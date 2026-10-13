'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const reader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const policy = require('../services/observeSnapshotPolicy');
const { setup, cases } = require('./fixtures/session-snapshot/a1a.cjs');
const fingerprint = stats => crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`)
  .digest('hex').slice(0, 16);
for (const provider of ['claude', 'codex']) for (const large of [false, true]) {
  test(`file_fp matches validated fd for ${provider}, large=${large}`, t => {
    const f = setup(t, cases[provider]);
    if (large) {
      const padding = JSON.stringify({ type: 'padding', timestamp: '2026-10-08T02:00:00.000Z', text: 'x'.repeat(1024 * 1024) }) + '\n';
      for (let i = 0; i < 17; i++) fs.appendFileSync(f.files[0], padding);
      assert.ok(fs.statSync(f.files[0]).size > reader.MAX_FILE_BYTES);
    }
    const expected = fingerprint(fs.statSync(f.files[0], { bigint: true }));
    const originalOpen = fs.openSync, originalFstat = fs.fstatSync;
    let fd, verified = false, bigintCalls = 0;
    t.mock.method(fs, 'openSync', (filename, ...args) => {
      const opened = originalOpen(filename, ...args);
      if (filename === f.files[0]) fd = opened;
      return opened;
    });
    t.mock.method(fs, 'fstatSync', (descriptor, options) => {
      if (descriptor === fd) {
        if (options?.bigint) { assert.equal(verified, true); bigintCalls++; }
        else verified = true;
      }
      return originalFstat(descriptor, options);
    });
    const snapshot = reader.runSnapshot(f.options);
    assert.equal(snapshot.sessions.length, 1);
    assert.match(snapshot.sessions[0].file_fp, /^[0-9a-f]{16}$/);
    assert.equal(snapshot.sessions[0].file_fp, expected);
    assert.ok(bigintCalls > 0);
    assert.equal(policy.validateSnapshot(snapshot).ok, true);
    assert.equal(JSON.stringify(snapshot).includes(f.files[0]), false);
  });
}
test('file_fp uses BigInt decimal values without Number precision loss or post-parse path stat', t => {
  const f = setup(t);
  const originalOpen = fs.openSync, originalFstat = fs.fstatSync, originalStat = fs.statSync;
  const huge = { dev: 9007199254740993n, ino: 18446744073709551615n };
  let fd, parsed = false, bigintCalls = 0;
  const originalRead = fs.readSync;
  t.mock.method(fs, 'openSync', (filename, ...args) => {
    const opened = originalOpen(filename, ...args);
    if (filename === f.files[0]) fd = opened;
    return opened;
  });
  t.mock.method(fs, 'readSync', (descriptor, ...args) => {
    const count = originalRead(descriptor, ...args);
    if (descriptor === fd) parsed = true;
    return count;
  });
  t.mock.method(fs, 'fstatSync', (descriptor, options) => {
    const stats = originalFstat(descriptor, options);
    if (descriptor === fd && options?.bigint) { bigintCalls++; return { ...stats, ...huge }; }
    return stats;
  });
  t.mock.method(fs, 'statSync', (filename, ...args) => {
    assert.ok(filename !== f.files[0] || !parsed, 'small-file fingerprint must not re-stat path after reading');
    return originalStat(filename, ...args);
  });
  const snapshot = reader.runSnapshot(f.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].file_fp, fingerprint(huge));
  assert.ok(bigintCalls > 0);
  assert.notEqual(fingerprint(huge), fingerprint({ dev: Number(huge.dev), ino: Number(huge.ino) }));
});
test('file_fp optional HEX16 slot preserves old snapshots and rejects malformed values', t => {
  const f = setup(t);
  const snapshot = reader.runSnapshot(f.options);
  assert.equal(snapshot.sessions.length, 1);
  for (const version of [1, 2]) {
    const old = structuredClone(snapshot);
    old.policy_version = version;
    if (version === 1) delete old.sessions[0].status;
    delete old.sessions[0].file_fp;
    assert.equal(policy.validateSnapshot(old).ok, true);
    old.sessions[0].file_fp = '0123456789abcdef';
    assert.equal(policy.validateSnapshot(old).ok, true);
    for (const invalid of ['A'.repeat(16), 'a'.repeat(15), 'a'.repeat(17), null, 123, '', 'g'.repeat(16)]) {
      old.sessions[0].file_fp = invalid;
      assert.equal(policy.validateSnapshot(old).ok, false);
    }
  }
});
test('held, excluded and exec sessions export no session or file_fp', t => {
  const held = setup(t, cases.held);
  const snapshot = reader.runSnapshot(held.options);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.coverage.codex.exec_sessions_excluded, 1);
  assert.deepEqual(snapshot.sessions, []);
  const excluded = setup(t);
  const config = JSON.parse(fs.readFileSync(excluded.config));
  config.exclude.sessions.push('claude:s');
  fs.writeFileSync(excluded.config, JSON.stringify(config));
  const result = reader.runSnapshot(excluded.options);
  assert.equal(result.coverage.claude.excluded_sessions, 1);
  assert.deepEqual(result.sessions, []);
  const multi = setup(t, [...cases.claude, ['claude', 'copy', cases.claude[0][2]]]);
  const duplicate = reader.runSnapshot(multi.options);
  assert.equal(duplicate.coverage.claude.multi_file_withheld, 1);
  assert.deepEqual(duplicate.sessions, []);
});
