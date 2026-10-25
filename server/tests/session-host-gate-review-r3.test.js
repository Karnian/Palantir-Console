'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const { evaluateInitialization, evaluateAccountRecheck } = require('../sessionHost/authGate');
const id = '12345678-1234-4abc-8abc-123456789abc';
const pinnedPath = '/pinned/claude';
const startedAt = 'Sat Oct 24 17:40:20 2026';
const marker = `PALANTIR_OWNED_INCARNATION=${id}`;
function fixture(options = {}) {
  const state = { calls: [], pass: 0, elapsed: 0, start: `${startedAt}\n`, reads: 0, marked: () => true };
  const probe = createPsIdentityProbe({ pinnedPath, clock: () => state.elapsed, ...options, execFileSync(command, args, execution) {
    assert.equal(command, '/bin/ps');
    state.calls.push({ args, timeout: execution.timeout });
    state.elapsed += state.stepMs || 0;
    if (args.includes('pid=,command=')) {
      state.pass++;
      return state.global ? state.global(state.pass) : `10 ${pinnedPath} ${marker}\n`;
    }
    if (args.includes('pid=')) return '10\n';
    if (args.includes('lstart=')) {
      state.reads++;
      if (state.absent) throw Object.assign(Error(), { status: 1, stdout: '', stderr: '' });
      return typeof state.start === 'function' ? state.start(state.reads) : state.start;
    }
    if (args.includes('command=')) return `${pinnedPath} ${state.marked(state.pass) ? marker : 'unmarked'}\n`;
    return '1\n';
  } });
  return { state, probe };
}
test('R3-01 actual macOS lstart literal accepts ASCII padding and rejects other trailing whitespace', () => {
  const { state, probe } = fixture();
  assert.equal(probe.check(10, startedAt), 'match');
  state.start = 'Sat Oct 24 17:40:20 2026    \n';
  assert.equal(probe.check(10, startedAt), 'match');
  assert.deepEqual(probe.findMarked(id).pids, [{ pid: 10, startedAt }]);
  for (const suffix of ['\t\n', '\u00a0\n', ' \r\n', '  \n\n']) {
    state.start = 'Sat Oct 24 17:40:20 2026    \n';
    assert.equal(probe.check(10, startedAt), 'match');
    state.start = startedAt + suffix;
    assert.equal(probe.check(10, startedAt), 'query_failed');
  }
});
test('R3-02 candidate command and parent are bracketed by equal lstart reads', () => {
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).status, 'ok');
  assert.deepEqual(state.calls.slice(2, 6).map(call => call.args[1] === '-ww' ? 'command=' : call.args[1]),
    ['lstart=', 'command=', 'ppid=', 'lstart=']);
  assert.ok(state.calls[6].args.includes('pid=,command='));
});
test('R3-02 reused PID between command and parent cannot establish main or descendant identity', () => {
  for (const method of ['findMarked', 'listMarkedDescendants']) {
    const { state, probe } = fixture();
    assert.equal(probe[method](id).status, 'ok');
    state.reads = 0;
    state.start = read => read === 1 ? `${startedAt}\n` : 'Sat Oct 24 17:40:21 2026\n';
    assert.equal(probe[method](id).status, 'query_failed');
  }
});
test('R3-03 persistent global-positive individual-negative mismatch retries once and rejects', () => {
  for (const method of ['findMarked', 'listMarkedDescendants']) {
    const { state, probe } = fixture();
    assert.equal(probe[method](id).status, 'ok');
    state.pass = 0;
    state.marked = () => false;
    const result = probe[method](id);
    assert.equal(result.status, 'query_failed');
    assert.equal(state.pass, 2);
    // Each failed candidate adds before/command probes before the unchanged full scan.
    assert.equal(result.diagnostics.queryCount, 12);
  }
});
test('R3-03 retry resolves transient mismatch by rerunning global and individual queries', () => {
  const { state, probe } = fixture();
  state.marked = pass => pass === 2;
  const result = probe.findMarked(id);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pids, [{ pid: 10, startedAt }]);
  assert.equal(state.pass, 3);
  assert.equal(state.calls.filter(call => call.args.includes('pid=')).length, 2);
  assert.equal(result.diagnostics.queryCount, 13);
});
test('R3-03 retry may confirm globally absent marker but never returns empty on persistent disappearance', () => {
  const { state, probe } = fixture();
  state.absent = true;
  state.global = pass => pass === 1 ? `10 ${pinnedPath} ${marker}\n` : '10 unmarked\n';
  const result = probe.findMarked(id);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pids, []);
  assert.equal(state.pass, 2);
  state.pass = 0;
  state.global = null;
  assert.equal(probe.findMarked(id).status, 'query_failed');
  assert.equal(state.pass, 2);
});
test('R3-03 retries share the original deadline and PID budget', () => {
  const { state, probe } = fixture({ deadlineMs: 10 });
  assert.equal(probe.findMarked(id).status, 'ok');
  state.pass = 0;
  state.marked = () => false;
  state.stepMs = 2;
  const result = probe.findMarked(id);
  assert.equal(result.status, 'query_failed');
  assert.deepEqual(result.diagnostics, { elapsedMs: 10, queryCount: 5 });
  const limited = fixture({ maxPids: 1 });
  assert.equal(limited.probe.findMarked(id).status, 'ok');
  limited.state.pass = 0;
  limited.state.marked = () => false;
  assert.equal(limited.probe.findMarked(id).status, 'query_failed');
  assert.equal(limited.state.pass, 2);
  assert.equal(limited.state.calls.filter(call => call.args.includes('command=')).length, 3);
});
const account = () => ({ email: 'person@example.test', organization: 'org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' });
function evaluate(value) {
  return evaluateInitialization({ account: value, pid: 10, claude_code_version: '2.1.308',
    current_permission_mode: 'default', remote_control_auto_enable: false }, { expectedPid: 10 });
}
for (const key of ['tokenSource', 'apiKeySource']) {
  test(`R3-04 inherited Object.prototype.${key} rejects initialization and recheck with cleanup`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
    assert.equal(evaluate(account()).ok, true);
    assert.equal(evaluateAccountRecheck(account(), account()).ok, true);
    try {
      Object.defineProperty(Object.prototype, key, { configurable: true, value: undefined });
      assert.equal(evaluate(account()).ok, false);
      assert.equal(evaluateAccountRecheck(account(), account()).ok, false);
      assert.equal(evaluate(Object.assign(Object.create(null), account())).ok, true);
    } finally {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
    assert.equal(evaluate(account()).ok, true);
  });
}
