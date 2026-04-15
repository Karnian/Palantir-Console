const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const {
  createPresetService,
  mergeMcp3,
  resolvePromptChain,
  compareSemver,
  MAX_PROMPT_BYTES,
} = require('../services/presetService');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupPluginsRoot(t) {
  const dir = mkTempDir('palantir-plugins-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePluginFixture(pluginsRoot, name, files = { 'plugin.json': '{}' }) {
  const absDir = path.join(pluginsRoot, name);
  fs.mkdirSync(absDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const absFile = path.join(absDir, rel);
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
    fs.writeFileSync(absFile, content);
  }
  return absDir;
}

function setupDb(t) {
  const dbDir = mkTempDir('palantir-db-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  // Seed the MCP templates (same logic skillPackService uses on boot).
  // We only need enough to satisfy mcp_server_ids validation.
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, command, args, allowed_env_keys, description)
    VALUES (@id, @alias, @command, @args, @allowed_env_keys, @description)
  `).run({
    id: 'tpl_test', alias: 'test', command: 'echo', args: JSON.stringify(['hi']),
    allowed_env_keys: '[]', description: 'test',
  });
  return db;
}

test('presetService: CRUD happy path', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'sample', { 'plugin.json': '{"name":"sample","version":"0.1.0"}' });
  const svc = createPresetService(db, { pluginsRoot });

  const created = svc.createPreset({
    name: 'My Preset',
    description: 'desc',
    plugin_refs: ['sample'],
    mcp_server_ids: ['tpl_test'],
    base_system_prompt: 'Hello.',
    isolated: true,
    min_claude_version: '2.0.0',
  });
  assert.ok(created.id.startsWith('wp_'));
  assert.equal(created.name, 'My Preset');
  assert.equal(created.isolated, true);
  assert.deepEqual(created.plugin_refs, ['sample']);
  assert.deepEqual(created.mcp_server_ids, ['tpl_test']);

  const list = svc.listPresets();
  assert.equal(list.length, 1);

  const got = svc.getPreset(created.id);
  assert.equal(got.name, 'My Preset');

  const updated = svc.updatePreset(created.id, { description: 'updated', isolated: false });
  assert.equal(updated.description, 'updated');
  assert.equal(updated.isolated, false);
  assert.deepEqual(updated.plugin_refs, ['sample']);

  svc.deletePreset(created.id);
  assert.throws(() => svc.getPreset(created.id), /not found/i);
});

test('presetService: name uniqueness', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  svc.createPreset({ name: 'unique' });
  assert.throws(() => svc.createPreset({ name: 'unique' }), /already exists/i);
});

test('presetService: unknown plugin_ref rejected', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  assert.throws(
    () => svc.createPreset({ name: 'bad', plugin_refs: ['nonexistent'] }),
    /Unknown plugin ref: 'nonexistent'/,
  );
});

test('presetService: plugin_ref path escape rejected', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  for (const bad of ['../etc', 'a/b', '..', '.']) {
    assert.throws(
      () => svc.createPreset({ name: 'x', plugin_refs: [bad] }),
      /bare directory name/,
    );
  }
});

test('presetService: unknown mcp_server_id rejected', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  assert.throws(
    () => svc.createPreset({ name: 'bad', mcp_server_ids: ['tpl_nope'] }),
    /Unknown mcp_server_id/,
  );
});

test('presetService: base_system_prompt byte limit enforced', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  const tooLong = 'a'.repeat(MAX_PROMPT_BYTES + 1);
  assert.throws(
    () => svc.createPreset({ name: 'big', base_system_prompt: tooLong }),
    /exceeds/,
  );
});

test('presetService: min_claude_version semver validation', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  assert.throws(() => svc.createPreset({ name: 'v', min_claude_version: 'not-semver' }), /semver/);
  svc.createPreset({ name: 'v', min_claude_version: '1.2.3' });
});

test('presetService: delete cascades task.preferred_preset_id → NULL', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  const preset = svc.createPreset({ name: 'cascade' });

  // Minimal task row. Tasks table is created by migrations; use raw SQL to insert.
  db.prepare(`
    INSERT INTO tasks (id, title, status, preferred_preset_id)
    VALUES ('t_cascade', 'test', 'todo', ?)
  `).run(preset.id);

  svc.deletePreset(preset.id);
  const row = db.prepare('SELECT preferred_preset_id FROM tasks WHERE id = ?').get('t_cascade');
  assert.equal(row.preferred_preset_id, null);
});

test('presetService: listPluginRefs returns plugin.json-bearing dirs', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'p1', { 'plugin.json': '{"description":"p one","version":"1.0.0"}' });
  writePluginFixture(pluginsRoot, 'p2', { 'plugin.json': '{}' });
  fs.mkdirSync(path.join(pluginsRoot, 'not-a-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginsRoot, 'not-a-plugin', 'readme.md'), 'x');
  const svc = createPresetService(db, { pluginsRoot });
  const { plugin_refs: refs, warnings } = svc.listPluginRefs();
  assert.deepEqual(refs.map(r => r.name), ['p1', 'p2']);
  assert.equal(refs[0].description, 'p one');
  assert.equal(refs[0].version, '1.0.0');
  assert.deepEqual(warnings, []);
});

test('presetService: listPluginRefs on missing pluginsRoot returns []', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = path.join(os.tmpdir(), 'palantir-never-exists-' + Date.now());
  const svc = createPresetService(db, { pluginsRoot });
  const result = svc.listPluginRefs();
  assert.deepEqual(result.plugin_refs, []);
  assert.deepEqual(result.warnings, []);
});

test('buildSnapshot: path namespacing + stable hash', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'a', {
    'plugin.json': '{"name":"a"}',
    'skills/one.md': 'hello',
  });
  writePluginFixture(pluginsRoot, 'b', {
    'plugin.json': '{"name":"b"}',
  });
  const svc = createPresetService(db, { pluginsRoot });
  const preset = svc.createPreset({ name: 'snap', plugin_refs: ['a', 'b'] });

  const snap1 = svc.buildSnapshot(preset);
  assert.ok(snap1.hash.length === 64);
  const paths = snap1.fileHashes.map(f => f.path);
  assert.ok(paths.includes('a/plugin.json'));
  assert.ok(paths.includes('a/skills/one.md'));
  assert.ok(paths.includes('b/plugin.json'));
  // sorted
  for (let i = 1; i < paths.length; i++) {
    assert.ok(paths[i - 1].localeCompare(paths[i]) <= 0);
  }

  // Second call on unchanged files → identical hash (cache hit path).
  const snap2 = svc.buildSnapshot(preset);
  assert.equal(snap2.hash, snap1.hash);

  // Modify a file → hash changes
  fs.writeFileSync(path.join(pluginsRoot, 'a', 'skills/one.md'), 'world');
  // Force mtime advance (some filesystems have coarse mtime resolution)
  const st = fs.statSync(path.join(pluginsRoot, 'a', 'skills/one.md'));
  fs.utimesSync(path.join(pluginsRoot, 'a', 'skills/one.md'), st.atime, new Date(Date.now() + 2000));

  const snap3 = svc.buildSnapshot(preset);
  assert.notEqual(snap3.hash, snap1.hash);
});

test('buildSnapshot rejects missing plugin', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'gone');
  const svc = createPresetService(db, { pluginsRoot });
  const preset = svc.createPreset({ name: 's', plugin_refs: ['gone'] });
  fs.rmSync(path.join(pluginsRoot, 'gone'), { recursive: true, force: true });
  assert.throws(() => svc.buildSnapshot(preset), /no longer available/);
});

test('mergeMcp3: precedence preset > project > skillPack', () => {
  const preset = { mcpServers: { a: { command: 'preset' }, shared: { command: 'preset' } } };
  const project = { mcpServers: { b: { command: 'project' }, shared: { command: 'project' } } };
  const skill = { mcpServers: { c: { command: 'skill' }, shared: { command: 'skill' } } };
  const warnings = [];
  const merged = mergeMcp3(preset, project, skill, { warnings });
  assert.equal(merged.mcpServers.a.command, 'preset');
  assert.equal(merged.mcpServers.b.command, 'project');
  assert.equal(merged.mcpServers.c.command, 'skill');
  assert.equal(merged.mcpServers.shared.command, 'preset');
  const shared = warnings.filter(w => w.type === 'mcp:alias_conflict' && w.alias === 'shared');
  // At least one conflict emitted (skill→project, project→preset overwrites)
  assert.ok(shared.length >= 1);
  assert.equal(shared[shared.length - 1].winner, 'preset');
});

test('mergeMcp3: all null → null', () => {
  assert.equal(mergeMcp3(null, null, null, { warnings: [] }), null);
});

test('resolvePromptChain: order + separator + empty drop', () => {
  const s = resolvePromptChain({
    presetPrompt: 'PRESET',
    skillPackSections: ['one', { text: 'two' }, '', null],
    adapterFooter: 'FOOT',
  });
  assert.equal(s, ['PRESET', 'one', 'two', 'FOOT'].join('\n\n---\n\n'));
});

test('resolvePromptChain: supports { string } alias and throws on unknown shape', () => {
  const ok = resolvePromptChain({
    presetPrompt: 'P',
    skillPackSections: [{ string: 'S1' }, { text: 'S2' }],
    adapterFooter: 'F',
  });
  assert.equal(ok, ['P', 'S1', 'S2', 'F'].join('\n\n---\n\n'));

  assert.throws(
    () => resolvePromptChain({ skillPackSections: [{ body: 'oops' }] }),
    /unsupported section shape/,
  );
  assert.throws(
    () => resolvePromptChain({ skillPackSections: [42] }),
    /unsupported section type/,
  );
});

test('resolvePromptChain: empty inputs → ""', () => {
  assert.equal(resolvePromptChain({}), '');
  assert.equal(resolvePromptChain({ presetPrompt: '', skillPackSections: [], adapterFooter: '' }), '');
});

test('compareSemver: basic ordering', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('2.0.0-rc1', '2.0.0'), 0); // pre-release stripped for gate
});

test('resolveForSpawn: Tier 1 + Tier 2 gating per adapter', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'fx', { 'plugin.json': '{}' });
  const svc = createPresetService(db, { pluginsRoot });

  const preset = svc.createPreset({
    name: 'spawn',
    isolated: true,
    plugin_refs: ['fx'],
    mcp_server_ids: ['tpl_test'],
    base_system_prompt: 'SYS',
  });

  const asClaude = svc.resolveForSpawn({ presetId: preset.id, adapter: 'claude' });
  assert.equal(asClaude.isolated, true);
  assert.equal(asClaude.pluginDirs.length, 1);
  assert.ok(asClaude.pluginDirs[0].endsWith('/fx'));
  assert.ok(asClaude.mcpConfig.mcpServers.test);
  assert.equal(asClaude.systemPrompt, 'SYS');
  assert.ok(asClaude.snapshot && asClaude.snapshot.hash);

  const asCodex = svc.resolveForSpawn({ presetId: preset.id, adapter: 'codex' });
  assert.equal(asCodex.isolated, false); // Tier 2 skipped
  assert.equal(asCodex.pluginDirs.length, 0);
  assert.ok(asCodex.mcpConfig.mcpServers.test); // Tier 1 still applied
  const skip = asCodex.warnings.find(w => w.type === 'preset:tier2_skipped');
  assert.ok(skip);
  assert.equal(skip.adapter, 'codex');
});

test('resolveForSpawn: missing preset throws', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  const svc = createPresetService(db, { pluginsRoot });
  assert.throws(() => svc.resolveForSpawn({ presetId: 'wp_nope', adapter: 'claude' }), /not found/);
});

test('persistSnapshot + getSnapshotForRun roundtrip', async (t) => {
  const db = setupDb(t);
  const pluginsRoot = setupPluginsRoot(t);
  writePluginFixture(pluginsRoot, 'rs', { 'plugin.json': '{}' });
  const svc = createPresetService(db, { pluginsRoot });
  const preset = svc.createPreset({ name: 'rs', plugin_refs: ['rs'] });
  // Minimal run row (runs has many columns — rely on migrations setting sane defaults)
  db.prepare(`INSERT INTO runs (id, status) VALUES ('r_test', 'running')`).run();
  const snap = svc.buildSnapshot(preset);
  svc.persistSnapshot('r_test', preset, snap);
  const out = svc.getSnapshotForRun('r_test');
  assert.ok(out);
  assert.equal(out.preset_snapshot_hash, snap.hash);
  assert.equal(out.preset_id, preset.id);
  assert.ok(Array.isArray(out.file_hashes));
});
