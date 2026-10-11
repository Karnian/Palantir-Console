'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { TOOLS, dispatch, brokerGet } = require('../../scripts/session-hub-mcp.cjs');
const call = (name, args) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('initialize protocol, three schemas, notification and unknown method', async () => {
  const result = await dispatch({ jsonrpc: '2.0', id: 7, method: 'initialize',
    params: { protocolVersion: 'client-version' } });
  assert.equal(result.result.protocolVersion, 'client-version');
  assert.deepEqual(result.result.capabilities, { tools: {} });
  assert.deepEqual(TOOLS.map(row => row.name), ['list_sessions', 'search_instructions', 'get_session']);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual((await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools, TOOLS);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 1, method: 'unknown' })).error.code, -32601);
});

test('invalid tool arguments cause zero HTTP calls including wrong types and unknown properties', async () => {
  let gets = 0;
  const get = () => { gets++; throw new Error('must not call'); };
  for (const [name, args] of [
    ['unknown', {}], ['list_sessions', { machine: '../escape' }], ['list_sessions', { provider: 'other' }],
    ['list_sessions', { limit: 31 }], ['list_sessions', { limit: '1' }], ['list_sessions', { limit: 1.5 }],
    ['list_sessions', { limit: 0 }], ['list_sessions', { cursor: 'bad' }], ['list_sessions', { extra: true }],
    ['list_sessions', []], ['list_sessions', null], ['search_instructions', {}], ['search_instructions', { q: '' }],
    ['search_instructions', { q: 'a'.repeat(201) }], ['search_instructions', { q: 'query', limit: 16 }],
    ['get_session', {}], ['get_session', { key: '../escape' }], ['get_session', { key: 'safe', rev: 'bad' }],
    ['get_session', { key: 'safe', around: 'claude:abc:u1' }],
    ['get_session', { key: 'safe', rev: 'a'.repeat(16), around: 'bad' }],
  ]) {
    const result = await dispatch(call(name, args), { get });
    assert.equal(result.result.isError, true, JSON.stringify([name, args]));
    assert.equal(result.result.content[0].text, '{"error":"invalid_query"}');
  }
  assert.equal(gets, 0);
});

test('valid calls hit broker once and preserve exact JSON bytes and broker errors', async () => {
  const seen = [];
  const get = async (name, args) => { seen.push([name, args]); return { text: '{ "error": "snapshot_changed" }',
    isError: true }; };
  for (const [name, args] of [['list_sessions', { machine: 'mac', provider: 'codex', limit: 30,
    cursor: '0123456789abcdef.30' }], ['search_instructions', { q: '오르카', limit: 15 }],
    ['get_session', { key: 'claude:abc', rev: '0123456789abcdef',
      around: `claude:${'a'.repeat(64)}:u${'b'.repeat(64)}` }]]) {
    const response = await dispatch(call(name, args), { get });
    assert.equal(response.result.content[0].text, '{ "error": "snapshot_changed" }');
    assert.equal(response.result.isError, true);
  }
  assert.equal(seen.length, 3);
});

test('HTTP uses only hub env keys, GET one time, encoded query, no redirect or other credential', async t => {
  const seen = [];
  t.mock.method(http, 'get', (url, options, callback) => {
    seen.push({ url, options });
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
    const res = new PassThrough(); res.statusCode = 403;
    queueMicrotask(() => { callback(res); res.end('{"error":"forbidden"}'); });
    return req;
  });
  const env = { PALANTIR_SESSION_HUB_TOKEN: 'hub-secret', PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:9999',
    PALANTIR_TOKEN: 'human', PALANTIR_PM_TOKEN: 'pm', PALANTIR_MANAGER_TOKEN: 'manager' };
  const result = await brokerGet('search_instructions', { q: '오르카 & x', machine: 'mac' }, env);
  assert.equal(seen.length, 1); assert.equal(result.text, '{"error":"forbidden"}'); assert.equal(result.isError, true);
  assert.equal(seen[0].url.searchParams.get('q'), '오르카 & x');
  assert.deepEqual(seen[0].options.headers, { Authorization: 'Bearer hub-secret' });
  assert.throws(() => brokerGet('list_sessions', {}, { ...env, PALANTIR_SESSION_HUB_BASE_URL: 'https://example.com' }));
  assert.equal(seen.length, 1);
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/session-hub-mcp.cjs'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\('([^']+)'\)/g)].map(row => row[1]), ['node:readline', 'node:http']);
  assert.deepEqual([...new Set(source.match(/env\.PALANTIR_[A-Z_]+/g))].sort(),
    ['env.PALANTIR_SESSION_HUB_BASE_URL', 'env.PALANTIR_SESSION_HUB_TOKEN']);
});

test('stdio script handles newline requests, malformed JSON, initialized notification without HTTP', async () => {
  const script = path.resolve(__dirname, '../../scripts/session-hub-mcp.cjs');
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
  const lines = [];
  readline.createInterface({ input: child.stdout }).on('line', line => lines.push(JSON.parse(line)));
  const exited = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  child.stdin.end('broken\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n'
    + JSON.stringify(call('list_sessions', { limit: 'bad' })) + '\n');
  assert.equal(await exited, 0);
  assert.equal(lines.length, 3); assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].result.tools.length, 3); assert.equal(lines[2].result.isError, true);
});

test('bootstrap tolerates fragmented delivery, spawns once and strips every other env key', () => {
  const vm = require('node:vm');
  const sockets = [];
  const spawned = [];
  const exited = [];
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/session-hub-mcp-bootstrap.cjs'), 'utf8');
  const modules = {
    'node:net': { connect() {
      const socket = new EventEmitter(); socket.setEncoding = () => {};
      socket.write = value => { socket.sent = value; }; socket.end = value => { socket.sent = value; };
      sockets.push(socket); return socket;
    } },
    'node:path': path,
    'node:child_process': {
      execFileSync: () => '500',
      spawn(command, argv, options) {
        spawned.push({ command, argv, options });
        return Object.assign(new EventEmitter(), { pid: 600 });
      },
    },
  };
  vm.runInNewContext(source, { require: name => modules[name], __dirname: '/fixture/scripts',
    process: { pid: 501, argv: ['node', 'bootstrap', '/protected/broker.sock'], execPath: process.execPath,
      exit: value => exited.push(value) } });
  sockets[0].emit('connect');
  const credentials = JSON.stringify({ PALANTIR_SESSION_HUB_TOKEN: 'secret',
    PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:3000', PALANTIR_TOKEN: 'must-drop' }) + '\n';
  sockets[0].emit('data', credentials.slice(0, 10));
  assert.equal(spawned.length, 0);
  sockets[0].emit('data', credentials.slice(10));
  sockets[0].emit('data', credentials);
  assert.equal(spawned.length, 1); assert.equal(exited.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(spawned[0].options.env)), { PALANTIR_SESSION_HUB_TOKEN: 'secret',
    PALANTIR_SESSION_HUB_BASE_URL: 'http://127.0.0.1:3000' });
  assert.equal(spawned[0].options.stdio, 'inherit');
  assert.equal(spawned[0].argv.some(value => value.includes('secret')), false);
  sockets[1].emit('connect');
  assert.deepEqual(JSON.parse(sockets[1].sent), { pid: 600, pgid: 500, kind: 'mcp' });
});
