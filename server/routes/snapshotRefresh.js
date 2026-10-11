'use strict';

const express = require('express');
const { requireSessionHubCookie } = require('./sessionHubChat');

function createSnapshotRefreshRouter({ service }) {
  const router = express.Router();
  router.use(requireSessionHubCookie);
  router.use(express.json({ limit: '4kb', strict: true }));
  router.get('/status', (req, res) => res.json(service.state()));
  router.post('/refresh', (req, res, next) => {
    try {
      const body = req.body;
      if ((req.headers['transfer-encoding'] || Number(req.headers['content-length']) > 0)
        && !req.is('application/json')) {
        return res.status(400).json({ error: 'request_invalid', reason: 'request_invalid' });
      }
      if (body !== undefined && (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).some(key => key !== 'targets'))) {
        return res.status(400).json({ error: 'request_invalid', reason: 'request_invalid' });
      }
      return res.status(202).json(service.refresh(body?.targets));
    } catch (err) { return next(err); }
  });
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const code = ['request_invalid', 'snapshot_refresh_closed', 'snapshot_targets_invalid',
      'snapshot_staging_invalid', 'snapshot_refresh_config_invalid', 'snapshot_targets_unset',
      'observe_off', 'reap_failed', 'snapshot_refresh_locked'].includes(err.code)
      ? err.code : 'request_invalid';
    return res.status(err.status || 400).json({ error: code, reason: code });
  });
  return router;
}

module.exports = { createSnapshotRefreshRouter };
