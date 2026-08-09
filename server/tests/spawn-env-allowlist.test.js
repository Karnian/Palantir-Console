'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');

const {
  buildManagerSpawnEnv,
  resolveClaudeAuth,
  resolveClaudeAuthForIsolated,
} = require('../services/authResolver');
const {
  PROCESS_BASE_ENV_KEYS,
  WORKER_BASE_ENV_KEYS,
  NETWORK_ENV_KEYS,
  VENDOR_ENV_KEYS,
  buildWorkerProcessEnv,
} = require('../services/actorTokenPolicy');
const { createLiveDistiller } = require('../services/distillers/liveDistiller');
const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
const { invokeApp } = require('./helpers/invokeApp');

const FIXTURE_BIN = path.join(__dirname, 'fixtures', 'bin');
const FAKE_CODEX_STDIN = path.join(FIXTURE_BIN, 'fake-codex-stdin.js');
const FAKE_OPENCODE = path.join(FIXTURE_BIN, 'fake-opencode.js');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

async function withProcessEnv(changes, action) {
  const saved = new Map();
  for (const [key, value] of Object.entries(changes)) {
    saved.set(key, hasOwn(process.env, key) ? process.env[key] : undefined);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await action();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function waitForJson(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError || new Error(`timed out waiting for ${filePath}`);
}

function makeFakeCodexChild() {
  return Object.assign(new EventEmitter(), {
    stdin: {
      write() {},
      end() {},
    },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {},
  });
}

test('manager allowlist removes opaque and named ambient keys, including empty values', () => {
  const env = buildManagerSpawnEnv({
    baseEnv: {
      PATH: '/bin',
      HOME: '/home/test',
      UNRELATED_CANARY_7F3A: '',
      GITHUB_TOKEN: 'github-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
    },
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/home/test');
  assert.equal(hasOwn(env, 'UNRELATED_CANARY_7F3A'), false);
  assert.equal(hasOwn(env, 'GITHUB_TOKEN'), false);
  assert.equal(hasOwn(env, 'AWS_SECRET_ACCESS_KEY'), false);
});

for (const key of VENDOR_ENV_KEYS.claude) {
  test(`claude-code manager vendor admits ${key}`, () => {
    const env = buildManagerSpawnEnv({
      baseEnv: { [key]: `claude-${key}`, CODEX_HOME: '/host/codex' },
      vendor: 'claude-code',
    });
    assert.equal(env[key], `claude-${key}`);
    assert.equal(hasOwn(env, 'CODEX_HOME'), false);
  });

  test(`codex manager vendor rejects Claude-only ${key}`, () => {
    const env = buildManagerSpawnEnv({
      baseEnv: { [key]: `claude-${key}` },
      vendor: 'codex',
    });
    assert.equal(hasOwn(env, key), false);
  });
}

for (const key of VENDOR_ENV_KEYS.codex) {
  test(`codex manager vendor admits ${key}`, () => {
    const env = buildManagerSpawnEnv({
      baseEnv: { [key]: `codex-${key}`, CLAUDE_CONFIG_DIR: '/host/claude' },
      vendor: 'codex',
    });
    assert.equal(env[key], `codex-${key}`);
    assert.equal(hasOwn(env, 'CLAUDE_CONFIG_DIR'), false);
  });

  test(`claude-code manager vendor rejects Codex-only ${key}`, () => {
    const env = buildManagerSpawnEnv({
      baseEnv: { [key]: `codex-${key}` },
      vendor: 'claude-code',
    });
    assert.equal(hasOwn(env, key), false);
  });
}

test('manager allowlist forwards all proxy spellings but blocks XDG homes and SSH agent', () => {
  const baseEnv = {};
  for (const key of NETWORK_ENV_KEYS) baseEnv[key] = `proxy-${key}`;
  for (const key of [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'SSH_AUTH_SOCK',
  ]) {
    baseEnv[key] = `/sensitive/${key}`;
  }

  const env = buildManagerSpawnEnv({ baseEnv });
  for (const key of NETWORK_ENV_KEYS) assert.equal(env[key], `proxy-${key}`);
  for (const key of [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'SSH_AUTH_SOCK',
  ]) {
    assert.equal(hasOwn(env, key), false, `${key} must be absent`);
  }
});

test('credentialed proxy forwarding emits a value-free security diagnostic', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    const env = buildManagerSpawnEnv({
      baseEnv: {
        HTTP_PROXY: 'http://proxy-user:proxy-password@proxy.example:3128',
        all_proxy: 'socks5:/encoded%40user:encoded%2Fpassword@proxy.example:1080',
        HTTPS_PROXY: 'scheme-user:scheme-password@proxy.example:8443',
        https_proxy: 'http://malformed-user:malformed#password@proxy.example:9443',
        ALL_PROXY: String.raw`http://DOMAIN\domain-user:domain-password@proxy.example:10443`,
        http_proxy: 'http:/slash-user:slash-password@proxy.example:11443',
        NO_PROXY: 'user@example.internal',
      },
      vendor: 'codex',
      diagnosticContext: 'manager:test:proxy',
    });
    assert.equal(env.HTTP_PROXY, 'http://proxy-user:proxy-password@proxy.example:3128');
    assert.equal(env.all_proxy, 'socks5:/encoded%40user:encoded%2Fpassword@proxy.example:1080');
    assert.equal(env.HTTPS_PROXY, 'scheme-user:scheme-password@proxy.example:8443');
    assert.equal(env.https_proxy, 'http://malformed-user:malformed#password@proxy.example:9443');
    assert.equal(
      env.ALL_PROXY,
      String.raw`http://DOMAIN\domain-user:domain-password@proxy.example:10443`,
    );
    assert.equal(env.http_proxy, 'http:/slash-user:slash-password@proxy.example:11443');
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[security\] manager_spawn_proxy_userinfo /);
  assert.match(lines[0], /"context":"manager:test:proxy"/);
  assert.match(lines[0], /"vendor":"codex"/);
  const payload = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
  assert.deepEqual(
    payload.keys,
    ['ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'http_proxy', 'https_proxy'].sort(),
  );
  assert.doesNotMatch(
    lines[0],
    /proxy-user|proxy-password|scheme-user|scheme-password|malformed-user|malformed#password|domain-user|domain-password|slash-user|slash-password|DOMAIN|encoded%40user|encoded%2Fpassword|proxy\.example|3128|8443|9443|10443|11443|1080/,
  );
});

test('proxy diagnostic stays silent without URL userinfo', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    buildManagerSpawnEnv({
      baseEnv: {
        HTTP_PROXY: 'http://proxy.example:3128',
        HTTPS_PROXY: 'not-a-url',
        ALL_PROXY: 'http://proxy.example:bad/path@name',
        all_proxy: 'http://[::1/path@name',
        http_proxy: 'http://proxy.example:bad?next=user@example.internal',
        https_proxy: 'mailto:user@example.internal',
        NO_PROXY: 'user@example.internal',
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(lines, []);
});

test('proxy diagnostic catches curl-compatible triple-slash SOCKS userinfo', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    buildManagerSpawnEnv({
      baseEnv: {
        ALL_PROXY: 'socks5:///triple-user:triple-password@proxy.example:1080',
      },
      diagnosticContext: 'manager:test:socks-slashes',
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /manager_spawn_proxy_userinfo/);
  assert.match(lines[0], /"keys":\["ALL_PROXY"\]/);
  assert.doesNotMatch(lines[0], /triple-user|triple-password|proxy\.example|1080/);
});

test('profile env_allowlist and bearerEnvKeys are additive and authEnv wins last', () => {
  const env = buildManagerSpawnEnv({
    baseEnv: {
      PROFILE_CUSTOM_ENV: '',
      CUSTOM_BEARER_ENV: 'base-bearer',
      AUTH_OVERRIDE: 'base-auth',
      UNLISTED: 'drop',
    },
    envAllowlist: ['PROFILE_CUSTOM_ENV', 'AUTH_OVERRIDE'],
    bearerEnvKeys: ['CUSTOM_BEARER_ENV'],
    authEnv: {
      AUTH_OVERRIDE: 'resolved-auth',
      AUTH_ONLY: 'resolved-only',
    },
  });

  assert.equal(hasOwn(env, 'PROFILE_CUSTOM_ENV'), true);
  assert.equal(env.PROFILE_CUSTOM_ENV, '');
  assert.equal(env.CUSTOM_BEARER_ENV, 'base-bearer');
  assert.equal(env.AUTH_OVERRIDE, 'resolved-auth');
  assert.equal(env.AUTH_ONLY, 'resolved-only');
  assert.equal(hasOwn(env, 'UNLISTED'), false);
});

test('security migration diagnostic logs dropped key names, contexts, and no values', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    buildManagerSpawnEnv({
      baseEnv: {
        PATH: '/bin',
        BEDROCK_REGION_CUSTOM: 'do-not-log-this-value',
        CUSTOM_PROVIDER_ENV_KEY: 'nor-this-value',
      },
      vendor: 'claude-code',
      diagnosticContext: 'manager:test:migration',
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[security\] manager_spawn_env_dropped /);
  assert.match(lines[0], /"context":"manager:test:migration"/);
  assert.match(lines[0], /"vendor":"claude"/);
  assert.match(lines[0], /BEDROCK_REGION_CUSTOM/);
  assert.match(lines[0], /CUSTOM_PROVIDER_ENV_KEY/);
  assert.doesNotMatch(lines[0], /do-not-log-this-value|nor-this-value/);
});

test('worker process env remains byte-identical to the pre-manager-allowlist contract', () => {
  // Containment, NOT object identity: the worker set is its own array so a
  // future worker-only key can be added without flowing into managers. What
  // must hold is that workers never lose a shared baseline key — the exact
  // pre-change output is pinned by the expected map below.
  for (const key of PROCESS_BASE_ENV_KEYS) {
    assert.ok(WORKER_BASE_ENV_KEYS.includes(key), `worker baseline lost ${key}`);
  }
  // Pinned literal, NOT derived from the constant under test. Building both the
  // input and the expectation from PROCESS_BASE_ENV_KEYS would make this test
  // vacuous: deleting a key from the constant would delete it from `expected`
  // too and still pass. This snapshot is the pre-#431 worker contract.
  const PRE_431_WORKER_KEYS = [
    'PATH', 'Path', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USER',
    'USERNAME', 'LOGNAME', 'SHELL', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
    'ComSpec', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TERM',
    'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  ];
  assert.deepEqual(
    [...WORKER_BASE_ENV_KEYS].sort(),
    [...PRE_431_WORKER_KEYS].sort(),
    'worker baseline drifted from the pre-#431 contract',
  );

  const baseEnv = Object.fromEntries(PRE_431_WORKER_KEYS.map((key, index) => [key, `v${index}`]));
  Object.assign(baseEnv, {
    CODEX_API_KEY: 'ambient-codex',
    UNRELATED_CANARY_7F3A: 'ambient-opaque',
    PALANTIR_TOKEN: 'human',
    PALANTIR_PM_TOKEN: 'pm',
    PALANTIR_WORKER_TOKEN: 'ambient-worker',
    PALANTIR_MANAGER_TOKEN: 'ambient-manager',
  });
  const explicitEnv = {
    PROFILE_ALLOWED: '',
    PALANTIR_TOKEN: 'smuggled-human',
    PALANTIR_PM_TOKEN: 'smuggled-pm',
    PALANTIR_MANAGER_TOKEN: 'smuggled-manager',
    PALANTIR_WORKER_TOKEN: 'run-worker',
  };
  const expected = Object.fromEntries(PRE_431_WORKER_KEYS.map((key, index) => [key, `v${index}`]));
  expected.PROFILE_ALLOWED = '';
  expected.PALANTIR_WORKER_TOKEN = 'run-worker';

  const actual = buildWorkerProcessEnv(baseEnv, explicitEnv);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});

test('liveDistiller actual child sees the Claude allowlist and no opaque host env', async () => {
  const childScript = String.raw`
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      const own = key => Object.prototype.hasOwnProperty.call(process.env, key);
      const observed = {
        opaque: own('UNRELATED_CANARY_7F3A'),
        github: own('GITHUB_TOKEN'),
        claudeCa: process.env.NODE_EXTRA_CA_CERTS,
        codexHome: own('CODEX_HOME'),
        custom: process.env.DISTILLER_PROFILE_ENV,
      };
      process.stdout.write(JSON.stringify([{
        candidateId: 'env-live',
        kind: 'heuristic',
        content: 'ENV:' + JSON.stringify(observed),
        confidence: 0.5,
        importance: 5
      }]));
    });
  `;

  await withProcessEnv({
    UNRELATED_CANARY_7F3A: '',
    GITHUB_TOKEN: 'github-secret',
    NODE_EXTRA_CA_CERTS: '/corp/claude-ca.pem',
    CODEX_HOME: '/host/codex',
    DISTILLER_PROFILE_ENV: 'profile-value',
  }, async () => {
    const distiller = createLiveDistiller({
      cliBin: FAKE_CODEX_STDIN,
      envAllowlist: ['DISTILLER_PROFILE_ENV'],
      resolveIsolatedAuth: async () => ({
        canAuth: true,
        env: {},
        sources: ['test'],
        diagnostics: [],
      }),
      spawnImpl: (_command, _args, opts) => childProcess.spawn(
        process.execPath,
        ['-e', childScript],
        opts,
      ),
    });

    const [proposal] = await distiller.distill({
      candidates: [{ id: 'env-live', rule: 'R3', raw_json: '{}' }],
    });
    const observed = JSON.parse(proposal.content.slice('ENV:'.length));
    assert.equal(observed.opaque, false);
    assert.equal(observed.github, false);
    assert.equal(observed.claudeCa, '/corp/claude-ca.pem');
    assert.equal(observed.codexHome, false);
    assert.equal(observed.custom, 'profile-value');
  });
});

test('opencodeService actual child sees storage, TLS default, and no ambient canary', async (t) => {
  const probePath = path.join(os.tmpdir(), `palantir-opencode-env-${process.pid}-${Date.now()}.json`);
  t.after(() => fsp.rm(probePath, { force: true }));
  const modulePath = require.resolve('../services/opencodeService');
  const originalSpawn = childProcess.spawn;
  delete require.cache[modulePath];
  childProcess.spawn = (_command, _args, opts) => originalSpawn(
    process.execPath,
    [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))",
      probePath,
    ],
    opts,
  );

  try {
    await withProcessEnv({
      UNRELATED_CANARY_7F3A: '',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      OPENCODE_STORAGE: '/tmp/opencode-shared-storage',
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    }, async () => {
      const { createOpencodeService } = require('../services/opencodeService');
      const service = createOpencodeService({ opencodeBin: FAKE_OPENCODE });
      await service.queueMessage({ sessionId: 'session-env', content: 'probe', cwd: os.tmpdir() });
      const observed = await waitForJson(probePath);
      assert.equal(hasOwn(observed, 'UNRELATED_CANARY_7F3A'), false);
      assert.equal(hasOwn(observed, 'AWS_SECRET_ACCESS_KEY'), false);
      assert.equal(observed.OPENCODE_STORAGE, '/tmp/opencode-shared-storage');
      assert.equal(observed.NODE_TLS_REJECT_UNAUTHORIZED, '1');
    });
  } finally {
    delete require.cache[modulePath];
    childProcess.spawn = originalSpawn;
  }
});

test('codexService actual child gets Codex auth and injected codexHome wins', async (t) => {
  const probePath = path.join(os.tmpdir(), `palantir-codex-service-env-${process.pid}-${Date.now()}.json`);
  t.after(() => fsp.rm(probePath, { force: true }));
  const childScript = String.raw`
    const fs = require('node:fs');
    const readline = require('node:readline');
    fs.writeFileSync(process.argv[1], JSON.stringify(process.env));
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', line => {
      const req = JSON.parse(line);
      let result = {};
      if (req.method === 'account/read') {
        result = { account: { type: 'test' }, requiresOpenaiAuth: false };
      } else if (req.method === 'account/rateLimits/read') {
        result = { rateLimits: { primary: { windowDurationMins: 300, remaining_pct: 75 } } };
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n', () => {
        if (req.method === 'account/rateLimits/read') process.exit(0);
      });
    });
  `;
  const modulePath = require.resolve('../services/codexService');
  const originalSpawn = childProcess.spawn;
  delete require.cache[modulePath];
  childProcess.spawn = (_command, _args, opts) => originalSpawn(
    process.execPath,
    ['-e', childScript, probePath],
    opts,
  );

  try {
    await withProcessEnv({
      UNRELATED_CANARY_7F3A: '',
      GITHUB_TOKEN: 'github-secret',
      CODEX_API_KEY: 'codex-api',
      OPENAI_API_KEY: 'openai-api',
      CODEX_HOME: '/host/codex-home',
      CLAUDE_CONFIG_DIR: '/host/claude',
    }, async () => {
      const { createCodexService } = require('../services/codexService');
      const service = createCodexService({
        codexBin: FAKE_CODEX_STDIN,
        codexHome: '/injected/codex-home',
        timeoutMs: 3000,
      });
      await service.getStatus();
      const observed = await waitForJson(probePath);
      assert.equal(hasOwn(observed, 'UNRELATED_CANARY_7F3A'), false);
      assert.equal(hasOwn(observed, 'GITHUB_TOKEN'), false);
      assert.equal(observed.CODEX_API_KEY, 'codex-api');
      assert.equal(observed.OPENAI_API_KEY, 'openai-api');
      assert.equal(observed.CODEX_HOME, '/injected/codex-home');
      assert.equal(hasOwn(observed, 'CLAUDE_CONFIG_DIR'), false);
    });
  } finally {
    delete require.cache[modulePath];
    childProcess.spawn = originalSpawn;
  }
});

test('CodexAdapter manager role fails closed when the caller omits env', async (t) => {
  let capturedEnv = null;
  const adapter = createCodexAdapter({
    runService: null,
    codexBin: FAKE_CODEX_STDIN,
    spawnFn: (_command, _args, opts) => {
      capturedEnv = opts.env;
      return makeFakeCodexChild();
    },
  });
  t.after(() => adapter.disposeSession('run-fail-closed'));

  await withProcessEnv({ UNRELATED_CANARY_7F3A: 'ambient-secret' }, async () => {
    adapter.startSession('run-fail-closed', {
      systemPrompt: 'system',
      cwd: process.cwd(),
      role: 'manager',
    });
    const result = adapter.runTurn('run-fail-closed', { text: 'hello' });
    assert.equal(result.accepted, true);
    assert.ok(capturedEnv);
    assert.equal(hasOwn(capturedEnv, 'UNRELATED_CANARY_7F3A'), false);
    assert.deepEqual(capturedEnv, {});
  });
});

function createMockManagerAdapter(calls) {
  return {
    type: 'claude-code',
    capabilities: {
      supportsResume: true,
      persistentProcess: true,
      persistentSession: true,
    },
    startSession(runId, opts) {
      calls.push({ runId, opts });
      return { sessionRef: { pid: 123 } };
    },
    runTurn: () => ({ accepted: true }),
    isSessionAlive: () => true,
    disposeSession: () => {},
    emitSessionEndedIfNeeded: () => {},
    detectExitCode: () => null,
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    buildGuardrailsSection: () => '',
  };
}

async function createManagerDbHarness(t, name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const { createDatabase } = require('../db/database');
  const { createRunService } = require('../services/runService');
  const { createAgentProfileService } = require('../services/agentProfileService');
  const { createManagerRegistry } = require('../services/managerRegistry');
  const { createConversationService } = require('../services/conversationService');
  const { db, migrate, close } = createDatabase(path.join(root, 'test.db'));
  migrate();
  const runService = createRunService(db, null);
  const agentProfileService = createAgentProfileService(db);
  agentProfileService.updateProfile('claude-code', {
    env_allowlist: JSON.stringify(['PROFILE_RESUME_ENV']),
  });
  const calls = [];
  const adapter = createMockManagerAdapter(calls);
  const managerAdapterFactory = { getAdapter: () => adapter };
  const managerRegistry = createManagerRegistry({ runService });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService: null,
  });
  t.after(async () => {
    close();
    await fsp.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    db,
    runService,
    agentProfileService,
    calls,
    managerAdapterFactory,
    managerRegistry,
    conversationService,
  };
}

async function startFreshManager(harness, {
  profileId = 'claude-code',
  authResolverOpts = {
    hasKeychain: () => false,
    hasCredentialsFile: () => false,
  },
} = {}) {
  const { createManagerRouter } = require('../routes/manager');
  const app = express();
  app.use(express.json());
  app.use('/api/manager', createManagerRouter({
    runService: harness.runService,
    managerAdapterFactory: harness.managerAdapterFactory,
    managerRegistry: harness.managerRegistry,
    conversationService: harness.conversationService,
    agentProfileService: harness.agentProfileService,
    authResolverOpts,
  }));
  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: {
      prompt: `fresh ${profileId} provider test`,
      agent_profile_id: profileId,
    },
  });
  return {
    response,
    call: harness.calls.find((entry) => !entry.opts.resumeSessionId),
  };
}

test('MUTATION: deleted pinned profile resumes from its env-policy snapshot without fallback widening', async (t) => {
  await withProcessEnv({
    PIN_ONLY: 'pinned-value',
    FALLBACK_ONLY: 'fallback-value',
  }, async () => {
    const harness = await createManagerDbHarness(t, 'palantir-env-snapshot-delete');
    harness.agentProfileService.updateProfile('claude-code', {
      name: 'ZZZ pinned Claude',
      env_allowlist: JSON.stringify(['PIN_ONLY']),
    });
    const fresh = await startFreshManager(harness, {
      authResolverOpts: {
        hasKeychain: () => true,
        hasCredentialsFile: () => false,
      },
    });
    assert.equal(fresh.response.status, 201, JSON.stringify(fresh.response.body));
    assert.equal(fresh.call.opts.env.PIN_ONLY, 'pinned-value');
    assert.equal(hasOwn(fresh.call.opts.env, 'FALLBACK_ONLY'), false);

    const runId = harness.managerRegistry.getActiveRunId('top');
    const freshRun = harness.runService.getRun(runId);
    const snapshot = JSON.parse(freshRun.session_claude_options_json).envPolicy;
    assert.deepEqual(snapshot.effectiveKeys, ['PIN_ONLY']);
    harness.runService.updateClaudeSessionId(runId, 'resume-pinned-env-snapshot');
    harness.agentProfileService.deleteProfile('claude-code');
    assert.equal(harness.runService.getRun(runId).agent_profile_id, null);
    harness.agentProfileService.createProfile({
      name: 'AAA fallback Claude',
      type: 'claude-code',
      command: 'claude',
      args_template: '-p {prompt}',
      env_allowlist: JSON.stringify(['FALLBACK_ONLY']),
    });

    const { createManagerRouter } = require('../routes/manager');
    const { createManagerRegistry } = require('../services/managerRegistry');
    const { createConversationService } = require('../services/conversationService');
    const resumeCalls = [];
    const resumeAdapter = createMockManagerAdapter(resumeCalls);
    const resumeFactory = { getAdapter: () => resumeAdapter };
    const resumeRegistry = createManagerRegistry({ runService: harness.runService });
    const resumeConversationService = createConversationService({
      runService: harness.runService,
      managerRegistry: resumeRegistry,
      managerAdapterFactory: resumeFactory,
      lifecycleService: null,
    });
    createManagerRouter({
      runService: harness.runService,
      managerAdapterFactory: resumeFactory,
      managerRegistry: resumeRegistry,
      conversationService: resumeConversationService,
      agentProfileService: harness.agentProfileService,
      authResolverOpts: {
        hasKeychain: () => true,
        hasCredentialsFile: () => false,
      },
    });

    const resumed = resumeCalls.find((call) => call.runId === runId);
    assert.ok(resumed, 'deleted-profile run must resume from its own snapshot');
    assert.deepEqual(resumed.opts.envAllowlist, ['PIN_ONLY']);
    assert.equal(resumed.opts.env.PIN_ONLY, 'pinned-value');
    assert.equal(hasOwn(resumed.opts.env, 'FALLBACK_ONLY'), false);
  });
});

test('fresh Top and boot-resumed Top/Operator use the same profile env_allowlist', async (t) => {
  await withProcessEnv({
    PROFILE_RESUME_ENV: 'profile-visible',
    RESUME_DROPPED_CANARY_7F3A: 'never-log-this-value',
  }, async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      const { createManagerRouter } = require('../routes/manager');

      const fresh = await createManagerDbHarness(t, 'palantir-env-fresh');
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/manager', createManagerRouter({
        runService: fresh.runService,
        managerAdapterFactory: fresh.managerAdapterFactory,
        managerRegistry: fresh.managerRegistry,
        conversationService: fresh.conversationService,
        agentProfileService: fresh.agentProfileService,
        authResolverOpts: {
          hasKeychain: () => true,
          hasCredentialsFile: () => false,
        },
      }));
      const response = await invokeApp(freshApp, {
        method: 'POST',
        path: '/api/manager/start',
        body: {
          prompt: 'fresh allowlist',
          agent_profile_id: 'claude-code',
        },
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const freshCall = fresh.calls.find((call) => !call.opts.resumeSessionId);
      assert.ok(freshCall, 'fresh Top spawn must be captured');

      const resumed = await createManagerDbHarness(t, 'palantir-env-resume');
      const { createProjectService } = require('../services/projectService');
      const { createProjectBriefService } = require('../services/projectBriefService');
      const projectService = createProjectService(resumed.db);
      const projectBriefService = createProjectBriefService(resumed.db);
      const project = projectService.createProject({
        name: 'resume-env-project',
        directory: resumed.root,
      });
      projectBriefService.ensureBrief(project.id);
      const ensured = resumed.runService.ensurePrimaryOperatorInstanceForProject(project.id);
      resumed.runService.setOperatorInstanceThread(ensured.instanceId, {
        thread_id: 'resume-operator-session',
        pm_adapter: 'claude',
        node_id: 'local',
        cwd: resumed.root,
      });

      const topRun = resumed.runService.createRun({
        is_manager: true,
        prompt: 'resume top',
        agent_profile_id: 'claude-code',
        manager_adapter: 'claude-code',
        manager_layer: 'top',
        conversation_id: 'top',
      });
      resumed.runService.updateRunStatus(topRun.id, 'running', { force: true });
      resumed.runService.updateClaudeSessionId(topRun.id, 'resume-top-session');

      const operatorRun = resumed.runService.createRun({
        is_manager: true,
        prompt: 'resume operator',
        agent_profile_id: 'claude-code',
        manager_adapter: 'claude-code',
        manager_layer: 'operator',
        conversation_id: ensured.instanceConversationId,
        operator_instance_id: ensured.instanceId,
      });
      resumed.runService.updateRunStatus(operatorRun.id, 'running', { force: true });

      createManagerRouter({
        runService: resumed.runService,
        projectService,
        projectBriefService,
        managerAdapterFactory: resumed.managerAdapterFactory,
        managerRegistry: resumed.managerRegistry,
        conversationService: resumed.conversationService,
        agentProfileService: resumed.agentProfileService,
        authResolverOpts: {
          hasKeychain: () => true,
          hasCredentialsFile: () => false,
        },
      });

      const resumedTopCall = resumed.calls.find((call) => call.runId === topRun.id);
      const resumedOperatorCall = resumed.calls.find((call) => call.runId === operatorRun.id);
      assert.ok(resumedTopCall, 'boot resume Top spawn must be captured');
      assert.ok(resumedOperatorCall, 'boot resume Operator spawn must be captured');
      for (const captured of [freshCall, resumedTopCall, resumedOperatorCall]) {
        assert.equal(captured.opts.env.PROFILE_RESUME_ENV, 'profile-visible');
        assert.equal(hasOwn(captured.opts.env, 'RESUME_DROPPED_CANARY_7F3A'), false);
      }
      assert.deepEqual(resumedTopCall.opts.env, freshCall.opts.env);
      assert.deepEqual(resumedOperatorCall.opts.env, freshCall.opts.env);

      for (const context of [
        'manager:fresh:top',
        'manager:resume:top',
        'manager:resume:operator',
      ]) {
        const line = warnings.find((entry) => (
          entry.includes('manager_spawn_env_dropped')
          && entry.includes(`"context":"${context}"`)
        ));
        assert.ok(line, `missing security diagnostic for ${context}`);
        assert.match(line, /RESUME_DROPPED_CANARY_7F3A/);
        assert.doesNotMatch(line, /never-log-this-value/);
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('MUTATION: Claude auth contract accepts an allowlisted cloud mode, while arbitrary Claude/Codex secrets only forward', async (t) => {
  await withProcessEnv({
    PALANTIR_SKIP_HOST_CREDENTIALS: '1',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'ap-northeast-2',
    AWS_SECRET_ACCESS_KEY: 'bedrock-approved-secret',
    CUSTOM_CODEX_REGION: 'custom-1',
    CUSTOM_CODEX_API_KEY: 'custom-approved-secret',
    CUSTOM_CLAUDE_API_KEY: 'custom-claude-secret',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    CODEX_API_KEY: undefined,
    OPENAI_API_KEY: undefined,
  }, async () => {
    const { createEnvironmentProviderService } = require('../services/environmentProviderService');
    const cases = [
      {
        profileId: 'claude-code',
        provider: {
          name: 'review-bedrock-auth',
          env_keys: [
            'CLAUDE_CODE_USE_BEDROCK',
            'AWS_REGION',
            'AWS_SECRET_ACCESS_KEY',
          ],
          gate_env_key: 'CLAUDE_CODE_USE_BEDROCK',
        },
        approvedKey: 'AWS_SECRET_ACCESS_KEY',
        expectedKeys: [
          'CLAUDE_CODE_USE_BEDROCK',
          'AWS_REGION',
          'AWS_SECRET_ACCESS_KEY',
        ],
      },
    ];

    for (const entry of cases) {
      const harness = await createManagerDbHarness(
        t,
        `palantir-provider-only-${entry.profileId}`,
      );
      const provider = createEnvironmentProviderService(harness.db)
        .createProvider(entry.provider);
      harness.agentProfileService.updateProfile(entry.profileId, {
        env_allowlist: JSON.stringify([entry.approvedKey]),
        environment_provider_ids: [provider.id],
      });

      const { response, call } = await startFreshManager(harness, {
        profileId: entry.profileId,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok(call, `${entry.profileId} provider-only spawn must be captured`);
      for (const key of entry.expectedKeys) {
        assert.equal(call.opts.env[key], process.env[key], `${key} must reach the child`);
      }
    }

    const custom = await createManagerDbHarness(t, 'palantir-provider-custom-codex');
    const customProvider = createEnvironmentProviderService(custom.db).createProvider({
      name: 'review-codex-custom-auth',
      env_keys: ['CUSTOM_CODEX_REGION', 'CUSTOM_CODEX_API_KEY'],
    });
    custom.agentProfileService.updateProfile('codex', {
      env_allowlist: JSON.stringify(['CUSTOM_CODEX_API_KEY']),
      environment_provider_ids: [customProvider.id],
    });
    const deniedAuth = await startFreshManager(custom, { profileId: 'codex' });
    assert.equal(deniedAuth.response.status, 400, JSON.stringify(deniedAuth.response.body));
    assert.equal(deniedAuth.response.body.error, 'manager_auth_unavailable');
    assert.equal(deniedAuth.call, undefined);

    // With real adapter auth present, the arbitrary approved secret is still
    // forwarded; it simply is not itself the reason preflight succeeds.
    await withProcessEnv({ OPENAI_API_KEY: 'real-codex-auth' }, async () => {
      custom.agentProfileService.updateProfile('codex', {
        env_allowlist: JSON.stringify(['OPENAI_API_KEY', 'CUSTOM_CODEX_API_KEY']),
      });
      const allowedForward = await startFreshManager(custom, { profileId: 'codex' });
      assert.equal(allowedForward.response.status, 201, JSON.stringify(allowedForward.response.body));
      assert.equal(allowedForward.call.opts.env.OPENAI_API_KEY, 'real-codex-auth');
      assert.equal(
        allowedForward.call.opts.env.CUSTOM_CODEX_API_KEY,
        'custom-approved-secret',
      );
    });

    const customClaude = await createManagerDbHarness(
      t,
      'palantir-provider-custom-claude',
    );
    const customClaudeProvider = createEnvironmentProviderService(customClaude.db)
      .createProvider({
        name: 'review-claude-custom-auth',
        env_keys: ['CUSTOM_CLAUDE_API_KEY'],
      });
    customClaude.agentProfileService.updateProfile('claude-code', {
      env_allowlist: JSON.stringify(['CUSTOM_CLAUDE_API_KEY']),
      environment_provider_ids: [customClaudeProvider.id],
    });
    const deniedClaudeAuth = await startFreshManager(customClaude, {
      profileId: 'claude-code',
    });
    assert.equal(
      deniedClaudeAuth.response.status,
      400,
      JSON.stringify(deniedClaudeAuth.response.body),
    );
    assert.equal(deniedClaudeAuth.response.body.error, 'manager_auth_unavailable');
    assert.equal(deniedClaudeAuth.call, undefined);

    await withProcessEnv({ ANTHROPIC_API_KEY: 'real-claude-auth' }, async () => {
      customClaude.agentProfileService.updateProfile('claude-code', {
        env_allowlist: JSON.stringify([
          'ANTHROPIC_API_KEY',
          'CUSTOM_CLAUDE_API_KEY',
        ]),
      });
      const allowedClaudeForward = await startFreshManager(customClaude, {
        profileId: 'claude-code',
      });
      assert.equal(
        allowedClaudeForward.response.status,
        201,
        JSON.stringify(allowedClaudeForward.response.body),
      );
      assert.equal(
        allowedClaudeForward.call.opts.env.CUSTOM_CLAUDE_API_KEY,
        'custom-claude-secret',
      );
    });

    const resumed = await createManagerDbHarness(
      t,
      'palantir-provider-only-resume-claude',
    );
    const resumedProvider = createEnvironmentProviderService(resumed.db)
      .createProvider({
        name: 'review-bedrock-auth-resume',
        env_keys: [
          'CLAUDE_CODE_USE_BEDROCK',
          'AWS_REGION',
          'AWS_SECRET_ACCESS_KEY',
        ],
        gate_env_key: 'CLAUDE_CODE_USE_BEDROCK',
      });
    resumed.agentProfileService.updateProfile('claude-code', {
      env_allowlist: JSON.stringify(['AWS_SECRET_ACCESS_KEY']),
      environment_provider_ids: [resumedProvider.id],
    });
    const stale = resumed.runService.createRun({
      is_manager: true,
      prompt: 'provider-only resume',
      agent_profile_id: 'claude-code',
      manager_adapter: 'claude-code',
      manager_layer: 'top',
      conversation_id: 'top',
    });
    resumed.runService.updateRunStatus(stale.id, 'running', { force: true });
    resumed.runService.updateClaudeSessionId(stale.id, 'provider-only-resume');
    const { createManagerRouter } = require('../routes/manager');
    createManagerRouter({
      runService: resumed.runService,
      managerAdapterFactory: resumed.managerAdapterFactory,
      managerRegistry: resumed.managerRegistry,
      conversationService: resumed.conversationService,
      agentProfileService: resumed.agentProfileService,
      authResolverOpts: {
        hasKeychain: () => false,
        hasCredentialsFile: () => false,
      },
    });
    const resumedCall = resumed.calls.find((entry) => entry.runId === stale.id);
    assert.ok(resumedCall, 'provider-only Top must resume without standard auth');
    assert.equal(resumedCall.opts.env.CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(resumedCall.opts.env.AWS_REGION, 'ap-northeast-2');
    assert.equal(
      resumedCall.opts.env.AWS_SECRET_ACCESS_KEY,
      'bedrock-approved-secret',
    );
  });
});

test('MUTATION: normal and isolated Claude auth use the same provider policy contract', async () => {
  const baseEnv = {
    PALANTIR_SKIP_HOST_CREDENTIALS: '1',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
  };
  const cases = [
    {
      name: 'approved OAuth token',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-canary' },
      envAllowlist: ['CLAUDE_CODE_OAUTH_TOKEN'],
      providerEnv: [{
        id: 'envp_oauth',
        active: true,
        approvedSecretKeys: ['CLAUDE_CODE_OAUTH_TOKEN'],
      }],
      expected: true,
    },
    {
      name: 'approved Anthropic API key',
      env: { ANTHROPIC_API_KEY: 'api-canary' },
      envAllowlist: ['ANTHROPIC_API_KEY'],
      providerEnv: [{
        id: 'envp_api',
        active: true,
        approvedSecretKeys: ['ANTHROPIC_API_KEY'],
      }],
      expected: true,
    },
    {
      name: 'provider-only allowlisted Bedrock cloud mode',
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      envAllowlist: ['CLAUDE_CODE_USE_BEDROCK'],
      providerEnv: [{
        id: 'envp_bedrock',
        active: true,
        inheritedKeys: ['CLAUDE_CODE_USE_BEDROCK'],
      }],
      expected: true,
    },
    {
      name: 'nothing available',
      env: {},
      envAllowlist: ['CUSTOM_NON_AUTH_CONFIG'],
      providerEnv: [],
      expected: false,
    },
  ];

  for (const entry of cases) {
    await withProcessEnv({ ...baseEnv, ...entry.env }, async () => {
      const options = {
        envAllowlist: entry.envAllowlist,
        providerEnv: entry.providerEnv,
        allowDefaultAuth: false,
        hasKeychain: () => false,
        hasCredentialsFile: () => false,
      };
      const normal = resolveClaudeAuth({ ...options, bare: true });
      const isolated = await resolveClaudeAuthForIsolated({
        ...options,
        prefer: 'env',
      });
      assert.equal(normal.canAuth, entry.expected, `${entry.name}: normal`);
      assert.equal(isolated.canAuth, entry.expected, `${entry.name}: isolated`);
      assert.equal(isolated.canAuth, normal.canAuth, `${entry.name}: parity`);
      if (isolated.apiKeyHelperSettings) isolated.apiKeyHelperSettings.cleanup();
    });
  }
});

test('review 2: binding a config-only provider preserves empty-allowlist default auth for Claude and Codex', async (t) => {
  await withProcessEnv({
    PALANTIR_SKIP_HOST_CREDENTIALS: '1',
    ANTHROPIC_API_KEY: 'default-claude-auth',
    OPENAI_API_KEY: 'default-codex-auth',
    CUSTOM_REGION: 'provider-region',
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CODEX_API_KEY: undefined,
  }, async () => {
    const { createEnvironmentProviderService } = require('../services/environmentProviderService');
    for (const [profileId, authKey] of [
      ['claude-code', 'ANTHROPIC_API_KEY'],
      ['codex', 'OPENAI_API_KEY'],
    ]) {
      const harness = await createManagerDbHarness(
        t,
        `palantir-provider-default-auth-${profileId}`,
      );
      const provider = createEnvironmentProviderService(harness.db).createProvider({
        name: `config-only-${profileId}`,
        env_keys: ['CUSTOM_REGION'],
      });
      harness.agentProfileService.updateProfile(profileId, {
        env_allowlist: '[]',
        environment_provider_ids: [provider.id],
      });

      const { response, call } = await startFreshManager(harness, { profileId });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.ok(call);
      assert.equal(call.opts.env[authKey], process.env[authKey]);
      assert.equal(call.opts.env.CUSTOM_REGION, 'provider-region');
    }
  });
});

test('review 3: an inactive provider gate suppresses approved secrets and config in the actual manager child', async (t) => {
  await withProcessEnv({
    CLAUDE_CODE_USE_BEDROCK: undefined,
    AWS_REGION: 'ap-northeast-2',
    AWS_SECRET_ACCESS_KEY: 'must-stay-ambient',
  }, async () => {
    const { createEnvironmentProviderService } = require('../services/environmentProviderService');
    const harness = await createManagerDbHarness(t, 'palantir-provider-gate-off');
    const provider = createEnvironmentProviderService(harness.db).createProvider({
      name: 'gated-bedrock',
      env_keys: [
        'CLAUDE_CODE_USE_BEDROCK',
        'AWS_REGION',
        'AWS_SECRET_ACCESS_KEY',
      ],
      gate_env_key: 'CLAUDE_CODE_USE_BEDROCK',
      gate_env_value: '1',
    });
    harness.agentProfileService.updateProfile('claude-code', {
      env_allowlist: JSON.stringify(['AWS_SECRET_ACCESS_KEY']),
      environment_provider_ids: [provider.id],
    });

    const { response, call } = await startFreshManager(harness, {
      authResolverOpts: {
        hasKeychain: () => true,
        hasCredentialsFile: () => false,
      },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.ok(call);
    for (const key of [
      'CLAUDE_CODE_USE_BEDROCK',
      'AWS_REGION',
      'AWS_SECRET_ACCESS_KEY',
    ]) {
      assert.equal(hasOwn(call.opts.env, key), false, `${key} must stay absent`);
    }
    const profile = harness.agentProfileService.getProfile('claude-code');
    assert.equal(profile.environment_providers[0].active, false);
    assert.deepEqual(profile.effective_env_allowlist, []);
  });
});

test('review 4: NULL env_allowlist applies provider policy to fresh and resumed manager children', async (t) => {
  await withProcessEnv({
    NULL_POLICY_REGION: 'null-policy-region',
  }, async () => {
    const { createManagerRouter } = require('../routes/manager');
    const { createEnvironmentProviderService } = require('../services/environmentProviderService');
    const authResolverOpts = {
      hasKeychain: () => true,
      hasCredentialsFile: () => false,
    };
    const configure = (harness, name) => {
      const provider = createEnvironmentProviderService(harness.db).createProvider({
        name,
        env_keys: ['NULL_POLICY_REGION'],
      });
      harness.agentProfileService.updateProfile('claude-code', {
        env_allowlist: null,
        environment_provider_ids: [provider.id],
      });
    };

    const fresh = await createManagerDbHarness(t, 'palantir-null-policy-fresh');
    configure(fresh, 'null-policy-fresh');
    const freshResult = await startFreshManager(fresh, { authResolverOpts });
    assert.equal(
      freshResult.response.status,
      201,
      JSON.stringify(freshResult.response.body),
    );
    assert.ok(freshResult.call);
    assert.equal(freshResult.call.opts.env.NULL_POLICY_REGION, 'null-policy-region');

    const resumed = await createManagerDbHarness(t, 'palantir-null-policy-resume');
    configure(resumed, 'null-policy-resume');
    const stale = resumed.runService.createRun({
      is_manager: true,
      prompt: 'resume null provider policy',
      agent_profile_id: 'claude-code',
      manager_adapter: 'claude-code',
      manager_layer: 'top',
      conversation_id: 'top',
    });
    resumed.runService.updateRunStatus(stale.id, 'running', { force: true });
    resumed.runService.updateClaudeSessionId(stale.id, 'resume-null-provider');
    createManagerRouter({
      runService: resumed.runService,
      managerAdapterFactory: resumed.managerAdapterFactory,
      managerRegistry: resumed.managerRegistry,
      conversationService: resumed.conversationService,
      agentProfileService: resumed.agentProfileService,
      authResolverOpts,
    });
    const resumedCall = resumed.calls.find((entry) => entry.runId === stale.id);
    assert.ok(resumedCall);
    assert.equal(resumedCall.opts.env.NULL_POLICY_REGION, 'null-policy-region');
    assert.deepEqual(resumedCall.opts.env, freshResult.call.opts.env);
  });
});

test('fresh and resumed managers inherit declared provider env while provider-only secrets remain dropped and attributed', async (t) => {
  await withProcessEnv({
    PROVIDER_MANAGER_REGION: 'manager-region',
    AWS_SECRET_ACCESS_KEY: 'manager-secret-must-not-be-logged',
  }, async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      const { createManagerRouter } = require('../routes/manager');
      const { createEnvironmentProviderService } = require('../services/environmentProviderService');
      const configureProvider = (harness) => {
        const provider = createEnvironmentProviderService(harness.db).createProvider({
          name: 'manager-declared-provider',
          env_keys: ['PROVIDER_MANAGER_REGION', 'AWS_SECRET_ACCESS_KEY'],
        });
        harness.agentProfileService.updateProfile('claude-code', {
          environment_provider_ids: [provider.id],
        });
      };
      const authResolverOpts = {
        hasKeychain: () => true,
        hasCredentialsFile: () => false,
      };

      const fresh = await createManagerDbHarness(t, 'palantir-provider-env-fresh');
      configureProvider(fresh);
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/manager', createManagerRouter({
        runService: fresh.runService,
        managerAdapterFactory: fresh.managerAdapterFactory,
        managerRegistry: fresh.managerRegistry,
        conversationService: fresh.conversationService,
        agentProfileService: fresh.agentProfileService,
        authResolverOpts,
      }));
      const response = await invokeApp(freshApp, {
        method: 'POST',
        path: '/api/manager/start',
        body: {
          prompt: 'fresh provider allowlist',
          agent_profile_id: 'claude-code',
        },
      });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      const freshCall = fresh.calls.find((call) => !call.opts.resumeSessionId);
      assert.ok(freshCall);

      const resumed = await createManagerDbHarness(t, 'palantir-provider-env-resume');
      configureProvider(resumed);
      const stale = resumed.runService.createRun({
        is_manager: true,
        prompt: 'resume provider allowlist',
        agent_profile_id: 'claude-code',
        manager_adapter: 'claude-code',
        manager_layer: 'top',
        conversation_id: 'top',
      });
      resumed.runService.updateRunStatus(stale.id, 'running', { force: true });
      resumed.runService.updateClaudeSessionId(stale.id, 'resume-provider-session');
      createManagerRouter({
        runService: resumed.runService,
        managerAdapterFactory: resumed.managerAdapterFactory,
        managerRegistry: resumed.managerRegistry,
        conversationService: resumed.conversationService,
        agentProfileService: resumed.agentProfileService,
        authResolverOpts,
      });
      const resumedCall = resumed.calls.find((call) => call.runId === stale.id);
      assert.ok(resumedCall);

      for (const captured of [freshCall, resumedCall]) {
        assert.equal(captured.opts.env.PROVIDER_MANAGER_REGION, 'manager-region');
        assert.equal(hasOwn(captured.opts.env, 'AWS_SECRET_ACCESS_KEY'), false);
      }
      assert.deepEqual(resumedCall.opts.env, freshCall.opts.env);

      for (const context of ['manager:fresh:top', 'manager:resume:top']) {
        const line = warnings.find((entry) => (
          entry.includes(`"context":"${context}"`)
          && entry.includes('"name":"manager-declared-provider"')
          && entry.includes('AWS_SECRET_ACCESS_KEY')
        ));
        assert.ok(line, `missing provider-attributed diagnostic for ${context}`);
        assert.doesNotMatch(line, /manager-secret-must-not-be-logged/);
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('fresh and resume security diagnostics are emitted before an unavailable-auth gate', async (t) => {
  await withProcessEnv({
    PALANTIR_SKIP_HOST_CREDENTIALS: '1',
    MIGRATED_AUTH_ENV_KEY: 'migration-secret-must-not-be-logged',
  }, async () => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
      const { createManagerRouter } = require('../routes/manager');
      const authResolverOpts = {
        hasKeychain: () => false,
        hasCredentialsFile: () => false,
      };

      const fresh = await createManagerDbHarness(t, 'palantir-env-auth-gate-fresh');
      const freshApp = express();
      freshApp.use(express.json());
      freshApp.use('/api/manager', createManagerRouter({
        runService: fresh.runService,
        managerAdapterFactory: fresh.managerAdapterFactory,
        managerRegistry: fresh.managerRegistry,
        conversationService: fresh.conversationService,
        agentProfileService: fresh.agentProfileService,
        authResolverOpts,
      }));
      const freshResponse = await invokeApp(freshApp, {
        method: 'POST',
        path: '/api/manager/start',
        body: {
          prompt: 'migration diagnostic',
          agent_profile_id: 'claude-code',
        },
      });
      assert.equal(freshResponse.status, 400);
      assert.equal(freshResponse.body.error, 'manager_auth_unavailable');

      const resumed = await createManagerDbHarness(t, 'palantir-env-auth-gate-resume');
      const stale = resumed.runService.createRun({
        is_manager: true,
        prompt: 'stale migration diagnostic',
        agent_profile_id: 'claude-code',
        manager_adapter: 'claude-code',
        manager_layer: 'top',
        conversation_id: 'top',
      });
      resumed.runService.updateRunStatus(stale.id, 'running', { force: true });
      resumed.runService.updateClaudeSessionId(stale.id, 'resume-auth-gate');
      createManagerRouter({
        runService: resumed.runService,
        managerAdapterFactory: resumed.managerAdapterFactory,
        managerRegistry: resumed.managerRegistry,
        conversationService: resumed.conversationService,
        agentProfileService: resumed.agentProfileService,
        authResolverOpts,
      });
      assert.equal(resumed.runService.getRun(stale.id).status, 'stopped');

      for (const context of ['manager:fresh:top', 'manager:resume:top']) {
        const line = warnings.find((entry) => (
          entry.includes(`"context":"${context}"`)
          && entry.includes('MIGRATED_AUTH_ENV_KEY')
        ));
        assert.ok(line, `missing pre-auth-gate diagnostic for ${context}`);
        assert.doesNotMatch(line, /migration-secret-must-not-be-logged/);
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

// MUTATION: malformed policy must never widen resume back to default auth.
test('MUTATION: a malformed profile env_allowlist fails closed on resume', () => {
  const { __testables } = require('../routes/manager');
  const resolveResumeEnvAllowlist = __testables && __testables.resolveResumeEnvAllowlist;
  assert.ok(resolveResumeEnvAllowlist, 'resolveResumeEnvAllowlist must be exported for test');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  try {
    for (const broken of ['{not json', '"a string"', '{"a":1}', '42']) {
      const svc = {
        listProfiles: () => [{ id: 'ap_broken', type: 'codex', env_allowlist: broken }],
      };
      assert.throws(
        () => resolveResumeEnvAllowlist(svc, { adapterType: 'codex' }),
        (err) => err.code === 'PROVIDER_ENV_POLICY_INVALID',
        `malformed allowlist ${broken} must fail closed`,
      );
    }
    // MUTATION: a profile whose row cannot be read is a hard resume failure;
    // returning undefined here would restore adapter defaults.
    const throwing = { listProfiles: () => { throw new Error('db gone'); } };
    assert.throws(
      () => resolveResumeEnvAllowlist(throwing, { adapterType: 'codex' }),
      (err) => err.code === 'PROVIDER_ENV_POLICY_INVALID',
    );

    // Degradation is observable, and never echoes an allowlist value.
    assert.ok(
      warnings.some((line) => line.includes('manager_env_allowlist_unreadable')),
      'degradation must be observable',
    );
  } finally {
    console.warn = originalWarn;
  }

  // A well-formed allowlist still resolves — the guard must not swallow those.
  const good = {
    listProfiles: () => [{ id: 'ap_ok', type: 'codex', env_allowlist: '["KEEP_ME"]' }],
  };
  assert.deepEqual(resolveResumeEnvAllowlist(good, { adapterType: 'codex' }), ['KEEP_ME']);
});

test('MUTATION: boot resume records an event and stops on invalid provider policy', async (t) => {
  const harness = await createManagerDbHarness(t, 'palantir-invalid-policy-resume');
  harness.db.prepare(
    'UPDATE agent_profiles SET env_allowlist = ? WHERE id = ?',
  ).run('{broken provider policy', 'claude-code');
  const stale = harness.runService.createRun({
    is_manager: true,
    prompt: 'invalid provider resume',
    agent_profile_id: 'claude-code',
    manager_adapter: 'claude-code',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  harness.runService.updateRunStatus(stale.id, 'running', { force: true });
  harness.runService.updateClaudeSessionId(stale.id, 'invalid-policy-resume');

  const { createManagerRouter } = require('../routes/manager');
  createManagerRouter({
    runService: harness.runService,
    managerAdapterFactory: harness.managerAdapterFactory,
    managerRegistry: harness.managerRegistry,
    conversationService: harness.conversationService,
    agentProfileService: harness.agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      hasCredentialsFile: () => false,
    },
  });

  assert.equal(harness.runService.getRun(stale.id).status, 'stopped');
  assert.equal(harness.calls.some((call) => call.runId === stale.id), false);
  assert.ok(
    harness.runService.getRunEvents(stale.id)
      .some((event) => event.event_type === 'manager:resume_env_policy_invalid'),
  );
});
