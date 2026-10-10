'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const request = require('supertest');
const { createApp } = require('../app');
const { runSnapshot, loadConfig } = require('../../scripts/lib/sessionSnapshotReader.cjs');
const { validateSnapshot, SNAPSHOT_LIMITS } = require('../services/observeSnapshotPolicy');
const {
  sealObserveState, listSnapshots, readSnapshot, createObserveSnapshotStore, STORE_LIMITS,
} = require('../services/observeSnapshotStore');
const { ERROR_STATUS, observeErrorHandler } = require('../routes/observe');
const { AppError } = require('../utils/errors');

const TOKEN = 'observe-human-fixture';
const PM_TOKEN = 'observe-pm-fixture';
const COOKIE = `palantir_token=${TOKEN}`;
const SECRET = 'sk-ant-api03-' + 'Q'.repeat(80);
const BASE = '/api/observe';
const LIST = `${BASE}/snapshots`;
const DETAIL = `${LIST}/alpha`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'observe-endpoint-')));
  const dir = path.join(root, 'snapshots');
  const homeDir = path.join(root, 'home');
  const apps = [];
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(homeDir, '.claude', 'projects'), { recursive: true });
  const rows = [{
    type: 'user', sessionId: 's', uuid: 'u', parentUuid: null,
    timestamp: '2026-10-08T02:00:00.000Z', cwd: path.join(root, 'repo'),
    origin: { kind: 'human' }, message: { content: 'Review the snapshot endpoint fixture.' },
  }];
  fs.writeFileSync(path.join(homeDir, '.claude', 'projects', 'fixture.jsonl'),
    rows.map(function encodeRow(row) { return JSON.stringify(row); }).join('\n'));
  const readerOptions = {
    homeDir, configDir: path.join(homeDir, '.config', 'palantir'),
    now: new Date('2026-10-08T03:00:00.000Z'), readerBuild: '0123456789abcdef',
    runOrca: function noOrca() { return null; },
  };
  const config = loadConfig(readerOptions);
  config.machine_id = 'alpha';
  config.machine_label = 'fixture_mac';
  fs.writeFileSync(path.join(readerOptions.configDir, 'observe.json'), JSON.stringify(config));
  const snapshot = runSnapshot(readerOptions);
  assert.equal(validateSnapshot(snapshot).ok, true);
  assert.ok(snapshot.instructions.length > 0);
  assert.ok(snapshot.coverage.claude.files_scanned > 0);
  fs.writeFileSync(path.join(dir, 'alpha.json'), JSON.stringify(snapshot), { mode: 0o600 });
  t.after(async function cleanupFixture() {
    for (const app of apps) await app.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dir, homeDir, snapshot, apps, filename: path.join(dir, 'alpha.json') };
}

function makeApp(fx, options = {}) {
  const appRoot = fs.mkdtempSync(path.join(fx.root, 'app-'));
  const previousCwd = process.cwd();
  let app;
  try {
    // createApp's runtime/mcp directory belongs to this fixture too.
    process.chdir(appRoot);
    app = createApp({
      authToken: TOKEN, pmToken: PM_TOKEN, observeSnapshotDir: fx.dir,
      storageRoot: path.join(appRoot, 'storage'), fsRoot: fx.homeDir,
      dbPath: path.join(appRoot, 'test.db'), pluginsRoot: path.join(appRoot, 'plugins'),
      codexHome: path.join(fx.homeDir, '.codex'),
      authResolverOpts: { hasKeychain: function noKeychain() { return false; } },
      agentProcessIsolation: true, execAttestation: { verified: true, reason: 'test' },
      memoryDistillEnabled: false, operatorSchedulerEnabled: false,
      ...options,
    });
  } finally {
    process.chdir(previousCwd);
  }
  fx.apps.push(app);
  return app;
}

function cookieGet(app, url = DETAIL) {
  return request(app).get(url).set('Cookie', COOKIE);
}

function writeSnapshot(fx, snapshot = fx.snapshot, machineId = snapshot.machine.id) {
  const filename = path.join(fx.dir, `${machineId}.json`);
  fs.writeFileSync(filename, JSON.stringify(snapshot), { mode: 0o600 });
  return filename;
}

function anotherSnapshot(fx, machineId) {
  const snapshot = structuredClone(fx.snapshot);
  snapshot.machine.id = machineId;
  for (const session of snapshot.sessions) session.key = `${machineId}:claude:${session.session_id}`;
  for (const instruction of snapshot.instructions) instruction.session_key = snapshot.sessions[0].key;
  assert.equal(validateSnapshot(snapshot).ok, true);
  writeSnapshot(fx, snapshot);
  return snapshot;
}

function assertError(response, status, reason) {
  assert.equal(response.status, status);
  assert.deepEqual(response.body, { error: reason, reason });
  assert.equal(response.headers['cache-control'], 'no-store');
}

function spyFs(names) {
  const calls = Object.fromEntries(names.map(function counter(name) { return [name, 0]; }));
  const originals = {};
  for (const name of names) {
    originals[name] = fs[name];
    fs[name] = function countedFs(...args) {
      calls[name]++;
      return originals[name].apply(fs, args);
    };
  }
  return {
    calls,
    reset: function resetCounters() { for (const name of names) calls[name] = 0; },
    restore: function restoreFs() { for (const name of names) fs[name] = originals[name]; },
  };
}

test('store: boot sealing covers valid, unset, tokenless, symlink, permissions and owner', (t) => {
  const fx = fixture(t);
  const on = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  assert.deepEqual(on, { on: true, code: null, root: fx.dir });
  assert.equal(Object.isFrozen(on), true);
  assert.equal(sealObserveState({ dir: `${fx.dir}/../snapshots`, authToken: TOKEN }).code,
    'observe_root_invalid');
  const symlink = path.join(fx.root, 'link');
  fs.symlinkSync(fx.dir, symlink);
  const cases = [
    [{ dir: null, authToken: TOKEN }, 'observe_dir_unset'],
    [{ dir: fx.dir, authToken: null }, 'observe_auth_off'],
    [{ dir: symlink, authToken: TOKEN }, 'observe_root_invalid'],
    [{ dir: fx.filename, authToken: TOKEN }, 'observe_root_invalid'],
    [{ dir: path.join(fx.root, 'missing'), authToken: TOKEN }, 'observe_root_invalid'],
    [{ dir: fx.dir, authToken: TOKEN, uid: fs.statSync(fx.dir).uid + 1 }, 'observe_root_owner'],
  ];
  for (const [options, code] of cases) {
    assert.deepEqual(sealObserveState(options), { on: false, code, root: null });
  }
  for (const mode of [0o720, 0o702]) {
    fs.chmodSync(fx.dir, mode);
    assert.equal(sealObserveState({ dir: fx.dir, authToken: TOKEN }).code, 'observe_root_writable');
  }
  fs.chmodSync(fx.dir, 0o700);
  assert.deepEqual(sealObserveState({ dir: fx.dir, authToken: TOKEN }), on);
});

test('store: normal output, closed metadata, off has zero FS, and default limits', (t) => {
  const fx = fixture(t);
  const on = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  const off = sealObserveState({ dir: null, authToken: TOKEN });
  const spy = spyFs(['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync']);
  try {
    assert.deepEqual(readSnapshot(on, 'alpha').snapshot, fx.snapshot);
    assert.equal(listSnapshots(on).snapshots.length, 1);
    for (const count of Object.values(spy.calls)) assert.ok(count > 0);
    spy.reset();
    assert.equal(readSnapshot(off, 'alpha').reason, 'observe_off');
    assert.equal(listSnapshots(off).reason, 'observe_off');
    for (const count of Object.values(spy.calls)) assert.equal(count, 0);
  } finally {
    spy.restore();
  }
  assert.equal(STORE_LIMITS.fileBytes, 16 * 1024 * 1024);
  assert.equal(STORE_LIMITS.fileBytes, SNAPSHOT_LIMITS.bytes);
  assert.equal(STORE_LIMITS.totalBytes, 64 * 1024 * 1024);
  assert.throws(function increasedLimit() {
    createObserveSnapshotStore({ totalBytes: STORE_LIMITS.totalBytes + 1 });
  }, /invalid observe limit/);
});

test('endpoint: on fixture reads FS; sealed off hides every method/path with zero FS after boot', async (t) => {
  const fx = fixture(t);
  const on = makeApp(fx);
  const off = makeApp(fx, { observeSnapshotDir: null });
  const names = ['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync',
    'statSync', 'readFileSync', 'writeFileSync', 'renameSync', 'stat', 'open', 'readdir'];
  const spy = spyFs(names);
  try {
    assert.equal((await cookieGet(on)).status, 200);
    assert.equal((await cookieGet(on, LIST)).body.snapshots.length, 1);
    for (const name of ['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync']) {
      assert.ok(spy.calls[name] > 0, name);
    }
    spy.reset();
    // Restore permissions or add files after boot cannot unseal an off instance.
    for (const headers of [{}, { Cookie: COOKIE }, { Authorization: `Bearer ${TOKEN}` }]) {
      for (const url of [BASE, LIST, `${LIST}/x`, `${BASE}/deep/nested/path`]) {
        for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']) {
          const response = await request(off)[method](url).set(headers);
          assert.equal(response.status, 404);
          assert.equal(response.headers['cache-control'], 'no-store');
          if (method !== 'head') assert.deepEqual(response.body, { error: 'observe_off', reason: 'observe_off' });
        }
      }
    }
    const malformed = await request(off).post(LIST).set('Content-Type', 'application/json').send('{');
    assertError(malformed, 404, 'observe_off');
    for (const [name, count] of Object.entries(spy.calls)) assert.equal(count, 0, name);
  } finally {
    spy.restore();
  }
});

test('endpoint: createApp sealing combinations and explicit null overriding env', async (t) => {
  const fx = fixture(t);
  assert.equal((await cookieGet(makeApp(fx))).status, 200);
  const previous = process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR;
  process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR = fx.dir;
  let fromEnv;
  let explicitOff;
  try {
    fromEnv = makeApp(fx, { observeSnapshotDir: undefined });
    explicitOff = makeApp(fx, { observeSnapshotDir: null });
  } finally {
    if (previous === undefined) delete process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR;
    else process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR = previous;
  }
  assert.equal((await cookieGet(fromEnv)).status, 200);
  assertError(await cookieGet(explicitOff), 404, 'observe_off');
  const symlink = path.join(fx.root, 'link');
  fs.symlinkSync(fx.dir, symlink);
  for (const options of [{ authToken: null }, { observeSnapshotDir: symlink },
    { observeSnapshotDir: path.join(fx.root, 'missing') }]) {
    assertError(await cookieGet(makeApp(fx, options)), 404, 'observe_off');
  }
  const originalStat = fs.statSync;
  let wrongOwner;
  try {
    fs.statSync = function differentOwner(filename, ...args) {
      const stat = originalStat.call(fs, filename, ...args);
      if (filename === fx.dir) stat.uid++;
      return stat;
    };
    wrongOwner = makeApp(fx);
  } finally {
    fs.statSync = originalStat;
  }
  assertError(await cookieGet(wrongOwner), 404, 'observe_off');
  fs.chmodSync(fx.dir, 0o770);
  const writable = makeApp(fx);
  fs.chmodSync(fx.dir, 0o700);
  assertError(await cookieGet(writable), 404, 'observe_off');
  assert.equal((await cookieGet(makeApp(fx))).status, 200);
});

test('endpoint: login cookie alone succeeds; human, PM, valid worker and no auth are refused', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  const login = await request(app).post('/api/auth/login').send({ token: TOKEN });
  assert.equal(login.status, 204);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(app).get(DETAIL).set('Cookie', cookie)).status, 200);
  const worker = app.services.workerProposalTokenService.mint('run_fixture', { projectId: 'project_fixture' });
  assert.ok(worker);
  assert.equal(app.services.workerProposalTokenService.verify(worker).runId, 'run_fixture');
  for (const url of [LIST, DETAIL, BASE, `${BASE}/deep`]) {
    for (const token of [TOKEN, PM_TOKEN, worker]) {
      const result = await request(app).get(url).set('Authorization', `Bearer ${token}`);
      assert.equal(result.status, 403);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.ok([TOKEN, PM_TOKEN].includes(token) ? result.body.error === 'cookie auth required'
        : result.body.error === 'authentication_failed');
    }
    assertError(await request(app).get(url), 401, 'authentication_required');
  }
  assertError(await request(app).get(DETAIL).set('Cookie', cookie).set('Authorization', `Bearer ${TOKEN}`),
    403, 'cookie auth required');
  for (const method of ['post', 'put', 'patch', 'delete', 'options', 'head']) {
    const result = await request(app)[method](LIST).set('Cookie', cookie);
    assert.equal(result.status, 404);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await request(app)[method](LIST).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
  }
});

test('endpoint: reader output is identical, never writes files or DB, and uses no-store', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  const disk = JSON.parse(fs.readFileSync(fx.filename, 'utf8'));
  assert.equal(validateSnapshot(disk).ok, true);
  const db = app.services._rawDb;
  const changes = db.prepare('SELECT total_changes() AS count').get().count;
  const spy = spyFs(['writeFileSync', 'renameSync', 'appendFileSync', 'unlinkSync', 'mkdirSync']);
  try {
    // Nonzero write assertion proves the instrumentation is active.
    fs.writeFileSync(path.join(fx.root, 'write-probe'), 'probe');
    assert.ok(spy.calls.writeFileSync > 0);
    spy.reset();
    const result = await cookieGet(app);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, disk);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
    for (const count of Object.values(spy.calls)) assert.equal(count, 0);
    assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
  } finally {
    spy.restore();
  }
});

test('endpoint: malformed IDs, missing files, JSON and policy violations have fixed statuses', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  const spy = spyFs(['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync',
    'statSync', 'readFileSync', 'stat', 'open', 'readdir', 'readFile']);
  try {
    assert.equal((await cookieGet(app)).status, 200);
    assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
    for (const name of ['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'fstatSync', 'readSync']) {
      assert.ok(spy.calls[name] > 0, name);
    }
    const invalidIds = ['bad.dot', 'a'.repeat(129), '%2Fetc%2Fpasswd', '%00', '%20', '%GG', SECRET];
    const cases = invalidIds.map(function invalidId(id) {
      return [`${LIST}/${id}`, 400, 'invalid_machine_id'];
    });
    // HTTP clients normalize the encoded dot segment before Express sees the URL.
    cases.push([`${LIST}/%2E%2E`, 404, 'route_not_found']);
    cases.push([`${LIST}/extra/child`, 404, 'route_not_found']);
    cases.push([`${LIST}//etc/passwd`, 404, 'route_not_found']);
    for (const [url, status, reason] of cases) {
      spy.reset();
      const response = await cookieGet(app, url);
      assertError(response, status, reason);
      for (const [name, count] of Object.entries(spy.calls)) assert.equal(count, 0, `${url}: ${name}`);
      assert.ok(!JSON.stringify(response.body).includes(url));
      assert.ok(!JSON.stringify(response.body).includes(url.slice(LIST.length + 1)));
    }
  } finally {
    spy.restore();
  }
  assertError(await cookieGet(app, `${LIST}/missing`), 404, 'not_found');
  fs.writeFileSync(fx.filename, '{');
  assertError(await cookieGet(app), 422, 'parse_error');
  const mutations = [
    function unknownKey(snapshot) { snapshot.unexpected = fx.filename; },
    function unsanitizedText(snapshot) { snapshot.instructions[0].text = SECRET; },
    function unsanitizedLabel(snapshot) { snapshot.sessions[0].repo_label = SECRET; },
    function oldPolicy(snapshot) { snapshot.policy_version = 0; },
  ];
  for (const mutate of mutations) {
    writeSnapshot(fx);
    assert.equal((await cookieGet(app)).status, 200);
    const unsafe = structuredClone(fx.snapshot);
    mutate(unsafe);
    assert.equal(validateSnapshot(unsafe).ok, false);
    writeSnapshot(fx, unsafe);
    const result = await cookieGet(app);
    assertError(result, 422, 'policy_violation');
    assert.ok(!JSON.stringify(result.body).includes(SECRET));
    assert.ok(!JSON.stringify(result.body).includes(fx.root));
  }
  writeSnapshot(fx);
  assert.equal((await cookieGet(app)).status, 200);
  const differentMachine = anotherSnapshot(fx, 'beta');
  writeSnapshot(fx, differentMachine, 'alpha');
  assertError(await cookieGet(app), 422, 'policy_violation');
  assertError(await request(app).post(LIST).set('Cookie', COOKIE)
    .set('Content-Type', 'application/json').send('{'), 400, 'request_invalid');
});

test('endpoint: existing symlinks, directories and FIFO are rejected before open', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app)).status, 200);
  const backup = path.join(fx.root, 'backup.json');
  fs.renameSync(fx.filename, backup);
  fs.symlinkSync(backup, fx.filename);
  assertError(await cookieGet(app), 422, 'symlink');
  fs.unlinkSync(fx.filename);
  writeSnapshot(fx);
  assert.equal((await cookieGet(app)).status, 200);
  fs.unlinkSync(fx.filename);
  fs.mkdirSync(fx.filename);
  assertError(await cookieGet(app), 422, 'not_regular');
  fs.rmdirSync(fx.filename);
  writeSnapshot(fx);
  assert.equal((await cookieGet(app)).status, 200);
  if (process.platform === 'win32') return;
  fs.unlinkSync(fx.filename);
  const fifo = spawnSync('mkfifo', [fx.filename], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  assert.equal(fs.lstatSync(fx.filename).isFIFO(), true);
  assertError(await cookieGet(app), 422, 'not_regular');
});

function raceAfterLstat(fx, replace, callback) {
  const original = fs.lstatSync;
  let replacements = 0;
  fs.lstatSync = function replaceAfterLstat(filename, ...args) {
    const stat = original.call(fs, filename, ...args);
    if (filename === fx.filename && replacements === 0) {
      replacements++;
      replace();
    }
    return stat;
  };
  return Promise.resolve().then(callback).then(function confirmReplacement(result) {
    assert.equal(replacements, 1);
    return result;
  }).finally(function restoreLstat() { fs.lstatSync = original; });
}

test('endpoint: lstat/open races independently enforce O_NOFOLLOW and dev/ino identity', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app)).status, 200);
  const originalOpen = fs.openSync;
  let safeOpens = 0;
  fs.openSync = function assertNoFollow(filename, flags, ...args) {
    if (filename === fx.filename && typeof flags === 'number'
      && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
      assert.ok((flags & fs.constants.O_NOFOLLOW) !== 0);
      safeOpens++;
    }
    return originalOpen.call(fs, filename, flags, ...args);
  };
  try {
    assert.equal((await cookieGet(app)).status, 200);
    assert.ok(safeOpens > 0);
    // Same-inode symlink defeats dev/ino alone: O_NOFOLLOW must refuse it.
    const symlinkResult = await raceAfterLstat(fx, function swapSymlink() {
      const backup = path.join(fx.root, 'same-inode.json');
      fs.renameSync(fx.filename, backup);
      fs.symlinkSync(backup, fx.filename);
    }, function requestSymlinkRace() { return cookieGet(app); });
    assertError(symlinkResult, 422, 'symlink');
    fs.unlinkSync(fx.filename);
    writeSnapshot(fx);
    assert.equal((await cookieGet(app)).status, 200);
    // A regular replacement passes O_NOFOLLOW; identity comparison must refuse it.
    const identityResult = await raceAfterLstat(fx, function swapInode() {
      const replacement = path.join(fx.root, 'replacement.json');
      fs.writeFileSync(replacement, JSON.stringify(fx.snapshot));
      assert.notEqual(fs.statSync(replacement).ino, fs.statSync(fx.filename).ino);
      fs.renameSync(replacement, fx.filename);
    }, function requestInodeRace() { return cookieGet(app); });
    assertError(identityResult, 422, 'identity_mismatch');
    assert.equal((await cookieGet(app)).status, 200);
    const differentSymlink = await raceAfterLstat(fx, function swapDifferentSymlink() {
      const replacement = path.join(fx.root, 'different-inode.json');
      fs.writeFileSync(replacement, JSON.stringify(fx.snapshot));
      assert.notEqual(fs.statSync(replacement).ino, fs.statSync(fx.filename).ino);
      fs.unlinkSync(fx.filename);
      fs.symlinkSync(replacement, fx.filename);
    }, function requestDifferentSymlink() { return cookieGet(app); });
    assertError(differentSymlink, 422, 'symlink');
  } finally {
    fs.openSync = originalOpen;
  }
});

test('endpoint: root realpath changes yield 503 without changing sealed state', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app)).status, 200);
  assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
  const moved = path.join(fx.root, 'moved');
  fs.renameSync(fx.dir, moved);
  fs.symlinkSync(moved, fx.dir);
  for (const url of [LIST, DETAIL]) assertError(await cookieGet(app, url), 503, 'observe_root_changed');
  fs.unlinkSync(fx.dir);
  fs.renameSync(moved, fx.dir);
  assert.deepEqual((await cookieGet(app)).body, fx.snapshot);
});

test('endpoint: file 16MB and aggregate 64MB caps are bounded and reset per request', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app)).status, 200);
  const fd = fs.openSync(fx.filename, 'r+');
  fs.ftruncateSync(fd, STORE_LIMITS.fileBytes + 1);
  fs.closeSync(fd);
  assertError(await cookieGet(app), 413, 'too_large');
  writeSnapshot(fx);
  anotherSnapshot(fx, 'beta');
  const sizes = ['alpha', 'beta'].map(function fileSize(id) {
    return fs.statSync(path.join(fx.dir, `${id}.json`)).size;
  });
  assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 2);
  const store = createObserveSnapshotStore({ totalBytes: sizes[0] + sizes[1] - 1 });
  const limitedApp = makeApp(fx, { observeSnapshotStore: store });
  const result = await cookieGet(limitedApp, LIST);
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshots[0].machine_id, 'alpha');
  assert.deepEqual(result.body.snapshots[1], { name_id: 'beta', error_code: 'total_limit' });
  assert.equal((await cookieGet(limitedApp, `${LIST}/beta`)).status, 200);
  assert.deepEqual((await cookieGet(limitedApp, LIST)).body, result.body);
  const fileLimited = makeApp(fx, {
    observeSnapshotStore: createObserveSnapshotStore({ fileBytes: sizes[0] - 1 }),
  });
  assertError(await cookieGet(fileLimited), 413, 'too_large');
  const totalLimited = makeApp(fx, { observeSnapshotStore: createObserveSnapshotStore({ totalBytes: 1 }) });
  assertError(await cookieGet(totalLimited), 413, 'total_limit');
});

test('store: failed files consume aggregate budget and file growth never exceeds read caps', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
  const size = fs.statSync(fx.filename).size;
  anotherSnapshot(fx, 'zeta');
  const store = createObserveSnapshotStore({ totalBytes: size * 2 });
  assert.equal(store.listSnapshots(state).snapshots[1].machine_id, 'zeta');
  fs.writeFileSync(path.join(fx.dir, 'invalid.json'), '!'.repeat(size));
  const result = store.listSnapshots(state).snapshots;
  assert.equal(result[0].machine_id, 'alpha');
  assert.deepEqual(result[1], { name_id: 'invalid', error_code: 'parse_error' });
  assert.deepEqual(result[2], { name_id: 'zeta', error_code: 'total_limit' });
  const originalRead = fs.readSync;
  let bytes = 0;
  let grown = false;
  fs.readSync = function growDuringRead(fd, buffer, offset, length, position) {
    if (!grown) {
      grown = true;
      fs.appendFileSync(fx.filename, ' '.repeat(size * 3));
    }
    const count = originalRead.call(fs, fd, buffer, offset, length, position);
    bytes += count;
    return count;
  };
  try {
    const limited = createObserveSnapshotStore({ fileBytes: size * 2 });
    assert.equal(limited.readSnapshot(state, 'alpha').reason, 'too_large');
    assert.equal(bytes, size * 2);
  } finally {
    fs.readSync = originalRead;
  }
});

test('store: fstat device identity and partial read failures cannot bypass aggregate limits', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
  const originalFstat = fs.fstatSync;
  try {
    fs.fstatSync = function differentDevice(fd) {
      const stat = originalFstat.call(fs, fd);
      stat.dev++;
      return stat;
    };
    assert.equal(readSnapshot(state, 'alpha').reason, 'identity_mismatch');
  } finally {
    fs.fstatSync = originalFstat;
  }
  assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
  const size = fs.statSync(fx.filename).size;
  anotherSnapshot(fx, 'omega');
  const store = createObserveSnapshotStore({ totalBytes: size });
  assert.equal(store.listSnapshots(state).snapshots[0].machine_id, 'alpha');
  const originalRead = fs.readSync;
  let reads = 0;
  try {
    fs.readSync = function failAfterPartialRead(fd, buffer, offset, length, position) {
      reads++;
      if (reads === 2) throw new Error(`private filesystem failure: ${fx.filename}`);
      return originalRead.call(fs, fd, buffer, offset, Math.min(length, 1), position);
    };
    const entries = store.listSnapshots(state).snapshots;
    assert.equal(reads, 2);
    assert.deepEqual(entries[0], { name_id: 'alpha', error_code: 'read_error' });
    assert.deepEqual(entries[1], { name_id: 'omega', error_code: 'total_limit' });
    assert.ok(!JSON.stringify(entries).includes(fx.root));
  } finally {
    fs.readSync = originalRead;
  }
});

test('endpoint: deterministic list exposes only metadata and closed failure entries', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
  anotherSnapshot(fx, 'beta');
  fs.writeFileSync(path.join(fx.dir, 'failed.json'), SECRET);
  for (const name of ['.hidden.json', 'bad.dot.json', 'a'.repeat(129) + '.json', 'other.txt']) {
    fs.writeFileSync(path.join(fx.dir, name), SECRET);
  }
  const result = await cookieGet(app, LIST);
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.snapshots.length, 3);
  assert.deepEqual(result.body.snapshots.map(function entryId(entry) {
    return entry.machine_id || entry.name_id;
  }), ['alpha', 'beta', 'failed']);
  assert.deepEqual(result.body.snapshots[2], { name_id: 'failed', error_code: 'parse_error' });
  for (const metadata of result.body.snapshots.slice(0, 2)) {
    assert.deepEqual(Object.keys(metadata).sort(),
      ['bytes', 'coverage_summary', 'generated_at', 'machine_id', 'machine_label']);
    assert.ok(metadata.bytes > 0);
    assert.deepEqual(Object.keys(metadata.coverage_summary).sort(), ['claude', 'codex']);
    for (const provider of Object.values(metadata.coverage_summary)) {
      for (const count of Object.values(provider)) assert.ok(Number.isSafeInteger(count) && count >= 0);
    }
    assert.ok(metadata.coverage_summary.claude.files_scanned > 0);
  }
  const body = JSON.stringify(result.body);
  for (const sentinel of [fx.root, SECRET, fx.snapshot.instructions[0].text, 'repo_label', 'orca_unavailable']) {
    assert.ok(!body.includes(sentinel), sentinel);
  }
  assert.deepEqual((await cookieGet(app, LIST)).body, result.body);
});

function openSse(app, headers) {
  return new Promise(function sseConnection(resolve, reject) {
    const server = app.listen(0, '127.0.0.1');
    let req;
    const timeout = setTimeout(function sseTimeout() {
      req?.destroy();
      server.close();
      reject(new Error('SSE open timed out'));
    }, 5000);
    server.on('error', function serverError(error) { clearTimeout(timeout); reject(error); });
    server.on('listening', function connectSse() {
      req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/events', headers },
        function sseHeaders(response) {
          const result = { status: response.statusCode, headers: response.headers };
          clearTimeout(timeout);
          response.destroy();
          req.destroy();
          server.close(function closedSse() { resolve(result); });
        });
      req.on('error', function requestError(error) {
        if (error.code === 'ECONNRESET') return;
        clearTimeout(timeout);
        server.close(function closedAfterError() { reject(error); });
      });
    });
  });
}

test('endpoint: existing health, global auth and SSE behavior is identical on and off', async (t) => {
  const fx = fixture(t);
  const on = makeApp(fx);
  const off = makeApp(fx, { observeSnapshotDir: null });
  assert.equal((await cookieGet(on)).status, 200);
  assertError(await cookieGet(off), 404, 'observe_off');
  const health = await request(on).get('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.deepEqual((await request(off).get('/api/health')).body, health.body);
  for (const app of [on, off]) {
    const tasks = await request(app).get('/api/tasks').set('Authorization', `Bearer ${TOKEN}`);
    assert.equal(tasks.status, 200);
    assert.equal((await request(app).get('/api/tasks')).status, 403);
    for (const headers of [{ Cookie: COOKIE }, { Authorization: `Bearer ${TOKEN}` }]) {
      const sse = await openSse(app, headers);
      assert.equal(sse.status, 200);
      assert.match(sse.headers['content-type'], /text\/event-stream/);
      assert.equal(sse.headers['cache-control'], 'no-cache');
    }
    assert.equal((await request(app).get('/api/events')).status, 403);
  }
});

test('store: fixed status table covers every public read failure', () => {
  assert.deepEqual(ERROR_STATUS, {
    observe_off: 404, invalid_machine_id: 400, not_found: 404, not_regular: 422, symlink: 422,
    identity_mismatch: 422, too_large: 413, total_limit: 413, parse_error: 422, policy_violation: 422,
    observe_root_changed: 503, read_error: 503, route_not_found: 404,
  });
});

test('store: R1 secret-shaped IDs are omitted and refused without file access', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  assert.equal(listSnapshots(state).snapshots[0].machine_id, 'alpha');
  assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
  fs.writeFileSync(path.join(fx.dir, `${SECRET}.json`), '{');
  const entries = listSnapshots(state).snapshots;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].machine_id, 'alpha');
  assert.equal(JSON.stringify(entries).includes(SECRET), false);
  const spy = spyFs(['lstatSync', 'openSync', 'readSync']);
  try {
    assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
    for (const count of Object.values(spy.calls)) assert.ok(count > 0);
    spy.reset();
    assert.equal(readSnapshot(state, SECRET).reason, 'invalid_machine_id');
    for (const count of Object.values(spy.calls)) assert.equal(count, 0);
  } finally {
    spy.restore();
  }
});

test('store: R1 writerless FIFO replacement ends within five seconds', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
  const source = `
    const fs = require('node:fs');
    const { spawnSync } = require('node:child_process');
    const store = require(process.argv[1]);
    const root = process.argv[2];
    const filename = root + '/alpha.json';
    const state = store.sealObserveState({ dir: root, authToken: 'fixture' });
    const lstat = fs.lstatSync;
    const open = fs.openSync;
    fs.lstatSync = function swapFifo(name) {
      const stat = lstat(name);
      if (name === filename) {
        fs.renameSync(filename, root + '/backup');
        const fifo = spawnSync('/usr/bin/mkfifo', [filename]);
        if (fifo.status !== 0) throw new Error('fixture mkfifo failed');
      }
      return stat;
    };
    fs.openSync = function recordOpen(name, flags, ...args) {
      if (name === filename) console.log(JSON.stringify({ flags }));
      return open(name, flags, ...args);
    };
    console.log(JSON.stringify(store.readSnapshot(state, 'alpha')));
  `;
  const child = spawnSync(process.execPath, ['-e', source,
    require.resolve('../services/observeSnapshotStore'), fx.dir], {
    encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
  });
  assert.equal(child.error?.code, undefined, 'FIFO read exceeded five seconds');
  assert.equal(child.status, 0, child.stderr);
  const [opened, result] = child.stdout.trim().split('\n').map(function parseLine(line) { return JSON.parse(line); });
  assert.equal(result.reason, 'not_regular');
  assert.ok((opened.flags & fs.constants.O_NONBLOCK) !== 0);
  assert.equal(fs.lstatSync(fx.filename).isFIFO(), true);
});

test('store: R1 file count cap rejects the whole list before opening files', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  fs.writeFileSync(path.join(fx.dir, 'empty.json'), '');
  const store = createObserveSnapshotStore({ fileCount: 2 });
  assert.equal(store.listSnapshots(state).snapshots.length, 2);
  fs.writeFileSync(path.join(fx.dir, 'extra.json'), '');
  const spy = spyFs(['lstatSync', 'openSync', 'readSync']);
  try {
    assert.equal(listSnapshots(state).snapshots[0].machine_id, 'alpha');
    for (const count of Object.values(spy.calls)) assert.ok(count > 0);
    spy.reset();
    assert.equal(store.listSnapshots(state).reason, 'total_limit');
    for (const count of Object.values(spy.calls)) assert.equal(count, 0);
  } finally {
    spy.restore();
  }
  assert.equal(STORE_LIMITS.fileCount, 256);
  assert.throws(function increasedCount() { createObserveSnapshotStore({ fileCount: 257 }); }, /invalid observe limit/);
});

test('store: R1 exact names are required even when file operations ignore case', (t) => {
  const fx = fixture(t);
  const state = sealObserveState({ dir: fx.dir, authToken: TOKEN });
  let physicalName = fx.filename;
  const lstat = fs.lstatSync;
  const open = fs.openSync;
  let fileCalls = 0;
  function caseInsensitiveName(name) {
    if (typeof name === 'string' && name.toLowerCase() === fx.filename.toLowerCase()) {
      fileCalls++;
      return physicalName;
    }
    return name;
  }
  try {
    fs.lstatSync = function insensitiveLstat(name, ...args) { return lstat(caseInsensitiveName(name), ...args); };
    fs.openSync = function insensitiveOpen(name, ...args) { return open(caseInsensitiveName(name), ...args); };
    assert.deepEqual(readSnapshot(state, 'alpha').snapshot, fx.snapshot);
    assert.ok(fileCalls > 0);
    fileCalls = 0;
    assert.equal(readSnapshot(state, 'ALPHA').reason, 'not_found');
    assert.equal(fileCalls, 0);
    physicalName = path.join(fx.dir, 'alpha.JSON');
    fs.renameSync(fx.filename, physicalName);
    assert.equal(readSnapshot(state, 'alpha').reason, 'not_found');
    assert.equal(fileCalls, 0);
    assert.deepEqual(listSnapshots(state).snapshots, []);
  } finally {
    fs.lstatSync = lstat;
    fs.openSync = open;
  }
});

test('store: R1 only unchanged canonical absolute root settings can be sealed on', (t) => {
  const fx = fixture(t);
  assert.equal(sealObserveState({ dir: fx.dir, authToken: TOKEN }).on, true);
  const relative = path.relative(process.cwd(), fx.dir);
  assert.equal(path.isAbsolute(relative), false);
  for (const dir of [relative, `${fx.dir}/`, `${fx.dir}/.`, `${fx.dir}/../snapshots`]) {
    assert.deepEqual(sealObserveState({ dir, authToken: TOKEN }),
      { on: false, code: 'observe_root_invalid', root: null });
  }
});

test('boot: R1 unset observe is silent and configured failures warn once with only a code', (t) => {
  const fx = fixture(t);
  const warn = console.warn;
  const warnings = [];
  try {
    console.warn = function captureWarning(...args) { warnings.push(args); };
    console.warn('probe');
    assert.equal(warnings.length, 1);
    warnings.length = 0;
    makeApp(fx, { observeSnapshotDir: null });
    assert.deepEqual(warnings, []);
    makeApp(fx, { observeSnapshotDir: `${fx.dir}/missing` });
    assert.deepEqual(warnings, [['observe_root_invalid']]);
    assert.equal(JSON.stringify(warnings).includes(fx.root), false);
  } finally {
    console.warn = warn;
  }
});

test('endpoint: R1 safe IDs, file count boundary and exact filename status are enforced', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx, { observeSnapshotStore: createObserveSnapshotStore({ fileCount: 2 }) });
  assert.equal((await cookieGet(app)).status, 200);
  assert.equal((await cookieGet(app, LIST)).body.snapshots[0].machine_id, 'alpha');
  fs.writeFileSync(path.join(fx.dir, `${SECRET}.json`), '{');
  const listed = await cookieGet(app, LIST);
  assert.equal(listed.body.snapshots.length, 1);
  assert.equal(JSON.stringify(listed.body).includes(SECRET), false);
  assertError(await cookieGet(app, `${LIST}/${SECRET}`), 400, 'invalid_machine_id');
  assertError(await cookieGet(app, `${LIST}/ALPHA`), 404, 'not_found');
  fs.renameSync(fx.filename, path.join(fx.dir, 'alpha.JSON'));
  assertError(await cookieGet(app), 404, 'not_found');
  fs.unlinkSync(path.join(fx.dir, 'alpha.JSON'));
  writeSnapshot(fx);
  fs.writeFileSync(path.join(fx.dir, 'empty.json'), '');
  const boundary = await cookieGet(app, LIST);
  assert.equal(boundary.status, 200);
  assert.equal(boundary.body.snapshots.length, 2);
  fs.writeFileSync(path.join(fx.dir, 'extra.json'), '');
  assertError(await cookieGet(app, LIST), 413, 'total_limit');
  assert.equal((await cookieGet(app)).status, 200);
  const originalOpen = fs.openSync;
  try {
    fs.openSync = function boundedFifoOpen(filename, flags, ...args) {
      if (filename === fx.filename) assert.ok((flags & fs.constants.O_NONBLOCK) !== 0);
      return originalOpen(filename, flags, ...args);
    };
    const result = await raceAfterLstat(fx, function replaceWithFifo() {
      fs.renameSync(fx.filename, path.join(fx.root, 'fifo-backup'));
      const fifo = spawnSync('/usr/bin/mkfifo', [fx.filename], { encoding: 'utf8' });
      assert.equal(fifo.status, 0, fifo.stderr);
    }, function requestFifo() { return cookieGet(app); });
    assertError(result, 422, 'not_regular');
  } finally {
    fs.openSync = originalOpen;
  }
});

test('store: R2 public root and descendants cannot be sealed on', (t) => {
  const fx = fixture(t);
  const publicDir = path.join(fx.root, 'public');
  const nested = path.join(publicDir, 'api', 'observe', 'snapshots');
  fs.mkdirSync(nested, { recursive: true, mode: 0o700 });
  fs.chmodSync(publicDir, 0o700);
  const options = { authToken: TOKEN, publicDir };
  assert.equal(sealObserveState({ ...options, dir: fx.dir }).on, true);
  for (const dir of [publicDir, nested]) {
    assert.deepEqual(sealObserveState({ ...options, dir }),
      { on: false, code: 'observe_root_invalid', root: null });
  }
  const sibling = `${publicDir}-private`;
  fs.mkdirSync(sibling, { mode: 0o700 });
  assert.equal(sealObserveState({ ...options, dir: sibling }).on, true);
  const alias = path.join(fx.root, 'public-link');
  fs.symlinkSync(publicDir, alias);
  assert.equal(sealObserveState({ ...options, publicDir: alias, dir: nested }).code, 'observe_root_invalid');
});

test('boot: R2 createApp supplies the static public root to sealing', (t) => {
  const fx = fixture(t);
  const publicDir = path.join(__dirname, '..', 'public');
  const realpath = fs.realpathSync;
  let publicChecks = 0;
  const warn = console.warn;
  const warnings = [];
  try {
    fs.realpathSync = function mapPublicRoot(filename, ...args) {
      if (filename === publicDir) {
        publicChecks++;
        return fx.root;
      }
      return realpath(filename, ...args);
    };
    console.warn = function captureWarning(code) { warnings.push(code); };
    makeApp(fx);
    assert.ok(publicChecks > 0);
    assert.deepEqual(warnings, ['observe_root_invalid']);
  } finally {
    fs.realpathSync = realpath;
    console.warn = warn;
  }
});

test('endpoint: R2 encoded API paths never probe static files on or off', async (t) => {
  const fx = fixture(t);
  const apps = [makeApp(fx), makeApp(fx, { observeSnapshotDir: null })];
  const spy = spyFs(['stat', 'open', 'createReadStream', 'statSync', 'openSync', 'lstatSync',
    'realpathSync', 'readdirSync', 'readSync', 'readFile', 'readFileSync']);
  try {
    for (const app of apps) {
      const script = await request(app).get('/app.js');
      assert.equal(script.status, 200);
      assert.ok(script.text.length > 0);
      assert.ok(spy.calls.stat > 0);
      assert.ok(spy.calls.open > 0);
      assert.ok(spy.calls.createReadStream > 0);
      for (const url of ['/api/%6fbserve/snapshots/x.json', '/API/observe/snapshots/x.json',
        '/api/obs%65rve/snapshots/x.json', '/%61pi/observe/snapshots/x.json',
        '/%2fapi%2fobserve/snapshots/x.json', '/prefix%2f..%2fapi/observe/snapshots/x.json',
        '/api/observe/snapshots/%GG']) {
        spy.reset();
        const response = await request(app).get(url);
        assert.notEqual(response.status, 200);
        for (const [name, count] of Object.entries(spy.calls)) assert.equal(count, 0, `${url}: ${name}`);
      }
    }
  } finally {
    spy.restore();
  }
});

test('route: R2 ID decoding errors require cookie auth before returning 400', () => {
  for (const error of [new URIError('fixture'), new AppError('invalid_machine_id', 400)]) {
    const response = {
      headersSent: false,
      set: function setHeader() { return this; },
      status: function setStatus(status) { this.statusCode = status; return this; },
      json: function setBody(body) { this.body = body; return this; },
    };
    observeErrorHandler(error, { auth: { method: 'cookie' } }, response);
    assert.equal(response.statusCode, 400);
    for (const method of ['bearer', 'worker', 'none']) {
      observeErrorHandler(error, { auth: { method } }, response);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { error: 'cookie auth required', reason: 'cookie auth required' });
    }
  }
});

test('endpoint: R2 malformed ID is 400 for cookies and 403 for human and PM bearer', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  const url = `${LIST}/%GG`;
  assertError(await cookieGet(app, url), 400, 'invalid_machine_id');
  for (const token of [TOKEN, PM_TOKEN]) {
    assertError(await request(app).get(url).set('Authorization', `Bearer ${token}`), 403, 'cookie auth required');
  }
});

test('route: R3 every non-auth error requires cookie auth', () => {
  const parseError = Object.assign(new SyntaxError('fixture'), { type: 'entity.parse.failed' });
  const charsetError = Object.assign(new Error('fixture'), { type: 'charset.unsupported' });
  for (const [error, status] of [[parseError, 400], [charsetError, 500], [new Error('fixture'), 500],
    [new AppError('observe_root_changed', 503), 503]]) {
    const response = {
      headersSent: false,
      set: function setHeader() { return this; },
      status: function setStatus(value) { this.statusCode = value; return this; },
      json: function setBody(body) { this.body = body; return this; },
    };
    observeErrorHandler(error, { auth: { method: 'cookie' } }, response);
    assert.equal(response.statusCode, status);
    for (const auth of [{ method: 'bearer' }, { method: 'worker' }, { method: 'none' }, undefined]) {
      observeErrorHandler(error, { auth }, response);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { error: 'cookie auth required', reason: 'cookie auth required' });
    }
  }
});

test('endpoint: R3 body errors preserve cookie 400 and reject other credentials before data access', async (t) => {
  const fx = fixture(t);
  const app = makeApp(fx);
  assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
  assertError(await cookieGet(app, LIST).set('Content-Type', 'application/json').send('{'), 400, 'request_invalid');
  const worker = app.services.workerProposalTokenService.mint('run_fixture', { projectId: 'project_fixture' });
  assert.ok(worker.length > 0);
  assert.equal(app.services.workerProposalTokenService.verify(worker).runId, 'run_fixture');
  const spy = spyFs(['realpathSync', 'readdirSync', 'lstatSync', 'openSync', 'readSync']);
  try {
    assert.equal((await cookieGet(app, LIST)).body.snapshots.length, 1);
    for (const count of Object.values(spy.calls)) assert.ok(count > 0);
    spy.reset();
    for (const token of [TOKEN, PM_TOKEN, worker]) {
      for (const type of ['application/json', 'application/json; charset=x-unknown']) {
        const response = await request(app).get(LIST).set('Authorization', `Bearer ${token}`)
          .set('Content-Type', type).send('{');
        const reason = token === worker ? 'authentication_failed' : 'cookie auth required';
        assertError(response, 403, reason);
      }
    }
    assertError(await request(app).get(LIST).set('Content-Type', 'application/json').send('{'),
      401, 'authentication_required');
    for (const count of Object.values(spy.calls)) assert.equal(count, 0);
  } finally {
    spy.restore();
  }
});
