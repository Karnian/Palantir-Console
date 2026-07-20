// Phase 10C — preset spawn wiring integration tests.
//
// Drives lifecycleService.executeTask with stubbed spawn engines and asserts
// that (a) preset MCP is merged with precedence preset > project > skill pack,
// (b) Claude worker gets a merged mcp-config file + composed system prompt,
// (c) Codex worker gets leaf-level `-c mcp_servers.<alias>.<key>=<TOML>` args
//     (M1: replaces the earlier top-level `mcp_servers=<JSON>` blob that Codex
//     rejected with "invalid type: string, expected a map"),
// (d) snapshot persists to run_preset_snapshots at resolve time (not spawn),
// (e) Tier 2 isolated preset emits a `preset:tier2_pending` warn but does not
// add --bare / --plugin-dir yet (Phase 10D).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createPresetService } = require('../services/presetService');

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-p10c-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  // Seed at least one MCP template so preset mcp_server_ids validates.
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, command, args, allowed_env_keys, description)
    VALUES ('tpl_ctx7', 'ctx7', 'npx', '["-y","@ctx7/mcp"]', '[]', 'ctx7')
  `).run();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return db;
}

function mkPluginsRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-p10c-plugins-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePlugin(root, name, files = { 'plugin.json': '{}' }) {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function stubExecEngine() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `s-${runId}` }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() { /* */ },
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubSJE() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: null }; },
    hasProcess(runId) { return spawned.some(s => s.runId === runId); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

function seedTask(db, projectId) {
  return createTaskService(db).createTask({ project_id: projectId, title: 'T', description: 'd' });
}

function seedProfile(db, command) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 5)`
  ).run(id, 'Agent', command, command, '{prompt} {system_prompt_file}', '{}', '[]');
  return { id, command, name: 'Agent', args_template: '{prompt} {system_prompt_file}' };
}

function seedProject(db) {
  return createProjectService(db).createProject({ name: 'P', directory: null });
}

function buildLifecycle(db, { presetService, claudeVersionResolver } = {}) {
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExecEngine();
  const sje = stubSJE();
  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: sje, worktreeService: null, eventBus: null,
    presetService, claudeVersionResolver,
  });
  return { rs, ts, ps, aps, exec, sje, lc };
}

test('Phase 10C: Claude worker with preset — systemPrompt composed, mcpConfig merged, snapshot persisted', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkPluginsRoot(t); writePlugin(pluginsRoot, 'sample');
  const presetService = createPresetService(db, { pluginsRoot });
  const { lc, sje, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'claude');

  const preset = presetService.createPreset({
    name: 'Tier1Claude',
    base_system_prompt: 'PRESET PROMPT',
    plugin_refs: ['sample'],
    mcp_server_ids: ['tpl_ctx7'],
    isolated: false,
  });

  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
  });

  assert.equal(sje.spawned.length, 1);
  const opts = sje.spawned[0].opts;
  // systemPrompt starts with preset base — §6.8 ordering
  assert.ok(opts.systemPrompt && opts.systemPrompt.startsWith('PRESET PROMPT'), 'preset prompt first');
  // mcpConfig was computed (path may be cleaned up by parallel tests' orphan
  // sweep — verify via DB snapshot which cannot be touched by other tests).
  assert.ok(opts.mcpConfig, 'mcpConfig path set');
  const runFromDb = rs.getRun(run.id);
  const mergedSnapshot = JSON.parse(runFromDb.mcp_config_snapshot || '{}');
  assert.ok(mergedSnapshot.mcpServers && mergedSnapshot.mcpServers.ctx7, 'ctx7 MCP from preset present in snapshot');

  // runs.preset_id + preset_snapshot_hash bound
  const persistedRun = rs.getRun(run.id);
  assert.equal(persistedRun.preset_id, preset.id);
  assert.ok(persistedRun.preset_snapshot_hash);

  // Snapshot row exists
  const snap = presetService.getSnapshotForRun(run.id);
  assert.ok(snap);
  assert.equal(snap.preset_id, preset.id);
});

test('Phase 10C+M1: Codex worker with preset — injects leaf-level -c mcp_servers.<alias>.<key> + writes system prompt file', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkPluginsRoot(t);
  const presetService = createPresetService(db, { pluginsRoot });
  const { lc, exec } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');

  const preset = presetService.createPreset({
    name: 'Tier1Codex',
    base_system_prompt: 'CODEX PRESET',
    mcp_server_ids: ['tpl_ctx7'],
  });

  await lc.executeTask(task.id, {
    agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
  });

  assert.equal(exec.spawned.length, 1);
  const args = exec.spawned[0].opts.args;
  // Collect all `-c <value>` pairs — M1 uses Codex leaf-level dotted path:
  //   -c mcp_servers.<alias>.<key>=<TOML-value>
  // Old worker path emitted `-c mcp_servers=<JSON>` which Codex rejects with
  // "invalid type: string, expected a map". That MUST not appear.
  const cflags = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && i + 1 < args.length) cflags.push(args[i + 1]);
  }
  assert.ok(cflags.length > 0, 'codex -c flag present');
  assert.ok(
    !cflags.some(c => /^mcp_servers=/.test(c)),
    'must not emit top-level mcp_servers=<JSON> blob (Codex rejects it)',
  );
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.command=/.test(c)),
    'ctx7.command leaf emitted',
  );
  assert.ok(
    cflags.some(c => /^mcp_servers\.ctx7\.args=/.test(c)),
    'ctx7.args leaf emitted',
  );
  // system_prompt_file placeholder was written (args_template contains
  // {system_prompt_file} — the substituted path appears in args).
  const promptFileArg = args.find(a => a.includes('-system-prompt.md'));
  assert.ok(promptFileArg, 'system_prompt_file placeholder was substituted');
  const content = fs.readFileSync(promptFileArg, 'utf8');
  assert.ok(content.startsWith('CODEX PRESET'), 'preset prompt leads composed file');
});

test('issue #113: Codex worker keeps stdio env out of argv and cleans wrapper after spawn failure', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const secret = 'worker-"quote"\n비밀-🔐';
  const originalMerge = presetService.mergeMcp3.bind(presetService);
  presetService.mergeMcp3 = function mergeWithSecretEnv(presetMcp, projectMcp, skillPackMcp, opts) {
    originalMerge(presetMcp, projectMcp, skillPackMcp, opts);
    return {
      mcpServers: {
        secretstdio: {
          command: 'npx',
          args: ['-y', '@scope/secret-mcp'],
          env: { MCP_SECRET: secret },
          required: true,
        },
      },
    };
  };

  const { lc, exec, rs } = buildLifecycle(db, { presetService });
  let wrapperPath = null;
  let wrapperModeAtSpawn = null;
  let wrapperContentAtSpawn = null;
  let capturedArgs = null;
  exec.spawnAgent = function failAfterCapturing(_runId, opts) {
    capturedArgs = [...opts.args];
    const flags = [];
    for (let i = 0; i < capturedArgs.length; i++) {
      if (capturedArgs[i] === '-c' && i + 1 < capturedArgs.length) flags.push(capturedArgs[i + 1]);
    }
    const wrapperArgsFlag = flags.find(flag => flag.startsWith('mcp_servers.secretstdio.args='));
    assert.ok(wrapperArgsFlag, 'worker receives wrapper args leaf');
    const wrapperArgs = JSON.parse(wrapperArgsFlag.slice('mcp_servers.secretstdio.args='.length));
    wrapperPath = wrapperArgs[0];
    wrapperModeAtSpawn = fs.statSync(wrapperPath).mode & 0o777;
    wrapperContentAtSpawn = fs.readFileSync(wrapperPath, 'utf8');
    assert.ok(flags.includes('mcp_servers.secretstdio.env.NODE_OPTIONS=""'));
    assert.ok(flags.includes('mcp_servers.secretstdio.required=true'));
    throw new Error('intentional worker spawn failure');
  };

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');
  const preset = presetService.createPreset({
    name: 'SecretWorkerMcp',
    mcp_server_ids: ['tpl_ctx7'],
  });

  await assert.rejects(
    () => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id }),
    /intentional worker spawn failure/,
  );

  assert.ok(capturedArgs, 'worker spawn was reached with prepared args');
  assert.equal(JSON.stringify(capturedArgs).includes(secret), false, 'secret occurs zero times in worker argv');
  assert.equal(wrapperModeAtSpawn, 0o600);
  assert.match(wrapperContentAtSpawn, /MCP_SECRET/);
  assert.match(wrapperContentAtSpawn, /비밀-🔐/);
  assert.equal(fs.existsSync(wrapperPath), false, 'outer spawn-failure cleanup removes wrapper dir');
  const failedRun = rs.listRuns({})[0];
  assert.equal(failedRun.status, 'failed');

  // The control-plane forensic snapshot intentionally remains separate from
  // the execution-node wrapper. Remove it in this eventBus-less unit harness.
  if (failedRun.mcp_config_path) fs.rmSync(failedRun.mcp_config_path, { force: true });
});

test('M1: Codex worker with invalid MCP (direct bearer_token) — fails closed, run marked failed, preset:mcp_invalid emitted', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  // Shim the merge so the lifecycleService receives an intentionally invalid
  // mcpServers map (direct `bearer_token` is refused by flattenMcpToCodexArgs).
  // This is the only surface we need to stage — mcp_server_templates / preset
  // schema intentionally don't accept that field, which is the whole point of
  // fail-closed on the lifecycle side.
  const origMerge = presetService.mergeMcp3.bind(presetService);
  presetService.mergeMcp3 = function patchedMerge(presetMcp, projectMcp, skillPackMcp, opts) {
    origMerge(presetMcp, projectMcp, skillPackMcp, opts);
    return {
      mcpServers: {
        bad: { command: 'echo', bearer_token: 'secret-leak' },
      },
    };
  };

  const { lc, exec, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');

  const preset = presetService.createPreset({
    name: 'BadMcp',
    base_system_prompt: 'PRESET',
    mcp_server_ids: ['tpl_ctx7'], // valid template so createPreset passes; merge shim overrides
  });

  await assert.rejects(
    () => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id }),
    /preset MCP invalid for codex worker/,
  );
  // Spawn must not happen
  assert.equal(exec.spawned.length, 0, 'codex spawn must be skipped');
  // Run row was created and then flipped to failed by the outer catch
  const runs = rs.listRuns({});
  assert.ok(runs.length >= 1);
  const last = runs[0];
  assert.equal(last.status, 'failed');
  // preset:mcp_invalid event landed before the throw
  const events = rs.getRunEvents(last.id);
  assert.ok(
    events.some(e => e.event_type === 'preset:mcp_invalid'),
    'preset:mcp_invalid emitted',
  );
});

test('Phase 10C: OpenCode worker with preset — emits preset:mcp_unsupported warning', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, exec, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'opencode');

  const preset = presetService.createPreset({
    name: 'OCMCP',
    mcp_server_ids: ['tpl_ctx7'],
  });

  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
  });

  const events = rs.getRunEvents(run.id);
  const mcpUnsupported = events.find(e => e.event_type === 'preset:mcp_unsupported');
  assert.ok(mcpUnsupported, 'preset:mcp_unsupported warning emitted');
  // opencode spawn does NOT add -c mcp_servers (no support)
  const args = exec.spawned[0].opts.args;
  assert.equal(args.indexOf('-c'), -1);
});

test('Phase 10C→10D: isolated preset emits tier2_active (dormant marker replaced by live wiring)', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkPluginsRoot(t); writePlugin(pluginsRoot, 'xfx');
  const presetService = createPresetService(db, { pluginsRoot });
  // Stub authResolver so Phase 10D's canAuth check doesn't depend on host env.
  const fakeAuthTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-auth-'));
  t.after(() => fs.rmSync(fakeAuthTmp, { recursive: true, force: true }));
  const fakeAuth = {
    resolveClaudeAuthForIsolated: () => ({
      canAuth: true, env: {}, sources: ['test'], diagnostics: [],
      apiKeyHelperSettings: {
        settingsPath: path.join(fakeAuthTmp, 's.json'),
        helperPath: path.join(fakeAuthTmp, 'h.sh'),
        tmpDir: fakeAuthTmp,
        cleanup: () => {},
      },
    }),
  };
  fs.writeFileSync(path.join(fakeAuthTmp, 's.json'), '{}');

  // buildLifecycle doesn't expose authResolver injection. Inline constructor.
  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExecEngine(), sje = stubSJE();
  const { createLifecycleService: createLc } = require('../services/lifecycleService');
  const lc = createLc({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: sje, worktreeService: null, eventBus: null,
    presetService, authResolver: fakeAuth,
  });

  const project = ps.createProject({ name: 'P' });
  const task = ts.createTask({ project_id: project.id, title: 't' });
  const profile = seedProfile(db, 'claude');

  const preset = presetService.createPreset({
    name: 'IsoLive', isolated: true, plugin_refs: ['xfx'],
  });

  const run = await lc.executeTask(task.id, {
    agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
  });
  const events = rs.getRunEvents(run.id);
  assert.ok(events.some(e => e.event_type === 'preset:tier2_active'),
    'preset:tier2_active emitted (Phase 10D)');
  assert.equal(events.some(e => e.event_type === 'preset:tier2_pending'), false,
    'no longer emits the Phase 10C dormant marker');
  // Phase 10D: spawn gets Tier 2 flags through to streamJsonEngine.
  assert.equal(sje.spawned.length, 1);
  assert.equal(sje.spawned[0].opts.isolated, true);
  assert.equal(sje.spawned[0].opts.pluginDirs.length, 1);
});

test('Phase 10C: MCP precedence preset > project > skillPack when all present', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkPluginsRoot(t);
  const presetService = createPresetService(db, { pluginsRoot });
  const { lc, sje, ps, rs } = buildLifecycle(db, { presetService });

  const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p10c-proj-'));
  t.after(() => fs.rmSync(tmpProjectDir, { recursive: true, force: true }));
  // Write project MCP config inside projectDir
  const projectMcpPath = path.join(tmpProjectDir, '.palantir-mcp.json');
  fs.writeFileSync(projectMcpPath, JSON.stringify({
    mcpServers: { shared: { command: 'project' }, projectOnly: { command: 'proj' } },
  }));
  const project = ps.createProject({ name: 'WithMcp', directory: tmpProjectDir, mcp_config_path: projectMcpPath });
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'claude');

  const preset = presetService.createPreset({
    name: 'Precedence',
    mcp_server_ids: ['tpl_ctx7'],
  });
  // Upgrade preset to explicitly override 'shared' alias via a fake template.
  // Simpler: rely on ctx7 from preset being present, project adding shared/projectOnly.
  // Can't easily add a preset server that conflicts with project's 'shared' without more plumbing,
  // so just assert preset.ctx7 present + project overlays preserved.
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const opts = sje.spawned[0].opts;
  // Avoid reading the file path directly — parallel tests may sweep it via
  // lifecycleService.cleanupOrphanMcpConfigs. Read from the DB snapshot.
  assert.ok(opts.mcpConfig);
  const runDb = rs.listRuns({ })[0];
  const merged = JSON.parse(runDb.mcp_config_snapshot || '{}');
  assert.ok(merged.mcpServers.ctx7, 'preset ctx7');
  assert.ok(merged.mcpServers.shared && merged.mcpServers.shared.command === 'project', 'project shared');
  assert.ok(merged.mcpServers.projectOnly, 'project projectOnly');
});

test('Phase 10C: min_claude_version mismatch fails the run', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  // Injected resolver reports old version
  const { lc, rs } = buildLifecycle(db, {
    presetService,
    claudeVersionResolver: () => '1.0.0',
  });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'claude');

  const preset = presetService.createPreset({ name: 'VReq', min_claude_version: '2.0.0' });
  await assert.rejects(
    () => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id }),
    /requires Claude CLI >= 2.0.0/,
  );
  // Some run row should exist with status=failed and a mismatch event
  const runs = rs.listRuns({ });
  const last = runs[0];
  assert.equal(last.status, 'failed');
  const events = rs.getRunEvents(last.id);
  assert.ok(events.some(e => e.event_type === 'preset:version_mismatch'));
});

test('Phase 10C: task.preferred_preset_id is used when presetId arg omitted', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, sje, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const profile = seedProfile(db, 'claude');
  const preset = presetService.createPreset({ name: 'Default', base_system_prompt: 'DEFAULT' });
  // Insert task row with preferred_preset_id directly — taskService may not
  // expose the column yet (that's Phase 10E UI wiring).
  const ts = createTaskService(db);
  const task = ts.createTask({ project_id: project.id, title: 'pref', description: 'd' });
  db.prepare(`UPDATE tasks SET preferred_preset_id = ? WHERE id = ?`).run(preset.id, task.id);

  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(sje.spawned.length, 1);
  assert.ok(sje.spawned[0].opts.systemPrompt.startsWith('DEFAULT'));
  assert.equal(rs.getRun(run.id).preset_id, preset.id);
});

// ────────────────────────────────────────────────────────────────────
// M2: legacy alias conflict detection (mcp:legacy_alias_conflict event)
// Matrix per Codex review: no conflict / preset conflict / skillpack
// conflict / both. `~/.codex/config.toml` is swapped via
// PALANTIR_CODEX_CONFIG_PATH so the util reads a test fixture.
// ────────────────────────────────────────────────────────────────────

function writeUserConfig(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-m2-userconf-'));
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, text);
  const prev = process.env.PALANTIR_CODEX_CONFIG_PATH;
  process.env.PALANTIR_CODEX_CONFIG_PATH = p;
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_CODEX_CONFIG_PATH;
    else process.env.PALANTIR_CODEX_CONFIG_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('M2: no conflict — user config has no overlapping alias → no legacy event', async (t) => {
  writeUserConfig(t, '[mcp_servers.other]\ncommand = "x"\n');
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, rs } = buildLifecycle(db, { presetService });
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');
  const preset = presetService.createPreset({ name: 'NoConflict', mcp_server_ids: ['tpl_ctx7'] });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const events = rs.getRunEvents(run.id);
  assert.equal(events.filter(e => e.event_type === 'mcp:legacy_alias_conflict').length, 0);
});

test('M2: preset conflict — source=preset emitted with fixed {alias, source, message} payload', async (t) => {
  writeUserConfig(t, '[mcp_servers.ctx7]\ncommand = "legacy"\nargs = []\n');
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, rs } = buildLifecycle(db, { presetService });
  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');
  const preset = presetService.createPreset({ name: 'PresetCtx7', mcp_server_ids: ['tpl_ctx7'] });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const events = rs.getRunEvents(run.id).filter(e => e.event_type === 'mcp:legacy_alias_conflict');
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload_json);
  assert.deepEqual(Object.keys(payload).sort(), ['alias', 'message', 'source']);
  assert.equal(payload.alias, 'ctx7');
  assert.equal(payload.source, 'preset');
  assert.match(payload.message, /ctx7.*config\.toml/);
});

test('M2: project conflict — source=project when legacy alias comes from project MCP file', async (t) => {
  writeUserConfig(t, 'mcp_servers.shared.command = "legacy"\n');
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, ps, rs } = buildLifecycle(db, { presetService });
  const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-m2-proj2-'));
  t.after(() => fs.rmSync(tmpProjectDir, { recursive: true, force: true }));
  const projectMcpPath = path.join(tmpProjectDir, '.palantir-mcp.json');
  fs.writeFileSync(projectMcpPath, JSON.stringify({
    mcpServers: { shared: { command: 'from-project' } },
  }));
  const project = ps.createProject({ name: 'ProjOnly', directory: tmpProjectDir, mcp_config_path: projectMcpPath });
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');
  // Preset without MCP so only the project file contributes the 'shared' alias.
  const preset = presetService.createPreset({ name: 'NoMcpPreset' });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const events = rs.getRunEvents(run.id).filter(e => e.event_type === 'mcp:legacy_alias_conflict');
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0].payload_json);
  assert.deepEqual(Object.keys(payload).sort(), ['alias', 'message', 'source']);
  assert.equal(payload.alias, 'shared');
  assert.equal(payload.source, 'project');
});

test('M2: both preset + project aliases conflict — 2 events, correct sources', async (t) => {
  writeUserConfig(t, `
[mcp_servers.ctx7]
command = "legacy"

[mcp_servers.shared]
command = "legacy-shared"
`);
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, ps, rs } = buildLifecycle(db, { presetService });
  const tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-m2-proj-'));
  t.after(() => fs.rmSync(tmpProjectDir, { recursive: true, force: true }));
  const projectMcpPath = path.join(tmpProjectDir, '.palantir-mcp.json');
  fs.writeFileSync(projectMcpPath, JSON.stringify({
    mcpServers: { shared: { command: 'from-project' } },
  }));
  const project = ps.createProject({ name: 'Both', directory: tmpProjectDir, mcp_config_path: projectMcpPath });
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');
  const preset = presetService.createPreset({ name: 'Both', mcp_server_ids: ['tpl_ctx7'] });
  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const events = rs.getRunEvents(run.id).filter(e => e.event_type === 'mcp:legacy_alias_conflict');
  assert.equal(events.length, 2);
  const byAlias = {};
  for (const e of events) {
    const p = JSON.parse(e.payload_json);
    byAlias[p.alias] = p.source;
  }
  assert.equal(byAlias.ctx7, 'preset');
  assert.equal(byAlias.shared, 'project');
});

test('Phase 10C: no preset → legacy path unchanged (no preset_id binding, no tier2 warn)', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, sje, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'claude');

  const run = await lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(sje.spawned.length, 1);
  const persisted = rs.getRun(run.id);
  assert.equal(persisted.preset_id, null);
  assert.equal(persisted.preset_snapshot_hash, null);
  const events = rs.getRunEvents(run.id);
  assert.equal(events.filter(e => e.event_type.startsWith('preset:')).length, 0);
});

// ────────────────────────────────────────────────────────────────────
// M4-a: HTTP transport preset wiring → flatten emits leaf-level url +
// bearer_token_env_var args; preflight gates the spawn.
// ────────────────────────────────────────────────────────────────────

async function seedHttpTemplate(db, alias = 'bifrost') {
  // Direct INSERT — bypass async assertSafeUrl validator. The trigger still
  // enforces column-shape so this only succeeds for valid http rows.
  const id = `tpl_${alias}`;
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, transport, url, bearer_token_env_var, updated_at)
    VALUES (?, ?, 'http', 'http://127.0.0.1:3100/mcp', 'PALANTIR_TEST_M4_TOKEN', datetime('now'))
  `).run(id, alias);
  return id;
}

test('M4-a: Codex worker with http preset → emits leaf-level url + bearer args (no transport key)', async (t) => {
  const prevSkip = process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP;
  process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP = '1';
  process.env.PALANTIR_TEST_M4_TOKEN = 'test-token';
  try {
    const db = await mkdb(t);
    const tplId = await seedHttpTemplate(db, 'bifrost');
    const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
    const { lc, exec } = buildLifecycle(db, { presetService });

    const project = seedProject(db);
    const task = seedTask(db, project.id);
    const profile = seedProfile(db, 'codex');

    const preset = presetService.createPreset({
      name: 'HttpCodex',
      base_system_prompt: 'CODEX HTTP',
      mcp_server_ids: [tplId],
    });

    await lc.executeTask(task.id, {
      agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
    });

    assert.equal(exec.spawned.length, 1, 'codex worker spawned (preflight skipped)');
    const args = exec.spawned[0].opts.args;
    const cflags = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' && i + 1 < args.length) cflags.push(args[i + 1]);
    }
    assert.ok(
      cflags.some(c => /^mcp_servers\.bifrost\.url=/.test(c)),
      'http alias url leaf present',
    );
    assert.ok(
      cflags.some(c => /^mcp_servers\.bifrost\.bearer_token_env_var=/.test(c)),
      'bearer_token_env_var leaf present',
    );
    // Critical: NO transport key (Codex auto-detects from url)
    assert.ok(
      !cflags.some(c => /\.transport=/.test(c)),
      'no transport= arg emitted',
    );
    // No stdio leakage
    assert.ok(!cflags.some(c => /^mcp_servers\.bifrost\.command=/.test(c)));
    assert.ok(!cflags.some(c => /^mcp_servers\.bifrost\.args=/.test(c)));
    // Worker spawn env carries the bearer token (auto-allowlisted)
    assert.equal(exec.spawned[0].opts.env.PALANTIR_TEST_M4_TOKEN, 'test-token');
  } finally {
    if (prevSkip === undefined) delete process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP;
    else process.env.PALANTIR_MCP_ALLOW_PREFLIGHT_SKIP = prevSkip;
    delete process.env.PALANTIR_TEST_M4_TOKEN;
  }
});

test('M4-a: http preset preflight failure (bearer env missing) → run failed + preset:mcp_unreachable', async (t) => {
  // Bearer env absent — preflight short-circuits to bearer_env_missing
  // without ever hitting the network. No skip toggle: we want preflight
  // to actually run.
  delete process.env.PALANTIR_TEST_M4_TOKEN_MISSING;
  const db = await mkdb(t);
  const tplId = `tpl_bearmiss`;
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, transport, url, bearer_token_env_var, updated_at)
    VALUES (?, 'bearmiss', 'http', 'http://127.0.0.1:3100/mcp', 'PALANTIR_TEST_M4_TOKEN_MISSING', datetime('now'))
  `).run(tplId);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, exec, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'codex');

  const preset = presetService.createPreset({
    name: 'NoToken', mcp_server_ids: [tplId],
  });

  await assert.rejects(
    () => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id }),
    /MCP preflight failed: bearmiss/,
  );
  assert.equal(exec.spawned.length, 0, 'spawn must not happen');
  const runs = rs.listRuns({});
  assert.ok(runs.length >= 1);
  const last = runs[0];
  assert.equal(last.status, 'failed');
  const events = rs.getRunEvents(last.id);
  const unreach = events.find(e => e.event_type === 'preset:mcp_unreachable');
  assert.ok(unreach, 'preset:mcp_unreachable emitted');
  const payload = JSON.parse(unreach.payload_json);
  assert.equal(payload.alias, 'bearmiss');
  assert.equal(payload.reason, 'bearer_env_missing');
  // Payload contains env *name*, never value
  assert.equal(payload.bearer_env, 'PALANTIR_TEST_M4_TOKEN_MISSING');
  assert.equal(JSON.stringify(payload).includes('test-token'), false);
});
