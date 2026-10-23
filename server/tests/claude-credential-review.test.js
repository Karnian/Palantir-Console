'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

function setup(t) {
  const saved = { ...process.env };
  for (const k of ['PALANTIR_SKIP_HOST_CREDENTIALS', 'PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[k];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-review-'));
  process.env.PALANTIR_CLAUDE_AUTH_FILE = path.join(root, 'auth.json');
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function fresh(file) { const id = require.resolve(file); delete require.cache[id]; return require(id); }

for (const legacy of [false, true]) test(`review: actual API helper preserves legacy=${legacy} semantics`, t => {
  setup(t);
  if (legacy) process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
  const { resolveActualAnthropicApiKey } = fresh('../services/authResolver');
  for (const value of [undefined, null, '', 'sk-ant-api-fixture']) assert.equal(resolveActualAnthropicApiKey(value), value);
  assert.equal(resolveActualAnthropicApiKey('sk-ant-oat-fixture'), legacy ? 'sk-ant-oat-fixture' : null);
});

test('review: only PALANTIR_CLAUDE_AUTH_FILE overrides the saved auth path', t => {
  const root = setup(t);
  delete process.env.PALANTIR_CLAUDE_AUTH_FILE;
  process.env.CLAUDE_AUTH_FILE = path.join(root, 'unrequested-override');
  const auth = fresh('../services/authResolver');
  assert.equal(auth.CLAUDE_AUTH_FILE, path.resolve(__dirname, '../../.claude-auth.json'));
  process.env.PALANTIR_CLAUDE_AUTH_FILE = path.join(root, 'requested-override');
  assert.equal(fresh('../services/authResolver').CLAUDE_AUTH_FILE, process.env.PALANTIR_CLAUDE_AUTH_FILE);
});

for (const platform of ['darwin', 'linux']) for (const skip of [false, true]) {
  test(`review: actual readers have zero underlying access on ${platform}, legacy plus skip=${skip}`, async t => {
    const root = setup(t);
    if (skip) {
      process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
      process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
    }
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    t.after(() => Object.defineProperty(process, 'platform', descriptor));
    const calls = { exec: 0, syncExec: 0, read: 0, write: 0, spawn: 0 };
    const payload = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' }, CLAUDE_CODE_OAUTH_TOKEN: 'fixture-token' });
    t.mock.method(cp, 'execFile', (...args) => { calls.exec++; queueMicrotask(() => args.at(-1)(null, payload, '')); });
    t.mock.method(cp, 'execFileSync', () => { calls.syncExec++; return payload; });
    t.mock.method(cp, 'spawn', () => { calls.spawn++; throw new Error('forbidden spawn'); });
    const originalRead = fs.readFileSync;
    const credentialPath = p => String(p) === process.env.PALANTIR_CLAUDE_AUTH_FILE || String(p).endsWith(path.join('.claude', '.credentials.json'));
    t.mock.method(fs, 'readFileSync', (p, ...args) => {
      if (credentialPath(p)) { calls.read++; return payload; }
      return originalRead(p, ...args);
    });
    t.mock.method(fsp, 'readFile', async () => { calls.read++; return payload; });
    const originalWrite = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (p, ...args) => {
      if (credentialPath(p)) { calls.write++; return; }
      return originalWrite(p, ...args);
    });
    // All lower-level mocks are installed BEFORE the resolver captures them.
    const auth = fresh('../services/authResolver');
    for (const reader of ['readClaudeKeychainToken', 'readClaudeKeychainTokenSync',
      'readClaudeLinuxCredentialsToken', 'readClaudeLinuxCredentialsTokenSync']) {
      assert.equal(await auth[reader](), null, reader);
      assert.deepEqual(calls, { exec: 0, syncExec: 0, read: 0, write: 0, spawn: 0 }, reader);
    }
    fs.mkdirSync(path.dirname(auth.CLAUDE_AUTH_FILE), { recursive: true });
    originalWrite(auth.CLAUDE_AUTH_FILE, payload);
    const predicates = { hasKeychain: () => false, hasCredentialsFile: () => false };
    assert.deepEqual(auth.resolveClaudeAuth(predicates).env, {});
    assert.deepEqual((await auth.resolveClaudeAuthForIsolated(predicates)).env, {});
    assert.deepEqual(calls, { exec: 0, syncExec: 0, read: 0, write: 0, spawn: 0 });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-fixture';
    auth.bootstrapClaudeAuthFromEnv({ logger: { log() {}, warn() {} } });
    assert.deepEqual(calls, { exec: 0, syncExec: 0, read: 0, write: 0, spawn: 0 });
    if (skip) {
      const result = await fresh('../services/providers/claude-code').fetchClaudeCodeUsage();
      assert.equal(result.limits[0].remainingPct, null);
      assert.deepEqual(calls, { exec: 0, syncExec: 0, read: 0, write: 0, spawn: 0 });
    }
    assert.equal(fs.existsSync(path.join(root, 'auth.json')), true);
  });
}

for (const [legacy, key] of [[false, 'sk-ant-oat-fixture'], [true, 'sk-ant-oat-fixture'], [false, 'sk-ant-api-fixture']]) {
  test(`review: createApp HTTP consumers enforce policy, legacy=${legacy}, key=${key}`, t => {
    const root = setup(t);
    process.env.ANTHROPIC_API_KEY = key;
    if (legacy) process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
    process.env.PALANTIR_GOAL_MODE = '1'; process.env.PALANTIR_GOAL_JUDGE = '1';
    const judge = require('../services/goalJudgeService');
    const specialist = require('../services/specialistBackend');
    const judgeCalls = [], specialistCalls = [];
    t.mock.method(judge, 'createGoalJudge', options => { judgeCalls.push(options); return { runJudge() {} }; });
    const originalSpecialist = specialist.createSpecialistBackend;
    t.mock.method(specialist, 'createSpecialistBackend', options => { specialistCalls.push(options); return originalSpecialist(options); });
    const { createApp } = fresh('../app');
    const app = createApp({ storageRoot: root, fsRoot: root, dbPath: path.join(root, 'test.db'),
      authToken: 'human-fixture', pmToken: 'agent-fixture', execAttestation: { verified: true, reason: 'fixture' },
      operatorSchedulerEnabled: false, operatorSpecialistEnabled: true, memoryDistillEnabled: true,
      authResolverOpts: { hasKeychain: () => false, hasCredentialsFile: () => false }, memoryDistillClaudeBin: null });
    t.after(() => app.shutdown());
    const accepted = legacy || !key.startsWith('sk-ant-oat');
    assert.equal(app.services.getMemoryDistillStatus().state, accepted ? 'running' : 'missing_credential');
    if (accepted) assert.equal(app.services.getMemoryDistillStatus().backend, 'anthropic_api');
    assert.equal(judgeCalls.length, accepted ? 1 : 0);
    assert.equal(specialistCalls.length, accepted ? 1 : 0);
    assert.equal(!!app.services.specialistService, accepted);
    if (accepted) {
      assert.equal(judgeCalls[0].apiKey, key); assert.equal(specialistCalls[0].apiKey, key);
    }
  });
}

test('review: legacy usage prefers OAuth API-key slot before native readers', async t => {
  setup(t);
  process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-api-slot';
  let reads = 0, header = '';
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, cb) { header += chunk; cb(); }, final(cb) {
      child.stdout.end('{"five_hour":{"utilization":10}}'); child.emit('close', 0); cb();
    } });
    return child;
  };
  const usage = fresh('../services/providers/claude-code');
  const opts = { spawn, execFile: async () => ({ stdout: '{}' }),
    readKeychainToken: () => { reads++; return 'keychain-fixture'; },
    readCredentialsFileToken: () => { reads++; return 'file-fixture'; } };
  const result = await usage.fetchClaudeCodeUsage(opts);
  assert.equal(result.limits[0].remainingPct, 90);
  assert.equal(reads, 0);
  assert.equal(header, 'Authorization: Bearer sk-ant-oat-api-slot\n');
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'explicit-oauth-fixture'; header = '';
  await usage.fetchClaudeCodeUsage(opts);
  assert.equal(header, 'Authorization: Bearer explicit-oauth-fixture\n');
  assert.equal(reads, 0);
});

test('review: local executor probes cannot implicitly inherit OAuth env', t => {
  setup(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'probe-oauth';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-probe';
  const calls = [];
  t.mock.method(cp, 'spawn', (command, args, options) => { calls.push({ command, args, options }); return {}; });
  const { createLocalNodeExecutor } = fresh('../services/nodeExecutor');
  const executor = createLocalNodeExecutor();
  executor.spawnInteractive('claude', ['--version']);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].options.env);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  executor.spawnInteractive('claude', ['auth', 'status'], { env: { ANTHROPIC_API_KEY: 'sk-ant-api-probe' } });
  assert.equal(calls[1].options.env.ANTHROPIC_API_KEY, 'sk-ant-api-probe');
});
