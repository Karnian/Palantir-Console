const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMcpTemplateService } = require('../services/mcpTemplateService');
const { createSkillPackService } = require('../services/skillPackService');
const { createPresetService } = require('../services/presetService');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupDb(t) {
  const dbDir = mkTempDir('palantir-mcp-tpl-');
  const dbPath = path.join(dbDir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dbDir, { recursive: true, force: true });
  });
  return db;
}

function setupPluginsRoot(t) {
  const dir = mkTempDir('palantir-mcp-tpl-plugins-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'sample'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample', 'plugin.json'), '{"name":"sample","version":"0.1.0"}');
  return dir;
}

test('createMcpTemplateService: list returns seeded defaults + newly created templates', (t) => {
  const db = setupDb(t);
  createSkillPackService(db); // seeds playwright + filesystem
  const svc = createMcpTemplateService(db);

  const seeded = svc.listTemplates();
  const aliases = seeded.map((t) => t.alias).sort();
  assert.ok(aliases.includes('playwright'));
  assert.ok(aliases.includes('filesystem'));

  const created = svc.createTemplate({
    alias: 'graphify',
    command: 'npx',
    args: ['-y', '@graphify/mcp'],
    allowed_env_keys: ['GRAPHIFY_ROOT'],
    description: 'Graphify knowledge graph MCP',
  });
  assert.ok(created.id.startsWith('tpl_'));
  assert.equal(created.alias, 'graphify');
  assert.equal(created.command, 'npx');
  assert.equal(JSON.parse(created.args)[0], '-y');
  assert.ok(created.updated_at);

  const listAfter = svc.listTemplates();
  assert.equal(listAfter.length, seeded.length + 1);
});

test('createMcpTemplateService: duplicate alias rejected with 409', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  // playwright is already seeded
  assert.throws(
    () => svc.createTemplate({ alias: 'playwright', command: 'npx' }),
    (err) => err.status === 409 && /already exists/.test(err.message),
  );
});

test('createMcpTemplateService: invalid alias rejected with 400', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  assert.throws(
    () => svc.createTemplate({ alias: 'has spaces', command: 'echo' }),
    (err) => err.status === 400 && /alias must match/.test(err.message),
  );
  assert.throws(
    () => svc.createTemplate({ alias: 'has.dots', command: 'echo' }),
    (err) => err.status === 400,
  );
  assert.throws(
    () => svc.createTemplate({ alias: '', command: 'echo' }),
    (err) => err.status === 400,
  );
});

test('createMcpTemplateService: env denylist pre-rejects forbidden keys', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const forbidden = ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'SOME_SECRET', 'API_KEY'];
  for (const bad of forbidden) {
    assert.throws(
      () => svc.createTemplate({
        alias: 'test_' + bad.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        command: 'echo',
        allowed_env_keys: [bad],
      }),
      (err) => err.status === 400 && /globally-denied key/.test(err.message),
      `should reject ${bad}`,
    );
  }
});

test('createMcpTemplateService: command rejects surrounding whitespace', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  assert.throws(
    () => svc.createTemplate({ alias: 'ws_lead', command: ' bash' }),
    (err) => err.status === 400 && /whitespace/.test(err.message),
  );
  assert.throws(
    () => svc.createTemplate({ alias: 'ws_trail', command: 'bash ' }),
    (err) => err.status === 400 && /whitespace/.test(err.message),
  );
  // Inner whitespace is fine (commands with multi-word paths do not pass
  // through this field; they would pass through args).
  const ok = svc.createTemplate({ alias: 'ok_cmd', command: 'bash' });
  assert.equal(ok.command, 'bash');
});

test('createMcpTemplateService: args JSON validation + size cap', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  // Non-string entries rejected
  assert.throws(
    () => svc.createTemplate({ alias: 'bad_args', command: 'echo', args: ['-y', 42] }),
    (err) => err.status === 400 && /args entries must be strings/.test(err.message),
  );
  // Non-array rejected
  assert.throws(
    () => svc.createTemplate({ alias: 'bad_args2', command: 'echo', args: 'not an array' }),
    (err) => err.status === 400,
  );
  // Over 4KB rejected
  const huge = new Array(500).fill('x'.repeat(20));
  assert.throws(
    () => svc.createTemplate({ alias: 'huge_args', command: 'echo', args: huge }),
    (err) => err.status === 400 && /exceeds 4096/.test(err.message),
  );
});

test('updateTemplate: alias immutable — explicit rename rejected, same-alias no-op accepted', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = svc.createTemplate({ alias: 'keep_this', command: 'echo' });

  // Explicit different alias — rejected
  assert.throws(
    () => svc.updateTemplate(tpl.id, { alias: 'renamed', command: 'echo' }),
    (err) => err.status === 400 && /alias is immutable/.test(err.message),
  );

  // Same alias echoed back — accepted (UIs often echo current value)
  const updated = svc.updateTemplate(tpl.id, { alias: 'keep_this', command: 'bash' });
  assert.equal(updated.alias, 'keep_this');
  assert.equal(updated.command, 'bash');
});

test('updateTemplate: no-op PATCH (identical values) does NOT bump updated_at', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = svc.createTemplate({
    alias: 'noop_check',
    command: 'echo',
    args: ['-y'],
    allowed_env_keys: ['FOO'],
    description: 'desc',
  });
  const before = tpl.updated_at;
  await new Promise((r) => setTimeout(r, 1100));

  // Echo exact same values — content is identical so updated_at must hold.
  const updated = svc.updateTemplate(tpl.id, {
    command: 'echo',
    args: ['-y'],
    allowed_env_keys: ['FOO'],
    description: 'desc',
  });
  assert.equal(updated.updated_at, before, 'updated_at must not move on no-op PATCH');
});

test('updateTemplate: bumps updated_at, leaves alias/id unchanged', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = svc.createTemplate({ alias: 'bump_check', command: 'echo' });
  const before = tpl.updated_at;
  // datetime('now') SQLite precision is 1s — wait enough to observe the bump
  await new Promise((r) => setTimeout(r, 1100));

  const updated = svc.updateTemplate(tpl.id, { command: 'bash' });
  assert.equal(updated.id, tpl.id);
  assert.equal(updated.alias, 'bump_check');
  assert.notEqual(updated.updated_at, before);
});

test('deleteTemplate: refuses when referenced by preset', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);
  const pluginsRoot = setupPluginsRoot(t);
  const presetSvc = createPresetService(db, { pluginsRoot });

  const tpl = mcpSvc.createTemplate({ alias: 'ref_by_preset', command: 'echo' });
  presetSvc.createPreset({
    name: 'uses-tpl',
    plugin_refs: ['sample'],
    mcp_server_ids: [tpl.id],
  });

  const err = t.assert.throws(
    () => mcpSvc.deleteTemplate(tpl.id),
    (e) => e.status === 409,
  );
  // Details should include the referencing preset name so UI can surface it.
  // Re-throw to inspect details (t.assert.throws does not return the error in
  // node:test; use assert.throws with predicate instead).
  try {
    mcpSvc.deleteTemplate(tpl.id);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.ok(e.details.presets.some((p) => p.name === 'uses-tpl'));
    assert.equal(e.details.skillPacks.length, 0);
  }
});

test('deleteTemplate: refuses when referenced by skill pack (by alias)', (t) => {
  const db = setupDb(t);
  const packSvc = createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);

  const tpl = mcpSvc.createTemplate({
    alias: 'ref_by_pack',
    command: 'echo',
    allowed_env_keys: ['FOO'],
  });
  packSvc.createSkillPack({
    name: 'uses-alias',
    scope: 'global',
    mcp_servers: { [tpl.alias]: { env_overrides: { FOO: 'bar' } } },
  });

  try {
    mcpSvc.deleteTemplate(tpl.id);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.equal(e.details.presets.length, 0);
    assert.ok(e.details.skillPacks.some((p) => p.name === 'uses-alias'));
  }
});

test('deleteTemplate: allows delete after references removed', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);
  const pluginsRoot = setupPluginsRoot(t);
  const presetSvc = createPresetService(db, { pluginsRoot });

  const tpl = mcpSvc.createTemplate({ alias: 'removable', command: 'echo' });
  const preset = presetSvc.createPreset({
    name: 'temp',
    plugin_refs: ['sample'],
    mcp_server_ids: [tpl.id],
  });

  // Remove reference first
  presetSvc.updatePreset(preset.id, { mcp_server_ids: [] });

  const res = mcpSvc.deleteTemplate(tpl.id);
  assert.equal(res.status, 'ok');
  assert.throws(() => mcpSvc.getTemplate(tpl.id), (e) => e.status === 404);
});

test('seed upsert: preserves updated_at across boots when content unchanged', (t) => {
  const db = setupDb(t);
  createSkillPackService(db); // first seed
  const svc = createMcpTemplateService(db);
  const first = svc.listTemplates().find((t) => t.alias === 'playwright');
  assert.ok(first.updated_at);

  // Simulate a second server boot — re-seeding with identical data
  createSkillPackService(db);
  const second = svc.listTemplates().find((t) => t.alias === 'playwright');
  assert.equal(second.updated_at, first.updated_at);
});
