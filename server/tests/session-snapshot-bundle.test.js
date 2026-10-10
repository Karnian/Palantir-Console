const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture } = require('./fixtures/session-snapshot/helpers.cjs');
const api = import('../../scripts/lib/sessionSnapshotBundle.mjs');
async function execute(f, request = f.request, extra = {}, overrides) {
  const m = await api;
  const bundle = m.buildBundle({ request, sourceOverrides: overrides });
  const result = await m.runExecutor({ target: f.target, bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env, ...extra });
  return { bundle, result, envelope: JSON.parse(result.stdout || 'null') };
}
function exactSnapshot(envelope) {
  assert.equal(envelope.sessions.length, 1);
  assert.equal(envelope.instructions.length, 1);
  assert.equal(envelope.instructions[0].text, 'Synthetic instruction A');
}
test('remote and local bytes, fixed argv, hash, permissions and atomic replacement', async t => {
  const f = fixture(t);
  const m = await api;
  const remote = await execute(f);
  exactSnapshot(remote.envelope);
  assert.equal(remote.envelope.reader_build, remote.bundle.readerBuild);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.env.FAKE_SSH_ARGV_LOG)),
    ['-o', 'BatchMode=yes', '--', 'synthetic@host', '/synthetic/node', '--no-warnings', '-']);
  const local = await execute(f, f.request, { target: { kind: 'local' } });
  assert.deepEqual(local.result.stdout, remote.result.stdout);
  assert.equal(m.receiveEnvelope(remote.result, { expectedKinds: ['snapshot'],
    expectedReaderBuild: remote.bundle.readerBuild }).ok, true);
  const file = m.writeSnapshotAtomic(f.out, remote.envelope);
  const bytes = fs.readFileSync(file);
  assert.equal(JSON.parse(bytes).instructions[0].text, 'Synthetic instruction A');
  m.writeSnapshotAtomic(f.out, local.envelope);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.out).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(f.out), [remote.envelope.machine.id + '.json']);
});
test('executor limits, failed outputs and stderr counting', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const mode of ['flood', 'hang', 'exit3', 'envelope_then_exit3', 'two_envelopes', 'garbage',
    'unsanitized', 'build_mismatch']) {
    const result = await m.runExecutor({ target: f.target, bundle: good.bundle,
      sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: { ...f.env, FAKE_SSH_MODE: mode },
      timeoutMs: mode === 'hang' ? 100 : 5000 });
    assert.equal(m.receiveEnvelope(result, { expectedKinds: ['snapshot', 'status'],
      expectedReaderBuild: good.bundle.readerBuild }).ok, false, mode);
    if (mode === 'envelope_then_exit3') {
      assert.deepEqual(result.stdout, good.result.stdout);
      assert.equal(result.exitCode, 3);
      assert.equal(m.receiveEnvelope({ ...result, exitCode: 0 }, { expectedKinds: ['snapshot'],
        expectedReaderBuild: good.bundle.readerBuild }).ok, true);
    }
    if (mode === 'flood') assert.equal(result.killedReason, 'stdout_limit');
    if (mode === 'hang') assert.equal(result.killedReason, 'timeout');
  }
  const noisy = await execute(f, f.request, { env: { ...f.env, FAKE_ORCA_STDERR: 'STDERR_SENTINEL' } });
  exactSnapshot(noisy.envelope);
  assert.equal(noisy.result.stderrBytes, 0);
  assert.equal(noisy.result.stdout.includes('STDERR_SENTINEL'), false);
});
test('actual launcher blocks warnings, synchronous errors and unhandled rejections', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const rejection of [false, true]) {
    const source = `module.exports = { ReaderError: class ReaderError extends Error {},
      runSnapshot: function explode() {
        process.emitWarning('EXCEPTION_SENTINEL');
        process.stderr.write('EXCEPTION_SENTINEL');
        ${rejection ? "Promise.reject(new Error('EXCEPTION_SENTINEL')); return {};"
    : "throw new Error('EXCEPTION_SENTINEL');"}
      } };`;
    const response = await execute(f, f.request, {}, { 'scripts/lib/sessionSnapshotReader.cjs': source });
    assert.equal(response.result.stderrBytes, 0);
    assert.equal(response.result.exitCode, 1);
    assert.equal(response.envelope.code, 'internal_error');
    assert.deepEqual(response.envelope.counts, {});
    assert.equal(response.result.stdout.includes('EXCEPTION_SENTINEL'), false);
    assert.equal(response.result.stdout.toString().split('\n').length, 2);
  }
});
test('manifest static closure and runtime closure are enforced', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const source of ["require('./outside')", 'require(variable)', "import('node:fs')",
    "process.binding('fs')", "module.require('node:fs')", "require('node:net')", "require('fs')"]) {
    assert.throws(() => m.buildBundle({ request: f.request,
      sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': source } }), { code: 'bundle_rejected' });
  }
  const marker = "var reader = require('./sessionSnapshotReader.cjs');";
  const position = good.bundle.code.lastIndexOf(marker);
  const tampered = good.bundle.code.slice(0, position) + "var reader = require('node:net');"
    + good.bundle.code.slice(position + marker.length);
  const result = await m.runExecutor({ target: f.target, bundle: tampered,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  assert.equal(JSON.parse(result.stdout).code, 'internal_error');
});
test('closed request, old Node, status validation, direct bare Orca guard and executor guard', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  assert.equal(fs.readFileSync(f.env.FAKE_ORCA_SPAWN_LOG, 'utf8').trim().split('\n').length, 2);
  const invalid = await execute(f, { ...f.request, unknown: true });
  assert.equal(invalid.envelope.code, 'request_invalid');
  const old = await execute(f, f.request, { env: { ...f.env,
    FAKE_SSH_PRELOAD: path.resolve(__dirname, 'fixtures/session-snapshot/old-node.cjs') } });
  assert.equal(old.envelope.code, 'node_unsupported');
  assert.equal(old.envelope.reader_build, old.bundle.readerBuild);
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin);
  const orca = path.join(bin, 'orca');
  fs.writeFileSync(orca, '#!' + process.execPath + '\n' +
    "const fs = require('node:fs'); fs.appendFileSync(process.env.BARE_ORCA_LOG, 'called\\n');\n" +
    "process.stdout.write('[]');\n", { mode: 0o700 });
  const log = path.join(f.root, 'bare-orca.log');
  const env = { ...f.env, PATH: bin + path.delimiter + f.env.PATH, BARE_ORCA_LOG: log };
  const unguarded = { ...env };
  delete unguarded.PALANTIR_BLOCK_REAL_SPAWN;
  delete unguarded.NODE_TEST_CONTEXT;
  const control = await execute(f, { ...f.request, orca_bin: 'orca' }, { env: unguarded });
  exactSnapshot(control.envelope);
  assert.equal(fs.readFileSync(log, 'utf8'), 'called\ncalled\n');
  fs.writeFileSync(log, '');
  const bare = await execute(f, { ...f.request, orca_bin: 'orca' }, { env });
  assert.equal(bare.envelope.coverage.orca.code, 'orca_unavailable');
  assert.equal(fs.readFileSync(log, 'utf8'), '');
  assert.equal(fs.readFileSync(f.env.FAKE_ORCA_SPAWN_LOG, 'utf8').trim().split('\n').length, 2);
  for (const envelope of [{ ...invalid.envelope, code: 'invented' },
    { ...invalid.envelope, counts: { invented: 1 } }]) {
    assert.equal(m.receiveEnvelope({ ...invalid.result, stdout: Buffer.from(JSON.stringify(envelope)) },
      { expectedKinds: ['status'], expectedReaderBuild: invalid.bundle.readerBuild }).ok, false);
  }
  let spawns = 0;
  function countedSpawn(...args) {
    spawns++;
    return require('node:child_process').spawn(...args);
  }
  const counted = await m.runExecutor({ target: f.target, bundle: good.bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env, spawnImpl: countedSpawn });
  assert.equal(counted.exitCode, 0);
  assert.equal(spawns, 1);
  spawns = 0;
  assert.throws(() => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: '/usr/bin/ssh',
    spawnImpl: countedSpawn }), { code: 'PALANTIR_SPAWN_BLOCKED' });
  assert.equal(spawns, 0);
});
test('remote write probe permits only config, lock and temporary config writes', async t => {
  const f = fixture(t);
  const log = path.join(f.root, 'writes.log');
  f.env.FAKE_SSH_PRELOAD = path.resolve(__dirname, 'fixtures/session-snapshot/write-probe.cjs');
  f.env.WRITE_PROBE_LOG = log;
  delete f.env.FAKE_ORCA_SPAWN_LOG;
  const response = await execute(f);
  exactSnapshot(response.envelope);
  const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(writes.filter(value => value === f.config).length, 1);
  const configWrites = writes;
  assert.ok(configWrites.length > 0);
  for (const value of configWrites) {
    assert.ok(value === path.dirname(f.config) || value === f.config || value === f.config + '.lock'
      || value.startsWith(f.config + '.'), value);
  }
  assert.equal(fs.existsSync(f.out), false);
  const before = fs.readFileSync(f.config);
  fs.writeFileSync(log, '');
  const preview = await execute(f, { ...f.request, op: 'exclude_query',
    target: { kind: 'session', provider: 'claude', sessionId: 's' } });
  assert.equal(preview.envelope.equiv_count, 1);
  assert.equal(fs.readFileSync(log, 'utf8'), '');
  assert.deepEqual(fs.readFileSync(f.config), before);
});

test('stdout already written is never followed by an exception envelope', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const m = await api;
  const bundle = m.buildBundle({ request: f.request, sourceOverrides: {
    'scripts/lib/sessionSnapshotReader.cjs': `process.stdout.write('{}\\n');
      throw new Error('AFTER_STDOUT_SENTINEL');`
  } });
  const result = await m.runExecutor({ target: f.target, bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout.toString(), '{}\n');
  assert.equal(result.stderrBytes, 0);
});
test('executor discards and counts ssh stderr and kills at injected small output limit', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const noisy = await execute(f, f.request, { env: { ...f.env, FAKE_SSH_STDERR: 'SSH_SENTINEL' } });
  exactSnapshot(noisy.envelope);
  assert.equal(noisy.result.stderrBytes, Buffer.byteLength('SSH_SENTINEL'));
  assert.equal(Object.hasOwn(noisy.result, 'stderr'), false);
  const m = await api;
  const limited = await m.runExecutor({ target: f.target, bundle: good.bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: { ...f.env, FAKE_SSH_MODE: 'flood' }, maxStdoutBytes: 32 });
  assert.equal(limited.killedReason, 'stdout_limit');
});
test('reader cannot bypass resolver through runtime closure or global require', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const expression of ["nativeRequire('node:net')", "globalThis['req' + 'uire']('node:net')",
    "Array.prototype.includes = function () { return true; }; const r = require; r('node:net')",
    'arguments.callee.caller']) {
    await t.test(expression, async () => {
      const source = expression + "; process.stdout.write(JSON.stringify('BYPASS_MARKER') + '\\n');";
      const bundle = m.buildBundle({ request: f.request,
        sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': source } });
      const result = await m.runExecutor({ target: f.target, bundle,
        sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
      assert.equal(JSON.parse(result.stdout).code, 'internal_error');
      assert.equal(result.exitCode, 1);
      assert.equal(result.stderrBytes, 0);
      assert.equal(result.stdout.includes('BYPASS_MARKER'), false);
    });
  }
});
test('reader compiled in global scope cannot see registry or bundle source variables', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const source = `process.stdout.write(JSON.stringify({ sources: typeof BUNDLE_SOURCES,
    registry: typeof registry, cache: typeof cache, native: typeof nativeRequire,
    globalModule: typeof globalThis.module, globalExports: typeof globalThis.exports,
    filename: typeof globalThis.__filename, dirname: typeof globalThis.__dirname,
    functionRequire: new Function('return typeof require')() }) + '\\n');`;
  const response = await execute(f, f.request, {}, { 'scripts/lib/sessionSnapshotReader.cjs': source });
  assert.deepEqual(response.envelope, { sources: 'undefined', registry: 'undefined', cache: 'undefined',
    native: 'undefined', globalModule: 'undefined', globalExports: 'undefined',
    filename: 'undefined', dirname: 'undefined', functionRequire: 'undefined' });
});
test('old Node rejects before compiling other manifest modules; modern compile errors stay silent', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const m = await api;
  const bundle = m.buildBundle({ request: f.request,
    sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': 'function broken( {' } });
  for (const old of [true, false]) {
    const env = { ...f.env };
    if (old) env.FAKE_SSH_PRELOAD = path.resolve(__dirname, 'fixtures/session-snapshot/old-node.cjs');
    const result = await m.runExecutor({ target: f.target, bundle,
      sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env });
    assert.equal(result.stderrBytes, 0);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.code, old ? 'node_unsupported' : 'internal_error');
    assert.equal(envelope.reader_build, bundle.readerBuild);
    assert.equal(envelope.machine_id, 'unknown');
    assert.deepEqual(envelope.counts, {});
    assert.equal(result.exitCode, old ? 0 : 1);
    assert.equal(result.stdout.toString().split('\n').length, 2);
  }
});
test('launcher hash encoding matches policy without loading other manifest modules', async t => {
  const f = fixture(t);
  const m = await api;
  const policy = require('../services/observeSnapshotPolicy.js');
  const launcher = require('../../scripts/lib/sessionSnapshotLauncher.cjs');
  const sources = Object.fromEntries(m.MANIFEST.map(name => [name,
    fs.readFileSync(path.resolve(__dirname, '../..', name), 'utf8')]));
  const records = m.MANIFEST.map(name => {
    const bytes = Buffer.from(sources[name]);
    return [name, bytes.length, bytes.toString('base64')];
  });
  const input = ['palantir.snapshot-bundle/1', ...records];
  assert.equal(JSON.stringify(input), policy.canonicalEncode(input));
  const expected = require('node:crypto').createHash('sha256').update(policy.canonicalEncode(input))
    .digest('hex').slice(0, 16);
  assert.equal(launcher.computeReaderBuild(sources), expected);
  const other = m.MANIFEST.filter(name => name !== 'scripts/lib/sessionSnapshotLauncher.cjs');
  const overrides = Object.fromEntries(other.map(name => [name, 'function broken( {']));
  const response = await execute(f, f.request, { env: { ...f.env,
    FAKE_SSH_PRELOAD: path.resolve(__dirname, 'fixtures/session-snapshot/old-node.cjs') } }, overrides);
  assert.equal(response.envelope.code, 'node_unsupported');
  assert.equal(response.envelope.reader_build, response.bundle.readerBuild);
  assert.equal(response.result.stderrBytes, 0);
});
test('launcher and runtime bootstrap contain only older Node compatible syntax', async t => {
  const f = fixture(t);
  const m = await api;
  const launcher = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/sessionSnapshotLauncher.cjs'), 'utf8');
  const overrides = Object.fromEntries(m.MANIFEST.map(name => [name, '']));
  const runtime = m.buildBundle({ request: f.request, sourceOverrides: overrides }).code;
  for (const source of [launcher, runtime]) {
    assert.doesNotMatch(source, /\?\?|\?\.|Object\.hasOwn|\bclass\b/);
    assert.doesNotThrow(() => new Function(source));
  }
  assert.match(runtime, /typeof globalThis !== 'undefined' \? globalThis : global/);
});
test('launcher errors never export a secret machine ID from observe.json', async t => {
  const f = fixture(t);
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const secret = 'ghp_' + 'Q'.repeat(40);
  fs.writeFileSync(f.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.config)), machine_id: secret }));
  const response = await execute(f);
  assert.equal(response.envelope.code, 'key_unavailable');
  assert.equal(response.envelope.machine_id, 'unknown');
  assert.equal(response.result.stdout.toString().split(secret).length - 1, 0);
  for (const [request, extra, overrides, code] of [
    [{ ...f.request, unknown: true }, {}, undefined, 'request_invalid'],
    [f.request, { env: { ...f.env,
      FAKE_SSH_PRELOAD: path.resolve(__dirname, 'fixtures/session-snapshot/old-node.cjs') } },
    undefined, 'node_unsupported'],
    [f.request, {}, { 'scripts/lib/sessionSnapshotReader.cjs': "throw new Error('failure');" }, 'internal_error']
  ]) {
    const failure = await execute(f, request, extra, overrides);
    assert.equal(failure.envelope.code, code);
    assert.equal(failure.envelope.machine_id, 'unknown');
    assert.equal(failure.result.stdout.includes(secret), false);
  }
});
test('executor resolves bare ssh using the spawn environment before guarding', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const outside = path.join(f.root, 'bin');
  fs.mkdirSync(outside);
  const name = path.basename(f.env.PALANTIR_OBSERVE_SSH_BIN);
  const executable = path.join(outside, name);
  fs.writeFileSync(executable, '#!' + process.execPath + '\n', { mode: 0o700 });
  let spawns = 0;
  const spawnImpl = () => { spawns++; throw new Error('spawn_should_not_run'); };
  const parentPath = process.env.PATH;
  t.after(() => { process.env.PATH = parentPath; });
  process.env.PATH = path.dirname(f.env.PALANTIR_OBSERVE_SSH_BIN);
  let spawnedCommand;
  const allowed = await m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: name,
    env: { ...f.env, PATH: process.env.PATH + path.delimiter + path.dirname(process.execPath) },
    spawnImpl: (command, ...args) => {
      spawns++;
      spawnedCommand = command;
      return require('node:child_process').spawn(command, ...args);
    } });
  assert.equal(allowed.exitCode, 0);
  assert.equal(spawns, 1);
  assert.equal(spawnedCommand, fs.realpathSync(f.env.PALANTIR_OBSERVE_SSH_BIN));
  spawns = 0;
  await assert.rejects(async () => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: name,
    env: { ...f.env, PATH: outside }, spawnImpl }), error => {
    assert.equal(error.code, 'PALANTIR_SPAWN_BLOCKED');
    assert.equal(error.details.resolvedCommand, fs.realpathSync(executable));
    return true;
  });
  assert.equal(spawns, 0);
  assert.throws(() => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: 'missing-ssh',
    env: { ...f.env, PATH: outside }, spawnImpl }), { code: 'ENOENT' });
  assert.equal(spawns, 0);
});
test('atomic snapshot collision preserves the temporary file owned by another writer', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const file = m.writeSnapshotAtomic(f.out, good.envelope);
  const before = fs.readFileSync(file);
  const time = 1234567890;
  const nonce = Buffer.alloc(8, 0x51);
  t.mock.method(Date, 'now', () => time);
  const random = t.mock.method(crypto, 'randomBytes', () => nonce);
  const prefix = '.' + good.envelope.machine.id + '-' + process.pid + '-';
  const collisions = [time, nonce.toString('hex')].map(suffix => path.join(f.out, prefix + suffix + '.tmp'));
  for (const collision of collisions) fs.writeFileSync(collision, 'other writer');
  assert.throws(() => m.writeSnapshotAtomic(f.out, good.envelope), { code: 'EEXIST' });
  for (const collision of collisions) assert.equal(fs.readFileSync(collision, 'utf8'), 'other writer');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(random.mock.calls.map(call => call.arguments), [[8]]);
});
test('atomic snapshot cleans its own failed write and does not unlink after a successful rename', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  const unlink = t.mock.method(fs, 'unlinkSync');
  const file = m.writeSnapshotAtomic(f.out, good.envelope);
  assert.equal(unlink.mock.callCount(), 0);
  const before = fs.readFileSync(file);
  const other = path.join(f.out, '.other-writer.tmp');
  fs.writeFileSync(other, 'other writer');
  let temporary;
  const rename = t.mock.method(fs, 'renameSync', source => {
    temporary = source;
    throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
  });
  assert.throws(() => m.writeSnapshotAtomic(f.out, good.envelope), { code: 'EACCES' });
  rename.mock.restore();
  assert.equal(fs.existsSync(temporary), false);
  assert.deepEqual(unlink.mock.calls.map(call => call.arguments), [[temporary]]);
  assert.equal(fs.readFileSync(other, 'utf8'), 'other writer');
  assert.deepEqual(fs.readFileSync(file), before);
});
test('Node 10 bootstrap without globalThis rejects before compiling modern reader source', async t => {
  const f = fixture(t);
  const m = await api;
  const bundle = m.buildBundle({ request: f.request,
    sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': 'function broken( {' } });
  // Delete during script execution: modern Node itself needs globalThis before evaluating stdin.
  const result = await m.runExecutor({ target: f.target, bundle: 'delete global.globalThis;\n' + bundle.code,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: { ...f.env,
      FAKE_SSH_PRELOAD: path.resolve(__dirname, 'fixtures/session-snapshot/old-node.cjs') } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrBytes, 0);
  assert.deepEqual(JSON.parse(result.stdout), { schema: 'palantir.snapshot-status/1', machine_id: 'unknown',
    reader_build: bundle.readerBuild, code: 'node_unsupported', counts: {} });
});
