'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const { buildHandoffCommand } = require('../sessionHost/handoffCommand');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createSdkAdapter } = require('../sessionHost/sdkAdapter');
const id = '12345678-1234-1234-1234-123456789abc';
const input = { cwd: '/tmp/work', home: '/tmp/home', executablePath: '/fake/claude', claudeSessionId: id };

test('SDK handoff verifier rechecks bytes and canonical path synchronously without spawning', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-pin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = path.join(dir, 'claude');
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'original'); fs.symlinkSync(target, executablePath);
  const adapter = createSdkAdapter({ sdk: {}, executablePath,
    executableSha256: createHash('sha256').update('original').digest('hex') });
  assert.equal(adapter.home, process.env.HOME); assert.equal(adapter.verifyExecutable(), true);
  fs.writeFileSync(target, 'changed'); assert.equal(adapter.verifyExecutable(), false);
  fs.writeFileSync(target, 'original'); assert.equal(adapter.verifyExecutable(), true);
  const other = path.join(dir, 'other'); fs.writeFileSync(other, 'original');
  fs.unlinkSync(executablePath); fs.symlinkSync(other, executablePath);
  assert.equal(adapter.verifyExecutable(), false);
});

test('handoff rejects stale incarnation with zero effects and same incarnation passes', t => {
  const f = fixture(t); f.start();
  assert.equal(f.core.submit(f.req('handoff', { incarnation_id: id })).state, 'rejected');
  assert.equal(f.adapter.log.closes.length, 0);
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
});

test('handoff hash mismatch leaves active session and produces no effects; matching pin passes', t => {
  const f = fixture(t, { executableValid: false }); f.start();
  assert.equal(f.core.submit(f.req('handoff')).reason, 'executable_hash_mismatch');
  assert.equal(f.state().session.state, 'active');
  for (const name of ['interrupts', 'closes', 'signals']) assert.equal(f.adapter.log[name].length, 0);
  assert.equal(f.state().handoff_command, undefined);
  f.adapter.options.executableValid = true;
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  assert.match(f.state().handoff_command, /--resume/);
  for (const kind of ['prompt', 'resume', 'handoff']) assert.equal(f.core.submit(f.req(kind, { body: 'no' })).state, 'rejected');
  assert.equal(f.core.submit(f.req('delete')).state, 'done');
  assert.equal(f.state().handoff_command, undefined);
});

test('handoff command appears only after exit and clear descendants', t => {
  const f = fixture(t, { noExit: true }); f.start();
  assert.equal(f.state().handoff_command, undefined);
  const control = f.core.submit(f.req('handoff'));
  assert.equal(control.state, 'accepted'); assert.equal(f.state().handoff_command, undefined);
  f.probe.descendants.set(f.iid, { status: 'ok', pids: [{ pid: 44, startedAt: 'x' }] });
  f.adapter.exit(f.iid);
  assert.equal(f.core.lookup(control.request_key).state, 'blocked');
  assert.equal(f.state().handoff_command, undefined);
  f.probe.descendants.delete(f.iid);
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  assert.equal(f.state().handoff_command, buildHandoffCommand({ ...input, cwd: '/private/work',
    home: f.adapter.home, executablePath: f.adapter.executablePath, claudeSessionId: f.sid }));
});

test('handoff shell parses quoted paths and starts with a clean environment', () => {
  const cwd = "/tmp/space ' $HOME `id`";
  const command = buildHandoffCommand({ ...input, cwd });
  const parsed = spawnSync('/bin/sh', ['-c', 'unset SHELL TERM LOGNAME; ' + command.replace(/^cd /, 'printf "%s\\0" ').replace(' && env ', ' env ')],
    { encoding: 'utf8', env: { PATH: '/bin', USER: '' } });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(parsed.stdout.split('\0').slice(0, -1),
    [cwd, 'env', '-i', 'PATH=/bin', 'USER=', 'HOME=/tmp/home', '/fake/claude', '--resume', id]);
});

test('handoff rejects invalid paths and UUID, each with one-field passing control', () => {
  for (const field of ['cwd', 'home', 'executablePath']) {
    for (const value of ['/tmp/a\nb', '/tmp/a\0b', 'relative']) {
      assert.throws(() => buildHandoffCommand({ ...input, [field]: value }), { code: 'invalid_handoff_path' });
      assert.ok(buildHandoffCommand(input));
    }
  }
  assert.throws(() => buildHandoffCommand({ ...input, claudeSessionId: 'bad' }), { code: 'invalid_claude_session_id' });
  assert.ok(buildHandoffCommand(input));
});

test('handoff executes fixture with fixed HOME, exact cwd and resume argv', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff ' $ ` space-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executablePath = path.resolve(__dirname, 'fixtures/bin/handoff-env-stdout.cjs');
  fs.chmodSync(executablePath, 0o755);
  const command = buildHandoffCommand({ ...input, cwd: dir, executablePath });
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(result.stdout);
  assert.equal(received.cwd, fs.realpathSync(dir));
  assert.equal(received.env.HOME, input.home);
  assert.deepEqual(received.argv, ['--resume', id]);
});
