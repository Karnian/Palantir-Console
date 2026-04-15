// Phase 10G smoke — pretend the operator dropped agent-olympus into
// `server/plugins/agent-olympus/` and verify that a preset referencing
// it spawns through lifecycleService with:
//  * pluginDirs containing the absolute fixture path
//  * isolated=true forwarded to the streamJsonEngine
//  * snapshot rows persisted with `<pluginRef>/<relpath>` namespacing
//  * a deterministic snapshot hash captured before spawn
//
// The test points presetService.pluginsRoot at the bundled CI fixture
// `server/tests/fixtures/plugins/` so we don't need a real ecosystem
// plugin on disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createPresetService } = require('../services/presetService');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'plugins');

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-10g-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return db;
}

function stubExec() {
  return {
    spawnAgent() { return { sessionName: null }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {},
    discoverGhostSessions() { return []; },
    hasProcess() { return false; },
  };
}

function stubSJE() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: null }; },
    hasProcess(id) { return spawned.some(s => s.runId === id); },
    isAlive() { return true; },
    detectExitCode() { return null; },
    sendInput() { return true; },
    kill() { return true; },
  };
}

test('Phase 10G smoke: agent-olympus-mock preset spawns with Tier 2 wiring', async (t) => {
  // Sanity-check the fixture is where we expect.
  assert.ok(fs.existsSync(path.join(FIXTURE_ROOT, 'agent-olympus-mock', 'plugin.json')),
    'fixture plugin.json present');

  const db = await mkdb(t);
  const presetService = createPresetService(db, { pluginsRoot: FIXTURE_ROOT });

  const sje = stubSJE();
  const fakeAuthTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fake-auth-'));
  t.after(async () => fsp.rm(fakeAuthTmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fakeAuthTmp, 'settings.json'), '{}');
  const fakeAuth = {
    resolveClaudeAuthForIsolated: () => ({
      canAuth: true, env: {}, sources: ['fixture'], diagnostics: [],
      apiKeyHelperSettings: {
        settingsPath: path.join(fakeAuthTmp, 'settings.json'),
        helperPath: path.join(fakeAuthTmp, 'helper.sh'),
        tmpDir: fakeAuthTmp,
        cleanup: () => {},
      },
    }),
  };

  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: stubExec(), streamJsonEngine: sje, worktreeService: null,
    eventBus: null,
    presetService, authResolver: fakeAuth,
  });

  const project = ps.createProject({ name: 'P' });
  const task = ts.createTask({ project_id: project.id, title: 'agent-olympus job' });
  const profileId = `pf-${Date.now()}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
              VALUES (?, ?, ?, ?, ?, ?, ?, 5)`)
    .run(profileId, 'Claude', 'claude', 'claude', '{prompt}', '{}', '[]');

  const preset = presetService.createPreset({
    name: 'AgentOlympusSmoke',
    description: 'Phase 10G smoke',
    isolated: true,
    plugin_refs: ['agent-olympus-mock'],
    base_system_prompt: 'You are an agent-olympus worker.',
  });

  const run = lc.executeTask(task.id, {
    agentProfileId: profileId, prompt: 'do work', presetId: preset.id,
  });

  // Tier 2 wiring forwarded to streamJsonEngine
  assert.equal(sje.spawned.length, 1);
  const opts = sje.spawned[0].opts;
  assert.equal(opts.isolated, true, 'isolated forwarded');
  assert.equal(opts.pluginDirs.length, 1);
  assert.ok(opts.pluginDirs[0].endsWith('/agent-olympus-mock'),
    `pluginDirs[0] resolves under fixture root, got ${opts.pluginDirs[0]}`);
  assert.ok(opts.settingsPath, 'apiKeyHelper settings path forwarded');
  assert.equal(typeof opts.onCleanup, 'function');
  assert.ok(opts.systemPrompt && opts.systemPrompt.startsWith('You are an agent-olympus worker.'));

  // Snapshot persisted with namespaced file paths
  const snap = presetService.getSnapshotForRun(run.id);
  assert.ok(snap, 'snapshot row exists');
  const filePaths = (snap.file_hashes || []).map(f => f.path);
  assert.ok(filePaths.includes('agent-olympus-mock/plugin.json'),
    'plugin.json captured under <pluginRef>/ namespace');
  assert.ok(filePaths.some(p => p.startsWith('agent-olympus-mock/skills/')),
    'skills/ files captured');
  assert.ok(filePaths.some(p => p.startsWith('agent-olympus-mock/commands/')),
    'commands/ files captured');

  // Run row carries preset_id + snapshot hash for forensic queries
  const persistedRun = rs.getRun(run.id);
  assert.equal(persistedRun.preset_id, preset.id);
  assert.equal(persistedRun.preset_snapshot_hash, snap.preset_snapshot_hash);
});
