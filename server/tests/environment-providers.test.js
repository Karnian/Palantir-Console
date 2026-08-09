'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createApp } = require('../app');
const { invokeApp } = require('./helpers/invokeApp');

// Keep the branch's fluent request style without opening a loopback listener;
// the sandbox intentionally forbids loopback binds.
function request(app) {
  const build = (method, requestPath) => {
    const state = { headers: {}, body: undefined };
    const chain = {
      set(name, value) {
        state.headers[name] = value;
        return chain;
      },
      send(body) {
        state.body = body;
        return chain;
      },
      then(resolve, reject) {
        return invokeApp(app, {
          method,
          path: requestPath,
          headers: state.headers,
          body: state.body,
        }).then(resolve, reject);
      },
    };
    return chain;
  };
  return {
    get: (requestPath) => build('GET', requestPath),
    post: (requestPath) => build('POST', requestPath),
    patch: (requestPath) => build('PATCH', requestPath),
    delete: (requestPath) => build('DELETE', requestPath),
  };
}

// Declaring a provider widens what a spawned agent may receive, so these routes
// are cookie-only — the same gate model policy writes use.
const COOKIE = ['Cookie', 'palantir_token=secret-token'];
const { buildManagerSpawnEnv } = require('../services/authResolver');

async function createTestApp(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pal-envp-storage-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pal-envp-fs-'));
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pal-envp-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath,
    opencodeBin: 'opencode',
    authToken: 'secret-token',
    authResolverOpts: {
      hasKeychain: () => false,
      hasCredentialsFile: () => false,
    },
  });
  app.__providerTestDbPath = dbPath;
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

test('migration seeds no providers and leaves unbound profile responses unchanged', async (t) => {
  const app = await createTestApp(t);
  const providers = await request(app).get('/api/environment-providers').set(...COOKIE);
  assert.equal(providers.status, 200);
  assert.deepEqual(providers.body.providers, []);

  const profile = app.services.agentProfileService.getProfile('codex');
  assert.equal(
    Object.prototype.hasOwnProperty.call(profile, 'environment_provider_ids'),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(profile, 'effective_env_allowlist'),
    false,
  );
  assert.equal(
    profile.env_allowlist,
    '["CODEX_API_KEY","OPENAI_API_KEY"]',
  );
});

test('provider CRUD stores operator-declared keys and exposes secret classification', async (t) => {
  const app = await createTestApp(t);
  const created = await request(app).post('/api/environment-providers').set(...COOKIE).send({
    name: 'declared-custom',
    env_keys: [
      'CUSTOM_PROVIDER_REGION',
      'CUSTOM_PROVIDER_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
    ],
    description: 'operator supplied, not a built-in provider',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.ok(created.body.provider.id.startsWith('envp_'));
  assert.deepEqual(created.body.provider.env_keys, [
    'CUSTOM_PROVIDER_REGION',
    'CUSTOM_PROVIDER_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ]);
  assert.deepEqual(created.body.provider.secret_env_keys, [
    'CUSTOM_PROVIDER_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
  ]);

  const id = created.body.provider.id;
  const updated = await request(app)
    .patch(`/api/environment-providers/${id}`)
    .set(...COOKIE)
    .send({ env_keys: ['CUSTOM_PROVIDER_REGION', 'CUSTOM_PROVIDER_PROJECT'] });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.provider.env_keys, [
    'CUSTOM_PROVIDER_REGION',
    'CUSTOM_PROVIDER_PROJECT',
  ]);

  const fetched = await request(app).get(`/api/environment-providers/${id}`).set(...COOKIE);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.provider.name, 'declared-custom');
});

test('profile binding merges only non-secret provider keys until env_allowlist explicitly approves secrets', async (t) => {
  const app = await createTestApp(t);
  const created = await request(app).post('/api/environment-providers').set(...COOKIE).send({
    name: 'declarative-bedrock-example',
    env_keys: [
      'CLAUDE_CODE_USE_BEDROCK',
      'AWS_REGION',
      'AWS_SECRET_ACCESS_KEY',
    ],
  });
  const providerId = created.body.provider.id;

  const bound = await request(app).patch('/api/agents/claude-code').set(...COOKIE).send({
    environment_provider_ids: [providerId],
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.deepEqual(bound.body.agent.environment_provider_ids, [providerId]);
  assert.deepEqual(bound.body.agent.effective_env_allowlist, [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'AWS_REGION',
  ]);
  assert.deepEqual(
    bound.body.agent.environment_providers[0].withheld_secret_env_keys,
    ['AWS_SECRET_ACCESS_KEY'],
  );

  const approved = await request(app).patch('/api/agents/claude-code').set(...COOKIE).send({
    env_allowlist: JSON.stringify([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'AWS_SECRET_ACCESS_KEY',
    ]),
  });
  assert.equal(approved.status, 200);
  assert.ok(approved.body.agent.effective_env_allowlist.includes('AWS_SECRET_ACCESS_KEY'));
  assert.deepEqual(
    approved.body.agent.environment_providers[0].withheld_secret_env_keys,
    [],
  );
});

test('provider validation and referenced delete fail closed', async (t) => {
  const app = await createTestApp(t);
  const invalid = await request(app).post('/api/environment-providers').set(...COOKIE).send({
    name: 'invalid',
    env_keys: ['VALID_ENV', 'not-valid'],
  });
  assert.equal(invalid.status, 400);

  const created = await request(app).post('/api/environment-providers').set(...COOKIE).send({
    name: 'referenced',
    env_keys: ['CUSTOM_REGION'],
  });
  const providerId = created.body.provider.id;
  await request(app).patch('/api/agents/codex').set(...COOKIE).send({
    environment_provider_ids: [providerId],
  });

  const refs = await request(app)
    .get(`/api/environment-providers/${providerId}/references`)
    .set(...COOKIE);
  assert.equal(refs.status, 200);
  assert.ok(refs.body.references.agent_profiles.some((profile) => profile.id === 'codex'));

  const deletion = await request(app).delete(`/api/environment-providers/${providerId}`).set(...COOKIE);
  assert.equal(deletion.status, 409);
  assert.ok(deletion.body.details.agent_profiles.some((profile) => profile.id === 'codex'));
});

test('manager dropped-env diagnostic annotates provider ownership without values', () => {
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    buildManagerSpawnEnv({
      baseEnv: {
        AWS_SECRET_ACCESS_KEY: 'must-not-appear',
        CUSTOM_PROVIDER_REGION: 'ap-test-1',
      },
      envAllowlist: ['CUSTOM_PROVIDER_REGION'],
      providerEnv: [{
        id: 'envp_observed',
        name: 'operator-provider',
        envKeys: ['AWS_SECRET_ACCESS_KEY', 'CUSTOM_PROVIDER_REGION'],
      }],
      vendor: 'claude-code',
      diagnosticContext: 'manager:test:provider',
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /manager_spawn_env_dropped/);
  assert.match(lines[0], /"id":"envp_observed"/);
  assert.match(lines[0], /"name":"operator-provider"/);
  assert.match(lines[0], /"keys":\["AWS_SECRET_ACCESS_KEY"\]/);
  assert.doesNotMatch(lines[0], /must-not-appear|ap-test-1/);
});

test('secret classification is not defeated by case or by missing separators', () => {
  const { isProviderSecretEnvKey } = require('../services/providerEnvPolicy');
  // The names an operator types are not constrained to UPPER_SNAKE_CASE, and
  // ENV_VAR_NAME_RE accepts any case. A classifier that only recognises the
  // tidy spelling waves through the untidy spelling of the same credential.
  for (const key of [
    'AWS_SECRET_ACCESS_KEY',
    'SECRETKEY',
    'MY_SECRETKEY',
    'stripeSecretKey',
    'awsSecretAccessKey',
    'githubToken',
    'my_api_key',
    'VaultPassword',
    'CLIENT_PRIVATE_CERT',
  ]) {
    assert.equal(isProviderSecretEnvKey(key), true, `${key} must require explicit approval`);
  }
  // Still lets ordinary configuration through, or the feature is pointless.
  for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'AWS_REGION', 'HTTP_PROXY', 'MODEL_NAME']) {
    assert.equal(isProviderSecretEnvKey(key), false, `${key} must not need approval`);
  }
});

test('declaring a provider is a human action, not something a bearer token can do', async (t) => {
  const app = await createTestApp(t);
  const body = { name: 'bearer-declared', env_keys: ['SOME_REGION'] };

  // PALANTIR_PM_TOKEN is bearer-only and unscoped, and a goal-mode Operator's
  // own spawn env legitimately contains it. Without this gate an Operator could
  // declare a provider, bind it to its profile, and widen its own effective
  // allowlist for the next spawn with no human in the loop.
  const bearer = await request(app)
    .post('/api/environment-providers')
    .set('Authorization', 'Bearer secret-token')
    .send(body);
  assert.equal(bearer.status, 403, JSON.stringify(bearer.body));

  const crossOrigin = await request(app)
    .post('/api/environment-providers')
    .set(...COOKIE)
    .set('Origin', 'http://evil.example')
    .send(body);
  assert.equal(crossOrigin.status, 403);

  assert.equal(
    (await request(app).get('/api/environment-providers').set(...COOKIE)).body.providers.length,
    0,
    'neither attempt may have created anything',
  );

  const created = await request(app)
    .post('/api/environment-providers')
    .set(...COOKIE)
    .send({ name: 'human-declared', env_keys: ['HUMAN_APPROVED_REGION'] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const providerId = created.body.provider.id;

  const bearerBinding = await request(app)
    .patch('/api/agents/claude-code')
    .set('Authorization', 'Bearer secret-token')
    .send({ environment_provider_ids: [providerId] });
  assert.equal(bearerBinding.status, 403, JSON.stringify(bearerBinding.body));
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      app.services.agentProfileService.getProfile('claude-code'),
      'environment_provider_ids',
    ),
    false,
    'bearer binding must not mutate the profile',
  );

  const cookieBinding = await request(app)
    .patch('/api/agents/claude-code')
    .set(...COOKIE)
    .send({ environment_provider_ids: [providerId] });
  assert.equal(cookieBinding.status, 200, JSON.stringify(cookieBinding.body));
  assert.deepEqual(cookieBinding.body.agent.environment_provider_ids, [providerId]);
});

test('MUTATION: process-loader provider keys are rejected and legacy rows resolve closed', async (t) => {
  const app = await createTestApp(t);
  for (const key of ['NODE_OPTIONS', 'LD_PRELOAD']) {
    const rejected = await request(app)
      .post('/api/environment-providers')
      .set(...COOKIE)
      .send({ name: `denied-${key}`, env_keys: ['SAFE_REGION', key] });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(rejected.body.message || rejected.body.error || '', /denied|process|runtime/i);
  }

  const Database = require('better-sqlite3');
  const rawDb = new Database(app.__providerTestDbPath);
  t.after(() => rawDb.close());
  rawDb.prepare(`
    INSERT INTO environment_providers (id, name, env_keys)
    VALUES (?, ?, ?)
  `).run('envp_legacy_denied', 'legacy-denied', JSON.stringify([
    'SAFE_REGION',
    'NODE_OPTIONS',
  ]));
  app.services.agentProfileService.updateProfile('codex', {
    env_allowlist: JSON.stringify(['NODE_OPTIONS']),
    environment_provider_ids: ['envp_legacy_denied'],
  });
  const policy = app.services.agentProfileService.resolveEnvPolicy('codex');
  assert.equal(policy.valid, false);
  assert.ok(policy.blockedKeys.includes('NODE_OPTIONS'));
  assert.equal(policy.effectiveKeys.includes('NODE_OPTIONS'), false);

  const spawnAttempt = await request(app)
    .post('/api/manager/start')
    .set(...COOKIE)
    .send({
      prompt: 'must not spawn with a legacy denied provider row',
      agent_profile_id: 'codex',
    });
  assert.equal(spawnAttempt.status, 400, JSON.stringify(spawnAttempt.body));
  assert.equal(spawnAttempt.body.error, 'manager_profile_env_allowlist_invalid');
  assert.equal(
    app.services.runService.listRuns().some((run) => run.is_manager),
    false,
    'invalid policy must fail before a manager run or child is created',
  );
});

test('MUTATION: a secret-shaped gate is presence-only and its value is never stored or returned', async (t) => {
  const app = await createTestApp(t);
  const rejected = await request(app)
    .post('/api/environment-providers')
    .set(...COOKIE)
    .send({
      name: 'secret-valued-gate',
      env_keys: ['CUSTOM_PROVIDER_API_KEY'],
      gate_env_key: 'CUSTOM_PROVIDER_API_KEY',
      gate_env_value: 'must-never-persist',
    });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));

  const created = await request(app)
    .post('/api/environment-providers')
    .set(...COOKIE)
    .send({
      name: 'secret-presence-gate',
      env_keys: ['CUSTOM_PROVIDER_API_KEY'],
      gate_env_key: 'CUSTOM_PROVIDER_API_KEY',
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.provider.gate_env_value, null);

  const Database = require('better-sqlite3');
  const rawDb = new Database(app.__providerTestDbPath);
  t.after(() => rawDb.close());
  const row = rawDb.prepare(
    'SELECT gate_env_value FROM environment_providers WHERE id = ?',
  ).get(created.body.provider.id);
  assert.equal(row.gate_env_value, null);

  rawDb.prepare(`
    INSERT INTO environment_providers (
      id, name, env_keys, gate_env_key, gate_env_value
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    'envp_legacy_secret_gate',
    'legacy-secret-gate',
    JSON.stringify(['LEGACY_API_KEY']),
    'LEGACY_API_KEY',
    'legacy-secret-value',
  );
  assert.equal(
    app.services.environmentProviderService
      .getProvider('envp_legacy_secret_gate').gate_env_value,
    null,
  );
});
