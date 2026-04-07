/**
 * Usage / provider API contract tests.
 *
 * Locks the response shape of /api/usage/providers and /api/agents/:id/usage
 * so the upcoming Phase 1 (provider/usage layer consolidation) refactor cannot
 * silently change the wire format. Each test exercises a deterministic path that
 * does NOT shell out (no `claude`, `codex`, `gemini` invocations) — the routes
 * already return structured fallback objects when credentials/binaries are missing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function createTestApp(t) {
  const storageRoot = await createTempDir('palantir-storage-');
  const fsRoot = await createTempDir('palantir-fs-');
  const dbPath = path.join(await createTempDir('palantir-db-'), 'test.db');
  // Force a non-existent opencode auth path so providerService deterministically
  // returns an empty registered-provider list (no provider-specific fetches happen).
  const opencodeAuthPath = path.join(await createTempDir('palantir-auth-'), 'missing-auth.json');

  const app = createApp({
    storageRoot,
    fsRoot,
    opencodeBin: 'opencode',
    dbPath,
    opencodeAuthPath,
  });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    else app.closeDb();
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true });
    await fs.rm(path.dirname(opencodeAuthPath), { recursive: true, force: true });
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

// ---- /api/usage/providers ----

test('GET /api/usage/providers returns canonical envelope when no auth file present', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app).get('/api/usage/providers');

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.ok(Array.isArray(res.body.providers), 'providers should be an array');
  assert.ok(Array.isArray(res.body.registeredProviders), 'registeredProviders should be an array');
  // With a missing auth.json, providerService.listRegisteredProviders() returns []
  assert.deepEqual(res.body.registeredProviders, []);
  assert.deepEqual(res.body.providers, []);
});

// ---- /api/agents/:id/usage ----

test('GET /api/agents/:id/usage returns fallback shape for unknown agent type', async (t) => {
  const { app } = await createTestApp(t);
  // Default seeded profile `opencode` has type='opencode' which has no usage provider
  // → route returns the structured fallback object instead of throwing.
  const res = await request(app).get('/api/agents/opencode/usage');

  assert.equal(res.status, 200);
  assert.ok(res.body.agent, 'agent included in response');
  assert.equal(res.body.agent.id, 'opencode');
  assert.equal(typeof res.body.runningCount, 'number');

  assertProviderShape(res.body.usage, 'opencode usage');
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

test('GET /api/agents/:id/usage returns gemini fallback shape when GEMINI_API_KEY missing', async (t) => {
  const prevKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (prevKey !== undefined) process.env.GEMINI_API_KEY = prevKey;
  });

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
  // fetchGeminiUsage('') returns id='google', name='gemini' with the missing-key fallback
  assert.equal(res.body.usage.id, 'google');
  assert.equal(res.body.usage.name, 'gemini');
  assert.match(res.body.usage.limits[0].errorMessage || '', /GEMINI_API_KEY/);
});
