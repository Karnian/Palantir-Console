'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');
const { buildHandoffCommand } = require('../sessionHost/handoffCommand');
function update(f, sql, ...args) {
  const db = new Database(f.dbPath);
  try { db.prepare(sql).run(...args); } finally { db.close(); }
}
function resumeBeforeSpawn(f) {
  f.faults.arm('after_spawn_sent_before_spawn');
  const request = f.req('resume');
  assert.throws(() => f.core.submit(request), SimulatedCrash);
  f.reboot().recover();
  f.iid = f.state().current_incarnation_id;
  const planned = f.state().incarnations.find(row => row.id === f.iid);
  assert.equal(planned.state, 'never_started');
  assert.equal(planned.pid, null); assert.equal(planned.pid_started_at, null);
  return planned;
}
for (const changed of [false, true]) {
  test(`R2 HOME A execution and HOME ${changed ? 'B' : 'A'} planned resume crash`, t => {
    const f = fixture(t, { home: '/home/A' }); f.start();
    const actualId = f.iid;
    assert.equal(f.core.submit(f.req('stop')).state, 'done');
    if (changed) f.adapter.home = '/home/B';
    assert.equal(resumeBeforeSpawn(f).cli_home, f.adapter.home);
    assert.equal(f.adapter.log.starts.length, 1);
    const result = f.core.submit(f.req('handoff'));
    assert.equal(result.state, changed ? 'failed' : 'done');
    if (changed) {
      assert.equal(result.reason, 'handoff_environment_mismatch');
      assert.equal(f.state().session.state, 'active'); assert.equal(f.state().handoff_command, undefined);
      assert.equal(f.core.eventsSince(0).events.some(event => event.type === 'handoff_ready'), false);
      f.adapter.home = '/home/A';
      assert.equal(f.core.submit(f.req('handoff')).state, 'done');
    }
    assert.equal(f.state().incarnations.find(row => row.id === actualId).cli_home, '/home/A');
    assert.equal(f.state().handoff_command, buildHandoffCommand({ cwd: '/private/work', home: '/home/A',
      executablePath: f.adapter.executablePath, claudeSessionId: f.sid }));
  });
}
for (const field of ['cli_home', 'cli_path', 'cli_sha256']) {
  test(`R2 last executed ${field}=null cannot be replaced by planned resume metadata`, t => {
    const f = fixture(t); f.start(); const actualId = f.iid;
    assert.equal(f.core.submit(f.req('stop')).state, 'done');
    const original = f.state().incarnations[0][field];
    update(f, `UPDATE incarnations SET ${field}=NULL WHERE id=?`, actualId);
    resumeBeforeSpawn(f);
    assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
    assert.equal(f.state().handoff_command, undefined);
    update(f, `UPDATE incarnations SET ${field}=? WHERE id=?`, original, actualId);
    assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  });
}
for (const field of ['pid', 'pid_started_at']) {
  test(`R2 no committed spawn identity (${field} absent) rejects planned evidence`, t => {
    const f = fixture(t); f.start(); f.core.submit(f.req('stop'));
    const actualId = f.iid;
    update(f, `UPDATE incarnations SET ${field}=NULL WHERE id=?`, actualId);
    resumeBeforeSpawn(f);
    assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
    assert.equal(f.state().handoff_command, undefined);
  });
}
test('R2 newest actual execution with missing identity never falls back to older complete record', t => {
  const f = fixture(t); f.start(); f.core.submit(f.req('stop'));
  const resumed = f.core.submit(f.req('resume')); f.iid = resumed.incarnation_id;
  assert.equal(resumed.state, 'done'); f.core.submit(f.req('stop'));
  const original = f.state().incarnations.find(row => row.id === f.iid).cli_home;
  const actualId = f.iid;
  update(f, 'UPDATE incarnations SET cli_home=NULL WHERE id=?', actualId);
  resumeBeforeSpawn(f);
  assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
  assert.equal(f.state().handoff_command, undefined);
  update(f, 'UPDATE incarnations SET cli_home=? WHERE id=?', original, actualId);
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
});
test('R2 never_started state is not actual execution evidence even with pid metadata', t => {
  const f = fixture(t); f.start(); f.adapter.exit(f.iid);
  update(f, "UPDATE incarnations SET state='never_started' WHERE id=?", f.iid);
  assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_identity_unavailable');
  assert.equal(f.state().handoff_command, undefined);
});

const fish = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'fish')).find(file => {
  try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
});
const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-r2 ' $ `-"));
const executablePath = path.join(nativeDir, "record ' $ ` env");
test.before(() => {
  const compiled = spawnSync('/usr/bin/cc', [path.resolve(__dirname, 'fixtures/bin/handoff-env.c'), '-o', executablePath],
    { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
});
test.after(() => fs.rmSync(nativeDir, { recursive: true, force: true }));
const expectedEnv = { PATH: process.env.PATH, USER: "user ' $ ` spaced", LOGNAME: '', SHELL: '/bin/zsh',
  LANG: 'C', LC_ALL: 'C', LC_CTYPE: 'C', TMPDIR: nativeDir, TERM: 'xterm', HOME: "/home/recorded ' $ `" };
for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh', fish || 'fish']) {
  test(`R2 wrapped command runs identical cwd argv env in ${shell}`, { skip: shell === 'fish' ? 'fish is not installed' : false }, () => {
    const command = buildHandoffCommand({ cwd: nativeDir, home: expectedEnv.HOME, executablePath,
      claudeSessionId: '12345678-1234-4234-8234-123456789abc' });
    assert.ok(command.startsWith("/bin/sh -c '"), 'command must select POSIX shell explicitly');
    const received = spawnSync(shell, ['-c', command], { encoding: 'utf8', env: { ...expectedEnv,
      HOME: '/wrong/home', CLAUDECODE: 'nested', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '9', FOO_SECRET: 'secret' } });
    assert.equal(received.status, 0, received.stderr);
    const values = received.stdout.split('\0').slice(0, -1), envStart = values.indexOf('ENV');
    assert.equal(values.shift(), fs.realpathSync(nativeDir));
    assert.deepEqual(values.slice(0, envStart - 1), ['--resume', '12345678-1234-4234-8234-123456789abc']);
    const env = Object.fromEntries(values.slice(envStart).map(value => {
      const equal = value.indexOf('='); return [value.slice(0, equal), value.slice(equal + 1)];
    }));
    assert.deepEqual(env, expectedEnv);
  });
}
