// Phase 10F — GET /api/runs/:id/preset-snapshot + drift computation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');
const { computePresetDrift } = require('../routes/runs');

test('computePresetDrift: deleted preset', () => {
  const d = computePresetDrift({ name: 'X' }, null);
  assert.equal(d.deleted, true);
  assert.deepEqual(d.changed_fields, []);
});

test('computePresetDrift: identical → no changed_fields', () => {
  const core = {
    name: 'X', description: null, isolated: false, plugin_refs: [], mcp_server_ids: [],
    base_system_prompt: null, setting_sources: '', min_claude_version: null,
  };
  const d = computePresetDrift(core, { ...core });
  assert.equal(d.deleted, false);
  assert.deepEqual(d.changed_fields, []);
});

test('computePresetDrift: detects changed name + plugin_refs', () => {
  const snap = {
    name: 'A', description: null, isolated: false, plugin_refs: ['p1'], mcp_server_ids: [],
    base_system_prompt: null, setting_sources: '', min_claude_version: null,
  };
  const cur = {
    ...snap, name: 'B', plugin_refs: ['p1', 'p2'],
  };
  const d = computePresetDrift(snap, cur);
  assert.deepEqual(d.changed_fields.sort(), ['name', 'plugin_refs']);
});

async function mkdirTemp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writePlugin(root, name) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'plugin.json'), '{}');
}

async function createTestApp(t) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  writePlugin(pluginsRoot, 'fx');
  const app = createApp({
    storageRoot, fsRoot, opencodeBin: 'opencode', dbPath, pluginsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    if (app.shutdown) app.shutdown(); else app.closeDb();
    await fsp.rm(storageRoot, { recursive: true, force: true });
    await fsp.rm(fsRoot, { recursive: true, force: true });
    await fsp.rm(dbDir, { recursive: true, force: true });
    await fsp.rm(pluginsRoot, { recursive: true, force: true });
  });
  return app;
}

test('GET /api/runs/:id/preset-snapshot 404s for unknown run', async (t) => {
  const app = await createTestApp(t);
  const res = await request(app).get('/api/runs/run_does_not_exist/preset-snapshot');
  assert.equal(res.status, 404);
});

// Phase D1: legacy snapshot row backward compat + drift_error surface

test('computePresetDrift skips description when snapshotCore omits it (legacy row)', () => {
  // Simulate a legacy snapshot_json that has no `description` key
  const legacyCore = {
    name: 'X', isolated: false, plugin_refs: [], mcp_server_ids: [],
    base_system_prompt: null, setting_sources: '', min_claude_version: null,
    // no `description` field — pre-Phase-D snapshot
  };
  const current = { ...legacyCore, description: 'some new description' };
  const d = computePresetDrift(legacyCore, current, [], []);
  assert.ok(!d.changed_fields.includes('description'),
    'description must not appear in changed_fields for legacy snapshots that omit it');
  assert.equal(d.has_drift, false);
});

test('computePresetDrift still compares description when snapshotCore explicitly contains it', () => {
  const core = {
    name: 'X', description: null, isolated: false, plugin_refs: [], mcp_server_ids: [],
    base_system_prompt: null, setting_sources: '', min_claude_version: null,
  };
  const current = { ...core, description: 'new value' };
  const d = computePresetDrift(core, current, [], []);
  assert.ok(d.changed_fields.includes('description'),
    'description must appear in changed_fields when it was present in snapshot and differs');
  assert.equal(d.has_drift, true);
});
