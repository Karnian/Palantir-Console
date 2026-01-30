const express = require('express');

function createUsageRouter({ codexService, providerService, fetchAnthropicUsage, fetchGeminiUsage }) {
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
      const registeredProviders = providerService
        ? await providerService.listRegisteredProviders()
        : [];
      const providers = [];
      if (registeredProviders.includes('openai')) {
        providers.push(await codexService.getProviderStatus());
      }
      if (registeredProviders.includes('anthropic')) {
        providers.push(await fetchAnthropicUsage(process.env.ANTHROPIC_API_KEY || ''));
      }
      if (registeredProviders.includes('google') || registeredProviders.includes('gemini')) {
        providers.push(await fetchGeminiUsage(process.env.GEMINI_API_KEY || ''));
      }
      if (!providers.length && registeredProviders.length) {
        registeredProviders.forEach((provider) => {
          providers.push({
            id: provider,
            name: provider,
            limits: [{
              label: 'usage',
              remainingPct: null,
              resetAt: null,
              errorMessage: 'Usage provider not configured'
            }],
            updatedAt: new Date().toISOString()
          });
        });
      }
      res.json({ status: 'ok', providers, registeredProviders });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { createUsageRouter };
