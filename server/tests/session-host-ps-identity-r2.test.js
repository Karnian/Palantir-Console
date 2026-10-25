'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const id = '12345678-1234-4abc-8abc-123456789abc';
const startedAt = 'Sat Oct 24 00:52:00 2026';
const pinnedPath = '/pinned cli/claude';
const marker = `PALANTIR_OWNED_INCARNATION=${id}`;
function absent() {
  return Object.assign(Error(), { status: 1, stdout: '', stderr: '' });
}
function fixture(options = {}) {
  const state = { global: `global hint ${pinnedPath} ${marker}\n20 unrelated\n`, pids: '10\n20\n',
    commands: { 10: `${pinnedPath} ${marker}\n`, 20: '/tool unrelated\n' },
    parents: { 10: '1\n', 20: '1\n' }, calls: [], elapsed: 0 };
  const probe = createPsIdentityProbe({ pinnedPath, clock: () => state.elapsed, ...options, execFileSync(command, args, execution) {
    assert.equal(command, '/bin/ps');
    state.calls.push({ args, timeout: execution.timeout });
    state.elapsed += state.stepMs || 0;
    if (args.includes('pid=,command=')) return state.global;
    if (args.includes('pid=')) return state.pids;
    const pid = args.at(-1);
    const value = args.includes('command=') ? state.commands[pid] :
      args.includes('ppid=') ? state.parents[pid] : `${startedAt}\n`;
    if (value instanceof Error) throw value;
    return value;
  } });
  return { state, probe };
}
test('R2-01 unrelated multiline argv and marked multiline argv use per-PID attribution', () => {
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).pids[0].pid, 10);
  state.global = `10 ${pinnedPath} first line\nsecond line ${marker}\n20 /tool first line\nnot a process row\n`;
  state.commands[10] = `${pinnedPath} first line\nsecond line ${marker}\n`;
  state.commands[20] = '/tool first line\nnot a process row\n';
  const result = probe.findMarked(id);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pids, [{ pid: 10, startedAt }]);
  assert.ok(state.calls.some(call => call.args.join(' ') === '-A -o pid='));
  assert.ok(state.calls.some(call => call.args.join(' ') === '-E -ww -o command= -p 20'));
  assert.deepEqual(result.diagnostics, { elapsedMs: 0, queryCount: 6 });
});
test('R2-01 global no-token multiline output succeeds empty without per-PID queries', () => {
  const { state, probe } = fixture();
  state.global = '20 /tool first line\nnot a PID row\n';
  const result = probe.findMarked(id);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.pids, []);
  assert.equal(result.diagnostics.queryCount, 1);
});
test('R2-02 marker-looking global PID never determines attribution', () => {
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).pids[0].pid, 10);
  state.global = `999 misleading argv continuation ${marker}\n`;
  assert.equal(probe.findMarked(id).pids[0].pid, 10);
});
test('R2-02 disappearing PID is skipped; other errors and malformed PID lists fail closed', () => {
  const { state, probe } = fixture();
  for (const error of [Object.assign(Error(), { code: 'EPERM' }),
    Object.assign(Error(), { status: 1, stdout: '', stderr: ' ' })]) {
    state.commands[20] = absent();
    assert.equal(probe.findMarked(id).status, 'ok');
    state.commands[20] = error;
    assert.equal(probe.findMarked(id).status, 'query_failed');
  }
  state.commands[20] = '/tool unrelated\n';
  for (const pids of ['10\nnot-pid\n', '10\n10\n', '', '10\n1.5\n']) {
    state.pids = '10\n20\n';
    assert.equal(probe.findMarked(id).status, 'ok');
    state.pids = pids;
    assert.equal(probe.findMarked(id).status, 'query_failed');
  }
});
test('R2-02 prefix-only global and per-PID output fail closed with full-token controls', () => {
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).status, 'ok');
  state.global = `anything ${marker.slice(0, -1)}\n`;
  assert.equal(probe.findMarked(id).status, 'query_failed');
  state.global = `anything ${marker}\n`;
  assert.equal(probe.findMarked(id).status, 'ok');
  state.commands[20] = `/tool\n${marker.slice(0, -1)}\n`;
  assert.equal(probe.findMarked(id).status, 'query_failed');
});
test('R2-03 PID count and total deadline are bounded and diagnostic counts reflect executed queries', () => {
  const { state, probe } = fixture({ maxPids: 2, deadlineMs: 10 });
  assert.equal(probe.findMarked(id).status, 'ok');
  state.pids = '10\n20\n30\n';
  const tooMany = probe.findMarked(id);
  assert.equal(tooMany.status, 'query_failed');
  assert.deepEqual(tooMany.diagnostics, { elapsedMs: 0, queryCount: 2 });
  state.pids = '10\n20\n';
  state.stepMs = 4;
  const timedOut = probe.findMarked(id);
  assert.equal(timedOut.status, 'query_failed');
  assert.deepEqual(timedOut.diagnostics, { elapsedMs: 12, queryCount: 3 });
  assert.deepEqual(state.calls.slice(-3).map(call => call.timeout), [10, 6, 2]);
});
test('R2 real ps ignores unrelated multiline argv while identifying a marked child', { timeout: 30000 }, async t => {
  const incarnationId = randomUUID();
  const children = [];
  t.after(async () => {
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(async child => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }));
  });
  async function launch(source, env) {
    const child = spawn(process.execPath, ['-e', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await once(child.stdout, 'data');
    return child;
  }
  const child = await launch('console.log("ready");setInterval(()=>{},1000);', { PALANTIR_OWNED_INCARNATION: incarnationId });
  const probe = createPsIdentityProbe({ pinnedPath: process.execPath });
  const control = probe.findMarked(incarnationId);
  assert.equal(control.status, 'ok', 'real ps control must pass before introducing unrelated multiline argv');
  assert.equal(control.pids[0].pid, child.pid);
  await launch('console.log("ready");\nsetInterval(()=>{},1000);', {});
  const found = probe.findMarked(incarnationId);
  assert.equal(found.status, 'ok');
  assert.equal(found.pids[0].pid, child.pid);
  assert.deepEqual(probe.listMarkedDescendants(incarnationId).pids, []);
});
