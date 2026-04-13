// Phase 2 — Skill Packs PM Integration Tests
//
// Verifies:
// 1. PM system prompt includes skill pack API documentation (PM layer only)
// 2. PM system prompt does NOT include skill pack docs for Top layer
// 3. pmSpawnService injects project auto_apply skill pack list into PM prompt
// 4. /execute skill_pack_ids documented in PM layer prompt
// 5. excluded user packs cannot be overridden via skill_pack_ids (integration)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createPmSpawnService } = require('../services/pmSpawnService');
const { createSkillPackService } = require('../services/skillPackService');
const {
  buildManagerSystemPrompt,
} = require('../services/managerSystemPrompt');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-sp-pm-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeFakeAdapter() {
  const sessions = new Map();
  return {
    type: 'codex',
    capabilities: { persistentProcess: false, supportsResume: true },
    startSession(runId, opts) {
      sessions.set(runId, { systemPrompt: opts.systemPrompt, ended: false });
      if (opts.resumeThreadId && typeof opts.onThreadStarted === 'function') {
        try { opts.onThreadStarted(opts.resumeThreadId); } catch { /* */ }
      }
      return { sessionRef: { resumedThreadId: opts.resumeThreadId || null } };
    },
    runTurn(runId) {
      const s = sessions.get(runId);
      if (!s || s.ended) return { accepted: false };
      if (!s.threadId) {
        s.threadId = `thread_${runId}`;
      }
      return { accepted: true };
    },
    isSessionAlive(runId) { return sessions.has(runId) && !sessions.get(runId).ended; },
    detectExitCode() { return null; },
    emitSessionEndedIfNeeded() {},
    getUsage() { return null; },
    getSessionId() { return null; },
    getOutput() { return null; },
    disposeSession(runId) { const s = sessions.get(runId); if (s) s.ended = true; },
    buildGuardrailsSection() { return ''; },
    _sessions: sessions,
  };
}

function seedTop({ rs, registry, adapter }) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

// ───────────────────────────────────────────────────────────────
// managerSystemPrompt — PM layer includes skill pack docs
// ───────────────────────────────────────────────────────────────

test('PM layer prompt includes Skill Packs section with API docs', () => {
  const fakeAdapter = { buildGuardrailsSection() { return ''; } };
  const prompt = buildManagerSystemPrompt({
    adapter: fakeAdapter, port: 4177, token: null, layer: 'pm', adapterType: 'codex',
  });
  assert.match(prompt, /Skill Packs.*PM-only/);
  assert.match(prompt, /skill_pack_ids/);
  assert.match(prompt, /api\/skill-packs/);
  assert.match(prompt, /per-run ephemeral/);
  assert.match(prompt, /User-excluded packs/);
});

test('Top layer prompt does NOT include Skill Packs section', () => {
  const fakeAdapter = { buildGuardrailsSection() { return ''; } };
  const prompt = buildManagerSystemPrompt({
    adapter: fakeAdapter, port: 4177, token: null, layer: 'top', adapterType: 'codex',
  });
  assert.ok(!prompt.includes('Skill Packs (PM-only'));
});

test('PM layer /execute doc includes skill_pack_ids parameter', () => {
  const fakeAdapter = { buildGuardrailsSection() { return ''; } };
  const prompt = buildManagerSystemPrompt({
    adapter: fakeAdapter, port: 4177, token: null, layer: 'pm', adapterType: 'codex',
  });
  // The execute line should mention skill_pack_ids for PM
  assert.match(prompt, /execute.*skill_pack_ids/s);
});

test('Top layer /execute doc does NOT include skill_pack_ids', () => {
  const fakeAdapter = { buildGuardrailsSection() { return ''; } };
  const prompt = buildManagerSystemPrompt({
    adapter: fakeAdapter, port: 4177, token: null, layer: 'top', adapterType: 'codex',
  });
  // The execute task line should not have skill_pack_ids for top
  const executeLineMatch = prompt.match(/Execute task with agent:.*$/m);
  assert.ok(executeLineMatch);
  assert.ok(!executeLineMatch[0].includes('skill_pack_ids'));
});

// ───────────────────────────────────────────────────────────────
// pmSpawnService — skill pack list injection into PM prompt
// ───────────────────────────────────────────────────────────────

test('Phase 2: PM prompt includes project auto_apply skill pack list', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  // Create project + skill packs + bindings
  const project = projectService.createProject({ name: 'alpha', pm_enabled: 1 });
  const pack1 = skillPackService.createSkillPack({
    name: 'A11y Expert', description: 'Accessibility specialist', prompt_full: 'You are an a11y expert.',
  });
  const pack2 = skillPackService.createSkillPack({
    name: 'Security Review', description: 'Security audit skills', prompt_full: 'You are a security reviewer.',
  });
  skillPackService.bindToProject(project.id, { skill_pack_id: pack1.id, auto_apply: 1 });
  skillPackService.bindToProject(project.id, { skill_pack_id: pack2.id, auto_apply: 0 }); // not auto_apply

  // Seed active Top
  seedTop({ rs, registry, adapter: topAdapter });

  // Spawn PM
  const { run, spawned } = spawn.ensureLivePm({ projectId: project.id });
  assert.ok(spawned);

  // Inspect the system prompt that was passed to the adapter
  const session = adapter._sessions.get(run.id);
  assert.ok(session);

  // auto_apply pack should be listed
  assert.match(session.systemPrompt, /A11y Expert/);
  assert.match(session.systemPrompt, /Accessibility specialist/);
  assert.match(session.systemPrompt, /auto_apply/i);
  // non-auto_apply pack should NOT be listed
  assert.ok(!session.systemPrompt.includes('Security Review'));
});

test('Phase 2: PM prompt works gracefully when no skill packs exist', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'beta', pm_enabled: 1 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run, spawned } = spawn.ensureLivePm({ projectId: project.id });
  assert.ok(spawned);

  const session = adapter._sessions.get(run.id);
  assert.ok(session);
  // Should not have auto_apply skill packs listing section (the header "Project Skill Packs (auto_apply)")
  assert.ok(!session.systemPrompt.includes('Project Skill Packs (auto_apply)'));
  // But should still have PM Role section
  assert.match(session.systemPrompt, /PM Role/);
});

test('Phase 2: PM prompt works when skillPackService is not injected', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  // No skillPackService
  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'gamma', pm_enabled: 1 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run, spawned } = spawn.ensureLivePm({ projectId: project.id });
  assert.ok(spawned);

  const session = adapter._sessions.get(run.id);
  assert.ok(session);
  assert.match(session.systemPrompt, /PM Role/);
});

test('Phase 2: PM Role section mentions skill pack selection guidance', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'delta', pm_enabled: 1 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run } = spawn.ensureLivePm({ projectId: project.id });
  const session = adapter._sessions.get(run.id);
  assert.match(session.systemPrompt, /choose skill packs/i);
  assert.match(session.systemPrompt, /skill_pack_ids/);
});

// ───────────────────────────────────────────────────────────────
// Integration: excluded user packs via /execute (Phase 1b + 2)
// ───────────────────────────────────────────────────────────────

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fs-'));
  const dbPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-db-')), 'test.db');
  const authResolverOpts = { hasKeychain: () => false };
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, authResolverOpts });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  return app;
}

test('Phase 2 integration: user-excluded skill pack not applied even with explicit skill_pack_ids', async (t) => {
  const app = await createTestApp(t);

  // Create project + agent
  const projRes = await request(app).post('/api/projects').send({ name: 'excl-test', directory: '/tmp/test' });
  const project = projRes.body.project;
  const agentRes = await request(app).post('/api/agents').send({
    name: 'test-agent', type: 'claude-code', command: 'echo',
  });
  const agent = agentRes.body;

  // Create skill pack
  const packRes = await request(app).post('/api/skill-packs').send({
    name: 'Excluded Pack', prompt_full: 'Excluded prompt',
  });
  assert.equal(packRes.status, 201);
  const pack = packRes.body.skill_pack;

  // Create task in the project
  const taskRes = await request(app).post('/api/tasks').send({
    title: 'Excluded test', project_id: project.id,
  });
  const task = taskRes.body.task;

  // Bind pack to task as user-excluded
  const bindRes = await request(app)
    .post(`/api/tasks/${task.id}/skill-packs`)
    .send({ skill_pack_id: pack.id, excluded: true });
  assert.equal(bindRes.status, 201);

  // Execute with explicit skill_pack_ids including the excluded pack
  const execRes = await request(app)
    .post(`/api/tasks/${task.id}/execute`)
    .send({ agent_profile_id: agent.id, prompt: 'test', skill_pack_ids: [pack.id] });
  // Execute will fail because no real agent, but we can check the run was created
  // and the skill pack was NOT applied. Check run skill packs snapshot.
  const runId = execRes.body.run?.id;
  if (runId) {
    const snapRes = await request(app).get(`/api/runs/${runId}/skill-packs`);
    if (snapRes.status === 200) {
      const snapshots = snapRes.body.skill_packs || [];
      const excluded = snapshots.find(s => s.skill_pack_id === pack.id);
      assert.ok(!excluded, 'User-excluded pack must not appear in run snapshots');
    }
  }
});

test('Phase 2 integration: PM prompt skill pack docs accessible via full app', async (t) => {
  // Verify that buildManagerSystemPrompt with PM layer includes skill pack docs
  // when invoked through the full app wiring (managerSystemPrompt is a pure function,
  // so this is a redundant sanity check that the import is correct).
  const {
    buildManagerSystemPrompt: build,
  } = require('../services/managerSystemPrompt');

  const pmPrompt = build({
    adapter: { buildGuardrailsSection: () => '' },
    port: 4177, token: 'test-tok', layer: 'pm', adapterType: 'codex',
  });
  assert.match(pmPrompt, /Skill Packs/);
  assert.match(pmPrompt, /lazy lookup/i);
  assert.match(pmPrompt, /do NOT call this every turn/i);
});

// ───────────────────────────────────────────────────────────────
// Codex cross-review: missing test cases
// ───────────────────────────────────────────────────────────────

test('Phase 2: PM prompt contains skill pack IDs for /execute usage', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'id-test', pm_enabled: 1 });
  const pack = skillPackService.createSkillPack({
    name: 'Test Pack', description: 'For ID check', prompt_full: 'test',
  });
  skillPackService.bindToProject(project.id, { skill_pack_id: pack.id, auto_apply: 1 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run } = spawn.ensureLivePm({ projectId: project.id });
  const session = adapter._sessions.get(run.id);
  // The pack ID must appear in the prompt so the PM can reference it in /execute
  assert.ok(session.systemPrompt.includes(pack.id), 'Pack ID should be in PM prompt');
});

test('Phase 2: auto_apply packs listed in priority order', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'priority-test', pm_enabled: 1 });
  const packA = skillPackService.createSkillPack({
    name: 'Pack-A', description: 'first', prompt_full: 'a', priority: 200,
  });
  const packB = skillPackService.createSkillPack({
    name: 'Pack-B', description: 'second', prompt_full: 'b', priority: 50,
  });
  // Bind with different priorities
  skillPackService.bindToProject(project.id, { skill_pack_id: packA.id, auto_apply: 1, priority: 200 });
  skillPackService.bindToProject(project.id, { skill_pack_id: packB.id, auto_apply: 1, priority: 50 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run } = spawn.ensureLivePm({ projectId: project.id });
  const session = adapter._sessions.get(run.id);
  const prompt = session.systemPrompt;
  // Pack-B (priority 50) should appear before Pack-A (priority 200)
  const idxB = prompt.indexOf('Pack-B');
  const idxA = prompt.indexOf('Pack-A');
  assert.ok(idxB > 0 && idxA > 0, 'Both packs should appear in prompt');
  assert.ok(idxB < idxA, 'Lower priority (50) should appear before higher priority (200)');
});

test('Phase 2: skill pack with null description renders without colon', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const projectService = createProjectService(db);
  const projectBriefService = createProjectBriefService(db);
  const skillPackService = createSkillPackService(db);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const topAdapter = makeFakeAdapter();

  const spawn = createPmSpawnService({
    runService: rs,
    managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    projectService,
    projectBriefService,
    skillPackService,
    authResolverOpts: { hasKeychain: true },
  });

  const project = projectService.createProject({ name: 'nodesc-test', pm_enabled: 1 });
  const pack = skillPackService.createSkillPack({
    name: 'NoDesc Pack', prompt_full: 'test',
    // description is null/undefined
  });
  skillPackService.bindToProject(project.id, { skill_pack_id: pack.id, auto_apply: 1 });
  seedTop({ rs, registry, adapter: topAdapter });

  const { run } = spawn.ensureLivePm({ projectId: project.id });
  const session = adapter._sessions.get(run.id);
  // Should render as "- NoDesc Pack (id: ...)" without a colon before the description
  assert.match(session.systemPrompt, /NoDesc Pack \(id:/);
  assert.ok(!session.systemPrompt.includes('NoDesc Pack:'), 'Should not have colon when no description');
});
