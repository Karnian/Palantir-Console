'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const startedAt = 'Sat Oct 24 00:52:00 2026';
function fixture() {
  const state = { output: ' 10 /pinned/claude PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc\n 11 node PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc\n' +
    ' 12 node PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc0\n', parents: { 10: 1, 11: 10 }, start: `${startedAt}\n`, signals: [] };
  const probe = createPsIdentityProbe({ pinnedPath: '/pinned/claude', execFileSync(command, args) {
    assert.equal(command, '/bin/ps');
    if (state.error) throw state.error;
    if (args.includes('-A')) return state.output;
    if (args.includes('ppid=')) return `${state.parents[args.at(-1)]}\n`;
    return state.start;
  }, kill(...args) { state.signals.push(args); } });
  return { state, probe };
}
test('exact marker token, unique parent root, descendants, and signal recheck', () => {
  const { probe, state } = fixture();
  assert.deepEqual(probe.findMarked('12345678-1234-4abc-8abc-123456789abc'), { status: 'ok', pids: [{ pid: 10, startedAt }] });
  assert.deepEqual(probe.listMarkedDescendants('12345678-1234-4abc-8abc-123456789abc'), { status: 'ok', pids: [{ pid: 11, startedAt }] });
  assert.equal(probe.check(10, startedAt), 'match');
  assert.equal(probe.verifyThenSignal(10, startedAt, 'SIGTERM'), 'match');
  assert.deepEqual(state.signals, [[10, 'SIGTERM']]);
  state.start = 'Sat Oct 24 00:53:00 2026\n';
  assert.equal(probe.verifyThenSignal(10, startedAt, 'SIGTERM'), 'mismatch_confirmed');
  assert.equal(state.signals.length, 1);
});
test('malformed, partial, empty, duplicate roots and permission errors never prove death', () => {
  for (const output of ['', 'malformed\n', '10 /pinned/claude PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc\nbroken\n',
    '10 /pinned/claude PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc\n10 duplicate\n']) {
    const { probe, state } = fixture();
    assert.equal(probe.findMarked('12345678-1234-4abc-8abc-123456789abc').status, 'ok');
    state.output = output;
    assert.deepEqual(probe.findMarked('12345678-1234-4abc-8abc-123456789abc'), { status: 'query_failed' });
  }
  const { probe, state } = fixture();
  assert.equal(probe.findMarked('12345678-1234-4abc-8abc-123456789abc').status, 'ok');
  state.parents[11] = 1;
  assert.deepEqual(probe.findMarked('12345678-1234-4abc-8abc-123456789abc'), { status: 'query_failed' });
  state.parents[11] = 10;
  for (const error of [Object.assign(Error(), { code: 'EPERM' }), Object.assign(Error(), { status: 1, stdout: '', stderr: 'permission denied' })]) {
    state.error = null;
    assert.equal(probe.check(10, startedAt), 'match');
    state.error = error;
    assert.equal(probe.check(10, startedAt), 'query_failed');
    assert.deepEqual(probe.findMarked('12345678-1234-4abc-8abc-123456789abc'), { status: 'query_failed' });
    assert.equal(probe.verifyThenSignal(10, startedAt, 'SIGTERM'), 'query_failed');
  }
  assert.deepEqual(state.signals, []);
});
test('absent PID status 1 with empty streams is distinct from empty successful and malformed output', () => {
  const { probe, state } = fixture();
  for (const output of ['', 'unknown']) {
    state.start = `${startedAt}\n`;
    assert.equal(probe.check(10, startedAt), 'match');
    state.start = output;
    assert.equal(probe.check(10, startedAt), 'query_failed');
  }
  state.start = `${startedAt}\n`;
  assert.equal(probe.check(10, startedAt), 'match');
  state.error = Object.assign(Error(), { status: 1, stdout: '', stderr: '' });
  assert.equal(probe.check(10, startedAt), 'mismatch_confirmed');
});
test('no matching token succeeds empty and surviving tools remain visible after main disappears', () => {
  const { probe, state } = fixture();
  assert.equal(probe.findMarked('12345678-1234-4abc-8abc-123456789abc').pids[0].pid, 10);
  state.output = '11 node PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc\n';
  state.parents[11] = 1;
  assert.deepEqual(probe.listMarkedDescendants('12345678-1234-4abc-8abc-123456789abc'), { status: 'ok', pids: [{ pid: 11, startedAt }] });
  state.output = '12 node PALANTIR_OWNED_INCARNATION=12345678-1234-4abc-8abc-123456789abc0\n';
  assert.deepEqual(probe.findMarked('12345678-1234-4abc-8abc-123456789abc'), { status: 'ok', pids: [] });
  assert.deepEqual(probe.listMarkedDescendants('12345678-1234-4abc-8abc-123456789abc'), { status: 'ok', pids: [] });
});
test('real ps identifies marked child and grandchild then confirms exit', { timeout: 8000 }, async t => {
  const id = require('node:crypto').randomUUID();
  const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{child.kill();child.on('exit',()=>process.exit());});
    console.log(child.pid);setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', source], {
    env: { PATH: process.env.PATH, PALANTIR_OWNED_INCARNATION: id }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let grandchild;
  t.after(() => { child.kill(); if (grandchild) { try { process.kill(grandchild); } catch {} } });
  const [data] = await once(child.stdout, 'data');
  grandchild = Number(String(data).trim());
  const probe = createPsIdentityProbe({ pinnedPath: process.execPath });
  const found = probe.findMarked(id);
  assert.equal(found.status, 'ok', 'real /bin/ps must be available; sandbox EPERM requires host rerun');
  assert.equal(found.pids[0].pid, child.pid);
  const identity = found.pids[0];
  assert.equal(probe.check(identity.pid, identity.startedAt), 'match');
  assert.deepEqual(probe.listMarkedDescendants(id).pids.map(row => row.pid), [grandchild]);
  const exited = once(child, 'exit');
  child.kill();
  await exited;
  assert.equal(probe.check(identity.pid, identity.startedAt), 'mismatch_confirmed');
});
