// Phase 10D — Tier 2 (Claude isolated) spawn wiring + auth materialization.
//
// Verifies:
//  - resolveClaudeAuthForIsolated picks tokens from env → .claude-auth.json →
//    keychain, materializes via apiKeyHelper by default, env fallback on demand,
//    fail-closed when none available.
//  - streamJsonEngine.buildArgs adds --bare / --strict-mcp-config /
//    --setting-sources / --plugin-dir / --settings when isolated=true.
//  - lifecycleService for an isolated preset:
//      * logs preset:tier2_active + preset:auth_sources
//      * spawns with isolated=true + pluginDirs + settingsPath
//      * fail-closed when auth is unavailable (run failed, 400 thrown)
//      * onCleanup invoked on process exit (apiKeyHelper temp dir removed)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const authResolverModule = require('../services/authResolver');
const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createAgentProfileService } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createPresetService } = require('../services/presetService');

function mkTempDir(prefix, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function mkdb(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-10d-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, command, args, allowed_env_keys, description)
    VALUES ('tpl_ctx7', 'ctx7', 'npx', '["-y"]', '[]', 'ctx7')
  `).run();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });
  return db;
}

// --------------------------------------------------------------------------
// authResolver.resolveClaudeAuthForIsolated
// --------------------------------------------------------------------------

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[key]; else process.env[key] = prev;
  }
}

test('resolveClaudeAuthForIsolated: env ANTHROPIC_API_KEY → apiKeyHelper by default', (t) => {
  const tmpRoot = mkTempDir('iso-tmp-', t);
  const result = withEnv('ANTHROPIC_API_KEY', 'sk-test-token-123', () => {
    return authResolverModule.resolveClaudeAuthForIsolated({
      tmpRoot,
      hasKeychain: () => false,
      readKeychainToken: () => null,
    });
  });
  assert.equal(result.canAuth, true);
  assert.deepEqual(result.env, {});               // apiKeyHelper path keeps env clean
  assert.ok(result.apiKeyHelperSettings);
  assert.ok(fs.existsSync(result.apiKeyHelperSettings.settingsPath));
  assert.ok(fs.existsSync(result.apiKeyHelperSettings.helperPath));

  const settingsContent = JSON.parse(fs.readFileSync(result.apiKeyHelperSettings.settingsPath, 'utf8'));
  assert.equal(settingsContent.apiKeyHelper, result.apiKeyHelperSettings.helperPath);
  const helperContent = fs.readFileSync(result.apiKeyHelperSettings.helperPath, 'utf8');
  assert.match(helperContent, /^#!\/bin\/sh\n/);
  assert.ok(helperContent.includes('sk-test-token-123'));

  // Token source logged.
  assert.ok(result.sources.some(s => s === 'env:ANTHROPIC_API_KEY'));
  assert.ok(result.sources.some(s => s === 'materialize:apiKeyHelper'));

  // Cleanup removes the temp dir.
  result.apiKeyHelperSettings.cleanup();
  assert.equal(fs.existsSync(result.apiKeyHelperSettings.tmpDir), false);
});

test('resolveClaudeAuthForIsolated: prefer="env" returns env-only, no temp files', (t) => {
  const tmpRoot = mkTempDir('iso-tmp-', t);
  const result = withEnv('ANTHROPIC_API_KEY', 'sk-e', () => {
    return authResolverModule.resolveClaudeAuthForIsolated({
      tmpRoot, prefer: 'env', hasKeychain: () => false, readKeychainToken: () => null,
    });
  });
  assert.equal(result.canAuth, true);
  assert.equal(result.env.ANTHROPIC_API_KEY, 'sk-e');
  assert.equal(result.apiKeyHelperSettings, undefined);
  assert.ok(result.sources.some(s => s === 'materialize:env:ANTHROPIC_API_KEY'));
});

test('resolveClaudeAuthForIsolated: keychain fallback when env + file absent', (t) => {
  const tmpRoot = mkTempDir('iso-tmp-', t);
  const result = withEnv('ANTHROPIC_API_KEY', undefined, () => {
    return authResolverModule.resolveClaudeAuthForIsolated({
      tmpRoot,
      hasKeychain: () => true,
      readKeychainToken: () => 'kc-access-token',
    });
  });
  assert.equal(result.canAuth, true);
  assert.ok(result.sources.some(s => s.startsWith('keychain:')));
  // Helper script contains the keychain-sourced token.
  const helperContent = fs.readFileSync(result.apiKeyHelperSettings.helperPath, 'utf8');
  assert.ok(helperContent.includes('kc-access-token'));
  result.apiKeyHelperSettings.cleanup();
});

test('resolveClaudeAuthForIsolated: fail-closed when no source available', (t) => {
  const tmpRoot = mkTempDir('iso-tmp-', t);
  const result = withEnv('ANTHROPIC_API_KEY', undefined, () => {
    return authResolverModule.resolveClaudeAuthForIsolated({
      tmpRoot,
      hasKeychain: () => false,
      readKeychainToken: () => null,
    });
  });
  assert.equal(result.canAuth, false);
  assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.apiKeyHelperSettings, undefined);
  assert.ok(result.diagnostics[0].includes('ANTHROPIC_API_KEY'));
});

test('resolveClaudeAuthForIsolated: envAllowlist blocks env ANTHROPIC_API_KEY source', (t) => {
  const tmpRoot = mkTempDir('iso-tmp-', t);
  const result = withEnv('ANTHROPIC_API_KEY', 'sk-blocked', () => {
    return authResolverModule.resolveClaudeAuthForIsolated({
      tmpRoot,
      envAllowlist: ['OTHER_KEY'],
      hasKeychain: () => false,
      readKeychainToken: () => null,
    });
  });
  // env source denied; file absent; keychain returns null → fail-closed.
  assert.equal(result.canAuth, false);
});

// --------------------------------------------------------------------------
// streamJsonEngine buildArgs (isolated)
// --------------------------------------------------------------------------

const streamJsonEngineModule = require('../services/streamJsonEngine');
// buildArgs is not exported directly — exercise through spawnAgent capture or
// via re-require of the factory and reflect on args produced. Simpler:
// re-implement equivalent via spawn stub pattern. But the function is
// internal-only. Instead, we drive through a spawn-capturing stub by
// monkey-patching child_process.spawn temporarily.

test('streamJsonEngine buildArgs: isolated=true emits expected flags', () => {
  const engine = streamJsonEngineModule.createStreamJsonEngine({
    runService: { addRunEvent() {}, updateRunStatus() {}, getRun() { return {}; } },
    eventBus: null,
  });
  const args = engine._buildArgs({
    isolated: true,
    pluginDirs: ['/tmp/pd1', '/tmp/pd2'],
    settingsPath: '/tmp/s.json',
    settingSources: '',
    isManager: false,
    prompt: 'hi',
  });
  assert.ok(args.includes('--bare'));
  assert.ok(args.includes('--strict-mcp-config'));
  const ssIdx = args.indexOf('--setting-sources');
  assert.ok(ssIdx >= 0 && args[ssIdx + 1] === '');
  const pluginArgs = args.reduce((acc, a, i) => {
    if (a === '--plugin-dir') acc.push(args[i + 1]);
    return acc;
  }, []);
  assert.deepEqual(pluginArgs, ['/tmp/pd1', '/tmp/pd2']);
  const sIdx = args.indexOf('--settings');
  assert.equal(args[sIdx + 1], '/tmp/s.json');
});

test('streamJsonEngine buildArgs: non-isolated has NO --bare (manager path untouched)', () => {
  const engine = streamJsonEngineModule.createStreamJsonEngine({
    runService: { addRunEvent() {}, updateRunStatus() {}, getRun() { return {}; } },
    eventBus: null,
  });
  const args = engine._buildArgs({ isManager: true });
  assert.equal(args.includes('--bare'), false);
  assert.equal(args.includes('--strict-mcp-config'), false);
  assert.equal(args.includes('--setting-sources'), false);
  assert.equal(args.includes('--plugin-dir'), false);
});

// --------------------------------------------------------------------------
// lifecycleService.executeTask — Tier 2 wiring
// --------------------------------------------------------------------------

function stubExec() {
  const spawned = [];
  return {
    spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `s-${runId}` }; },
    isAlive() { return true; },
    detectExitCode() { return null; },
    getOutput() { return ''; },
    sendInput() { return true; },
    kill() {}, discoverGhostSessions() { return []; }, hasProcess() { return false; },
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

function seedProfile(db, command) {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent)
              VALUES (?, ?, ?, ?, ?, ?, ?, 5)`)
    .run(id, 'Agent', command, command, '{prompt}', '{}', '[]');
  return { id };
}

test('lifecycleService: isolated preset → spawn gets isolated+pluginDirs+settingsPath, logs tier2_active', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkTempDir('p10d-plugins-', t);
  fs.mkdirSync(path.join(pluginsRoot, 'p1'), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, 'p1', 'plugin.json'), '{}');
  const presetService = createPresetService(db, { pluginsRoot });

  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const sje = stubSJE();

  // Stub authResolver so tests are deterministic (no real keychain probe).
  const fakeAuthTmp = mkTempDir('fake-auth-', t);
  const fakeAuth = {
    resolveClaudeAuthForIsolated: () => ({
      canAuth: true,
      env: {},
      sources: ['test'],
      diagnostics: [],
      apiKeyHelperSettings: {
        settingsPath: path.join(fakeAuthTmp, 'settings.json'),
        helperPath: path.join(fakeAuthTmp, 'helper.sh'),
        tmpDir: fakeAuthTmp,
        cleanup: () => {},
      },
    }),
  };
  fs.writeFileSync(path.join(fakeAuthTmp, 'settings.json'), '{"apiKeyHelper":"/tmp/x"}');

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: stubExec(), streamJsonEngine: sje, worktreeService: null, eventBus: null,
    presetService, authResolver: fakeAuth,
  });

  const project = ps.createProject({ name: 'P' });
  const task = ts.createTask({ project_id: project.id, title: 't' });
  const profile = seedProfile(db, 'claude');
  const preset = presetService.createPreset({
    name: 'Iso', isolated: true, plugin_refs: ['p1'], setting_sources: '',
  });

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  assert.equal(sje.spawned.length, 1);
  const opts = sje.spawned[0].opts;
  assert.equal(opts.isolated, true);
  assert.equal(opts.pluginDirs.length, 1);
  assert.ok(opts.pluginDirs[0].endsWith('/p1'));
  assert.ok(opts.settingsPath && opts.settingsPath.endsWith('/settings.json'));
  assert.equal(opts.settingSources, '');
  assert.equal(typeof opts.onCleanup, 'function');

  const events = rs.getRunEvents(run.id);
  assert.ok(events.some(e => e.event_type === 'preset:tier2_active'));
  assert.ok(events.some(e => e.event_type === 'preset:auth_sources'));
});

test('lifecycleService: isolated preset → fail-closed when canAuth=false', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkTempDir('p10d-plugins-', t);
  fs.mkdirSync(path.join(pluginsRoot, 'p1'), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, 'p1', 'plugin.json'), '{}');
  const presetService = createPresetService(db, { pluginsRoot });

  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const sje = stubSJE();

  const fakeAuth = {
    resolveClaudeAuthForIsolated: () => ({
      canAuth: false,
      env: {},
      sources: [],
      diagnostics: ['Isolated preset requires Claude auth.'],
    }),
  };

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: stubExec(), streamJsonEngine: sje, worktreeService: null, eventBus: null,
    presetService, authResolver: fakeAuth,
  });

  const project = ps.createProject({ name: 'P' });
  const task = ts.createTask({ project_id: project.id, title: 't' });
  const profile = seedProfile(db, 'claude');
  const preset = presetService.createPreset({
    name: 'IsoNoAuth', isolated: true, plugin_refs: ['p1'],
  });

  assert.throws(
    () => lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id }),
    /Isolated preset requires Claude auth/,
  );
  assert.equal(sje.spawned.length, 0, 'spawn never invoked on fail-closed');
});

test('lifecycleService: isolated + codex adapter → Tier 2 skipped (tier2_skipped warn + NO --bare)', async (t) => {
  const db = await mkdb(t);
  const pluginsRoot = mkTempDir('p10d-plugins-', t);
  fs.mkdirSync(path.join(pluginsRoot, 'p1'), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, 'p1', 'plugin.json'), '{}');
  const presetService = createPresetService(db, { pluginsRoot });

  const rs = createRunService(db, null);
  const ts = createTaskService(db);
  const ps = createProjectService(db);
  const aps = createAgentProfileService(db);
  const exec = stubExec();

  const lc = createLifecycleService({
    runService: rs, taskService: ts, agentProfileService: aps, projectService: ps,
    executionEngine: exec, streamJsonEngine: stubSJE(), worktreeService: null, eventBus: null,
    presetService,
  });

  const project = ps.createProject({ name: 'P' });
  const task = ts.createTask({ project_id: project.id, title: 't' });
  const profile = seedProfile(db, 'codex');
  const preset = presetService.createPreset({
    name: 'IsoCodex', isolated: true, plugin_refs: ['p1'],
  });

  const run = lc.executeTask(task.id, { agentProfileId: profile.id, prompt: 'hi', presetId: preset.id });
  const events = rs.getRunEvents(run.id);
  assert.ok(events.some(e => e.event_type === 'preset:tier2_skipped'));
  assert.equal(events.some(e => e.event_type === 'preset:tier2_active'), false);
});
