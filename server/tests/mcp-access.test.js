/**
 * mcp-access.test.js — P3-4 + P3-5 MCP allowedTools extension tests.
 *
 * Covers:
 *  1. parseMcpTools helper (valid JSON, empty, malformed)
 *  2. Agent profile CRUD preserves mcp_tools in capabilities_json
 *  3. claudeAdapter.startSession merges mcpTools into allowedTools
 *  4. Source invariant: AgentModal in app.js contains "MCP Tools" label
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const request = require('supertest');
const { createApp } = require('../app');

// ---------------------------------------------------------------------------
// Helper: parseMcpTools — extracted inline here so it matches the logic in
// lifecycleService.js and routes/manager.js (both duplicate this function).
// ---------------------------------------------------------------------------

function parseMcpTools(capabilitiesJson) {
  try {
    const caps = JSON.parse(capabilitiesJson || '{}');
    return Array.isArray(caps.mcp_tools)
      ? caps.mcp_tools.filter(t => typeof t === 'string' && t.trim())
      : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 1. parseMcpTools unit tests
// ---------------------------------------------------------------------------

test('parseMcpTools — valid mcp_tools array', () => {
  const json = JSON.stringify({ mcp_tools: ['mcp__slack__*', 'mcp__notion__search'] });
  const result = parseMcpTools(json);
  assert.deepEqual(result, ['mcp__slack__*', 'mcp__notion__search']);
});

test('parseMcpTools — empty capabilities_json', () => {
  assert.deepEqual(parseMcpTools('{}'), []);
  assert.deepEqual(parseMcpTools(''), []);
  assert.deepEqual(parseMcpTools(null), []);
  assert.deepEqual(parseMcpTools(undefined), []);
});

test('parseMcpTools — malformed JSON returns []', () => {
  assert.deepEqual(parseMcpTools('{bad json}'), []);
  assert.deepEqual(parseMcpTools('[1,2,3]'), []); // array at top level, not object
});

test('parseMcpTools — mcp_tools not an array returns []', () => {
  assert.deepEqual(parseMcpTools(JSON.stringify({ mcp_tools: 'mcp__slack__*' })), []);
  assert.deepEqual(parseMcpTools(JSON.stringify({ mcp_tools: null })), []);
  assert.deepEqual(parseMcpTools(JSON.stringify({ mcp_tools: 42 })), []);
});

test('parseMcpTools — filters out non-string and blank entries', () => {
  const json = JSON.stringify({ mcp_tools: ['mcp__slack__*', '', '  ', 42, null, 'mcp__notion__*'] });
  const result = parseMcpTools(json);
  assert.deepEqual(result, ['mcp__slack__*', 'mcp__notion__*']);
});

// ---------------------------------------------------------------------------
// 2. Agent profile CRUD preserves mcp_tools in capabilities_json
// ---------------------------------------------------------------------------

async function createTempApp(t) {
  const storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-storage-'));
  const fsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-fs-'));
  const dbDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-db-'));
  const dbPath = path.join(dbDir, 'test.db');
  const app = createApp({ storageRoot, fsRoot, opencodeBin: 'opencode', dbPath });

  t.after(async () => {
    if (app.shutdown) app.shutdown();
    await fsp.rm(storageRoot, { recursive: true, force: true });
    await fsp.rm(fsRoot, { recursive: true, force: true });
    await fsp.rm(dbDir, { recursive: true, force: true });
  });

  return { app };
}

test('POST /api/agents creates profile with mcp_tools in capabilities_json', async (t) => {
  const { app } = await createTempApp(t);
  const res = await request(app)
    .post('/api/agents')
    .send({
      name: 'MCP Worker',
      type: 'claude-code',
      command: 'claude',
      capabilities_json: JSON.stringify({ mcp_tools: ['mcp__slack__*', 'mcp__notion__search'] }),
    });
  assert.equal(res.status, 201);
  // POST /api/agents returns { agent: { ... } }
  const agent = res.body.agent;
  assert.ok(agent, 'response should have .agent');
  const caps = JSON.parse(agent.capabilities_json || '{}');
  assert.deepEqual(caps.mcp_tools, ['mcp__slack__*', 'mcp__notion__search']);
});

test('PATCH /api/agents/:id updates mcp_tools in capabilities_json', async (t) => {
  const { app } = await createTempApp(t);
  // Create first
  const createRes = await request(app)
    .post('/api/agents')
    .send({ name: 'Patch Agent', type: 'claude-code', command: 'claude' });
  assert.equal(createRes.status, 201);
  const agentId = createRes.body.agent.id;

  // Update with mcp_tools
  const patchRes = await request(app)
    .patch(`/api/agents/${agentId}`)
    .send({
      capabilities_json: JSON.stringify({ mcp_tools: ['mcp__context7__*'] }),
    });
  assert.equal(patchRes.status, 200);
  // PATCH /api/agents/:id returns { agent: { ... } }
  const caps = JSON.parse(patchRes.body.agent.capabilities_json || '{}');
  assert.deepEqual(caps.mcp_tools, ['mcp__context7__*']);
});

test('GET /api/agents returns profiles preserving mcp_tools', async (t) => {
  const { app } = await createTempApp(t);
  const createRes = await request(app)
    .post('/api/agents')
    .send({
      name: 'List Agent',
      type: 'claude-code',
      command: 'claude',
      capabilities_json: JSON.stringify({ mcp_tools: ['mcp__foo__*'] }),
    });
  assert.equal(createRes.status, 201);
  const agentId = createRes.body.agent.id;

  // GET /api/agents returns { agents: [...] }
  const listRes = await request(app).get('/api/agents');
  assert.equal(listRes.status, 200);
  assert.ok(Array.isArray(listRes.body.agents), 'response should have .agents array');
  const found = listRes.body.agents.find(a => a.id === agentId);
  assert.ok(found, 'created agent should appear in list');
  const caps = JSON.parse(found.capabilities_json || '{}');
  assert.deepEqual(caps.mcp_tools, ['mcp__foo__*']);
});

// ---------------------------------------------------------------------------
// 3. claudeAdapter.startSession merges mcpTools into allowedTools
// ---------------------------------------------------------------------------

test('claudeAdapter.startSession — mcpTools merged into base allowedTools', () => {
  // Create a minimal mock of streamJsonEngine and runService
  let capturedOpts = null;
  const mockStreamJsonEngine = {
    spawnAgent: (runId, opts) => { capturedOpts = opts; return { pid: 1 }; },
    kill: () => {},
  };
  const mockRunService = {
    addRunEvent: () => {},
  };

  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({ streamJsonEngine: mockStreamJsonEngine, runService: mockRunService });

  adapter.startSession('run_test1', {
    prompt: 'hello',
    cwd: '/tmp',
    mcpTools: ['mcp__slack__*', 'mcp__notion__search'],
  });

  assert.ok(capturedOpts, 'spawnAgent should have been called');
  assert.ok(Array.isArray(capturedOpts.allowedTools), 'allowedTools should be an array');
  // Must contain base tools
  assert.ok(capturedOpts.allowedTools.includes('Read'), 'should include Read');
  // P4-7: Bash(curl:*) removed — WebFetch covers HTTP needs
  assert.ok(!capturedOpts.allowedTools.includes('Bash(curl:*)'), 'should NOT include Bash(curl:*)');
  assert.ok(capturedOpts.allowedTools.includes('WebFetch'), 'should include WebFetch');
  // Must contain MCP tools
  assert.ok(capturedOpts.allowedTools.includes('mcp__slack__*'), 'should include mcp__slack__*');
  assert.ok(capturedOpts.allowedTools.includes('mcp__notion__search'), 'should include mcp__notion__search');
});

test('claudeAdapter.startSession — no mcpTools leaves base allowedTools unchanged', () => {
  let capturedOpts = null;
  const mockStreamJsonEngine = {
    spawnAgent: (runId, opts) => { capturedOpts = opts; return { pid: 1 }; },
    kill: () => {},
  };
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({ streamJsonEngine: mockStreamJsonEngine, runService: null });

  adapter.startSession('run_test2', { prompt: 'hello', cwd: '/tmp' });

  assert.ok(capturedOpts, 'spawnAgent should have been called');
  const tools = capturedOpts.allowedTools;
  assert.ok(Array.isArray(tools));
  // Should only contain base tools — no mcp__ entries
  const mcpEntries = tools.filter(t => t.startsWith('mcp__'));
  assert.equal(mcpEntries.length, 0, 'no MCP entries expected when mcpTools is not passed');
});

test('claudeAdapter.startSession — empty mcpTools array leaves base unchanged', () => {
  let capturedOpts = null;
  const mockStreamJsonEngine = {
    spawnAgent: (runId, opts) => { capturedOpts = opts; return { pid: 1 }; },
    kill: () => {},
  };
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({ streamJsonEngine: mockStreamJsonEngine, runService: null });

  adapter.startSession('run_test3', { prompt: 'hello', cwd: '/tmp', mcpTools: [] });

  const tools = capturedOpts.allowedTools;
  const mcpEntries = tools.filter(t => t.startsWith('mcp__'));
  assert.equal(mcpEntries.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Source invariant: AgentModal in app.js contains "MCP Tools" label
// ---------------------------------------------------------------------------

test('app.js AgentModal contains "MCP Tools" label', () => {
  const appJsPath = path.join(__dirname, '../public/app.js');
  const source = fs.readFileSync(appJsPath, 'utf8');
  assert.ok(
    source.includes('MCP Tools'),
    'app.js AgentModal must contain "MCP Tools" label (P3-5 UI)'
  );
});

test('app.js AgentModal contains mcp_tools textarea placeholder', () => {
  const appJsPath = path.join(__dirname, '../public/app.js');
  const source = fs.readFileSync(appJsPath, 'utf8');
  assert.ok(
    source.includes('mcp__claude_ai_Slack__*') || source.includes('mcp__slack__*'),
    'app.js AgentModal textarea should have an MCP placeholder'
  );
});
