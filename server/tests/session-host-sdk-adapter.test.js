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
  assert.equal(rows.filter(row => row.type === 'initialize').length, 21);
  assert.equal(rows.filter(row => row.type === 'tool_response').length, 10);
  for (const row of rows.filter(row => row.type === 'tool_response')) {
    assert.equal(row.inputMatch, true);
    assert.deepEqual(row.updatedInput, { command: 'fake success' });
  }
  assert.equal(rows.filter(row => row.type === 'input_mismatch').length, 0);
  assert.equal(rows.filter(row => row.type === 'user').length, 20);
  assert.equal(new Set(rows.filter(row => row.type === 'user').map(row => row.uuid)).size, 20);
  assert.equal(rows.filter(row => row.type === 'tool').length, 10);
  assert.equal(new Set(rows.filter(row => row.type === 'tool').map(row => row.tool_use_id)).size, 10);
  assert.equal(f.state().deliveries.filter(row => row.state === 'unknown').length, 0);
  assert.equal(f.state().deliveries.filter(row => row.state === 'completed').length, 20);
  assert.equal(f.state().deliveries.filter(row => row.state === 'provider_observed').length, 10);
  assert.equal(JSON.stringify(f.events.filter(event => event.type !== 'sdk_message')).includes('not retained'), false);
  assert.equal(JSON.stringify(f.events.filter(event => event.type === 'sdk_message')).includes('not retained'), true);
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
  let interruptSettled = false;
  const f = await fixture(t, sdk, { ...config, delayMs: 1000, noInterruptResult: label === 'older' },
    { testHooks: { onInterruptSettled() { interruptSettled = true; } } });
  await f.start();
  const prompt = f.prompt();
  await until(() => f.events.some(event => event.type === 'lifecycle'), 'started');
  const interrupt = f.core.submit(f.req('interrupt'));
  if (label === 'older') {
    await until(() => f.log().some(row => row.type === 'interrupt_response') && interruptSettled, 'old receipt processed');
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
      let queued, injected;
      if (mode === 'merge') {
        queued = f.prompt('queued before merge');
        assert.equal(queued.state, 'queued');
        injected = randomUUID();
        f.adapter.send(f.iid, injected, 'fault injected second message');
      }
      await until(() => f.events.some(event => event.type === 'result'), 'result');
      if (mode === 'merge') {
        await until(() => [prompt.message_uuid, injected].every(uuid => f.events.some(event =>
          event.type === 'lifecycle' && event.command_uuid === uuid && event.state === 'completed')), 'merged lifecycle ends');
        assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
        assert.equal(f.d(prompt).state, 'provider_observed');
        assert.equal(f.d(prompt).outcome, null);
        assert.equal(f.d(queued).state, 'queued');
        assert.equal(f.d(queued).outcome, null);
        assert.equal(f.prompt('new after merge').state, 'rejected');
      } else if (mode === 'omitLifecycle') {
        assert.equal(f.d(prompt).outcome, null);
        assert.equal(f.core.idle(f.sid), false);
        const queued = f.prompt('queued without lifecycle');
        assert.equal(queued.state, 'queued');
        await f.exit();
        assert.equal(f.d(prompt).state, 'unknown');
        // The unchanged core preserves the known exact result on exit, despite missing lifecycle.
        assert.equal(f.d(prompt).outcome, 'completed');
        assert.equal(f.d(queued).state, 'expired');
        assert.equal(f.d(queued).outcome, null);
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
  await new Promise(setImmediate);
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
  ['env', { baseEnv: { HOME: home, LANG: 'sk-ant-private' } }, 'invalid_child_env']
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
  const descendants = probe.listMarkedDescendants(f.iid);
  assert.equal(descendants.status, 'ok');
  assert.ok(descendants.pids.some(row => row.pid === grandchild.pid));
  assert.ok(descendants.diagnostics.elapsedMs < 2000, JSON.stringify(descendants.diagnostics));
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
  await until(() => f.log().some(row => row.type === 'sigterm_ignored'), 'child handled SIGTERM');
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
  const queued = [f.prompt('queued A'), f.prompt('queued B')];
  assert.ok(queued.every(row => row.state === 'queued'));
  // Closing the core detaches its event listener, without closing the owned SDK query.
  f.core.close();
  const { createHostCore } = require('../sessionHost/core');
  const core = createHostCore({ dbPath: path.join(f.dir, 'host.sqlite'), adapter: f.adapter, identityProbe: f.probe,
    hostBootId: 'recovered-sdk-boot', clock: () => 1800000000000 });
  t.after(() => core.close());
  core.recover();
  assert.equal(core.lookup(prompt.request_key).state, 'unknown');
  const blocked = core.submit(f.req('prompt', { body: 'different key while original unknown' }));
  assert.equal(blocked.state, 'rejected');
  assert.equal(blocked.outcome, null);
  assert.equal(f.log().filter(row => row.type === 'user').length, 1);
  await until(() => f.events.some(event => event.type === 'result'), 'late original result');
  assert.equal(core.lookup(prompt.request_key).state, 'unknown');
  assert.equal(core.lookup(prompt.request_key).outcome, 'outcome_unknown');
  for (const delivery of queued) {
    assert.equal(core.lookup(delivery.request_key).state, 'expired');
    assert.equal(core.lookup(delivery.request_key).outcome, null);
  }
  assert.equal(core.lookup(blocked.request_key).state, 'rejected');
  assert.equal(core.lookup(blocked.request_key).outcome, null);
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
  await delay(1600);
  assert.doesNotThrow(() => process.kill(record.pid, 0), 'grandchild must outlive the previous 1.5 second timer');
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

// Structured answers are a known limit and excluded from normal-path success counts until S1-e.
check('SDK structured question answer known limit (S1-e): core string-equality boundary', async (t, sdk) => {
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

check('R2 config root mismatch rejects settings and start before spawn', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const f = await fixture(t, sdk, {}, { baseEnv: { HOME: home + '-different', PATH: process.env.PATH } });
  await assert.rejects(f.adapter.checkSettings(f.dir), { code: 'config_root_mismatch' });
  assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), { code: 'config_root_mismatch' });
  assert.equal(f.spawns.length, 0);
});

check('R2 prompt recheck gets fresh account instead of initialization cache', async (t, sdk) => {
  const good = await fixture(t, sdk);
  await good.start();
  await good.completed(good.prompt());
  await good.completed(good.prompt());
  assert.equal(good.log().filter(row => row.type === 'initialize').length, 3);
  const f = await fixture(t, sdk);
  await f.start();
  await f.completed(f.prompt());
  fs.writeFileSync(path.join(f.dir, 'fake-claude.json'), JSON.stringify({ initialization: { account: { ...account,
    apiKeySource: 'ANTHROPIC_API_KEY' } } }));
  const second = f.prompt('must not reach provider');
  await until(() => ['rejected', 'completed'].includes(f.d(second).state), 'second prompt settled');
  assert.equal(f.d(second).state, 'rejected');
  assert.equal(f.d(second).reason, 'auth_recheck_failed');
  assert.equal(f.log().filter(row => row.type === 'user').length, 1);
  assert.equal(f.log().filter(row => row.type === 'initialize').length, 3);
});

for (const aborted of [false, true]) check(`R2 duplicate tool callback shares pending promise aborted=${aborted}`, async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const first = callback(event.name, event.input, { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId });
  const controller = new AbortController();
  if (aborted) controller.abort();
  const second = callback(event.name, event.input, { signal: controller.signal, toolUseID: tool.tool_use_id, requestId });
  assert.strictEqual(first, second);
  assert.equal(f.adapter.facts(f.iid, tool.tool_use_id).aborted, aborted);
  if (aborted) {
    assert.equal(event.signal.aborted, true);
    assert.deepEqual(await first, { behavior: 'deny', message: 'request_aborted' });
    assert.equal(f.core.submit(f.req('tool_decision', {
      target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' }
    })).state, 'rejected');
    await f.completed(prompt);
    assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
    return;
  }
  const answer = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  assert.deepEqual(await first, { behavior: 'allow', updatedInput: event.input });
  await f.completed(prompt);
  assert.equal(f.d(answer).state, 'provider_observed');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
  assert.deepEqual(await callback(event.name, event.input,
    { signal: controller.signal, toolUseID: tool.tool_use_id, requestId: requestId + '-different' }),
    { behavior: 'deny', message: 'duplicate_tool_request' });
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
});

for (const mode of ['error', 'missing']) check(`R2 prompt fresh initialization ${mode} rejects without provider input`, async (t, sdk) => {
  const f = await fixture(t, sdk);
  await f.start();
  await f.completed(f.prompt());
  fs.writeFileSync(path.join(f.dir, 'fake-claude.json'), JSON.stringify(mode === 'error' ? { initializationError: true } : { omitAccount: true }));
  const second = f.prompt('blocked');
  await until(() => f.d(second).state === 'rejected', 'auth recheck rejection');
  assert.equal(f.d(second).reason, 'auth_recheck_failed');
  assert.equal(f.log().filter(row => row.type === 'initialize').length, 3);
  assert.equal(f.log().filter(row => row.type === 'user').length, 1);
});

for (const answer of [{}, { 'Which?': 'A' }, { 'Which?': 'A', 'Why?': 'B', Extra: 'C' },
  { 'Which?': '', 'Why?': 'B' }, { 'Which?': '  ', 'Why?': 'B' }]) {
  check(`R2 question rejects incomplete answers ${JSON.stringify(answer)}`, async (t, sdk) => {
    const f = await fixture(t, sdk, { questionCount: 2 });
    await f.start();
    const prompt = f.prompt('question');
    const tool = await f.pendingTool();
    assert.throws(() => f.adapter.decide(f.iid, tool.tool_use_id, { behavior: 'answer', answer }), { code: 'invalid_decision' });
    assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
    await f.completed(prompt);
    assert.equal(f.log().filter(row => row.type === 'tool_response').length, 1);
    assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
    assert.throws(() => f.adapter.decide(f.iid, tool.tool_use_id, { behavior: 'answer',
      answer: { 'Which?': 'A', 'Why?': 'B' } }), { code: 'tool_request_missing' });
  });
}

check('R2 fake refuses changed allow input instead of recording execution', async (t, sdk) => {
  const f = await fixture(t, sdk);
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  f.events.find(event => event.type === 'tool_request').input.command = 'tampered';
  const answer = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  assert.equal(f.d(answer).state, 'unknown');
  assert.equal(f.d(answer).reason, 'tool_finished_error');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
  assert.equal(f.log().filter(row => row.type === 'input_mismatch').length, 1);
});

check('R2 missing lifecycle and uncorrelated result finish unknown on child exit', async (t, sdk) => {
  const f = await fixture(t, sdk, { omitLifecycle: true, singularResult: true });
  await f.start();
  const prompt = f.prompt();
  await until(() => f.events.some(event => event.type === 'result'), 'uncorrelated result');
  assert.equal(f.d(prompt).outcome, null);
  await f.exit();
  assert.equal(f.d(prompt).state, 'unknown');
  assert.equal(f.d(prompt).outcome, 'outcome_unknown');
  assert.equal(f.core.submit({ ...f.req('prompt', { body: 'hello' }), request_key: prompt.request_key }).id, prompt.id);
  assert.equal(f.log().filter(row => row.type === 'user').length, 1);
});

check('R2 config root validates creation and every settings/start call with single-field controls', async (t, sdk) => {
  const good = await fixture(t, sdk);
  assert.equal((await good.start()).state, 'done');
  const blocked = async f => {
    await assert.rejects(f.adapter.checkSettings(f.dir), { code: 'config_root_mismatch' });
    assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), { code: 'config_root_mismatch' });
    assert.equal(f.spawns.length, 0);
  };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) {
    const current = await fixture(t, sdk);
    process.env[key] = home;
    try { await blocked(current); } finally { delete process.env[key]; }
    process.env[key] = home;
    let created;
    try { created = await fixture(t, sdk); } finally { delete process.env[key]; }
    await blocked(created);
    await blocked(await fixture(t, sdk, {}, { baseEnv: { HOME: home, PATH: process.env.PATH, [key]: '' } }));
    const control = await fixture(t, sdk);
    assert.equal((await control.start()).state, 'done');
  }
  for (const value of [undefined, '']) {
    await blocked(await fixture(t, sdk, {}, { baseEnv: { HOME: value, PATH: process.env.PATH } }));
  }
  const current = await fixture(t, sdk);
  const savedHome = process.env.HOME;
  try {
    process.env.HOME = '';
    await blocked(current);
  } finally { process.env.HOME = savedHome; }
});

check('R2 subagent tool result preserves approval observation and parent correlation', async (t, sdk) => {
  const f = await fixture(t, sdk, { parentToolUseId: 'parent-tool' });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  const answer = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  assert.equal(f.d(answer).state, 'provider_observed');
  assert.equal(f.events.find(event => event.type === 'tool_result').parent_tool_use_id, 'parent-tool');
});

check('R2 late original stays unknown while alive and never drains unrelated queued inputs', async (t, sdk) => {
  const f = await fixture(t, sdk, { delayMs: 150, omitLifecycle: true });
  await f.start();
  const send = f.adapter.send.bind(f.adapter);
  f.adapter.send = (...args) => { send(...args); throw Error('injected_after_input_yield'); };
  const original = f.prompt('original');
  const queued = [f.prompt('queued one'), f.prompt('queued two')];
  await until(() => f.d(original).state === 'unknown', 'original unknown before delayed execution');
  assert.equal(f.adapter.facts(f.iid).exited, false);
  assert.equal(f.d(original).outcome, null);
  assert.ok(queued.every(delivery => f.d(delivery).state === 'queued'));
  const blocked = f.prompt('new key while unknown');
  assert.equal(blocked.state, 'rejected');
  await until(() => f.events.some(event => event.type === 'result'), 'late original result');
  assert.equal(f.d(original).state, 'unknown');
  assert.equal(f.d(original).outcome, null);
  for (const delivery of queued) {
    assert.equal(f.d(delivery).state, 'queued');
    assert.equal(f.d(delivery).outcome, null);
  }
  assert.equal(f.d(blocked).state, 'rejected');
  assert.equal(f.d(blocked).outcome, null);
  assert.deepEqual(f.log().filter(row => row.type === 'user').map(row => row.uuid), [original.message_uuid]);
});

check('R3 default environment HOME is fixed at adapter creation', async (t, sdk) => {
  const f = await fixture(t, sdk, {}, { baseEnv: undefined });
  await f.adapter.checkSettings(f.dir);
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = originalHome + '-changed';
    await assert.rejects(f.adapter.checkSettings(f.dir), { code: 'config_root_mismatch' });
    assert.throws(() => f.adapter.start({ incarnation_id: randomUUID(), cwd: f.dir }), { code: 'config_root_mismatch' });
    assert.equal(f.spawns.length, 0);
    assert.deepEqual(f.log(), []);
  } finally { process.env.HOME = originalHome; }
  await f.adapter.checkSettings(f.dir);
  assert.equal((await f.start()).state, 'done');
  assert.equal(f.spawns[0].opts.env.HOME, originalHome);
});

check('R3 caller environment mutation cannot change child snapshot', async (t, sdk) => {
  const baseEnv = { HOME: home, PATH: process.env.PATH, LANG: 'C' };
  const f = await fixture(t, sdk, {}, { baseEnv });
  baseEnv.HOME += '-changed';
  baseEnv.PATH = '/invalid';
  baseEnv.LANG = 'changed';
  assert.equal((await f.start()).state, 'done');
  assert.equal(f.spawns[0].opts.env.HOME, home);
  assert.equal(f.spawns[0].opts.env.PATH, process.env.PATH);
  assert.equal(f.spawns[0].opts.env.LANG, 'C');
});

for (const question of [false, true]) check(`R4 completed same request denies original result replay question=${question}`, async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  const prompt = f.prompt(question ? 'question' : 'tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const options = { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId };
  const pending = callback(event.name, event.input, options);
  f.adapter.decide(f.iid, tool.tool_use_id, question ? { behavior: 'answer', answer: 'A' } : { behavior: 'allow' });
  const result = await pending;
  await f.completed(prompt);
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(await callback(event.name, event.input, options), { behavior: 'deny', message: 'duplicate_tool_request' });
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
});

for (const question of [false, true]) check(`R4 wire completed redelivery denies without another execution question=${question}`, async (t, sdk) => {
  const f = await fixture(t, sdk, { redeliverToolRequest: true });
  await f.start();
  const prompt = f.prompt(question ? 'question' : 'tool');
  const tool = await f.pendingTool();
  // Its reply is later in stdout than both copies, so SDK has processed the
  // pre-response duplicate while the first human decision is still pending.
  await f.adapter.accountInfo(f.iid);
  const answer = f.core.submit(f.req(question ? 'question_answer' : 'tool_decision', {
    target_tool_use_id: tool.tool_use_id, body: question ? { answer: 'A' } : { behavior: 'allow' }
  }));
  await f.completed(prompt);
  await until(() => f.log().filter(row => row.type === 'permission_response').length >= 2, 'replayed wire response');
  const replies = f.log().filter(row => row.type === 'permission_response');
  assert.equal(replies.length, 2);
  assert.equal(replies[1].decision.behavior, 'deny');
  assert.equal(replies[1].decision.message, 'duplicate_tool_request');
  assert.equal(replies[0].decision.behavior, 'allow');
  assert.equal(f.d(answer).state, 'unknown');
  assert.equal(f.d(answer).reason, 'tool_finished_error');
  assert.equal(f.state().deliveries.filter(row => ['tool_decision', 'question_answer'].includes(row.kind)).length, 1);
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
  assert.deepEqual(f.log().filter(row => row.type === 'tool_request_sent').map(row => row.phase),
    ['initial', 'before_response', 'after_response']);
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
});

check('R3 wire cancellation aborts SDK signal and blocks late human approval', async (t, sdk) => {
  const f = await fixture(t, sdk, { cancelToolRequest: true });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await until(() => f.state().tool_requests.find(row => row.state === 'cancelled'), 'wire cancelled approval');
  const event = f.events.find(event => event.type === 'tool_request');
  assert.equal(event.signal.aborted, true);
  assert.equal(f.adapter.facts(f.iid, tool.tool_use_id).aborted, true);
  const late = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  assert.equal(late.state, 'rejected');
  await until(() => f.log().some(row => row.type === 'permission_response'), 'aborted permission response');
  await until(() => f.d(prompt).outcome === 'interrupted', 'cancelled lifecycle');
  assert.equal(f.log().filter(row => row.type === 'tool_cancel_sent').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
  assert.ok(f.log().filter(row => row.type === 'permission_response').every(row => row.decision.behavior === 'deny'));
  assert.equal(f.state().tool_requests[0].state, 'cancelled');
});

for (const requestId of ['different-request', undefined]) {
  check(`R3 unrelated or missing request ID cannot reuse tool approval requestId=${requestId}`, async (t, sdk) => {
    let callback;
    const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
    await f.start();
    const prompt = f.prompt('tool');
    const tool = await f.pendingTool();
    const event = f.events.find(event => event.type === 'tool_request');
    const originalId = f.log().find(row => row.type === 'tool_request_sent').request_id;
    const options = { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId };
    const duplicate = callback(event.name, event.input, options);
    assert.deepEqual(await duplicate, { behavior: 'deny', message: 'duplicate_tool_request' });
    assert.equal(f.state().tool_requests[0].state, 'pending');
    assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
    const pending = callback(event.name, event.input, { ...options, requestId: originalId });
    const decision = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
    const originalResult = await pending;
    await f.completed(prompt);
    assert.equal(f.d(decision).state, 'provider_observed');
    assert.deepEqual(await callback(event.name, event.input, options), { behavior: 'deny', message: 'duplicate_tool_request' });
    assert.equal(originalResult.behavior, 'allow');
    assert.deepEqual(await callback(event.name, event.input, { ...options, requestId: originalId }),
      { behavior: 'deny', message: 'duplicate_tool_request' });
    assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
    assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
  });
}

check('R4 completed request denies instead of replaying allow', async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const options = { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId };
  f.adapter.decide(f.iid, tool.tool_use_id, { behavior: 'allow' });
  await f.completed(prompt);
  assert.deepEqual(await callback(event.name, event.input, options), { behavior: 'deny', message: 'duplicate_tool_request' });
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
});

for (const change of ['name', 'input']) check(`R4 pending replay verifies ${change}`, async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const options = { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId };
  const original = callback(event.name, event.input, options);
  const different = callback(change === 'name' ? 'OtherTool' : event.name,
    change === 'input' ? { command: 'different' } : event.input, options);
  assert.notStrictEqual(different, original);
  assert.deepEqual(await different, { behavior: 'deny', message: 'duplicate_tool_request' });
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
});

check('R4 accepted replay abort propagates through adapter signal', async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, {}, { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const duplicate = new AbortController();
  const promise = callback(event.name, event.input, { signal: duplicate.signal, toolUseID: tool.tool_use_id, requestId });
  duplicate.abort();
  assert.equal(event.signal.aborted, true);
  assert.equal(f.adapter.facts(f.iid, tool.tool_use_id).aborted, true);
  assert.deepEqual(await promise, { behavior: 'deny', message: 'request_aborted' });
  assert.equal(f.state().tool_requests[0].state, 'cancelled');
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } })).state, 'rejected');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
});

check('R4 cached SDK user root cannot hide new HOME forbidden settings', async (t, sdk) => {
  const settingsA = path.join(home, '.claude/settings.json');
  const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-home-b-'));
  t.after(() => fs.rmSync(homeB, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(settingsA), { recursive: true });
  fs.writeFileSync(settingsA, JSON.stringify({ model: 'root-control' }));
  fs.mkdirSync(path.join(homeB, '.claude'));
  fs.writeFileSync(path.join(homeB, '.claude/settings.json'), JSON.stringify({ apiKeyHelper: 'blocked' }));
  try {
    const good = await fixture(t, sdk);
    const resolvedA = await sdk.resolveSettings({ cwd: good.dir });
    assert.ok(resolvedA.sources.some(source => source.source === 'user' && source.path.startsWith(home + path.sep)));
    assert.equal((await good.start()).state, 'done');
    process.env.HOME = homeB;
    const f = await fixture(t, sdk);
    let resolved, rejected = false;
    try { resolved = await f.adapter.checkSettings(f.dir); }
    catch (error) { assert.equal(error.code, 'config_root_mismatch'); rejected = true; }
    if (!rejected) assert.equal(resolved.effective.apiKeyHelper, 'blocked');
    assert.equal((await f.start()).state, 'failed');
    assert.equal(f.spawns.length, 0);
    assert.deepEqual(f.log(), []);
  } finally {
    process.env.HOME = home;
    fs.rmSync(settingsA, { force: true });
  }
});

check('R4 sorted JSON fingerprint accepts reordered nested input keys', async (t, sdk) => {
  let callback;
  const f = await fixture(t, sdk, { toolInput: { command: 'fake success', metadata: { z: 1, a: 2 } } },
    { testHooks: { onQuery({ canUseTool }) { callback = canUseTool; } } });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  const requestId = f.log().find(row => row.type === 'tool_request_sent').request_id;
  const options = { signal: new AbortController().signal, toolUseID: tool.tool_use_id, requestId };
  const first = callback(event.name, event.input, options);
  assert.strictEqual(callback(event.name, { metadata: { a: 2, z: 1 }, command: 'fake success' }, options), first);
  const decision = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  assert.equal(f.d(decision).state, 'provider_observed');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
});

check('R4 child exit aborts adapter controller and facts', async (t, sdk) => {
  const f = await fixture(t, sdk);
  await f.start();
  f.prompt('tool');
  const tool = await f.pendingTool();
  const event = f.events.find(event => event.type === 'tool_request');
  assert.equal(event.signal.aborted, false);
  await f.exit();
  assert.equal(event.signal.aborted, true);
  assert.equal(f.adapter.facts(f.iid, tool.tool_use_id).aborted, true);
  assert.equal(f.state().tool_requests[0].state, 'cancelled');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
});

check('R4 wire pending changed-name replay is deduped by SDK before callback', async (t, sdk) => {
  const f = await fixture(t, sdk, { pendingReplayToolName: 'OtherTool' });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  await f.adapter.accountInfo(f.iid);
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool_request_sent').length, 2);
  assert.equal(f.log().filter(row => row.type === 'permission_response').length, 0);
  const decision = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  assert.equal(f.d(decision).state, 'provider_observed');
  assert.equal(f.log().filter(row => row.type === 'permission_response').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
});

check('R4 wire pending replay cancellation cancels shared logical approval', async (t, sdk) => {
  const f = await fixture(t, sdk, { cancelPendingReplay: true });
  await f.start();
  const prompt = f.prompt('tool');
  const tool = await f.pendingTool();
  await f.adapter.accountInfo(f.iid);
  await until(() => f.state().tool_requests[0].state === 'cancelled', 'wire pending replay cancelled');
  assert.equal(f.adapter.facts(f.iid, tool.tool_use_id).aborted, true);
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } })).state, 'rejected');
  await until(() => f.d(prompt).outcome === 'interrupted', 'cancelled prompt');
  assert.equal(f.events.filter(event => event.type === 'tool_request').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool_request_sent').length, 2);
  assert.equal(f.log().filter(row => row.type === 'tool_cancel_sent').length, 1);
  assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
});

check('C1 SDK stream preserves full messages alongside existing translated events', async (t, sdk) => {
  const f = await fixture(t, sdk);
  assert.equal((await f.start()).state, 'done');
  const delivery = f.prompt('hello');
  await f.completed(delivery);
  const raw = f.events.filter(event => event.type === 'sdk_message');
  assert.ok(raw.length > 0);
  assert.ok(raw.some(event => event.message.type === 'result'));
  assert.ok(raw.some(event => event.message.type === 'command_lifecycle'));
  assert.ok(f.events.some(event => event.type === 'result'));
  const persisted = f.core.eventsSince(0).events.filter(event => event.type === 'sdk_message');
  assert.deepEqual(persisted.map(event => event.json.message), raw.map(event => event.message));
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw);
});

check('C1 SDK raw messages omit functions and AbortSignal runtime values', async (t, sdk) => {
  const wrappedSdk = { ...sdk, query(args) {
    const query = sdk.query(args);
    const iterator = query[Symbol.asyncIterator].bind(query);
    query[Symbol.asyncIterator] = async function* () {
      for await (const message of { [Symbol.asyncIterator]: iterator }) {
        yield { ...message, runtime: { signal: new AbortController().signal, callback() {}, text: 'retained text' } };
      }
    };
    return query;
  } };
  const f = await fixture(t, wrappedSdk);
  assert.equal((await f.start()).state, 'done');
  await f.completed(f.prompt('hello'));
  const messages = f.events.filter(event => event.type === 'sdk_message');
  assert.ok(messages.length > 0);
  for (const event of messages) assert.deepEqual(event.message.runtime, { text: 'retained text' });
});

for (const invalid of ['cycle', 'bigint']) {
  check('C1 serialization failure preserves subsequent lifecycle and result: ' + invalid, async (t, sdk) => {
    const wrapped = { ...sdk, query(args) {
      const query = sdk.query(args);
      const iterator = query[Symbol.asyncIterator].bind(query);
      query[Symbol.asyncIterator] = async function* () {
        const bad = { type: 'assistant' };
        bad.extra = invalid === 'cycle' ? bad : 1n;
        yield bad;
        yield* { [Symbol.asyncIterator]: iterator };
      };
      return query;
    } };
    const f = await fixture(t, wrapped);
    assert.equal((await f.start()).state, 'done');
    const delivery = f.prompt('hello');
    assert.equal((await f.completed(delivery)).state, 'completed');
    assert.ok(f.events.some(event => event.type === 'lifecycle'));
    assert.ok(f.events.some(event => event.type === 'result'));
    assert.ok(f.events.some(event => event.type === 'sdk_message' && event.message.serialization_failed === true));
  });
}

check('R1 raw rate limit message cannot bypass field allowlist', async (t, sdk) => {
  const wrapped = { ...sdk, query(args) {
    const query = sdk.query(args); const iterator = query[Symbol.asyncIterator].bind(query);
    query[Symbol.asyncIterator] = async function* () {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', email: 'SECRET-RATE-EMAIL' }, email: 'SECRET-RATE-TOP' };
      yield* { [Symbol.asyncIterator]: iterator };
    };
    return query;
  } };
  const f = await fixture(t, wrapped); await f.start();
  assert.equal(JSON.stringify(f.core.eventsSince(0)).includes('SECRET-RATE'), false);
});

check('R4 missing fake configuration initializes SDK session with defaults', async (t, sdk) => {
  const f = await fixture(t, sdk);
  fs.unlinkSync(path.join(f.dir, 'fake-claude.json'));
  assert.equal((await f.start()).state, 'done');
  assert.ok(f.log().some(row => row.type === 'initialize'));
});

check('R5 invalid question key preserves pending card and zero responses; corrected answer completes', async (t, sdk) => {
  const f = await fixture(t, sdk, { contentArray: true }); await f.start();
  const prompt = f.prompt('question'); const tool = await f.pendingTool();
  const before = f.state().deliveries.length;
  const request = f.req('question_answer', { target_tool_use_id: tool.tool_use_id, body: { answer: { Choice: 'A' } } });
  const rejected = f.core.submit(request);
  assert.equal(rejected.state, 'rejected'); assert.equal(rejected.reason, 'invalid_answer');
  assert.equal(f.state().deliveries.length, before);
  assert.equal(f.state().tool_requests[0].state, 'pending');
  assert.equal(f.log().filter(row => row.type === 'tool_response').length, 0);
  // Only the answer field changes; the same key and card remain usable.
  const accepted = f.core.submit({ ...request, body: { answer: 'A' } });
  await f.completed(prompt);
  assert.equal(f.d(accepted).state, 'provider_observed');
  assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
});

for (const count of [1, 2]) check('R5 string answer requires exactly one question count=' + count, async (t, sdk) => {
  const f = await fixture(t, sdk, { questionCount: count, contentArray: true }); await f.start();
  const prompt = f.prompt('question'); const tool = await f.pendingTool();
  const before = f.state().deliveries.length;
  const answer = f.core.submit(f.req('question_answer', { target_tool_use_id: tool.tool_use_id, body: { answer: 'A' } }));
  if (count === 1) {
    await f.completed(prompt); assert.equal(f.d(answer).state, 'provider_observed');
  } else {
    assert.equal(answer.state, 'rejected'); assert.equal(answer.reason, 'invalid_answer');
    assert.equal(f.state().deliveries.length, before); assert.equal(f.state().tool_requests[0].state, 'pending');
    assert.equal(f.log().filter(row => row.type === 'tool_response').length, 0);
    f.core.submit(f.req('question_answer', { target_tool_use_id: tool.tool_use_id, body: { answer: { 'Which?': 'A', 'Why?': 'B' } } }));
    await f.completed(prompt);
  }
});

for (const force of [false, true]) check('R5 decide failure settles SDK promise with deny force=' + force, async (t, sdk) => {
  const f = await fixture(t, sdk, {}, { testHooks: { beforeDecide() { if (force) throw Error('forced_decide_failure'); } } });
  await f.start(); const prompt = f.prompt('tool'); const tool = await f.pendingTool();
  const decision = f.core.submit(f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body: { behavior: 'allow' } }));
  await f.completed(prompt);
  if (force) {
    assert.equal(f.d(decision).state, 'unknown'); assert.equal(f.d(decision).reason, 'effect_failed');
    const response = f.log().find(row => row.type === 'tool_response');
    assert.equal(response.behavior, 'deny'); assert.equal(response.message, 'invalid_decision');
    assert.equal(f.log().filter(row => row.type === 'tool').length, 0);
    assert.equal(f.core.idle(f.sid), true);
    assert.equal(f.state().incarnations.at(-1).attribution_uncertain, 0);
    await f.completed(f.prompt('after failed decision'));
  } else {
    assert.equal(f.d(decision).state, 'provider_observed'); assert.equal(f.log().filter(row => row.type === 'tool').length, 1);
  }
});

for (const body of [{ behavior: 'invalid' }, { behavior: 'allow', message: 3 }]) {
  check('R5 invalid tool decision preserves pending card ' + JSON.stringify(body), async (t, sdk) => {
    const f = await fixture(t, sdk); await f.start(); const prompt = f.prompt('tool'); const tool = await f.pendingTool();
    const before = f.state().deliveries.length;
    const request = f.req('tool_decision', { target_tool_use_id: tool.tool_use_id, body });
    const rejected = f.core.submit(request);
    assert.equal(rejected.state, 'rejected'); assert.equal(rejected.reason, 'invalid_decision');
    assert.equal(f.state().tool_requests[0].state, 'pending'); assert.equal(f.state().deliveries.length, before);
    assert.equal(f.log().filter(row => row.type === 'tool_response').length, 0);
    const accepted = f.core.submit({ ...request, body: { ...body, ...(body.behavior === 'invalid' ? { behavior: 'allow' } : { message: 'ok' }) } });
    await f.completed(prompt); assert.equal(f.d(accepted).state, 'provider_observed');
  });
}
