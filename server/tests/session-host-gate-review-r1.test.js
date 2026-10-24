'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildChildEnv, assertChildEnv } = require('../sessionHost/spawnEnv');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const { evaluateInitialization, evaluateAccountRecheck } = require('../sessionHost/authGate');
const { checkSpawnOptions, hashFile } = require('../sessionHost/argvCheck');
const id = '12345678-1234-4abc-8abc-123456789abc';
const pinnedPath = '/pinned cli/claude';
const startedAt = 'Sat Oct 24 00:52:00 2026';
function fixture() {
  const state = { output: `10 ${pinnedPath} PALANTIR_OWNED_INCARNATION=${id}\n`, start: `${startedAt}\n` };
  const probe = createPsIdentityProbe({ pinnedPath, execFileSync(command, args) {
    assert.equal(command, '/bin/ps');
    if (args.includes('-A')) return state.output;
    if (state.error) throw state.error;
    return args.includes('ppid=') ? '1\n' : state.start;
  } });
  return { state, probe };
}
test('R1-01 UUID v4 required by env and both marker queries', () => {
  for (const bad of ['inc_1', '12345678-1234-1abc-8abc-123456789abc', '12345678-1234-4abc-7abc-123456789abc']) {
    assert.doesNotThrow(() => buildChildEnv({ incarnationId: id }));
    assert.throws(() => buildChildEnv({ incarnationId: bad }), { code: 'invalid_child_env' });
    const { probe } = fixture();
    assert.equal(probe.findMarked(id).status, 'ok');
    assert.equal(probe.findMarked(bad).status, 'query_failed');
    assert.equal(probe.listMarkedDescendants(bad).status, 'query_failed');
  }
});
test('R1-01 main executable must match pinned path including spaces', () => {
  const { state, probe } = fixture();
  for (const command of ['/other/tool', `${pinnedPath}-other`, `echo ${pinnedPath}`]) {
    state.output = `10 ${pinnedPath} PALANTIR_OWNED_INCARNATION=${id}\n`;
    assert.equal(probe.findMarked(id).pids[0].pid, 10);
    state.output = `10 ${command} PALANTIR_OWNED_INCARNATION=${id}\n`;
    assert.equal(probe.findMarked(id).status, 'query_failed');
  }
});
test('R1-02 truncated marker prefixes and malformed PID fail closed', () => {
  for (const suffix of [id.slice(0, 1), id.slice(0, -1), '']) {
    const { state, probe } = fixture();
    assert.equal(probe.findMarked(id).status, 'ok');
    state.output = `10 ${pinnedPath} PALANTIR_OWNED_INCARNATION=${suffix}\n`;
    assert.equal(probe.findMarked(id).status, 'query_failed');
    assert.equal(probe.listMarkedDescendants(id).status, 'query_failed');
  }
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).status, 'ok');
  state.output = `1.5 ${pinnedPath} PALANTIR_OWNED_INCARNATION=${id}\n`;
  assert.equal(probe.findMarked(id).status, 'query_failed');
});
test('R1-03 child env has null prototype and inherited pollution is rejected', () => {
  const good = buildChildEnv({ incarnationId: id, baseEnv: Object.create({ HOME: '/inherited' }) });
  assert.equal(Object.getPrototypeOf(good), null);
  assert.equal(Object.hasOwn(good, 'HOME'), false);
  assert.equal(assertChildEnv(good, id), true);
  for (const prototype of [Object.prototype, { PALANTIR_TOKEN: 'secret' }, { ANTHROPIC_API_KEY: 'secret' }]) {
    const bad = Object.assign(Object.create(prototype), good);
    assert.equal(assertChildEnv(good, id), true);
    assert.throws(() => assertChildEnv(bad, id), { code: 'invalid_child_env' });
  }
});
test('R1-04 only zero-length absent streams prove death', () => {
  const { state, probe } = fixture();
  for (const streams of [{ stdout: ' ', stderr: '' }, { stdout: '', stderr: '\n' },
    { stdout: '', stderr: 'process id too large' }]) {
    state.error = Object.assign(Error(), { status: 1, stdout: '', stderr: '' });
    assert.equal(probe.check(10, startedAt), 'mismatch_confirmed');
    state.error = Object.assign(Error(), { status: 1, ...streams });
    assert.equal(probe.check(10, startedAt), 'query_failed');
  }
});
test('R1-05 lstart rejects extra lines and invalid calendar/time ranges', () => {
  const { state, probe } = fixture();
  for (const bad of ['Sat Oct 00 00:52:00 2026', 'Sat Oct 32 00:52:00 2026', 'Sat Oct 24 24:52:00 2026',
    'Sat Oct 24 00:60:00 2026', 'Sat Oct 24 00:52:60 2026', 'Bad Oct 24 00:52:00 2026',
    'Sat Bad 24 00:52:00 2026', `${startedAt}\n\n`, 'Sat Oct\n24 00:52:00 2026']) {
    state.start = `${startedAt}\n`;
    assert.equal(probe.check(10, startedAt), 'match');
    state.start = bad;
    assert.equal(probe.check(10, startedAt), 'query_failed');
  }
});
test('R1-05 lstart compares normalized spaces', () => {
  const { state, probe } = fixture();
  state.start = 'Sat Oct  4 00:52:00 2026\n';
  assert.equal(probe.check(10, 'Sat Oct 4 00:52:00 2026'), 'match');
  assert.equal(probe.check(10, 'Sat Oct  4 00:52:00 2026'), 'match');
});
const account = () => ({ email: 'person@example.test', organization: 'org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
const evaluate = value => evaluateInitialization({ account: value, pid: 10, claude_code_version: '2.1.308',
  current_permission_mode: 'default', remote_control_auto_enable: false }, { expectedPid: 10 });
test('R1-06 account requires own nonempty email and organization', () => {
  for (const key of ['email', 'organization']) {
    for (const value of [undefined, '', '   ']) {
      const bad = account();
      if (value === undefined) delete bad[key];
      else bad[key] = value;
      assert.equal(evaluate(account()).ok, true);
      assert.equal(evaluate(bad).ok, false);
      assert.equal(evaluateAccountRecheck(account(), account()).ok, true);
      assert.equal(evaluateAccountRecheck(bad, bad).ok, false);
      assert.equal(JSON.stringify(evaluate(bad)).includes('person@example.test'), false);
    }
  }
  assert.equal(evaluate(Object.assign(Object.create(null), account())).ok, true);
});
test('R1-06 account rejects custom prototypes regardless of inherited fields', () => {
  for (const prototype of [{}, { tokenSource: 'x' }, { apiKeySource: undefined }]) {
    assert.equal(evaluate(account()).ok, true);
    assert.equal(evaluate(Object.assign(Object.create(prototype), account())).ok, false);
  }
});
test('R1-07 streaming hash uses an independent known SHA-256 literal', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixed');
  fs.writeFileSync(file, 'abc');
  const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await hashFile(file), digest);
  const input = { command: file, args: ['--permission-mode=default'] };
  const options = { pinnedPath: file, pinnedSha256: digest };
  assert.equal((await checkSpawnOptions(input, options)).ok, true);
  fs.writeFileSync(file, 'abcd');
  assert.equal((await checkSpawnOptions(input, options)).ok, false);
});
test('R1-07 hash throw and rejection refuse spawn with passing controls', async () => {
  const digest = 'a'.repeat(64);
  const input = { command: process.execPath, args: ['--permission-mode=default'] };
  const options = { pinnedPath: process.execPath, pinnedSha256: digest };
  for (const hash of [() => { throw Error('private path'); }, async () => { throw Error('private path'); }]) {
    assert.equal((await checkSpawnOptions(input, { ...options, hashFile: () => digest })).ok, true);
    assert.deepEqual(await checkSpawnOptions(input, { ...options, hashFile: hash }), { ok: false, reason: 'executable_check_failed' });
  }
});
