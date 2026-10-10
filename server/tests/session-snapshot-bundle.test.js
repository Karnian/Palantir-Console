const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fixture, recordingSpawn, descendantProbe } = require('./fixtures/session-snapshot/helpers.cjs');
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
test('executor guard is looked up for each local and remote execution', async t => {
  const f = fixture(t);
  await api;
  const guard = require('../utils/spawnGuard.js');
  const original = guard.assertSpawnAllowed;
  const calls = [];
  t.after(() => { guard.assertSpawnAllowed = original; });
  guard.assertSpawnAllowed = options => { calls.push(options); return original(options); };
  for (const target of [{ kind: 'local' }, f.target]) {
    await t.test(target.kind, async () => {
      calls.length = 0;
      const extra = { target };
      if (target.kind === 'remote') {
        extra.sshBin = path.basename(f.env.PALANTIR_OBSERVE_SSH_BIN);
        extra.env = { ...f.env, PATH: path.dirname(f.env.PALANTIR_OBSERVE_SSH_BIN) + path.delimiter + f.env.PATH };
      }
      const response = await execute(f, f.request, extra);
      exactSnapshot(response.envelope);
      const command = target.kind === 'local' ? process.execPath : fs.realpathSync(f.env.PALANTIR_OBSERVE_SSH_BIN);
      assert.deepEqual(calls, [{ command, source: 'session-snapshot:executor' }]);
    });
  }
});
test('executor fallback and backstop settle killed streams', { timeout: 10000 }, async t => {
  const m = await api;
  for (const fallback of [true, false]) {
    await t.test(fallback ? 'group kill fallback' : 'missing pid and close backstop', async sub => {
      const child = new EventEmitter();
      for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
      child.stdin.resume();
      sub.after(() => { for (const name of ['stdin', 'stdout', 'stderr']) child[name].destroy(); });
      if (fallback) child.pid = 12345;
      const groupKill = sub.mock.method(process, 'kill', () => { throw new Error('synthetic group failure'); });
      const signals = [];
      child.kill = signal => {
        signals.push(signal);
        setImmediate(() => child.emit('close', null, signal));
        return true;
      };
      const timeoutMs = 20;
      const started = performance.now();
      const result = await m.runExecutor({ target: { kind: 'local' }, bundle: '', timeoutMs,
        spawnImpl: (_, __, options) => {
          assert.equal(options.detached, true);
          setImmediate(() => { child.stdout.write('partial'); child.stderr.write('discarded'); });
          return child;
        } });
      assert.ok(performance.now() - started <= timeoutMs + 3000);
      assert.deepEqual(result, { exitCode: null, signal: 'SIGKILL', stdout: Buffer.from('partial'),
        stderrBytes: 9, killedReason: 'timeout' });
      assert.ok(['stdin', 'stdout', 'stderr'].every(name => child[name].destroyed));
      assert.deepEqual(groupKill.mock.calls.map(call => call.arguments), fallback ? [[-12345, 'SIGKILL']] : []);
      assert.deepEqual(signals, fallback ? ['SIGKILL'] : []);
      child.emit('close', 0, null);
      child.emit('error', new Error('late child error'));
    });
  }
});
test('executor timeout terminates inherited-pipe descendants', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const probe = descendantProbe(t, f.root);
  const m = await api;
  const bundle = m.buildBundle({ request: f.request });
  const timeoutMs = 1000;
  const started = performance.now();
  const pending = m.runExecutor({ target: f.target, bundle, timeoutMs,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: { ...f.env, FAKE_SSH_MODE: 'hang_descendant',
      FAKE_SSH_DESCENDANT_PID: probe.pidFile } });
  const pid = await probe.readPid();
  const result = await pending;
  if (t.signal.aborted) return;
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs <= timeoutMs + 3000, String(elapsedMs));
  assert.equal(result.killedReason, 'timeout');
  assert.equal(m.receiveEnvelope(result, { expectedKinds: ['snapshot'],
    expectedReaderBuild: bundle.readerBuild }).ok, false);
  await probe.waitForExit();
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  t.diagnostic(JSON.stringify({ elapsedMs, descendantExited: true }));
});
test('large remote snapshot flushes its complete envelope before launcher exit', async t => {
  const f = fixture(t);
  const m = await api;
  const sessionCount = 2;
  const instructionsPerSession = 200;
  const count = sessionCount * instructionsPerSession;
  const filename = path.join(f.home, '.claude/projects/s.jsonl');
  const template = JSON.parse(fs.readFileSync(filename, 'utf8'));
  fs.unlinkSync(filename);
  const rows = [];
  for (let session = 0; session < sessionCount; session++) {
    const sessionId = 'flush-' + session;
    const sessionRows = Array.from({ length: instructionsPerSession }, (_, offset) => {
      const index = session * instructionsPerSession + offset;
      return { ...template, sessionId, uuid: 'u' + index,
        message: { content: 'Synthetic instruction ' + index + ': ' + 'a '.repeat(850) } };
    });
    rows.push(...sessionRows);
    fs.writeFileSync(path.join(path.dirname(filename), sessionId + '.jsonl'),
      sessionRows.map(JSON.stringify).join('\n') + '\n');
  }
  const bundle = m.buildBundle({ request: f.request });
  const result = await m.runExecutor({ target: f.target, bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  t.diagnostic(JSON.stringify({ remoteStdoutBytes: result.stdout.length, expectedInstructions: count }));
  assert.ok(result.stdout.length >= 512 * 1024);
  const received = m.receiveEnvelope(result, { expectedKinds: ['snapshot'],
    expectedReaderBuild: bundle.readerBuild });
  assert.equal(received.ok, true, received.reason);
  assert.equal(received.envelope.sessions.length, sessionCount);
  assert.ok(received.envelope.sessions.every(session => session.instruction_count === instructionsPerSession));
  assert.equal(received.envelope.coverage.claude.records_unverified, 0);
  assert.equal(received.envelope.instructions.length, count);
  assert.deepEqual(received.envelope.instructions.map(item => item.text), rows.map(row => row.message.content));
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
  assert.notEqual(position, -1);
  const replacement = JSON.stringify("require('node:net');\n" +
    "process.stdout.write('IMPORT_OK\\n'); process.exit(0);").slice(1, -1);
  const tampered = good.bundle.code.slice(0, position) + replacement
    + good.bundle.code.slice(position + marker.length);
  const result = await m.runExecutor({ target: f.target, bundle: tampered,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  assert.equal(result.stdout.toString().split('IMPORT_OK').length - 1, 0, result.stdout.toString());
  assert.equal(JSON.parse(result.stdout).code, 'internal_error');
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderrBytes, 0);
});
test('manifest rejects every import token while current sources remain valid', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const source of ["import /* c */ ('node:net')", "import\n('node:net')", 'import.meta']) {
    await t.test(source, () => {
      assert.throws(() => m.buildBundle({ request: f.request,
        sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': source } }), { code: 'bundle_rejected' });
    });
  }
});
test('manifest word rules reject commented calls and require aliases while permitting prose', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  assert.doesNotThrow(() => m.buildBundle({ request: f.request,
    sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': '// we require charset detection' } }));
  for (const source of ["process /* c */ .binding('natives')", "process/**/.dlopen(m, '/x.node')",
    'require /* c */ (name)', "require\n('node:fs')", 'const r = require;', "require.resolve('x')",
    "const r = require\nr('node:net')", "const r = require\r\nr('node:net')",
    "module.require('node:fs')", "x.require('node:fs')"]) {
    await t.test(source, () => {
      assert.throws(() => m.buildBundle({ request: f.request,
        sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': source } }), { code: 'bundle_rejected' });
    });
  }
});
test('manifest rejects additional builtin and native loading tokens', async t => {
  const f = fixture(t);
  const m = await api;
  const good = await execute(f);
  exactSnapshot(good.envelope);
  for (const source of ["process.getBuiltinModule('node:net')",
    "const createRequire = function () {};", "process.dlopen(module, '/synthetic/native.node')"]) {
    await t.test(source, () => {
      assert.throws(() => m.buildBundle({ request: f.request,
        sourceOverrides: { 'scripts/lib/sessionSnapshotReader.cjs': source } }), { code: 'bundle_rejected' });
    });
  }
});
test('runtime removes builtin lookup before compiling manifest modules', async t => {
  const f = fixture(t);
  const source = "process['getBuiltin' + 'Module']('node:net'); " +
    "process.stdout.write(JSON.stringify('BYPASS_MARKER') + '\\n');";
  const response = await execute(f, f.request, {}, { 'scripts/lib/sessionSnapshotReader.cjs': source });
  assert.equal(response.envelope.code, 'internal_error');
  assert.equal(response.result.exitCode, 1);
  assert.equal(response.result.stderrBytes, 0);
  assert.equal(response.result.stdout.includes('BYPASS_MARKER'), false);
});
test('closed request, simulated old major, status validation, bare Orca and executor guards', async t => {
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
  const denied = recordingSpawn(t);
  await assert.rejects(async () => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: '/usr/bin/ssh',
    env: f.env, spawnImpl: denied.spawnImpl }), { code: 'PALANTIR_SPAWN_BLOCKED' });
  assert.equal(denied.calls.length, 0);
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
      || path.dirname(value) === path.dirname(f.config)
        && /^observe\.json\.tmp-[0-9a-f]{16}$/.test(path.basename(value)), value);
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
    "Array.prototype.includes = function () { return true; }; const r = arguments[2]; r('node:net')",
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
    functionRequire: new Function('return typeof req' + 'uire')() }) + '\\n');`;
  const response = await execute(f, f.request, {}, { 'scripts/lib/sessionSnapshotReader.cjs': source });
  assert.deepEqual(response.envelope, { sources: 'undefined', registry: 'undefined', cache: 'undefined',
    native: 'undefined', globalModule: 'undefined', globalExports: 'undefined',
    filename: 'undefined', dirname: 'undefined', functionRequire: 'undefined' });
});
test('simulated old major rejects before compiling other modules; modern compile errors stay silent', async t => {
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
  const denied = recordingSpawn(t);
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
  await assert.rejects(async () => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: name,
    env: { ...f.env, PATH: outside }, spawnImpl: denied.spawnImpl }), error => {
    assert.equal(error.code, 'PALANTIR_SPAWN_BLOCKED');
    assert.equal(error.details.resolvedCommand, fs.realpathSync(executable));
    return true;
  });
  assert.equal(denied.calls.length, 0);
  assert.throws(() => m.runExecutor({ target: f.target, bundle: good.bundle, sshBin: 'missing-ssh',
    env: { ...f.env, PATH: outside }, spawnImpl: denied.spawnImpl }), { code: 'ENOENT' });
  assert.equal(denied.calls.length, 0);
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
test('simulated old major without globalThis rejects before compiling modern reader source', async t => {
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

test('PR1c B labels initialize and update config once; repeated and absent labels write nothing', async t => {
  const f = fixture(t);
  const log = path.join(f.root, 'label-writes.log');
  f.env.FAKE_SSH_PRELOAD = path.resolve(__dirname, 'fixtures/session-snapshot/write-probe.cjs');
  f.env.WRITE_PROBE_LOG = log;
  delete f.env.FAKE_ORCA_SPAWN_LOG;
  const initial = await execute(f, { ...f.request, machine_label: 'Mac' });
  exactSnapshot(initial.envelope);
  assert.equal(initial.envelope.machine.label, 'Mac');
  const before = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  fs.writeFileSync(log, '');
  const updated = await execute(f, { ...f.request, machine_label: 'codev2' });
  assert.equal(updated.envelope.machine.label, 'codev2');
  const after = JSON.parse(fs.readFileSync(f.config, 'utf8'));
  assert.equal(after.machine_label, 'codev2');
  after.machine_label = before.machine_label;
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(writes.filter(value => value === f.config).length, 1);
  assert.ok(writes.includes(f.config + '.lock'));
  const bytes = fs.readFileSync(f.config);
  for (const request of [{ ...f.request, machine_label: 'codev2' }, f.request]) {
    fs.writeFileSync(log, '');
    const same = await execute(f, request);
    assert.equal(same.envelope.machine.label, 'codev2');
    assert.equal(fs.readFileSync(log, 'utf8'), '');
    assert.deepEqual(fs.readFileSync(f.config), bytes);
  }
});

test('PR1c B direct invalid labels and labels on exclusion requests are rejected before reader execution', async t => {
  const f = fixture(t);
  const valid = await execute(f, { ...f.request, machine_label: 'codev2' });
  assert.equal(valid.envelope.machine.label, 'codev2');
  const before = fs.readFileSync(f.config);
  const probe = { 'scripts/lib/sessionSnapshotReader.cjs': "throw new Error('READER_SHOULD_NOT_RUN');" };
  for (const label of ['a b', '-x', 'x'.repeat(33), '', null, 42]) {
    const result = await execute(f, { ...f.request, machine_label: label }, {}, probe);
    assert.equal(result.envelope.code, 'request_invalid');
    assert.deepEqual(fs.readFileSync(f.config), before);
  }
  for (const op of ['exclude_query', 'exclude_commit']) {
    const request = { ...f.request, op, machine_label: 'codev2',
      target: { kind: 'session', provider: 'claude', sessionId: 's' } };
    if (op === 'exclude_commit') request.token = '0'.repeat(64);
    const result = await execute(f, request, {}, probe);
    assert.equal(result.envelope.code, 'request_invalid');
  }
});

test('PR1c D fake Orca executes actual envelopes through the bundle and projects topology links', async t => {
  const f = fixture(t);
  const { envelope } = await execute(f);
  exactSnapshot(envelope);
  assert.deepEqual(envelope.coverage.orca, { state: 'ok', code: null });
  assert.equal(envelope.orca.worktrees.length, 1);
  assert.equal(envelope.orca.terminals.length, 1);
  assert.equal(envelope.orca.worktrees[0].live_terminals, 1);
  assert.equal(envelope.orca.worktrees[0].last_activity_at, '2026-10-08T02:00:00.000Z');
  assert.equal(envelope.orca.terminals[0].last_output_at, '2026-10-08T02:00:00.000Z');
  assert.equal(envelope.sessions[0].orca_link.confirmed, true);
  assert.equal(envelope.sessions[0].orca_link.pane_key, 'fixture-tab:fixture-leaf');
  assert.equal(envelope.sessions[0].orca_link.terminal_handle, 'term_fixture');
  assert.equal(JSON.stringify(envelope).includes('FAKE_ORCA_PRIVATE_TEXT'), false);
});
