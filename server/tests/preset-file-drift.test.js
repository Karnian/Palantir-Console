// Gap #2 — preset-snapshot file_hashes drift comparison
// Tests computePresetDrift with file hash args, and the E2E route endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');
const { createDatabase } = require('../db/database');
const { computePresetDrift } = require('../routes/runs');

// ─── Unit tests: computePresetDrift with file hash args ──────────────────────

const CORE = {
  name: 'P', description: null, isolated: false, plugin_refs: ['fx'],
  mcp_server_ids: [], base_system_prompt: null, setting_sources: '', min_claude_version: null,
};

test('computePresetDrift: no file hashes → has_drift false, changed_files []', () => {
  const d = computePresetDrift(CORE, { ...CORE }, [], []);
  assert.equal(d.deleted, false);
  assert.deepEqual(d.changed_fields, []);
  assert.deepEqual(d.changed_files, []);
  assert.equal(d.has_drift, false);
});

test('computePresetDrift: identical file hashes → no file drift', () => {
  const hashes = [{ path: 'fx/plugin.json', sha256: 'aaa' }];
  const d = computePresetDrift(CORE, { ...CORE }, hashes, hashes);
  assert.equal(d.has_drift, false);
  assert.deepEqual(d.changed_files, []);
});

test('computePresetDrift: modified file → status modified', () => {
  const snap = [{ path: 'fx/plugin.json', sha256: 'aaa' }];
  const curr = [{ path: 'fx/plugin.json', sha256: 'bbb' }];
  const d = computePresetDrift(CORE, { ...CORE }, snap, curr);
  assert.equal(d.has_drift, true);
  assert.equal(d.changed_files.length, 1);
  assert.equal(d.changed_files[0].status, 'modified');
  assert.equal(d.changed_files[0].old_hash, 'aaa');
  assert.equal(d.changed_files[0].new_hash, 'bbb');
  assert.equal(d.changed_files[0].path, 'fx/plugin.json');
});

test('computePresetDrift: deleted file → status deleted', () => {
  const snap = [{ path: 'fx/plugin.json', sha256: 'aaa' }];
  const curr = [];
  const d = computePresetDrift(CORE, { ...CORE }, snap, curr);
  assert.equal(d.has_drift, true);
  assert.equal(d.changed_files[0].status, 'deleted');
  assert.equal(d.changed_files[0].new_hash, null);
});

test('computePresetDrift: added file → status added', () => {
  const snap = [];
  const curr = [{ path: 'fx/new.js', sha256: 'ccc' }];
  const d = computePresetDrift(CORE, { ...CORE }, snap, curr);
  assert.equal(d.has_drift, true);
  assert.equal(d.changed_files[0].status, 'added');
  assert.equal(d.changed_files[0].old_hash, null);
  assert.equal(d.changed_files[0].new_hash, 'ccc');
});

test('computePresetDrift: core field + file change → both reported', () => {
  const snap = [{ path: 'fx/a.js', sha256: 'x' }];
  const curr = [{ path: 'fx/a.js', sha256: 'y' }];
  const d = computePresetDrift(CORE, { ...CORE, name: 'Q' }, snap, curr);
  assert.equal(d.has_drift, true);
  assert.ok(d.changed_fields.includes('name'));
  assert.equal(d.changed_files.length, 1);
  assert.equal(d.changed_files[0].status, 'modified');
});

test('computePresetDrift: deleted preset → has_drift true regardless of files', () => {
  const d = computePresetDrift(CORE, null, [{ path: 'fx/a.js', sha256: 'x' }], []);
  assert.equal(d.deleted, true);
  assert.equal(d.has_drift, true);
});

test('computePresetDrift: backward compat — called without file hash args', () => {
  const d = computePresetDrift(CORE, { ...CORE });
  assert.equal(d.has_drift, false);
  assert.deepEqual(d.changed_files, []);
});

test('computePresetDrift: multiple files — sorted by path', () => {
  const snap = [
    { path: 'fx/z.js', sha256: '111' },
    { path: 'fx/a.js', sha256: '222' },
  ];
  const curr = [
    { path: 'fx/z.js', sha256: '999' }, // modified
    { path: 'fx/a.js', sha256: '222' }, // unchanged
    { path: 'fx/new.js', sha256: '333' }, // added
  ];
  const d = computePresetDrift(CORE, { ...CORE }, snap, curr);
  assert.equal(d.has_drift, true);
  assert.equal(d.changed_files.length, 2);
  // sorted by path
  assert.equal(d.changed_files[0].path, 'fx/new.js');
  assert.equal(d.changed_files[0].status, 'added');
  assert.equal(d.changed_files[1].path, 'fx/z.js');
  assert.equal(d.changed_files[1].status, 'modified');
});

// ─── E2E tests via HTTP ───────────────────────────────────────────────────────

async function mkdirTemp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function writePlugin(root, name, files = { 'plugin.json': '{}' }) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

async function createTestEnv(t, pluginFiles = {}) {
  const storageRoot = await mkdirTemp('palantir-storage-');
  const fsRoot = await mkdirTemp('palantir-fs-');
  const dbDir = await mkdirTemp('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const pluginsRoot = await mkdirTemp('palantir-plugins-');

  for (const [name, files] of Object.entries(pluginFiles)) {
    writePlugin(pluginsRoot, name, files);
  }

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

  // Open a SECOND DB connection AFTER app (which ran migrations)
  // so the schema is ready. WAL mode allows concurrent readers.
  const { db: rawDb, close: closeRawDb } = createDatabase(dbPath);
  t.after(() => closeRawDb());

  return { app, rawDb, pluginsRoot };
}

test('GET /api/runs/:id/preset-snapshot — drift includes changed_files when file hash changes', async (t) => {
  const { app, rawDb } = await createTestEnv(t, {
    fx: { 'plugin.json': '{"name":"fx"}', 'main.js': 'console.log("v2")' },
  });

  // Create agent profile
  const agentRes = await request(app).post('/api/agents').send({
    name: 'test-agent', type: 'claude', command: 'claude',
  });
  assert.equal(agentRes.status, 201);
  const agentId = agentRes.body.agent.id;

  // Create preset referencing fx plugin
  const presetRes = await request(app).post('/api/worker-presets').send({
    name: 'drift-preset', plugin_refs: ['fx'],
  });
  assert.equal(presetRes.status, 201);
  const presetId = presetRes.body.preset.id;

  // Create task + run
  const taskRes = await request(app).post('/api/tasks').send({ title: 'drift task' });
  const taskId = taskRes.body.task.id;

  const runRes = await request(app).post('/api/runs').send({
    task_id: taskId, agent_profile_id: agentId, status: 'completed',
  });
  assert.equal(runRes.status, 201);
  const runId = runRes.body.run.id;

  // Inject snapshot row with OLD file hash (simulating hash at run time)
  const snapCore = JSON.stringify({
    name: 'drift-preset', isolated: false, plugin_refs: ['fx'],
    mcp_server_ids: [], base_system_prompt: null, setting_sources: '', min_claude_version: null,
  });
  const oldFileHashes = JSON.stringify([
    { path: 'fx/main.js', sha256: 'old_hash_before_modification' },
    { path: 'fx/plugin.json', sha256: 'old_plugin_hash' },
  ]);
  rawDb.prepare(`
    INSERT OR REPLACE INTO run_preset_snapshots
      (run_id, preset_id, preset_snapshot_hash, snapshot_json, file_hashes, applied_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(runId, presetId, 'testhash_abc', snapCore, oldFileHashes);
  // Also update the run to point to preset_id (needed for RunInspector tab visibility)
  rawDb.prepare('UPDATE runs SET preset_id = ? WHERE id = ?').run(presetId, runId);

  const res = await request(app).get(`/api/runs/${runId}/preset-snapshot`);
  assert.equal(res.status, 200);
  assert.ok(res.body.snapshot, 'snapshot should be present');
  const drift = res.body.drift;
  assert.ok(drift, 'drift should be present');
  assert.ok('has_drift' in drift, 'drift must include has_drift');
  assert.ok(Array.isArray(drift.changed_files), 'drift must include changed_files array');
  assert.equal(drift.has_drift, true, 'file hashes changed → drift');

  // Both files had old hashes; disk hashes differ → should be modified
  const modified = drift.changed_files.filter(f => f.status === 'modified');
  assert.ok(modified.length >= 1, 'at least one file modified');
  assert.ok(modified.every(f => f.old_hash && f.new_hash), 'modified files have both hashes');
});

test('GET /api/runs/:id/preset-snapshot — no file drift when hashes match', async (t) => {
  const { app, rawDb, pluginsRoot } = await createTestEnv(t, {
    fx: { 'plugin.json': '{"name":"fx"}' },
  });

  const agentRes = await request(app).post('/api/agents').send({
    name: 'a', type: 'claude', command: 'claude',
  });
  const agentId = agentRes.body.agent.id;

  const presetRes = await request(app).post('/api/worker-presets').send({
    name: 'stable-preset', plugin_refs: ['fx'],
  });
  const presetId = presetRes.body.preset.id;

  const taskRes = await request(app).post('/api/tasks').send({ title: 't' });
  const taskId = taskRes.body.task.id;

  const runRes = await request(app).post('/api/runs').send({
    task_id: taskId, agent_profile_id: agentId, status: 'completed',
  });
  const runId = runRes.body.run.id;

  // Read actual file hash from disk
  const crypto = require('node:crypto');
  const pluginJsonBuf = fs.readFileSync(path.join(pluginsRoot, 'fx', 'plugin.json'));
  const realHash = crypto.createHash('sha256').update(pluginJsonBuf).digest('hex');

  const snapCore = JSON.stringify({
    name: 'stable-preset', isolated: false, plugin_refs: ['fx'],
    mcp_server_ids: [], base_system_prompt: null, setting_sources: '', min_claude_version: null,
  });
  // Use real hash to simulate no drift
  const currentFileHashes = JSON.stringify([{ path: 'fx/plugin.json', sha256: realHash }]);
  rawDb.prepare(`
    INSERT OR REPLACE INTO run_preset_snapshots
      (run_id, preset_id, preset_snapshot_hash, snapshot_json, file_hashes, applied_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(runId, presetId, 'stablehash', snapCore, currentFileHashes);
  rawDb.prepare('UPDATE runs SET preset_id = ? WHERE id = ?').run(presetId, runId);

  const res = await request(app).get(`/api/runs/${runId}/preset-snapshot`);
  assert.equal(res.status, 200);
  const drift = res.body.drift;
  assert.ok(drift, 'drift should be present');
  assert.equal(drift.has_drift, false, 'hashes match → no drift');
  assert.deepEqual(drift.changed_files, [], 'no changed files');
  assert.deepEqual(drift.changed_fields, [], 'no changed fields');
});

// ─── Phase D1: drift_error surface ───────────────────────────────────────────

test('computePresetDrift returns drift_error with empty changed_files when file comparison unavailable', () => {
  const core = { ...CORE };
  const current = { ...CORE };
  // currentFileHashes=null triggers skip, driftError is surfaced
  const d = computePresetDrift(core, current, [], null, { driftError: 'boom' });
  assert.equal(d.drift_error, 'boom', 'drift_error must equal the provided error message');
  assert.deepEqual(d.changed_files, [], 'changed_files must be empty when file comparison skipped');
  assert.equal(d.has_drift, false, 'drift_error alone must not set has_drift');
});

test('has_drift is false when only drift_error is set (no core diff)', () => {
  const core = { ...CORE };
  const current = { ...CORE };
  const d = computePresetDrift(core, current, [], null, { driftError: 'fs error' });
  assert.equal(d.has_drift, false);
  assert.ok(d.drift_error);
});

test('route surfaces drift_error when computeCurrentFileHashes throws', async (t) => {
  const { app, rawDb, pluginsRoot } = await createTestEnv(t, {
    fx: { 'plugin.json': '{"name":"fx"}' },
  });

  const agentRes = await request(app).post('/api/agents').send({
    name: 'err-agent', type: 'claude', command: 'claude',
  });
  const agentId = agentRes.body.agent.id;

  const presetRes = await request(app).post('/api/worker-presets').send({
    name: 'err-preset', plugin_refs: ['fx'],
  });
  const presetId = presetRes.body.preset.id;

  const taskRes = await request(app).post('/api/tasks').send({ title: 'err-task' });
  const taskId = taskRes.body.task.id;
  const runRes = await request(app).post('/api/runs').send({
    task_id: taskId, agent_profile_id: agentId, status: 'completed',
  });
  const runId = runRes.body.run.id;

  // Inject snapshot with old name so core-field 'name' differs from current preset
  const snapCore = JSON.stringify({
    name: 'err-preset-OLD', description: null, isolated: false, plugin_refs: ['fx'],
    mcp_server_ids: [], base_system_prompt: null, setting_sources: '', min_claude_version: null,
  });
  rawDb.prepare(`
    INSERT OR REPLACE INTO run_preset_snapshots
      (run_id, preset_id, preset_snapshot_hash, snapshot_json, file_hashes, applied_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(runId, presetId, 'errhash', snapCore, JSON.stringify([]));
  rawDb.prepare('UPDATE runs SET preset_id = ? WHERE id = ?').run(presetId, runId);

  // Make plugin.json unreadable so fs.readFileSync throws EACCES during
  // buildManifest → computeCurrentFileHashes will throw → route catches it.
  const pluginJsonPath = path.join(pluginsRoot, 'fx', 'plugin.json');
  const origMode = fs.statSync(pluginJsonPath).mode;
  fs.chmodSync(pluginJsonPath, 0o000);
  t.after(() => {
    try { fs.chmodSync(pluginJsonPath, origMode); } catch { /* already cleaned */ }
  });

  const res = await request(app).get(`/api/runs/${runId}/preset-snapshot`);
  assert.equal(res.status, 200, 'must respond 200 even when file recomputation fails');
  const drift = res.body.drift;
  assert.ok(drift, 'drift must be present');
  assert.ok(drift.drift_error, 'drift_error must be present when file computation throws');
  assert.deepEqual(drift.changed_files, [], 'changed_files must be empty on drift_error');
  // Core field 'name' differs between old snapshot ('err-preset-OLD') and current preset ('err-preset')
  assert.ok(drift.changed_fields.includes('name'), 'core-field name drift must still be detected');
});
