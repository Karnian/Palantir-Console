'use strict';

const readline = require('node:readline');
const http = require('node:http');
const ID = '^[A-Za-z0-9:_-]{1,128}$';
const instruction = '^(claude|codex):[A-Za-z0-9_-]{1,64}:[uin][A-Za-z0-9_-]{1,64}$';
const string = (pattern, maxLength = 200) => ({
  type: 'string', minLength: 1, maxLength, ...(pattern ? { pattern } : {}),
});
const filters = {
  machine: string(ID, 128), provider: { type: 'string', enum: ['claude', 'codex'] },
  cursor: string('^[0-9a-f]{16}\\.(0|[1-9][0-9]*)$', 100),
};
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = [
  { name: 'list_sessions', description: 'List snapshot sessions', inputSchema: schema({
    ...filters, limit: { type: 'integer', minimum: 1, maximum: 30 },
  }) },
  { name: 'search_instructions', description: 'Search past instructions', inputSchema: schema({
    q: string(), ...filters, limit: { type: 'integer', minimum: 1, maximum: 15 },
  }, ['q']) },
  { name: 'search_assistant_history', description: 'Search active assistant conversation', inputSchema: schema({
    q: string(), limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['q']) },
  { name: 'propose_memory', description: 'Propose memory for human approval', inputSchema: schema({
    content: string(null, 500), kind: { type: 'string', enum: ['preference', 'fact', 'person', 'project', 'other'] },
    reason: string(null, 300),
  }, ['content', 'kind', 'reason']) },
  { name: 'propose_forget', description: 'Propose archiving memory for human approval', inputSchema: schema({
    memory_id: string(ID, 128), reason: string(null, 300),
  }, ['memory_id', 'reason']) },
  { name: 'get_session', description: 'Read a snapshot session timeline', inputSchema: schema({
    key: string(ID, 128),
    rev: string('^[0-9a-f]{16}$', 16), around: string(instruction, 140),
  }, ['key']) },
];

function valid(args, spec) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (spec.required.some(key => !Object.hasOwn(args, key))) return false;
  for (const [key, value] of Object.entries(args)) {
    const rule = spec.properties[key];
    if (!rule || typeof value !== (rule.type === 'integer' ? 'number' : rule.type)) return false;
    if (rule.type === 'integer' && (!Number.isSafeInteger(value)
      || value < rule.minimum || value > rule.maximum)) return false;
    if (rule.type === 'string' && ([...value].length < (rule.minLength || 0)
      || [...value].length > (rule.maxLength || Infinity))) return false;
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
    if (rule.enum && !rule.enum.includes(value)) return false;
  }
  if (args.cursor && !Number.isSafeInteger(Number(args.cursor.split('.')[1]))) return false;
  return !args.around || !!args.rev;
}

function brokerGet(name, args, env) {
  if (name === 'propose_memory' || name === 'propose_forget') return brokerPost(name, args, env);
  const base = new URL(env.PALANTIR_SESSION_HUB_BASE_URL);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/') {
    throw new Error('invalid_base_url');
  }
  const endpoint = name === 'get_session' ? `sessions/${encodeURIComponent(args.key)}`
    : name === 'search_assistant_history' ? 'history/search'
      : name === 'search_instructions' ? 'search' : 'sessions';
  const url = new URL(`/api/session-hub/${endpoint}`, base);
  for (const [key, value] of Object.entries(args)) if (key !== 'key') url.searchParams.set(key, String(value));
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Authorization: `Bearer ${env.PALANTIR_SESSION_HUB_TOKEN}` } }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) res.destroy(new Error('broker_response_too_large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), isError: res.statusCode >= 400 }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('broker_timeout')));
    req.on('error', reject);
  });
}

function brokerPost(name, args, env) {
  const base = new URL(env.PALANTIR_SESSION_HUB_BASE_URL);
  if (base.protocol !== 'http:' || base.username || base.password || base.pathname !== '/') {
    throw new Error('invalid_base_url');
  }
  const url = new URL('/api/session-hub/memory/proposals', base);
  const body = JSON.stringify({ ...args, operation: name === 'propose_forget' ? 'forget' : 'add' });
  if (Buffer.byteLength(body) > 4096) throw new Error('invalid_query');
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: {
      Authorization: `Bearer ${env.PALANTIR_SESSION_HUB_TOKEN}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } }, res => {
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 65536) res.destroy(new Error('broker_response_too_large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), isError: res.statusCode >= 400 }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('broker_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function dispatch(message, { env = process.env, get = brokerGet } = {}) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (!Object.hasOwn(message, 'id')) return null;
  const response = { jsonrpc: '2.0', id: message.id };
  if (message.method === 'initialize') {
    response.result = { protocolVersion: message.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'session_hub', version: '1.0.0' } };
  } else if (message.method === 'tools/list') response.result = { tools: TOOLS };
  else if (message.method === 'tools/call') {
    const tool = TOOLS.find(row => row.name === message.params?.name);
    const args = Object.hasOwn(message.params || {}, 'arguments') ? message.params.arguments : {};
    let result;
    if (!tool || !valid(args, tool.inputSchema)) result = { text: '{"error":"invalid_query"}', isError: true };
    else {
      try { result = await get(tool.name, args, env); }
      catch { result = { text: '{"error":"snapshot_unavailable"}', isError: true }; }
    }
    response.result = { content: [{ type: 'text', text: result.text }], isError: result.isError };
  } else response.error = { code: -32601, message: 'Method not found' };
  return response;
}

function runStdio(options = {}) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  input.on('line', line => {
    queue = queue.then(async () => {
      let response;
      try { response = await dispatch(JSON.parse(line), options); }
      catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  return input;
}
if (require.main === module) runStdio();
module.exports = { TOOLS, valid, dispatch, brokerGet, runStdio };
