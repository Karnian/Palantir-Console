'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup, until, BODY } = require('./helpers/answer-query-fixture.cjs');
const fields = ['status', 'reason', 'text', 'truncated', 'redacted', 'shared_turn', 'answer_at', 'observed_at'].sort();
const failed = value => { assert.equal(value.status, 'unavailable'); assert.equal(value.reason, 'exec_failed'); };

test('final is projected to exactly eight fields; local argv uses snapshot ref/fp, no disk/DB writes', async t => {
  const fx = setup(t, 'stderr'); const input = fx.query();
  const before = fs.readFileSync(path.join(fx.dir, 'alpha.json'));
  const result = await fx.service.query(input);
  assert.deepEqual(Object.keys(result).sort(), fields); assert.equal(result.text, BODY);
  const instruction = fx.alpha.instructions.find(row => row.id === input.instructionId);
  const session = fx.alpha.sessions.find(row => row.key === input.sessionKey);
  assert.deepEqual(fx.calls()[0].args, ['answer', '--instruction', `${instruction.id}#${instruction.ref}`,
    '--file-fp', session.file_fp, '--emit-envelope']);
  assert.equal(fx.calls()[0].executorGroup, 'inherit'); assert.equal(fx.calls()[0].blocked, '1');
  assert.deepEqual(fs.readFileSync(path.join(fx.dir, 'alpha.json')), before);
  for (const name of fs.readdirSync(fx.root, { recursive: true })) {
    const filename = path.join(fx.root, name);
    if (fs.statSync(filename).isFile()) assert.equal(fs.readFileSync(filename).includes(BODY), false, filename);
  }
});

test('ssh argv includes remoteNode and snapshot values, omits diag/label/orcaBin', async t => {
  const fx = setup(t);
  const service = fx.newService({ env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([
    { name: 'remote', machineId: 'beta', kind: 'ssh', host: 'user@host', remoteNode: '/opt/node', label: 'remote', orcaBin: '/opt/orca' }]) } });
  const input = fx.query('beta'); const result = await service.query(input); assert.equal(result.status, 'final');
  const row = fx.beta.instructions[0];
  assert.deepEqual(fx.calls()[0].args, ['remote', '--host', 'user@host', '--remote-node', '/opt/node',
    'answer', '--instruction', `${row.id}#${row.ref}`, '--file-fp', fx.beta.sessions[0].file_fp, '--emit-envelope']);
});

for (const mode of ['target', 'fp', 'instruction', 'machine', 'diag', 'invariant', 'large', 'padded', 'flood', 'two_lines', 'status', 'invalid_json', 'failed']) {
  test(`receiver fails closed for ${mode}, and retains no result`, async t => {
    const fx = setup(t, mode); failed(await fx.service.query(fx.query())); failed(await fx.service.query(fx.query()));
    assert.equal(fx.spawns(), 2);
  });
}

test('read failures and invalid/missing targets map to closed errors without spawning', async t => {
  const fx = setup(t);
  for (const reason of ['not_found', 'policy_violation', 'read_error']) {
    const service = fx.newService({ store: { readSnapshotHashed: () => ({ ok: false, reason }) } });
    assert.throws(() => service.query(fx.query()), error => error.code === (reason === 'not_found' ? 'not_found' : 'snapshot_unavailable'));
  }
  const throwing = fx.newService({ store: { readSnapshotHashed() { throw new Error('PRIVATE'); } } });
  assert.throws(() => throwing.query(fx.query()), { code: 'snapshot_unavailable' });
  for (const raw of ['{', '[]', '{}', JSON.stringify([{ name: 'a', kind: 'local', machineId: 'alpha', host: 'bad' }])]) {
    const service = fx.newService({ env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: raw } });
    assert.throws(() => service.query(fx.query()), { code: 'snapshot_unavailable' });
  }
  assert.equal(fx.spawns(), 0);
});

test('file_fp absent skips target resolution and spawn, using injected clock', async t => {
  const fx = setup(t);
  delete fx.alpha.sessions[0].file_fp; fx.write(fx.alpha);
  const service = fx.newService({ env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: '[]' }, clock: () => '2026-10-14T02:00:00.000Z' });
  const result = await service.query(fx.query());
  assert.deepEqual(result, { status: 'target_changed', reason: 'file_missing', text: null,
    truncated: false, redacted: false, shared_turn: false, answer_at: null, observed_at: '2026-10-14T02:00:00.000Z' });
  assert.equal(fx.spawns(), 0);
});

test('same tuple shares one promise; fp change does not merge, capacity rejects immediately then releases', async t => {
  const fx = setup(t, 'ok', { env: { ...process.env, PALANTIR_BLOCK_REAL_SPAWN: '1',
    PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([{ name: 'a', machineId: 'alpha', kind: 'local' }]), FAKE_ANSWER_DELAY: '200' } });
  const input = fx.query(); const first = fx.service.query(input); const second = fx.service.query(input);
  assert.equal(first, second);
  const sameMachine = fx.query('alpha', 1);
  assert.throws(() => fx.service.query(sameMachine), { code: 'answer_busy', status: 429 });
  fx.alpha.sessions.find(row => row.key === input.sessionKey).file_fp = 'f'.repeat(16); fx.write(fx.alpha);
  assert.throws(() => fx.service.query(fx.query()), { code: 'answer_busy' });
  const results = await Promise.all([first, second]); assert.equal(results[0], results[1]); assert.equal(fx.spawns(), 1);
  assert.equal((await fx.service.query(fx.query())).status, 'final'); assert.equal(fx.spawns(), 2);
});

test('two machines run concurrently; third is busy; other machine refresh does not invalidate rev', async t => {
  const fx = setup(t);
  const gamma = structuredClone(fx.alpha); gamma.machine.id = 'gamma';
  gamma.sessions.forEach(row => { row.key = row.key.replace('alpha', 'gamma'); row.session_id = 'gamma-' + row.session_id; });
  gamma.instructions.forEach(row => { row.session_key = row.session_key.replace('alpha', 'gamma'); row.id = row.id.replace('claude:', 'claude:gamma-'); });
  fx.write(gamma);
  const service = fx.newService({ env: { ...fx.env, FAKE_ANSWER_DELAY: '200' } });
  const input = fx.query(); fx.beta.generated_at = '2026-10-14T00:00:00.000Z'; fx.write(fx.beta);
  const a = service.query(input); const b = service.query(fx.query('beta'));
  assert.throws(() => service.query(fx.query('gamma')), { code: 'answer_busy' });
  assert.equal((await a).status, 'final'); assert.equal((await b).status, 'final');
  assert.equal((await service.query(fx.query('gamma'))).status, 'final'); assert.equal(fx.spawns(), 3);
});

test('requester can discard its promise; execution continues, releases capacity, next query spawns anew', async t => {
  const fx = setup(t); const service = fx.newService({ env: { ...fx.env, FAKE_ANSWER_DELAY: '200' } });
  let done = false;
  service.query(fx.query()).then(() => { done = true; });
  await until(() => fx.calls().length === 1);
  assert.equal(done, false); assert.throws(() => service.query(fx.query('alpha', 1)), { code: 'answer_busy' });
  await until(() => done); assert.equal((await service.query(fx.query())).text, BODY); assert.equal(fx.spawns(), 2);
});

test('timeout releases slot only after process group ESRCH; subsequent query runs', async t => {
  const fx = setup(t, 'hang', { timeoutMs: 500 });
  const first = fx.service.query(fx.query()); await until(() => fx.calls().length === 1);
  const pid = fx.calls()[0].pid;
  assert.equal((await first).reason, 'timeout');
  assert.throws(() => process.kill(-pid, 0), error => error.code === 'ESRCH');
  const second = fx.service.query(fx.query()); await until(() => fx.calls().length === 2);
  assert.equal((await second).reason, 'timeout'); assert.equal(fx.spawns(), 2);
});

test('reap failure locks machine without spawning again; shutdown retries group cleanup idempotently', async t => {
  let denied = true;
  const fx = setup(t, 'ok', { reapOptions: { termMs: 1, reapMs: 10, pollMs: 1, kill() {
    throw Object.assign(new Error('denied'), { code: denied ? 'EPERM' : 'ESRCH' });
  } } });
  failed(await fx.service.query(fx.query())); failed(await fx.service.query(fx.query())); assert.equal(fx.spawns(), 1);
  denied = false;
  const closing = fx.service.shutdown(); assert.equal(fx.service.shutdown(), closing); await closing;

});

test('spawn throws/errors and guard refusal are unavailable with no stdout logging', async t => {
  const warnings = []; const fx = setup(t);
  const throwing = fx.newService({ spawn() { throw new Error(BODY); }, warn: code => warnings.push(code) });
  failed(await throwing.query(fx.query()));
  const missing = fx.newService({ execPath: '/missing-node' }); failed(await missing.query(fx.query()));
  const refused = fx.newService({ scriptPath: path.resolve(__dirname, '../../scripts/session-snapshot.mjs') });
  failed(await refused.query(fx.query())); assert.equal(warnings.join('').includes(BODY), false); assert.equal(fx.spawns(), 0);
});

test('unreaped group retains global capacity while other machines continue', async t => {
  let denied = true;
  const fx = setup(t, 'ok', { reapOptions: { termMs: 1, reapMs: 10, pollMs: 1, kill(pgid, signal) {
    if (denied) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return process.kill(pgid, signal);
  } } });
  const gamma = structuredClone(fx.alpha); gamma.machine.id = 'gamma';
  gamma.sessions.forEach(row => { row.key = row.key.replace('alpha', 'gamma'); row.session_id = 'gamma-' + row.session_id; });
  gamma.instructions.forEach(row => { row.session_key = row.session_key.replace('alpha', 'gamma'); row.id = row.id.replace('claude:', 'claude:gamma-'); });
  fx.write(gamma);
  const service = fx.newService({ env: { ...fx.env, FAKE_ANSWER_DELAY: '200' } });
  failed(await service.query(fx.query())); denied = false;
  const beta = service.query(fx.query('beta'));
  assert.throws(() => service.query(fx.query('gamma')), { code: 'answer_busy' });
  assert.equal((await beta).status, 'final');
  assert.equal((await service.query(fx.query('gamma'))).status, 'final');
  assert.equal(fx.spawns(), 3);
});

test('ssh timeout cools only its machine until first request start + 60s, retaining global capacity', async t => {
  const start = Date.parse('2026-10-14T00:00:00.000Z'); let time = start;
  const fx = setup(t);
  const gamma = structuredClone(fx.alpha); gamma.machine.id = 'gamma';
  gamma.sessions.forEach(row => { row.key = row.key.replace('alpha', 'gamma'); row.session_id = 'gamma-' + row.session_id; });
  gamma.instructions.forEach(row => { row.session_key = row.session_key.replace('alpha', 'gamma'); row.id = row.id.replace('claude:', 'claude:gamma-'); });
  fx.write(gamma);
  const service = fx.newService({ timeoutMs: 500, clock: () => time,
    env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([
      { name: 'remote', machineId: 'alpha', kind: 'ssh', host: 'user@host' },
      { name: 'beta', machineId: 'beta', kind: 'local' }, { name: 'gamma', machineId: 'gamma', kind: 'local' }]) },
    spawn(command, argv, options) {
      return fx.options.spawn(command, argv, { ...options, env: { ...options.env,
        FAKE_ANSWER_MODE: argv.includes('remote') ? 'hang' : 'ok', FAKE_ANSWER_DELAY: '100' } });
    } });
  const input = fx.query(); const first = service.query(input);
  await until(() => fx.calls().length === 1);
  time = start + 10000;
  assert.equal(service.query(input), first, 'joining must not reset the request start');
  const result = await first; assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'timeout');
  assert.throws(() => process.kill(-fx.calls()[0].pid, 0), error => error.code === 'ESRCH');
  const spawnCount = fx.spawns();
  assert.throws(() => service.query(input), { code: 'answer_busy', status: 429 });
  assert.equal(fx.spawns(), spawnCount);
  const beta = service.query(fx.query('beta'));
  assert.throws(() => service.query(fx.query('gamma')), { code: 'answer_busy', status: 429 });
  assert.equal((await beta).status, 'final');
  assert.equal((await service.query(fx.query('gamma'))).status, 'final');
  assert.equal(fx.spawns(), spawnCount + 2, 'cooling plus one execution must exhaust global capacity');
  time = start + 59999;
  assert.throws(() => service.query(input), { code: 'answer_busy', status: 429 });
  assert.equal(fx.spawns(), spawnCount + 2);
  time = start + 60001;
  const freeBeta = service.query(fx.query('beta')), freeGamma = service.query(fx.query('gamma'));
  assert.equal((await freeBeta).status, 'final'); assert.equal((await freeGamma).status, 'final');
  assert.equal(fx.spawns(), spawnCount + 4, 'expired cooling must free capacity when other machines query');
  assert.equal((await service.query(input)).reason, 'timeout');
  assert.equal(fx.spawns(), spawnCount + 5);
  const begun = Date.now(); await service.shutdown();
  assert.ok(Date.now() - begun < 1000, 'shutdown must not wait for cooling with the clock frozen');
});

test('ssh shutdown cancellation reaps its local group without waiting for remote cooling', async t => {
  const fx = setup(t, 'hang');
  const service = fx.newService({ timeoutMs: 60000, clock: () => Date.parse('2026-10-14T00:00:00.000Z'),
    env: { ...fx.env, PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([
      { name: 'remote', machineId: 'alpha', kind: 'ssh', host: 'user@host' }]) } });
  let settled = false;
  const task = service.query(fx.query()).finally(() => { settled = true; });
  await until(() => fx.calls().length >= 1); assert.equal(settled, false);
  const pid = fx.calls()[0].pid, begun = Date.now();
  await service.shutdown();
  assert.equal(settled, true); failed(await task);
  assert.throws(() => process.kill(-pid, 0), error => error.code === 'ESRCH');
  assert.ok(Date.now() - begun < 1000, 'shutdown must wait for reaping, not a cooling deadline');
});

test('ssh execution cannot start after the request-time budget even when launch is delayed', async t => {
  const start = Date.parse('2026-10-14T00:00:00.000Z'); let time = start;
  const fx = setup(t);
  const service = fx.newService({ clock: () => time, env: { ...fx.env,
    PALANTIR_SNAPSHOT_TARGETS: JSON.stringify([{ name: 'remote', machineId: 'alpha', kind: 'ssh', host: 'user@host' }]) } });
  const input = fx.query(), task = service.query(input);
  time = start + 30001;
  const result = await task;
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'timeout'); assert.equal(fx.spawns(), 0);
  assert.throws(() => service.query(input), { code: 'answer_busy', status: 429 });
  time = start + 60001;
  assert.equal((await service.query(input)).status, 'final'); assert.equal(fx.spawns(), 1);
});
