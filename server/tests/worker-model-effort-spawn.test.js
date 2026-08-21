'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createProjectService } = require('../services/projectService');
const { createRunService } = require('../services/runService');
const {
  createStreamJsonEngine: createProductionStreamJsonEngine,
} = require('../services/streamJsonEngine');
const { createTaskService } = require('../services/taskService');

async function createHarness(t, { bareToken = 'worker-keychain-access-token' } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-worker-model-effort-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => {
    close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const executionEngine = createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine();
  const agentProfileService = createAgentProfileService(db);
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    executionEngine,
    streamJsonEngine,
    worktreeService: null,
    eventBus: null,
    authResolverOpts: {
      hasKeychain: () => true,
      readKeychainTokenSync: () => bareToken,
      hasCredentialsFile: () => false,
    },
  });
  const project = projectService.createProject({
    name: 'Worker model/effort project',
    directory: null,
  });

  return {
    db,
    runService,
    taskService,
    executionEngine,
    streamJsonEngine,
    agentProfileService,
    lifecycleService,
    project,
  };
}

function createExecutionEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `worker-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function createStreamJsonEngine() {
  const spawned = [];
  const buildArgs = createProductionStreamJsonEngine()._buildArgs;
  return {
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts, args: buildArgs(opts) });
      return { sessionName: null };
    },
    hasProcess(runId) { return spawned.some((spawn) => spawn.runId === runId); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function insertProfile(db, {
  command,
  argsTemplate = 'exec --full-auto --skip-git-repo-check {prompt}',
  model = null,
  reasoningEffort = null,
  permissionMode = null,
  envAllowlist = [],
}) {
  const id = `${command}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent, model, reasoning_effort, permission_mode
    ) VALUES (?, ?, ?, ?, ?, '{}', ?, 5, ?, ?, ?)
  `).run(
    id,
    id,
    command,
    command,
    argsTemplate,
    JSON.stringify(envAllowlist),
    model,
    reasoningEffort,
    permissionMode,
  );
  return id;
}

async function executeWorker(harness, profileId, title) {
  const task = harness.taskService.createTask({
    project_id: harness.project.id,
    title,
    description: 'spawn worker',
  });
  return harness.lifecycleService.executeTask(task.id, {
    agentProfileId: profileId,
    prompt: 'hello',
  });
}

test('codex worker injects structured effort/model before forced tier and snapshots both', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'codex',
    model: 'gpt-x',
    reasoningEffort: 'high',
  });

  const run = await executeWorker(harness, profileId, 'Structured codex worker');

  assert.deepEqual(harness.executionEngine.spawned[0].opts.args, [
    '-c', 'model_reasoning_effort="high"',
    '-m', 'gpt-x',
    '-c', 'service_tier="default"',
    'exec', '--full-auto', '--skip-git-repo-check', '-',
  ]);
  assert.equal(harness.executionEngine.spawned[0].opts.stdin, 'hello');
  const persisted = harness.runService.getRun(run.id);
  assert.equal(persisted.session_model, 'gpt-x');
  assert.equal(persisted.session_effort, 'high');
});

test('codex worker keeps structured flag ordering when structured columns are NULL', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, { command: 'codex' });

  await executeWorker(harness, profileId, 'Default codex worker');

  assert.deepEqual(harness.executionEngine.spawned[0].opts.args, [
    '-c', 'service_tier="default"',
    'exec', '--full-auto', '--skip-git-repo-check', '-',
  ]);
  assert.equal(harness.executionEngine.spawned[0].opts.stdin, 'hello');
});

test('claude worker forwards structured model to the stream-json spec', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '{prompt}',
    model: 'claude-x',
  });

  await executeWorker(harness, profileId, 'Structured claude worker');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.model, 'claude-x');
  assert.equal(harness.executionEngine.spawned.length, 0);
});

test('legacy Claude raw permission flag remains effective when the structured column is NULL', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt} --permission-mode acceptEdits',
  });

  await executeWorker(harness, profileId, 'Legacy claude worker');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.permissionMode, 'acceptEdits');
  assert.equal(
    harness.runService.getRun(
      harness.streamJsonEngine.spawned[0].runId,
    ).session_permission_mode,
    'acceptEdits',
  );
});

test('claude worker forwards structured permission_mode to the stream-json spec', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt}',
    permissionMode: 'acceptEdits',
  });

  await executeWorker(harness, profileId, 'Structured claude permission mode');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.permissionMode, 'acceptEdits');
});

test('claude worker carries security template options into the stream-json spec', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt} --max-budget-usd 0.01 --mcp-config /tmp/intended.json --strict-mcp-config --safe-mode --bare --disable-slash-commands --no-chrome --setting-sources "" --settings locked.json --max-turns 5',
    envAllowlist: ['NO_AUTH_ENV'],
  });

  await executeWorker(harness, profileId, 'Claude template runtime options');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.maxBudgetUsd, 0.01);
  assert.equal(
    harness.streamJsonEngine.spawned[0].opts.mcpConfig,
    '/tmp/intended.json',
  );
  assert.equal(harness.streamJsonEngine.spawned[0].opts.strictMcpConfig, true);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.safeMode, true);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.bare, true);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.disableSlashCommands, true);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.noChrome, true);
  assert.equal(harness.streamJsonEngine.spawned[0].opts.settingSources, '');
  assert.equal(harness.streamJsonEngine.spawned[0].opts.settings, 'locked.json');
  assert.equal(harness.streamJsonEngine.spawned[0].opts.maxTurns, 5);
  assert.equal(
    harness.streamJsonEngine.spawned[0].opts.env.ANTHROPIC_API_KEY,
    'worker-keychain-access-token',
  );

  const { args } = harness.streamJsonEngine.spawned[0];
  assert.equal(args.filter((arg) => arg === '--no-chrome').length, 1);
  const settingsIndex = args.indexOf('--settings');
  assert.notEqual(settingsIndex, -1);
  assert.equal(args[settingsIndex + 1], 'locked.json');
  const maxTurnsIndex = args.indexOf('--max-turns');
  assert.notEqual(maxTurnsIndex, -1);
  assert.equal(args[maxTurnsIndex + 1], '5');
});

test('claude --bare worker fails before spawn when native auth cannot be materialized', async (t) => {
  const harness = await createHarness(t, { bareToken: null });
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt} --bare',
    envAllowlist: ['NO_AUTH_ENV'],
  });

  await assert.rejects(
    () => executeWorker(harness, profileId, 'Claude bare auth unavailable'),
    /--bare requires a materialized ANTHROPIC_API_KEY/,
  );
  assert.equal(harness.streamJsonEngine.spawned.length, 0);
});

test('claude --bare worker starts when explicit settings provides apiKeyHelper auth', async (t) => {
  const harness = await createHarness(t, { bareToken: null });
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt} --bare --settings /pod/settings.json',
    envAllowlist: ['NO_AUTH_ENV'],
  });

  await executeWorker(harness, profileId, 'Claude settings helper auth');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  const { opts, args } = harness.streamJsonEngine.spawned[0];
  assert.equal(opts.settings, '/pod/settings.json');
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(args[args.indexOf('--settings') + 1], '/pod/settings.json');
});

test('claude --bare worker starts with allowlisted Bedrock provider credentials', async (t) => {
  const providerEnv = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'worker-bedrock-access-key',
    AWS_SECRET_ACCESS_KEY: 'worker-bedrock-secret-key',
  };
  const previous = Object.fromEntries(
    Object.keys(providerEnv).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, providerEnv);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const harness = await createHarness(t, { bareToken: null });
  const profileId = insertProfile(harness.db, {
    command: 'claude',
    argsTemplate: '-p {prompt} --bare',
    envAllowlist: Object.keys(providerEnv),
  });

  await executeWorker(harness, profileId, 'Claude Bedrock bare auth');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  const { opts, args } = harness.streamJsonEngine.spawned[0];
  assert.equal(opts.bare, true);
  assert.equal(args.filter((arg) => arg === '--bare').length, 1);
  for (const [key, value] of Object.entries(providerEnv)) {
    assert.equal(opts.env[key], value, key);
  }
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
});

test('saved Claude disallowedTools template reaches the stream-json worker spec', async (t) => {
  const harness = await createHarness(t);
  const profile = harness.agentProfileService.createProfile({
    name: 'Restricted Claude',
    type: 'claude-code',
    command: 'claude',
    args_template: '-p {prompt} --disallowedTools Bash',
  });

  await executeWorker(harness, profile.id, 'Restricted Claude worker');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.deepEqual(
    harness.streamJsonEngine.spawned[0].opts.disallowedTools,
    ['Bash'],
  );
});

test('saved Claude tools template restricts the stream-json worker spec', async (t) => {
  const harness = await createHarness(t);
  const profile = harness.agentProfileService.createProfile({
    name: 'Read-only Claude',
    type: 'claude-code',
    command: 'claude',
    args_template: '-p {prompt} --tools Read,Grep',
  });

  await executeWorker(harness, profile.id, 'Read-only Claude worker');

  assert.equal(harness.streamJsonEngine.spawned.length, 1);
  assert.deepEqual(
    harness.streamJsonEngine.spawned[0].opts.tools,
    ['Read,Grep'],
  );
});

test('raw-SQL-contaminated structured profile fails before claim and never spawns', async (t) => {
  const harness = await createHarness(t);
  const profileId = insertProfile(harness.db, {
    command: 'codex',
    argsTemplate: `exec --full-auto --skip-git-repo-check -c 'model_reasoning_effort="high"' {prompt}`,
    reasoningEffort: 'high',
  });

  const run = await executeWorker(harness, profileId, 'Contaminated codex worker');
  const persisted = harness.runService.getRun(run.id);

  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.started_at, null);
  assert.equal(harness.executionEngine.spawned.length, 0);
  assert.ok(
    harness.runService.getRunEvents(run.id)
      .some((event) => event.event_type === 'worker:profile_invalid'),
  );
});
