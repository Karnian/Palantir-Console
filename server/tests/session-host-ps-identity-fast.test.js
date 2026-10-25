'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const { hashFile, hashFileSync } = require('../sessionHost/argvCheck');
const id = '12345678-1234-4abc-8abc-123456789abc';
const marker = `PALANTIR_OWNED_INCARNATION=${id}`;
const startedAt = 'Sat Oct 24 00:52:00 2026';
function fixture(count = 3) {
  const state = { calls: [], commands: {}, parents: {}, global: '', absent: new Set() };
  const pids = Array.from({ length: count }, (_, index) => index + 10);
  for (const pid of pids) {
    state.commands[pid] = `/tool unmarked-${pid}`;
    state.parents[pid] = 1;
  }
  state.commands[10] = `/pinned/claude ${marker}`;
  state.commands[11] = `/tool ${marker}`;
  state.parents[11] = 10;
  state.global = pids.map(pid => `${pid} ${state.commands[pid]}\n`).join('');
  const probe = createPsIdentityProbe({ pinnedPath: '/pinned/claude', execFileSync(command, args) {
    assert.equal(command, '/bin/ps');
    state.calls.push(args);
    if (args.includes('pid=,command=')) return typeof state.global === 'function' ? state.global() : state.global;
    if (args.includes('pid=')) return pids.join('\n') + '\n';
    const pid = Number(args.at(-1));
    if (state.absent.has(pid)) throw Object.assign(Error(), { status: 1, stdout: '', stderr: '' });
    if (args.includes('command=')) return state.commands[pid] + '\n';
    if (args.includes('ppid=')) return state.parents[pid] + '\n';
    return startedAt + '\n';
  } });
  return { state, probe };
}
function markedPids(probe) {
  const result = probe.listMarkedDescendants(id);
  assert.equal(result.status, 'ok');
  return result.pids.map(row => row.pid);
}

test('fast ps scan uses 11 queries for two marked processes among 3000', { timeout: 5000 }, () => {
  const { state, probe } = fixture(3000);
  assert.deepEqual(markedPids(probe), [10, 11]);
  assert.equal(state.calls.length, 3 + 2 * 4);
  assert.equal(state.calls.filter(args => args.includes('command=')).length, 2);
  state.calls.length = 0;
  assert.deepEqual(probe.findMarked(id).pids, [{ pid: 10, startedAt }]);
  assert.equal(state.calls.length, 11);
});

test('fast ps duplicate mapping from newline forged real PID falls back to full scan', { timeout: 5000 }, () => {
  const { state, probe } = fixture();
  assert.deepEqual(markedPids(probe), [10, 11]);
  // PID 10's argv continuation impersonates the real marked PID 11.
  state.global = `10 /pinned/claude first line\n11 forged continuation ${marker}\n11 /tool ${marker}\n12 /tool\n`;
  state.commands[10] = `/pinned/claude first line\n11 forged continuation ${marker}`;
  state.calls.length = 0;
  assert.deepEqual(markedPids(probe), [10, 11]);
  assert.ok(state.calls.some(args => args.includes('command=') && args.at(-1) === '12'), 'full scan must inspect unrelated PID');
});

test('fast ps candidate without per-PID marker falls back to full scan', { timeout: 5000 }, () => {
  const { state, probe } = fixture();
  assert.deepEqual(markedPids(probe), [10, 11]);
  // Neither global candidate maps to the actual owner of this marker line.
  state.global = `10 /pinned/claude first line\n12 forged continuation ${marker}\n11 /tool ${marker}\n`;
  state.commands[10] = `/pinned/claude first line\n12 forged continuation ${marker}`;
  state.calls.length = 0;
  assert.deepEqual(markedPids(probe), [10, 11]);
  assert.equal(state.calls.filter(args => args.includes('command=') && args.at(-1) === '12').length, 2);
});

test('fast ps absent candidate forces full scan without discarding surviving processes', { timeout: 5000 }, () => {
  const { state, probe } = fixture();
  state.absent.add(11);
  assert.deepEqual(markedPids(probe), [10]);
  assert.equal(state.calls.length, 14);
});

test('buffered synchronous SHA-256 matches async and reference across buffer boundaries', { timeout: 5000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const length of [0, 1, 1024 * 1024, 2 * 1024 * 1024 + 17]) {
    const bytes = Buffer.alloc(length, 0x87);
    const file = path.join(dir, String(length));
    fs.writeFileSync(file, bytes);
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hashFileSync(file), expected);
    assert.equal(await hashFile(file), expected);
  }
});

test('buffered synchronous SHA-256 closes its descriptor after a read error', { timeout: 5000 }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-hash-error-'));
  const file = path.join(dir, 'input');
  fs.writeFileSync(file, 'data');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalRead = fs.readSync, originalClose = fs.closeSync;
  let closed = 0;
  try {
    fs.readSync = () => { throw Error('injected_read_failure'); };
    fs.closeSync = fd => { closed++; return originalClose(fd); };
    assert.throws(() => hashFileSync(file), /injected_read_failure/);
    assert.equal(closed, 1);
  } finally {
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
  }
});

test('R2 ps absent forged candidate cannot hide live marked child', { timeout: 5000 }, () => {
  const { state, probe } = fixture();
  assert.equal(probe.findMarked(id).pids[0].pid, 10);
  state.commands[11] = `/tool newline\n12 forged argv ${marker}`;
  state.global = `10 /pinned/claude ${marker}\n11 /tool newline\n12 forged argv ${marker}\n12 /temporary\n`;
  state.absent.add(12);
  assert.deepEqual(markedPids(probe), [11]);
});

test('R2 ps new marked process between G and P cannot be omitted', { timeout: 5000 }, () => {
  const { state, probe } = fixture(4);
  const before = state.global;
  state.commands[12] = `/new/tool ${marker}`;
  state.parents[12] = 10;
  const after = `10 /pinned/claude ${marker}\n11 /tool ${marker}\n12 /new/tool ${marker}\n13 unrelated\n`;
  let globals = 0;
  state.global = () => ++globals === 1 ? before : after;
  assert.deepEqual(markedPids(probe), [10, 11, 12]);
  assert.ok(globals >= 2);
  assert.ok(state.calls.some(args => args.includes('command=') && args.at(-1) === '13'), 'mapping change must use full scan');
});

test('R2 ps changed final G mapping forces full scan', { timeout: 5000 }, () => {
  const { state, probe } = fixture(4);
  const before = state.global;
  let globals = 0;
  state.global = () => ++globals === 1 ? before : `11 /tool ${marker}\n10 /pinned/claude ${marker}\n12 unrelated\n13 unrelated\n`;
  assert.deepEqual(markedPids(probe), [10, 11]);
  assert.ok(state.calls.some(args => args.includes('command=') && args.at(-1) === '13'), 'changed mapping must use full scan');
});

test('R2 ps new marked PID outside original P fails closed', { timeout: 5000 }, () => {
  const { state, probe } = fixture();
  const before = state.global;
  let globals = 0;
  state.global = () => ++globals === 1 ? before : before + `13 /new/tool ${marker}\n`;
  assert.equal(probe.listMarkedDescendants(id).status, 'query_failed');
});
