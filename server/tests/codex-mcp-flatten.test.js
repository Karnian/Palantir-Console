// M1: flattenMcpToCodexArgs — unit coverage for the JSON → TOML leaf-level
// dotted path util shared by lifecycleService (worker) and codexAdapter (PM).

const test = require('node:test');
const assert = require('node:assert/strict');

const { flattenMcpToCodexArgs } = require('../services/managerAdapters/codexMcpFlatten');

test('empty / missing input returns []', () => {
  assert.deepEqual(flattenMcpToCodexArgs(null), []);
  assert.deepEqual(flattenMcpToCodexArgs(undefined), []);
  assert.deepEqual(flattenMcpToCodexArgs({}), []);
  assert.deepEqual(flattenMcpToCodexArgs({ mcpServers: {} }), []);
  assert.deepEqual(flattenMcpToCodexArgs({ mcpServers: null }), []);
  assert.deepEqual(flattenMcpToCodexArgs({ mcpServers: undefined }), []);
});

test('fail-closed on malformed root shape (mcp non-object, mcpServers non-map)', () => {
  assert.throws(() => flattenMcpToCodexArgs('bad'), /mcp must be a plain object/);
  assert.throws(() => flattenMcpToCodexArgs(42), /mcp must be a plain object/);
  assert.throws(() => flattenMcpToCodexArgs([]), /mcp must be a plain object/);
  // Non-plain objects (Map, Date, class instances) must not slip through
  // via `typeof x === 'object'` since Object.entries returns [] for them.
  assert.throws(() => flattenMcpToCodexArgs(new Map()), /mcp must be a plain object/);
  assert.throws(() => flattenMcpToCodexArgs(new Date()), /mcp must be a plain object/);
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: 'bad' }),
    /mcpServers must be a plain object map/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: 42 }),
    /mcpServers must be a plain object map/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: [] }),
    /mcpServers must be a plain object map/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: new Map() }),
    /mcpServers must be a plain object map/,
  );
});

test('fail-closed on alias cfg that would emit zero args (declared server vanishing)', () => {
  // Empty cfg object
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: {} } }),
    /alias "svc" produced zero args/,
  );
  // All leaves null/undefined
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: undefined, args: null } } }),
    /alias "svc" produced zero args/,
  );
  // All nested leaves null/undefined — empty inline-table collapses to null,
  // alias emit count ends at 0. Covers the R4 silent-vanish regression.
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { env: { TOKEN: undefined } } } }),
    /alias "svc" produced zero args/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({
      mcpServers: { svc: { env: { TOKEN: undefined, OTHER: null } } },
    }),
    /alias "svc" produced zero args/,
  );
});

test('fail-closed on malformed env container type (env must be plain object)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: 'bad' } } }),
    /env under svc must be a plain object/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: [] } } }),
    /env under svc must be a plain object/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: 42 } } }),
    /env under svc must be a plain object/,
  );
  // null / undefined env are OK — "env absent" semantic
  assert.deepEqual(
    flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: null } } }),
    ['-c', 'mcp_servers.svc.command="x"'],
  );
});

test('empty env object drops the leaf but keeps other keys (alias does not vanish)', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { command: 'x', env: {} } },
  });
  const cflags = args.filter((_, i) => i % 2 === 1);
  // env={} is collapsed to null, command stays — alias still emits 1 arg
  assert.equal(cflags.length, 1);
  assert.equal(cflags[0], 'mcp_servers.svc.command="x"');
});

test('fail-closed on malformed alias cfg (null, string, array, non-plain-object)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: null } }),
    /alias "svc" has null\/undefined cfg/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: 'bad' } }),
    /alias "svc" cfg must be a plain object/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: [1, 2] } }),
    /alias "svc" cfg must be a plain object/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: new Date() } }),
    /alias "svc" cfg must be a plain object/,
  );
});

test('encodes string / number / bool leaves as TOML literals', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: {
      svc: {
        command: 'npx',
        port: 4177,
        enabled: true,
        flag: false,
      },
    },
  });
  // Interleaved -c, value, -c, value, ...
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  assert.ok(pairs.every(([k]) => k === '-c'));
  const values = pairs.map(([, v]) => v);
  assert.ok(values.includes('mcp_servers.svc.command="npx"'));
  assert.ok(values.includes('mcp_servers.svc.port=4177'));
  assert.ok(values.includes('mcp_servers.svc.enabled=true'));
  assert.ok(values.includes('mcp_servers.svc.flag=false'));
});

test('encodes arrays as TOML arrays (homogeneous string list)', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { args: ['-y', '@ctx7/mcp'] } },
  });
  const v = args[args.indexOf('-c') + 1];
  assert.equal(v, 'mcp_servers.svc.args=["-y","@ctx7/mcp"]');
});

test('encodes nested object (env) as inline table', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { env: { KEY: 'val', TOKEN_VAR: 'TOK' } } },
  });
  const cflags = args.filter((_, i) => i % 2 === 1);
  const envFlag = cflags.find(c => c.startsWith('mcp_servers.svc.env='));
  assert.ok(envFlag, 'env flag emitted');
  assert.ok(envFlag.includes('KEY="val"'));
  assert.ok(envFlag.includes('TOKEN_VAR="TOK"'));
  // Inline-table braces
  assert.ok(/^mcp_servers\.svc\.env=\{.*\}$/.test(envFlag));
});

test('rejects invalid alias (dots, shell metas)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { 'bad.alias': { command: 'x' } } }),
    /invalid alias/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { 'bad alias': { command: 'x' } } }),
    /invalid alias/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { 'bad;alias': { command: 'x' } } }),
    /invalid alias/,
  );
});

test('rejects invalid top-level key', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { 'bad key': 'v' } } }),
    /invalid key under svc/,
  );
});

test('rejects invalid env key', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { env: { 'bad key': 'v' } } } }),
    /invalid env key under svc/,
  );
});

test('rejects non-string env values (env is map<string,string>)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: { PORT: 4177 } } } }),
    /env value for svc\.env\.PORT must be a string/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { command: 'x', env: { CFG: { nested: 'x' } } } } }),
    /env value for svc\.env\.CFG must be a string/,
  );
  // null / undefined env entries are dropped; env entry collapses to null
  // when all inner leaves vanish — if that leaves zero args on the alias,
  // fail-closed kicks in at the alias level.
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { env: { X: null, Y: undefined } } } }),
    /alias "svc" produced zero args/,
  );
});

test('rejects direct bearer_token value (must use bearer_token_env_var)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { bearer_token: 'secret' } } }),
    /bearer_token/,
  );
  // bearer_token_env_var is allowed (names an env var, not the secret itself)
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { bearer_token_env_var: 'NOTION_TOKEN' } },
  });
  const v = args[args.indexOf('-c') + 1];
  assert.equal(v, 'mcp_servers.svc.bearer_token_env_var="NOTION_TOKEN"');
});

test('drops null / undefined leaves silently', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { command: 'x', nothing: null, alsoNothing: undefined } },
  });
  const cflags = args.filter((_, i) => i % 2 === 1);
  assert.equal(cflags.length, 1);
  assert.equal(cflags[0], 'mcp_servers.svc.command="x"');
});

test('throws on non-finite numbers (NaN / Infinity) — no silent drop', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { a: NaN } } }),
    /non-finite number at svc\.a/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { b: Infinity } } }),
    /non-finite number at svc\.b/,
  );
});

test('throws on unsupported value types (bigint, function, symbol, non-plain-object leaf)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { a: 10n } } }),
    /unsupported value type "bigint" at svc\.a/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { a: () => 0 } } }),
    /unsupported value type "function" at svc\.a/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { a: Symbol('x') } } }),
    /unsupported value type "symbol" at svc\.a/,
  );
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { a: new Date() } } }),
    /unsupported value type "non-plain-object" at svc\.a/,
  );
});

test('throws on null/undefined inside arrays (no holes allowed)', () => {
  assert.throws(
    () => flattenMcpToCodexArgs({ mcpServers: { svc: { args: ['ok', null] } } }),
    /null\/undefined array element at svc\.args\[1\]/,
  );
});

test('escapes double quotes in strings', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { command: 'say "hi"' } },
  });
  const v = args[args.indexOf('-c') + 1];
  // JSON.stringify → backslash-escaped double quotes, which is valid TOML too.
  assert.equal(v, 'mcp_servers.svc.command="say \\"hi\\""');
});

test('does NOT emit top-level mcp_servers=<JSON> blob (regression guard)', () => {
  const args = flattenMcpToCodexArgs({
    mcpServers: { svc: { command: 'x' } },
  });
  const cflags = args.filter((_, i) => i % 2 === 1);
  // Leaf-level only — the old broken form must never reappear.
  assert.ok(!cflags.some(c => /^mcp_servers=/.test(c)));
  assert.ok(cflags.every(c => /^mcp_servers\./.test(c)));
});
