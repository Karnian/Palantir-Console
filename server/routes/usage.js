const express = require('express');

function createUsageRouter({ codexService }) {
  const router = express.Router();

  router.get('/codex-status', async (req, res, next) => {
    try {
      const result = await codexService.getStatus();
      res.json({
        status: 'ok',
        limits: result.limits,
        updatedAt: result.updatedAt,
        account: result.account,
        requiresOpenaiAuth: result.requiresOpenaiAuth,
        accountError: result.accountError
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/providers', async (req, res, next) => {
    try {
      const codex = await codexService.getProviderStatus();
      res.json({ status: 'ok', providers: [codex] });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createUsageRouter };
