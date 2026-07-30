'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createStreamJsonEngine } = require('../services/streamJsonEngine');
const { createManagerAdapterFactory } = require('../services/managerAdapters');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const { createManagerRouter } = require('../routes/manager');
const { invokeApp } = require('./helpers/invokeApp');

const FAKE_CLAUDE = path.join(
  __dirname,
  'fixtures',
  'bin',
  'fake-claude-stream-json.js',
);

async function readArgs(filePath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError || new Error(`Claude args were not written: ${filePath}`);
}

function permissionModeArg(args) {
  const index = args.indexOf('--permission-mode');
  assert.notEqual(index, -1, `missing --permission-mode in ${JSON.stringify(args)}`);
  return args[index + 1];
}

async function createCapturingManagerHarness(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-manager-profile-'));
  const database = createDatabase(path.join(root, 'test.db'));
  database.migrate();
  const runService = createRunService(database.db, null);
  const agentProfileService = createAgentProfileService(database.db);
  const managerRegistry = createManagerRegistry({ runService });
  const starts = [];
  const adapter = {
    type: 'claude-code',
    capabilities: { persistentProcess: true, supportsResume: true },
    startSession(runId, opts) {
      starts.push({ runId, opts });
      return { sessionRef: { pid: 4321 } };
    },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    disposeSession() { return true; },
    buildGuardrailsSection() { return ''; },
  };
  const managerAdapterFactory = {
    getAdapter(type) {
      assert.equal(type, 'claude-code');
      return adapter;
    },
  };
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService: null,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/manager', createManagerRouter({
    runService,
    managerAdapterFactory,
    managerRegistry,
    conversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'manager-test-keychain-token',
      hasCredentialsFile: () => false,
    },
  }));

  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  return {
    app,
    database,
    agentProfileService,
    runService,
    managerRegistry,
    starts,
  };
}

test('Manager profile permission_mode reaches Claude CLI and NULL matches the worker default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-manager-permission-'));
  const argsFile = path.join(root, 'claude-args.json');
  const previousClaudeBin = process.env.CLAUDE_BIN;
  const previousArgsFile = process.env.CLAUDE_ARGS_FILE;
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.CLAUDE_ARGS_FILE = argsFile;

  const database = createDatabase(path.join(root, 'test.db'));
  database.migrate();
  const runService = createRunService(database.db, null);
  const agentProfileService = createAgentProfileService(database.db);
  const streamJsonEngine = createStreamJsonEngine({ runService });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const managerRegistry = createManagerRegistry({ runService });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService: null,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/manager', createManagerRouter({
    runService,
    streamJsonEngine,
    managerAdapterFactory,
    managerRegistry,
    conversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'manager-test-keychain-token',
      hasCredentialsFile: () => false,
    },
  }));

  t.after(async () => {
    const activeRunId = managerRegistry.getActiveRunId('top');
    if (activeRunId) {
      try {
        await managerRegistry.getActiveAdapter('top')?.disposeSession(activeRunId);
      } catch { /* already stopped */ }
    }
    database.close();
    if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBin;
    if (previousArgsFile === undefined) delete process.env.CLAUDE_ARGS_FILE;
    else process.env.CLAUDE_ARGS_FILE = previousArgsFile;
    await fs.rm(root, { recursive: true, force: true });
  });

  agentProfileService.updateProfile('claude-code', {
    permission_mode: 'acceptEdits',
    env_allowlist: JSON.stringify(['CLAUDE_ARGS_FILE']),
  });

  let response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: { agent_profile_id: 'claude-code', prompt: 'explicit permission mode' },
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(permissionModeArg(await readArgs(argsFile)), 'acceptEdits');
  const explicitRunId = managerRegistry.getActiveRunId('top');
  assert.equal(
    runService.getRun(explicitRunId).session_permission_mode,
    'acceptEdits',
  );

  response = await invokeApp(app, { method: 'POST', path: '/api/manager/stop' });
  assert.equal(response.status, 200, response.text);
  await fs.rm(argsFile, { force: true });

  agentProfileService.updateProfile('claude-code', { permission_mode: null });
  response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: { agent_profile_id: 'claude-code', prompt: 'default permission mode' },
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(permissionModeArg(await readArgs(argsFile)), 'bypassPermissions');

  response = await invokeApp(app, { method: 'POST', path: '/api/manager/stop' });
  assert.equal(response.status, 200, response.text);

  // A raw legacy/imported row can still violate the new save-time invariant.
  // Manager start must fail closed instead of selecting Claude by type while
  // the rest of the profile stack treats this as a Codex command.
  database.db.prepare(`
    UPDATE agent_profiles
    SET type = 'claude-code', command = 'codex'
    WHERE id = 'claude-code'
  `).run();
  response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: { agent_profile_id: 'claude-code', prompt: 'mismatched vendor' },
  });
  assert.equal(response.status, 400, response.text);
  assert.equal(JSON.parse(response.text).error, 'manager_profile_vendor_mismatch');
});

test('Top Manager materializes Keychain-only auth for a real --bare child contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-manager-bare-auth-'));
  const argsFile = path.join(root, 'claude-args.json');
  const contractFile = path.join(root, 'claude-auth-contract.json');
  const previous = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    CLAUDE_ARGS_FILE: process.env.CLAUDE_ARGS_FILE,
    CLAUDE_AUTH_CONTRACT_FILE: process.env.CLAUDE_AUTH_CONTRACT_FILE,
    CLAUDE_REQUIRE_BARE_API_KEY: process.env.CLAUDE_REQUIRE_BARE_API_KEY,
  };
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.CLAUDE_ARGS_FILE = argsFile;
  process.env.CLAUDE_AUTH_CONTRACT_FILE = contractFile;
  process.env.CLAUDE_REQUIRE_BARE_API_KEY = '1';

  const database = createDatabase(path.join(root, 'test.db'));
  database.migrate();
  const runService = createRunService(database.db, null);
  const agentProfileService = createAgentProfileService(database.db);
  agentProfileService.updateProfile('claude-code', {
    args_template: '-p {prompt} --bare --no-chrome --settings locked.json',
    env_allowlist: JSON.stringify([
      'CLAUDE_ARGS_FILE',
      'CLAUDE_AUTH_CONTRACT_FILE',
      'CLAUDE_REQUIRE_BARE_API_KEY',
    ]),
  });
  const streamJsonEngine = createStreamJsonEngine({ runService });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const managerRegistry = createManagerRegistry({ runService });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService: null,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/manager', createManagerRouter({
    runService,
    streamJsonEngine,
    managerAdapterFactory,
    managerRegistry,
    conversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'keychain-only-access-token',
      hasCredentialsFile: () => false,
    },
  }));

  t.after(async () => {
    const activeRunId = managerRegistry.getActiveRunId('top');
    if (activeRunId) {
      try {
        await managerRegistry.getActiveAdapter('top')?.disposeSession(activeRunId);
      } catch { /* already stopped */ }
    }
    database.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: { agent_profile_id: 'claude-code', prompt: 'keychain-only bare auth' },
  });
  assert.equal(response.status, 201, response.text);

  const args = await readArgs(argsFile);
  assert.equal(args.filter((arg) => arg === '--bare').length, 1);
  assert.equal(args.filter((arg) => arg === '--no-chrome').length, 1);
  assert.equal(args[args.indexOf('--settings') + 1], 'locked.json');
  assert.deepEqual(await readArgs(contractFile), {
    bare: true,
    hasAnthropicApiKey: true,
  });
});

test('Top Manager clears its starting guard when Claude template parsing fails', async (t) => {
  const {
    app,
    database,
    starts,
  } = await createCapturingManagerHarness(t);
  database.db.prepare(`
    UPDATE agent_profiles
    SET args_template = ?, permission_mode = NULL
    WHERE id = 'claude-code'
  `).run('-p {prompt} --max-budget-usd nope');

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await invokeApp(app, {
      method: 'POST',
      path: '/api/manager/start',
      body: { agent_profile_id: 'claude-code', prompt: `invalid template ${attempt}` },
    });
    assert.equal(response.status, 400, response.text);
    assert.doesNotMatch(response.text, /Manager session is starting/);
  }
  assert.equal(starts.length, 0);
});

test('Top Manager snapshots and resumes Claude runtime options after profile removal', async (t) => {
  const {
    app,
    agentProfileService,
    runService,
    managerRegistry,
    starts,
  } = await createCapturingManagerHarness(t);
  agentProfileService.updateProfile('claude-code', {
    args_template: '-p {prompt} --tools Read,Grep --disallowedTools Bash --max-budget-usd 0.01 --mcp-config profile.json --strict-mcp-config --safe-mode --bare --disable-slash-commands --no-chrome --setting-sources "" --settings locked.json',
  });

  const response = await invokeApp(app, {
    method: 'POST',
    path: '/api/manager/start',
    body: { agent_profile_id: 'claude-code', prompt: 'deny Bash' },
  });
  assert.equal(response.status, 201, response.text);
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].opts.tools, ['Read,Grep']);
  assert.deepEqual(starts[0].opts.disallowedTools, ['Bash']);
  assert.equal(starts[0].opts.maxBudgetUsd, 0.01);
  assert.equal(starts[0].opts.mcpConfig, 'profile.json');
  assert.equal(starts[0].opts.strictMcpConfig, true);
  assert.equal(starts[0].opts.safeMode, true);
  assert.equal(starts[0].opts.bare, true);
  assert.equal(starts[0].opts.disableSlashCommands, true);
  assert.equal(starts[0].opts.noChrome, true);
  assert.equal(starts[0].opts.settingSources, '');
  assert.equal(starts[0].opts.settings, 'locked.json');
  const run = runService.getRun(managerRegistry.getActiveRunId('top'));
  assert.deepEqual(JSON.parse(run.session_claude_options_json), {
    tools: ['Read,Grep'],
    disallowedTools: ['Bash'],
    maxBudgetUsd: 0.01,
    mcpConfig: 'profile.json',
    strictMcpConfig: true,
    safeMode: true,
    bare: true,
    disableSlashCommands: true,
    noChrome: true,
    settingSources: '',
    settings: 'locked.json',
  });

  runService.updateClaudeSessionId(run.id, 'sess-profile-options');
  agentProfileService.updateProfile('claude-code', {
    args_template: '-p {prompt}',
  });

  const resumeStarts = [];
  const resumeAdapter = {
    type: 'claude-code',
    capabilities: { persistentProcess: true, supportsResume: true },
    startSession(runId, opts) {
      resumeStarts.push({ runId, opts });
      return { sessionRef: { pid: 9876 } };
    },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    disposeSession() { return true; },
    buildGuardrailsSection() { return ''; },
  };
  const resumeFactory = {
    getAdapter(type) {
      assert.equal(type, 'claude-code');
      return resumeAdapter;
    },
  };
  const resumeRegistry = createManagerRegistry({ runService });
  const resumeConversationService = createConversationService({
    runService,
    managerRegistry: resumeRegistry,
    managerAdapterFactory: resumeFactory,
    lifecycleService: null,
  });
  createManagerRouter({
    runService,
    managerAdapterFactory: resumeFactory,
    managerRegistry: resumeRegistry,
    conversationService: resumeConversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'manager-test-keychain-token',
      hasCredentialsFile: () => false,
    },
  });

  const resumed = resumeStarts.find((entry) => entry.runId === run.id);
  assert.ok(resumed);
  assert.equal(resumed.opts.resumeSessionId, 'sess-profile-options');
  assert.deepEqual(resumed.opts.tools, ['Read,Grep']);
  assert.deepEqual(resumed.opts.disallowedTools, ['Bash']);
  assert.equal(resumed.opts.maxBudgetUsd, 0.01);
  assert.equal(resumed.opts.mcpConfig, 'profile.json');
  assert.equal(resumed.opts.strictMcpConfig, true);
  assert.equal(resumed.opts.safeMode, true);
  assert.equal(resumed.opts.bare, true);
  assert.equal(resumed.opts.disableSlashCommands, true);
  assert.equal(resumed.opts.noChrome, true);
  assert.equal(resumed.opts.settingSources, '');
  assert.equal(resumed.opts.settings, 'locked.json');
});

test('Manager boot-resume stops a migration-marked session instead of using a mutable profile', async (t) => {
  const {
    agentProfileService,
    runService,
  } = await createCapturingManagerHarness(t);
  const staleRun = runService.createRun({
    is_manager: true,
    agent_profile_id: 'claude-code',
    prompt: 'pre-migration manager',
    manager_adapter: 'claude-code',
  });
  runService.updateRunStatus(staleRun.id, 'running', { force: true });
  runService.updateClaudeSessionId(staleRun.id, 'sess-pre-migration');
  runService.setSessionSnapshot(staleRun.id, {
    sessionPermissionMode: 'acceptEdits',
    sessionClaudeOptions: { legacyUnresumable: true },
  });
  agentProfileService.updateProfile('claude-code', {
    args_template: '-p {prompt}',
  });

  const resumeStarts = [];
  const resumeAdapter = {
    type: 'claude-code',
    capabilities: { persistentProcess: true, supportsResume: true },
    startSession(runId, opts) {
      resumeStarts.push({ runId, opts });
      return { sessionRef: { pid: 7654 } };
    },
    isSessionAlive() { return true; },
    detectExitCode() { return null; },
    disposeSession() { return true; },
    buildGuardrailsSection() { return ''; },
  };
  const resumeFactory = { getAdapter: () => resumeAdapter };
  const resumeRegistry = createManagerRegistry({ runService });
  const resumeConversationService = createConversationService({
    runService,
    managerRegistry: resumeRegistry,
    managerAdapterFactory: resumeFactory,
    lifecycleService: null,
  });
  createManagerRouter({
    runService,
    managerAdapterFactory: resumeFactory,
    managerRegistry: resumeRegistry,
    conversationService: resumeConversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'manager-test-keychain-token',
      hasCredentialsFile: () => false,
    },
  });

  assert.equal(
    resumeStarts.some((entry) => entry.runId === staleRun.id),
    false,
  );
  assert.equal(runService.getRun(staleRun.id).status, 'stopped');
});

test('Manager boot-resume uses the fresh-spawn permission snapshot after profile deletion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-manager-resume-permission-'));
  const argsFile = path.join(root, 'claude-resume-args.json');
  const previousClaudeBin = process.env.CLAUDE_BIN;
  const previousArgsFile = process.env.CLAUDE_ARGS_FILE;
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.CLAUDE_ARGS_FILE = argsFile;

  const database = createDatabase(path.join(root, 'test.db'));
  database.migrate();
  const runService = createRunService(database.db, null);
  const agentProfileService = createAgentProfileService(database.db);
  agentProfileService.updateProfile('claude-code', {
    args_template: '-p {prompt} --tools Read,Grep --disallowedTools Bash --max-budget-usd 0.01 --mcp-config locked.json --strict-mcp-config',
    permission_mode: 'acceptEdits',
    env_allowlist: JSON.stringify(['CLAUDE_ARGS_FILE']),
  });

  const staleRun = runService.createRun({
    is_manager: true,
    agent_profile_id: 'claude-code',
    prompt: 'resume stored session',
    manager_adapter: 'claude-code',
    manager_layer: 'top',
    conversation_id: 'top',
  });
  runService.updateRunStatus(staleRun.id, 'running', { force: true });
  runService.updateClaudeSessionId(staleRun.id, 'sess-review');
  runService.setSessionSnapshot(staleRun.id, {
    sessionPermissionMode: 'acceptEdits',
    sessionClaudeOptions: {
      tools: ['Read,Grep'],
      disallowedTools: ['Bash'],
      maxBudgetUsd: 0.01,
      mcpConfig: 'locked.json',
      strictMcpConfig: true,
      bare: true,
      disableSlashCommands: true,
      noChrome: true,
      settings: 'locked.json',
    },
  });

  agentProfileService.deleteProfile('claude-code');
  assert.equal(runService.getRun(staleRun.id).agent_profile_id, null);
  agentProfileService.createProfile({
    name: 'Fallback bypass Claude',
    type: 'claude-code',
    command: 'claude',
    args_template: '-p {prompt}',
    permission_mode: 'bypassPermissions',
    env_allowlist: JSON.stringify(['CLAUDE_ARGS_FILE']),
  });

  const streamJsonEngine = createStreamJsonEngine({ runService });
  const managerAdapterFactory = createManagerAdapterFactory({ streamJsonEngine, runService });
  const managerRegistry = createManagerRegistry({ runService });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    managerAdapterFactory,
    lifecycleService: null,
  });

  createManagerRouter({
    runService,
    streamJsonEngine,
    managerAdapterFactory,
    managerRegistry,
    conversationService,
    agentProfileService,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => 'manager-test-keychain-token',
      hasCredentialsFile: () => false,
    },
  });

  t.after(async () => {
    const activeRunId = managerRegistry.getActiveRunId('top');
    if (activeRunId) {
      try {
        await managerRegistry.getActiveAdapter('top')?.disposeSession(activeRunId);
      } catch { /* already stopped */ }
    }
    database.close();
    if (previousClaudeBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousClaudeBin;
    if (previousArgsFile === undefined) delete process.env.CLAUDE_ARGS_FILE;
    else process.env.CLAUDE_ARGS_FILE = previousArgsFile;
    await fs.rm(root, { recursive: true, force: true });
  });

  const args = await readArgs(argsFile);
  assert.equal(permissionModeArg(args), 'acceptEdits');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'Bash');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.01');
  assert.equal(args[args.indexOf('--mcp-config') + 1], 'locked.json');
  assert.equal(
    args.filter((arg) => arg === '--strict-mcp-config').length,
    1,
  );
  assert.equal(args.filter((arg) => arg === '--bare').length, 1);
  assert.equal(args.filter((arg) => arg === '--disable-slash-commands').length, 1);
  assert.equal(args.filter((arg) => arg === '--no-chrome').length, 1);
  assert.equal(args[args.indexOf('--settings') + 1], 'locked.json');
  const resumeIndex = args.indexOf('--resume');
  assert.notEqual(resumeIndex, -1, `missing --resume in ${JSON.stringify(args)}`);
  assert.equal(args[resumeIndex + 1], 'sess-review');
});
