const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createMcpTemplateService } = require('../services/mcpTemplateService');
const { createPresetService } = require('../services/presetService');
const { preflightHttpMcpConfig } = require('../services/mcpPreflight');

const PROCESS_HIJACK_KEYS = ['LD_PRELOAD', 'NODE_OPTIONS', 'PATH', 'HOME'];

async function makeHarness(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-mcp-bearer-deny-'));
  const { db, migrate, close } = createDatabase(path.join(root, 'test.db'));
  migrate();
  const pluginsRoot = path.join(root, 'plugins');
  fs.mkdirSync(pluginsRoot);

  const spawned = [];
  const executionEngine = {
    type: 'subprocess',
    spawned,
    spawnAgent(runId, opts) {
      spawned.push({ runId, opts });
      return { sessionName: `session-${runId}` };
    },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const agentProfileService = createAgentProfileService(db);
  const defaultPresetService = createPresetService(db, { pluginsRoot });
  // `presetService: null` is a supported production shape (the legacy merge
  // fallback), so the override must be able to force it off rather than only
  // replace it.
  const presetService = Object.prototype.hasOwnProperty.call(overrides, 'presetService')
    ? overrides.presetService
    : defaultPresetService;
  const lifecycleService = createLifecycleService({
    runService,
    taskService,
    projectService,
    agentProfileService,
    presetService,
    skillPackService: overrides.skillPackService || undefined,
    executionEngine,
    streamJsonEngine: null,
    worktreeService: null,
    eventBus: null,
    runtimeMcpDir: path.join(root, 'runtime-mcp'),
  });

  t.after(async () => {
    close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  return {
    root,
    db,
    spawned,
    runService,
    taskService,
    projectService,
    presetService: defaultPresetService,
    lifecycleService,
  };
}

function seedProfile(db, envAllowlist = []) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent
    ) VALUES (?, 'Denylist Agent', 'codex', 'codex', '{prompt}', '{}', ?, 5)
  `).run(id, JSON.stringify(envAllowlist));
  return id;
}

function seedQueuedRun(h, project, {
  workspacePath = null,
  envAllowlist = [],
  presetId = null,
} = {}) {
  const task = h.taskService.createTask({
    project_id: project.id,
    title: 'MCP bearer denylist',
    description: 'verify spawn isolation',
  });
  const run = h.runService.createRun({
    task_id: task.id,
    agent_profile_id: seedProfile(h.db, envAllowlist),
    prompt: 'test',
    queued_args: {
      skillPackIds: null,
      presetId,
    },
  });
  if (workspacePath) {
    h.db.prepare(`
      UPDATE runs
         SET source_type_snapshot = 'git',
             run_source_generation = 0,
             workspace_path = ?,
             workspace_generation = 0,
             resolved_commit = '0123456789abcdef0123456789abcdef01234567'
       WHERE id = ?
    `).run(workspacePath, run.id);
  }
  return h.runService.getRun(run.id);
}

function setEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function enablePreflightSkip(t) {
  setEnv(t, 'PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP', '1');
}

function materializedSpawnEnv(spawned) {
  return Object.assign({}, ...spawned.map(({ opts }) => opts.env || opts.spec?.env || {}));
}

function assertEnvAbsent(spawned, key) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(materializedSpawnEnv(spawned), key),
    false,
    `${key} must be absent, not merely empty, in every worker spawn env`,
  );
}

function assertDeniedRun(h, run, key, reason, source) {
  assert.equal(h.runService.getRun(run.id).status, 'failed');
  assert.equal(h.spawned.length, 0, 'worker spawn must not be attempted');
  assertEnvAbsent(h.spawned, key);
  const unreachable = h.runService.getRunEvents(run.id)
    .find((event) => event.event_type === 'preset:mcp_unreachable');
  assert.ok(unreachable, 'denial must be observable as preset:mcp_unreachable');
  const payload = JSON.parse(unreachable.payload_json);
  assert.equal(payload.reason, reason);
  assert.equal(payload.bearer_env, key);
  assert.equal(payload.source, source);
  assert.equal(JSON.stringify(payload).includes(`host-value-for-${key}`), false);
}

function writeProjectMcp(h, key, name) {
  const projectDir = path.join(h.root, name);
  fs.mkdirSync(projectDir);
  const configPath = path.join(projectDir, 'mcp.json');
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      projectHttp: {
        url: 'http://127.0.0.1:3100/mcp',
        bearer_token_env_var: key,
      },
    },
  }));
  return h.projectService.createProject({
    name,
    directory: projectDir,
    mcp_config_path: configPath,
  });
}

async function createHttpPreset(h, key, alias) {
  const templateService = createMcpTemplateService(h.db);
  const template = await templateService.createTemplate({
    alias,
    transport: 'http',
    url: 'http://localhost:3100/mcp',
    bearer_token_env_var: key,
  });
  return h.presetService.createPreset({
    name: `Preset ${alias}`,
    mcp_server_ids: [template.id],
  });
}

function createRawHttpPreset(h, key, alias) {
  const templateId = `tpl_${alias}`;
  h.db.prepare(`
    INSERT INTO mcp_server_templates (
      id, alias, transport, url, bearer_token_env_var, updated_at
    ) VALUES (?, ?, 'http', 'http://127.0.0.1:3100/mcp', ?, datetime('now'))
  `).run(templateId, alias, key);
  return h.presetService.createPreset({
    name: `Preset ${alias}`,
    mcp_server_ids: [templateId],
  });
}

test('template CRUD shares the immutable bearer process-hijack denylist', async (t) => {
  const h = await makeHarness(t);
  const service = createMcpTemplateService(h.db);

  for (const key of PROCESS_HIJACK_KEYS) {
    await assert.rejects(
      () => service.createTemplate({
        alias: `denied_${key.toLowerCase()}`,
        transport: 'http',
        url: 'http://localhost:3100/mcp',
        bearer_token_env_var: key,
      }),
      (error) => error.status === 400 && /globally-denied/.test(error.message),
      `template CRUD should reject ${key}`,
    );
  }
});

test('BIFROST_MCP_TOKEN from template/preset reaches the worker', async (t) => {
  const h = await makeHarness(t);
  enablePreflightSkip(t);
  setEnv(t, 'BIFROST_MCP_TOKEN', 'bifrost-token-value');
  const preset = await createHttpPreset(h, 'BIFROST_MCP_TOKEN', 'bifrost');
  const project = h.projectService.createProject({ name: 'Bifrost project' });
  const run = seedQueuedRun(h, project, { presetId: preset.id });

  await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(h.spawned.length, 1);
  const spawnEnv = materializedSpawnEnv(h.spawned);
  assert.equal(
    Object.prototype.hasOwnProperty.call(spawnEnv, 'BIFROST_MCP_TOKEN'),
    true,
  );
  assert.equal(spawnEnv.BIFROST_MCP_TOKEN, 'bifrost-token-value');
});

test('same SOME_MCP_TOKEN follows provenance and explicit profile authority', async (t) => {
  await t.test('preset source auto-allows', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'SOME_MCP_TOKEN', 'preset-token-value');
    const preset = await createHttpPreset(h, 'SOME_MCP_TOKEN', 'some_preset');
    const project = h.projectService.createProject({ name: 'Preset provenance' });
    const run = seedQueuedRun(h, project, { presetId: preset.id });

    await h.lifecycleService.spawnQueuedRun(run.id);

    assert.equal(h.spawned.length, 1);
    assert.equal(materializedSpawnEnv(h.spawned).SOME_MCP_TOKEN, 'preset-token-value');
  });

  await t.test('project source without profile allowlist fails closed', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'SOME_MCP_TOKEN', 'host-value-for-SOME_MCP_TOKEN');
    const project = writeProjectMcp(h, 'SOME_MCP_TOKEN', 'Project untrusted');
    const run = seedQueuedRun(h, project);

    await assert.rejects(
      () => h.lifecycleService.spawnQueuedRun(run.id),
      /MCP preflight failed: projectHttp \(bearer_env_untrusted_source\)/,
    );
    assertDeniedRun(h, run, 'SOME_MCP_TOKEN', 'bearer_env_untrusted_source', 'project');
  });

  await t.test('project source with explicit profile allowlist passes', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'SOME_MCP_TOKEN', 'operator-approved-value');
    const project = writeProjectMcp(h, 'SOME_MCP_TOKEN', 'Project approved');
    const run = seedQueuedRun(h, project, { envAllowlist: ['SOME_MCP_TOKEN'] });

    await h.lifecycleService.spawnQueuedRun(run.id);

    assert.equal(h.spawned.length, 1);
    const spawnEnv = materializedSpawnEnv(h.spawned);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnEnv, 'SOME_MCP_TOKEN'), true);
    assert.equal(spawnEnv.SOME_MCP_TOKEN, 'operator-approved-value');
  });
});

test('GITHUB_TOKEN from project/repo needs explicit profile authority', async (t) => {
  await t.test('project source without allowlist cannot read host token', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'GITHUB_TOKEN', 'host-value-for-GITHUB_TOKEN');
    const project = writeProjectMcp(h, 'GITHUB_TOKEN', 'Project GitHub attack');
    const run = seedQueuedRun(h, project);

    await assert.rejects(
      () => h.lifecycleService.spawnQueuedRun(run.id),
      /bearer_env_untrusted_source/,
    );
    assertDeniedRun(h, run, 'GITHUB_TOKEN', 'bearer_env_untrusted_source', 'project');
  });

  await t.test('repo_relpath source without allowlist cannot read host token', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'GITHUB_TOKEN', 'host-value-for-GITHUB_TOKEN');
    setEnv(st, 'PALANTIR_PROJECT_REPO', '1');
    const workspace = path.join(h.root, 'repo-workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, '.mcp.json'), JSON.stringify({
      mcpServers: {
        repoHttp: {
          url: 'http://127.0.0.1:3100/mcp',
          bearer_token_env_var: 'GITHUB_TOKEN',
        },
      },
    }));
    const project = h.projectService.createProject({
      name: 'Repo GitHub attack',
      source_type: 'git',
      repo_url: 'https://example.com/repo.git',
      repo_ref: 'HEAD',
      mcp_config_source: 'repo_relpath',
      mcp_config_relpath: '.mcp.json',
    });
    const run = seedQueuedRun(h, project, { workspacePath: workspace });

    await assert.rejects(
      () => h.lifecycleService.spawnQueuedRun(run.id),
      /bearer_env_untrusted_source/,
    );
    assertDeniedRun(h, run, 'GITHUB_TOKEN', 'bearer_env_untrusted_source', 'project');
  });

  await t.test('explicit profile allowlist is respected', async (st) => {
    const h = await makeHarness(st);
    enablePreflightSkip(st);
    setEnv(st, 'GITHUB_TOKEN', 'operator-approved-github-token');
    const project = writeProjectMcp(h, 'GITHUB_TOKEN', 'Project GitHub approved');
    const run = seedQueuedRun(h, project, { envAllowlist: ['GITHUB_TOKEN'] });

    await h.lifecycleService.spawnQueuedRun(run.id);

    assert.equal(h.spawned.length, 1);
    const spawnEnv = materializedSpawnEnv(h.spawned);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnEnv, 'GITHUB_TOKEN'), true);
    assert.equal(spawnEnv.GITHUB_TOKEN, 'operator-approved-github-token');
  });
});

test('process-loader/path hijack keys are rejected even from preset provenance', async (t) => {
  for (const key of PROCESS_HIJACK_KEYS) {
    await t.test(key, async (st) => {
      const h = await makeHarness(st);
      enablePreflightSkip(st);
      setEnv(st, key, `host-value-for-${key}`);
      // Raw insert models a legacy/pre-validation row. New CRUD rejects it too.
      const preset = createRawHttpPreset(h, key, `legacy_${key.toLowerCase()}`);
      const project = h.projectService.createProject({ name: `Preset ${key}` });
      const run = seedQueuedRun(h, project, { presetId: preset.id });

      await assert.rejects(
        () => h.lifecycleService.spawnQueuedRun(run.id),
        /bearer_env_process_hijack/,
      );
      assertDeniedRun(h, run, key, 'bearer_env_process_hijack', 'preset');
    });
  }
});

test('network preflight skip does not bypass process-hijack validation', async (t) => {
  enablePreflightSkip(t);
  const out = await preflightHttpMcpConfig({
    mcpServers: {
      hostile: {
        url: 'http://127.0.0.1:3100/mcp',
        bearer_token_env_var: 'NODE_OPTIONS',
      },
    },
  });
  assert.equal(out.skipped, false);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].reason, 'bearer_env_process_hijack');
  assert.equal(out.failures[0].bearer_env, 'NODE_OPTIONS');
});

// ── codex adversarial review (PR B, MINOR): the three policy branches that the
// first test matrix asserted only by reading the code. Each is a distinct way
// the provenance gate could be wrong without any existing test noticing.

function stubSkillPackService(mcpConfig) {
  return {
    resolveForRun: () => ({
      mcpConfig,
      warnings: [],
      appliedPacks: [],
      promptSections: [],
    }),
    recordRunSnapshots() {},
  };
}

test('skill-pack MCP is trusted provenance and auto-allows its bearer key', async (t) => {
  const h = await makeHarness(t, {
    skillPackService: stubSkillPackService({
      mcpServers: {
        packHttp: {
          url: 'http://127.0.0.1:3100/mcp',
          bearer_token_env_var: 'PACK_MCP_TOKEN',
        },
      },
    }),
  });
  enablePreflightSkip(t);
  setEnv(t, 'PACK_MCP_TOKEN', 'host-value-for-PACK_MCP_TOKEN');

  const project = h.projectService.createProject({ name: 'pack-trusted', directory: h.root });
  const run = seedQueuedRun(h, project);
  await h.lifecycleService.spawnQueuedRun(run.id);

  assert.equal(h.runService.getRun(run.id).status !== 'failed', true, 'trusted pack must not be rejected');
  assert.equal(
    materializedSpawnEnv(h.spawned).PACK_MCP_TOKEN,
    'host-value-for-PACK_MCP_TOKEN',
    'skill-pack bearer key must reach the worker without a profile allowlist entry',
  );
});

test('a shadowed alias is judged by the merge winner, not by the losing source', async (t) => {
  // mergeMcp3 applies skillPack -> project -> preset with later overwriting, so
  // preset WINS. If the gate walked sources in the other order it would judge
  // the project's GITHUB_TOKEN for an alias the merge never uses, and fail a
  // run that is actually safe.
  const project = { name: 'alias-shadow' };
  const h = await makeHarness(t);
  enablePreflightSkip(t);
  setEnv(t, 'SHADOW_MCP_TOKEN', 'host-value-for-SHADOW_MCP_TOKEN');
  setEnv(t, 'GITHUB_TOKEN', 'host-value-for-GITHUB_TOKEN');

  const projectDir = path.join(h.root, project.name);
  fs.mkdirSync(projectDir);
  const configPath = path.join(projectDir, 'mcp.json');
  // Same alias the preset uses, but naming an unrelated host secret.
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      sharedAlias: {
        url: 'http://127.0.0.1:3100/mcp',
        bearer_token_env_var: 'GITHUB_TOKEN',
      },
    },
  }));
  const proj = h.projectService.createProject({
    name: project.name,
    directory: projectDir,
    mcp_config_path: configPath,
  });
  const preset = createRawHttpPreset(h, 'SHADOW_MCP_TOKEN', 'sharedAlias');

  const run = seedQueuedRun(h, proj, { presetId: preset.id });
  await h.lifecycleService.spawnQueuedRun(run.id);

  assert.notEqual(h.runService.getRun(run.id).status, 'failed', 'winning preset alias is safe');
  const env = materializedSpawnEnv(h.spawned);
  assert.equal(env.SHADOW_MCP_TOKEN, 'host-value-for-SHADOW_MCP_TOKEN');
  assertEnvAbsent(h.spawned, 'GITHUB_TOKEN');
});

test('the presetService-absent fallback still denies project bearer keys', async (t) => {
  // presetService is optional; the legacy merge path below it must not become a
  // hole where a project config regains auto-forwarding.
  const h = await makeHarness(t, { presetService: null });
  enablePreflightSkip(t);
  setEnv(t, 'GITHUB_TOKEN', 'host-value-for-GITHUB_TOKEN');

  const proj = writeProjectMcp(h, 'GITHUB_TOKEN', 'fallback-project');
  const run = seedQueuedRun(h, proj);
  await assert.rejects(
    () => h.lifecycleService.spawnQueuedRun(run.id),
    /bearer_env_untrusted_source/,
  );

  assertDeniedRun(h, run, 'GITHUB_TOKEN', 'bearer_env_untrusted_source', 'project');
});
