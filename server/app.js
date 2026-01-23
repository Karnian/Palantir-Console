const express = require('express');
const path = require('path');
const os = require('os');
const { createStorageContext } = require('./services/storage');
const { createSessionService } = require('./services/sessionService');
const { createTrashService } = require('./services/trashService');
const { createMessageService } = require('./services/messageService');
const { createFsService } = require('./services/fsService');
const { createOpencodeService } = require('./services/opencodeService');
const { createSessionsRouter } = require('./routes/sessions');
const { createTrashRouter } = require('./routes/trash');
const { createFsRouter } = require('./routes/fs');
const { errorHandler } = require('./middleware/errorHandler');

function createApp(options = {}) {
  const app = express();
  const storageRoot = options.storageRoot
    || process.env.OPENCODE_STORAGE
    || path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  const fsRoot = options.fsRoot || process.env.OPENCODE_FS_ROOT || os.homedir();
  const opencodeBin = options.opencodeBin || process.env.OPENCODE_BIN || 'opencode';
  const storage = createStorageContext({ storageRoot, fsRoot });
  const sessionService = createSessionService(storage);
  const trashService = createTrashService(storage);
  const messageService = createMessageService(storage);
  const fsService = createFsService(storage);
  const opencodeService = createOpencodeService({ opencodeBin });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/sessions', createSessionsRouter({
    sessionService,
    messageService,
    trashService,
    opencodeService,
    storageRoot: storage.storageRoot
  }));
  app.use('/api/trash/sessions', createTrashRouter({ trashService }));
  app.use('/api/fs', createFsRouter({ fsService }));
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
