/**
 * mcp-config-pipeline.test.js — P4-2 --mcp-config pipeline tests.
 *
 * Covers:
 *  1. Migration 011: projects.mcp_config_path column exists
 *  2. projectService CRUD includes mcp_config_path
 *  3. streamJsonEngine.spawnAgent receives --mcp-config in args when mcpConfig is set
 *  4. pmSpawnService passes mcpConfig from project
 *  5. codexAdapter accepts mcpConfig without throwing
 *  6. claudeAdapter passes mcpConfig through to spawnAgent
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('supertest');
const { createDatabase } = require('../db/database');
const { createApp } = require('../app');

async function mkTestApp(t) {
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({ dbPath });
  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fs.rm(dbDir, { recursive: true, force: true });
  });
  return app;
}

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-db-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// ---------------------------------------------------------------------------
// 1. Migration + column existence
// ---------------------------------------------------------------------------

test('P4-2: projects table has mcp_config_path column', async (t) => {
  const db = await mkdb(t);
  const cols = db.pragma('table_info(projects)').map(c => c.name);
  assert.ok(cols.includes('mcp_config_path'), `Expected mcp_config_path in columns: ${cols.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 2. projectService CRUD with mcp_config_path
// ---------------------------------------------------------------------------

test('P4-2: createProject stores mcp_config_path', async (t) => {
  const app = await mkTestApp(t);
  const res = await request(app)
    .post('/api/projects')
    .send({ name: 'MCP Test', mcp_config_path: '/tmp/test-mcp.json' })
    .expect(201);
  assert.equal(res.body.project.mcp_config_path, '/tmp/test-mcp.json');
});

test('P4-2: createProject defaults mcp_config_path to null', async (t) => {
  const app = await mkTestApp(t);
  const res = await request(app)
    .post('/api/projects')
    .send({ name: 'No MCP' })
    .expect(201);
  assert.equal(res.body.project.mcp_config_path, null);
});

test('P4-2: updateProject can set/clear mcp_config_path', async (t) => {
  const app = await mkTestApp(t);
  const create = await request(app)
    .post('/api/projects')
    .send({ name: 'Update Test' })
    .expect(201);
  const id = create.body.project.id;

  // Set
  const upd = await request(app)
    .patch(`/api/projects/${id}`)
    .send({ mcp_config_path: '/etc/mcp/prod.json' })
    .expect(200);
  assert.equal(upd.body.project.mcp_config_path, '/etc/mcp/prod.json');

  // Clear
  const clr = await request(app)
    .patch(`/api/projects/${id}`)
    .send({ mcp_config_path: null })
    .expect(200);
  assert.equal(clr.body.project.mcp_config_path, null);
});

test('P4-2: getProject includes mcp_config_path', async (t) => {
  const app = await mkTestApp(t);
  const create = await request(app)
    .post('/api/projects')
    .send({ name: 'Get Test', mcp_config_path: '/tmp/get.json' })
    .expect(201);
  const id = create.body.project.id;

  const res = await request(app).get(`/api/projects/${id}`).expect(200);
  assert.equal(res.body.project.mcp_config_path, '/tmp/get.json');
});

// ---------------------------------------------------------------------------
// 3. streamJsonEngine buildArgs includes --mcp-config
// ---------------------------------------------------------------------------

test('P4-2: streamJsonEngine.buildArgs includes --mcp-config when mcpConfig set', () => {
  const fsSync = require('node:fs');
  const src = fsSync.readFileSync(require.resolve('../services/streamJsonEngine'), 'utf8');
  assert.ok(src.includes("if (opts.mcpConfig)"), 'buildArgs should handle mcpConfig');
  assert.ok(src.includes("'--mcp-config', opts.mcpConfig"), 'buildArgs should push --mcp-config flag');
});

// ---------------------------------------------------------------------------
// 4. claudeAdapter passes mcpConfig to spawnAgent
// ---------------------------------------------------------------------------

test('P4-2: claudeAdapter.startSession passes mcpConfig to streamJsonEngine', () => {
  let capturedOpts = null;
  const fakeEngine = {
    spawnAgent: (runId, opts) => {
      capturedOpts = opts;
      return { pid: 1234, engine: 'stream-json', isManager: true };
    },
  };
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({ streamJsonEngine: fakeEngine });

  adapter.startSession('run_test', {
    prompt: 'hello',
    cwd: '/tmp',
    mcpConfig: '/path/to/mcp.json',
  });

  assert.ok(capturedOpts, 'spawnAgent should have been called');
  assert.equal(capturedOpts.mcpConfig, '/path/to/mcp.json');
});

test('P4-2: claudeAdapter.startSession omits mcpConfig when not provided', () => {
  let capturedOpts = null;
  const fakeEngine = {
    spawnAgent: (runId, opts) => {
      capturedOpts = opts;
      return { pid: 1234, engine: 'stream-json', isManager: true };
    },
  };
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({ streamJsonEngine: fakeEngine });

  adapter.startSession('run_test2', {
    prompt: 'hello',
    cwd: '/tmp',
  });

  assert.ok(capturedOpts, 'spawnAgent should have been called');
  assert.equal(capturedOpts.mcpConfig, undefined);
});

// ---------------------------------------------------------------------------
// 5. codexAdapter accepts mcpConfig without throwing
// ---------------------------------------------------------------------------

test('P4-2: codexAdapter.startSession accepts mcpConfig silently', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const adapter = createCodexAdapter({ spawnFn: () => {} });

  assert.doesNotThrow(() => {
    adapter.startSession('run_codex_mcp', {
      systemPrompt: 'test',
      cwd: '/tmp',
      mcpConfig: '/path/to/mcp.json',
    });
  });
});

// ---------------------------------------------------------------------------
// 6. pmSpawnService passes mcpConfig from project (source invariant)
// ---------------------------------------------------------------------------

test('P4-2: pmSpawnService source includes mcpConfig from project', () => {
  const fsSync = require('node:fs');
  const src = fsSync.readFileSync(require.resolve('../services/pmSpawnService'), 'utf8');
  assert.ok(
    src.includes('project.mcp_config_path'),
    'pmSpawnService should reference project.mcp_config_path'
  );
  assert.ok(
    src.includes('mcpConfig:'),
    'pmSpawnService should pass mcpConfig to adapter.startSession'
  );
});

// ---------------------------------------------------------------------------
// 7. lifecycleService passes mcpConfig from project (source invariant)
// ---------------------------------------------------------------------------

test('P4-2: lifecycleService source includes projectMcpConfig', () => {
  const fsSync = require('node:fs');
  const src = fsSync.readFileSync(require.resolve('../services/lifecycleService'), 'utf8');
  assert.ok(
    src.includes('projectMcpConfig'),
    'lifecycleService should capture projectMcpConfig from project'
  );
  // Phase 1b: mcpConfig now comes from effectiveMcpConfig (skill pack merged or fallback to project)
  assert.ok(
    src.includes('effectiveMcpConfig') && src.includes('mcpConfig: effectiveMcpConfig'),
    'lifecycleService should pass mcpConfig (effectiveMcpConfig) to spawnAgent'
  );
});
