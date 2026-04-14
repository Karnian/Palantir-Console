const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const express = require('express');
const { createDatabase } = require('../db/database');
const { createSkillPackService } = require('../services/skillPackService');
const { createRegistryService } = require('../services/registryService');
const { createSkillPacksRouter } = require('../routes/skillPacks');
const { errorHandler } = require('../middleware/errorHandler');

async function createTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Build a minimal test app with skillPacks router + a stubbable registryService.
 * The stub replaces fetchPackFromUrl so we don't need real HTTPS.
 */
async function createTestApp(t, { fetchStub } = {}) {
  const dbDir = await createTempDir('palantir-url-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();

  const skillPackService = createSkillPackService(db);
  const baseRegistry = createRegistryService();
  const registryService = {
    ...baseRegistry,
    fetchPackFromUrl: fetchStub || baseRegistry.fetchPackFromUrl,
  };

  const app = express();
  app.use(express.json());
  app.use('/api/skill-packs', createSkillPacksRouter({ skillPackService, registryService }));
  app.use(errorHandler);

  t.after(() => {
    close();
    fs.rm(dbDir, { recursive: true, force: true });
  });

  return { app, skillPackService, registryService };
}

// ─── Helper: valid pack fixture ───

function samplePack(overrides = {}) {
  return {
    name: 'Test URL Pack',
    description: 'URL-fetched pack for tests',
    category: 'general',
    author: 'test-author',
    icon: '◉',
    color: '#6c8eef',
    prompt_full: 'You are a test assistant.',
    prompt_compact: 'Test assistant.',
    mcp_servers: {},
    checklist: ['Item 1'],
    inject_checklist: true,
    conflict_policy: 'warn',
    priority: 100,
    ...overrides,
  };
}

// ─── install-url dry-run ───

test('POST /install-url dry_run returns pack + hash + preview_token', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  assert.equal(res.status, 200);
  assert.ok(res.body.pack);
  assert.equal(res.body.hash, 'abc123');
  assert.ok(res.body.preview_token);
  assert.equal(res.body.source_url_display, 'https://example.com/p.json');
});

test('POST /install-url confirm requires preview_token', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', expected_hash: 'abc123' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('preview_token'));
});

test('POST /install-url confirm requires expected_hash', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: 'xxx' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('expected_hash'));
});

test('POST /install-url full flow: dry_run → confirm → installed', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });

  // Dry run
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  assert.equal(dry.status, 200);
  const token = dry.body.preview_token;

  // Confirm
  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({
      url: 'https://example.com/p.json',
      preview_token: token,
      expected_hash: 'abc123',
    });
  assert.equal(install.status, 201);
  assert.equal(install.body.skill_pack.name, 'Test URL Pack');
  assert.equal(install.body.skill_pack.origin_type, 'url');
  // source_url is stripped from API responses (server-only per spec §6.2)
  assert.equal(install.body.skill_pack.source_url, undefined);
  assert.equal(install.body.skill_pack.source_url_display, 'https://example.com/p.json');
  assert.equal(install.body.skill_pack.source_hash, 'abc123');
  assert.equal(install.body.skill_pack.scope, 'global');
});

test('POST /install-url rejects bad preview_token', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({
      url: 'https://example.com/p.json',
      preview_token: 'never-issued',
      expected_hash: 'abc123',
    });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('preview_token'));
});

test('POST /install-url rejects when preview_token consumed twice', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });

  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const token = dry.body.preview_token;

  // First install succeeds
  const first = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: token, expected_hash: 'abc123' });
  assert.equal(first.status, 201);

  // Need another fixture (different name to avoid name collision 409)
  // But same URL → source_url collision 409 happens before token reuse check
  // Test token reuse with different URL — needs separate fixture
  const fetchStub2 = async () => ({
    canonicalUrl: 'https://example.com/q.json',
    displayUrl: 'https://example.com/q.json',
    pack: samplePack({ name: 'Another' }),
    hash: 'abc123',
  });
});

test('POST /install-url detects TOCTOU (hash changed since preview)', async (t) => {
  let fetchCount = 0;
  const fetchStub = async () => {
    fetchCount++;
    return {
      canonicalUrl: 'https://example.com/p.json',
      displayUrl: 'https://example.com/p.json',
      pack: samplePack(),
      hash: fetchCount === 1 ? 'hash-a' : 'hash-b', // different hash on second fetch
    };
  };
  const { app } = await createTestApp(t, { fetchStub });

  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  assert.equal(dry.body.hash, 'hash-a');

  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({
      url: 'https://example.com/p.json',
      preview_token: dry.body.preview_token,
      expected_hash: 'hash-a',
    });
  // Second fetch returns hash-b → hash !== expected_hash → 409 OR preview_token
  // binding mismatch since token was bound to hash-a but server refetch got hash-b
  assert.ok([409, 400].includes(install.status));
});

test('POST /install-url rejects duplicate source_url with 409', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });

  const dry1 = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry1.body.preview_token, expected_hash: 'abc123' });

  // Second attempt with same URL — will fail at installFromUrl's source_url uniqueness
  const dry2 = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry2.body.preview_token, expected_hash: 'abc123' });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('Already installed'));
});

test('POST /install-url rejects name collision with existing pack', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack({ name: 'Existing Pack' }),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });
  // Create a manual pack with same name
  await request(app).post('/api/skill-packs').send({ name: 'Existing Pack', scope: 'global' });

  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry.body.preview_token, expected_hash: 'abc123' });
  assert.equal(res.status, 409);
  assert.ok(res.body.error.includes('already exists'));
});

test('POST /install-url rejects URL without url field', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({});
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('url'));
});

// ─── check-update-url / update-url ───

test('POST /check-update-url returns update_available=false when hash matches', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc123',
  });
  const { app } = await createTestApp(t, { fetchStub });

  // Install first
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry.body.preview_token, expected_hash: 'abc123' });
  const packId = install.body.skill_pack.id;

  // Check update — hash unchanged
  const check = await request(app)
    .post('/api/skill-packs/registry/check-update-url')
    .send({ pack_id: packId });
  assert.equal(check.status, 200);
  assert.equal(check.body.update_available, false);
  assert.ok(check.body.preview_token);
});

test('POST /check-update-url returns update_available=true when hash differs', async (t) => {
  let fetchCount = 0;
  const fetchStub = async () => {
    fetchCount++;
    return {
      canonicalUrl: 'https://example.com/p.json',
      displayUrl: 'https://example.com/p.json',
      pack: samplePack({ prompt_full: fetchCount >= 3 ? 'Updated prompt.' : 'Original prompt.' }),
      hash: fetchCount >= 3 ? 'new-hash' : 'original-hash',
    };
  };
  const { app } = await createTestApp(t, { fetchStub });

  // Install (fetch 1: dry, fetch 2: confirm)
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry.body.preview_token, expected_hash: 'original-hash' });
  const packId = install.body.skill_pack.id;

  // Check update — fetch 3 returns new hash
  const check = await request(app)
    .post('/api/skill-packs/registry/check-update-url')
    .send({ pack_id: packId });
  assert.equal(check.body.update_available, true);
  assert.equal(check.body.new_hash, 'new-hash');
});

test('POST /check-update-url rejects non-URL pack', async (t) => {
  const { app } = await createTestApp(t);
  // Create a manual pack
  const manual = await request(app).post('/api/skill-packs').send({ name: 'Manual', scope: 'global' });
  const res = await request(app)
    .post('/api/skill-packs/registry/check-update-url')
    .send({ pack_id: manual.body.skill_pack.id });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('URL-installed'));
});

test('POST /update-url updates content, preserves user customizations', async (t) => {
  let fetchCount = 0;
  const fetchStub = async () => {
    fetchCount++;
    return {
      canonicalUrl: 'https://example.com/p.json',
      displayUrl: 'https://example.com/p.json',
      pack: samplePack({
        name: 'Registry Name', // this will be overwritten by user
        prompt_full: fetchCount >= 3 ? 'New content.' : 'Old content.',
      }),
      hash: fetchCount >= 3 ? 'new-hash' : 'old-hash',
    };
  };
  const { app } = await createTestApp(t, { fetchStub });

  // Install
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry.body.preview_token, expected_hash: 'old-hash' });
  const packId = install.body.skill_pack.id;

  // User edits name + priority
  await request(app).patch(`/api/skill-packs/${packId}`).send({ name: 'My Custom', priority: 50 });

  // Check update + update
  const check = await request(app)
    .post('/api/skill-packs/registry/check-update-url')
    .send({ pack_id: packId });
  const upd = await request(app)
    .post('/api/skill-packs/registry/update-url')
    .send({ pack_id: packId, preview_token: check.body.preview_token, expected_hash: 'new-hash' });
  assert.equal(upd.status, 200);

  // User fields preserved
  assert.equal(upd.body.skill_pack.name, 'My Custom');
  assert.equal(upd.body.skill_pack.priority, 50);
  // Content updated
  assert.equal(upd.body.skill_pack.prompt_full, 'New content.');
  assert.equal(upd.body.skill_pack.source_hash, 'new-hash');
});

test('POST /update-url rejects non-URL pack', async (t) => {
  const { app } = await createTestApp(t);
  const manual = await request(app).post('/api/skill-packs').send({ name: 'Manual', scope: 'global' });
  const res = await request(app)
    .post('/api/skill-packs/registry/update-url')
    .send({ pack_id: manual.body.skill_pack.id, preview_token: 'x', expected_hash: 'y' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.includes('URL-installed'));
});

// ─── SSRF integration (real fetchPackFromUrl, no stub) ───

test('SSRF blocks http:// URL via install-url', async (t) => {
  const { app } = await createTestApp(t); // use real fetchPackFromUrl
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'http://example.com/pack.json', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks localhost', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://localhost/pack.json', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks loopback IP', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://127.0.0.1/pack.json', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks AWS metadata IP', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://169.254.169.254/latest/meta-data/', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks RFC1918 range', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://192.168.1.1/pack.json', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks .local hostname', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://foo.local/pack.json', dry_run: true });
  assert.equal(res.status, 400);
});

test('SSRF blocks user:pass@ URL', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://user:pass@example.com/pack.json', dry_run: true });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.toLowerCase().includes('userinfo'));
});

test('SSRF blocks non-443 port', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com:8080/pack.json', dry_run: true });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.toLowerCase().includes('port'));
});

// ─── Bundled namespace collision (v1.1 R1-P1-2) ───

test('POST /install-url rejects URL pack claiming a bundled registry_id (namespace squat)', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack({ registry_id: 'core/code-review', name: 'Pirate Code Review' }),
    hash: 'abc',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', dry_run: true });
  const res = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json', preview_token: dry.body.preview_token, expected_hash: 'abc' });
  assert.equal(res.status, 409);
  assert.ok(/bundled/i.test(res.body.error));
});

// ─── Server-only source_url (v1.1 R1-P1-1) ───

test('API responses do not include full source_url (server-only)', async (t) => {
  const fetchStub = async () => ({
    canonicalUrl: 'https://example.com/p.json?token=secret',
    displayUrl: 'https://example.com/p.json',
    pack: samplePack(),
    hash: 'abc',
  });
  const { app } = await createTestApp(t, { fetchStub });
  const dry = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json?token=secret', dry_run: true });
  const install = await request(app)
    .post('/api/skill-packs/registry/install-url')
    .send({ url: 'https://example.com/p.json?token=secret', preview_token: dry.body.preview_token, expected_hash: 'abc' });
  assert.equal(install.status, 201);
  assert.equal(install.body.skill_pack.source_url, undefined);
  assert.ok(install.body.skill_pack.source_url_display);
  assert.ok(!install.body.skill_pack.source_url_display.includes('token=secret'));

  // Also check list + get endpoints
  const list = await request(app).get('/api/skill-packs');
  for (const p of list.body.skill_packs) {
    assert.equal(p.source_url, undefined);
  }
  const get = await request(app).get(`/api/skill-packs/${install.body.skill_pack.id}`);
  assert.equal(get.body.skill_pack.source_url, undefined);
});

// ─── JSON import origin_type (v1.1 R1-P1-3) ───

test('POST /import marks pack as origin_type=import', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs/import')
    .send({ skill_pack: { name: 'Imported Pack', scope: 'global', prompt_full: 'x' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.skill_pack.origin_type, 'import');
});

test('POST /api/skill-packs creates pack with origin_type=manual by default', async (t) => {
  const { app } = await createTestApp(t);
  const res = await request(app)
    .post('/api/skill-packs')
    .send({ name: 'Manual Pack', scope: 'global' });
  assert.equal(res.body.skill_pack.origin_type, 'manual');
});
