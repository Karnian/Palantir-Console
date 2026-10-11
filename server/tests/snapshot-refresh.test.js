'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSnapshotRefreshService } = require('../services/snapshotRefreshService');
const { fixture, request, COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');
const { spawn } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, 'fixtures/bin/fake-snapshot-refresh.cjs');
const BASE = '/api/session-hub/snapshots';

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function setup(t, mode = 'ok', extra = {}) {
  const fx = fixture(t);
  const input = path.join(fx.root, 'input.json');
  fs.writeFileSync(input, JSON.stringify(fx.alpha));
  const log = path.join(fx.root, 'calls.log');
  const pid = path.join(fx.root, 'grandchild.pid');
  const env = { ...process.env, PALANTIR_BLOCK_REAL_SPAWN: '1', PALANTIR_ALLOW_REAL_SPAWN: '0',
    PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([{ name: 'mac', kind: 'local', machineId: 'alpha', label: 'mac' }]),
    PALANTIR_SNAPSHOT_REFRESH_MS: '0', FAKE_REFRESH_INPUT: input,
    FAKE_REFRESH_LOG: log, FAKE_REFRESH_PID: pid, FAKE_REFRESH_MODE: mode };
  const options = { observeState: fx.state, env, scriptPath: SCRIPT, execPath: process.execPath, ...extra };
  const service = createSnapshotRefreshService(options);
  t.after(() => service.shutdown().catch(() => {}));
  const result = () => service.state().targets[0].last_result;
  const original = fs.readFileSync(path.join(fx.dir, 'alpha.json'));
  const unchanged = () => assert.deepEqual(fs.readFileSync(path.join(fx.dir, 'alpha.json')), original);
  return { ...fx, service, options, env, result, original, unchanged, log, pid };
}

test('single-flight, success rename, private clean staging, bounded output and fixture-only spawn', async t => {
  const fx = setup(t, 'flood');
  const dir = path.join(fx.dir, '.staging', 'alpha');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'stale'), 'stale');
  fx.service.refresh(); fx.service.refresh(['mac']);
  assert.equal(fx.service.state().targets[0].running, true);
  await fx.service.settled();
  assert.deepEqual(fx.result(), { code: 'ok' });
  const calls = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1); assert.equal(calls[0].blocked, '1'); assert.ok(calls[0].context);
  const runDir = calls[0].args[calls[0].args.indexOf('--out-dir') + 1];
  assert.equal(path.dirname(runDir), dir);
  assert.match(path.basename(runDir), /^run-/);
  assert.equal(fs.existsSync(runDir), false);
  assert.equal(fs.existsSync(path.join(dir, 'stale')), true);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(dir), ['stale']);
  assert.equal(fs.readFileSync(path.join(fx.dir, 'alpha.json'), 'utf8'), fx.original.toString() + '\n');
  assert.equal(fs.statSync(path.join(fx.dir, 'alpha.json')).mode & 0o777, 0o600);
  assert.ok(fx.service.state().targets[0].last_success_at);
  assert.equal(JSON.stringify(fx.service.state()).includes('sensitive'), false);
});

for (const [mode, code] of [['mismatch', 'machine_mismatch'], ['invalid', 'invalid_output'], ['failed', 'failed']]) {
  test(`${code} leaves canonical bytes unchanged`, async t => {
    const fx = setup(t, mode);
    fx.service.refresh(); await fx.service.settled();
    assert.equal(fx.result().code, code); fx.unchanged();
    if (mode === 'failed') assert.equal(fx.result().status_code, 7);
    assert.equal(fx.service.state().targets[0].last_success_at, null);
  });
}

test('timeout reaps the CLI group including a SIGTERM-resistant grandchild', async t => {
  const fx = setup(t, 'descendant', { reapOptions: { termMs: 200, reapMs: 3000, pollMs: 10 } });
  // Use a timeout long enough to let the fixture publish its descendant PID.
  await fx.service.shutdown();
  const service = createSnapshotRefreshService({ ...fx.options,
    env: { ...fx.env, PALANTIR_SNAPSHOT_TIMEOUT_MS: '500' } });
  t.after(() => service.shutdown());
  service.refresh(); await until(() => fs.existsSync(fx.pid));
  const pid = Number(fs.readFileSync(fx.pid, 'utf8'));
  await service.settled();
  assert.deepEqual(service.state().targets[0].last_result, { code: 'timeout' });
  assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH'); fx.unchanged();
});

test('shutdown is idempotent, awaits active group ESRCH and cancels publication', async t => {
  const fx = setup(t, 'descendant', { reapOptions: { termMs: 200, reapMs: 3000, pollMs: 10 } });
  fx.service.refresh(); await until(() => fs.existsSync(fx.pid));
  const pid = Number(fs.readFileSync(fx.pid, 'utf8'));
  const closing = fx.service.shutdown();
  assert.equal(fx.service.shutdown(), closing);
  assert.throws(() => fx.service.refresh(), err => err.code === 'snapshot_refresh_closed');
  await closing;
  assert.deepEqual(fx.result(), { code: 'cancelled' }); fx.unchanged();
  assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH');
});

test('SIGKILL escalation survives parent exit; EPERM never means reaped and locks subsequent attempts', async t => {
  const signals = []; let calls = 0;
  const fx = setup(t, 'ok', { spawn(...args) { calls++; return spawn(...args); },
    reapOptions: { termMs: 5, reapMs: 30, pollMs: 1, kill(pid, signal) {
      signals.push(signal); throw Object.assign(new Error('denied'), { code: 'EPERM' });
    } } });
  fx.service.refresh(); await fx.service.settled();
  assert.deepEqual(fx.result(), { code: 'reap_failed' });
  assert.equal(fx.service.state().targets[0].locked, true);
  assert.ok(signals.includes('SIGTERM')); assert.ok(signals.includes('SIGKILL'));
  assert.throws(() => fx.service.refresh(), err => err.code === 'reap_failed'); assert.equal(calls, 1);
  fx.unchanged(); await assert.rejects(fx.service.shutdown(), err => err.code === 'reap_failed');
});

test('duplicate machine ids and malformed settings disable service with a fixed warning', async t => {
  const fx = setup(t);
  const target = { name: 'mac', kind: 'local', machineId: 'alpha' };
  for (const raw of [JSON.stringify([target, { ...target, name: 'codev2' }]), '{', '{}',
    JSON.stringify([{ ...target, host: 'forbidden' }]), JSON.stringify([{ ...target, extra: 'secret' }])]) {
    const warnings = [];
    const service = createSnapshotRefreshService({ ...fx.options,
      env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: raw }, warn: code => warnings.push(code) });
    assert.equal(service.state().enabled, false); assert.deepEqual(warnings, ['snapshot_targets_invalid']);
    assert.throws(() => service.refresh()); await service.shutdown();
  }
  const off = createSnapshotRefreshService({ ...fx.options, observeState: { on: false } });
  assert.equal(off.state().enabled, false); assert.equal(off.state().code, 'observe_off'); await off.shutdown();
});

test('test guard requires a fixture script before any real CLI or ssh can spawn', async t => {
  const fx = setup(t); let calls = 0;
  const service = createSnapshotRefreshService({ ...fx.options, scriptPath: undefined,
    spawn() { calls++; throw new Error('must not spawn'); } });
  service.refresh(); await service.settled();
  assert.equal(calls, 0); assert.equal(service.state().targets[0].last_result.code, 'failed');
  fx.unchanged(); await service.shutdown();
});

test('fake automatic timer is unrefed, skips running targets, and is stopped at shutdown', async t => {
  let tick; let unref = false; let cleared = false; let calls = 0;
  const fx = setup(t, 'hang', { spawn(...args) { calls++; return spawn(...args); }, setInterval(fn, ms) {
    tick = fn; assert.equal(ms, 300000); return { unref() { unref = true; } };
  }, clearInterval() { cleared = true; }, reapOptions: { termMs: 10, reapMs: 1000, pollMs: 1 },
  env: { ...process.env, PALANTIR_BLOCK_REAL_SPAWN: '1', PALANTIR_SNAPSHOT_TARGETS:
    JSON.stringify([{ name: 'mac', kind: 'local', machineId: 'alpha' }]),
  FAKE_REFRESH_MODE: 'hang', FAKE_REFRESH_LOG: '/dev/null' } });
  assert.equal(unref, true);
  tick(); tick(); assert.equal(fx.service.state().targets[0].running, true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls, 1);
  await fx.service.shutdown(); assert.equal(cleared, true);
  tick(); assert.equal(fx.service.state().targets[0].running, false);
});

test('routes require exact Origin and cookie, forbid bearer/hub tokens, validate body, and return status', async t => {
  const fx = setup(t);
  const app = fx.app({ sessionHubActive: false, sessionHubTokenProvider: { current: () => 'live-hub' },
    snapshotRefreshServiceOptions: fx.options });
  for (const origin of [undefined, 'null', 'https://localhost', 'http://other', 'http://localhost:80']) {
    let call = request(app).post(`${BASE}/refresh`).set('Cookie', COOKIE);
    if (origin) call = call.set('Origin', origin);
    assert.equal((await call).status, 403);
  }
  for (const token of [TOKEN, 'live-hub', 'bad']) {
    for (const [method, url] of [['post', '/refresh'], ['get', '/status']]) {
      const response = await request(app)[method](BASE + url).set('Cookie', COOKIE)
        .set('Authorization', `Bearer ${token}`).set('Origin', 'http://localhost');
      assert.equal(response.status, 403);
    }
  }
  assert.equal((await request(app).get(`${BASE}/status`).set('Cookie', COOKIE)
    .set('Sec-Fetch-Site', 'cross-site')).status, 403);
  for (const body of [{ targets: ['missing'] }, { targets: 'mac' }, { command: 'ssh' }, []]) {
    assert.equal((await request(app).post(`${BASE}/refresh`).set('Cookie', COOKIE)
      .set('Origin', 'http://localhost').send(body)).status, 400);
  }
  const response = await request(app).post(`${BASE}/refresh`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost').send({ targets: ['mac'] });
  assert.equal(response.status, 202); assert.equal(response.body.targets[0].running, true);
  await app.snapshotRefreshService.settled();
  const status = await request(app).get(`${BASE}/status`).set('Cookie', COOKIE);
  assert.equal(status.status, 200); assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.body.auto_interval_ms, 0);
  assert.deepEqual(Object.keys(status.body.targets[0]).sort(), ['name', 'machine_id', 'running',
    'last_success_at', 'last_attempt_at', 'last_result', 'locked'].sort());
  assert.deepEqual(status.body.targets[0].last_result, { code: 'ok' });
  const empty = await request(app).post(`${BASE}/refresh`).set('Cookie', COOKIE)
    .set('Origin', 'http://localhost');
  assert.equal(empty.status, 202);
});

test('app shutdown cancels refresh synchronously and waits for the fixture descendant', async t => {
  const fx = setup(t, 'descendant', { reapOptions: { termMs: 200, reapMs: 3000, pollMs: 10 } });
  const app = fx.app({ snapshotRefreshServiceOptions: fx.options });
  app.snapshotRefreshService.refresh(); await until(() => fs.existsSync(fx.pid));
  const pid = Number(fs.readFileSync(fx.pid, 'utf8'));
  const closing = app.shutdown(); assert.equal(app.shutdown(), closing);
  assert.equal(app.snapshotRefreshService.state().closed, true);
  await closing;
  assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH'); fx.unchanged();
});

test('timeout escalates even after CLI exits first and kills the orphaned grandchild', async t => {
  const fx = setup(t, 'early_exit', { reapOptions: { termMs: 200, reapMs: 3000, pollMs: 10 } });
  await fx.service.shutdown();
  const service = createSnapshotRefreshService({ ...fx.options,
    env: { ...fx.env, PALANTIR_SNAPSHOT_TIMEOUT_MS: '500' } });
  t.after(() => service.shutdown());
  service.refresh(); await until(() => fs.existsSync(fx.pid));
  const pid = Number(fs.readFileSync(fx.pid, 'utf8'));
  await service.settled();
  assert.deepEqual(service.state().targets[0].last_result, { code: 'timeout' });
  assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH'); fx.unchanged();
});

test('SSH argv and target configuration are sealed at boot without executing ssh', async t => {
  const fx = setup(t);
  const env = { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([{ name: 'codev2', kind: 'ssh',
    machineId: 'alpha', host: 'codev@codev2', label: 'codev2', remoteNode: '/synthetic/node',
    orcaBin: '/synthetic/orca' }]) };
  const service = createSnapshotRefreshService({ ...fx.options, env });
  env.PALANTIR_SNAPSHOT_TARGETS = '[]';
  service.refresh(); await service.settled();
  const call = JSON.parse(fs.readFileSync(fx.log, 'utf8').trim());
  assert.deepEqual(call.args, ['remote', '--host', 'codev@codev2', '--remote-node', '/synthetic/node',
    'snapshot', '--out-dir', call.args[7], '--label', 'codev2',
    '--orca-bin', '/synthetic/orca']);
  assert.equal(path.dirname(call.args[7]), path.join(fx.dir, '.staging', 'alpha'));
  assert.equal(service.state().targets[0].name, 'codev2'); await service.shutdown();
});

test('every execution owns a unique directory and removes only that directory', async t => {
  const fx = setup(t);
  const parent = path.join(fx.dir, '.staging', 'alpha');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const sibling = fs.mkdtempSync(path.join(parent, 'run-sibling-'));
  fs.writeFileSync(path.join(sibling, 'alpha.json'), 'old bytes');
  for (let index = 0; index < 2; index++) { fx.service.refresh(); await fx.service.settled(); }
  const calls = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map(JSON.parse);
  const dirs = calls.map(call => call.args[call.args.indexOf('--out-dir') + 1]);
  assert.notEqual(dirs[0], dirs[1]);
  for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'alpha.json'), 'utf8'), 'old bytes');
});

test('boot removes crash remnants, including targets removed from configuration', async t => {
  const fx = setup(t);
  await fx.service.shutdown();
  const old = path.join(fx.dir, '.staging', 'removed', 'run-old');
  fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'executor.pgid'), '12345');
  const service = createSnapshotRefreshService(fx.options);
  assert.equal(service.state().enabled, true); assert.equal(fs.existsSync(old), false);
  await service.shutdown();
});

test('timeout reaps a detached executor and grandchild while the fixture CLI is SIGSTOPed', async t => {
  const fx = setup(t, 'stopped_cli');
  await fx.service.shutdown();
  let executor;
  const service = createSnapshotRefreshService({ ...fx.options,
    env: { ...fx.env, PALANTIR_SNAPSHOT_TIMEOUT_MS: '1000' },
    reapOptions: { termMs: 100, reapMs: 3000, pollMs: 10 },
    psBin: path.resolve(__dirname, 'fixtures/bin/fake-snapshot-ps.cjs'),
    execFile(command, args, options, callback) {
      assert.deepEqual(args, ['-axo', 'pid=,pgid=,uid=']);
      callback(null, `${process.pid} ${process.pid} ${process.getuid()}\n`
        + `${executor} ${executor} ${process.getuid()}\n`);
    } });
  t.after(async () => {
    if (executor) { try { process.kill(-executor, 'SIGKILL'); } catch {} }
    await service.shutdown().catch(() => {});
  });
  service.refresh(); await until(() => fs.existsSync(fx.pid));
  const grandchild = Number(fs.readFileSync(fx.pid, 'utf8'));
  const call = JSON.parse(fs.readFileSync(fx.log, 'utf8').trim().split('\n')[0]);
  const dir = call.args[call.args.indexOf('--out-dir') + 1];
  executor = Number(fs.readFileSync(path.join(dir, 'executor.pgid'), 'utf8'));
  process.kill(call.pid, 'SIGSTOP');
  await service.settled();
  assert.deepEqual(service.state().targets[0].last_result, { code: 'timeout' });
  for (const pid of [call.pid, executor, grandchild]) {
    assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH');
  }
  assert.equal(fs.existsSync(dir), false); fx.unchanged();
});

test('executor PGID rejects invalid, own-group, symlink and foreign-uid markers before signalling', async t => {
  const { reapExecutorGroup } = require('../utils/snapshotExecutorGroup');
  const fx = setup(t);
  const marker = path.join(fx.root, 'executor.pgid');
  let signals = 0; let rows = `${process.pid} 5000 ${process.getuid()}\n`;
  const options = { psBin: path.resolve(__dirname, 'fixtures/bin/fake-snapshot-ps.cjs'),
    execFile(command, argv, settings, callback) { callback(null, rows); },
    reapOptions: { kill() { signals++; } } };
  for (const value of ['0', '1', '-2', '2\n', '2147483648', 'not-a-pid', '5000']) {
    fs.writeFileSync(marker, value, { mode: 0o600 });
    await assert.rejects(reapExecutorGroup(fx.root, options), err => err.code === 'reap_failed');
  }
  rows += `6000 6000 ${process.getuid() + 1}\n`;
  fs.writeFileSync(marker, '6000');
  await assert.rejects(reapExecutorGroup(fx.root, options), err => err.code === 'reap_failed');
  fs.unlinkSync(marker); fs.symlinkSync(path.join(fx.root, 'input.json'), marker);
  await assert.rejects(reapExecutorGroup(fx.root, options), err => err.code === 'reap_failed');
  assert.equal(signals, 0);
});
