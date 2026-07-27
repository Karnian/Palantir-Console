/**
 * Usage / provider API contract tests.
 *
 * Locks the response shape of /api/usage/providers and /api/agents/:id/usage
 * so provider-layer refactors cannot silently change the wire format. Every
 * provider adapter is injected here; these tests never inspect host credentials
 * or invoke `claude`, `codex`, or `gemini`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const request = require('supertest');
const { createApp } = require('../app');
const { CLAUDE_OAUTH_USAGE_JS } = require('../services/remoteSshExecutor');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const UPDATED_AT = '2026-01-01T00:00:00.000Z';

function provider(id, name, remainingPct, errorMessage) {
  return {
    id,
    name,
    limits: [{ label: 'usage', remainingPct, resetAt: null, ...(errorMessage ? { errorMessage } : {}) }],
    updatedAt: UPDATED_AT,
  };
}

async function createTestApp(t, {
  codexProviderStatusFn = async () => provider('codex', 'codex', 80),
  fetchClaudeCodeUsageFn = async () => provider('anthropic', 'claude', 70),
  fetchGeminiUsageFn = async () => provider('google', 'gemini', null, 'GEMINI_API_KEY not set'),
} = {}) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  const codexService = {
    getProviderStatus: codexProviderStatusFn,
    async getStatus() {
      const { id, name, ...status } = await codexProviderStatusFn();
      return status;
    },
  };

  const app = createApp({
    storageRoot,
    fsRoot,
    opencodeBin: 'opencode',
    dbPath,
    codexService,
    fetchClaudeCodeUsageFn,
    fetchGeminiUsageFn,
  });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  return { app };
}

// Reusable shape assertion: every provider entry must have id/name/limits/updatedAt
// and each limit must carry label + nullable remainingPct/resetAt.
function assertProviderShape(provider, label) {
  assert.ok(provider, `${label}: provider missing`);
  assert.equal(typeof provider.id, 'string', `${label}: id should be string`);
  assert.equal(typeof provider.name, 'string', `${label}: name should be string`);
  assert.ok(Array.isArray(provider.limits), `${label}: limits should be array`);
  assert.ok(provider.limits.length >= 1, `${label}: limits should have at least 1 entry`);
  for (const [i, limit] of provider.limits.entries()) {
    assert.equal(typeof limit.label, 'string', `${label}.limits[${i}]: label should be string`);
    assert.ok(
      'remainingPct' in limit,
      `${label}.limits[${i}]: remainingPct key required (may be null)`,
    );
    assert.ok(
      'resetAt' in limit,
      `${label}.limits[${i}]: resetAt key required (may be null)`,
    );
  }
  assert.equal(typeof provider.updatedAt, 'string', `${label}: updatedAt should be ISO string`);
  // Sanity-check ISO 8601
  assert.ok(!Number.isNaN(Date.parse(provider.updatedAt)), `${label}: updatedAt parses as date`);
}

function runClaudeUsageProbe(credentials, responses) {
  const requests = [];
  let stdout = '';

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock Claude usage probe timed out')), 1000);
    const fakeProcess = {
      stdout: { write(chunk) { stdout += String(chunk); } },
      exit(code) {
        clearTimeout(timer);
        resolve({ code, stdout, requests });
      },
    };
    const https = {
      request(options, onResponse) {
        const request = new EventEmitter();
        const recorded = { options, body: '' };
        requests.push(recorded);
        request.write = (chunk) => { recorded.body += String(chunk); };
        request.destroy = () => {};
        request.end = () => {
          const responseSpec = responses.shift();
          if (!responseSpec) {
            reject(new Error(`unexpected HTTPS request: ${options.method} ${options.host}${options.path}`));
            return;
          }
          process.nextTick(() => {
            const response = new EventEmitter();
            response.statusCode = responseSpec.statusCode;
            onResponse(response);
            if (responseSpec.body) response.emit('data', Buffer.from(responseSpec.body));
            response.emit('end');
          });
        };
        return request;
      },
    };
    const context = {
      Buffer,
      Date,
      process: fakeProcess,
      require(id) {
        if (id === 'https') return https;
        if (id === 'os') return { homedir: () => '/mock-home' };
        if (id === '/mock-home/.claude/.credentials.json') {
          return { claudeAiOauth: credentials };
        }
        throw new Error(`unexpected require: ${id}`);
      },
    };

    try {
      vm.runInNewContext(CLAUDE_OAUTH_USAGE_JS, context);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

test('an expired access token is reported locally, with no network call at all', async () => {
  // The probe must NOT try to refresh. Refreshing would mean rewriting the
  // CLI's own credential file on the pod, and if the grant rotates the refresh
  // token, discarding the new one revokes the user's login — on every poll of
  // an idle node. Detect, report, and let the user run Claude there once.
  const result = await runClaudeUsageProbe({
    accessToken: 'expired-access',
    refreshToken: 'still-valid-refresh',
    expiresAt: Date.now() - 60_000,
    scopes: ['user:profile', 'user:inference'],
  }, []);

  assert.equal(result.code, 4);
  assert.equal(result.stdout, '__CLAUDE_TOKEN_EXPIRED__');
  assert.deepEqual(
    result.requests,
    [],
    'a known-expired token must not reach the network, and must never spend the refresh token',
  );
});

test('a live access token still queries usage directly', async () => {
  const usageBody = JSON.stringify({ five_hour: { utilization: 25 } });
  const result = await runClaudeUsageProbe({
    accessToken: 'live-access',
    expiresAt: Date.now() + 3_600_000,
  }, [{ statusCode: 200, body: usageBody }]);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, usageBody);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].options.host, 'api.anthropic.com');
  assert.equal(result.requests[0].options.path, '/api/oauth/usage');
  assert.equal(result.requests[0].options.headers.Authorization, 'Bearer live-access');
});

// ---- /api/usage/providers ----

test('GET /api/usage/providers always attempts known providers without auth configuration', async (t) => {
  const calls = [];
  const { app } = await createTestApp(t, {
    codexProviderStatusFn: async () => {
      calls.push('codex');
      return provider('codex', 'codex', 80);
    },
    fetchClaudeCodeUsageFn: async () => {
      calls.push('claude');
      return provider('anthropic', 'claude', 70);
    },
    fetchGeminiUsageFn: async () => {
      calls.push('gemini');
      return provider('google', 'gemini', null, 'GEMINI_API_KEY not set');
    },
  });
  const res = await request(app).get('/api/usage/providers');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(Array.isArray(res.body.providers), 'providers should be an array');
  assert.equal('registeredProviders' in res.body, false);
  assert.deepEqual(calls.sort(), ['claude', 'codex', 'gemini']);
  assert.deepEqual(res.body.providers.map((entry) => entry.id), ['codex', 'anthropic', 'google']);
  res.body.providers.forEach((entry, index) => assertProviderShape(entry, `provider ${index}`));
});

// ---- /api/agents/:id/usage ----

test('GET /api/agents/:id/usage returns fallback shape for unknown agent type', async (t) => {
  const { app } = await createTestApp(t);

  const created = await request(app).post('/api/agents').send({
    name: 'Test Unknown',
    type: 'made-up',
    command: 'gemini',
    args_template: '{prompt}',
  });
  assert.equal(created.status, 201);
  const agentId = created.body.agent.id;

  const res = await request(app).get(`/api/agents/${agentId}/usage`);

  assert.equal(res.status, 200);
  assert.ok(res.body.agent, 'agent included in response');
  assert.equal(res.body.agent.id, agentId);
  assert.equal(typeof res.body.runningCount, 'number');

  assertProviderShape(res.body.usage, 'unknown agent usage');
  // Fallback path emits an explicit errorMessage on the limit entry
  const limit = res.body.usage.limits[0];
  assert.ok(limit.errorMessage, 'fallback should include errorMessage');
  assert.match(limit.errorMessage, /usage provider/i);
  // Fallback envelope must preserve the agent's display name so UI cards
  // don't degrade to the bare provider id.
  assert.equal(res.body.usage.name, res.body.agent.name);
});

test('GET /api/agents/:id/usage returns 404 envelope for unknown agent id', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/agents/does-not-exist/usage');
  // Locks the not-found wire format so Phase 1 refactor cannot accidentally
  // turn this into 200 + empty body or 500 + stack trace.
  assert.equal(res.status, 404);
  assert.equal(typeof res.body.error, 'string');
});

test('GET /api/agents/:id/usage returns injected gemini fallback shape', async (t) => {
  const { app } = await createTestApp(t);

  // Create a gemini-typed agent profile (gemini is in the command allowlist)
  const created = await request(app).post('/api/agents').send({
    name: 'Test Gemini',
    type: 'gemini',
    command: 'gemini',
    args_template: '{prompt}',
  });
  assert.equal(created.status, 201);
  const agentId = created.body.agent.id;

  const res = await request(app).get(`/api/agents/${agentId}/usage`);
  assert.equal(res.status, 200);
  assertProviderShape(res.body.usage, 'gemini usage');
  assert.equal(res.body.usage.id, 'google');
  assert.equal(res.body.usage.name, 'gemini');
  assert.match(res.body.usage.limits[0].errorMessage || '', /GEMINI_API_KEY/);
});
