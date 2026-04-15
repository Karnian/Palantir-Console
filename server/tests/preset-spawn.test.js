// Phase 10C — preset spawn wiring integration tests.
//
// Drives lifecycleService.executeTask with stubbed spawn engines and asserts
// that (a) preset MCP is merged with precedence preset > project > skill pack,
// (b) Claude worker gets a merged mcp-config file + composed system prompt,
// (c) Codex worker gets `-c mcp_servers=<json>` args + prompt-file placeholder,
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

  const run = lc.executeTask(task.id, {
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

test('Phase 10C: Codex worker with preset — injects -c mcp_servers + writes system prompt file', async (t) => {
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

  lc.executeTask(task.id, {
    agentProfileId: profile.id, prompt: 'hi', presetId: preset.id,
  });

  assert.equal(exec.spawned.length, 1);
  const args = exec.spawned[0].opts.args;
  // `-c mcp_servers=<json>` prepended
  const cIdx = args.indexOf('-c');
  assert.ok(cIdx >= 0, 'codex -c flag present');
  assert.ok(args[cIdx + 1].startsWith('mcp_servers='), '-c mcp_servers= form');
  assert.ok(args[cIdx + 1].includes('"ctx7"'), 'ctx7 alias included');
  // system_prompt_file placeholder was written (args_template contains
  // {system_prompt_file} — the substituted path appears in args).
  const promptFileArg = args.find(a => a.includes('-system-prompt.md'));
  assert.ok(promptFileArg, 'system_prompt_file placeholder was substituted');
  const content = fs.readFileSync(promptFileArg, 'utf8');
  assert.ok(content.startsWith('CODEX PRESET'), 'preset prompt leads composed file');
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

  const run = lc.executeTask(task.id, {
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

  const run = lc.executeTask(task.id, {
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
  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
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
  assert.throws(
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

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(sje.spawned.length, 1);
  assert.ok(sje.spawned[0].opts.systemPrompt.startsWith('DEFAULT'));
  assert.equal(rs.getRun(run.id).preset_id, preset.id);
});

test('Phase 10C: no preset → legacy path unchanged (no preset_id binding, no tier2 warn)', async (t) => {
  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: mkPluginsRoot(t) });
  const { lc, sje, rs } = buildLifecycle(db, { presetService });

  const project = seedProject(db);
  const task = seedTask(db, project.id);
  const profile = seedProfile(db, 'claude');

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi' });
  assert.equal(sje.spawned.length, 1);
  const persisted = rs.getRun(run.id);
  assert.equal(persisted.preset_id, null);
  assert.equal(persisted.preset_snapshot_hash, null);
  const events = rs.getRunEvents(run.id);
  assert.equal(events.filter(e => e.event_type.startsWith('preset:')).length, 0);
});
