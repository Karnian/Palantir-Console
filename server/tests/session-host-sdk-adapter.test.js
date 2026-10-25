'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
// SDK settings use process HOME (os.homedir), not the subprocess options.env.
// Each node:test file runs in its own process; change HOME before importing SDK.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-sdk-home-'));
process.env.HOME = home;
for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) delete process.env[key];
const sdkPromise = import('@anthropic-ai/claude-agent-sdk');
const { fixture, until, executablePath, executableSha256 } = require('./helpers/session-host-sdk');
const { createSdkAdapter, capabilityVerdict } = require('../sessionHost/sdkAdapter');
const { createFakeIdentityProbe } = require('../sessionHost/identity');
const { createPsIdentityProbe } = require('../sessionHost/psIdentity');
const { checkSpawnOptions, checkSpawnOptionsSync } = require('../sessionHost/argvCheck');
const pin = require('../sessionHost/pin');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));
const check = (name, fn) => test(name, { timeout: 20000 }, async t => fn(t, await sdkPromise));

check('SDK core normal 20 prompts and 10 approvals have provider effect once and unknown zero', async (t, sdk) => {
  const f = await fixture(t, sdk);
  assert.equal((await f.start()).state, 'done');
  for (let index = 0; index < 20; index++) {
    const delivery = f.prompt(index < 10 ? 'tool' : 'hello');
    if (index < 10) {
      const tool = await f.pendingTool();
      const answer = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
      const duplicate = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'deny' } }));
      assert.equal(duplicate.state, 'rejected');
      await until(() => f.d(answer).state === 'provider_observed', 'approval observed');
    }
    await f.completed(delivery);
    assert.equal(f.core.submit({ ...f.req('prompt', { body: index < 10 ? 'tool' : 'hello' }), request_key: delivery.request_key }).id, delivery.id);
  }
  const rows = f.log();
  assert.equal(rows.filter(row => row.type === 'user').length, 20);
  assert.equal(new Set(rows.filter(row => row.type === 'user').map(row => row.uuid)).size, 20);
  assert.equal(rows.filter(row => row.type === 'tool').length, 10);
  assert.equal(new Set(rows.filter(row => row.type === 'tool').map(row => row.tool_use_id)).size, 10);
  assert.equal(f.state().deliveries.filter(row => row.state === 'unknown').length, 0);
  assert.equal(f.state().deliveries.filter(row => row.state === 'completed').length, 20);
  assert.equal(f.state().deliveries.filter(row => row.state === 'provider_observed').length, 10);
  assert.equal(JSON.stringify(f.events).includes('not retained'), false);
  const spawn = rows.find(row => row.type === 'spawn');
  assert.ok(spawn.argv.includes(`--session-id=${f.state().session.claude_session_id}`));
});

for (const behavior of ['deny', 'answer', 'toolError']) check(`SDK core ${behavior} tool path`, async (t, sdk) => {
  const f = await fixture(t, sdk, { toolError: behavior === 'toolError', contentArray: true });
  assert.equal((await f.start()).state, 'done');
  const prompt = f.prompt(behavior === 'answer' ? 'question' : 'tool');
  const tool = await f.pendingTool();
  const delivery = f.core.submit(f.req(behavior === 'answer' ? 'question_answer' : 'tool_decision', {
    target_tool_use_id: tool.tool_use_id,
    body: behavior === 'answer' ? { answer: 'A' } : { behavior: behavior === 'deny' ? 'deny' : 'allow' }
  }));
  await f.completed(prompt);
  assert.equal(f.d(delivery).state, behavior === 'toolError' ? 'unknown' : 'provider_observed');
  assert.equal(f.log().filter(row => row.type === 'tool').length, behavior === 'deny' ? 0 : 1);
  if (behavior === 'answer') assert.deepEqual(f.log().find(row => row.type === 'tool').answers, { 'Which?': 'A' });
  assert.throws(() => f.adapter.decide(f.iid, tool.tool_use_id, { behavior: 'allow' }), /tool_request_missing/);
});

for (const [label, config] of [
  ['empty', { stillQueued: [] }], ['survivors', { stillQueued: ['unexpected'] }], ['older', { olderReceipt: true }]
]) check(`SDK interrupt ${label} receipt via real control protocol`, async (t, sdk) => {
  const f = await fixture(t, sdk, { ...config, delayMs: 1000, noInterruptResult: label === 'older' });
  await f.start();
  const prompt = f.prompt();
  await until(() => f.events.some(event => event.type === 'lifecycle'), 'started');
  const interrupt = f.core.submit(f.req('interrupt'));
  if (label === 'older') {
    await delay(80);
    assert.equal(f.events.filter(event => event.type === 'interrupt_receipt').length, 0);
    f.advance(60000);
    assert.equal(f.d(interrupt).state, 'unknown');
  } else {
    await until(() => f.events.some(event => event.type === 'interrupt_receipt'), 'receipt');
    if (label === 'survivors') {
      assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
      const next = f.prompt('next');
      assert.equal(next.state, 'rejected');
      assert.equal(f.log().filter(row => row.type === 'user').length, 1);
      assert.equal(f.d(prompt).outcome, null);
    } else {
      await until(() => f.d(interrupt).state === 'completed', 'interrupt completed');
      assert.equal(f.core.idle(f.sid), true);
    }
  }
});

for (const mode of ['drop', 'merge', 'delayMs', 'omitLifecycle', 'singularResult']) {
  check(`SDK core abnormal ${mode} never resends input`, async (t, sdk) => {
    const f = await fixture(t, sdk, { [mode]: mode === 'delayMs' ? 100 : true });
    await f.start();
    const prompt = f.prompt();
    await until(() => f.log().some(row => row.type === 'user'), 'provider input');
    if (['drop', 'delayMs'].includes(mode)) {
      assert.ok(['written', 'provider_observed'].includes(f.d(prompt).state));
    }
    if (mode === 'drop') {
      assert.equal(f.d(prompt).state, 'written');
      await f.exit();
      assert.equal(f.d(prompt).state, 'unknown');
    } else if (mode === 'delayMs') {
      const retry = f.core.submit({ ...f.req('prompt', { body: 'hello' }), request_key: prompt.request_key });
      assert.equal(retry.id, prompt.id);
      await f.completed(prompt);
    } else {
      if (mode === 'merge') f.adapter.send(f.iid, randomUUID(), 'fault injected second message');
      await until(() => f.events.some(event => event.type === 'result'), 'result');
      if (mode === 'merge') {
        assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
        assert.equal(f.d(prompt).outcome, null);
      } else if (mode === 'omitLifecycle') {
        assert.equal(f.d(prompt).outcome, null);
        assert.equal(f.core.idle(f.sid), false);
      } else {
        assert.deepEqual(f.events.find(event => event.type === 'result').user_message_uuids, []);
        assert.equal(f.d(prompt).outcome, 'outcome_unknown');
      }
    }
    assert.equal(f.core.submit({ ...f.req('prompt', { body: 'hello' }), request_key: prompt.request_key }).id, prompt.id);
    assert.equal(f.log().filter(row => row.type === 'user').length, mode === 'merge' ? 2 : 1);
  });
}

for (const config of [{ capabilities: ['msg_lifecycle_v1'] }, { apiKeySource: 'env' }]) {
  check(`SDK first init closes for ${JSON.stringify(config)} with passing control`, async (t, sdk) => {
    const good = await fixture(t, sdk);
    await good.start();
    await good.completed(good.prompt());
    assert.equal(good.core.idle(good.sid), true);
    const f = await fixture(t, sdk, config);
    await f.start();
    f.prompt();
    await until(() => f.adapter.facts(f.iid).exited, 'automatic close');
    assert.equal(f.prompt('next').state, 'rejected');
    assert.equal(f.log().filter(row => row.type === 'user').length, 1);
  });
}

const account = { email: 'fake@example.test', organization: 'fake', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
for (const [label, patch] of [
  ['subscription', {}], ['API', { apiKeySource: 'ANTHROPIC_API_KEY' }], ['bearer', { tokenSource: 'ANTHROPIC_AUTH_TOKEN' }],
  ['OAuth', { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }], ['helper', { tokenSource: 'apiKeyHelper' }], ['cloud', { apiProvider: 'bedrock' }]
]) check(`SDK initialization ${label} account with passing control`, async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, { initialization: { account: { ...account, ...patch } } });
  const result = await f.start();
  assert.equal(result.state, label === 'subscription' ? 'done' : 'failed');
  if (label !== 'subscription') {
    assert.equal(result.reason, 'gate_rejected_cleaned');
    assert.equal(f.log().filter(row => row.type === 'user').length, 0);
    assert.equal(f.adapter.facts(f.iid).exited, true);
  }
});
for (const [field, value] of [['pid', 99], ['claude_code_version', 'wrong'], ['current_permission_mode', 'plan'],
  ['remote_control_auto_enable', true], ['account', null]]) {
  check(`SDK initialization ${field} rejects and confirms cleanup`, async (t, sdk) => {
    const good = await fixture(t, sdk);
    assert.equal((await good.start()).state, 'done');
    const f = await fixture(t, sdk, { initialization: { [field]: value } });
    assert.equal((await f.start()).reason, 'gate_rejected_cleaned');
    assert.equal(f.log().filter(row => row.type === 'user').length, 0);
    assert.equal(f.adapter.facts(f.iid).exited, true);
  });
}

check('SDK initialization timeout tick closes child and child_exit comes once', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, { hangInitialize: true });
  const accepted = f.core.submit({ kind: 'start', request_key: f.key(), cwd: f.dir });
  f.sid = accepted.session_id;
  f.iid = accepted.incarnation_id;
  await until(() => f.log().some(row => row.type === 'spawn'), 'spawn');
  f.advance(pin.initializationDeadlineMs);
  await f.control(accepted);
  assert.equal(f.core.lookup(accepted.request_key).reason, 'initialization_timeout');
  assert.equal(f.events.filter(event => event.type === 'child_exit').length, 1);
  f.adapter.close(f.iid);
  await delay(20);
  assert.equal(f.events.filter(event => event.type === 'child_exit').length, 1);
  assert.throws(() => f.adapter.send(f.iid, randomUUID(), 'late'), /incarnation_closed/);
  assert.equal(f.adapter.signal(f.iid, 'SIGTERM'), 0);
});

check('SDK receives scrubbed child env with single ownership marker', async (t, sdk) => {
  const f = await fixture(t, sdk, {}, { baseEnv: { HOME: home, PATH: process.env.PATH, PALANTIR_TOKEN: 'private',
    ANTHROPIC_API_KEY: 'sk-ant-private', ANTHROPIC_BASE_URL: 'private' } });
  assert.equal((await f.start()).state, 'done');
  const record = f.log().find(row => row.type === 'spawn');
  assert.equal(record.marker, f.iid);
  assert.deepEqual(record.palantirKeys, ['PALANTIR_OWNED_INCARNATION']);
  assert.deepEqual(record.authKeys, []);
  assert.deepEqual(Object.keys(f.spawns[0].opts.env).sort(), ['HOME', 'PATH', 'CLAUDE_AGENT_SDK_VERSION',
    'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SDK_READS_SESSION_STATE', 'PALANTIR_OWNED_INCARNATION'].sort());
});

for (const [label, options, code] of [
  ['hash', { executableSha256: '0'.repeat(64) }, 'executable_hash_mismatch'],
  ['argv', { extraArgs: { bare: null } }, 'unsafe_argv'],
  ['env', { baseEnv: { HOME: 'sk-ant-private' } }, 'invalid_child_env']
]) check(`SDK synchronous ${label} refusal happens before spawn with control`, async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, {}, options);
  assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), error => error.code === code && error.message === code);
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.log(), []);
});

check('SDK permission mode injection and identity failure are synchronous', async (t, sdk) => {
  const good = await fixture(t, sdk);
  await good.start();
  const f = await fixture(t, sdk, {}, { extraArgs: { 'permission-mode': 'plan' } });
  assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), /unsafe_argv/);
  assert.equal(f.spawns.length, 0);
  const probe = createFakeIdentityProbe();
  probe.readStartTime = () => ({ status: 'query_failed' });
  const badIdentity = await fixture(t, sdk, {}, { identityProbe: probe });
  assert.throws(() => badIdentity.adapter.start({ incarnation_id: randomUUID(), cwd: badIdentity.dir }), /identity_unavailable/);
  await until(() => badIdentity.processes[0].signalCode === 'SIGKILL', 'handle kill');
});

check('SDK settings read isolated HOME and reject project helper and base URL before spawn', async (t, sdk) => {
  for (const settings of [{}, { env: { ANTHROPIC_BASE_URL: 'https://invalid.test' } }, { apiKeyHelper: 'blocked' }]) {
    const f = await fixture(t, sdk);
    fs.mkdirSync(path.join(f.dir, '.claude'));
    fs.writeFileSync(path.join(f.dir, '.claude/settings.json'), JSON.stringify(settings));
    const resolved = await f.adapter.checkSettings(f.dir);
    assert.ok(resolved.sources.every(source => !source.path || source.path.startsWith(home) || source.path.startsWith(f.dir)));
    const result = await f.start();
    assert.equal(result.state, Object.keys(settings).length ? 'failed' : 'done');
    assert.equal(f.spawns.length, Object.keys(settings).length ? 0 : 1);
  }
});

check('SDK rate limits appear in snapshot and resume preserves conversation UUID', async (t, sdk) => {
  const f = await fixture(t, sdk, { rateLimit: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 12345 } });
  await f.start();
  await f.completed(f.prompt());
  assert.equal(f.state().incarnations[0].rate_limit_info.status, 'allowed');
  const sessionId = f.state().session.claude_session_id;
  assert.ok(f.spawns[0].args.includes(`--session-id=${sessionId}`));
  const stop = f.core.submit(f.req('stop'));
  assert.equal((await f.control(stop)).state, 'done');
  const resume = f.core.submit(f.req('resume'));
  f.iid = resume.incarnation_id;
  assert.equal((await f.control(resume)).state, 'done');
  assert.ok(f.spawns[1].args.includes(`--resume=${sessionId}`));
  assert.equal(f.state().session.claude_session_id, sessionId);
});

check('SDK capability verdict and argv synchronous/async parity', async () => {
  const args = ['--permission-mode=default'];
  for (const patch of [{}, { command: process.execPath }, { args: [] }, { args: [...args, '--bare'] },
    { args: [...args, '--dangerously-skip-permissions'] }, { args: [...args, '--permission-mode=plan'] }]) {
    const input = { command: executablePath, args, ...patch };
    const options = { pinnedPath: executablePath, pinnedSha256: executableSha256 };
    assert.deepEqual(checkSpawnOptionsSync(input, options), await checkSpawnOptions(input, options));
  }
  const input = { sdkVersion: pin.sdkVersion, cliVersion: pin.cliVersion, permissionMode: 'default' };
  assert.deepEqual(capabilityVerdict(input), { observe: 'supported', prompt: 'unknown', tool_approval: 'supported',
    cancel: 'unknown', resume: 'supported' });
  assert.equal(capabilityVerdict({ ...input, systemInitCapabilities: [] }).prompt, 'unsupported');
  assert.equal(capabilityVerdict({ ...input, systemInitCapabilities: pin.requiredCapabilities }).cancel, 'supported');
  for (const patch of [{ sdkVersion: 'wrong' }, { cliVersion: 'wrong' }, { permissionMode: 'plan' }]) {
    assert.ok(Object.values(capabilityVerdict({ ...input, ...patch })).every(value => value === 'unsupported'));
  }
  const source = fs.readFileSync(path.resolve(__dirname, '../sessionHost/sdkAdapter.js'), 'utf8');
  assert.equal(/bypassPermissions|allowDangerouslySkipPermissions/.test(source), false);
});

check('SDK real ps identity reads actual child and inherited grandchild marker then mismatch', async (t, sdk) => {
  require('node:child_process').execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)]);
  const probe = createPsIdentityProbe({ pinnedPath: executablePath });
  const f = await fixture(t, sdk, { spawnGrandchild: true }, { identityProbe: probe });
  assert.equal((await f.start()).state, 'done');
  const child = f.processes[0];
  const identity = probe.readStartTime(child.pid);
  assert.equal(identity.status, 'ok');
  assert.equal(probe.check(child.pid, identity.startedAt), 'match');
  const grandchild = await until(() => f.log().find(row => row.type === 'grandchild'), 'grandchild');
  assert.equal(grandchild.marker, f.iid);
  assert.ok(probe.listMarkedDescendants(f.iid).pids.some(row => row.pid === grandchild.pid));
  await f.exit();
  assert.equal(probe.check(child.pid, identity.startedAt), 'mismatch_confirmed');
});

check('SDK close and SIGTERM ignored: stream closure is not child death and cleanup is unverified', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, { ignoreClose: true, ignoreSigterm: true,
    initialization: { remote_control_auto_enable: true } });
  const accepted = f.core.submit({ kind: 'start', request_key: f.key(), cwd: f.dir });
  f.sid = accepted.session_id;
  f.iid = accepted.incarnation_id;
  await until(() => f.log().some(row => row.type === 'eof'), 'close EOF ignored');
  assert.equal(f.adapter.facts(f.iid).exited, false);
  assert.equal(f.events.filter(event => event.type === 'child_exit').length, 0);
  const signals = [];
  f.probe.verifyThenSignal = (pid, startedAt, sig) => {
    if (f.probe.check(pid, startedAt) !== 'match') return 'query_failed';
    signals.push(sig);
    f.adapter.signal(f.iid, sig);
    return 'match';
  };
  let descendants = 0;
  f.probe.listMarkedDescendants = () => { descendants++; return { status: 'query_failed' }; };
  f.advance(pin.closeWaitMs);
  assert.deepEqual(signals, ['SIGTERM']);
  await delay(30);
  assert.equal(f.adapter.facts(f.iid).exited, false);
  f.advance(pin.sigtermWaitMs);
  assert.equal(descendants, 1);
  assert.equal(f.core.lookup(accepted.request_key).reason, 'gate_rejected_unverified');
  assert.equal(f.state().incarnations[0].state, 'liveness_unknown');
});

check('SDK initialization reject emits fixed failure and confirms exit', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, { initializationError: true });
  const result = await f.start();
  assert.equal(result.reason, 'initialization_failed');
  assert.deepEqual(f.events.find(event => event.type === 'initialization_failed'),
    { incarnation_id: f.iid, type: 'initialization_failed', code: 'initialization_failed' });
  assert.equal(f.events.filter(event => event.type === 'child_exit').length, 1);
});

check('SDK abort cancels outstanding permission and prevents a late decision', async (t, sdk) => {
  const f = await fixture(t, sdk);
  await f.start();
  f.prompt('tool');
  const tool = await f.pendingTool();
  const interrupt = f.core.submit(f.req('interrupt'));
  await until(() => f.adapter.facts(f.iid, tool.tool_use_id).aborted, 'permission abort');
  assert.throws(() => f.adapter.decide(f.iid, tool.tool_use_id, { behavior: 'allow' }), /tool_request_missing/);
  await until(() => f.d(interrupt).state === 'completed', 'interrupted turn result');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
  // A subsequent turn has a fresh permission request and can succeed.
  const prompt = f.prompt('tool');
  const next = await f.pendingTool();
  const answer = f.core.submit(f.req('tool_decision', { target_tool_use_id: next.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  assert.equal(f.d(answer).state, 'provider_observed');
});

check('SDK hashes executable at every spawn including resume and async checker has identical failures', async (t, sdk) => {
  let hashes = 0;
  const { hashFileSync } = require('../sessionHost/argvCheck');
  const f = await fixture(t, sdk, {}, { hashFileSync(file) { hashes++; return hashFileSync(file); } });
  await f.start();
  const stop = f.core.submit(f.req('stop'));
  await f.control(stop);
  const resume = f.core.submit(f.req('resume'));
  f.iid = resume.incarnation_id;
  await f.control(resume);
  assert.equal(hashes, 2);
  for (const options of [{ pinnedSha256: '0'.repeat(64) }, { pinnedPath: '/missing' },
    { hashFileSync: () => { throw Error('private'); }, hashFile: async () => { throw Error('private'); } }]) {
    const input = { command: executablePath, args: ['--permission-mode=default'] };
    const config = { pinnedPath: executablePath, pinnedSha256: executableSha256, ...options };
    assert.deepEqual(checkSpawnOptionsSync(input, config), await checkSpawnOptions(input, config));
  }
});

check('SDK native command path check rejects SDK Node wrapper before spawning', async (t, sdk) => {
  const good = await fixture(t, sdk);
  await good.start();
  // The pinned SDK treats .js as a script and sets SpawnOptions.command to node.
  // This existing fixture is only read; the command mismatch rejects before execution.
  const script = path.resolve(__dirname, 'fixtures/bin/fake-claude-stream-json.js');
  const f = await fixture(t, sdk, {}, { executablePath: script,
    executableSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(script)).digest('hex') });
  assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), error => error.code === 'executable_mismatch');
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.log(), []);
});

check('SDK delay consumes original input once after host recovery marks it unknown', async (t, sdk) => {
  const f = await fixture(t, sdk, { delayMs: 150, omitLifecycle: true });
  await f.start();
  const prompt = f.prompt();
  await until(() => f.log().some(row => row.type === 'user'), 'provider input');
  // Closing the core detaches its event listener, without closing the owned SDK query.
  f.core.close();
  const { createHostCore } = require('../sessionHost/core');
  const core = createHostCore({ dbPath: path.join(f.dir, 'host.sqlite'), adapter: f.adapter, identityProbe: f.probe,
    hostBootId: 'recovered-sdk-boot', clock: () => 1800000000000 });
  t.after(() => core.close());
  core.recover();
  await until(() => f.events.some(event => event.type === 'result'), 'late original result');
  assert.equal(core.lookup(prompt.request_key).state, 'unknown');
  assert.equal(core.lookup(prompt.request_key).outcome, 'outcome_unknown');
  assert.equal(core.submit({ ...f.req('prompt', { body: 'hello' }), request_key: prompt.request_key }).id, prompt.id);
  assert.equal(f.log().filter(row => row.type === 'user').length, 1);
});

check('SDK spawn guard refuses an executable outside fixtures before hash and spawn', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  let hashes = 0;
  const f = await fixture(t, sdk, {}, { executablePath: '/bin/ls', hashFileSync() { hashes++; return '0'.repeat(64); } });
  assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }),
    error => error.code === 'spawn_blocked' && error.message === 'spawn_blocked');
  assert.equal(hashes, 0);
  assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.log(), []);
});

check('SDK fake grandchild inherits exact marker with no credentials', async (t, sdk) => {
  const f = await fixture(t, sdk, { spawnGrandchild: true });
  await f.start();
  const record = await until(() => f.log().find(row => row.type === 'grandchild'), 'grandchild marker');
  assert.equal(record.marker, f.iid);
  assert.notEqual(record.pid, f.processes[0].pid);
});

check('SDK settings use isolated process HOME user settings, not parent account configuration', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const settingsDir = path.join(home, '.claude');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://invalid.test' } }));
  try {
    const f = await fixture(t, sdk);
    const resolved = await f.adapter.checkSettings(f.dir);
    assert.equal(resolved.effective.env.ANTHROPIC_BASE_URL, 'https://invalid.test');
    assert.equal((await f.start()).reason, 'settings_rejected');
    assert.equal(f.spawns.length, 0);
  } finally {
    fs.rmSync(settingsPath);
  }
});

check('SDK structured question answer exposes existing core string-equality boundary', async (t, sdk) => {
  const f = await fixture(t, sdk);
  await f.start();
  const prompt = f.prompt('question');
  const tool = await f.pendingTool();
  const delivery = f.core.submit(f.req('question_answer', { target_tool_use_id: tool.tool_use_id,
    body: { answer: { 'Which?': 'A' } } }));
  await f.completed(prompt);
  assert.deepEqual(f.log().find(row => row.type === 'tool').answers, { 'Which?': 'A' });
  assert.equal(f.d(delivery).state, 'unknown');
  assert.equal(f.d(delivery).reason, 'tool_finished');
});

check('SDK identity lookup failure kills owned handle and core retains never_started', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const probe = createFakeIdentityProbe();
  probe.readStartTime = () => { throw Error('private path'); };
  const f = await fixture(t, sdk, {}, { identityProbe: probe });
  assert.equal((await f.start()).reason, 'spawn_failed');
  await until(() => f.processes[0].signalCode === 'SIGKILL', 'failed startup child killed');
  assert.equal(f.state().incarnations[0].state, 'never_started');
  assert.equal(f.events.filter(event => event.type === 'child_exit').length, 1);
  assert.equal(f.log().filter(row => row.type === 'user').length, 0);
});

check('SDK missing initialization account stays absent and fails closed', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, { omitAccount: true });
  assert.equal((await f.start()).reason, 'gate_rejected_cleaned');
  assert.equal(Object.hasOwn(f.events.find(event => event.type === 'initialization').initialization, 'account'), false);
  assert.equal(f.log().filter(row => row.type === 'user').length, 0);
});
