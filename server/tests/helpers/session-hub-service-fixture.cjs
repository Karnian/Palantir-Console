'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createSessionHubService } = require('../../services/sessionHubService');
const Database = require('better-sqlite3');
const { createAssistantStore } = require('../../services/assistantStore');
const binary = path.resolve(__dirname, '../fixtures/bin/fake-claude-session-hub.js');

function fakeNet() {
  return { createServer(handler) {
    const server = new EventEmitter();
    server.listen = (filename, callback) => { fs.writeFileSync(filename, '', { mode: 0o600 }); callback(); };
    server.close = callback => callback();
    server.connect = handler;
    return server;
  } };
}
function serviceFixture(t, overrides = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-service-')));
  const home = path.join(temp, 'home');
  const root = path.join(home, '.palantir/session-hub');
  fs.mkdirSync(home, { mode: 0o700 });
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../db/migrations/096_assistant_threads.sql'), 'utf8'));
  db.exec(fs.readFileSync(path.resolve(__dirname, '../../db/migrations/098_assistant_request_receipts.sql'), 'utf8'));
  const store = createAssistantStore(db);
  const calls = [];
  const signals = [];
  const children = [];
  const options = { store, root, home, tmpDir: temp, managedPaths: [], net: fakeNet(), baseUrl: 'http://127.0.0.1:3000',
    env: { PATH: process.env.PATH, HOME: home, USER: 'fixture', LANG: 'en_US.UTF-8', TMPDIR: temp,
      PALANTIR_TOKEN: 'human', PALANTIR_PM_TOKEN: 'pm', PALANTIR_MANAGER_TOKEN: 'manager', SERVER_SECRET: 'secret' },
    resolveAuth: () => ({ env: { ANTHROPIC_API_KEY: 'auth', PALANTIR_TOKEN: 'smuggled' } }),
    resolveBinary: () => ({ path: binary, executable: true }), termMs: 10, reapMs: 100, pollMs: 2,
    kill(pid, signal) {
      signals.push([pid, signal]);
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
    spawn(command, argv, opts) {
      calls.push({ command, argv, options: opts });
      const child = new EventEmitter();
      child.pid = 8000 + children.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      children.push(child);
      return child;
    }, ...overrides };
  const service = createSessionHubService(options);
  t.after(async () => {
    await service.shutdown().catch(() => {});
    await fsp.rm(temp, { recursive: true, force: true });
  });
  const event = value => children.at(-1).stdout.write(`${JSON.stringify(value)}\n`);
  function init(session_id = 'owned') {
    event({ type: 'system', subtype: 'init', session_id,
      memory_paths: { auto: `${service.diagnostics().transcriptDir}/memory/` } });
  }
  return { service, db, store, temp, home, root, options, calls, signals, children, event, init };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check, timeout = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('fixture wait timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
module.exports = { serviceFixture, fakeNet, binary, tick, until };
