'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('manager capabilities are scoped to owned workers on every run surface', async (t) => {
  const previousIsolation = process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
  process.env.PALANTIR_AGENT_PROCESS_ISOLATION = 'verified';
  t.after(() => {
    if (previousIsolation === undefined) delete process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
    else process.env.PALANTIR_AGENT_PROCESS_ISOLATION = previousIsolation;
  });

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-manager-scope-'));
  const executionEngine = {
    sendInput: () => true,
    getOutput: () => 'worker output',
    kill: () => true,
    isRunning: () => true,
    getSessionId: () => null,
    getUsage: () => null,
    disposeSession: () => {},
  };
  const app = createApp({
    dbPath: path.join(root, 'test.db'),
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    authToken: 'human-token',
    execAttestation: { verified: true, reason: 'test' },
    executionEngine,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  const rs = app.services.runService;
  const project = app.services.projectService.createProject({ name: 'Scope project' });
  const task = app.services.taskService.createTask({ project_id: project.id, title: 'Scope task' });
  const agent = app.services.agentProfileService.listProfiles()[0];
  assert.ok(agent, 'seeded agent profile is required');
  const workerFields = { task_id: task.id, agent_profile_id: agent.id };
  const profile = app.services.operatorProfileService.createProfile({ name: 'Scope operator' });
  const instanceA = app.services.operatorInstanceService.createInstance({ profile_id: profile.id });
  const instanceB = app.services.operatorInstanceService.createInstance({ profile_id: profile.id });

  function operatorManager(instance, label) {
    const conversationId = `operator:${instance.id}`;
    const run = rs.createRun({
      is_manager: true,
      manager_layer: 'operator',
      conversation_id: conversationId,
      operator_instance_id: instance.id,
      manager_adapter: 'codex',
      prompt: label,
    });
    rs.updateRunStatus(run.id, 'running', { force: true });
    app.managerRegistry.setActive(conversationId, run.id, {
      isSessionAlive: () => true,
      detectExitCode: () => null,
      disposeSession: () => {},
    });
    const token = app.services.managerCapabilityTokenService.mint(run.id, {
      conversationId,
      layer: 'operator',
    });
    assert.ok(token, 'verified isolation must mint a manager capability');
    return { run, token };
  }

  const a = operatorManager(instanceA, 'operator A');
  const b = operatorManager(instanceB, 'operator B');
  assert.equal(
    rs.resolveOperatorConversationIdWithDb(`operator:${instanceA.id}`).instanceId,
    instanceA.id,
  );
  const owned = rs.createRun({ ...workerFields, parent_run_id: a.run.id, prompt: 'A owned prompt' });
  rs.updateRunStatus(owned.id, 'running', { force: true });
  const instanceOwned = rs.createRun({ ...workerFields, operator_instance_id: instanceA.id, prompt: 'A instance prompt' });
  rs.updateRunStatus(instanceOwned.id, 'running', { force: true });
  const legacy = rs.createRun({ ...workerFields, prompt: 'legacy prompt' });
  rs.updateRunStatus(legacy.id, 'running', { force: true });

  const crossRequests = [
    { path: `/api/runs/${owned.id}` },
    { path: `/api/runs/${owned.id}/events` },
    { path: `/api/runs/${owned.id}/output` },
    { method: 'POST', path: `/api/runs/${owned.id}/input`, body: { text: 'cross input' } },
    { method: 'POST', path: `/api/runs/${owned.id}/cancel` },
    { method: 'POST', path: `/api/conversations/worker:${owned.id}/message`, body: { text: 'cross alias' } },
    { path: `/api/conversations/worker:${owned.id}/events` },
    { path: `/api/conversations/worker%3A${owned.id}/events` },
  ];
  for (const request of crossRequests) {
    const response = await invokeApp(app, { ...request, headers: bearer(b.token) });
    assert.equal(response.status, 403, `${request.method || 'GET'} ${request.path}`);
  }
  assert.equal(rs.getRun(owned.id).status, 'running', 'cross-owner cancel must not cancel the run');

  const ownRequests = [
    { path: `/api/runs/${owned.id}` },
    { path: `/api/runs/${owned.id}/events` },
    { path: `/api/runs/${owned.id}/output` },
    { method: 'POST', path: `/api/runs/${owned.id}/input`, body: { text: 'own input' } },
    { method: 'POST', path: `/api/conversations/worker:${owned.id}/message`, body: { text: 'own alias' } },
    { path: `/api/conversations/worker:${owned.id}/events` },
  ];
  for (const request of ownRequests) {
    const response = await invokeApp(app, { ...request, headers: bearer(a.token) });
    assert.equal(response.status, 200, `${request.method || 'GET'} ${request.path}: ${response.text}`);
  }

  for (const run of [instanceOwned]) {
    for (const suffix of ['', '/events', '/output']) {
      const response = await invokeApp(app, {
        path: `/api/runs/${run.id}${suffix}`,
        headers: bearer(a.token),
      });
      assert.equal(response.status, 200, `instance ownership ${suffix || 'detail'}`);
    }
  }

  assert.equal((await invokeApp(app, {
    path: `/api/runs/${legacy.id}`,
    headers: bearer(a.token),
  })).status, 403, 'legacy ownership must fail closed');

  const listB = await invokeApp(app, { path: '/api/runs', headers: bearer(b.token) });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.runs.some(run => run.id === owned.id), false);
  assert.equal(listB.body.runs.some(run => run.id === b.run.id), true, 'grant manager remains listed');
  const listA = await invokeApp(app, { path: '/api/runs', headers: bearer(a.token) });
  assert.equal(listA.body.runs.some(run => run.id === owned.id), true);

  const top = rs.createRun({ is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top' });
  rs.updateRunStatus(top.id, 'running', { force: true });
  app.managerRegistry.setActive('top', top.id, {
    isSessionAlive: () => true, detectExitCode: () => null, disposeSession: () => {},
  });
  const topToken = app.services.managerCapabilityTokenService.mint(top.id, {
    conversationId: 'top', layer: 'top',
  });
  for (const suffix of ['', '/events', '/output']) {
    const response = await invokeApp(app, {
      path: `/api/runs/${instanceOwned.id}${suffix}`,
      headers: bearer(topToken),
    });
    assert.equal(response.status, 200, `Top read ${suffix || 'detail'}`);
  }

  const cancel = await invokeApp(app, {
    method: 'POST', path: `/api/runs/${owned.id}/cancel`, headers: bearer(a.token),
  });
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(rs.getRun(owned.id).status, 'cancelled');
});

// Unit-level pins for the scope rule itself. The end-to-end test above cannot
// reach these shapes: mint() always produces a well-formed grant, so a
// hand-built one is the only way to exercise the degenerate comparisons.
const { managerCanAccessRun } = require('../services/managerRunScope');

test('a run with no parent is not owned just because the grant has no run id', () => {
  // `null === null` would read as ownership. That is the exact shape of a legacy
  // worker plus a malformed grant, and it must not open the boundary.
  assert.equal(
    managerCanAccessRun(
      { layer: 'operator', runId: null, conversationId: 'operator:oi_x' },
      { id: 'w', is_manager: 0, parent_run_id: null, operator_instance_id: null },
    ),
    false,
  );
});

test('a legacy pm-layer grant is scoped like an operator, not denied outright', () => {
  // mint() still accepts layer 'pm', and managerCapabilityRequestAllowed treats
  // every non-top layer as operator. Requiring the literal 'operator' here would
  // silently revoke all worker access for such a grant.
  const grant = { layer: 'pm', runId: 'mgr-1', conversationId: 'operator:oi_x' };
  assert.equal(
    managerCanAccessRun(grant, { id: 'w', is_manager: 0, parent_run_id: 'mgr-1' }),
    true,
  );
  assert.equal(
    managerCanAccessRun(grant, { id: 'w', is_manager: 0, parent_run_id: 'mgr-2' }),
    false,
  );
});

test('an operator grant never reaches a manager run through the scope rule', () => {
  assert.equal(
    managerCanAccessRun(
      { layer: 'operator', runId: 'mgr-1', conversationId: 'operator:oi_x' },
      { id: 'other-mgr', is_manager: 1, parent_run_id: 'mgr-1' },
    ),
    false,
  );
});

test('a runService without the resolver denies instead of throwing', () => {
  assert.equal(
    managerCanAccessRun(
      { layer: 'operator', runId: 'mgr-1', conversationId: 'operator:oi_x' },
      { id: 'w', is_manager: 0, operator_instance_id: 'oi_x' },
      { runService: {} },
    ),
    false,
  );
});

test('scoping a non-manager caller costs no extra run lookup', async (t) => {
  // The incremental output route proves its pre-read / re-read ordering by
  // COUNTING getRun calls, and an unconditional scope lookup broke that test
  // 3/3 while looking like a flake. Pin the same property on /events, which has
  // no counter of its own: a non-manager request must not fetch the run at all.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-scope-cost-'));
  const app = createApp({
    dbPath: path.join(root, 'test.db'),
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    authToken: 'human-token',
    execAttestation: { verified: true, reason: 'test' },
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  const rs = app.services.runService;
  const project = app.services.projectService.createProject({ name: 'Cost project' });
  const task = app.services.taskService.createTask({ project_id: project.id, title: 'Cost task' });
  const agent = app.services.agentProfileService.listProfiles()[0];
  const run = rs.createRun({ task_id: task.id, agent_profile_id: agent.id, prompt: 'x', node_id: 'local' });

  let lookups = 0;
  const originalGetRun = rs.getRun;
  rs.getRun = (id) => { lookups += 1; return originalGetRun.call(rs, id); };
  t.after(() => { rs.getRun = originalGetRun; });

  const res = await invokeApp(app, {
    method: 'GET',
    path: `/api/runs/${run.id}/events`,
    headers: { Authorization: 'Bearer human-token' },
  });
  assert.equal(res.status, 200);
  assert.equal(lookups, 0, 'a non-manager caller must not pay for the ownership lookup');
});

test('the gaps adversarial review named: instance-only ownership, Top intervention, filtered list queries', async (t) => {
  const previousIsolation = process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
  process.env.PALANTIR_AGENT_PROCESS_ISOLATION = 'verified';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-scope-gaps-'));
  const app = createApp({
    dbPath: path.join(root, 'test.db'),
    storageRoot: path.join(root, 'storage'),
    fsRoot: path.join(root, 'fs'),
    authToken: 'human-token',
    execAttestation: { verified: true, reason: 'test' },
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    await app.shutdown();
    await fs.rm(root, { recursive: true, force: true });
    if (previousIsolation === undefined) delete process.env.PALANTIR_AGENT_PROCESS_ISOLATION;
    else process.env.PALANTIR_AGENT_PROCESS_ISOLATION = previousIsolation;
  });

  const rs = app.services.runService;
  const profile = app.services.operatorProfileService.createProfile({ name: `gaps-${Date.now()}`, persona: 'x' });
  const mkOperator = (label) => {
    const instance = app.services.operatorInstanceService.createInstance({ profile_id: profile.id, display_name: label });
    const conversationId = `operator:${instance.id}`;
    const run = rs.createRun({
      is_manager: true, manager_layer: 'operator', conversation_id: conversationId,
      manager_adapter: 'codex', prompt: label,
    });
    rs.updateRunStatus(run.id, 'running', { force: true });
    app.managerRegistry.setActive(conversationId, run.id, {
      isSessionAlive: () => true, detectExitCode: () => null, disposeSession: () => true,
    });
    const token = app.services.managerCapabilityTokenService.mint(run.id, { conversationId, layer: 'operator' });
    return { instance, run, token };
  };
  const a = mkOperator('A');
  const b = mkOperator('B');

  const project = app.services.projectService.createProject({ name: 'Gaps project' });
  const task = app.services.taskService.createTask({ project_id: project.id, title: 'Gaps task' });
  const agent = app.services.agentProfileService.listProfiles()[0];
  // Owned by A through the instance marker ONLY -- no parent_run_id. This is the
  // branch the end-to-end loop covered for the ALLOW side but never for DENY.
  const worker = rs.createRun({
    task_id: task.id, agent_profile_id: agent.id, prompt: 'secret', node_id: 'local',
    operator_instance_id: a.instance.id,
  });

  const call = (token, req) => invokeApp(app, { headers: { Authorization: `Bearer ${token}` }, ...req });

  for (const path of [`/api/runs/${worker.id}`, `/api/runs/${worker.id}/events`, `/api/runs/${worker.id}/output`]) {
    assert.equal((await call(b.token, { path })).status, 403, `B must not reach ${path}`);
    assert.equal((await call(a.token, { path })).status, 200, `A owns ${path} through its instance`);
  }

  // Top is refused intervention by the auth allowlist, before any router runs.
  const topRun = rs.createRun({ is_manager: true, manager_layer: 'top', conversation_id: 'top', manager_adapter: 'codex', prompt: 'top' });
  rs.updateRunStatus(topRun.id, 'running', { force: true });
  app.managerRegistry.setActive('top', topRun.id, { isSessionAlive: () => true, detectExitCode: () => null, disposeSession: () => true });
  const topToken = app.services.managerCapabilityTokenService.mint(topRun.id, { conversationId: 'top', layer: 'top' });
  for (const req of [
    { method: 'POST', path: `/api/runs/${worker.id}/input`, body: { text: 'x' } },
    { method: 'POST', path: `/api/runs/${worker.id}/cancel` },
    { method: 'POST', path: `/api/conversations/worker:${worker.id}/message`, body: { text: 'x' } },
  ]) {
    assert.equal((await call(topToken, req)).status, 403, `Top intervention must stay refused: ${req.path}`);
  }
  assert.equal((await call(topToken, { path: `/api/runs/${worker.id}` })).status, 200, 'Top may still read');

  // The list filter must survive the query-parameter branches, not just the bare list.
  for (const query of ['', `?task_id=${task.id}`, '?status=queued']) {
    const listB = await call(b.token, { path: `/api/runs${query}` });
    assert.equal(listB.status, 200, query);
    assert.equal(listB.body.runs.some(r => r.id === worker.id), false, `B must not see the worker via ${query || 'the bare list'}`);
  }
  const listA = await call(a.token, { path: `/api/runs?task_id=${task.id}` });
  assert.equal(listA.body.runs.some(r => r.id === worker.id), true, 'A still sees its own worker');
});
