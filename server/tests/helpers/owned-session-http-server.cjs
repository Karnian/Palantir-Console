'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthMiddleware } = require('../../middleware/auth');
const { createOwnedSessionService } = require('../../services/ownedSessionService');
const { createOwnedSessionsRouter } = require('../../routes/ownedSessions');
const { createClient } = require('../../sessionHost/launcher');
const runtimeDir = process.argv[2];
let client;
const service = createOwnedSessionService({ runtimeDir, pollMs: 10,
  createClient(options) { client = createClient(options); return client; } });
let subscriptions = 0;
const subscribe = service.subscribe;
service.subscribe = (seq, send) => {
  subscriptions++; const off = subscribe(seq, send); let closed = false;
  return () => { if (!closed) { closed = true; subscriptions--; off(); } };
};
const app = express();
app.use(createAuthMiddleware({ token: 'owned-test-token' }));
app.use('/api/owned-sessions', createOwnedSessionsRouter({ service }));
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
  await service.shutdown(); server.closeAllConnections(); server.close(() => process.exit(0));
});
