'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { withLegacyClaudeCredentialAccess } = require('./helpers/host-credential-discovery');

function setup(t) {
  const saved = { ...process.env };
  for (const k of ['PALANTIR_SKIP_HOST_CREDENTIALS', 'PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS',
    'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete process.env[k];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-policy-'));
  process.env.PALANTIR_CLAUDE_AUTH_FILE = path.join(dir, 'auth.json');
  const id = require.resolve('../services/authResolver');
  delete require.cache[id];
  const auth = require(id);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    delete require.cache[id];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return auth;
}
const noNative = { hasKeychain: () => false, hasCredentialsFile: () => false };
const silent = { log() {}, warn() {} };

test('A: default bootstrap purges OAuth env without saving; existing file is unread and warned once', t => {
  const auth = setup(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-fixture';
  auth.bootstrapClaudeAuthFromEnv({ logger: silent });
  assert.equal(fs.existsSync(auth.CLAUDE_AUTH_FILE), false);
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  fs.writeFileSync(auth.CLAUDE_AUTH_FILE, JSON.stringify({ CLAUDE_CODE_OAUTH_TOKEN: 'saved-fixture' }));
  const warnings = [];
  const fileRead = t.mock.method(fs, 'readFileSync', () => { throw new Error('file content must not be read'); });
  const logger = { log() {}, warn: s => warnings.push(s) };
  auth.bootstrapClaudeAuthFromEnv({ logger }); auth.bootstrapClaudeAuthFromEnv({ logger });
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(fileRead.mock.callCount(), 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS/);
  assert.equal(fs.existsSync(auth.CLAUDE_AUTH_FILE), true);
});

test('A legacy save/load and exact switch semantics; skip wins', t => {
  const auth = setup(t);
  for (const value of ['0', 'true', 'yes', '']) {
    process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = value;
    assert.equal(auth.legacyClaudeCredentialAccessEnabled(), false);
  }
  withLegacyClaudeCredentialAccess(() => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth';
    assert.equal(auth.bootstrapClaudeAuthFromEnv({ logger: silent }), true);
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    assert.equal(auth.bootstrapClaudeAuthFromEnv({ logger: silent }), true);
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-oauth');
    process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
    assert.equal(auth.legacyClaudeCredentialAccessEnabled(), false);
  });
});

test('C D E: default resolvers and final manager env block OAuth even on allowlist without reading stores', async t => {
  const auth = setup(t);
  let readerCalls = 0;
  const forbidden = () => { readerCalls++; throw new Error('credential reader called'); };
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-oauth';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-fixture';
  fs.writeFileSync(auth.CLAUDE_AUTH_FILE, '{}');
  const native = { hasKeychain: () => true, hasCredentialsFile: () => true,
    readKeychainTokenSync: forbidden, readCredentialsFileTokenSync: forbidden,
    readKeychainToken: forbidden, readCredentialsFileToken: forbidden };
  t.mock.method(fs, 'readFileSync', forbidden);
  const normal = auth.resolveClaudeAuth(native);
  assert.equal(readerCalls, 0);
  assert.equal(normal.canAuth, true); // CLI can read its own login.
  assert.equal(normal.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(normal.env.ANTHROPIC_API_KEY, undefined);
  const bare = auth.resolveClaudeAuth({ ...native, bare: true });
  assert.equal(readerCalls, 0);
  assert.equal(bare.canAuth, false);
  assert.match(bare.diagnostics.join(' '), /PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS/);
  assert.equal((await auth.resolveClaudeAuthForIsolated(native)).canAuth, false);
  assert.equal(readerCalls, 0);
  const allow = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const spawnEnv = auth.buildManagerSpawnEnv({ baseEnv: process.env, authEnv: process.env, envAllowlist: allow });
  assert.equal(spawnEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(spawnEnv.ANTHROPIC_API_KEY, undefined);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-fixture';
  assert.equal(auth.resolveClaudeAuth({ ...noNative, bare: true }).env.ANTHROPIC_API_KEY, 'sk-ant-api-fixture');
  assert.equal((await auth.resolveClaudeAuthForIsolated({ ...native, prefer: 'env' })).canAuth, true);
  assert.equal(readerCalls, 0);
  withLegacyClaudeCredentialAccess(() => {
    assert.equal(auth.buildManagerSpawnEnv({ baseEnv: process.env, envAllowlist: allow }).CLAUDE_CODE_OAUTH_TOKEN, 'fixture-oauth');
  });
});

function provider() {
  delete require.cache[require.resolve('../services/providers/claude-code')];
  return require('../services/providers/claude-code');
}

test('B: default usage never reads native tokens or spawns curl; actual API key never becomes Bearer in either mode', async t => {
  setup(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ignored-env-oauth';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-ignored';
  let calls = 0;
  const fail = () => { calls++; throw new Error('forbidden'); };
  const opts = { execFile: async (command, args, options) => {
    assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(options.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-oat') ? undefined : process.env.ANTHROPIC_API_KEY);
    return { stdout: '{"loggedIn":true,"email":"fixture"}' };
  },
    spawn: fail, readKeychainToken: fail, readCredentialsFileToken: fail };
  const result = await provider().fetchClaudeCodeUsage(opts);
  assert.equal(calls, 0);
  assert.equal(result.limits.length, 1);
  assert.equal(result.limits[0].remainingPct, null);
  assert.match(result.limits[0].errorMessage, /PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS/);
  assert.equal(result.account.email, 'fixture');
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-fixture';
  await provider().fetchClaudeCodeUsage(opts);
  await withLegacyClaudeCredentialAccess(() => provider().fetchClaudeCodeUsage({ ...opts,
    readKeychainToken: () => null, readCredentialsFileToken: () => null }));
  assert.equal(calls, 0);
});

test('B legacy: curl uses stdin, clean env, -q, and refuses control characters', async t => {
  setup(t);
  await withLegacyClaudeCredentialAccess(async () => {
    let calls = 0; let header = '';
    const token = 'fixture-oauth-secret';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-other';
    const opts = { execFile: async () => ({ stdout: '{}' }), spawn(command, args, options) {
      calls++;
      assert.equal(command, 'curl'); assert.equal(args[0], '-q');
      assert.ok(args.includes('@-')); assert.ok(!args.join(' ').includes(token));
      for (const key of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) assert.equal(options.env[key], undefined);
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, enc, cb) { header += chunk; cb(); }, final(cb) {
        child.stdout.end('{"five_hour":{"utilization":10}}'); child.emit('close', 0); cb();
      } });
      return child;
    } };
    const result = await provider().fetchClaudeCodeUsage(opts);
    assert.equal(result.limits[0].remainingPct, 90);
    assert.equal(header, `Authorization: Bearer ${token}\n`);
    for (const bad of ['bad\rvalue', 'bad\nvalue']) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = bad;
      const rejected = await provider().fetchClaudeCodeUsage(opts);
      assert.equal(rejected.limits[0].remainingPct, null);
    }
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    const nul = await provider().fetchClaudeCodeUsage({ ...opts, readKeychainToken: () => 'bad\0value' });
    assert.equal(nul.limits[0].remainingPct, null);
    assert.equal(calls, 1);
  });
});

test('B prime: default remote usage executes no SSH probe', async t => {
  setup(t);
  const { createRemoteSshNodeExecutor } = require('../services/remoteSshExecutor');
  let calls = 0;
  const executor = createRemoteSshNodeExecutor({ kind: 'ssh', ssh_host: 'fixture', ssh_user: 'fixture', exposed_roots: '["/srv/root"]' },
    { spawnFn: () => { calls++; throw new Error('must not run'); } });
  const result = await executor.readClaudeOAuthUsage();
  assert.equal(calls, 0);
  assert.equal(JSON.parse(result.stdout).state, 'quota_unsupported');
});

test('F: Linux existence checks stat only, including malformed and empty files', t => {
  const auth = setup(t);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const file = path.join(path.dirname(auth.CLAUDE_AUTH_FILE), 'credentials');
  fs.writeFileSync(file, 'not JSON');
  const stat = fs.statSync.bind(fs);
  t.mock.method(fs, 'statSync', p => stat(p === auth.CLAUDE_LINUX_CREDENTIALS_FILE ? file : p));
  const fileRead = t.mock.method(fs, 'readFileSync', () => { throw new Error('must not read'); });
  assert.equal(auth.hasClaudeLinuxCredentials(), true);
  fs.writeFileSync(file, '');
  assert.equal(auth.hasClaudeLinuxCredentials(), false);
  assert.equal(fileRead.mock.callCount(), 0);
  withLegacyClaudeCredentialAccess(() => {
    assert.equal(auth.hasClaudeLinuxCredentials(), false);
    fs.writeFileSync(file, 'not JSON');
    assert.equal(auth.hasClaudeLinuxCredentials(), true);
    assert.equal(fileRead.mock.callCount(), 0);
  });
});

test('E: session hub final env filters injected OAuth auth and preserves a real API key', async t => {
  setup(t);
  const { serviceFixture } = require('./helpers/session-hub-service-fixture.cjs');
  const fx = serviceFixture(t, { resolveAuth: () => ({ env: {
    CLAUDE_CODE_OAUTH_TOKEN: 'injected-oauth', ANTHROPIC_API_KEY: 'sk-ant-oat-injected',
  } }) });
  await fx.service.start();
  const env = fx.calls[0].options.env;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  const real = serviceFixture(t, { resolveAuth: () => ({ env: { ANTHROPIC_API_KEY: 'sk-ant-api-fixture' } }) });
  await real.service.start();
  assert.equal(real.calls[0].options.env.ANTHROPIC_API_KEY, 'sk-ant-api-fixture');
  await withLegacyClaudeCredentialAccess(async () => {
    const legacy = serviceFixture(t, { resolveAuth: () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'legacy-fixture' } }) });
    await legacy.service.start();
    assert.equal(legacy.calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, 'legacy-fixture');
  });
});

test('D prime: a live CLI distiller rechecks credential policy at each call', async t => {
  setup(t);
  const { createLiveDistiller } = require('../services/distillers/liveDistiller');
  let calls = 0;
  let distiller;
  withLegacyClaudeCredentialAccess(() => {
    distiller = createLiveDistiller({ cliBin: '/fixture/claude',
      spawnImpl: () => { calls++; throw new Error('must not spawn'); } });
  });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ignored-oauth-fixture';
  await assert.rejects(() => distiller.distill({ candidates: [{ id: 'fixture', kind: 'heuristic', content: 'fixture' }] }),
    /PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS/);
  assert.equal(calls, 0);
});
