const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createNodeService } = require('../services/nodeService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createPresetService } = require('../services/presetService');
const { createEventBus } = require('../services/eventBus');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fleet-dispatch-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    try { close(); } catch { /* ignore */ }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function stubExecEngine() {
  const spawned = [];
  const killed = [];
  const inputs = [];
  return {
    type: 'subprocess',
    spawned,
    killed,
    inputs,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `local-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    output: '',
    getOutput() { return this.output; },
    sendInput(runId, text) { inputs.push({ runId, text }); return true; },
    kill(runId) { killed.push(runId); return true; },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubStreamJsonEngine() {
  const spawned = [];
  const active = new Set();
  const inputs = [];
  const killed = [];
  return {
    spawned,
    inputs,
    killed,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      active.add(runId);
      return { sessionName: null };
    },
    hasProcess(runId) { return active.has(runId); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput(runId, text) { inputs.push({ runId, text }); return true; },
    kill(runId) { killed.push(runId); active.delete(runId); return true; },
    buildDetachedWorkerSpec(spec, { workerPath } = {}) {
      return {
        command: 'claude',
        args: [
          '--print',
          '--output-format',
          'stream-json',
          '-p',
          ...(spec.bare ? ['--bare'] : []),
        ],
        stdin: spec.prompt || '',
        systemPrompt: spec.systemPrompt,
        systemPromptFileFlag: spec.systemPrompt ? '--append-system-prompt-file' : undefined,
        cwd: spec.cwd,
        env: Object.fromEntries(
          Object.entries(spec.env || {}).filter(([key]) => (
            key === 'PALANTIR_API_BASE' || key === 'PALANTIR_WORKER_TOKEN'
          )),
        ),
        envAllowlist: spec.envAllowlist || [],
        claudeBareAuth: spec.bare === true && !spec.isolated,
        workerPath,
      };
    },
  };
}

function makeRemoteChannel({
  alive = true,
  exitCode = null,
  output = '',
  structuredResult = '',
} = {}) {
  const channel = {
    spawned: [],
    killed: [],
    ownerCalls: [],
    isAliveCalls: [],
    detectExitCodeCalls: [],
    getOutputCalls: [],
    getStructuredResultCalls: [],
    async spawnWorker(runId, payload) {
      channel.spawned.push({ runId, payload });
      return { sessionName: `remote-${runId}` };
    },
    async ownerOf(runId) {
      channel.ownerCalls.push({ runId });
      return 'cli';
    },
    async isAlive(runId, engine) {
      channel.isAliveCalls.push({ runId, engine });
      return alive;
    },
    async detectExitCode(runId, engine) {
      channel.detectExitCodeCalls.push({ runId, engine });
      return exitCode;
    },
    async getOutput(runId, lines, engine) {
      channel.getOutputCalls.push({ runId, lines, engine });
      return output;
    },
    async getStructuredResult(runId) {
      channel.getStructuredResultCalls.push({ runId });
      return structuredResult;
    },
    async sendInput() {
      return false;
    },
    async kill(runId, engine) {
      channel.killed.push({ runId, engine });
      return true;
    },
    async cleanupRun() {},
  };
  return channel;
}

function buildHarness(db, {
  remoteChannel = makeRemoteChannel(),
  worktreeService = null,
  skillPackService = null,
  presetService = null,
  eventBus = null,
  lifecycleOptions = {},
} = {}) {
  const remoteFactoryCalls = [];
  const nodeService = createNodeService(db, {
    createRemoteExecutor(node) {
      remoteFactoryCalls.push(node);
      return remoteChannel;
    },
  });
  const pickedNodeIds = [];
  const basePickExecutor = nodeService.pickExecutor.bind(nodeService);
  nodeService.pickExecutor = (nodeId) => {
    pickedNodeIds.push(nodeId);
    return basePickExecutor(nodeId);
  };

  const runService = createRunService(db, eventBus);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const executionEngine = stubExecEngine();
  const streamJsonEngine = stubStreamJsonEngine();
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    agentProfileService,
    projectService,
    nodeService,
    executionEngine,
    streamJsonEngine,
    worktreeService,
    harvestService: null,
    eventBus,
    presetService,
    skillPackService,
    ...lifecycleOptions,
  });

  return {
    nodeService,
    runService,
    taskService,
    projectService,
    agentProfileService,
    executionEngine,
    streamJsonEngine,
    lifecycleService,
    remoteChannel,
    remoteFactoryCalls,
    pickedNodeIds,
  };
}

function seedProfile(db, {
  command = 'codex',
  max = 5,
  envAllowlist = [],
  argsTemplate: argsTemplateOverride,
} = {}) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const argsTemplate = argsTemplateOverride || (
    path.basename(command).toLowerCase().includes('codex')
      ? 'exec {prompt}'
      : '{prompt}'
  );
  db.prepare(`
    INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
    VALUES (?, 'FleetDispatchAgent', 'codex', ?, ?, '{}', ?, ?)
  `).run(id, command, argsTemplate, JSON.stringify(envAllowlist), max);
  return { id, command, max_concurrent: max };
}

function seedTask(taskService, projectId) {
  return taskService.createTask({
    project_id: projectId,
    title: `T-${Math.random().toString(36).slice(2)}`,
    description: 'fleet dispatch test',
    status: 'in_progress',
  });
}

function createSshNode(nodeService, fields = {}) {
  return nodeService.createNode({
    id: 'ssh-pod',
    name: 'SSH Pod',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
    node_prefix: '/opt/codex/bin',
    ...fields,
  });
}

test('reachable executable ssh node dispatches through pickExecutor and remote workerPath', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  const h = buildHarness(db, {
    remoteChannel,
    worktreeService: {
      classifyProjectDir() { throw new Error('remote spawn must not classify local worktrees'); },
      createWorktree() { throw new Error('remote spawn must not create local worktrees'); },
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { envAllowlist: ['POD_ONLY_PROVIDER_KEY'] });
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely',
  });

  assert.equal(run.status, 'running');
  assert.equal(h.pickedNodeIds.length, 1);
  assert.equal(h.pickedNodeIds[0], 'ssh-pod');
  assert.equal(h.remoteFactoryCalls.length, 1);
  assert.equal(remoteChannel.spawned.length, 1);
  assert.equal(h.executionEngine.spawned.length, 0, 'local executionEngine was not used');
  const spawn = remoteChannel.spawned[0];
  assert.equal(spawn.runId, run.id);
  assert.equal(spawn.payload.engine, 'cli');
  assert.equal(spawn.payload.spec.command, 'codex');
  // F-1: codex workers are pinned to the standard service tier (leaf `-c`
  // override, before the args_template) so a batch run never inherits the
  // user's ~/.codex/config.toml service_tier="fast".
  assert.deepEqual(spawn.payload.spec.args, ['-c', 'service_tier="default"', 'exec', '-']);
  assert.equal(spawn.payload.spec.stdin, 'run remotely');
  assert.equal(spawn.payload.spec.cwd, '/workspace/project');
  assert.equal(run.worktree_path, null, 'remote worker runs do not receive a worktree');
  assert.equal(run.branch, null, 'remote worker runs do not receive a worktree branch');
  assert.equal(spawn.payload.spec.workerPath, '/opt/codex/bin');
  assert.deepEqual(spawn.payload.spec.envAllowlist, ['POD_ONLY_PROVIDER_KEY']);
  assert.equal(h.runService.getRun(run.id).tmux_session, `remote-${run.id}`);

  const { createCodexAdapter } = require('../services/managerAdapters/codexAdapter');
  const guardrails = createCodexAdapter({ runService: null })
    .buildGuardrailsSection({ layer: 'operator' });
  assert.match(
    guardrails,
    /A remote legacy-directory project is the exception:[\s\S]*configured remote directory without a run worktree,[\s\S]*diff capture and test harvest are unavailable for that path/i,
    'the manager prompt must describe the remote legacy-directory no-worktree path exercised above',
  );
});

test('remote worker gets no loopback memory capability without a public Console base URL', async (t) => {
  const db = await mkdb(t);
  const minted = [];
  const h = buildHarness(db, {
    lifecycleOptions: {
      workerProposalTokenService: {
        mint(runId, claims) {
          minted.push({ runId, claims });
          return 'scoped-token';
        },
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: null,
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteNoPublicBase',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely',
  });

  const spec = h.remoteChannel.spawned[0].payload.spec;
  assert.deepEqual(minted, []);
  assert.equal('PALANTIR_WORKER_TOKEN' in spec.env, false);
  assert.equal('PALANTIR_API_BASE' in spec.env, false);
  assert.doesNotMatch(spec.args.join(' '), /memory\/propose/);
});

test('remote worker gets no API base when proposal token mint returns null', async (t) => {
  const db = await mkdb(t);
  const minted = [];
  const caseVariantApiBase = 'http://case-user:case-password@console.internal:4177';
  const previousCaseVariantApiBase = process.env.palantir_api_base;
  process.env.palantir_api_base = caseVariantApiBase;
  t.after(() => {
    if (previousCaseVariantApiBase === undefined) delete process.env.palantir_api_base;
    else process.env.palantir_api_base = previousCaseVariantApiBase;
  });
  const h = buildHarness(db, {
    lifecycleOptions: {
      workerProposalTokenService: {
        mint(runId, claims) {
          minted.push({ runId, claims });
          return null;
        },
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: 'https://console.tailnet.example/proxy-prefix',
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { envAllowlist: ['palantir_api_base'] });
  const project = h.projectService.createProject({
    name: 'RemoteMintDisabled',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely without a minted capability',
  });

  assert.equal(minted.length, 1);
  const spec = h.remoteChannel.spawned[0].payload.spec;
  assert.equal('PALANTIR_WORKER_TOKEN' in spec.env, false);
  assert.equal('PALANTIR_API_BASE' in spec.env, false);
  assert.equal('palantir_api_base' in spec.env, false);
  assert.deepEqual(spec.envAllowlist, []);
  assert.equal(JSON.stringify(spec).includes(caseVariantApiBase), false);
  assert.doesNotMatch(spec.stdin, /memory\/propose/);
});

test('remote worker receives memory capability with an explicitly reachable Console base URL', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db, {
    lifecycleOptions: {
      actorTokens: {
        humanToken: 'human-secret',
        agentToken: 'automation-secret',
        separated: true,
        processIsolated: true,
        capabilitiesEnabled: true,
        boundary: 'run_capabilities',
      },
      workerProposalTokenService: {
        mint: () => 'remote-scoped-token',
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: 'https://console.tailnet.example',
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemotePublicBase',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely',
  });

  const spec = h.remoteChannel.spawned[0].payload.spec;
  assert.equal(spec.env.PALANTIR_WORKER_TOKEN, 'remote-scoped-token');
  assert.equal(spec.env.PALANTIR_API_BASE, 'https://console.tailnet.example');
  assert.doesNotMatch(spec.args.join(' '), /memory\/propose/);
  assert.match(spec.stdin, new RegExp(`/api/runs/${run.id}/memory/propose`));
});

test('restart revokes a remote worker whose boot-local memory capability expired', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false });
  const h = buildHarness(db, {
    remoteChannel,
    lifecycleOptions: {
      actorTokens: {
        humanToken: 'human-secret',
        agentToken: 'automation-secret',
        separated: true,
        processIsolated: true,
        capabilitiesEnabled: true,
        boundary: 'run_capabilities',
      },
      workerProposalTokenService: {
        mint: () => 'remote-boot-local-token',
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: 'https://console.tailnet.example',
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteRestartCapability',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run remotely across a Console restart',
  });

  const recovered = await h.lifecycleService.recoverOrphanSessions();

  assert.deepEqual(recovered, [{ runId: run.id, status: 'credential_revoked' }]);
  assert.deepEqual(remoteChannel.killed, [{ runId: run.id, engine: 'cli' }]);
  assert.equal(h.runService.getRun(run.id).status, 'stopped');
  const revoked = h.runService.getRunEvents(run.id)
    .find((event) => event.event_type === 'security:credential_revoked');
  assert.equal(JSON.parse(revoked.payload_json).reason, 'worker_capability_restart');
});

test('restart preserves a completed remote worker result before capability revocation', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 0, output: 'done' });
  const h = buildHarness(db, {
    remoteChannel,
    lifecycleOptions: {
      actorTokens: {
        humanToken: 'human-secret',
        agentToken: 'automation-secret',
        separated: true,
        processIsolated: true,
        capabilitiesEnabled: true,
        boundary: 'run_capabilities',
      },
      workerProposalTokenService: {
        mint: () => 'remote-boot-local-token',
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: 'https://console.tailnet.example',
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteRestartCompleted',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'finish while Console is offline',
  });

  const recovered = await h.lifecycleService.recoverOrphanSessions();

  assert.deepEqual(recovered, [{ runId: run.id, status: 'terminated' }]);
  assert.deepEqual(remoteChannel.killed, [{ runId: run.id, engine: 'cli' }]);
  assert.equal(h.runService.getRun(run.id).status, 'completed');
  assert.equal(h.runService.getRun(run.id).exit_code, 0);
  assert.equal(h.taskService.getTask(task.id).status, 'review');
});

test('restart recovery emits the dedicated needs_input alert for a detached Claude limit', async (t) => {
  const db = await mkdb(t);
  const structuredResult = JSON.stringify({
    type: 'result',
    is_error: false,
    stop_reason: 'max_tokens',
    result: 'partial recovery result',
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  const remoteChannel = makeRemoteChannel({
    alive: false,
    exitCode: 0,
    structuredResult,
  });
  const eventBus = createEventBus();
  const alerts = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'run:needs_input') alerts.push(event.data);
  });
  const h = buildHarness(db, {
    remoteChannel,
    eventBus,
    lifecycleOptions: {
      actorTokens: {
        humanToken: 'human-secret',
        agentToken: 'automation-secret',
        separated: true,
        processIsolated: true,
        capabilitiesEnabled: true,
        boundary: 'run_capabilities',
      },
      workerProposalTokenService: {
        mint: () => 'remote-boot-local-token',
      },
      workerProposalBaseUrl: 'http://127.0.0.1:4177',
      workerProposalRemoteBaseUrl: 'https://console.tailnet.example',
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteRestartNeedsInput',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'hit a limit while Console is offline',
  });

  const recovered = await h.lifecycleService.recoverOrphanSessions();

  assert.deepEqual(recovered, [{ runId: run.id, status: 'terminated' }]);
  assert.equal(h.runService.getRun(run.id).status, 'needs_input');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].runId, run.id);
  assert.equal(alerts[0].from_status, 'running');
  assert.equal(alerts[0].to_status, 'needs_input');
  assert.equal(alerts[0].reason, 'max_tokens');
  assert.equal(alerts[0].priority, 'alert');
});

test('issue #113: remote Codex MCP secret placement and cleanup stay on selected executor', async (t) => {
  const db = await mkdb(t);
  const secret = 'remote-worker-secret-sentinel-🔐';
  const putCalls = [];
  const rmrfCalls = [];
  const remoteChannel = makeRemoteChannel();
  remoteChannel.putSecretFile = async (name, content, mode) => {
    const dir = `/workspace/.palantir-secret-${putCalls.length + 1}`;
    putCalls.push({ name, content, mode, dir });
    return `${dir}/${name}`;
  };
  remoteChannel.resolveNodeRuntime = async () => '/usr/bin/node';
  remoteChannel.rmrf = async (dir) => { rmrfCalls.push(dir); };
  remoteChannel.spawnWorker = async (runId, payload) => {
    remoteChannel.spawned.push({ runId, payload });
    throw new Error('intentional remote spawn failure');
  };
  const skillPackService = {
    resolveForRun() {
      return {
        warnings: [],
        appliedPacks: [],
        promptSections: [],
        checklist: [],
        mcpConfig: {
          mcpServers: {
            remoteSecret: {
              command: 'npx', args: ['-y', '@scope/remote-mcp'], env: { TOKEN: secret },
            },
          },
        },
      };
    },
  };
  const h = buildHarness(db, { remoteChannel, skillPackService });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteSecretProject', directory: '/workspace/project', node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  await assert.rejects(
    () => h.lifecycleService.executeTask(task.id, {
      agentProfileId: profile.id,
      prompt: 'run remote secret test',
    }),
    /intentional remote spawn failure/,
  );

  assert.equal(putCalls.length, 1, 'wrapper placed through selected remote executor');
  assert.equal(putCalls[0].mode, 0o600);
  assert.ok(putCalls[0].content.includes(secret));
  assert.equal(remoteChannel.spawned.length, 1);
  const args = remoteChannel.spawned[0].payload.spec.args;
  assert.equal(JSON.stringify(args).includes(secret), false, 'remote worker argv has zero secret values');
  assert.ok(args.includes('mcp_servers.remoteSecret.env.NODE_OPTIONS=""'));
  assert.deepEqual(rmrfCalls, [putCalls[0].dir], 'failure cleanup uses the same remote executor');
  assert.equal(h.executionEngine.spawned.length, 0);

  const failedRun = h.runService.listRuns({})[0];
  if (failedRun.mcp_config_path) {
    try { await fs.rm(failedRun.mcp_config_path, { force: true }); } catch { /* ignore */ }
  }
});

test('unreachable ssh node remains queued until heartbeat reachability', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService, { reachable: false });
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'wait for heartbeat',
  });

  assert.equal(run.status, 'queued');
  assert.equal(h.pickedNodeIds.length, 0);
  assert.equal(remoteChannel.spawned.length, 0);
});

test('local runs keep using the injected global worker channel', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({ name: 'LocalProject' });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run locally',
  });

  assert.equal(run.status, 'running');
  assert.equal(h.pickedNodeIds.length, 0, 'local dispatch bypasses nodeService.pickExecutor');
  assert.equal(h.executionEngine.spawned.length, 1);
  assert.equal(h.remoteChannel.spawned.length, 0);
  assert.equal(h.executionEngine.spawned[0].opts.workerPath, undefined);
});

test('remote claude worker uses detached SSH ownership with pod-native auth', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel();
  let controllerAuthCalls = 0;
  const h = buildHarness(db, {
    remoteChannel,
    lifecycleOptions: {
      authResolver: {
        resolveClaudeAuth() {
          controllerAuthCalls += 1;
          throw new Error('remote --bare worker must not resolve controller auth');
        },
      },
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, {
    command: 'claude',
    envAllowlist: ['POD_ONLY_PROVIDER_KEY'],
    argsTemplate: '{prompt} --bare',
  });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'claude remotely',
  });

  assert.equal(run.status, 'running');
  assert.equal(remoteChannel.spawned.length, 1);
  assert.equal(h.streamJsonEngine.spawned.length, 0);
  assert.equal(h.executionEngine.spawned.length, 0);
  const spawn = remoteChannel.spawned[0];
  assert.equal(spawn.runId, run.id);
  assert.equal(spawn.payload.engine, 'stream-json');
  assert.equal(spawn.payload.spec.stdin, 'claude remotely');
  assert.equal(spawn.payload.spec.cwd, '/workspace/project');
  assert.equal(spawn.payload.spec.workerPath, '/opt/codex/bin');
  assert.deepEqual(spawn.payload.spec.envAllowlist, ['POD_ONLY_PROVIDER_KEY']);
  assert.equal(spawn.payload.spec.claudeBareAuth, true);
  assert.ok(spawn.payload.spec.args.includes('--bare'));
  assert.equal(controllerAuthCalls, 0);
  assert.equal(
    spawn.payload.spec.args.includes('claude remotely'),
    false,
    'worker prompt must not enter remote argv',
  );
  const events = h.runService.getRunEvents(run.id);
  assert.equal(events.some(e => e.event_type === 'spawn:remote_claude_unsupported'), false);
  const engineEvent = events.find(e => e.event_type === 'runtime:remote_worker_engine');
  assert.deepEqual(JSON.parse(engineEvent.payload_json), {
    engine: 'claude-stream-json',
    version: 1,
  });

  assert.equal(await h.lifecycleService.sendAgentInput(run.id, 'continue remotely'), false);
});

test('remote Claude start acknowledgement loss keeps one running owner and never retries', async (t) => {
  const db = await mkdb(t);
  const eventBus = createEventBus();
  const nodeStatusEvents = [];
  eventBus.subscribe((event) => {
    if (event.channel === 'node:status') nodeStatusEvents.push(event.data);
  });
  const remoteChannel = makeRemoteChannel();
  remoteChannel.spawnWorker = async (runId, payload) => {
    remoteChannel.spawned.push({ runId, payload });
    const err = new Error('ssh acknowledgement lost');
    err.code = 'REMOTE_SPAWN_UNCERTAIN';
    err.transportCode = 'SSH_TRANSPORT';
    err.sessionName = `palantir-run-${runId}`;
    throw err;
  };
  const h = buildHarness(db, { remoteChannel, eventBus });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeUncertain',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'start once',
  });

  assert.equal(run.status, 'running');
  assert.equal(run.tmux_session, `palantir-run-${run.id}`);
  assert.equal(h.runService.listRuns({}).length, 1, 'no retry run may be created');
  assert.equal(h.nodeService.getNode('ssh-pod').reachable, 0);
  assert.equal(nodeStatusEvents.length, 1);
  assert.deepEqual(nodeStatusEvents[0], {
    node_id: 'ssh-pod',
    from_reachable: 1,
    to_reachable: 0,
    at: nodeStatusEvents[0].at,
  });
  assert.ok(Number.isFinite(Date.parse(nodeStatusEvents[0].at)));
  const events = h.runService.getRunEvents(run.id);
  assert.ok(events.some((event) => event.event_type === 'spawn:remote_ownership_uncertain'));
  assert.equal(events.some((event) => event.event_type === 'error'), false);
});

test('a node whose kind is local is not treated as remote just because its id is not "local"', async (t) => {
  const db = await mkdb(t);
  const h = buildHarness(db, { eventBus: createEventBus() });
  // nodeService supports registering a local node under any id and routes it to
  // the local executor. `node_id !== 'local'` is therefore not a remote test —
  // using it would push a purely local Claude run down the remote branches.
  h.nodeService.createNode({
    id: 'local-alias',
    name: 'Local Alias',
    kind: 'local',
    exposed_roots: ['/workspace'],
    can_execute: true,
    reachable: true,
  });
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'LocalAlias',
    directory: '/workspace/project',
    node_id: 'local-alias',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'run here',
  });

  assert.equal(h.remoteChannel.spawned.length, 0, 'a local-kind node must not use the remote channel');
  assert.equal(
    h.runService.getRunEvents(run.id)
      .some((event) => event.event_type === 'runtime:remote_worker_engine'),
    false,
    'no remote engine marker may be written for a local-kind node',
  );
});

test('an unresolved uncertain spawn survives the health check that would otherwise terminalize it', async (t) => {
  const db = await mkdb(t);
  // The pod reports exactly what an ownership-uncertain start looks like from
  // the controller: no tmux session and no exit sentinel. That is the SAME
  // observation a genuinely dead worker produces, so the health check must
  // decide on the durable uncertainty marker rather than on this absence.
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: null });
  remoteChannel.spawnWorker = async (runId, payload) => {
    remoteChannel.spawned.push({ runId, payload });
    const err = new Error('ssh acknowledgement lost');
    err.code = 'REMOTE_SPAWN_UNCERTAIN';
    err.transportCode = 'SSH_TRANSPORT';
    err.sessionName = `palantir-run-${runId}`;
    throw err;
  };
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeUncertainHealth',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'start once',
  });
  assert.equal(run.status, 'running');

  await h.lifecycleService.checkHealth();
  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'running', 'absence is not evidence: the pane may still be starting');
  assert.equal(after.exit_code, null);
  assert.equal(h.runService.listRuns({}).length, 1, 'no retry run may be created');
  assert.equal(remoteChannel.killed.length, 0, 'a possibly-live remote owner must not be killed');
  assert.equal(
    h.runService.getRunEvents(run.id).some((event) => event.event_type === 'error'),
    false,
  );
});

test('an uncertain spawn without durable dead evidence terminalizes after the grace TTL but keeps its lease held', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: null });
  remoteChannel.spawnWorker = async (runId, payload) => {
    remoteChannel.spawned.push({ runId, payload });
    const err = new Error('ssh acknowledgement lost');
    err.code = 'REMOTE_SPAWN_UNCERTAIN';
    err.transportCode = 'SSH_TRANSPORT';
    err.sessionName = `palantir-run-${runId}`;
    throw err;
  };
  // §8.2 C8 + grace TTL: session absence without an exit sentinel is unknown,
  // held for ONE grace window; after it the legacy terminal rules apply so the
  // slot is not held forever — but the LEASE stays held (owner unconfirmed),
  // so requeue keeps 409ing.
  let clock = Date.now();
  const h = buildHarness(db, { remoteChannel, lifecycleOptions: { now: () => clock } });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeUncertainTtl',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'start once',
  });

  await h.lifecycleService.checkHealth();
  assert.equal(h.runService.getRun(run.id).status, 'running', 'still inside the window');

  clock += 11 * 60 * 1000;
  // First post-TTL check starts the unknown grace clock (annotation), second
  // check after the grace window terminalizes.
  await h.lifecycleService.checkHealth();
  clock += 11 * 60 * 1000;
  await h.lifecycleService.checkHealth();
  assert.notEqual(
    h.runService.getRun(run.id).status,
    'running',
    'a pane that never appeared must stop suppressing terminalize after the grace TTL',
  );
  assert.equal(
    h.runService.getHeldLease(run.id).state,
    'held',
    'the owner was never confirmed dead — the lease must survive terminalization',
  );
});

test('a confirmed remote owner that later vanishes without a sentinel terminalizes after the grace TTL', async (t) => {
  const db = await mkdb(t);
  let alive = false;
  const remoteChannel = makeRemoteChannel();
  remoteChannel.isAlive = async (runId, engine) => {
    remoteChannel.isAliveCalls.push({ runId, engine });
    return alive;
  };
  remoteChannel.detectExitCode = async () => null;
  remoteChannel.spawnWorker = async (runId, payload) => {
    remoteChannel.spawned.push({ runId, payload });
    const err = new Error('ssh acknowledgement lost');
    err.code = 'REMOTE_SPAWN_UNCERTAIN';
    err.transportCode = 'SSH_TRANSPORT';
    err.sessionName = `palantir-run-${runId}`;
    throw err;
  };
  let clock = Date.now();
  const h = buildHarness(db, { remoteChannel, lifecycleOptions: { now: () => clock } });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeUncertainResolve',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'start once',
  });

  // The pane turns up late — exactly the case the absence probes could not see.
  alive = true;
  await h.lifecycleService.checkHealth();

  const eventTypes = h.runService.getRunEvents(run.id).map((event) => event.event_type);
  assert.ok(
    eventTypes.includes('spawn:remote_ownership_confirmed'),
    'observing the owner must resolve the uncertainty rather than leave it latched forever',
  );
  assert.equal(h.runService.getRun(run.id).status, 'running');

  // A prior alive observation does not turn later absence into durable death —
  // the run holds through the grace window, then terminalizes with the lease
  // still held (owner unconfirmed).
  alive = false;
  await h.lifecycleService.checkHealth();
  assert.equal(h.runService.getRun(run.id).status, 'running', 'within the grace window');
  clock += 11 * 60 * 1000;
  await h.lifecycleService.checkHealth();
  assert.notEqual(h.runService.getRun(run.id).status, 'running', 'after the grace window');
  assert.equal(h.runService.getHeldLease(run.id).state, 'held');
});

test('remote claude preset version gate probes the selected SSH node', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fleet-plugins-'));
  t.after(() => fs.rm(pluginsRoot, { recursive: true, force: true }));
  const presetService = createPresetService(db, { pluginsRoot });
  const versionCalls = [];
  const remoteChannel = makeRemoteChannel();
  remoteChannel.readClaudeVersion = async (options) => {
    versionCalls.push(options);
    return '1.0.0';
  };
  const h = buildHarness(db, { remoteChannel, presetService });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeVersionProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const preset = presetService.createPreset({
    name: 'RemoteVersionGate',
    min_claude_version: '2.0.0',
  });

  await assert.rejects(
    () => h.lifecycleService.executeTask(task.id, {
      agentProfileId: profile.id,
      prompt: 'check remote version',
      presetId: preset.id,
    }),
    /requires Claude CLI >= 2.0.0, found 1.0.0/,
  );

  assert.deepEqual(versionCalls, [{ pathPrefix: '/opt/codex/bin' }]);
  assert.equal(h.streamJsonEngine.spawned.length, 0);
  const run = h.runService.listRuns({})[0];
  assert.equal(run.status, 'failed');
  assert.ok(
    h.runService.getRunEvents(run.id)
      .some(event => event.event_type === 'preset:version_mismatch'),
  );
});

test('remote claude rejects control-plane MCP paths nonretryably', async (t) => {
  const db = await mkdb(t);
  const runtimeMcpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fleet-mcp-'));
  t.after(() => fs.rm(runtimeMcpDir, { recursive: true, force: true }));
  const skillPackService = {
    resolveForRun() {
      return {
        warnings: [],
        appliedPacks: [],
        promptSections: [],
        checklist: [],
        mcpConfig: {
          mcpServers: {
            localOnly: { command: 'node', args: ['server.js'] },
          },
        },
      };
    },
  };
  const h = buildHarness(db, {
    skillPackService,
    lifecycleOptions: { runtimeMcpDir },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeMcpProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);

  const result = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'must not receive controller path',
  });

  assert.equal(result.status, 'failed');
  assert.equal(h.streamJsonEngine.spawned.length, 0);
  const run = h.runService.listRuns({})[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.retry_count, 1);
  assert.equal(run.non_retryable, 1);
  assert.ok(
    h.runService.getRunEvents(run.id)
      .some(event => event.event_type === 'spawn:remote_claude_assets_unsupported'),
  );
  assert.deepEqual(await fs.readdir(runtimeMcpDir), [], 'controller MCP file cleaned');
});

test('remote claude rejects isolated preset assets before resolving controller auth', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fleet-plugins-'));
  t.after(() => fs.rm(pluginsRoot, { recursive: true, force: true }));
  const presetService = createPresetService(db, { pluginsRoot });
  let authCalls = 0;
  const h = buildHarness(db, {
    presetService,
    lifecycleOptions: {
      authResolver: {
        async resolveClaudeAuthForIsolated() {
          authCalls += 1;
          throw new Error('controller auth must not be used for remote worker');
        },
      },
    },
  });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeIsolatedProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const preset = presetService.createPreset({
    name: 'RemoteIsolated',
    isolated: true,
  });

  const result = await h.lifecycleService.executeTask(task.id, {
    agentProfileId: profile.id,
    prompt: 'must not receive controller plugin paths',
    presetId: preset.id,
  });

  assert.equal(result.status, 'failed');
  assert.equal(authCalls, 0);
  assert.equal(h.streamJsonEngine.spawned.length, 0);
  const run = h.runService.listRuns({})[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.retry_count, 1);
  assert.equal(run.non_retryable, 1);
  const event = h.runService.getRunEvents(run.id)
    .find(item => item.event_type === 'spawn:remote_claude_assets_unsupported');
  assert.ok(event);
  assert.equal(JSON.parse(event.payload_json).isolated_preset, true);
});

test('async remote health completes a run when detectExitCode resolves zero', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 0, output: 'done' });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `remote-${run.id}` });

  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.exit_code, 0);
  assert.equal(remoteChannel.killed.length, 1);
});

test('a legacy run without a lease keeps the immediate terminal behavior', async (t) => {
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: null, output: '' });
  let clock = Date.now();
  const h = buildHarness(db, { remoteChannel, lifecycleOptions: { now: () => clock } });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'RemoteProject',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `remote-${run.id}` });

  // This run was created WITHOUT a claim, so it has no owner lease — the
  // pre-S1a world. The unknown grace protects leases; a lease-less legacy run
  // keeps the original immediate-terminal behavior, unchanged.
  assert.equal(h.runService.getHeldLease(run.id), null, 'precondition: no lease');
  await h.lifecycleService.checkHealth();
  assert.equal(h.runService.getRun(run.id).status, 'failed', 'legacy behavior preserved');
});

test('detached remote Claude health restores structured result, usage, and events', async (t) => {
  const db = await mkdb(t);
  const resultText = [
    'done',
    '```palantir-goal-report',
    '{"goal_status":"achieved","summary":"complete","blockers":[]}',
    '```',
  ].join('\n');
  const output = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: resultText },
          { type: 'tool_use', name: 'Bash', id: 'tool-1' },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      stop_reason: 'end_turn',
      result: resultText,
      usage: { input_tokens: 7, output_tokens: 8 },
      total_cost_usd: 0.5,
      num_turns: 2,
    }),
  ].join('\n');
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 0, output });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeStructuredResult',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });

  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.result_summary, resultText);
  assert.equal(after.input_tokens, 7);
  assert.equal(after.output_tokens, 8);
  assert.equal(after.cost_usd, 0.5);
  const events = h.runService.getRunEvents(run.id);
  assert.ok(events.some((event) => event.event_type === 'assistant_text'));
  assert.ok(events.some((event) => event.event_type === 'tool_use'));
  assert.ok(events.some((event) => event.event_type === 'result'));
  const finalOutput = events.find((event) => event.event_type === 'final_output');
  assert.match(JSON.parse(finalOutput.payload_json).output, /palantir-goal-report/);
});

test('detached remote Claude rejected limit is non-retryable before terminal emission', async (t) => {
  const db = await mkdb(t);
  const output = [
    JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rateLimitType: 'five_hour',
        resetsAt: 1785312000000,
      },
    }),
    JSON.stringify({
      type: 'result',
      is_error: true,
      stop_reason: null,
      result: 'request rejected',
      usage: { input_tokens: 1, output_tokens: 0 },
    }),
  ].join('\n');
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 1, output });
  const eventBus = createEventBus();
  const h = buildHarness(db, { remoteChannel, eventBus });
  t.after(() => h.lifecycleService.stopMonitoring());
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeRejectedLimit',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.addRunEvent(run.id, 'runtime:remote_worker_engine', JSON.stringify({
    engine: 'claude-stream-json',
    version: 1,
  }));
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });

  h.lifecycleService.startMonitoring();
  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.non_retryable, 1);
  assert.equal(after.retry_count, 0);
  assert.equal(h.runService.listRuns({ task_id: task.id }).length, 1);
  assert.equal(
    h.runService.getRunEvents(run.id)
      .filter((event) => event.event_type === 'worker:limit_rejected').length,
    1,
  );
});

test('detached remote Claude heartbeat never persists raw tool input', async (t) => {
  const db = await mkdb(t);
  const secret = 'tool-input-secret-must-not-enter-events';
  const output = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working safely' },
        { type: 'tool_use', name: 'Bash', input: { command: secret } },
      ],
    },
  });
  const remoteChannel = makeRemoteChannel({ alive: true, exitCode: null, output });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeHeartbeat',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.addRunEvent(run.id, 'runtime:remote_worker_engine', JSON.stringify({
    engine: 'claude-stream-json',
    version: 1,
  }));
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });

  await h.lifecycleService.checkHealth();

  const heartbeat = h.runService.getRunEvents(run.id)
    .find((event) => event.event_type === 'heartbeat');
  assert.ok(heartbeat);
  assert.deepEqual(JSON.parse(heartbeat.payload_json), { output: 'working safely' });
  assert.equal(heartbeat.payload_json.includes(secret), false);
});

test('detached remote Claude tool-only termination never persists raw NDJSON', async (t) => {
  const db = await mkdb(t);
  const secret = 'terminal-tool-secret-must-not-enter-events';
  const output = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          id: 'tool-terminal',
          input: { command: secret },
        },
      ],
    },
  });
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 0, output });
  const eventBus = createEventBus();
  const h = buildHarness(db, { remoteChannel, eventBus });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeToolOnly',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.setGoalActive(run.id, true);
  h.runService.addRunEvent(run.id, 'runtime:remote_worker_engine', JSON.stringify({
    engine: 'claude-stream-json',
    version: 1,
  }));
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
  h.lifecycleService.startMonitoring();
  t.after(() => h.lifecycleService.stopMonitoring());

  await h.lifecycleService.checkHealth();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.final_output, null);
  const events = h.runService.getRunEvents(run.id);
  assert.equal(events.some((event) => event.event_type === 'final_output'), false);
  assert.equal(events.some((event) => (event.payload_json || '').includes(secret)), false);
  const toolEvent = events.find((event) => event.event_type === 'tool_use');
  assert.deepEqual(JSON.parse(toolEvent.payload_json), {
    tool: 'Bash',
    id: 'tool-terminal',
  });
});

test('detached remote Claude harvests the durable result when the bounded tail is empty', async (t) => {
  const db = await mkdb(t);
  const structuredResult = JSON.stringify({
    type: 'result',
    is_error: false,
    stop_reason: 'end_turn',
    result: 'durable result after oversized tail',
    usage: { input_tokens: 21, output_tokens: 34 },
    total_cost_usd: 0.75,
  });
  const remoteChannel = makeRemoteChannel({
    alive: false,
    exitCode: 0,
    output: '',
    structuredResult,
  });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeDurableResult',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.addRunEvent(run.id, 'runtime:remote_worker_engine', JSON.stringify({
    engine: 'claude-stream-json',
    version: 1,
  }));
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });

  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'completed');
  assert.equal(after.result_summary, 'durable result after oversized tail');
  assert.equal(after.input_tokens, 21);
  assert.equal(after.output_tokens, 34);
  assert.equal(after.cost_usd, 0.75);
  assert.deepEqual(remoteChannel.getStructuredResultCalls, [{ runId: run.id }]);
});

test('detached remote Claude goal capture parses the semantic result instead of raw NDJSON', async (t) => {
  const db = await mkdb(t);
  const goalText = [
    'finished',
    '```palantir-goal-report',
    '{"goal_status":"achieved","summary":"remote complete","blockers":[]}',
    '```',
  ].join('\n');
  const longResult = `${'x'.repeat(70 * 1024)}\n${goalText}`;
  const output = JSON.stringify({
    type: 'result',
    is_error: false,
    stop_reason: 'end_turn',
    result: longResult,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  const remoteChannel = makeRemoteChannel({
    alive: false,
    exitCode: 0,
    output: '',
    structuredResult: output,
  });
  const eventBus = createEventBus();
  const h = buildHarness(db, { remoteChannel, eventBus });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeGoalResult',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.setGoalActive(run.id, true);
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
  h.lifecycleService.startMonitoring();
  t.after(() => h.lifecycleService.stopMonitoring());

  await h.lifecycleService.checkHealth();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const after = h.runService.getRun(run.id);
  assert.ok(Buffer.byteLength(after.final_output, 'utf8') <= 64 * 1024);
  assert.ok(after.final_output.endsWith(goalText));
  assert.deepEqual(JSON.parse(after.goal_report), {
    goal_status: 'achieved',
    summary: 'remote complete',
    blockers: [],
  });
});

test('detached remote Claude max_turns remains needs_input after later health ticks', async (t) => {
  const db = await mkdb(t);
  const output = JSON.stringify({
    type: 'result',
    is_error: false,
    stop_reason: 'max_turns',
    result: 'partial result',
    usage: { input_tokens: 9, output_tokens: 10 },
    num_turns: 200,
  });
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 0, output });
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db, { command: 'claude' });
  const project = h.projectService.createProject({
    name: 'RemoteClaudeLimitResult',
    directory: '/workspace/project',
    node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: profile.id,
    prompt: 'health',
    node_id: 'ssh-pod',
  });
  h.runService.markRunStarted(run.id, { tmux_session: `palantir-run-${run.id}` });
  h.runService.addRunEvent(run.id, 'runtime:remote_worker_engine', JSON.stringify({
    engine: 'claude-stream-json',
    version: 1,
  }));
  for (let index = 0; index < 1001; index++) {
    h.runService.addRunEvent(run.id, 'heartbeat', null);
  }
  h.agentProfileService.deleteProfile(profile.id);
  assert.equal(h.runService.getRun(run.id).agent_profile_id, null);

  await h.lifecycleService.checkHealth();
  await h.lifecycleService.checkHealth();

  const after = h.runService.getRun(run.id);
  assert.equal(after.status, 'needs_input');
  assert.equal(after.result_summary, 'partial result');
  assert.equal(after.exit_code, 0);
  assert.equal(h.runService.hasRunEvent(run.id, 'limit_reached'), true);
  assert.equal(
    h.runService.getRunEvents(run.id)
      .some((event) => event.event_type === 'limit_reached'),
    false,
    'the marker sits beyond the legacy oldest-first 1,000-event window',
  );
});

test('boot housekeeping releases a dead lease before reaping the sentinel dir', async (t) => {
  // codex S1b R1 #4: the boot reap deleted the remote status dir — exit
  // sentinel included — without releasing the held lease first. With the only
  // durable dead evidence gone, the sweep could only ever say unknown and the
  // lease stayed held forever (a permanent slot under the capacity flag).
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: false, exitCode: 1 });
  const cleanupCalls = [];
  remoteChannel.cleanupRun = async (runId) => { cleanupCalls.push(runId); };
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'ReapProject', directory: '/workspace/project', node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id, agent_profile_id: profile.id, prompt: 'reap', node_id: 'ssh-pod',
  });
  const claim = h.runService.claimQueuedRun(run.id, { withLease: true });
  db.prepare("UPDATE run_owner_leases SET engine = 'remote' WHERE run_id = ?").run(run.id);
  // The run actually spawned (acquired), then finished — a reserved lease's
  // sentinel evidence is deliberately distrusted, so this fixture must model
  // the real spawn path.
  h.runService.markRunStarted(run.id, claim.leaseId, { tmux_session: `palantir-run-${run.id}` });
  h.runService.updateRunStatus(run.id, 'completed', { force: true });
  h.runService.addRunEvent(run.id, 'harvest:diff', JSON.stringify({ ok: true }));

  await h.lifecycleService.recoverOrphanSessions();

  assert.deepEqual(cleanupCalls, [run.id], 'the reap must still run');
  const lease = db.prepare('SELECT state, lease_id FROM run_owner_leases WHERE run_id = ?').get(run.id);
  assert.equal(lease.state, 'released', 'the dead lease must be released before the evidence is destroyed');
  assert.equal(lease.lease_id, claim.leaseId);
});

test('boot housekeeping refuses to reap while the owner is not confirmed dead', async (t) => {
  // codex S1b R2 #1: reaping an alive/unknown owner's status dir destroys
  // where its exit sentinel WILL be written — permanent unknown. The reap must
  // skip and leave the dir for a later boot or the sweep.
  const db = await mkdb(t);
  const remoteChannel = makeRemoteChannel({ alive: true, exitCode: null });
  const cleanupCalls = [];
  remoteChannel.cleanupRun = async (runId) => { cleanupCalls.push(runId); };
  const h = buildHarness(db, { remoteChannel });
  createSshNode(h.nodeService);
  const profile = seedProfile(db);
  const project = h.projectService.createProject({
    name: 'ReapAliveProject', directory: '/workspace/project', node_id: 'ssh-pod',
  });
  const task = seedTask(h.taskService, project.id);
  const run = h.runService.createRun({
    task_id: task.id, agent_profile_id: profile.id, prompt: 'reap-alive', node_id: 'ssh-pod',
  });
  h.runService.claimQueuedRun(run.id, { withLease: true });
  db.prepare("UPDATE run_owner_leases SET engine = 'remote' WHERE run_id = ?").run(run.id);
  h.runService.updateRunStatus(run.id, 'completed', { force: true });
  h.runService.addRunEvent(run.id, 'harvest:diff', JSON.stringify({ ok: true }));

  await h.lifecycleService.recoverOrphanSessions();

  assert.deepEqual(cleanupCalls, [], 'an unconfirmed owner blocks the reap');
  assert.equal(
    db.prepare('SELECT state FROM run_owner_leases WHERE run_id = ?').get(run.id).state,
    'held',
  );
});
