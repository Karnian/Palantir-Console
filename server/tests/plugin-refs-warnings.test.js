// Gap #3 — /api/worker-presets/plugin-refs warnings for malformed plugin.json
// Valid dirs in plugin_refs, malformed dirs in warnings, server logs a warning.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function mkdirTemp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writePlugin(root, name, content = '{}') {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'plugin.json'), content);
}

async function createTestApp(t, pluginsRoot) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fsp.rm(storageRoot, { recursive: true, force: true });
    await fsp.rm(fsRoot, { recursive: true, force: true });
    await fsp.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

// ─── HTTP integration tests ───────────────────────────────────────────────────

test('GET /api/worker-presets/plugin-refs — valid plugins only, no warnings', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'alpha', '{"name":"alpha"}');
  writePlugin(pluginsRoot, 'beta', '{"name":"beta"}');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.plugin_refs.map(r => r.name), ['alpha', 'beta']);
  assert.deepEqual(res.body.warnings, []);
});

test('GET /api/worker-presets/plugin-refs — invalid JSON → excluded, warning returned', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'ok-plugin', '{"name":"ok-plugin"}');
  writePlugin(pluginsRoot, 'bad-json', '{bad}');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin_refs.length, 1);
  assert.equal(res.body.plugin_refs[0].name, 'ok-plugin');
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].dir, 'bad-json');
  assert.equal(res.body.warnings[0].reason, 'invalid_json', 'invalid JSON → reason=invalid_json');
  assert.ok(res.body.warnings[0].message, 'warning includes raw message detail');
});

test('GET /api/worker-presets/plugin-refs — null JSON (schema violation) → warning', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'null-plugin', 'null');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin_refs.length, 0);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].dir, 'null-plugin');
  assert.equal(res.body.warnings[0].reason, 'not_an_object');
  assert.match(res.body.warnings[0].message, /object/);
});

test('GET /api/worker-presets/plugin-refs — JSON array (not object) → warning', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'array-plugin', '["not","an","object"]');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin_refs.length, 0);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].dir, 'array-plugin');
  assert.equal(res.body.warnings[0].reason, 'not_an_object');
  assert.ok(res.body.warnings[0].message, 'message field present');
});

test('GET /api/worker-presets/plugin-refs — malformed JSON → reason=invalid_json + message field', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'syntax-err', '{not valid json}');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].reason, 'invalid_json');
  assert.ok(typeof res.body.warnings[0].message === 'string', 'message is a string');
  assert.ok(res.body.warnings[0].message.length > 0, 'message is non-empty');
});

test('GET /api/worker-presets/plugin-refs — mixed valid + malformed → only valid in plugin_refs', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  writePlugin(pluginsRoot, 'valid-one', '{"name":"valid-one"}');
  writePlugin(pluginsRoot, 'malformed', 'INVALID');
  writePlugin(pluginsRoot, 'valid-two', '{"name":"valid-two"}');
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  const names = res.body.plugin_refs.map(r => r.name).sort();
  assert.deepEqual(names, ['valid-one', 'valid-two']);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].dir, 'malformed');
  assert.equal(res.body.warnings[0].reason, 'invalid_json');
  assert.ok(res.body.warnings[0].message, 'message field present');
});

test('GET /api/worker-presets/plugin-refs — no plugins → empty arrays', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.plugin_refs, []);
  assert.deepEqual(res.body.warnings, []);
});
