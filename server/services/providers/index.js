/**
 * Provider registry — single entry point for usage queries across providers.
 *
 * Why this exists:
 *   The codebase used to spread usage logic across providerService (registered
 *   provider list), externalUsageService (anthropic + gemini fetchers), inline
 *   logic in routes/agents.js (claude-code OAuth + curl), and codexService
 *   (codex provider status). The identifiers for "what is a provider" were
 *   also mixed:
 *
 *     - provider aliases:      openai | anthropic   | google | gemini
 *     - agent profile types:   codex  | claude-code | gemini
 *     - response envelope ids: codex  | anthropic   | google
 *
 *   The registry is the only place that translates between those namespaces.
 *   Adapters (claude-code.js, gemini.js, codex via codexService) have a single
 *   responsibility: fetch usage and return the canonical envelope. They MUST
 *   NOT import routes or app — the registry is the only thing they hand back
 *   to.
 */

const { fetchClaudeCodeUsage } = require('./claude-code');
const { fetchGeminiUsage } = require('./gemini');

// Provider alias → handler config. `openai` maps to the codex provider, which
// lives in codexService and gets injected.
//
// fallbackId/fallbackName are used when the handler throws or returns null.
// Without them, the failure envelope would inherit the alias (`openai`)
// instead of the canonical provider id (`codex`), creating a subtle drift
// between success and failure responses for the same provider.
//
// Aliases (`google` / `gemini` both point to gemini) MUST share the same
// handler function reference so fetchAllKnown() can dedupe by identity.
const geminiHandler = (deps) => deps.fetchGeminiUsageFn(process.env.GEMINI_API_KEY || '');
const PROVIDER_HANDLERS = {
  openai:    { handler: (deps) => deps.codexService?.getProviderStatus(), fallbackId: 'codex',     fallbackName: 'codex'  },
  anthropic: { handler: (deps) => deps.fetchClaudeCodeUsageFn(), fallbackId: 'anthropic', fallbackName: 'claude' },
  google:    { handler: geminiHandler, fallbackId: 'google', fallbackName: 'gemini' },
  gemini:    { handler: geminiHandler, fallbackId: 'google', fallbackName: 'gemini' },
};

// agent_profiles.type → adapter dispatch.
const AGENT_TYPE_HANDLERS = {
  codex:         (deps) => deps.codexService?.getProviderStatus(),
  'claude-code': (deps) => deps.fetchClaudeCodeUsageFn(),
  gemini:        (deps) => deps.fetchGeminiUsageFn(process.env.GEMINI_API_KEY || ''),
};

// Fixed UI order for known providers. Aliases (`google`/`gemini`) share a
// handler reference so they dedupe naturally while preserving this order.
const KNOWN_PROVIDER_ORDER = ['openai', 'anthropic', 'google', 'gemini'];

function buildFallbackProvider(id, errorMessage, name) {
  return {
    id,
    // Preserve human-readable name when caller has one (typically the agent
    // profile's display name). Falls back to the provider id otherwise.
    name: name || id,
    limits: [{
      label: 'usage',
      remainingPct: null,
      resetAt: null,
      errorMessage,
    }],
    updatedAt: new Date().toISOString(),
  };
}

function createProviderRegistry({
  codexService,
  fetchClaudeCodeUsageFn = fetchClaudeCodeUsage,
  fetchGeminiUsageFn = fetchGeminiUsage,
} = {}) {
  const deps = { codexService, fetchClaudeCodeUsageFn, fetchGeminiUsageFn };

  /**
   * Fetch usage for every known provider in parallel. Promise.all preserves
   * the input array's order, so handler completion order cannot reshuffle the
   * UI cards.
   */
  async function fetchAllKnown() {
    const seenHandlers = new Set();

    const handlers = KNOWN_PROVIDER_ORDER.flatMap((key) => {
      const cfg = PROVIDER_HANDLERS[key];
      if (!cfg || seenHandlers.has(cfg.handler)) return [];
      seenHandlers.add(cfg.handler);
      return [cfg];
    });

    return Promise.all(handlers.map(async (cfg) => {
      try {
        const result = await cfg.handler(deps);
        return result || buildFallbackProvider(cfg.fallbackId, 'Provider returned no data', cfg.fallbackName);
      } catch (err) {
        return buildFallbackProvider(cfg.fallbackId, err?.message || 'Provider fetch failed', cfg.fallbackName);
      }
    }));
  }

  /**
   * Fetch usage for a single agent profile, dispatching by agent.type.
   * Caller is expected to handle the falsy/missing-agent case before calling.
   * Fallback envelopes preserve agent.name so UI cards still show the human
   * label rather than the bare provider id.
   */
  async function getUsageForAgent(agent) {
    const type = (agent?.type || '').toLowerCase();
    const fallbackName = agent?.name;
    const handler = AGENT_TYPE_HANDLERS[type];
    if (!handler) {
      return buildFallbackProvider(type || 'unknown', `No usage provider for type: ${type}`, fallbackName);
    }
    try {
      const result = await handler(deps);
      if (result) return result;
      return buildFallbackProvider(type, 'Provider returned no data', fallbackName);
    } catch (err) {
      return buildFallbackProvider(type, err?.message || 'Failed to fetch usage', fallbackName);
    }
  }

  return {
    fetchAllKnown,
    getUsageForAgent,
  };
}

module.exports = { createProviderRegistry };
