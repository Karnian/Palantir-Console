'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');
const { buildHandoffCommand } = require('../sessionHost/handoffCommand');
const { buildChildEnv } = require('../sessionHost/spawnEnv');
const dirtyKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'PALANTIR_TOKEN', 'FOO_SECRET'];
const allowedKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TERM'];
const id = '12345678-1234-4234-8234-123456789abc';
const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-native-'));
const nativeExecutable = path.join(nativeDir, 'handoff-env');
test.before(() => {
  const result = spawnSync('/usr/bin/cc', [path.resolve(__dirname, 'fixtures/bin/handoff-env.c'), '-o', nativeExecutable],
    { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test.after(() => fs.rmSync(nativeDir, { recursive: true, force: true }));
function capture(result) {
  assert.equal(result.status, 0, result.stderr);
  const tokens = result.stdout.split('\0').slice(0, -1);
  const cwd = tokens.shift(), index = tokens.indexOf('ENV');
  return { cwd, argv: tokens.slice(0, index), env: Object.fromEntries(tokens.slice(index + 1).map(value => {
    const equal = value.indexOf('='); return [value.slice(0, equal), value.slice(equal + 1)];
  })) };
}


for (const point of ['after_control_accept_before_reply', 'after_close_sent']) {
  for (const tampered of [false, true]) test(`R1 recovery ${point} tampered=${tampered}`, t => {
    const f = fixture(t);
    const executablePath = path.join(f.dir, 'bundled-claude');
    fs.writeFileSync(executablePath, 'pinned executable bytes');
    const executableSha256 = require('node:crypto').createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
    const verifier = require('../sessionHost/sdkAdapter').createSdkAdapter({ sdk: {}, executablePath, executableSha256 });
    f.adapter.executablePath = fs.realpathSync(executablePath);
    f.adapter.executableSha256 = executableSha256;
    f.adapter.verifyExecutable = verifier.verifyExecutable;
    f.start(); f.faults.arm(point);
    const request = f.req('handoff');
    assert.throws(() => f.core.submit(request), SimulatedCrash);
    f.probe.exit(f.iid);
    if (tampered) fs.writeFileSync(executablePath, 'tampered executable bytes');
    f.reboot().recover();
    assert.equal(f.core.lookup(request.request_key).state, tampered ? 'failed' : 'done');
    assert.equal(f.state().session.state, tampered ? 'active' : 'handed_off');
    if (tampered) {
      assert.equal(f.core.lookup(request.request_key).reason, 'executable_hash_mismatch');
      assert.equal(f.state().handoff_command, undefined);
      assert.equal(f.core.eventsSince(0).events.filter(event => event.type === 'handoff_ready').length, 0);
    } else assert.ok(f.state().handoff_command);
    assert.equal(f.adapter.log.closes.length, 0); assert.equal(f.adapter.log.signals.length, 0);
  });
}

for (const [field, value, code] of [['home', '/home/B', 'handoff_environment_mismatch'],
  ['executablePath', '/other/claude', 'handoff_environment_mismatch'],
  ['executableSha256', 'b'.repeat(64), 'executable_hash_mismatch']]) {
  test(`R1 persisted execution identity rejects changed ${field} after host loss`, t => {
    const f = fixture(t); f.start();
    const original = f.adapter[field];
    f.adapter[field] = value; f.probe.exit(f.iid); f.reboot().recover();
    assert.equal(f.core.submit(f.req('handoff')).reason, code);
    assert.equal(f.state().session.state, 'active'); assert.equal(f.state().handoff_command, undefined);
    f.adapter[field] = original;
    assert.equal(f.core.submit(f.req('handoff')).state, 'done');
  });
}

test('R1 execution HOME/path/hash are durable and scrubbed on deletion', t => {
  const f = fixture(t); f.start();
  let incarnation = f.state().incarnations[0];
  assert.equal(incarnation.cli_home, f.adapter.home);
  assert.equal(incarnation.cli_path, f.adapter.executablePath);
  assert.match(incarnation.cli_sha256, /^[a-f0-9]{64}$/);
  f.probe.exit(f.iid); f.reboot().recover();
  assert.equal(f.state().incarnations[0].cli_home, f.adapter.home);
  f.core.submit(f.req('handoff')); f.core.submit(f.req('delete'));
  incarnation = f.core.snapshot(f.sid).state;
  assert.equal(incarnation.handoff_command, undefined);
});

test('R1 close-time tampering and blocked retry cannot publish a command', t => {
  const f = fixture(t, { noExit: true }); f.start();
  const control = f.core.submit(f.req('handoff'));
  f.adapter.options.executableValid = false; f.adapter.exit(f.iid);
  assert.equal(f.core.lookup(control.request_key).reason, 'executable_hash_mismatch');
  assert.equal(f.state().handoff_command, undefined);
  f.adapter.options.executableValid = true;
  f.probe.descendants.set(f.iid, { status: 'ok', pids: [{ pid: 45, startedAt: 'x' }] });
  assert.equal(f.core.submit(f.req('handoff')).state, 'blocked');
  f.probe.descendants.delete(f.iid); f.adapter.options.executableValid = false;
  assert.equal(f.core.submit(f.req('handoff')).reason, 'executable_hash_mismatch');
  assert.equal(f.state().handoff_command, undefined);
  f.adapter.options.executableValid = true;
  assert.equal(f.core.submit(f.req('handoff')).state, 'done');
});

for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
  for (const empty of [false, true]) test(`R1 independent pollution and optional expansions ${shell} empty=${empty}`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-r1 ' $ `-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const executablePath = nativeExecutable;
    const clean = { PATH: process.env.PATH, HOME: '/home/recorded', USER: empty ? '' : "user ' $ ` space",
      LANG: 'C', TERM: 'xterm' };
    const parent = { ...clean, HOME: '/parent/home', ...Object.fromEntries(dirtyKeys.map(key => [key, 'dirty'])) };
    const command = buildHandoffCommand({ cwd: dir, home: clean.HOME, executablePath, claudeSessionId: id });
    const result = spawnSync(shell, ['-c', 'unset LOGNAME SHELL LC_ALL LC_CTYPE TMPDIR; ' + command], { encoding: 'utf8', env: parent });
    assert.equal(result.status, 0, result.stderr);
    const received = capture(result);
    assert.equal(received.cwd, fs.realpathSync(dir)); assert.deepEqual(received.argv, ['--resume', id]);
    for (const key of dirtyKeys) assert.equal(received.env[key], undefined, key);
    assert.ok(Object.keys(received.env).every(key => allowedKeys.includes(key)), JSON.stringify(received.env));
    assert.deepEqual(received.env, clean);
    const hostEnv = buildChildEnv({ baseEnv: { ...parent, HOME: clean.HOME }, incarnationId: id,
      sdkEnv: { CLAUDE_AGENT_SDK_VERSION: 'fake', CLAUDE_CODE_ENTRYPOINT: 'sdk', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' } });
    for (const key of ['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE',
      'PALANTIR_OWNED_INCARNATION']) delete hostEnv[key];
    assert.deepEqual(Object.keys(received.env).sort(), Object.keys(hostEnv).sort());
    assert.deepEqual(received.env, { ...hostEnv });
  });
}

test('R1 schema v3 migration leaves old identity unknown and refuses handoff without guessing', t => {
  const Database = require('better-sqlite3');
  const f = fixture(t); f.start(); f.probe.exit(f.iid); f.core.close();
  const db = new Database(f.dbPath);
  db.exec('ALTER TABLE incarnations DROP COLUMN cli_home; DELETE FROM host_schema_versions WHERE version=4;');
  db.close(); f.reboot().recover();
  const migrated = new Database(f.dbPath);
  assert.equal(migrated.prepare('SELECT MAX(version) v FROM host_schema_versions').get().v, 4);
  assert.equal(migrated.prepare('SELECT cli_home FROM incarnations').get().cli_home, null);
  migrated.close();
  assert.equal(f.core.submit(f.req('handoff')).reason, 'handoff_environment_mismatch');
  assert.equal(f.state().handoff_command, undefined);
});

for (const execution of ['alive', 'orphaned', 'exited', 'never_started']) {
  test(`R1 core handoff supports recorded ${execution} incarnation`, t => {
    const f = fixture(t); f.start();
    if (execution === 'orphaned') f.reboot().recover();
    if (['exited', 'never_started'].includes(execution)) f.adapter.exit(f.iid);
    if (execution === 'never_started') {
      const Database = require('better-sqlite3'), db = new Database(f.dbPath);
      db.prepare("UPDATE incarnations SET state='never_started' WHERE id=?").run(f.iid); db.close();
    }
    assert.equal(f.core.submit(f.req('handoff')).state, 'done');
    assert.ok(f.state().handoff_command);
  });
}

test('R1 actual SDK fake child spawn environment matches native handoff environment', async t => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-sdk-home-'));
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previousHome; fs.rmSync(home, { recursive: true, force: true }); });
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const { fixture: sdkFixture } = require('./helpers/session-host-sdk');
  const f = await sdkFixture(t, sdk);
  assert.equal((await f.start()).state, 'done');
  const hostEnv = { ...f.spawns[0].opts.env };
  const parent = { ...hostEnv, ...Object.fromEntries(dirtyKeys.map(key => [key, 'dirty'])) };
  const command = buildHandoffCommand({ cwd: f.dir, home: hostEnv.HOME,
    executablePath: nativeExecutable, claudeSessionId: id });
  const received = capture(spawnSync('/bin/sh', ['-c', 'unset USER LOGNAME SHELL LANG LC_ALL LC_CTYPE TMPDIR TERM; ' + command],
    { encoding: 'utf8', env: parent }));
  for (const key of ['CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE',
    'PALANTIR_OWNED_INCARNATION']) delete hostEnv[key];
  assert.deepEqual(received.env, hostEnv);
  assert.ok(f.log().some(row => row.type === 'spawn'));
  await f.exit();
});
