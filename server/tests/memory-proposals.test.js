'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { createApp } = require('../app');
const { createMemoryProposalsRouter } = require('../routes/memoryProposals');
const { WORKER_CANDIDATE_LIMIT } = require('../services/memoryService');
const { errorHandler } = require('../middleware/errorHandler');

const BEARER = { Authorization: 'Bearer secret-token' };

function setupApp(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pal-memory-proposals-'));
  const app = createApp({
    storageRoot: tmp,
    fsRoot: tmp,
    dbPath: path.join(tmp, 'test.db'),
    authToken: 'secret-token',
    agentProcessIsolation: true,
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
    authResolverOpts: { hasKeychain: () => false },
  });
  app.services._rawDb.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'One'), ('p2', 'Two')").run();
  t.after(async () => {
    try { await app.shutdown(); } catch { /* */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  return app;
}

function proposalHarness(
  app,
  resolveConversation,
  getLastTurnContext = () => null,
  auth = { method: 'bearer' },
) {
  const harness = express();
  harness.use(express.json());
  harness.use((req, res, next) => {
    req.auth = auth;
    next();
  });
  harness.use('/api', createMemoryProposalsRouter({
    conversationService: { resolveConversation, getLastTurnContext },
    runService: app.services.runService,
    memoryService: app.services.memoryService,
    masterMemoryService: app.services.masterMemoryService,
    projectService: app.services.projectService,
  }));
  harness.use(errorHandler);
  return harness;
}

test('Top and Operator proposals are always owner-derived pending candidates', async (t) => {
  const app = setupApp(t);
  const operator = app.services.runService.ensurePrimaryOperatorInstanceForProject('p1');
  const profileId = app.services.runService.getOperatorInstance(operator.instanceId).profile_id;
  const topContent = 'Prefer concise verification summaries after implementation.';
  const harness = proposalHarness(app, (conversationId) => {
    if (conversationId === 'top') {
      return {
        kind: 'top',
        conversationId: 'top',
        run: { id: 'run_mgr_top', is_manager: 1 },
      };
    }
    if (conversationId === 'operator:trusted') {
      return {
        kind: 'pm',
        conversationId,
        projectId: 'p1',
        instanceId: operator.instanceId,
        run: {
          id: 'run_mgr_operator',
          is_manager: 1,
          operator_instance_id: operator.instanceId,
        },
      };
    }
    return null;
  }, (runId) => (
    runId === 'run_mgr_operator'
      ? { workspaceProjectId: 'p2', turnMode: 'codebase', source: 'explicit' }
      : null
  ));

  const top = await request(harness)
    .post('/api/conversations/top/memory/propose')
    .send({
      kind: 'preference',
      content: topContent,
      importance: 7,
    })
    .expect(202);
  assert.deepEqual(top.body.owner, { type: 'user', id: 'user' });
  assert.deepEqual(Object.keys(top.body.candidate).sort(), ['id', 'status']);
  assert.equal(top.body.candidate.status, 'pending');
  assert.equal(app.services.masterMemoryService.listForScope('user').length, 0);
  const duplicateViaRemember = await request(app)
    .post('/api/master-memory/remember')
    .set(BEARER)
    .send({ scope: 'user', kind: 'preference', content: topContent })
    .expect(202);
  assert.equal(duplicateViaRemember.body.candidate.id, top.body.candidate.id);
  assert.equal(
    app.services._rawDb.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n,
    1,
  );

  const workspace = await request(harness)
    .post('/api/conversations/operator%3Atrusted/memory/propose')
    .send({
      target: 'workspace',
      kind: 'constraint',
      content: 'Run the focused database migration tests before the full suite.',
    })
    .expect(202);
  assert.deepEqual(workspace.body.owner, { type: 'workspace', id: 'p2' });
  assert.equal(app.services.memoryService.listForProject('p2').length, 0);

  const profile = await request(harness)
    .post('/api/conversations/operator%3Atrusted/memory/propose')
    .send({
      target: 'profile',
      kind: 'convention',
      content: 'Summarize the exact verification commands in every handoff.',
    })
    .expect(202);
  assert.deepEqual(profile.body.owner, { type: 'profile', id: profileId });
  assert.equal(app.services.memoryService.listForProfile(profileId).length, 0);

  const rows = app.services._rawDb.prepare(
    "SELECT owner_type, owner_id, status FROM memory_candidates WHERE status='pending' ORDER BY owner_type"
  ).all();
  assert.deepEqual(rows, [
    { owner_type: 'profile', owner_id: profileId, status: 'pending' },
    { owner_type: 'workspace', owner_id: 'p2', status: 'pending' },
  ]);
});

test('proposal callers cannot steer owner or scope through request fields', async (t) => {
  const app = setupApp(t);
  const harness = proposalHarness(app, () => ({
    kind: 'top',
    conversationId: 'top',
    run: { id: 'run_mgr_top', is_manager: 1 },
  }));

  for (const field of [
    { scope: 'cross_project' },
    { projectId: 'p2' },
    { owner_id: 'p2' },
  ]) {
    await request(harness)
      .post('/api/conversations/top/memory/propose')
      .send({
        ...field,
        kind: 'preference',
        content: 'This request must not select its own memory owner.',
      })
      .expect(400);
  }
  assert.equal(
    app.services._rawDb.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n,
    0,
  );
});

test('manager capability can propose memory only for its own active conversation', async (t) => {
  const app = setupApp(t);
  const harness = proposalHarness(app, () => ({
    kind: 'top',
    conversationId: 'top',
    run: { id: 'run_mgr_top', is_manager: 1 },
  }), () => null, {
    method: 'bearer',
    actor: 'manager',
    managerRunId: 'run_mgr_other',
    conversationId: 'operator:other',
    layer: 'operator',
  });

  await request(harness)
    .post('/api/conversations/top/memory/propose')
    .send({
      kind: 'preference',
      content: 'A different manager must not attribute this proposal to Top.',
    })
    .expect(403);
  assert.equal(
    app.services._rawDb.prepare('SELECT COUNT(*) n FROM master_memory_candidates').get().n,
    0,
  );
});

test('worker proposal route binds to the spawn project and rejects a terminal run token', async (t) => {
  const app = setupApp(t);
  const agent = app.services.agentProfileService.createProfile({
    name: 'proposal-worker',
    type: 'codex',
    command: 'codex',
  });
  const task = app.services.taskService.createTask({
    project_id: 'p1',
    title: 'Capture a reusable lesson',
  });
  const run = app.services.runService.createRun({
    task_id: task.id,
    agent_profile_id: agent.id,
    prompt: 'work',
    is_manager: false,
  });
  assert.ok(app.services.runService.claimQueuedRun(run.id));
  const workerToken = app.services.workerProposalTokenService.mint(run.id, { projectId: 'p1' });
  app.services.taskService.updateTask(task.id, { project_id: 'p2' });

  const proposed = await request(app)
    .post(`/api/runs/${run.id}/memory/propose`)
    .set({ Authorization: `Bearer ${workerToken}` })
    .send({
      target: 'workspace',
      kind: 'pitfall',
      content: 'Native modules must be rebuilt after changing Node versions.',
      importance: 8,
    })
    .expect(202);
  assert.deepEqual(proposed.body.owner, { type: 'workspace', id: 'p1' });
  assert.equal(proposed.body.candidate.status, 'pending');
  assert.equal('content' in proposed.body.candidate, false);
  assert.equal(app.services.memoryService.listForProject('p1').length, 0);

  const stored = app.services._rawDb.prepare(
    'SELECT project_id, owner_type, owner_id, status, raw_json FROM memory_candidates WHERE id=?'
  ).get(proposed.body.candidate.id);
  assert.equal(stored.project_id, 'p1');
  assert.equal(stored.owner_type, 'workspace');
  assert.equal(stored.owner_id, 'p1');
  assert.equal(stored.status, 'pending');
  assert.equal(JSON.parse(stored.raw_json).proposed_by.run_id, run.id);

  await request(app)
    .post(`/api/runs/${run.id}/memory/propose`)
    .set({ Authorization: `Bearer ${workerToken}` })
    .send({
      projectId: 'p2',
      kind: 'pitfall',
      content: 'A worker cannot redirect this candidate to another project.',
    })
    .expect(400);

  await request(app)
    .get('/api/tasks')
    .set({ Authorization: `Bearer ${workerToken}` })
    .expect(403);

  app.services.runService.updateRunStatus(run.id, 'completed', {
    force: true,
    reason: 'test_complete',
  });
  await request(app)
    .post(`/api/runs/${run.id}/memory/propose`)
    .set({ Authorization: `Bearer ${workerToken}` })
    .send({
      kind: 'pitfall',
      content: 'A terminal run token must not create another candidate.',
    })
    .expect(403);
});

test('worker proposal quota is durable per run and exact retries stay idempotent', async (t) => {
  const app = setupApp(t);
  const agent = app.services.agentProfileService.createProfile({
    name: 'quota-worker',
    type: 'codex',
    command: 'codex',
  });
  const task = app.services.taskService.createTask({
    project_id: 'p1',
    title: 'Bound candidate volume',
  });
  const run = app.services.runService.createRun({
    task_id: task.id,
    agent_profile_id: agent.id,
    prompt: 'work',
    is_manager: false,
  });
  assert.ok(app.services.runService.claimQueuedRun(run.id));
  const workerToken = app.services.workerProposalTokenService.mint(run.id, { projectId: 'p1' });
  const auth = { Authorization: `Bearer ${workerToken}` };

  for (let i = 0; i < WORKER_CANDIDATE_LIMIT; i += 1) {
    await request(app)
      .post(`/api/runs/${run.id}/memory/propose`)
      .set(auth)
      .send({ kind: 'heuristic', content: `Durable quota lesson ${i}.` })
      .expect(202);
  }

  await request(app)
    .post(`/api/runs/${run.id}/memory/propose`)
    .set(auth)
    .send({ kind: 'heuristic', content: 'This unique candidate exceeds the run quota.' })
    .expect(429)
    .expect(({ body }) => assert.equal(body.details.limit, WORKER_CANDIDATE_LIMIT));

  // Retrying an already-created candidate remains idempotent at the cap.
  await request(app)
    .post(`/api/runs/${run.id}/memory/propose`)
    .set(auth)
    .send({ kind: 'heuristic', content: 'Durable quota lesson 0.' })
    .expect(202);

  assert.equal(
    app.services._rawDb.prepare(`
      SELECT COUNT(*) AS n
      FROM memory_candidates
      WHERE json_extract(raw_json, '$.proposed_by.run_id') = ?
    `).get(run.id).n,
    WORKER_CANDIDATE_LIMIT,
  );
});
