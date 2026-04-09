// v3 Phase 6 — routerService 3-step matcher + HTTP wrapper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');

const { createRouterService } = require('../services/routerService');
const { createDatabase } = require('../db/database');
const { createProjectService } = require('../services/projectService');
const { createApp } = require('../app');

function fakeProjectService(projects) {
  return {
    listProjects: () => projects.slice(),
    getProject: (id) => {
      const p = projects.find(p => p.id === id);
      if (!p) throw new Error('not found');
      return p;
    },
  };
}

test('Phase 6 router: rule 1 — @mention by exact project name strips prefix', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
      { id: 'proj_beta', name: 'beta', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: '@alpha 지금 상태 요약해줘' });
  assert.equal(r.target, 'pm:proj_alpha');
  assert.equal(r.text, '지금 상태 요약해줘');
  assert.equal(r.matchedRule, '1_explicit');
});

test('Phase 6 router: rule 1 — @mention by project id', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: '@proj_alpha hi' });
  assert.equal(r.target, 'pm:proj_alpha');
  assert.equal(r.matchedRule, '1_explicit');
});

test('Phase 6 router: rule 1 — @mention is case-insensitive by name', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'Alpha', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: '@ALPHA hello' });
  assert.equal(r.target, 'pm:proj_alpha');
});

test('Phase 6 router: rule 1 — @mention falls through if project disabled', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 0 },
    ]),
  });
  const r = svc.resolveTarget({ text: '@alpha hi', currentConversationId: 'top' });
  assert.equal(r.target, 'top');
  assert.equal(r.matchedRule, '2_current');
});

test('Phase 6 router: rule 1 — unresolved @mention logs and falls through', () => {
  const logs = [];
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
    logger: (m) => logs.push(m),
  });
  const r = svc.resolveTarget({ text: '@nonexistent hi', currentConversationId: 'top' });
  assert.equal(r.target, 'top');
  assert.equal(r.matchedRule, '2_current');
  assert.ok(logs.some(l => /unresolved @mention "nonexistent"/.test(l)));
});

test('Phase 6 router: rule 2 — current conversation id wins over no-mention body', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({
    text: 'alpha 라는 단어가 들어있지만 mention 아님',
    currentConversationId: 'pm:proj_alpha',
  });
  assert.equal(r.target, 'pm:proj_alpha');
  assert.equal(r.matchedRule, '2_current');
  // Text unchanged
  assert.match(r.text, /단어가 들어있지만/);
});

test('Phase 6 router: rule 2 — worker conversation id valid', () => {
  const svc = createRouterService({ projectService: fakeProjectService([]) });
  const r = svc.resolveTarget({
    text: 'hi',
    currentConversationId: 'worker:run_abc',
  });
  assert.equal(r.target, 'worker:run_abc');
  assert.equal(r.matchedRule, '2_current');
});

test('Phase 6 router: rule 3 — fuzzy name match when no current context', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
      { id: 'proj_beta', name: 'beta', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: 'please check alpha status' });
  assert.equal(r.target, 'pm:proj_alpha');
  assert.equal(r.matchedRule, '3_namematch');
});

test('Phase 6 router: rule 3 — multi-match is ambiguous and falls to default', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
      { id: 'proj_beta', name: 'beta', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: 'alpha vs beta which one?' });
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.target, 'top');
  assert.equal(r.matchedRule, '3_namematch');
});

test('Phase 6 router: rule 4 — defaults to top when nothing else matches', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: '그냥 안녕' });
  assert.equal(r.target, 'top');
  assert.equal(r.matchedRule, '4_default');
});

test('Phase 6 router: invalid currentConversationId is ignored (falls through)', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
  });
  const r = svc.resolveTarget({ text: 'hi', currentConversationId: 'bogus' });
  assert.equal(r.target, 'top');
  assert.equal(r.matchedRule, '4_default');
});

test('Phase 6 router: @mention with empty body keeps original text', () => {
  const svc = createRouterService({
    projectService: fakeProjectService([
      { id: 'proj_alpha', name: 'alpha', pm_enabled: 1 },
    ]),
  });
  // Rare edge: user typed just "@alpha" with nothing after. Keep the
  // original so the downstream turn sees SOME text.
  const r = svc.resolveTarget({ text: '@alpha' });
  assert.equal(r.target, 'pm:proj_alpha');
  assert.equal(r.text, '@alpha');
});

// --- HTTP surface ---

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-router-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({
    storageRoot, fsRoot, dbPath,
    authResolverOpts: { hasKeychain: true },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

test('Phase 6 router HTTP: POST /api/router/resolve rejects missing text', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/router/resolve').send({});
  assert.equal(res.status, 400);
});

test('Phase 6 router HTTP: POST /api/router/resolve honors @mention', async (t) => {
  const app = await createTestApp(t);
  const { project } = (await request(app).post('/api/projects').send({ name: 'alpha' })).body;
  const res = await request(app).post('/api/router/resolve').send({
    text: '@alpha 상태',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.target, `pm:${project.id}`);
  assert.equal(res.body.matchedRule, '1_explicit');
  assert.equal(res.body.text, '상태');
});

test('Phase 6 router HTTP: POST /api/router/resolve honors current context', async (t) => {
  const app = await createTestApp(t);
  const { project } = (await request(app).post('/api/projects').send({ name: 'beta' })).body;
  const res = await request(app).post('/api/router/resolve').send({
    text: 'hi',
    currentConversationId: `pm:${project.id}`,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.target, `pm:${project.id}`);
  assert.equal(res.body.matchedRule, '2_current');
});
