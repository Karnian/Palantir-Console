// D3-2 — warnings.reason io_error / other 케이스 추가 테스트
//
// 기존 plugin-refs-warnings.test.js 는 invalid_json / not_an_object 만 커버.
// 여기서는 io_error (readFileSync throw) / other (unknown exception) 를 추가한다.
//
// 전략:
//   - io_error: HTTP integration test — fs.readFileSync 를 monkey-patch 해서 EACCES throw 재현.
//     presetService 는 require('node:fs') 로 같은 객체 참조를 가지므로 patch 가 효과적.
//   - other: unit-level test — presetService.listPluginRefs() 를 직접 호출.
//     presetService.js 의 outer try/catch 는 Array.isArray() 같이 내부 guard 바깥에서 throw 될 때만
//     도달 가능. 동기 호출 구간에만 Array.isArray 를 patch 하고 즉시 복원한다.
//     createPresetService 에 최소 DB stub 을 주입해서 HTTP 레이어 없이 테스트.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');
const { createPresetService } = require('../services/presetService');

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

// ─── D3-2a: io_error — readFileSync throws (EACCES simulation) ────────────────

test('GET /api/worker-presets/plugin-refs — io_error: readFileSync throw → reason=io_error + message', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));

  // Create a valid plugin dir with plugin.json
  writePlugin(pluginsRoot, 'inaccessible-plugin', '{"name":"inaccessible-plugin"}');

  // Monkey-patch fs.readFileSync to throw EACCES for that specific plugin.json
  const targetPath = path.join(pluginsRoot, 'inaccessible-plugin', 'plugin.json');
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (filePath, ...args) {
    if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetPath)) {
      const err = new Error('EACCES: permission denied');
      err.code = 'EACCES';
      throw err;
    }
    return origReadFileSync.call(this, filePath, ...args);
  };

  t.after(() => { fs.readFileSync = origReadFileSync; });

  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin_refs.length, 0, 'io_error plugin excluded from plugin_refs');
  assert.equal(res.body.warnings.length, 1, 'one warning emitted');
  assert.equal(res.body.warnings[0].dir, 'inaccessible-plugin');
  assert.equal(res.body.warnings[0].reason, 'io_error', 'reason should be io_error');
  assert.ok(typeof res.body.warnings[0].message === 'string', 'message is a string');
  assert.ok(res.body.warnings[0].message.length > 0, 'message is non-empty');
});

test('GET /api/worker-presets/plugin-refs — io_error + valid plugin → valid included, io_error warned', async (t) => {
  const pluginsRoot = await mkdirTemp('palantir-plugins-');
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));

  writePlugin(pluginsRoot, 'good-plugin', '{"name":"good-plugin"}');
  writePlugin(pluginsRoot, 'bad-read', '{"name":"bad-read"}');

  const targetPath = path.join(pluginsRoot, 'bad-read', 'plugin.json');
  const origReadFileSync = fs.readFileSync;
  fs.readFileSync = function (filePath, ...args) {
    if (typeof filePath === 'string' && path.resolve(filePath) === path.resolve(targetPath)) {
      const err = new Error('EACCES: permission denied, open \'' + targetPath + '\'');
      err.code = 'EACCES';
      throw err;
    }
    return origReadFileSync.call(this, filePath, ...args);
  };

  t.after(() => { fs.readFileSync = origReadFileSync; });

  const app = await createTestApp(t, pluginsRoot);
  const res = await request(app).get('/api/worker-presets/plugin-refs');
  assert.equal(res.status, 200);
  assert.equal(res.body.plugin_refs.length, 1, 'good plugin included');
  assert.equal(res.body.plugin_refs[0].name, 'good-plugin');
  assert.equal(res.body.warnings.length, 1, 'one warning for bad-read');
  assert.equal(res.body.warnings[0].dir, 'bad-read');
  assert.equal(res.body.warnings[0].reason, 'io_error');
});

// ─── D3-2b: other — unit-level test via presetService directly ───────────────
//
// The presetService.js outer try/catch (reason='other') catches errors that
// escape all inner guards:
//   - Inner readFileSync catch: catches ALL exceptions → io_error
//   - Inner JSON.parse catch:   catches ALL exceptions → invalid_json
//   - The only reachable path to 'other': code between inner catches inside the
//     outer try, e.g. Array.isArray(parsed) after JSON.parse succeeds.
//
// Strategy: call presetService.listPluginRefs() directly (no HTTP layer).
// Patch Array.isArray for the exact synchronous duration of the call, then
// restore. listPluginRefs() is fully synchronous so the restore happens before
// any other test code can observe the patch.

/** Minimal better-sqlite3 stub: only needs db.prepare() to succeed. */
function makeDbStub() {
  const noopStmt = { get: () => null, run: () => ({}), all: () => [] };
  return { prepare: () => noopStmt, transaction: (fn) => fn };
}

test('presetService.listPluginRefs() — other: Array.isArray throws inside outer try → reason=other + message', (t) => {
  const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-plugins-'));
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));
  os.tmpdir(); // ensure OS module loaded (already is)

  // A valid JSON object — readFileSync and JSON.parse both succeed.
  // The outer catch fires when Array.isArray(parsed) throws.
  writePlugin(pluginsRoot, 'outer-catch-plugin', '{"name":"outer-catch-plugin"}');

  const svc = createPresetService(makeDbStub(), { pluginsRoot });

  const origArrayIsArray = Array.isArray;
  let shouldThrow = true;
  Array.isArray = function (v) {
    // Throw only for the first plain object parsed by listPluginRefs
    if (shouldThrow && v !== null && typeof v === 'object' && !origArrayIsArray(v)) {
      shouldThrow = false; // throw exactly once
      throw new RangeError('Simulated Array.isArray failure: outer catch path test');
    }
    return origArrayIsArray.call(this, v);
  };

  let result;
  try {
    result = svc.listPluginRefs();
  } finally {
    // Restore immediately after the synchronous call
    Array.isArray = origArrayIsArray;
  }

  assert.equal(result.plugin_refs.length, 0, 'other-error plugin excluded');
  assert.equal(result.warnings.length, 1, 'one warning emitted');
  assert.equal(result.warnings[0].dir, 'outer-catch-plugin');
  assert.equal(result.warnings[0].reason, 'other', 'reason should be other');
  assert.ok(typeof result.warnings[0].message === 'string', 'message is a string');
  assert.match(result.warnings[0].message, /Simulated Array\.isArray/, 'message contains original error text');
});

test('presetService.listPluginRefs() — other: mixed with valid → warnings shape correct', (t) => {
  // Two plugins: one triggers 'other', one succeeds.
  // We mark the failing one with a sentinel property so the Array.isArray patch
  // can identify it regardless of filesystem iteration order.
  const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-plugins-'));
  t.after(() => fsp.rm(pluginsRoot, { recursive: true, force: true }));

  writePlugin(pluginsRoot, 'clean-plugin', '{"name":"clean-plugin"}');
  // __d3_other__ sentinel: triggers our Array.isArray patch
  writePlugin(pluginsRoot, 'bad-plugin', '{"name":"bad-plugin","__d3_other__":true}');

  const svc = createPresetService(makeDbStub(), { pluginsRoot });

  const origArrayIsArray = Array.isArray;
  Array.isArray = function (v) {
    // Throw only when we see the sentinel property — regardless of iteration order
    if (v !== null && typeof v === 'object' && !origArrayIsArray(v) && v.__d3_other__ === true) {
      throw new RangeError('Simulated outer catch for mixed test');
    }
    return origArrayIsArray.call(this, v);
  };

  let result;
  try {
    result = svc.listPluginRefs();
  } finally {
    Array.isArray = origArrayIsArray;
  }

  assert.equal(result.plugin_refs.length, 1, 'clean plugin included');
  assert.equal(result.plugin_refs[0].name, 'clean-plugin');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].dir, 'bad-plugin');
  assert.equal(result.warnings[0].reason, 'other');
  assert.match(result.warnings[0].message, /Simulated outer catch/);
});
