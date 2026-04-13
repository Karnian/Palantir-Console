const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
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

// Helper: create a project
async function createProject(app, name = 'Test Project') {
  const res = await request(app).post('/api/projects').send({ name, directory: '/tmp/test' });
  return res.body.project;
}

// Helper: create a task
async function createTask(app, projectId) {
  const body = { title: 'Test Task', status: 'todo' };
  if (projectId) body.project_id = projectId;
  const res = await request(app).post('/api/tasks').send(body);
  return res.body.task;
}

// ──── Schema & Migration ────

test('Skill Packs: tables exist after migration', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/skill-packs');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.skill_packs));
});

test('Skill Packs: MCP templates are seeded', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/skill-packs/templates');
  assert.equal(res.status, 200);
  assert.ok(res.body.templates.length >= 2);
  const aliases = res.body.templates.map(t => t.alias);
  assert.ok(aliases.includes('playwright'));
  assert.ok(aliases.includes('filesystem'));
});

// ──── Skill Pack CRUD ────

test('Skill Packs: create global skill pack', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'A11y Expert',
    description: 'Accessibility specialist',
    prompt_full: 'You are an accessibility expert. Check WCAG 2.2 AA.',
    priority: 50,
  });
  assert.equal(res.status, 201);
  const sp = res.body.skill_pack;
  assert.ok(sp.id.startsWith('sp_'));
  assert.equal(sp.name, 'A11y Expert');
  assert.equal(sp.scope, 'global');
  assert.equal(sp.project_id, null);
  assert.equal(sp.priority, 50);
  assert.ok(sp.estimated_tokens > 0);
});

test('Skill Packs: create project-scope skill pack', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'Project Style',
    scope: 'project',
    project_id: project.id,
    prompt_full: 'Follow project conventions.',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.scope, 'project');
  assert.equal(res.body.skill_pack.project_id, project.id);
});

test('Skill Packs: project-scope requires project_id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'Broken',
    scope: 'project',
  });
  assert.equal(res.status, 400);
});

test('Skill Packs: global-scope rejects project_id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'Broken',
    scope: 'global',
    project_id: 'proj_12345678',
  });
  assert.equal(res.status, 400);
});

test('Skill Packs: get by id', async (t) => {
  const app = await createTestApp(t);
  const create = await request(app).post('/api/skill-packs').send({ name: 'Get Test' });
  const res = await request(app).get(`/api/skill-packs/${create.body.skill_pack.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.skill_pack.name, 'Get Test');
});

test('Skill Packs: 404 on missing id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/skill-packs/sp_nonexistent');
  assert.equal(res.status, 404);
});

test('Skill Packs: update skill pack', async (t) => {
  const app = await createTestApp(t);
  const create = await request(app).post('/api/skill-packs').send({
    name: 'Original',
    prompt_full: 'v1',
  });
  const id = create.body.skill_pack.id;
  const res = await request(app).patch(`/api/skill-packs/${id}`).send({
    name: 'Updated',
    prompt_full: 'v2 with more text here',
    priority: 200,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.skill_pack.name, 'Updated');
  assert.equal(res.body.skill_pack.priority, 200);
  assert.ok(res.body.skill_pack.estimated_tokens > 0);
});

test('Skill Packs: delete skill pack', async (t) => {
  const app = await createTestApp(t);
  const create = await request(app).post('/api/skill-packs').send({ name: 'ToDelete' });
  const id = create.body.skill_pack.id;
  const del = await request(app).delete(`/api/skill-packs/${id}`);
  assert.equal(del.status, 200);
  const get = await request(app).get(`/api/skill-packs/${id}`);
  assert.equal(get.status, 404);
});

test('Skill Packs: unique name constraint (global)', async (t) => {
  const app = await createTestApp(t);
  await request(app).post('/api/skill-packs').send({ name: 'UniqueTest' });
  const res = await request(app).post('/api/skill-packs').send({ name: 'UniqueTest' });
  // SQLite UNIQUE constraint → 500 (or handled as conflict)
  assert.ok(res.status >= 400);
});

test('Skill Packs: same name allowed in different project scopes', async (t) => {
  const app = await createTestApp(t);
  const p1 = await createProject(app, 'Proj A');
  const p2 = await createProject(app, 'Proj B');

  const r1 = await request(app).post('/api/skill-packs').send({
    name: 'SharedName', scope: 'project', project_id: p1.id,
  });
  assert.equal(r1.status, 201);

  const r2 = await request(app).post('/api/skill-packs').send({
    name: 'SharedName', scope: 'project', project_id: p2.id,
  });
  assert.equal(r2.status, 201);
});

// ──── Shadow Rule ────

test('Skill Packs: shadow rule — project-scope replaces same-name global in listing', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);

  await request(app).post('/api/skill-packs').send({
    name: 'SharedSkill', prompt_full: 'global version',
  });
  await request(app).post('/api/skill-packs').send({
    name: 'SharedSkill', scope: 'project', project_id: project.id,
    prompt_full: 'project version',
  });

  const res = await request(app).get(`/api/skill-packs?project_id=${project.id}`);
  assert.equal(res.status, 200);
  const shared = res.body.skill_packs.filter(sp => sp.name === 'SharedSkill');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].scope, 'project');
});

// ──── MCP Servers Validation ────

test('Skill Packs: mcp_servers alias validation', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'BadMCP',
    mcp_servers: JSON.stringify({ nonexistent: {} }),
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('nonexistent'));
});

test('Skill Packs: mcp_servers env override allowed', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'GoodMCP',
    mcp_servers: JSON.stringify({
      playwright: { env_overrides: { BROWSER: 'chromium' } },
    }),
  });
  assert.equal(res.status, 201);
});

test('Skill Packs: mcp_servers env override blocked by hard denylist', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'DeniedEnv',
    mcp_servers: JSON.stringify({
      playwright: { env_overrides: { NODE_OPTIONS: '--inspect' } },
    }),
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('blocked'));
});

test('Skill Packs: mcp_servers env key not in template allowlist', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'NotAllowed',
    mcp_servers: JSON.stringify({
      playwright: { env_overrides: { UNKNOWN_VAR: 'value' } },
    }),
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('not allowed'));
});

test('Skill Packs: env hard denylist patterns (_KEY, _SECRET, etc)', async (t) => {
  const app = await createTestApp(t);
  const deniedKeys = ['API_KEY', 'MY_SECRET', 'AUTH_TOKEN', 'DB_PASSWORD', 'LD_PRELOAD', 'PATH', 'HOME'];
  for (const key of deniedKeys) {
    const res = await request(app).post('/api/skill-packs').send({
      name: `test_${key}`,
      mcp_servers: JSON.stringify({
        playwright: { env_overrides: { [key]: 'bad' } },
      }),
    });
    assert.equal(res.status, 400, `Expected 400 for env key ${key}`);
  }
});

// ──── Checklist Validation ────

test('Skill Packs: checklist stored as JSON array', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'WithChecklist',
    checklist: ['Check A', 'Check B'],
  });
  assert.equal(res.status, 201);
  const cl = JSON.parse(res.body.skill_pack.checklist);
  assert.deepEqual(cl, ['Check A', 'Check B']);
});

test('Skill Packs: checklist rejects non-array', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'BadChecklist',
    checklist: 'not an array',
  });
  assert.equal(res.status, 400);
});

// ──── Project Bindings ────

test('Skill Packs: bind to project', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'BindMe' })).body.skill_pack;

  const res = await request(app).post(`/api/projects/${project.id}/skill-packs`).send({
    skill_pack_id: sp.id, auto_apply: true, priority: 50,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.binding.auto_apply, 1);
  assert.equal(res.body.binding.priority, 50);
});

test('Skill Packs: list project bindings', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'Listed' })).body.skill_pack;
  await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).get(`/api/projects/${project.id}/skill-packs`);
  assert.equal(res.status, 200);
  assert.equal(res.body.bindings.length, 1);
  assert.equal(res.body.bindings[0].skill_pack_name, 'Listed');
});

test('Skill Packs: update project binding', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'UpdateBind' })).body.skill_pack;
  await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).patch(`/api/projects/${project.id}/skill-packs/${sp.id}`).send({
    auto_apply: true, priority: 10,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.binding.auto_apply, 1);
  assert.equal(res.body.binding.priority, 10);
});

test('Skill Packs: unbind from project', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'Unbind' })).body.skill_pack;
  await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).delete(`/api/projects/${project.id}/skill-packs/${sp.id}`);
  assert.equal(res.status, 200);
  const list = await request(app).get(`/api/projects/${project.id}/skill-packs`);
  assert.equal(list.body.bindings.length, 0);
});

test('Skill Packs: cross-project binding blocked (project-scope to wrong project)', async (t) => {
  const app = await createTestApp(t);
  const p1 = await createProject(app, 'Project A');
  const p2 = await createProject(app, 'Project B');
  const sp = (await request(app).post('/api/skill-packs').send({
    name: 'P1Only', scope: 'project', project_id: p1.id,
  })).body.skill_pack;

  const res = await request(app).post(`/api/projects/${p2.id}/skill-packs`).send({
    skill_pack_id: sp.id,
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('different project'));
});

test('Skill Packs: duplicate project binding blocked', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'DupBind' })).body.skill_pack;
  await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });
  assert.equal(res.status, 400);
});

// ──── Task Bindings ────

test('Skill Packs: bind to task (user)', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const task = await createTask(app, project.id);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'TaskBind' })).body.skill_pack;

  const res = await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id, priority: 150,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.binding.pinned_by, 'user');
  assert.equal(res.body.binding.priority, 150);
});

test('Skill Packs: list task bindings', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'ListTask' })).body.skill_pack;
  await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).get(`/api/tasks/${task.id}/skill-packs`);
  assert.equal(res.status, 200);
  assert.equal(res.body.bindings.length, 1);
});

test('Skill Packs: exclude from task', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'Exclude' })).body.skill_pack;

  const res = await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id, excluded: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.binding.excluded, 1);
  assert.equal(res.body.binding.pinned_by, 'user');
});

test('Skill Packs: unbind from task', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'UnbindTask' })).body.skill_pack;
  await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({ skill_pack_id: sp.id });

  const res = await request(app).delete(`/api/tasks/${task.id}/skill-packs/${sp.id}`);
  assert.equal(res.status, 200);
});

test('Skill Packs: pinned_by from body is ignored (server decides)', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'PinnedBy' })).body.skill_pack;

  // Client tries to set pinned_by='pm' — should be overridden to 'user'
  const res = await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id, pinned_by: 'pm',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.binding.pinned_by, 'user');
});

// ──── Cross-project task binding (DB trigger) ────

test('Skill Packs: cross-project task binding blocked by DB trigger', async (t) => {
  const app = await createTestApp(t);
  const p1 = await createProject(app, 'P1');
  const p2 = await createProject(app, 'P2');
  const task = await createTask(app, p1.id);
  const sp = (await request(app).post('/api/skill-packs').send({
    name: 'CrossTask', scope: 'project', project_id: p2.id,
  })).body.skill_pack;

  const res = await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id,
  });
  // DB trigger fires: 'Cannot bind project-scope skill pack to task in different project'
  assert.ok(res.status >= 400);
});

// ──── User-exclusion guard (DB trigger) ────

test('Skill Packs: user-exclusion DB trigger blocks update', async (t) => {
  const app = await createTestApp(t);
  const task = await createTask(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'ExclGuard' })).body.skill_pack;

  // User excludes
  await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id, excluded: true,
  });

  // Try to re-include (same user) — the binding exists with excluded=1, pinned_by='user'
  // The DB trigger prevents changing excluded/pinned_by on a user-excluded row
  // But the user can re-bind by overriding through the service layer (callerType='user')
  // Actually, the service layer does an UPDATE which will hit the trigger if trying to change excluded from 1 to 0
  const res = await request(app).post(`/api/tasks/${task.id}/skill-packs`).send({
    skill_pack_id: sp.id, excluded: false,
  });
  // DB trigger fires because OLD.excluded=1, OLD.pinned_by='user', NEW.excluded=0
  assert.ok(res.status >= 400);
});

// ──── Estimated Tokens ────

test('Skill Packs: estimated_tokens auto-calculated', async (t) => {
  const app = await createTestApp(t);
  const text = 'A'.repeat(400); // ~100 tokens
  const res = await request(app).post('/api/skill-packs').send({
    name: 'Tokens',
    prompt_full: text,
    prompt_compact: 'A'.repeat(80),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.estimated_tokens, 100);
  assert.equal(res.body.skill_pack.estimated_tokens_compact, 20);
});

// ──── Run Snapshots ────

test('Skill Packs: run snapshots endpoint returns empty for new run', async (t) => {
  const app = await createTestApp(t);
  // We need a run to query — runs are created through other APIs
  // Just test the endpoint returns properly for a non-existent run
  const res = await request(app).get('/api/runs/nonexistent/skill-packs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.skill_packs, []);
});

// ──── MCP Resolution ────

test('Skill Packs: resolveMcpServers resolves valid alias', async (t) => {
  const app = await createTestApp(t);
  // Create a pack with MCP to ensure templates are seeded, then test via API
  const spRes = await request(app).post('/api/skill-packs').send({
    name: 'WithMCP',
    mcp_servers: JSON.stringify({
      playwright: { env_overrides: { BROWSER: 'firefox' } },
    }),
  });
  assert.equal(spRes.status, 201);
  // Verify the pack stored valid mcp_servers
  const pack = spRes.body.skill_pack;
  const mcpServers = JSON.parse(pack.mcp_servers);
  assert.ok(mcpServers.playwright);
  assert.equal(mcpServers.playwright.env_overrides.BROWSER, 'firefox');
});

// ──── Conflict Policy ────

test('Skill Packs: conflict_policy defaults to fail', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({ name: 'DefaultPolicy' });
  assert.equal(res.body.skill_pack.conflict_policy, 'fail');
});

test('Skill Packs: conflict_policy accepts warn', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'WarnPolicy', conflict_policy: 'warn',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.conflict_policy, 'warn');
});

test('Skill Packs: conflict_policy rejects invalid', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'BadPolicy', conflict_policy: 'invalid',
  });
  assert.equal(res.status, 400);
});

// ──── inject_checklist ────

test('Skill Packs: inject_checklist stored as 0/1', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/skill-packs').send({
    name: 'InjectCL', inject_checklist: true,
    checklist: ['Check1'],
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.inject_checklist, 1);
});

// ──── Cascade deletes ────

test('Skill Packs: deleting project cascades to project-scope packs', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({
    name: 'CascadeTest', scope: 'project', project_id: project.id,
  })).body.skill_pack;

  await request(app).delete(`/api/projects/${project.id}`);
  const get = await request(app).get(`/api/skill-packs/${sp.id}`);
  assert.equal(get.status, 404);
});

test('Skill Packs: deleting skill pack cascades bindings', async (t) => {
  const app = await createTestApp(t);
  const project = await createProject(app);
  const sp = (await request(app).post('/api/skill-packs').send({ name: 'CascadeBind' })).body.skill_pack;
  await request(app).post(`/api/projects/${project.id}/skill-packs`).send({ skill_pack_id: sp.id });

  // Delete the pack
  await request(app).delete(`/api/skill-packs/${sp.id}`);
  // Bindings should be gone
  const list = await request(app).get(`/api/projects/${project.id}/skill-packs`);
  assert.equal(list.body.bindings.length, 0);
});
