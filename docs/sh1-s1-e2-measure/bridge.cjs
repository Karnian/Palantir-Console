'use strict';
// Measurement-only bridge: the real owned-sessions router and service, with cookie auth stubbed.
const REPO = '/Users/K/Desktop/sub_project/palantir_console';
const express = require(`${REPO}/node_modules/express`);
const { createOwnedSessionService } = require(`${REPO}/server/services/ownedSessionService`);
const { createOwnedSessionsRouter } = require(`${REPO}/server/routes/ownedSessions`);
const [runtimeDir, port] = process.argv.slice(2);
const service = createOwnedSessionService({ runtimeDir });
const app = express();
app.use((req, res, next) => { req.auth = { method: 'cookie' }; next(); });
app.use('/api/owned-sessions', createOwnedSessionsRouter({ service }));
const server = app.listen(Number(port), '127.0.0.1', () => process.send?.({ type: 'ready', port: server.address().port }));
process.on('SIGTERM', async () => { await service.shutdown(); server.close(() => process.exit(0)); });
