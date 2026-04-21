// M2: codexUserConfigScan — unit coverage for legacy alias detection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  extractAliasesFromToml,
  scanCodexUserConfigAliases,
  detectLegacyAliasConflicts,
} = require('../services/managerAdapters/codexUserConfigScan');

// --- extractAliasesFromToml ---

test('extract: table-header form [mcp_servers.<alias>]', () => {
  const toml = `
[mcp_servers.ctx7]
command = "npx"
args = ["-y", "@ctx7/mcp"]

[mcp_servers.notion]
bearer_token_env_var = "NOTION_TOKEN"
`;
  assert.deepEqual(extractAliasesFromToml(toml), ['ctx7', 'notion']);
});

test('extract: dotted-key form mcp_servers.<alias>.<key> = …', () => {
  const toml = `
mcp_servers.slack.command = "slack-mcp"
mcp_servers.slack.args = []
mcp_servers.github.url = "https://example.com/mcp"
`;
  assert.deepEqual(extractAliasesFromToml(toml), ['slack', 'github']);
});

test('extract: ignores comments and blank lines', () => {
  const toml = `
# [mcp_servers.fake] — inside comment
#mcp_servers.fake.command = "nope"

[mcp_servers.real]
command = "x"  # trailing comment
`;
  assert.deepEqual(extractAliasesFromToml(toml), ['real']);
});

test('extract: empty / non-string input returns []', () => {
  assert.deepEqual(extractAliasesFromToml(''), []);
  assert.deepEqual(extractAliasesFromToml(null), []);
  assert.deepEqual(extractAliasesFromToml(undefined), []);
  assert.deepEqual(extractAliasesFromToml(42), []);
});

test('extract: quoted-key forms — [mcp_servers."ctx7"] and mcp_servers."ctx7".command', () => {
  const toml = `
[mcp_servers."quoted-alias"]
command = "x"

mcp_servers."dotted-quoted".command = "y"

[ mcp_servers.whitespace-ok ]
command = "z"
`;
  const aliases = extractAliasesFromToml(toml);
  assert.ok(aliases.includes('quoted-alias'));
  assert.ok(aliases.includes('dotted-quoted'));
  assert.ok(aliases.includes('whitespace-ok'));
});

test('extract: deduplicates repeated aliases', () => {
  const toml = `
[mcp_servers.ctx7]
command = "npx"
mcp_servers.ctx7.args = ["-y"]
`;
  assert.deepEqual(extractAliasesFromToml(toml), ['ctx7']);
});

// --- scanCodexUserConfigAliases ---

test('scan: missing file returns [] (no conflict detected)', () => {
  const nonExistent = path.join(os.tmpdir(), `palantir-m2-${Date.now()}-nope.toml`);
  assert.deepEqual(scanCodexUserConfigAliases(nonExistent), []);
});

test('scan: reads explicit path', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-m2-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, '[mcp_servers.ctx7]\ncommand = "npx"\n');
  assert.deepEqual(scanCodexUserConfigAliases(p), ['ctx7']);
});

// --- detectLegacyAliasConflicts ---

test('detect: no conflict when merged is empty or null', () => {
  assert.deepEqual(detectLegacyAliasConflicts(null, ['ctx7']), []);
  assert.deepEqual(detectLegacyAliasConflicts({}, ['ctx7']), []);
  assert.deepEqual(detectLegacyAliasConflicts({ mcpServers: {} }, ['ctx7']), []);
});

test('detect: no conflict when userAliases is empty', () => {
  const merged = { mcpServers: { ctx7: { command: 'x' } } };
  assert.deepEqual(detectLegacyAliasConflicts(merged, []), []);
  assert.deepEqual(detectLegacyAliasConflicts(merged, null), []);
});

test('detect: single conflict with resolver source', () => {
  const merged = { mcpServers: { ctx7: { command: 'x' } } };
  const out = detectLegacyAliasConflicts(merged, ['ctx7'], {
    perAliasSource: () => 'preset',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].alias, 'ctx7');
  assert.equal(out[0].source, 'preset');
  assert.match(out[0].message, /alias "ctx7".*preset.*config\.toml/);
});

test('detect: payload shape is fixed ({alias, source, message}) — low cardinality per M2 review', () => {
  const merged = { mcpServers: { ctx7: { command: 'x' }, slack: { command: 'y' } } };
  const out = detectLegacyAliasConflicts(merged, ['ctx7', 'slack'], {
    perAliasSource: (a) => (a === 'ctx7' ? 'preset' : 'skillpack'),
  });
  assert.equal(out.length, 2);
  for (const entry of out) {
    assert.deepEqual(Object.keys(entry).sort(), ['alias', 'message', 'source']);
    assert.equal(typeof entry.alias, 'string');
    assert.equal(typeof entry.source, 'string');
    assert.equal(typeof entry.message, 'string');
  }
});

test('detect: resolver default is "unknown" when omitted', () => {
  const merged = { mcpServers: { ctx7: { command: 'x' } } };
  const out = detectLegacyAliasConflicts(merged, ['ctx7']);
  assert.equal(out[0].source, 'unknown');
});

test('detect: message uses resolved configPath instead of a hard-coded ~/.codex/config.toml', () => {
  const merged = { mcpServers: { ctx7: {} } };
  const out = detectLegacyAliasConflicts(merged, ['ctx7'], {
    perAliasSource: () => 'preset',
    configPath: '/custom/path/config.toml',
  });
  assert.match(out[0].message, /\/custom\/path\/config\.toml/);
  assert.doesNotMatch(out[0].message, /~\/\.codex\/config\.toml/);
});

test('detect: only conflicting aliases are reported (no false positives)', () => {
  const merged = { mcpServers: { ctx7: { command: 'x' }, fresh: { command: 'y' } } };
  const out = detectLegacyAliasConflicts(merged, ['ctx7', 'unrelated'], {
    perAliasSource: () => 'preset',
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].alias, 'ctx7');
});
