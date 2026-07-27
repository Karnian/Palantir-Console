'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveDotEnvPath,
  assertNoActorTokensInDotEnv,
  consumeActorTokenFile,
  prepareActorTokenEnvironment,
  resolveActorTokenPolicy,
  scanAmbientActorTokens,
  hadAmbientActorTokensAtLoad,
  buildWorkerProcessEnv,
  augmentProcessPath,
  applyManagerCredentialPolicy,
  applyWorkerCredentialPolicy,
  createWorkerProposalTokenService,
  createManagerCapabilityTokenService,
} = require('../services/actorTokenPolicy');
const { createAuthMiddleware } = require('../middleware/auth');

function isolatedPolicy(env = {}) {
  return resolveActorTokenPolicy({
    ...env,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  });
}

// The attenuated grade requires a bootstrap that keeps PALANTIR_TOKEN out of
// the Console's environment; otherwise an agent can read it and present it as a
// cookie, bypassing every capability limit. Tests that want the grade must say
// so, exactly as an operator has to.
function attenuatedPolicy(env = {}) {
  return resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    ...env,
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  });
}

test('actor token policy separates token-source assurance from process isolation', () => {
  assert.deepEqual(resolveActorTokenPolicy({}), {
    humanToken: null,
    agentToken: null,
    separated: false,
    processIsolated: false,
    capabilitiesForcedDisabled: false,
    capabilityTier: 'disabled',
    capabilitiesEnabled: false,
    boundary: 'auth_disabled',
  });
  // A token that reached the Console through its own environment cannot support
  // the attenuated grade: a same-UID agent reads `/proc/<pid>/environ`, presents
  // PALANTIR_TOKEN as a cookie, and the allowlist/TTL/run-binding/audit never
  // see the request at all.
  assert.equal(resolveActorTokenPolicy({ PALANTIR_TOKEN: 'shared' }).capabilityTier, 'disabled');
  assert.equal(resolveActorTokenPolicy({ PALANTIR_TOKEN: 'shared' }).boundary, 'agent_capabilities_disabled');
  assert.equal(attenuatedPolicy({ PALANTIR_TOKEN: 'shared' }).boundary, 'shared_uid_attenuated');
  assert.equal(attenuatedPolicy({
    PALANTIR_TOKEN: 'same',
    PALANTIR_PM_TOKEN: 'same',
  }).boundary, 'shared_uid_attenuated');

  const separated = attenuatedPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
  });
  assert.equal(separated.boundary, 'shared_uid_attenuated');
  assert.equal(separated.humanToken, 'human-secret');
  assert.equal(separated.agentToken, 'agent-secret');
  assert.equal(separated.separated, true);
  assert.equal(separated.processIsolated, false);
  assert.equal(separated.capabilityTier, 'shared_uid_attenuated');
  assert.equal(separated.capabilitiesEnabled, true);
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  }).boundary, 'shared_uid_attenuated');
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  }).boundary, 'run_capabilities_unverified');
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  }).boundary, 'run_capabilities');
});

test('repository dotenv files cannot contain actor credentials', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-dotenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=4177\nPALANTIR_TOKEN=readable-secret\n');
  assert.throws(
    () => assertNoActorTokensInDotEnv({ cwd: dir, env: {}, fsImpl: fs }),
    (err) => err.code === 'PALANTIR_ACTOR_TOKEN_IN_DOTENV'
      && !err.message.includes('readable-secret'),
  );
});

test('dotenv security check and loader resolve the same configured path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-dotenv-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=4177\n');
  fs.writeFileSync(path.join(dir, 'custom.env'), 'PALANTIR_TOKEN=custom-secret\n');
  const env = { DOTENV_CONFIG_PATH: 'custom.env' };
  const envPath = resolveDotEnvPath({ cwd: dir, env });

  assert.equal(envPath, path.join(dir, 'custom.env'));
  assert.throws(
    () => assertNoActorTokensInDotEnv({ cwd: dir, env, envPath, fsImpl: fs }),
    (err) => err.code === 'PALANTIR_ACTOR_TOKEN_IN_DOTENV'
      && !err.message.includes('custom-secret'),
  );
});

test('dotenv actor credential keys are rejected case-insensitively', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-dotenv-case-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, '.env'),
    'palantir_token=human-secret\nPalantir_Pm_Token=manager-secret\n',
  );

  assert.throws(
    () => assertNoActorTokensInDotEnv({ cwd: dir, env: {}, fsImpl: fs }),
    (err) => err.code === 'PALANTIR_ACTOR_TOKEN_IN_DOTENV'
      && err.message.includes('PALANTIR_TOKEN')
      && err.message.includes('PALANTIR_PM_TOKEN')
      && !err.message.includes('human-secret')
      && !err.message.includes('manager-secret'),
  );
});

test('PALANTIR_SKIP_DOTENV skips inspection but still consumes an explicit token file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-dotenv-skip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'PALANTIR_TOKEN=ignored-developer-secret\n');
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'isolated-human-secret',
  }), { mode: 0o600 });
  const env = {
    PALANTIR_SKIP_DOTENV: '1',
    PALANTIR_ACTOR_TOKEN_FILE: tokenPath,
  };

  const result = prepareActorTokenEnvironment({ cwd: dir, env, fsImpl: fs });

  assert.equal(result.authToken, 'isolated-human-secret');
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(fs.existsSync(path.join(dir, '.env')), true);
});

test('one-shot actor token file is mode-checked, consumed, and unlinked', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'manager-secret',
  }), { mode: 0o600 });
  const env = {
    PALANTIR_ACTOR_TOKEN_FILE: tokenPath,
    PALANTIR_TOKEN: 'ambient-human-must-be-removed',
    palantir_pm_token: 'ambient-manager-must-be-removed',
  };
  const result = consumeActorTokenFile({ env, cwd: dir, fsImpl: fs });
  // Ambient actor tokens were present at exec, so `/proc/<pid>/environ` still
  // exposes them however thoroughly `process.env` is cleaned afterwards. The
  // boot is reported as tainted, which withholds the attenuated grade — this
  // configuration used to be accepted as fully assured.
  assert.equal(result.source, 'ephemeral_file_tainted');
  assert.equal(result.ambientActorTokens, true);
  assert.equal(fs.existsSync(tokenPath), false);
  assert.equal(result.authToken, 'human-secret');
  assert.equal(result.pmToken, 'manager-secret');
  assert.equal(
    Object.keys(env).some((key) => (
      key.toUpperCase() === 'PALANTIR_TOKEN'
      || key.toUpperCase() === 'PALANTIR_PM_TOKEN'
    )),
    false,
  );
  assert.equal('PALANTIR_ACTOR_TOKEN_SOURCE' in env, false);
  assert.equal('PALANTIR_ACTOR_TOKEN_FILE' in env, false);
});

test('one-shot actor token file is read through its validated descriptor', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-fd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'descriptor-human-secret',
  }), { mode: 0o600 });
  const reads = [];
  const fsImpl = {
    ...fs,
    readFileSync(target, ...args) {
      reads.push(target);
      return fs.readFileSync(target, ...args);
    },
  };

  const result = consumeActorTokenFile({
    env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath },
    cwd: dir,
    fsImpl,
  });

  assert.equal(result.authToken, 'descriptor-human-secret');
  assert.equal(reads.length, 1);
  assert.equal(typeof reads[0], 'number');
});

test('one-shot actor token file rejects a second hard link', (t) => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-hardlink-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  const linkedPath = path.join(dir, 'retained.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'human-secret',
  }), { mode: 0o600 });
  fs.linkSync(tokenPath, linkedPath);

  assert.throws(
    () => consumeActorTokenFile({
      env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath },
      cwd: dir,
      fsImpl: fs,
    }),
    /exactly one hard link/,
  );
  assert.equal(fs.existsSync(tokenPath), true);
  assert.equal(fs.existsSync(linkedPath), true);
});

test('one-shot actor token file rejects an entry swapped before descriptor open', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  const replacementPath = path.join(dir, 'replacement.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'original-human-secret',
  }), { mode: 0o600 });
  fs.writeFileSync(replacementPath, JSON.stringify({
    PALANTIR_TOKEN: 'attacker-known-secret',
  }), { mode: 0o600 });
  let opened = false;
  const fsImpl = {
    ...fs,
    openSync(target, flags) {
      if (!opened) {
        opened = true;
        fs.renameSync(replacementPath, tokenPath);
      }
      return fs.openSync(target, flags);
    },
  };

  assert.throws(
    () => consumeActorTokenFile({
      env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath },
      cwd: dir,
      fsImpl,
    }),
    /changed while opening/,
  );
});

test('one-shot actor token file detects a path swap during final unlink', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-unlink-swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  const retainedPath = path.join(dir, 'retained-secret.json');
  const replacementPath = path.join(dir, 'replacement.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'original-human-secret',
  }), { mode: 0o600 });
  fs.writeFileSync(replacementPath, JSON.stringify({
    PALANTIR_TOKEN: 'attacker-known-secret',
  }), { mode: 0o600 });
  const fsImpl = {
    ...fs,
    unlinkSync(target) {
      fs.renameSync(tokenPath, retainedPath);
      fs.renameSync(replacementPath, tokenPath);
      return fs.unlinkSync(target);
    },
  };

  assert.throws(
    () => consumeActorTokenFile({
      env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath },
      cwd: dir,
      fsImpl,
    }),
    /validated file was not unlinked/,
  );
  assert.equal(fs.existsSync(retainedPath), true);
});

test('one-shot actor token file fails closed while group/world-readable', (t) => {
  if (process.platform === 'win32') return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-mode-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'manager-secret',
  }), { mode: 0o644 });
  const env = { PALANTIR_ACTOR_TOKEN_FILE: tokenPath };
  assert.throws(
    () => consumeActorTokenFile({ env, cwd: dir, fsImpl: fs }),
    /mode 0600 or stricter/,
  );
  assert.equal(fs.existsSync(tokenPath), true);
  assert.equal('PALANTIR_TOKEN' in env, false);
});

test('one-shot actor token file fails closed on Windows without an ACL verifier', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-windows-acl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({
    PALANTIR_TOKEN: 'human-secret',
  }), { mode: 0o600 });

  assert.throws(
    () => consumeActorTokenFile({
      env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath },
      cwd: dir,
      fsImpl: fs,
      platform: 'win32',
    }),
    /unsupported on Windows.*ACL/,
  );
  assert.equal(fs.existsSync(tokenPath), true);
});

test('worker environment removes global actor tokens and keeps only an explicit scoped grant', () => {
  const env = buildWorkerProcessEnv({
    PATH: '/bin',
    CODEX_API_KEY: 'ambient-codex-secret',
    MCP_BEARER_TOKEN: 'ambient-mcp-secret',
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_WORKER_TOKEN: 'ambient-worker',
    PALANTIR_MANAGER_TOKEN: 'ambient-manager-capability',
  }, {
    EXTRA: 'ok',
    PALANTIR_TOKEN: 'profile-smuggle',
    PALANTIR_PM_TOKEN: 'profile-override',
    PALANTIR_WORKER_TOKEN: 'scoped-run-token',
    PALANTIR_MANAGER_TOKEN: 'profile-manager-capability',
  });
  assert.equal('PALANTIR_TOKEN' in env, false);
  assert.equal('PALANTIR_PM_TOKEN' in env, false);
  assert.equal(env.PALANTIR_WORKER_TOKEN, 'scoped-run-token');
  assert.equal('PALANTIR_MANAGER_TOKEN' in env, false);
  assert.equal(env.EXTRA, 'ok');
  assert.equal(env.PATH, '/bin');
  assert.equal('CODEX_API_KEY' in env, false);
  assert.equal('MCP_BEARER_TOKEN' in env, false);
});

test('worker environment admits a credential only when the caller explicitly allowlists it', () => {
  const env = buildWorkerProcessEnv({
    PATH: '/bin',
    CODEX_API_KEY: 'ambient-codex-secret',
  }, {
    CODEX_API_KEY: 'explicit-allowlisted-secret',
  });
  assert.equal(env.CODEX_API_KEY, 'explicit-allowlisted-secret');
});

test('worker environment preserves the non-secret Windows subprocess baseline', () => {
  const env = buildWorkerProcessEnv({
    Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    USERPROFILE: 'C:\\Users\\worker',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    APPDATA: 'C:\\Users\\worker\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
    PALANTIR_TOKEN: 'human-secret',
  }, {
    palantir_pm_token: 'case-insensitive-smuggle',
  });

  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Program Files\\nodejs');
  assert.equal(env.USERPROFILE, 'C:\\Users\\worker');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  assert.equal(env.APPDATA, 'C:\\Users\\worker\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\worker\\AppData\\Local');
  assert.equal(
    Object.keys(env).some((key) => key.toUpperCase() === 'PALANTIR_TOKEN'
      || key.toUpperCase() === 'PALANTIR_PM_TOKEN'),
    false,
  );
});

test('shared-token worker environment never inherits the human credential', () => {
  const env = buildWorkerProcessEnv({
    PALANTIR_TOKEN: 'shared-secret',
  }, { EXTRA: 'ok' });
  assert.equal('PALANTIR_TOKEN' in env, false);
  assert.equal('PALANTIR_PM_TOKEN' in env, false);
  assert.equal(env.EXTRA, 'ok');
});

test('a resolved app policy overrides ambient process credentials at spawn seams', () => {
  const appPolicy = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'app-human',
    PALANTIR_PM_TOKEN: 'app-agent',
  });
  const env = buildWorkerProcessEnv({
    PALANTIR_TOKEN: 'ambient-human',
    PALANTIR_PM_TOKEN: 'ambient-agent',
    PATH: '/bin',
  }, {
    PALANTIR_TOKEN: 'profile-human',
    PALANTIR_PM_TOKEN: 'profile-agent',
  }, appPolicy);

  assert.equal('PALANTIR_TOKEN' in env, false);
  assert.equal('PALANTIR_PM_TOKEN' in env, false);
});

test('manager credential policy scrubs ambient credentials', () => {
  const env = applyManagerCredentialPolicy({
    PALANTIR_TOKEN: 'ambient-human',
    PALANTIR_PM_TOKEN: 'ambient-agent',
    PALANTIR_MANAGER_TOKEN: 'stale-manager-capability',
    EXTRA: 'ok',
  });

  assert.deepEqual(env, { EXTRA: 'ok' });
});

test('manager credential policy injects only the explicit run capability', () => {
  const env = applyManagerCredentialPolicy({
    PALANTIR_TOKEN: 'ambient-human',
    PALANTIR_PM_TOKEN: 'ambient-agent',
    PALANTIR_MANAGER_TOKEN: 'stale-manager-capability',
    PATH: '/bin',
  }, {
    managerToken: 'current-run-capability',
    actorTokens: isolatedPolicy({ PALANTIR_TOKEN: 'human' }),
  });

  assert.deepEqual(env, {
    PATH: '/bin',
    PALANTIR_MANAGER_TOKEN: 'current-run-capability',
  });
});

test('PATH augmentation preserves Windows Path casing and removes duplicates', () => {
  const env = augmentProcessPath({
    PATH: '',
    Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    USERPROFILE: 'C:\\Users\\worker',
  }, [
    'C:\\Program Files\\Palantir\\bin',
  ], {
    delimiter: ';',
  });

  assert.equal(
    env.Path,
    'C:\\Program Files\\Palantir\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs',
  );
  assert.equal('PATH' in env, false);
  assert.equal(env.USERPROFILE, 'C:\\Users\\worker');
});

test('manager process environment never receives global actor credentials', () => {
  const env = applyManagerCredentialPolicy({
    PALANTIR_TOKEN: 'human',
    PALANTIR_PM_TOKEN: 'manager',
    palantir_token: 'case-human',
    Palantir_Pm_Token: 'case-manager',
    PATH: '/bin',
  });
  assert.deepEqual(env, { PATH: '/bin' });
});

test('worker credential policy pins a run-bound token and proposal base', () => {
  const env = applyWorkerCredentialPolicy({
    PALANTIR_TOKEN: 'human',
    PALANTIR_PM_TOKEN: 'manager',
    PALANTIR_WORKER_TOKEN: 'profile-smuggle',
    EXTRA: 'ok',
  }, {
    workerToken: 'run-only',
    apiBase: 'http://console.internal:4177/',
    actorTokens: isolatedPolicy({ PALANTIR_TOKEN: 'human' }),
  });
  assert.deepEqual(env, {
    EXTRA: 'ok',
    PALANTIR_WORKER_TOKEN: 'run-only',
    PALANTIR_API_BASE: 'http://console.internal:4177',
  });
});

test('worker proposal tokens are signed and bound to one run id', () => {
  const service = createWorkerProposalTokenService({
    actorTokens: isolatedPolicy({
      PALANTIR_TOKEN: 'human-secret',
      PALANTIR_PM_TOKEN: 'manager-secret',
    }),
  });
  const token = service.mint('run_alpha', { projectId: 'proj_one' });
  assert.deepEqual(service.verify(token), { runId: 'run_alpha', projectId: 'proj_one' });
  assert.equal(service.verify(`${token}tampered`), null);

  const disabled = createWorkerProposalTokenService({
    actorTokens: resolveActorTokenPolicy({}),
  });
  assert.equal(disabled.mint('run_alpha', { projectId: 'proj_one' }), null);
  assert.equal(disabled.verify(token), null);
});

test('worker proposal signatures are independent from global bearer credentials', () => {
  const actorTokens = isolatedPolicy({
    PALANTIR_TOKEN: 'guessable-human-token',
    PALANTIR_PM_TOKEN: 'guessable-manager-token',
  });
  const first = createWorkerProposalTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 1),
  });
  const second = createWorkerProposalTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 2),
  });
  const token = first.mint('run_alpha', { projectId: 'proj_one' });
  assert.deepEqual(first.verify(token), { runId: 'run_alpha', projectId: 'proj_one' });
  assert.equal(second.verify(token), null, 'same global bearers cannot validate another boot key');
});

test('manager capabilities are boot-local and bind run, conversation, and layer', () => {
  const actorTokens = isolatedPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'manager-secret',
  });
  const first = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 3),
  });
  const second = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 4),
  });
  const token = first.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  });
  assert.deepEqual(first.verify(token), {
    runId: 'run_top',
    conversationId: 'top',
    layer: 'top',
  });
  assert.equal(second.verify(token), null);
  assert.equal(first.verify(`${token}tampered`), null);
});

test('operator can force the agent capability tier to disabled', () => {
  const actorTokens = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
    PALANTIR_AGENT_CAPABILITIES: 'disabled',
  });
  assert.equal(createWorkerProposalTokenService({ actorTokens }).mint('run_alpha'), null);
  assert.equal(createManagerCapabilityTokenService({ actorTokens }).mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  }), null);
  assert.throws(
    () => applyManagerCredentialPolicy({}, {
      managerToken: 'must-not-cross',
      actorTokens,
    }),
    /disabled by actor token policy/,
  );
  assert.throws(
    () => applyWorkerCredentialPolicy({}, {
      workerToken: 'must-not-cross',
      actorTokens,
    }),
    /disabled by actor token policy/,
  );
});

test('shared-UID manager capability is minted, honestly tiered, and expires', () => {
  let clock = 1_000;
  const actorTokens = attenuatedPolicy();
  assert.equal(actorTokens.capabilityTier, 'shared_uid_attenuated');
  const service = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 7),
    now: () => clock,
    attenuatedTtlMs: 30_000,
  });
  const token = service.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  });
  assert.equal(typeof token, 'string');
  assert.match(token, /^palm2\./);
  assert.deepEqual(service.verify(token), {
    runId: 'run_top',
    conversationId: 'top',
    layer: 'top',
    capabilityTier: 'shared_uid_attenuated',
    expiresAt: 31_000,
  });
  clock = 31_000;
  assert.equal(service.verify(token), null);
});

test('attenuated manager capability is allowlisted to the manager job and audits denials', () => {
  const actorTokens = attenuatedPolicy();
  const service = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 8),
  });
  const token = service.mint('run_top', {
    conversationId: 'top',
    layer: 'top',
  });
  let active = true;
  const audit = [];
  const middleware = createAuthMiddleware({
    token: 'human-secret',
    managerCapabilityTokenService: service,
    isManagerCapabilityActive: () => active,
    onManagerCapabilityUse: (req, grant, outcome) => audit.push({
      runId: grant.runId,
      method: req.method,
      path: req.originalUrl,
      ...outcome,
    }),
  });
  const invoke = (method, originalUrl) => {
    const req = {
      method,
      originalUrl,
      headers: { authorization: `Bearer ${token}` },
    };
    let passed = false;
    let error = null;
    try {
      middleware(req, {}, () => { passed = true; });
    } catch (err) {
      error = err;
    }
    return { req, passed, error };
  };

  // The allowlist covers what the manager is FOR — dispatch, observe, review,
  // converse. Narrower than this and it cannot review a worker, which is the
  // capability #436 exists to restore.
  for (const [method, url] of [
    ['GET', '/api/runs'],
    ['GET', '/api/agents'],
    ['GET', '/api/tasks'],
    ['GET', '/api/projects'],
    ['GET', '/api/runs/run_one'],
    ['GET', '/api/runs/run_one/events'],
    ['GET', '/api/runs/run_one/output'],
    ['GET', '/api/projects/project_one/tasks'],
    ['GET', '/api/conversations/top/events'],
    ['POST', '/api/tasks'],
    ['POST', '/api/tasks/task_one/execute'],
    ['POST', '/api/conversations/top/message'],
    ['PATCH', '/api/tasks/task_one/status'],
  ]) {
    assert.equal(invoke(method, url).passed, true, `${method} ${url}`);
  }

  // Run intervention and dispatch-audit belong to the Operator layer. A Top
  // grant is refused at BOTH grades — the attenuated grade must never hand Top
  // something the isolated grade withholds.
  for (const [method, url] of [
    ['POST', '/api/runs/run_one/input'],
    ['POST', '/api/runs/run_one/cancel'],
    ['POST', '/api/dispatch-audit'],
  ]) {
    assert.equal(invoke(method, url).passed, false, `top must not reach ${method} ${url}`);
  }

  // Representative paths from every current cookie-only family remain beyond
  // the attenuated boundary. These requests fail in auth before route logic.
  for (const [method, url] of [
    ['PATCH', '/api/operator/profiles/profile_one/memory'],
    ['PUT', '/api/model-policies/top'],
    ['POST', '/api/operator-schedules'],
    ['POST', '/api/tasks/task_one/goal/deliver'],
    ['PATCH', '/api/projects/project_one/memory/memory_one'],
    ['POST', '/api/memory-candidates/candidate_one/promote'],
    ['GET', '/api/memory/diagnostics'],
    ['PATCH', '/api/operator-instances/instance_one'],
    ['PATCH', '/api/master-memory/memory_one'],
    ['POST', '/api/verify-checks'],
    ['DELETE', '/api/tasks/task_one'],
    // The generic task edit stays out: only the status transition is allowed,
    // so a goal `done` remains visible to the delivery provenance guard.
    ['PATCH', '/api/tasks/task_one'],
  ]) {
    const result = invoke(method, url);
    assert.equal(result.passed, false, `${method} ${url}`);
    assert.equal(result.error?.statusCode || result.error?.status, 403);
  }
  assert.ok(audit.some((event) => (
    event.runId === 'run_top'
    && event.allowed === false
    && event.reason === 'endpoint_not_allowed'
  )));

  active = false;
  const ended = invoke('GET', '/api/runs');
  assert.equal(ended.passed, false);
  assert.equal(ended.error?.statusCode || ended.error?.status, 403);
  assert.equal(audit.at(-1).reason, 'inactive_run');
});

// The invariant that makes the attenuated grade safe by construction, rather
// than by a hand-maintained list staying in sync. A review round found the
// attenuated grade granting Top three routes the isolated grade denied — the
// weaker credential was strictly WIDER. Deriving attenuated as
// `isolated MINUS exclusions` fixes that, and this test pins the derivation.
test('attenuated capability is a strict subset of isolated, for every layer', () => {
  // Each grade needs its OWN service and middleware: `verify` refuses a token
  // whose grade does not match its policy, so a single middleware would deny
  // every attenuated request for the wrong reason and make this test vacuous.
  const build = (actorTokens) => {
    const service = createManagerCapabilityTokenService({
      actorTokens,
      signingKey: Buffer.alloc(32, 9),
    });
    const middleware = createAuthMiddleware({
      token: 'human-secret',
      managerCapabilityTokenService: service,
      isManagerCapabilityActive: () => true,
      // Every run in this matrix is a worker run, so the manager-run rule never
      // fires and cannot mask a widening.
      isManagerRun: () => false,
    });
    return { service, middleware };
  };
  const isolatedTokens = isolatedPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  });
  assert.equal(isolatedTokens.capabilityTier, 'isolated');
  const attenuatedTokens = attenuatedPolicy();
  assert.equal(attenuatedTokens.capabilityTier, 'shared_uid_attenuated');
  const iso = build(isolatedTokens);
  const att = build(attenuatedTokens);

  const allows = (grade, token, method, originalUrl) => {
    let passed = false;
    try {
      grade.middleware({ method, originalUrl, headers: { authorization: `Bearer ${token}` } },
        {}, () => { passed = true; });
    } catch { /* denial */ }
    return passed;
  };

  const PATHS = [
    '/api/runs', '/api/agents', '/api/tasks', '/api/projects', '/api/skill-packs',
    '/api/runs/run_one', '/api/runs/run_one/events', '/api/runs/run_one/output',
    '/api/projects/project_one/tasks', '/api/projects/project_one/memory',
    '/api/operator/profiles', '/api/operator/specialist',
    '/api/tasks/task_one', '/api/tasks/task_one/status', '/api/tasks/task_one/execute',
    '/api/runs/run_one/input', '/api/runs/run_one/cancel', '/api/dispatch-audit',
    '/api/verify-checks', '/api/verify-checks/check_one', '/api/verify-checks/assign',
    '/api/conversations/top/events', '/api/conversations/top/message',
    '/api/conversations/top/memory/propose',
    '/api/model-policies/top', '/api/master-memory', '/api/operator-instances/oi_one',
  ];
  const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
  const LAYERS = [
    ['top', 'top'],
    ['operator', 'operator:oi_one'],
  ];

  let comparisons = 0;
  let attenuatedAllowed = 0;
  for (const [layer, conversationId] of LAYERS) {
    const isolatedToken = iso.service.mint(`run_${layer}`, { conversationId, layer });
    const attenuatedToken = att.service.mint(`run_${layer}`, { conversationId, layer });

    for (const method of METHODS) {
      for (const path of PATHS) {
        const attOk = allows(att, attenuatedToken, method, path);
        const isoOk = allows(iso, isolatedToken, method, path);
        comparisons += 1;
        if (attOk) attenuatedAllowed += 1;
        assert.equal(attOk && !isoOk, false,
          `attenuated ${layer} gained ${method} ${path} that isolated denies`);
      }
    }
  }
  // Guard against the comparison silently becoming vacuous — if authentication
  // broke, every attenuated request would be "denied" and the subset assertion
  // above would hold for the wrong reason.
  assert.ok(comparisons > 200, `expected a broad matrix, got ${comparisons}`);
  assert.ok(attenuatedAllowed > 15,
    `attenuated grade allowed only ${attenuatedAllowed} routes — the matrix is not exercising it`);
});

// Direction, not identity. Restricting an attenuated grant to its own
// conversation id looked safe and passed every allowlist test, but it broke
// Top→Operator delegation — the core three-layer flow. The rule is that a
// manager addresses itself or a layer BELOW it.
test('attenuated conversation access follows the layer hierarchy downward', () => {
  const actorTokens = attenuatedPolicy();
  const service = createManagerCapabilityTokenService({
    actorTokens,
    signingKey: Buffer.alloc(32, 11),
  });
  const middleware = createAuthMiddleware({
    token: 'human-secret',
    managerCapabilityTokenService: service,
    isManagerCapabilityActive: () => true,
    isManagerRun: () => false,
  });
  const allows = (token, originalUrl) => {
    let passed = false;
    try {
      middleware({ method: 'POST', originalUrl, headers: { authorization: `Bearer ${token}` } },
        {}, () => { passed = true; });
    } catch { /* denial */ }
    return passed;
  };
  const top = service.mint('run_top', { conversationId: 'top', layer: 'top' });
  const operator = service.mint('run_op', { conversationId: 'operator:oi_1', layer: 'operator' });

  // Percent-encoded ids are used throughout: the rule must decode before
  // comparing, or `operator%3Aoi_2` would slip past a prefix test.
  for (const [label, token, url, expected] of [
    ['top delegates to an operator', top, '/api/conversations/operator%3Aoi_1/message', true],
    ['top addresses itself', top, '/api/conversations/top/message', true],
    ['top must not drive a worker', top, '/api/conversations/worker%3Ar9/message', false],
    ['operator must not drive its parent', operator, '/api/conversations/top/message', false],
    ['operator must not drive a peer', operator, '/api/conversations/operator%3Aoi_2/message', false],
    ['operator addresses itself', operator, '/api/conversations/operator%3Aoi_1/message', true],
    ['operator drives its workers', operator, '/api/conversations/worker%3Ar9/message', true],
  ]) {
    assert.equal(allows(token, url), expected, label);
  }
});

// The clean bootstrap — no actor token in the environment at all — is the only
// one that earns the attenuated grade, and it must keep earning it.
test('a token file consumed without ambient actor tokens is fully assured', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({ PALANTIR_TOKEN: 'file-only-secret' }), { mode: 0o600 });

  const result = consumeActorTokenFile({
    env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath }, cwd: dir, fsImpl: fs,
  });

  assert.equal(result.source, 'ephemeral_file');
  assert.equal(result.ambientActorTokens, false);
  assert.equal(
    resolveActorTokenPolicy({
      PALANTIR_TOKEN: result.authToken,
      PALANTIR_ACTOR_TOKEN_SOURCE: result.source,
    }).capabilityTier,
    'shared_uid_attenuated',
  );
  // ...and the tainted variant must NOT reach that grade.
  assert.equal(
    resolveActorTokenPolicy({
      PALANTIR_TOKEN: result.authToken,
      PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file_tainted',
    }).capabilityTier,
    'disabled',
  );
});

// An empty value is not a credential. Launchers commonly declare optional
// secrets as empty strings, and treating that as taint disabled capabilities
// for a bootstrap that was never at risk.
test('empty ambient actor token values do not taint a file bootstrap', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-actor-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenPath = path.join(dir, 'tokens.json');
  fs.writeFileSync(tokenPath, JSON.stringify({ PALANTIR_TOKEN: 'file-secret' }), { mode: 0o600 });

  const result = consumeActorTokenFile({
    env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath, PALANTIR_TOKEN: '', PALANTIR_PM_TOKEN: '' },
    cwd: dir,
    fsImpl: fs,
  });

  assert.equal(result.ambientActorTokens, false);
  assert.equal(result.source, 'ephemeral_file');
  // ...while a non-empty one still taints.
  fs.writeFileSync(tokenPath, JSON.stringify({ PALANTIR_TOKEN: 'file-secret' }), { mode: 0o600 });
  assert.equal(
    consumeActorTokenFile({
      env: { PALANTIR_ACTOR_TOKEN_FILE: tokenPath, PALANTIR_TOKEN: 'ambient' },
      cwd: dir,
      fsImpl: fs,
    }).source,
    'ephemeral_file_tainted',
  );
});

// Deleting the variable before constructing the app does not undo the process
// image. `/proc/<pid>/environ` still holds what exec saw, so the taint check has
// to be anchored at load time, not at createApp time.
test('ambient actor token detection survives a later delete, and is case-insensitive', () => {
  assert.equal(scanAmbientActorTokens({ PALANTIR_TOKEN: 'secret' }), true);
  assert.equal(scanAmbientActorTokens({ palantir_token: 'secret' }), true,
    'the environment is not case-sensitive, so neither is this');
  assert.equal(scanAmbientActorTokens({ Palantir_Pm_Token: 'secret' }), true);
  assert.equal(scanAmbientActorTokens({ PALANTIR_TOKEN: '' }), false, 'empty is not a credential');
  assert.equal(scanAmbientActorTokens({}), false);
  // The load-time capture is a plain boolean about THIS process, so it must at
  // least be readable and stable.
  assert.equal(typeof hadAmbientActorTokensAtLoad(), 'boolean');
  assert.equal(hadAmbientActorTokensAtLoad(), hadAmbientActorTokensAtLoad());
});

// An expired capability is a REAL credential used past its life. Checking expiry
// before the signature made that indistinguishable from a forgery, so it left no
// audit trail at all.
test('an expired capability is distinguishable from a forgery', () => {
  let clock = 1_000;
  const service = createManagerCapabilityTokenService({
    actorTokens: attenuatedPolicy(),
    signingKey: Buffer.alloc(32, 13),
    now: () => clock,
  });
  const token = service.mint('run_x', { conversationId: 'top', layer: 'top' });
  assert.ok(service.verify(token), 'valid while fresh');

  clock += 25 * 60 * 60 * 1000;
  assert.equal(service.verify(token), null, 'expired must not authorize');
  const expired = service.inspect(token);
  assert.equal(expired.signatureValid, true);
  assert.equal(expired.expired, true);
  assert.equal(expired.grant.runId, 'run_x', 'the audit needs to know WHICH run');

  const forged = service.inspect('palm2.eyJhIjoxfQ.AAAA');
  assert.equal(forged.signatureValid, false);
  assert.equal(forged.grant, null);
});
