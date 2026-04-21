const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function mkdirTemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writePlugin(root, name, files = { 'plugin.json': '{}' }) {
  fsSync.mkdirSync(path.join(root, name), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, name, rel);
    fsSync.mkdirSync(path.dirname(abs), { recursive: true });
    fsSync.writeFileSync(abs, content);
  }
}

async function createTestApp(t, { withPlugins = [] } = {}) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  for (const name of withPlugins) writePlugin(pluginsRoot, name);
  const authResolverOpts = { hasKeychain: () => false };
  // authToken=null avoids sibling test PALANTIR_TOKEN leak (same reason as
  // preset-route.test.js — see PR #117).
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authResolverOpts, authToken: null,
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

test('GET /api/mcp-server-templates — returns seeded defaults', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/mcp-server-templates');
  assert.equal(res.status, 200);
  const aliases = res.body.templates.map((tpl) => tpl.alias).sort();
  assert.ok(aliases.includes('playwright'));
  assert.ok(aliases.includes('filesystem'));
});

test('POST /api/mcp-server-templates creates a new template', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/mcp-server-templates').send({
    alias: 'graphify',
    command: 'npx',
    args: ['-y', '@graphify/mcp'],
    allowed_env_keys: ['GRAPHIFY_ROOT'],
    description: 'Graphify knowledge graph',
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.template.alias, 'graphify');
  assert.ok(res.body.template.id.startsWith('tpl_'));
  assert.ok(res.body.template.updated_at);
});

test('POST rejects duplicate alias with 409', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/mcp-server-templates')
    .send({ alias: 'playwright', command: 'npx' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/);
});

test('POST rejects invalid alias with 400', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app)
    .post('/api/mcp-server-templates')
    .send({ alias: 'has spaces', command: 'echo' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /alias must match/);
});

test('POST rejects denylisted env key with 400', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).post('/api/mcp-server-templates').send({
    alias: 'sneaky',
    command: 'echo',
    allowed_env_keys: ['NODE_OPTIONS'],
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /globally-denied key/);
});

test('GET /:id/references returns refs for a referenced template', async (t) => {
  const app = await createTestApp(t, { withPlugins: ['sample'] });
  const create = await request(app).post('/api/mcp-server-templates').send({
    alias: 'ref_probe',
    command: 'echo',
  });
  assert.equal(create.status, 201);
  const tplId = create.body.template.id;

  // Bind to a preset to create a reference
  const preset = await request(app).post('/api/worker-presets').send({
    name: 'uses-ref-probe',
    plugin_refs: ['sample'],
    mcp_server_ids: [tplId],
  });
  assert.equal(preset.status, 201);

  const refs = await request(app).get(`/api/mcp-server-templates/${tplId}/references`);
  assert.equal(refs.status, 200);
  assert.ok(refs.body.references.presets.some((p) => p.name === 'uses-ref-probe'));
  assert.equal(refs.body.references.skillPacks.length, 0);
});

test('PATCH cannot change alias (immutable)', async (t) => {
  const app = await createTestApp(t);
  const create = await request(app).post('/api/mcp-server-templates').send({
    alias: 'immutable_check',
    command: 'echo',
  });
  const tplId = create.body.template.id;

  const rename = await request(app)
    .patch(`/api/mcp-server-templates/${tplId}`)
    .send({ alias: 'renamed', command: 'echo' });
  assert.equal(rename.status, 400);
  assert.match(rename.body.error, /alias is immutable/);

  // Same alias echoed back is fine
  const echo = await request(app)
    .patch(`/api/mcp-server-templates/${tplId}`)
    .send({ alias: 'immutable_check', command: 'bash' });
  assert.equal(echo.status, 200);
  assert.equal(echo.body.template.command, 'bash');
});

test('DELETE blocks when preset references template (409 + details)', async (t) => {
  const app = await createTestApp(t, { withPlugins: ['sample'] });
  const create = await request(app).post('/api/mcp-server-templates').send({
    alias: 'blocked_delete',
    command: 'echo',
  });
  const tplId = create.body.template.id;

  await request(app).post('/api/worker-presets').send({
    name: 'blocker',
    plugin_refs: ['sample'],
    mcp_server_ids: [tplId],
  });

  const del = await request(app).delete(`/api/mcp-server-templates/${tplId}`);
  assert.equal(del.status, 409);
  assert.match(del.body.error, /in use/);
  assert.ok(del.body.details);
  assert.ok(del.body.details.presets.some((p) => p.name === 'blocker'));
});

test('DELETE blocks when skill pack references template by alias', async (t) => {
  const app = await createTestApp(t);
  const create = await request(app).post('/api/mcp-server-templates').send({
    alias: 'pack_blocker',
    command: 'echo',
    allowed_env_keys: ['FOO'],
  });
  const tplId = create.body.template.id;

  await request(app).post('/api/skill-packs').send({
    name: 'uses-pack-blocker',
    scope: 'global',
    mcp_servers: { pack_blocker: { env_overrides: { FOO: 'bar' } } },
  });

  const del = await request(app).delete(`/api/mcp-server-templates/${tplId}`);
  assert.equal(del.status, 409);
  assert.ok(del.body.details.skillPacks.some((p) => p.name === 'uses-pack-blocker'));
});

test('DELETE succeeds after references removed', async (t) => {
  const app = await createTestApp(t, { withPlugins: ['sample'] });
  const create = await request(app).post('/api/mcp-server-templates').send({
    alias: 'removable_route',
    command: 'echo',
  });
  const tplId = create.body.template.id;

  const preset = await request(app).post('/api/worker-presets').send({
    name: 'temp_user',
    plugin_refs: ['sample'],
    mcp_server_ids: [tplId],
  });
  // Drop the reference
  await request(app)
    .patch(`/api/worker-presets/${preset.body.preset.id}`)
    .send({ mcp_server_ids: [] });

  const del = await request(app).delete(`/api/mcp-server-templates/${tplId}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.status, 'ok');

  const get = await request(app).get(`/api/mcp-server-templates/${tplId}`);
  assert.equal(get.status, 404);
});

test('GET /:id returns 404 for unknown id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/mcp-server-templates/tpl_does_not_exist');
  assert.equal(res.status, 404);
});

test('GET /:id/references returns 404 for unknown id', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get(
    '/api/mcp-server-templates/tpl_nope/references',
  );
  assert.equal(res.status, 404);
});
