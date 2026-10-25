'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../../app');
const { createClient } = require('../../sessionHost/launcher');
const runtimeDir = process.argv[2];
const appRoot = fs.mkdtempSync(path.join(runtimeDir, 'server-'));
process.chdir(appRoot);
let client;
const app = createApp({ authToken: 'owned-test-token', pmToken: null,
  dbPath: path.join(appRoot, 'app.sqlite'), storageRoot: path.join(appRoot, 'storage'), fsRoot: runtimeDir,
  pluginsRoot: path.join(appRoot, 'plugins'), codexHome: path.join(appRoot, 'codex'),
  observeSnapshotDir: null, sessionHubActive: false, authResolverOpts: { hasKeychain: () => false },
  agentProcessIsolation: true, execAttestation: { verified: true, reason: 'test' },
  memoryDistillEnabled: false, operatorSchedulerEnabled: false, masterMemoryXprojectScanEnabled: false,
  fleetHeartbeatEnabled: false, operatorSpecialistEnabled: false,
  ownedSessionServiceOptions: { runtimeDir, pollMs: 10,
    createClient(options) { client = createClient(options); return client; } }
});
const service = app.ownedSessionService;
let subscriptions = 0;
const subscribe = service.subscribe;
service.subscribe = (seq, send) => {
  subscriptions++; const off = subscribe(seq, send); let closed = false;
  return () => { if (!closed) { closed = true; subscriptions--; off(); } };
};
const server = app.listen(0, '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
server.on('error', error => { process.stderr.write(String(error.stack) + '\n'); process.exit(1); });
process.on('message', message => {
  if (message === 'stats') process.send?.({ type: 'stats', subscriptions });
  if (message === 'break-socket') {
    client.close();
    fs.unlinkSync(path.join(runtimeDir, 'host.sock'));
    process.send?.({ type: 'socket-broken' });
  }
});
process.on('SIGTERM', async () => {
  await app.shutdown(); server.closeAllConnections(); server.close(() => process.exit(0));
});
