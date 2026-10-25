'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { isClaudeOAuthTokenValue } = require('../services/authResolver');
function hostEnvironment(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) =>
    !key.startsWith('PALANTIR_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN' &&
    !(key === 'ANTHROPIC_API_KEY' && isClaudeOAuthTokenValue(value))));
}
function createClient({ runtimeDir, timeoutMs = 2000 }) {
  let socket;
  let bootId;
  let bootChanged = false;
  let connected = false;
  let nextId = 0;
  let connecting;
  const pending = new Map();
  const uncertain = new Map();
  function remember(metadata, result) {
    const key = metadata.request_key;
    if (result.found === false || Object.hasOwn(result, 'session_deleted') || Object.hasOwn(result, 'expires_at')) {
      uncertain.delete(key);
      return;
    }
    const kind = result.kind || metadata.kind;
    const previous = metadata.lastState || {};
    // Keep only correlation and state facts, never a request or a returned row containing a body.
    const lastState = {
      id: result.id ?? previous.id,
      state: result.state ?? previous.state,
      outcome: Object.hasOwn(result, 'outcome') ? result.outcome : previous.outcome
    };
    const control = ['start', 'resume', 'close', 'stop', 'handoff', 'delete'].includes(kind);
    const unfinished = control ? lastState.state === 'accepted' : kind === 'prompt' ?
      lastState.outcome == null && !['rejected', 'cancelled', 'expired'].includes(lastState.state) :
      ['queued', 'sending', 'written', 'provider_observed'].includes(lastState.state);
    if (unfinished) uncertain.set(key, { request_key: key, kind, lastState });
    else uncertain.delete(key);
  }
  function rememberUnknown(metadata) {
    if (!uncertain.has(metadata.request_key)) {
      uncertain.set(metadata.request_key, { request_key: metadata.request_key, kind: metadata.kind,
        lastState: { state: 'acceptance_unknown' } });
    }
  }
  function observeEvents(events) {
    for (const event of events || []) {
      if (event.type !== 'transition') continue;
      const change = event.json;
      if (!['deliveries', 'control_requests'].includes(change?.table)) continue;
      for (const metadata of [...uncertain.values()]) {
        const id = change.table === 'control_requests' ? metadata.request_key : metadata.lastState.id;
        if (id !== undefined && id === change.id) remember(metadata, change);
      }
    }
  }
  function request(type, fields) {
    if (!connected) return Promise.reject(new Error('host_disconnected'));
    const id = ++nextId;
    const trackedFields = type === 'submit' ?
      { request: { request_key: fields.request.request_key, kind: fields.request.kind } } : fields;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        if (type === 'submit') rememberUnknown(trackedFields.request);
        reject(new Error(type === 'submit' ? 'acceptance_unknown' : 'request_timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, type, fields: trackedFields });
      socket.write(JSON.stringify({ type, id, ...fields }) + '\n');
    });
  }
  async function connect() {
    if (connected) return api;
    if (connecting) return connecting;
    connecting = (async () => {
      const capability = (await fs.readFile(path.join(runtimeDir, 'capability'), 'utf8')).trim();
      await new Promise((resolve, reject) => {
        let buffer = '';
        let greeted = false;
        const current = net.createConnection(path.join(runtimeDir, 'host.sock'));
        current.setEncoding('utf8');
        socket = current;
        const timer = setTimeout(() => current.destroy(new Error('handshake_timeout')), timeoutMs);
        current.on('connect', () => current.write(JSON.stringify({ type: 'hello', capability }) + '\n'));
        current.on('data', chunk => {
          buffer += chunk.toString();
          if (Buffer.byteLength(buffer) > 16777216) return current.destroy(new Error('response_too_large'));
          let end;
          while ((end = buffer.indexOf('\n')) !== -1) {
            let message;
            try { message = JSON.parse(buffer.slice(0, end)); } catch { return current.destroy(new Error('invalid_response')); }
            buffer = buffer.slice(end + 1);
            if (!greeted) {
              if (message.type !== 'hello') return current.destroy(new Error('invalid_handshake'));
              greeted = true;
              bootChanged = bootId !== undefined && bootId !== message.host_boot_id;
              bootId = message.host_boot_id;
              connected = true;
              clearTimeout(timer);
              resolve();
            } else {
              const entry = pending.get(message.id);
              if (!entry) continue;
              pending.delete(message.id);
              clearTimeout(entry.timer);
              if (['error', 'not_accepted', 'rejected'].includes(message.type)) {
                const unknown = message.type === 'error' && entry.type === 'submit';
                if (unknown) rememberUnknown(entry.fields.request);
                entry.reject(Object.assign(new Error(unknown ? 'acceptance_unknown' : message.code || message.type),
                  { code: message.code || message.type }));
              } else {
                if (entry.type === 'submit') remember(entry.fields.request, message.result);
                if (entry.type === 'lookup' && uncertain.has(entry.fields.request_key)) {
                  remember(uncertain.get(entry.fields.request_key), message.result);
                }
                if (entry.type === 'abandon') {
                  const metadata = uncertain.get(entry.fields.request_key);
                  if (message.result.abandoned) uncertain.delete(entry.fields.request_key);
                  else if (metadata && message.result.existing) remember(metadata, message.result.existing);
                }
                if (entry.type === 'events_since') observeEvents(message.result.events);
                entry.resolve(message.result);
              }
            }
          }
        });
        current.on('error', error => { if (!greeted) reject(error); });
        current.on('close', () => {
          clearTimeout(timer);
          connected = false;
          if (!greeted) reject(new Error('handshake_closed'));
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            if (entry.type === 'submit') rememberUnknown(entry.fields.request);
            entry.reject(new Error(entry.type === 'submit' ? 'acceptance_unknown' : 'host_disconnected'));
          }
          pending.clear();
        });
      });
      return api;
    })();
    try { return await connecting; } finally { connecting = null; }
  }
  const api = {
    connect,
    get hostBootId() { return bootId; },
    get hostBootChanged() { return bootChanged; },
    submit: value => request('submit', { request: value }),
    lookup: request_key => request('lookup', { request_key }),
    abandon: request_key => request('abandon', { request_key }),
    snapshot: session_id => request('snapshot', { session_id }),
    transcript: (session_id, before_seq, limit = 50) => request('transcript', { session_id, before_seq, limit }),
    chunk: (session_id, source, id_or_seq, offset = 0) => request('chunk', { session_id, source, id_or_seq, offset }),
    list: () => request('list', {}),
    settingsPreview: cwd => request('settings_preview', { cwd }),
    eventsSince: (seq, options = {}) => request('events_since', { seq,
      ...(options.maxBytes !== undefined ? { max_bytes: options.maxBytes } : {}) }),
    async reconcile() {
      await connect();
      const results = new Map();
      for (const key of [...uncertain.keys()]) {
        results.set(key, await api.lookup(key));
      }
      return results;
    },
    close() { socket?.destroy(); }
  };
  return api;
}
async function ensureHost({ runtimeDir, entry = path.join(__dirname, 'main.js'), timeoutMs = 5000 }) {
  if (process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS === '1') {
    throw Object.assign(new Error('legacy_credential_mode'), { code: 'legacy_credential_mode' });
  }
  const deadline = Date.now() + timeoutMs;
  let launched = false;
  while (Date.now() < deadline) {
    const client = createClient({ runtimeDir, timeoutMs: Math.max(1, Math.min(250, deadline - Date.now())) });
    try { await client.connect(); return client; } catch { client.close(); }
    if (!launched) {
      const child = spawn(process.execPath, [entry, '--runtime-dir', runtimeDir],
        { detached: true, stdio: 'ignore', env: hostEnvironment() });
      child.on('error', () => {});
      child.unref();
      launched = true;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('host_start_timeout');
}
module.exports = { ensureHost, createClient, hostEnvironment };
