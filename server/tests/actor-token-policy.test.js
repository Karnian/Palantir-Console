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
  buildWorkerProcessEnv,
  augmentProcessPath,
  applyManagerCredentialPolicy,
  applyWorkerCredentialPolicy,
  normalizeWorkerApiBase,
  createWorkerProposalTokenService,
  createManagerCapabilityTokenService,
} = require('../services/actorTokenPolicy');

function isolatedPolicy(env = {}) {
  return resolveActorTokenPolicy({
    ...env,
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  }, { execAttestation: { verified: true, reason: 'test' } });
}

test('actor token policy separates token-source assurance from process isolation', () => {
  assert.deepEqual(resolveActorTokenPolicy({}), {
    humanToken: null,
    agentToken: null,
    separated: false,
    processIsolated: false,
    capabilitiesEnabled: false,
    execAttestation: null,
    boundary: 'auth_disabled',
  });
  assert.equal(resolveActorTokenPolicy({ PALANTIR_TOKEN: 'shared' }).boundary, 'agent_capabilities_disabled');
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'same',
    PALANTIR_PM_TOKEN: 'same',
  }).boundary, 'agent_capabilities_disabled');

  const separated = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
  });
  assert.equal(separated.boundary, 'agent_capabilities_disabled');
  assert.equal(separated.humanToken, 'human-secret');
  assert.equal(separated.agentToken, 'agent-secret');
  assert.equal(separated.separated, true);
  assert.equal(separated.processIsolated, false);
  assert.equal(separated.capabilitiesEnabled, false);
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
  }).boundary, 'agent_capabilities_disabled');
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  }, { execAttestation: { verified: true, reason: 'test' } }).boundary, 'run_capabilities_unverified');
  assert.equal(resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_PM_TOKEN: 'agent-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
    PALANTIR_AGENT_PROCESS_ISOLATION: 'verified',
  }, { execAttestation: { verified: true, reason: 'test' } }).boundary, 'run_capabilities');
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
  assert.equal(result.source, 'ephemeral_file');
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

test('worker API base normalization rejects URL userinfo fail-closed', () => {
  for (const apiBase of [
    'http://worker-user:worker-password@console.internal:4177',
    'http://secret-user\\:secret-pass@127.0.0.1:4177',
  ]) {
    assert.throws(
      () => normalizeWorkerApiBase(apiBase),
      (err) => (
        err.code === 'WORKER_API_BASE_USERINFO'
        && /userinfo/.test(err.message)
        && !/worker-user|worker-password|secret-user|secret-pass/.test(err.message)
      ),
    );
  }
});

test('worker API base normalization returns the validated URL serialization', () => {
  assert.equal(
    normalizeWorkerApiBase('HTTP://CONSOLE.EXAMPLE:80/a/../worker///'),
    'http://console.example/worker',
  );
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

test('agent capabilities fail closed without verified process isolation', () => {
  const actorTokens = resolveActorTokenPolicy({
    PALANTIR_TOKEN: 'human-secret',
    PALANTIR_ACTOR_TOKEN_SOURCE: 'ephemeral_file',
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
    /verified agent process isolation/,
  );
  assert.throws(
    () => applyWorkerCredentialPolicy({}, {
      workerToken: 'must-not-cross',
      actorTokens,
    }),
    /verified agent process isolation/,
  );
});
