const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, capture, recordingSpawn, NOW } = require('./fixtures/session-snapshot/helpers.cjs');
const api = import('../../scripts/lib/sessionSnapshotBundle.mjs');
const cli = import('../../scripts/session-snapshot.mjs');
function args(f, extra = []) {
  return ['remote', '--host', 'synthetic@host', 'snapshot', '--now', NOW,
    '--out-dir', f.out, '--orca-bin', f.request.orca_bin, ...extra];
}
async function invoke(f, argv, input = '', env = f.env, executorSpawn) {
  const io = capture(input, executorSpawn);
  const code = await (await cli).main(argv, { ...io, env });
  return { ...io, code };
}
async function initialize(f) {
  const result = await invoke(f, args(f));
  assert.equal(result.code, 0, result.errors());
  assert.equal(result.spawns(), 1);
  const file = path.join(f.out, fs.readdirSync(f.out)[0]);
  const bytes = fs.readFileSync(file);
  const snapshot = JSON.parse(bytes);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'Synthetic instruction A');
  return { file, bytes, snapshot };
}
async function operation(f, request, overrides) {
  const m = await api;
  const bundle = m.buildBundle({ request, sourceOverrides: overrides });
  const result = await m.runExecutor({ target: f.target, bundle,
    sshBin: f.env.PALANTIR_OBSERVE_SSH_BIN, env: f.env });
  assert.equal(result.exitCode, 0);
  return JSON.parse(result.stdout);
}
function exclusionArgs(f) {
  return ['remote', '--host', 'synthetic@host', 'exclude', '--session', 'claude:s',
    '--now', NOW, '--orca-bin', f.request.orca_bin];
}
test('CLI writes a snapshot and preserves exact existing bytes on every rejected response', async t => {
  const f = fixture(t);
  const initial = await initialize(f);
  for (const mode of ['flood', 'exit3', 'envelope_then_exit3', 'two_envelopes', 'garbage', 'unsanitized',
    'build_mismatch', 'status_bad_code', 'status_bad_counts']) {
    const result = await invoke(f, args(f), '', { ...f.env, FAKE_SSH_MODE: mode });
    assert.equal(result.code, 1, mode);
    assert.equal((result.output() + result.errors()).includes('UNTRUSTED_SENTINEL'), false);
    assert.deepEqual(fs.readFileSync(initial.file), initial.bytes);
    assert.deepEqual(fs.readdirSync(f.out), [path.basename(initial.file)]);
  }
  const noisy = await invoke(f, args(f), '', { ...f.env, FAKE_ORCA_STDERR: 'ORCA_SENTINEL' });
  assert.equal(noisy.code, 0);
  assert.equal((noisy.output() + noisy.errors()).includes('ORCA_SENTINEL'), false);
  assert.equal(noisy.output().includes('Synthetic instruction A'), false);
});
test('Mac validation and Orca guard reject before spawn; target metacharacters remain request data', async t => {
  const f = fixture(t);
  await initialize(f);
  const denied = recordingSpawn(t);
  for (const host of ['-oProxyCommand=x', 'space host', 'a;b', '']) {
    const result = await invoke(f, ['remote', '--host', host, 'snapshot', '--out-dir', f.out,
      '--orca-bin', f.request.orca_bin], '', f.env, denied.spawnImpl);
    assert.equal(result.code, 2);
    assert.equal(result.spawns(), 0);
  }
  for (const node of ['relative/node', '/$(x)']) {
    const result = await invoke(f, [...args(f), '--remote-node', node], '', f.env, denied.spawnImpl);
    assert.equal(result.code, 2);
    assert.equal(result.spawns(), 0);
  }
  for (const argv of [['snapshot'], [...args(f), '--now', 'bad'],
    ['snapshot', '--now', NOW, '--out-dir', f.out, '--orca-bin', '/bin/true']]) {
    const before = fs.readFileSync(f.env.FAKE_ORCA_SPAWN_LOG);
    const result = await invoke(f, argv, '', f.env, denied.spawnImpl);
    assert.equal(result.code, 2);
    assert.equal(result.spawns(), 0);
    if (argv.includes('/bin/true')) assert.equal(result.errors(), 'PALANTIR_SPAWN_BLOCKED\n');
    assert.deepEqual(fs.readFileSync(f.env.FAKE_ORCA_SPAWN_LOG), before);
  }
  assert.equal(denied.calls.length, 0);
  const malicious = 'claude:s;"$(x)';
  const argv = exclusionArgs(f);
  argv[argv.indexOf('claude:s')] = malicious;
  const result = await invoke(f, argv, 'yes\n');
  assert.equal(result.code, 1);
  assert.equal(result.spawns(), 1);
  assert.match(result.output(), /request_invalid/);
  assert.equal(fs.readFileSync(f.env.FAKE_SSH_ARGV_LOG, 'utf8').includes(malicious), false);
});
test('CLI entrypoint propagates invalid input exit status and writes a real fixture snapshot', async t => {
  const f = fixture(t);
  const entrypoint = path.resolve(__dirname, '../../scripts/session-snapshot.mjs');
  const invalid = spawnSync(process.execPath, [entrypoint, 'remote', '--host', '-bad', 'snapshot',
    '--now', NOW, '--out-dir', f.out, '--orca-bin', f.request.orca_bin], { env: f.env, encoding: 'utf8' });
  assert.equal(invalid.error, undefined);
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'request_invalid\n');
  assert.equal(fs.existsSync(f.out), false);
  const valid = spawnSync(process.execPath, [entrypoint, ...args(f)], { env: f.env, encoding: 'utf8' });
  assert.equal(valid.error, undefined);
  assert.equal(valid.status, 0, valid.stderr);
  const files = fs.readdirSync(f.out);
  assert.equal(files.length, 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.out, files[0])));
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'Synthetic instruction A');
});
test('exclude query is read only, default No never spawns commit, yes registers once', async t => {
  const f = fixture(t);
  await initialize(f);
  const original = fs.readFileSync(f.config);
  assert.deepEqual(JSON.parse(original).exclude.sessions, []);
  for (const answer of ['\n', '', 'n\n']) {
    const result = await invoke(f, exclusionArgs(f), answer);
    assert.equal(result.code, 1);
    assert.equal(result.spawns(), 1);
    assert.match(result.output(), /equiv_count: 1/);
    assert.deepEqual(fs.readFileSync(f.config), original);
  }
  const accepted = await invoke(f, exclusionArgs(f), 'YES\n');
  assert.equal(accepted.code, 0);
  assert.equal(accepted.spawns(), 2);
  assert.match(accepted.output(), /스냅샷을 다시 생성하세요/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).exclude.sessions, ['claude:s']);
  const after = fs.readFileSync(f.config);
  const repeat = await invoke(f, exclusionArgs(f), 'y\n');
  assert.equal(repeat.code, 0);
  assert.match(repeat.output(), /"registered":0/);
  assert.deepEqual(fs.readFileSync(f.config), after);
});
test('confirmation binds source, build, machine and target; missing keys never regenerate', async t => {
  const f = fixture(t);
  const initial = await initialize(f);
  const instruction = initial.snapshot.instructions[0];
  const target = { kind: 'instruction', instrId: instruction.id, ref: instruction.ref };
  const query = { ...f.request, op: 'exclude_query', target };
  const preview = await operation(f, query);
  assert.equal(preview.preview, 'Synthetic instruction A');
  assert.equal(preview.equiv_count, 1);
  const original = fs.readFileSync(f.config);
  const commit = { ...query, op: 'exclude_commit', token: preview.token };
  f.write('Synthetic instruction B');
  assert.equal((await operation(f, commit)).code, 'confirm_mismatch');
  assert.deepEqual(fs.readFileSync(f.config), original);
  f.write();
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/sessionSnapshotReader.cjs'), 'utf8');
  assert.equal((await operation(f, commit, { 'scripts/lib/sessionSnapshotReader.cjs': source + ' ' })).code,
    'confirm_mismatch');
  assert.deepEqual(fs.readFileSync(f.config), original);
  assert.equal((await operation(f, { ...commit, target: { kind: 'session', provider: 'claude', sessionId: 's' } }))
    .code, 'confirm_mismatch');
  for (const change of [{ machine_id: 'other_machine' }, { local_key: undefined }, { key_fingerprint: 'bad' }]) {
    fs.writeFileSync(f.config, JSON.stringify({ ...JSON.parse(original), ...change }));
    const before = fs.readFileSync(f.config);
    const status = await operation(f, commit);
    assert.equal(status.code, change.machine_id ? 'confirm_mismatch' : 'key_unavailable');
    assert.deepEqual(fs.readFileSync(f.config), before);
  }
  fs.writeFileSync(f.config, original);
  const committed = await operation(f, commit);
  assert.equal(committed.counts.registered, 1);
  assert.equal(committed.machine_id, initial.snapshot.machine.id);
  const after = fs.readFileSync(f.config);
  assert.equal(JSON.parse(after).exclude.instructions.length, 1);
  assert.equal((await operation(f, commit)).counts.registered, 0);
  assert.deepEqual(fs.readFileSync(f.config), after);
});
test('ordinal rewrite before query produces target_changed', async t => {
  const f = fixture(t);
  const filename = path.join(f.home, '.codex/sessions/s.jsonl');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  function write(messages) {
    const timestamp = '2026-10-08T02:00:00.000Z';
    const rows = [{ type: 'session_meta', timestamp,
      payload: { id: 'c', cwd: '/synthetic', source: 'cli', thread_source: 'user' } }];
    rows.push(...messages.map(text => ({ type: 'response_item', timestamp,
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })));
    fs.writeFileSync(filename, rows.map(JSON.stringify).join('\n'));
  }
  write(['A', 'B', 'C']);
  const result = await invoke(f, args(f));
  assert.equal(result.code, 0);
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.out, fs.readdirSync(f.out)[0])));
  assert.deepEqual(snapshot.instructions.filter(item => item.id.startsWith('codex:')).map(item => item.text),
    ['A', 'B', 'C']);
  const instruction = snapshot.instructions.find(item => item.text === 'B');
  const original = fs.readFileSync(f.config);
  write(['A', 'C']);
  assert.equal((await operation(f, { ...f.request, op: 'exclude_query',
    target: { kind: 'instruction', instrId: instruction.id, ref: instruction.ref } })).code, 'target_changed');
  assert.deepEqual(fs.readFileSync(f.config), original);
});
test('concurrent exclusion preserves rules and held lock returns config_busy', async t => {
  const f = fixture(t);
  const initial = await initialize(f);
  const query = { ...f.request, op: 'exclude_query', target: { kind: 'session', provider: 'claude', sessionId: 's' } };
  const preview = await operation(f, query);
  assert.equal(preview.equiv_count, 1);
  const commit = { ...query, op: 'exclude_commit', token: preview.token };
  const original = JSON.parse(fs.readFileSync(f.config));
  original.exclude.sessions.push('claude:existing');
  fs.writeFileSync(f.config, JSON.stringify(original));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).exclude.sessions, ['claude:existing']);
  fs.writeFileSync(f.config + '.lock', 'synthetic lock');
  assert.equal((await operation(f, commit)).code, 'config_busy');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)).exclude.sessions, ['claude:existing']);
  fs.unlinkSync(f.config + '.lock');
  const item = initial.snapshot.instructions[0];
  const otherQuery = { ...query, target: { kind: 'instruction', instrId: item.id, ref: item.ref } };
  const otherPreview = await operation(f, otherQuery);
  const responses = await Promise.all([operation(f, commit), operation(f,
    { ...otherQuery, op: 'exclude_commit', token: otherPreview.token })]);
  assert.ok(responses.every(response => ['ok', 'config_busy'].includes(response.code)));
  assert.ok(responses.some(response => response.code === 'ok'));
  const config = JSON.parse(fs.readFileSync(f.config));
  assert.ok(config.exclude.sessions.includes('claude:existing'));
  if (responses[0].code === 'ok') assert.ok(config.exclude.sessions.includes('claude:s'));
  if (responses[1].code === 'ok') {
    assert.equal(config.exclude.instructions.length, 1);
    assert.equal(config.exclude.instructions[0].id, item.id);
  }
  const m = await cli;
  assert.equal(m.escapeTerminal('normal\u001b[31m\u0000\u0085'), 'normal\\u001b[31m\\u0000\\u0085');
});
test('terminal confirmation displays escaped preview and never displays ssh stderr', async t => {
  const f = fixture(t);
  await initialize(f);
  f.write('Synthetic \u001b[31m\u0001 instruction');
  const snapshotResult = await invoke(f, args(f));
  assert.equal(snapshotResult.code, 0);
  const snapshot = JSON.parse(fs.readFileSync(path.join(f.out, fs.readdirSync(f.out)[0])));
  assert.equal(snapshot.instructions.length, 1);
  const item = snapshot.instructions[0];
  assert.equal(item.text, 'Synthetic \u001b[31m\u0001 instruction');
  const preview = await invoke(f, ['remote', '--host', 'synthetic@host', 'exclude',
    '--now', NOW, '--instruction', item.id + '#' + item.ref, '--orca-bin', f.request.orca_bin], 'n\n',
  { ...f.env, FAKE_SSH_STDERR: 'RAW_SSH_SENTINEL' });
  assert.equal(preview.spawns(), 1);
  assert.equal(preview.code, 1);
  assert.match(preview.output(), /Synthetic \\u001b\[31m\\u0001 instruction/);
  assert.equal(preview.output().includes('\u001b'), false);
  assert.equal(preview.output().includes('\u0001'), false);
  assert.equal((preview.output() + preview.errors()).includes('RAW_SSH_SENTINEL'), false);
});
