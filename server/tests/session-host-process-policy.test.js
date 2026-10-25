'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hostEnvironment, ensureHost } = require('../sessionHost/launcher');
const { fixture } = require('./helpers/session-host-fixture');
const { unavailableAdapter } = require('../sessionHost/main');
test('launcher strips OAuth and all PALANTIR variables regardless of legacy switch', () => {
  const env = hostEnvironment({ PALANTIR_TOKEN: 'secret', PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth', ANTHROPIC_API_KEY: 'sk-ant-oat-xx', HOME: '/tmp' });
  assert.deepEqual(env, { HOME: '/tmp' });
  assert.deepEqual(hostEnvironment({ ANTHROPIC_API_KEY: 'console' }), { ANTHROPIC_API_KEY: 'console' });
});
test('launcher and product main reject exact legacy switch before touching runtime', async () => {
  const previous = process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS;
  process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
  try {
    await assert.rejects(ensureHost({ runtimeDir: '/does/not/exist' }), { code: 'legacy_credential_mode' });
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../sessionHost/main.js')],
      { encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), 'legacy_credential_mode');
  } finally {
    if (previous === undefined) delete process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS;
    else process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = previous;
  }
});
test('unavailable adapter has no effects and emits fixed failure reason through public core method', t => {
  const f = fixture(t);
  const adapter = unavailableAdapter();
  for (const name of ['start', 'send', 'decide', 'interrupt', 'close', 'signal']) assert.throws(() => adapter[name](), /adapter_unavailable/);
  f.adapter.start = adapter.start;
  const request = { kind: 'start', cwd: '/tmp', request_key: f.key() };
  const result = f.core.submitUnavailable(request);
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'adapter_unavailable');
  assert.deepEqual(f.core.lookup(request.request_key), result);
  assert.deepEqual(f.core.submitUnavailable(request), result);
});
test('lookup exposes delivery aliases, controls and deletion tombstones without resubmission', t => {
  const f = fixture(t);
  const started = f.start();
  assert.deepEqual(f.core.lookup(started.request_key), started);
  const delivery = f.prompt();
  const { body_bytes, body_truncated, ...expected } = f.d(delivery.id);
  assert.deepEqual(f.core.lookup(delivery.request_key), expected);
  assert.equal(body_bytes, Buffer.byteLength(expected.body)); assert.equal(body_truncated, false);
  assert.deepEqual(f.core.lookup('missing'), { found: false });
  f.core.submit(f.req('close'));
  f.core.submit(f.req('delete'));
  assert.equal(f.core.lookup(delivery.request_key).session_deleted, 1);
  assert.equal(f.core.activity().activeSessions, 0);
});
test('lookup resolves a durable interrupt alias to its original delivery', t => {
  const f = fixture(t, { noReceipt: true, manual: true });
  f.start();
  f.prompt();
  const first = f.core.submit(f.req('interrupt'));
  const secondRequest = f.req('interrupt');
  const second = f.core.submit(secondRequest);
  assert.equal(second.id, first.id);
  const { body_bytes, body_truncated, ...expected } = f.d(first.id);
  assert.deepEqual(f.core.lookup(secondRequest.request_key), expected);
  assert.equal(body_bytes, Buffer.byteLength(expected.body)); assert.equal(body_truncated, false);
});
test('SQLite exclusive lock fails immediately for a second connection and releases explicitly', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { acquireLock } = require('../sessionHost/lock');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = acquireLock(dir);
  t.after(() => first.release());
  assert.throws(() => acquireLock(dir), { code: 'host_locked' });
  first.release();
  const replacement = acquireLock(dir);
  replacement.release();
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
