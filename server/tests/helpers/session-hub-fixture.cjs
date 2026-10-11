'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Duplex } = require('node:stream');
const { createSnapshots } = require('./work-board-fixture.cjs');
const { createApp } = require('../../app');
const { sealObserveState } = require('../../services/observeSnapshotStore');

const TOKEN = 'hub-human-fixture';
const PM = 'hub-pm-fixture';
const COOKIE = `palantir_token=${TOKEN}`;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-')));
  const dir = path.join(root, 'snapshots');
  fs.mkdirSync(dir, { mode: 0o700 });
  const snapshots = createSnapshots(root);
  const apps = [];
  const write = snapshot => fs.writeFileSync(path.join(dir, `${snapshot.machine.id}.json`), JSON.stringify(snapshot));
  write(snapshots.alpha); write(snapshots.beta);
  const state = sealObserveState({ dir, authToken: TOKEN });
  t.after(async () => {
    for (const app of apps) await app.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function app(options = {}) {
    const appRoot = fs.mkdtempSync(path.join(root, 'app-'));
    const previous = process.cwd();
    let result;
    try {
      process.chdir(appRoot);
      result = createApp({ authToken: TOKEN, pmToken: PM, observeSnapshotDir: dir,
        storageRoot: path.join(appRoot, 'storage'), fsRoot: snapshots.homeDir, dbPath: path.join(appRoot, 'db'),
        pluginsRoot: path.join(appRoot, 'plugins'), codexHome: path.join(snapshots.homeDir, '.codex'),
        authResolverOpts: { hasKeychain: () => false }, agentProcessIsolation: true,
        execAttestation: { verified: true, reason: 'test' }, memoryDistillEnabled: false,
        operatorSchedulerEnabled: false, sessionHubActive: true, ...options });
    } finally { process.chdir(previous); }
    apps.push(result);
    return result;
  }
  return { root, dir, state, ...snapshots, write, app };
}

function managerToken(app, layer, conversationId) {
  const run = app.services.runService.createRun({ is_manager: true, manager_layer: layer,
    conversation_id: conversationId, manager_adapter: 'codex', prompt: 'fixture' });
  app.services.runService.updateRunStatus(run.id, 'running', { force: true });
  app.managerRegistry.setActive(conversationId, run.id, {
    isSessionAlive: () => true, detectExitCode: () => null, disposeSession: () => true,
  });
  return app.services.managerCapabilityTokenService.mint(run.id, { layer, conversationId });
}

// Drive createApp's real middleware stack with Node HTTP objects without opening a sandbox port.
function request(app) {
  function method(verb, url) {
    const headers = {};
    let payload;
    const call = {
      set(key, value) { headers[key.toLowerCase()] = value; return call; },
      send(value) {
        payload = typeof value === 'string' ? value : JSON.stringify(value);
        headers['content-type'] ||= 'application/json';
        return call;
      },
      then(resolve, reject) {
        const promise = new Promise((done, fail) => {
          const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { callback(); } });
          socket.remoteAddress = '127.0.0.1';
          const req = new http.IncomingMessage(socket);
          req.method = verb; req.url = url; req.headers = { host: 'localhost', ...headers };
          if (payload !== undefined) req.headers['content-length'] = String(Buffer.byteLength(payload));
          const res = new http.ServerResponse(req);
          const chunks = [];
          res.write = chunk => { chunks.push(Buffer.from(chunk)); return true; };
          res.end = chunk => {
            if (chunk) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString('utf8');
            let body;
            try { body = text ? JSON.parse(text) : {}; } catch { body = text; }
            done({ status: res.statusCode, headers: res.getHeaders(), body, text });
            return res;
          };
          app.handle(req, res, fail);
          if (payload !== undefined) req.push(payload);
          req.push(null);
        });
        return promise.then(resolve, reject);
      },
    };
    return call;
  }
  return Object.fromEntries(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']
    .map(verb => [verb, url => method(verb.toUpperCase(), url)]));
}

module.exports = { fixture, managerToken, request, TOKEN, PM, COOKIE };
