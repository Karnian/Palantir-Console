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
  const dbDir = await createTempDir('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  return { app };
}

// ─── Registry Service (bundled) ───

test('GET /api/skill-packs/registry returns bundled packs', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/skill-packs/registry');
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'bundled');
  assert.ok(Array.isArray(res.body.categories));
  assert.ok(res.body.categories.length >= 8);
  assert.ok(Array.isArray(res.body.packs));
  assert.ok(res.body.packs.length >= 8);
  // Each pack should have install status fields
  const pack = res.body.packs[0];
  assert.equal(pack.installed, false);
  assert.equal(pack.localId, null);
  assert.equal(pack.updateAvailable, false);
  assert.ok(pack.registry_id);
  assert.ok(pack.name);
  assert.ok(pack._source === 'bundled');
});

test('GET /api/skill-packs/registry/pack returns single pack', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .get('/api/skill-packs/registry/pack')
    .query({ id: 'core/code-review' });
  assert.equal(res.status, 200);
  assert.ok(res.body.pack);
  assert.equal(res.body.pack.registry_id, 'core/code-review');
  assert.equal(res.body.pack.installed, false);
});

test('GET /api/skill-packs/registry/pack returns 404 for unknown', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .get('/api/skill-packs/registry/pack')
    .query({ id: 'core/nonexistent' });
  assert.equal(res.status, 404);
});

test('GET /api/skill-packs/registry/pack returns 400 without id', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/skill-packs/registry/pack');
  assert.equal(res.status, 400);
});

// ─── Install ───

test('POST /api/skill-packs/registry/install installs a bundled pack', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 201);
  const pack = res.body.skill_pack;
  assert.ok(pack.id);
  assert.equal(pack.registry_id, 'core/code-review');
  assert.equal(pack.registry_version, '1.0.0');
  assert.equal(pack.scope, 'global');
  assert.ok(pack.prompt_full);

  // Verify it shows as installed in registry listing
  const listRes = await request(app).get('/api/skill-packs/registry');
  const listed = listRes.body.packs.find(p => p.registry_id === 'core/code-review');
  assert.equal(listed.installed, true);
  assert.equal(listed.localId, pack.id);
  assert.equal(listed.updateAvailable, false);
});

test('POST /api/skill-packs/registry/install rejects duplicate registry_id with 409', async (t) => {
  const { app } = await createTestApp(t);
  await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/code-review' });
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('Already installed'));
});

test('POST /api/skill-packs/registry/install rejects name collision with 409', async (t) => {
  const { app } = await createTestApp(t);
  await request(app)
    .post('/api/skill-packs')
    .send({ name: 'Code Review Expert', scope: 'global' });
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('already exists'));
});

test('POST /api/skill-packs/registry/install returns 404 for unknown registry_id', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/nonexistent' });
  assert.equal(res.status, 404);
});

test('POST /api/skill-packs/registry/install returns 400 without registry_id', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({});
  assert.equal(res.status, 400);
});

// ─── Update ───

test('POST /api/skill-packs/registry/update updates content fields only', async (t) => {
  const { app } = await createTestApp(t);
  // Install first
  const installRes = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/testing-expert' });
  const localId = installRes.body.skill_pack.id;

  // Rename the local pack (user customization)
  await request(app)
    .patch(`/api/skill-packs/${localId}`)
    .send({ name: 'My Custom Testing', priority: 50 });

  // Update from registry
  const updateRes = await request(app)
    .post('/api/skill-packs/registry/update')
    .send({ registry_id: 'core/testing-expert' });
  assert.equal(updateRes.status, 200);

  // User-customized fields preserved
  assert.equal(updateRes.body.skill_pack.name, 'My Custom Testing');
  assert.equal(updateRes.body.skill_pack.priority, 50);
  // Content fields updated (registry version maintained)
  assert.equal(updateRes.body.skill_pack.registry_version, '1.0.0');
});

test('POST /api/skill-packs/registry/update returns 404 for uninstalled pack', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/update')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 404);
  assert.ok(res.body.error.includes('No installed pack'));
});

test('POST /api/skill-packs/registry/update returns 404 for manual (non-registry) pack', async (t) => {
  const { app } = await createTestApp(t);
  // Create a manual pack (no registry_id)
  await request(app)
    .post('/api/skill-packs')
    .send({ name: 'Manual Pack', scope: 'global' });
  // Try to update it via registry route
  const res = await request(app)
    .post('/api/skill-packs/registry/update')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 404);
});

// ─── Refresh (Stage 2 stub) ───

test('POST /api/skill-packs/registry/refresh returns stub response', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/refresh');
  assert.equal(res.status, 200);
  assert.equal(res.body.refreshed, false);
  // v1.1 deprecated central registry; both reason strings acceptable during transition
  assert.ok(['remote_not_configured', 'deprecated_in_v1_1'].includes(res.body.reason));
});

// ─── Security validation (unit-level) ───

test('installFromRegistry rejects prompt_full exceeding 32KB', async (t) => {
  const { app } = await createTestApp(t);
  // Access skillPackService via internal wiring
  const { createSkillPackService } = require('../services/skillPackService');
  const { createDatabase } = require('../db/database');
  const dbDir = await createTempDir('palantir-db-sec-');
  const dbPath = path.join(dbDir, 'sec.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  const svc = createSkillPackService(db);
  t.after(() => { close(); fs.rm(dbDir, { recursive: true, force: true }); });

  const oversizedPack = {
    registry_id: 'test/oversized-full',
    registry_version: '1.0.0',
    name: 'Oversized Full',
    prompt_full: 'x'.repeat(32 * 1024 + 1),
    mcp_servers: {},
    checklist: [],
    _source: 'bundled',
  };
  assert.throws(
    () => svc.installFromRegistry(oversizedPack, {}),
    /prompt_full exceeds/
  );
});

test('installFromRegistry rejects prompt_compact exceeding 8KB', async (t) => {
  const { createSkillPackService } = require('../services/skillPackService');
  const { createDatabase } = require('../db/database');
  const dbDir = await createTempDir('palantir-db-sec2-');
  const dbPath = path.join(dbDir, 'sec2.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  const svc = createSkillPackService(db);
  t.after(() => { close(); fs.rm(dbDir, { recursive: true, force: true }); });

  const oversizedPack = {
    registry_id: 'test/oversized-compact',
    registry_version: '1.0.0',
    name: 'Oversized Compact',
    prompt_full: 'ok',
    prompt_compact: 'y'.repeat(8 * 1024 + 1),
    mcp_servers: {},
    checklist: [],
    _source: 'bundled',
  };
  assert.throws(
    () => svc.installFromRegistry(oversizedPack, {}),
    /prompt_compact exceeds/
  );
});

test('installFromRegistry rejects invalid color hex', async (t) => {
  const { createSkillPackService } = require('../services/skillPackService');
  const { createDatabase } = require('../db/database');
  const dbDir = await createTempDir('palantir-db-sec3-');
  const dbPath = path.join(dbDir, 'sec3.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  const svc = createSkillPackService(db);
  t.after(() => { close(); fs.rm(dbDir, { recursive: true, force: true }); });

  const packWithBadColor = {
    registry_id: 'test/bad-color',
    registry_version: '1.0.0',
    name: 'Bad Color',
    prompt_full: 'test',
    color: 'not-a-hex',
    mcp_servers: {},
    checklist: [],
    _source: 'bundled',
  };
  assert.throws(
    () => svc.installFromRegistry(packWithBadColor, {}),
    /Invalid color hex/
  );
});

test('installFromRegistry requires confirmed_preview for remote packs', async (t) => {
  const { createSkillPackService } = require('../services/skillPackService');
  const { createDatabase } = require('../db/database');
  const dbDir = await createTempDir('palantir-db-sec4-');
  const dbPath = path.join(dbDir, 'sec4.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  const svc = createSkillPackService(db);
  t.after(() => { close(); fs.rm(dbDir, { recursive: true, force: true }); });

  const remotePack = {
    registry_id: 'test/remote-pack',
    registry_version: '1.0.0',
    name: 'Remote Pack',
    prompt_full: 'test',
    mcp_servers: {},
    checklist: [],
    _source: 'remote',
  };
  // Without confirmed_preview → rejected
  assert.throws(
    () => svc.installFromRegistry(remotePack, {}),
    /confirmed_preview/
  );
  // Truthy non-true values must NOT bypass (strict === true)
  assert.throws(
    () => svc.installFromRegistry(remotePack, { confirmed_preview: 'true' }),
    /confirmed_preview/
  );
  assert.throws(
    () => svc.installFromRegistry(remotePack, { confirmed_preview: 1 }),
    /confirmed_preview/
  );
  assert.throws(
    () => svc.installFromRegistry(remotePack, { confirmed_preview: {} }),
    /confirmed_preview/
  );
  // With confirmed_preview === true → accepted
  const result = svc.installFromRegistry(remotePack, { confirmed_preview: true });
  assert.ok(result.id);
});

test('installFromRegistry rejects unknown MCP alias', async (t) => {
  const { createSkillPackService } = require('../services/skillPackService');
  const { createDatabase } = require('../db/database');
  const dbDir = await createTempDir('palantir-db-sec5-');
  const dbPath = path.join(dbDir, 'sec5.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  const svc = createSkillPackService(db);
  t.after(() => { close(); fs.rm(dbDir, { recursive: true, force: true }); });

  const packWithBadMcp = {
    registry_id: 'test/bad-mcp',
    registry_version: '1.0.0',
    name: 'Bad MCP',
    prompt_full: 'test',
    mcp_servers: { nonexistent_alias: {} },
    checklist: [],
    _source: 'bundled',
  };
  assert.throws(
    () => svc.installFromRegistry(packWithBadMcp, {}),
    /Unknown MCP server template alias/
  );
});

// ─── Security validation (integration) ───

test('install bundled pack validates color and stores valid hex', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/accessibility' });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.color, '#6fd4a0');
});

test('install returns 409 for duplicate registry_id', async (t) => {
  const { app } = await createTestApp(t);
  await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/security-audit' });
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/security-audit' });
  assert.equal(res.status, 409);
});

test('install returns 409 for name collision', async (t) => {
  const { app } = await createTestApp(t);
  await request(app)
    .post('/api/skill-packs')
    .send({ name: 'Code Review Expert', scope: 'global' });
  const res = await request(app)
    .post('/api/skill-packs/registry/install')
    .send({ registry_id: 'core/code-review' });
  assert.equal(res.status, 409);
});

// ─── Existing CRUD still works ───

test('existing skill pack CRUD is not broken by registry changes', async (t) => {
  const { app } = await createTestApp(t);

  // Create
  const createRes = await request(app)
    .post('/api/skill-packs')
    .send({ name: 'Manual Pack', scope: 'global', prompt_full: 'Test prompt' });
  assert.equal(createRes.status, 201);
  const id = createRes.body.skill_pack.id;

  // Read
  const getRes = await request(app).get(`/api/skill-packs/${id}`);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.skill_pack.name, 'Manual Pack');
  assert.equal(getRes.body.skill_pack.registry_id, null);

  // List
  const listRes = await request(app).get('/api/skill-packs');
  assert.ok(listRes.body.skill_packs.some(p => p.id === id));

  // Update
  const patchRes = await request(app)
    .patch(`/api/skill-packs/${id}`)
    .send({ name: 'Updated Pack' });
  assert.equal(patchRes.status, 200);

  // Delete
  const delRes = await request(app).delete(`/api/skill-packs/${id}`);
  assert.equal(delRes.status, 200);
});

// ─── Install all 8 core packs ───

test('can install all 8 core packs from bundled registry', async (t) => {
  const { app } = await createTestApp(t);
  const listRes = await request(app).get('/api/skill-packs/registry');
  const packs = listRes.body.packs;
  assert.ok(packs.length >= 8);

  for (const pack of packs) {
    const res = await request(app)
      .post('/api/skill-packs/registry/install')
      .send({ registry_id: pack.registry_id });
    assert.equal(res.status, 201, `Failed to install ${pack.registry_id}: ${JSON.stringify(res.body)}`);
  }

  // Verify all show as installed
  const afterRes = await request(app).get('/api/skill-packs/registry');
  assert.ok(afterRes.body.packs.every(p => p.installed));
});
