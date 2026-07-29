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
  const resumeIndex = args.indexOf('--resume');
  assert.notEqual(resumeIndex, -1, `missing --resume in ${JSON.stringify(args)}`);
  assert.equal(args[resumeIndex + 1], 'sess-review');
});
