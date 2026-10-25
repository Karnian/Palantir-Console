'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createOwnedSessionService } = require('../services/ownedSessionService');
const { createClient, ensureHost } = require('../sessionHost/launcher');
const { createOwnedSessionsRouter } = require('../routes/ownedSessions');
const { poll, key } = require('./helpers/session-host-process');
const entry = path.join(__dirname, 'helpers/owned-session-host-main.cjs');
for (const history of [false, true]) {
  test('S1-e2 GET snapshot after host crash, history=' + history, { timeout: 20000 }, async t => {
    const dir = fs.mkdtempSync('/private/tmp/owned-read-');
    const children = []; const clients = [];
    let server; let service; let launches = 0;
    t.after(async () => {
      await service?.shutdown();
      for (const client of clients) client.close();
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    async function launch() {
      const child = spawn(process.execPath, [entry, '--runtime-dir', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
      children.push(child); let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      return poll(async () => {
        if (child.exitCode !== null) throw Error(errors || 'host_exited');
        const client = createClient({ runtimeDir: dir, timeoutMs: 100 });
        try { await client.connect(); clients.push(client); return client; } catch { client.close(); return false; }
      }, 5000);
    }
    let id = 'missing';
    if (history) {
      const client = await launch();
      const started = await client.submit({ kind: 'start', request_key: key(), cwd: dir, confirmed_settings: true });
      id = started.session_id;
      await poll(async () => (await client.snapshot(id)).state.incarnations.some(row => row.state === 'alive'));
      const exited = once(children[0], 'exit'); children[0].kill('SIGKILL'); await exited; client.close();
    }
    service = createOwnedSessionService({ runtimeDir: dir, ensureHost: async () => {
      launches++;
      // Launch a tracked process, then exercise the real launcher's handshake path.
      const client = await launch(); client.close();
      return ensureHost({ runtimeDir: dir, entry });
    } });
    const app = express();
    app.use((req, res, next) => { req.auth = { method: 'cookie' }; next(); });
    app.use('/api/owned-sessions', createOwnedSessionsRouter({ service }));
    server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/owned-sessions/${id}`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.host, history ? 'running' : 'not_running');
    assert.equal(launches, history ? 1 : 0);
    if (history) {
      assert.equal(result.state.incarnations[0].state, 'exited');
      assert.equal(result.state.incarnations[0].end_reason, 'host_lost');
      assert.equal(fs.readFileSync(path.join(dir, 'effects'), 'utf8').trim(), 'start');
    }
  });
}
