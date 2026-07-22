const express = require('express');

/**
 * Usage routes — thin layer on top of the provider registry.
 *
 * Wire format is locked by server/tests/usage-contract.test.js. Any change
 * here that alters response shape will fail those tests.
 */
function createUsageRouter({ codexService, providerRegistry }) {
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
        accountError: result.accountError,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/providers', async (req, res, next) => {
    try {
      const providers = providerRegistry
        ? await providerRegistry.fetchAllKnown()
        : [];
      res.json({ status: 'ok', providers });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createUsageRouter };
