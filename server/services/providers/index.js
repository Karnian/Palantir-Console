/**
 * Provider registry — single entry point for usage queries across providers.
 *
 * Why this exists:
 *   The codebase used to spread usage logic across providerService (registered
 *   provider list), externalUsageService (anthropic + gemini fetchers), inline
 *   logic in routes/agents.js (claude-code OAuth + curl), and codexService
 *   (codex provider status). The keys for "what is a provider" were also mixed:
 *
 *     - opencode auth.json keys: openai | anthropic | google | gemini | ...
 *     - agent profile types:    codex  | claude-code | gemini | opencode
 *     - response envelope ids:  codex  | anthropic   | google
 *
 *   The registry is the only place that translates between those three
 *   namespaces. Adapters (anthropic.js, claude-code.js, gemini.js, codex via
 *   codexService) have a single responsibility: fetch usage and return the
 *   canonical envelope. They MUST NOT import routes or app — the registry
 *   is the only thing they hand back to.
 */

const { fetchAnthropicUsage } = require('./anthropic');
const { fetchClaudeCodeUsage } = require('./claude-code');
const { fetchGeminiUsage } = require('./gemini');
const { listRegisteredProviders } = require('./registered');

// opencode auth.json key → handler config.
// `openai` ships with the codex CLI auth in opencode parlance, so it maps to
// the codex provider, which lives in codexService and gets injected.
//
// fallbackId/fallbackName are used when the handler throws or returns null.
// Without them, the failure envelope would inherit the auth.json key (`openai`)
// instead of the canonical provider id (`codex`), creating a subtle drift
// between success and failure responses for the same provider.
//
// Aliases (`google` / `gemini` both point to gemini) MUST share the same
// handler function reference so fetchAllRegistered() can dedupe by identity.
// Otherwise we'd produce two duplicate provider cards when both keys live
// in auth.json.
const geminiHandler = () => fetchGeminiUsage(process.env.GEMINI_API_KEY || '');
const REGISTERED_KEY_HANDLERS = {
  openai:    { handler: (deps) => deps.codexService?.getProviderStatus(), fallbackId: 'codex',     fallbackName: 'codex'  },
  anthropic: { handler: () => fetchAnthropicUsage(process.env.ANTHROPIC_API_KEY || ''), fallbackId: 'anthropic', fallbackName: 'claude' },
  google:    { handler: geminiHandler, fallbackId: 'google', fallbackName: 'gemini' },
  gemini:    { handler: geminiHandler, fallbackId: 'google', fallbackName: 'gemini' },
};

// agent_profiles.type → adapter dispatch.
// claude-code is intentionally separate from anthropic — different auth source.
const AGENT_TYPE_HANDLERS = {
  codex:         (deps) => deps.codexService?.getProviderStatus(),
  'claude-code': () => fetchClaudeCodeUsage(),
  gemini:        () => fetchGeminiUsage(process.env.GEMINI_API_KEY || ''),
};

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

function createProviderRegistry({ codexService, opencodeAuthPath }) {
  const deps = { codexService };

  /**
   * Discover provider keys the user has configured (from opencode auth.json).
   * Pure passthrough — kept here so callers don't need to know about the file.
   */
  async function listRegistered() {
    return listRegisteredProviders(opencodeAuthPath);
  }

  // Fixed UI order for known providers — preserves the legacy
  // `openai → anthropic → gemini` card layout. Aliases (`google`/`gemini`) share
  // a handler reference so they dedupe naturally via the seenHandlers set.
  const KNOWN_PROVIDER_ORDER = ['openai', 'anthropic', 'google', 'gemini'];

  /**
   * Fetch usage for every registered provider.
   *
   * Behavior preserved from the pre-refactor implementation:
   *  - Known providers render in a fixed order, regardless of how they sort in
   *    the auth file (so the UI cards don't reshuffle).
   *  - Aliased handlers (google/gemini → same fetcher) dedupe by reference.
   *  - Unknown registered keys ONLY produce fallback cards when no known
   *    provider was rendered. Mixing known + unknown would have been a behavior
   *    drift that contract tests can't catch.
   */
  async function fetchAllRegistered() {
    const keys = await listRegistered();
    const keySet = new Set(keys);
    const out = [];
    const seenHandlers = new Set();

    for (const key of KNOWN_PROVIDER_ORDER) {
      if (!keySet.has(key)) continue;
      const cfg = REGISTERED_KEY_HANDLERS[key];
      if (!cfg || seenHandlers.has(cfg.handler)) continue;
      seenHandlers.add(cfg.handler);
      try {
        const result = await cfg.handler(deps);
        if (result) out.push(result);
        // Fallback id/name come from the handler config so failure envelopes
        // surface the canonical provider (e.g. `codex`) rather than the raw
        // auth-file key (e.g. `openai`) — keeping success and failure paths
        // keyed identically.
        else out.push(buildFallbackProvider(cfg.fallbackId, 'Provider returned no data', cfg.fallbackName));
      } catch (err) {
        out.push(buildFallbackProvider(cfg.fallbackId, err?.message || 'Provider fetch failed', cfg.fallbackName));
      }
    }

    // Legacy semantics: only show fallback rows for unknown registered keys
    // when nothing known was emitted. Otherwise the unknowns are silently ignored.
    if (out.length === 0) {
      for (const key of keys) {
        if (REGISTERED_KEY_HANDLERS[key]) continue;
        out.push(buildFallbackProvider(key, 'Usage provider not configured'));
      }
    }

    return out;
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
    listRegistered,
    fetchAllRegistered,
    getUsageForAgent,
  };
}

module.exports = { createProviderRegistry };
