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

test('createMcpTemplateService: list returns seeded defaults + newly created templates', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db); // seeds playwright + filesystem
  const svc = createMcpTemplateService(db);

  const seeded = svc.listTemplates();
  const aliases = seeded.map((t) => t.alias).sort();
  assert.ok(aliases.includes('playwright'));
  assert.ok(aliases.includes('filesystem'));

  const created = await svc.createTemplate({
    alias: 'graphify',
    command: 'npx',
    args: ['-y', '@graphify/mcp'],
    allowed_env_keys: ['GRAPHIFY_ROOT'],
    description: 'Graphify knowledge graph MCP',
  });
  assert.ok(created.id.startsWith('tpl_'));
  assert.equal(created.alias, 'graphify');
  assert.equal(created.transport, 'stdio', 'transport defaults to stdio');
  assert.equal(created.command, 'npx');
  assert.equal(JSON.parse(created.args)[0], '-y');
  assert.ok(created.updated_at);

  const listAfter = svc.listTemplates();
  assert.equal(listAfter.length, seeded.length + 1);
});

test('createMcpTemplateService: duplicate alias rejected with 409', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  // playwright is already seeded
  await assert.rejects(
    () => svc.createTemplate({ alias: 'playwright', command: 'npx' }),
    (err) => err.status === 409 && /already exists/.test(err.message),
  );
});

test('createMcpTemplateService: invalid alias rejected with 400', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({ alias: 'has spaces', command: 'echo' }),
    (err) => err.status === 400 && /alias must match/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({ alias: 'has.dots', command: 'echo' }),
    (err) => err.status === 400,
  );
  await assert.rejects(
    () => svc.createTemplate({ alias: '', command: 'echo' }),
    (err) => err.status === 400,
  );
});

test('createMcpTemplateService: env denylist pre-rejects forbidden keys', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const forbidden = ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'SOME_SECRET', 'API_KEY'];
  for (const bad of forbidden) {
    await assert.rejects(
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

test('createMcpTemplateService: command rejects surrounding whitespace', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({ alias: 'ws_lead', command: ' bash' }),
    (err) => err.status === 400 && /whitespace/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({ alias: 'ws_trail', command: 'bash ' }),
    (err) => err.status === 400 && /whitespace/.test(err.message),
  );
  // Inner whitespace is fine (commands with multi-word paths do not pass
  // through this field; they would pass through args).
  const ok = await svc.createTemplate({ alias: 'ok_cmd', command: 'bash' });
  assert.equal(ok.command, 'bash');
});

test('createMcpTemplateService: args JSON validation + size cap', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  // Non-string entries rejected
  await assert.rejects(
    () => svc.createTemplate({ alias: 'bad_args', command: 'echo', args: ['-y', 42] }),
    (err) => err.status === 400 && /args entries must be strings/.test(err.message),
  );
  // Non-array rejected
  await assert.rejects(
    () => svc.createTemplate({ alias: 'bad_args2', command: 'echo', args: 'not an array' }),
    (err) => err.status === 400,
  );
  // Over 4KB rejected
  const huge = new Array(500).fill('x'.repeat(20));
  await assert.rejects(
    () => svc.createTemplate({ alias: 'huge_args', command: 'echo', args: huge }),
    (err) => err.status === 400 && /exceeds 4096/.test(err.message),
  );
});

test('updateTemplate: alias immutable — explicit rename rejected, same-alias no-op accepted', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = await svc.createTemplate({ alias: 'keep_this', command: 'echo' });

  // Explicit different alias — rejected
  await assert.rejects(
    () => svc.updateTemplate(tpl.id, { alias: 'renamed', command: 'echo' }),
    (err) => err.status === 400 && /alias is immutable/.test(err.message),
  );

  // Same alias echoed back — accepted (UIs often echo current value)
  const updated = await svc.updateTemplate(tpl.id, { alias: 'keep_this', command: 'bash' });
  assert.equal(updated.alias, 'keep_this');
  assert.equal(updated.command, 'bash');
});

test('updateTemplate: no-op PATCH (identical values) does NOT bump updated_at', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = await svc.createTemplate({
    alias: 'noop_check',
    command: 'echo',
    args: ['-y'],
    allowed_env_keys: ['FOO'],
    description: 'desc',
  });
  const before = tpl.updated_at;
  await new Promise((r) => setTimeout(r, 1100));

  // Echo exact same values — content is identical so updated_at must hold.
  const updated = await svc.updateTemplate(tpl.id, {
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

  const tpl = await svc.createTemplate({ alias: 'bump_check', command: 'echo' });
  const before = tpl.updated_at;
  // datetime('now') SQLite precision is 1s — wait enough to observe the bump
  await new Promise((r) => setTimeout(r, 1100));

  const updated = await svc.updateTemplate(tpl.id, { command: 'bash' });
  assert.equal(updated.id, tpl.id);
  assert.equal(updated.alias, 'bump_check');
  assert.notEqual(updated.updated_at, before);
});

test('deleteTemplate: refuses when referenced by preset', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);
  const pluginsRoot = setupPluginsRoot(t);
  const presetSvc = createPresetService(db, { pluginsRoot });

  const tpl = await mcpSvc.createTemplate({ alias: 'ref_by_preset', command: 'echo' });
  presetSvc.createPreset({
    name: 'uses-tpl',
    plugin_refs: ['sample'],
    mcp_server_ids: [tpl.id],
  });

  // Re-throw to inspect details — assert.throws with predicate doesn't
  // return the error in node:test, so we use a try/catch.
  try {
    mcpSvc.deleteTemplate(tpl.id);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.ok(e.details.presets.some((p) => p.name === 'uses-tpl'));
    assert.equal(e.details.skillPacks.length, 0);
  }
});

test('deleteTemplate: refuses when referenced by skill pack (by alias)', async (t) => {
  const db = setupDb(t);
  const packSvc = createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);

  const tpl = await mcpSvc.createTemplate({
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

test('deleteTemplate: allows delete after references removed', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const mcpSvc = createMcpTemplateService(db);
  const pluginsRoot = setupPluginsRoot(t);
  const presetSvc = createPresetService(db, { pluginsRoot });

  const tpl = await mcpSvc.createTemplate({ alias: 'removable', command: 'echo' });
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

// ─── M4-a: HTTP transport branch ───

test('M4-a: createTemplate transport=http requires url, accepts bearer_token_env_var', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = await svc.createTemplate({
    alias: 'bifrost-default',
    transport: 'http',
    url: 'http://localhost:3100/mcp?profile=default',
    bearer_token_env_var: 'BIFROST_MCP_TOKEN',
    description: 'Bifrost default profile',
  });
  assert.equal(tpl.transport, 'http');
  assert.equal(tpl.url, 'http://localhost:3100/mcp?profile=default');
  assert.equal(tpl.bearer_token_env_var, 'BIFROST_MCP_TOKEN');
  assert.equal(tpl.command, null);
  assert.equal(tpl.args, null);
  assert.equal(tpl.allowed_env_keys, null);
});

test('M4-a: createTemplate transport=http rejects stdio-only fields', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({
      alias: 'http_with_command', transport: 'http',
      url: 'http://localhost:3100/mcp', command: 'npx',
    }),
    (err) => err.status === 400 && /command is only valid for stdio/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'http_with_args', transport: 'http',
      url: 'http://localhost:3100/mcp', args: ['-y'],
    }),
    (err) => err.status === 400 && /args is only valid for stdio/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'http_with_env', transport: 'http',
      url: 'http://localhost:3100/mcp', allowed_env_keys: ['FOO'],
    }),
    (err) => err.status === 400 && /allowed_env_keys is only valid for stdio/.test(err.message),
  );
});

test('M4-a: createTemplate transport=stdio rejects http-only fields', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({
      alias: 'stdio_with_url', command: 'npx', url: 'http://localhost:3100/mcp',
    }),
    (err) => err.status === 400 && /url is only valid for http/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'stdio_with_bearer', command: 'npx', bearer_token_env_var: 'X',
    }),
    (err) => err.status === 400 && /bearer_token_env_var is only valid for http/.test(err.message),
  );
});

test('M4-a: createTemplate transport=http rejects private-IP url (SSRF)', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({
      alias: 'rfc1918', transport: 'http', url: 'http://10.0.0.1/mcp',
    }),
    (err) => err.status === 400 && /SSRF policy/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'metadata', transport: 'http', url: 'http://169.254.169.254/mcp',
    }),
    (err) => err.status === 400 && /SSRF policy/.test(err.message),
  );
});

test('M4-a: createTemplate transport=http rejects invalid scheme / fragment', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({
      alias: 'file_scheme', transport: 'http', url: 'file:///tmp/mcp',
    }),
    (err) => err.status === 400 && /scheme/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'frag', transport: 'http', url: 'http://localhost:3100/mcp#section',
    }),
    (err) => err.status === 400 && /fragment/.test(err.message),
  );
});

test('M4-a: createTemplate transport=http rejects denylisted bearer_token_env_var', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  await assert.rejects(
    () => svc.createTemplate({
      alias: 'denied_bearer', transport: 'http',
      url: 'http://localhost:3100/mcp', bearer_token_env_var: 'NODE_OPTIONS',
    }),
    (err) => err.status === 400 && /globally-denied/.test(err.message),
  );
  await assert.rejects(
    () => svc.createTemplate({
      alias: 'malformed_bearer', transport: 'http',
      url: 'http://localhost:3100/mcp', bearer_token_env_var: '1BAD',
    }),
    (err) => err.status === 400 && /POSIX env var name/.test(err.message),
  );
});

test('M4-a: updateTemplate transport immutable', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const tpl = await svc.createTemplate({ alias: 'transport_lock', command: 'echo' });
  await assert.rejects(
    () => svc.updateTemplate(tpl.id, { transport: 'http', url: 'http://localhost:3100/mcp' }),
    (err) => err.status === 400 && /transport is immutable/.test(err.message),
  );
  // Same transport echo OK
  const updated = await svc.updateTemplate(tpl.id, { transport: 'stdio', command: 'bash' });
  assert.equal(updated.transport, 'stdio');
  assert.equal(updated.command, 'bash');
});

test('M4-a: DB triggers ABORT on direct stdio→http mutation (last line of defense)', (t) => {
  const db = setupDb(t);
  createSkillPackService(db);

  // Direct INSERT + UPDATE bypassing the service. Trigger MUST refuse.
  db.prepare(`
    INSERT INTO mcp_server_templates (id, alias, transport, command, updated_at)
    VALUES ('tpl_raw1', 'raw_stdio', 'stdio', 'echo', datetime('now'))
  `).run();

  // Mutating transport via raw SQL is rejected by the immutability trigger.
  assert.throws(() => {
    db.prepare(`UPDATE mcp_server_templates SET transport='http', url='http://localhost:3100/mcp', command=NULL WHERE id='tpl_raw1'`).run();
  }, /transport is immutable/);

  // Direct INSERT of an http row WITHOUT a url is rejected (column-shape).
  assert.throws(() => {
    db.prepare(`
      INSERT INTO mcp_server_templates (id, alias, transport, updated_at)
      VALUES ('tpl_raw2', 'raw_http_bad', 'http', datetime('now'))
    `).run();
  }, /http template requires non-empty url/);

  // Direct INSERT of a stdio row WITH url is rejected.
  assert.throws(() => {
    db.prepare(`
      INSERT INTO mcp_server_templates (id, alias, transport, command, url, updated_at)
      VALUES ('tpl_raw3', 'raw_stdio_with_url', 'stdio', 'echo', 'http://x', datetime('now'))
    `).run();
  }, /stdio template must not have url/);
});

test('M4-a: migration 022 backfills existing rows as transport=stdio', (t) => {
  const db = setupDb(t);
  createSkillPackService(db); // seeds playwright + filesystem (stdio)
  const rows = db.prepare(`SELECT alias, transport FROM mcp_server_templates ORDER BY alias`).all();
  for (const r of rows) {
    assert.equal(r.transport, 'stdio', `${r.alias} should default to stdio`);
  }
});

test('M4-a: http template URL stored verbatim (canonical form preserved)', async (t) => {
  const db = setupDb(t);
  createSkillPackService(db);
  const svc = createMcpTemplateService(db);

  const cases = [
    'http://localhost:3100/mcp',
    'http://localhost:3100/mcp?profile=read-only',
    'http://127.0.0.1:3100/mcp?team=eng',
  ];
  for (const url of cases) {
    const tpl = await svc.createTemplate({
      alias: `tpl_${url.length}`.replace(/[^a-z0-9_]/gi, '_').slice(0, 30),
      transport: 'http', url,
    });
    assert.equal(tpl.url, url, `url ${url} preserved`);
  }
});
