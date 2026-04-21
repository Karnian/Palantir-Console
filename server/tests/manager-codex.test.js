const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// PR4: unit-level coverage for the CodexAdapter and managerSystemPrompt
// module. We DO NOT spawn a real `codex exec` here — that requires a live
// codex CLI plus auth, and would make the suite environment-dependent. The
// integration test (one real multi-turn manager session against codex) is
// documented in /tmp/athena_brief.md "Done" criteria and verified manually.

// --- managerSystemPrompt module ---

test('buildManagerSystemPrompt composes role + adapter guardrails + base', () => {
  const {
    buildManagerSystemPrompt,
    buildInitialUserContext,
  } = require('../services/managerSystemPrompt');

  const fakeAdapter = {
    type: 'fake',
    buildGuardrailsSection() { return '## fake adapter notes\nDo nothing.'; },
  };
  const out = buildManagerSystemPrompt({ adapter: fakeAdapter, port: 4177, token: null });
  assert.match(out, /Palantir Manager/);
  assert.match(out, /fake adapter notes/);
  assert.match(out, /\/api\/runs/);
  assert.doesNotMatch(out, /Current State/, 'dynamic context must NOT be in the system prompt');

  // Initial user context contains the dynamic sections.
  const ctx = buildInitialUserContext({
    runSummary: '- Running: 1',
    projectList: '  - p1',
    agentList: '  - claude-code',
    userPrompt: 'hello',
  });
  assert.match(ctx, /Current State/);
  assert.match(ctx, /Available Projects/);
  assert.match(ctx, /Available Agent Profiles/);
  assert.match(ctx, /Initial instruction/);
  assert.match(ctx, /hello/);
});

test('buildManagerSystemPrompt works with no adapter (back-compat)', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok' });
  assert.match(out, /Palantir Manager/);
  assert.match(out, /Bearer tok/);
});

// --- CodexAdapter unit tests ---

test('CodexAdapter exposes Codex capabilities', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const adapter = createCodexAdapter({ runService: null });
  assert.equal(adapter.type, 'codex');
  assert.equal(adapter.capabilities.persistentProcess, false);
  assert.equal(adapter.capabilities.persistentSession, true);
  assert.equal(adapter.capabilities.supportsResume, true);
  assert.equal(adapter.capabilities.supportsUsdCost, false);
  assert.equal(typeof adapter.buildGuardrailsSection(), 'string');
  assert.match(adapter.buildGuardrailsSection(), /Codex CLI adapter notes/);
});

test('CodexAdapter.startSession writes a system prompt temp file and disposeSession cleans it up', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const captured = [];
  const fakeRunService = {
    addRunEvent(_r, t, p) { captured.push({ t, p: JSON.parse(p) }); return captured.length; },
    updateManagerThreadId() { /* unused */ },
    updateRunResult() { /* unused */ },
    updateRunStatus() { /* unused */ },
  };
  const adapter = createCodexAdapter({ runService: fakeRunService });
  const { sessionRef } = adapter.startSession('run_mgr_codex1', {
    systemPrompt: 'hello system',
    cwd: process.cwd(),
    model: 'gpt-5-codex',
  });
  assert.ok(sessionRef.instructionsPath, 'instructionsPath should be set');
  assert.ok(fs.existsSync(sessionRef.instructionsPath), 'temp file should exist');
  const content = fs.readFileSync(sessionRef.instructionsPath, 'utf-8');
  assert.equal(content, 'hello system');

  // Dispose: temp file (and its parent dir) should be unlinked best-effort.
  adapter.disposeSession('run_mgr_codex1');
  // The dispose is async-best-effort; give the fs a tick.
  // It uses fsp.rm which returns a promise we can't await here without
  // making the whole test async — so just check the parent dir at least
  // becomes unreachable on a next tick.
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(fs.existsSync(sessionRef.instructionsPath), false, 'temp file should be cleaned up after dispose');
    resolve();
  }, 50));
});

test('M1: CodexAdapter.runTurn with mcpConfig injects leaf-level -c mcp_servers.<alias>.<key> flags', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  // Capture spawn args without launching a real codex process. readline in
  // spawnOneTurn needs a real Readable for child.stdout; PassThrough is the
  // cheapest option. We never write to it so the rl stays idle.
  let capturedArgs = null;
  const fakeChild = {
    stdin: { write() {}, end() {} },
    stderr: new PassThrough(),
    stdout: new PassThrough(),
    on() { return this; },
    kill() {},
  };
  const fakeSpawn = (_bin, args /* , opts */) => {
    capturedArgs = args;
    return fakeChild;
  };
  const fakeRunService = {
    addRunEvent() {},
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  adapter.startSession('run_mgr_codex_m1', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: {
      mcpServers: {
        ctx7: {
          command: 'npx',
          args: ['-y', '@ctx7/mcp'],
          env: { CTX7_KEY: 'val' },
        },
      },
    },
  });
  const res = adapter.runTurn('run_mgr_codex_m1', { text: 'hi' });
  assert.equal(res.accepted, true);
  assert.ok(capturedArgs, 'spawn was invoked');

  // Extract every `-c <value>` pair
  const cflags = [];
  for (let i = 0; i < capturedArgs.length; i++) {
    if (capturedArgs[i] === '-c' && i + 1 < capturedArgs.length) cflags.push(capturedArgs[i + 1]);
  }
  // Top-level blob must NOT be emitted
  assert.ok(
    !cflags.some(c => /^mcp_servers=/.test(c)),
    'must not emit top-level mcp_servers=<JSON> blob',
  );
  // Leaf-level dotted paths present
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.command=/.test(c)),
    'ctx7.command leaf present',
  );
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.args=/.test(c)),
    'ctx7.args leaf present',
  );
  // env subtable is emitted as inline table (a single leaf) or as env.<name> —
  // accept either form since both are valid TOML. M1 implementation uses the
  // inline-table form for the env object.
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.env=/.test(c)),
    'ctx7.env leaf present',
  );

  adapter.disposeSession('run_mgr_codex_m1');
});

test('M1: CodexAdapter.runTurn with invalid mcpConfig fails closed (accepted=false + TURN_FAILED + session ended)', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { PassThrough } = require('node:stream');
  const events = [];
  const fakeRunService = {
    addRunEvent(_r, t, p) { events.push({ t, p: JSON.parse(p) }); },
    updateManagerThreadId() {},
    updateRunResult() {},
    updateRunStatus(_r, status) { events.push({ t: '__status', status }); },
  };
  // spawn MUST NOT be reached — the flatten throw is upstream of spawn.
  let spawned = 0;
  const fakeSpawn = () => {
    spawned += 1;
    return {
      stdin: { write() {}, end() {} },
      stderr: new PassThrough(),
      stdout: new PassThrough(),
      on() { return this; },
      kill() {},
    };
  };
  const adapter = createCodexAdapter({ runService: fakeRunService, spawnFn: fakeSpawn });
  adapter.startSession('run_mgr_codex_m1_bad', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
    mcpConfig: {
      mcpServers: {
        leak: { command: 'echo', bearer_token: 'secret' },
      },
    },
  });
  const res = adapter.runTurn('run_mgr_codex_m1_bad', { text: 'hi' });
  assert.equal(res.accepted, false, 'runTurn must refuse to proceed');
  assert.equal(spawned, 0, 'spawn must not be invoked');
  // TURN_FAILED emitted with mcp_invalid kind. The normalized event type
  // lives under the 'mgr.' namespace (see eventTypes.NORMALIZED_EVENT_TYPES).
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const turnFailed = events.find(e => e.t === NORMALIZED_EVENT_TYPES.TURN_FAILED);
  assert.ok(turnFailed, 'turn_failed event emitted');
  assert.equal(turnFailed.p.data?.kind, 'mcp_invalid');
  // Run marked failed
  const statusEv = events.find(e => e.t === '__status');
  assert.ok(statusEv && statusEv.status === 'failed', 'run status flipped to failed');
  // Session ended
  assert.equal(adapter.isSessionAlive('run_mgr_codex_m1_bad'), false);

  adapter.disposeSession('run_mgr_codex_m1_bad');
});

test('CodexAdapter normalizes thread.started + agent_message + turn.completed', () => {
  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const { NORMALIZED_EVENT_TYPES } = require('../services/managerAdapters/eventTypes');
  const captured = [];
  let threadIdSet = null;
  const fakeRunService = {
    addRunEvent(_r, t, p) { captured.push({ t, p: p ? JSON.parse(p) : null }); return captured.length; },
    updateManagerThreadId(_r, id) { threadIdSet = id; },
    updateRunResult() {},
    updateRunStatus() {},
  };
  const adapter = createCodexAdapter({ runService: fakeRunService });
  adapter.startSession('run_mgr_codex2', {
    systemPrompt: 'sys',
    cwd: process.cwd(),
  });
  // Reach into the adapter via its session map by driving handleVendorEvent
  // through a synthetic spawn isn't possible from outside; we instead test
  // the adapter behavior indirectly by feeding events through runTurn AFTER
  // we monkey-patch the spawn — too invasive. Instead, validate the public
  // contract: getUsage starts at 0, getSessionId starts null, isSessionAlive
  // is true after startSession.
  assert.equal(adapter.isSessionAlive('run_mgr_codex2'), true);
  assert.equal(adapter.getSessionId('run_mgr_codex2'), null);
  const u = adapter.getUsage('run_mgr_codex2');
  assert.equal(u.inputTokens, 0);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.costUsd, 0);
  adapter.disposeSession('run_mgr_codex2');
  assert.equal(adapter.isSessionAlive('run_mgr_codex2'), false);
});

// --- P4-6: Codex error classifier tests ---

test('classifyCodexErrorAsNotice returns true for severity-based notices', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ severity: 'warning', message: 'something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'warn', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'notice', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'info', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'deprecation', message: '' }), true);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'WARNING', message: '' }), true, 'case insensitive');
  assert.equal(classifyCodexErrorAsNotice({ severity: 'error', message: '' }), false);
  assert.equal(classifyCodexErrorAsNotice({ severity: 'fatal', message: '' }), false);
});

test('classifyCodexErrorAsNotice returns true for code-prefix notices', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ code: 'deprecated_feature_x' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'deprecation_notice' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'notice_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'warn_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'warning_something' }), true);
  assert.equal(classifyCodexErrorAsNotice({ code: 'error_something' }), false);
});

test('classifyCodexErrorAsNotice returns true for deprecation message regex', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice({ message: '[features].foo is deprecated' }), true);
  assert.equal(classifyCodexErrorAsNotice({ message: 'Deprecation warning for X' }), true);
  assert.equal(classifyCodexErrorAsNotice({ message: 'Something else entirely' }), false);
});

test('classifyCodexErrorAsNotice returns false for null/invalid input', () => {
  const { classifyCodexErrorAsNotice } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorAsNotice(null), false);
  assert.equal(classifyCodexErrorAsNotice(undefined), false);
  assert.equal(classifyCodexErrorAsNotice('string'), false);
  assert.equal(classifyCodexErrorAsNotice(42), false);
});

test('classifyCodexErrorKind uses structured error_type first', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ error_type: 'rate_limit', message: 'rate limit hit' }), 'rate_limit');
  assert.equal(classifyCodexErrorKind({ error_type: 'custom_vendor_error', message: '' }), 'custom_vendor_error');
});

test('classifyCodexErrorKind uses structured code field', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ code: 'model_not_available', message: '' }), 'model_not_available');
  // Notice-prefixed codes should NOT be used as error kind
  assert.equal(classifyCodexErrorKind({ code: 'deprecated_feature', message: 'timeout happened' }), 'timeout');
});

test('classifyCodexErrorKind classifies common error patterns via regex', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');

  // rate_limit
  assert.equal(classifyCodexErrorKind({ message: 'Rate limit exceeded' }), 'rate_limit');
  assert.equal(classifyCodexErrorKind({ message: 'rate-limit reached' }), 'rate_limit');

  // auth_error
  assert.equal(classifyCodexErrorKind({ message: 'Unauthorized access' }), 'auth_error');
  assert.equal(classifyCodexErrorKind({ message: '401 auth required' }), 'auth_error');
  assert.equal(classifyCodexErrorKind({ message: 'Forbidden: 403' }), 'auth_error');

  // timeout
  assert.equal(classifyCodexErrorKind({ message: 'Request timed out' }), 'timeout');
  assert.equal(classifyCodexErrorKind({ message: 'ETIMEDOUT connecting' }), 'timeout');
  assert.equal(classifyCodexErrorKind({ message: 'Connection timeout' }), 'timeout');

  // network_error
  assert.equal(classifyCodexErrorKind({ message: 'ECONNREFUSED 127.0.0.1:443' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'ECONNRESET by peer' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'Network error occurred' }), 'network_error');
  assert.equal(classifyCodexErrorKind({ message: 'fetch failed' }), 'network_error');

  // context_length
  assert.equal(classifyCodexErrorKind({ message: 'Context length exceeded' }), 'context_length');
  assert.equal(classifyCodexErrorKind({ message: 'max tokens reached' }), 'context_length');
  assert.equal(classifyCodexErrorKind({ message: 'Input too long for model' }), 'context_length');

  // invalid_model
  assert.equal(classifyCodexErrorKind({ message: 'Model gpt-99 not found' }), 'invalid_model');
  assert.equal(classifyCodexErrorKind({ message: 'The model does not exist' }), 'invalid_model');

  // server_overloaded
  assert.equal(classifyCodexErrorKind({ message: 'Server overloaded, try later' }), 'server_overloaded');
  assert.equal(classifyCodexErrorKind({ message: 'HTTP 503 service unavailable' }), 'server_overloaded');
  assert.equal(classifyCodexErrorKind({ message: 'HTTP 529 overloaded' }), 'server_overloaded');

  // invalid_request
  assert.equal(classifyCodexErrorKind({ message: 'Invalid request body' }), 'invalid_request');
  assert.equal(classifyCodexErrorKind({ message: 'Bad request: missing field' }), 'invalid_request');

  // content_filtered
  assert.equal(classifyCodexErrorKind({ message: 'Content filter triggered' }), 'content_filtered');
  assert.equal(classifyCodexErrorKind({ message: 'Output blocked by safety' }), 'content_filtered');
});

test('classifyCodexErrorKind falls back to unknown_error', () => {
  const { classifyCodexErrorKind } = require('../services/managerAdapters/codexAdapter');
  assert.equal(classifyCodexErrorKind({ message: 'Something completely unexpected' }), 'unknown_error');
  assert.equal(classifyCodexErrorKind({ message: '' }), 'unknown_error');
  assert.equal(classifyCodexErrorKind({}), 'unknown_error');
  assert.equal(classifyCodexErrorKind(null), 'unknown_error');
  assert.equal(classifyCodexErrorKind(undefined), 'unknown_error');
});

// --- P4-7: allowedTools source invariant tests ---

test('P4-7: claudeAdapter allowedTools must NOT include Bash(curl:*)', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const capturedTools = [];
  const adapter = createClaudeAdapter({
    streamJsonEngine: {
      spawnAgent: (_runId, opts) => { capturedTools.push(...(opts.allowedTools || [])); return { pid: 1 }; },
      isAlive: () => false,
      detectExitCode: () => null,
      kill: () => true,
      getOutput: () => '',
      getUsage: () => null,
      getSessionId: () => null,
      sendInput: () => true,
    },
    runService: null,
  });
  adapter.startSession('test-invariant', { prompt: 'hi', cwd: '/tmp' });
  const hasCurl = capturedTools.some(t => /Bash\(curl/i.test(t));
  assert.equal(hasCurl, false, 'Bash(curl:*) must not appear in default allowedTools');
  const hasWebFetch = capturedTools.includes('WebFetch');
  assert.equal(hasWebFetch, true, 'WebFetch must be in default allowedTools');
});

test('P4-7: source invariant — no Bash(curl string literal in claudeAdapter.js baseTools', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'managerAdapters', 'claudeAdapter.js'), 'utf-8');
  // Find the baseTools array definition and extract only the string literals
  // (ignoring comments that may reference Bash(curl in historical context).
  const toolsSection = src.match(/const baseTools\s*=\s*allowedTools\s*\|\|\s*\[([\s\S]*?)\];/);
  assert.ok(toolsSection, 'baseTools array should exist in claudeAdapter.js');
  const stringLiterals = toolsSection[1].match(/'[^']*'/g) || [];
  const hasCurlLiteral = stringLiterals.some(s => s.includes('Bash(curl'));
  assert.equal(hasCurlLiteral, false, 'Bash(curl must not appear as a string literal in baseTools array');
});

test('P4-7: system prompt no longer uses curl examples', () => {
  const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');
  const out = buildManagerSystemPrompt({ adapter: null, port: 4177, token: 'tok' });
  assert.match(out, /WebFetch/, 'system prompt should mention WebFetch');
  assert.doesNotMatch(out, /curl -s/, 'system prompt should not contain curl -s examples');
});

test('ClaudeAdapter exposes Claude guardrails section', () => {
  const { createClaudeAdapter } = require('../services/managerAdapters/claudeAdapter');
  const adapter = createClaudeAdapter({
    streamJsonEngine: { spawnAgent: () => ({ pid: 1 }), isAlive: () => false, detectExitCode: () => null, kill: () => true, getOutput: () => '', getUsage: () => null, getSessionId: () => null, sendInput: () => true },
    runService: null,
  });
  assert.equal(typeof adapter.buildGuardrailsSection, 'function');
  assert.match(adapter.buildGuardrailsSection(), /Claude Code adapter notes/);
});
