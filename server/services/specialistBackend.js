'use strict';

/**
 * Specialist backend (Operator P-B2c-1).
 *
 * A folder-less specialist (Profile × workspace:none × doer) must run deny-by-
 * default: no shell/FS/network/MCP/env/artifact. Codex + athena both concluded
 * the CLI adapters CANNOT host this — codexAdapter always passes
 * `--dangerously-bypass-approvals-and-sandbox` + server cwd + process.env, and
 * CLI tool-gating has escape hatches (e.g. `Bash(curl:*)` had to be removed).
 *
 * So the specialist runs as a DIRECT Anthropic Messages API turn with
 * server-executed tool-use (function-calling). The affordances are exactly two:
 * emit text, or call a tool WE registered. Tools are built ADDITIVELY from the
 * operator's capability grant — only granted caps become tools — so there is no
 * "forgot a check ⇒ ambient authority" failure mode. A folder-less specialist's
 * one cap is `registry_metadata_search` (GET-only metadata; never install/exec).
 *
 * 🔒 Three-layer gate on every tool_use block (Codex P-B2c-1 design Q4):
 *   1. ENTRY: reject any non-specialist (legacy) context — this is a specialist
 *      backend, NOT a safe fallback. Legacy must never run here.
 *   2. ALLOWLIST: the tool name must be in the cap-derived allowed set
 *      (grant.caps ∩ CAP_TO_TOOL). An injected `toolExecutors.shell` is inert
 *      because the name isn't in the allowed set — rejected before lookup.
 *   3. DEFENSE-IN-DEPTH: the executor calls enforceCapability(ctx, cap) too.
 *
 * PURE + UNWIRED (B2c-1): no spawn path / REST route / Composer / UI calls this
 * yet. B2c-2 wires it behind a flag. `callModel` + `toolExecutors` are injectable
 * so the whole engine is unit-testable with ZERO network / ZERO LLM.
 *
 * Tool results are untrusted (prompt-injection): the executor redacts secrets +
 * caps field lengths before the result re-enters the model context, and the
 * system prompt (B2c-2) instructs the model that metadata values are data, not
 * instructions. (Mirrors liveDistiller's posture.)
 */

const { isEnforced, enforceCapability, OPERATOR_KIND } = require('../utils/operatorContext');
const { CAPABILITIES } = require('../utils/capability');
const { redactSecrets } = require('./memorySanitize');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5';
const FIELD_CAP = 240; // max chars per projected metadata field

// Capability → server tool name. ONLY caps that map to a tool appear here; this
// is the additive allowlist. B2c-1 ships exactly one tool. shell/fs/network/…
// are intentionally absent (a specialist cannot get them via a tool at all).
const CAP_TO_TOOL = Object.freeze({
  [CAPABILITIES.REGISTRY_METADATA_SEARCH]: 'registry_metadata_search',
});
const TOOL_TO_CAP = Object.freeze(
  Object.fromEntries(Object.entries(CAP_TO_TOOL).map(([cap, tool]) => [tool, cap]))
);

const REGISTRY_METADATA_SEARCH_TOOL = Object.freeze({
  name: 'registry_metadata_search',
  description:
    'Search the bundled skill-pack registry and agent profiles for metadata (name, description, id only). Does NOT install, fetch, execute, or reveal any configuration/secret.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
  },
});

const TOOL_DEFS = Object.freeze({ registry_metadata_search: REGISTRY_METADATA_SEARCH_TOOL });

function capField(s) {
  const t = redactSecrets(String(s == null ? '' : s)).text.replace(/\s+/g, ' ').trim();
  return t.length > FIELD_CAP ? t.slice(0, FIELD_CAP) : t;
}

/**
 * Default executor for `registry_metadata_search`. GET-only, in-memory metadata.
 * Projects ONLY id/name/description — NEVER command/args/env_allowlist/
 * capabilities_json/url/bearer/etc. Untrusted query: coerced + length-capped.
 * Empty query → no results (no ambient enumeration / info disclosure).
 */
function createRegistryMetadataSearchExecutor({ registryService, agentProfileService } = {}) {
  return async function registryMetadataSearch(input) {
    const query = String((input && input.query) || '').trim().slice(0, 500);
    if (!query) return { results: [] };
    const q = query.toLowerCase();
    const results = [];

    try {
      const reg = registryService && typeof registryService.getRegistry === 'function'
        ? registryService.getRegistry() : null;
      const packs = reg && Array.isArray(reg.packs) ? reg.packs : [];
      for (const p of packs) {
        const name = capField(p && p.name);
        const description = capField(p && p.description);
        if (`${name} ${description}`.toLowerCase().includes(q)) {
          // every model-bound field is sanitized+capped (incl. id); source is a
          // fixed literal enum ('registry'|'profile'), not data.
          results.push({ id: capField(p && p.registry_id), name, description, source: 'registry' });
        }
      }
    } catch { /* registry read is best-effort */ }

    try {
      const profiles = agentProfileService && typeof agentProfileService.listProfiles === 'function'
        ? agentProfileService.listProfiles() : [];
      for (const pr of (Array.isArray(profiles) ? profiles : [])) {
        const name = capField(pr && pr.name);
        const type = capField(pr && pr.type);
        if (`${name} ${type}`.toLowerCase().includes(q)) {
          // description carries ONLY the type (metadata), never command/args/env.
          results.push({ id: capField(pr && pr.id), name, description: `type: ${type}`, source: 'profile' });
        }
      }
    } catch { /* profile read is best-effort */ }

    return { results: results.slice(0, 20) };
  };
}

/** Raw Messages API call returning the FULL response (content blocks + stop_reason). */
async function defaultCallModel({ system, messages, tools, tool_choice, model, maxTokens, apiKey, fetchImpl, signal }) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('fetch is unavailable');
  const body = { model, max_tokens: maxTokens, system, messages };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    if (tool_choice) body.tool_choice = tool_choice;
  }
  const res = await f(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`anthropic messages ${res.status}`);
  return res.json();
}

/**
 * @param {object} opts
 * @param {string} [opts.apiKey]       required unless callModel injected
 * @param {string} [opts.model]
 * @param {Function} [opts.callModel]  injectable raw Messages call (zero-network test)
 * @param {Function} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]    per-call abort
 * @param {number} [opts.totalTimeoutMs] whole-turn abort
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.maxIterations] tool-use loop guard
 * @param {object} [opts.toolExecutors] injectable { <toolName>: async (input)=>result }
 * @param {object} [opts.registryService]    for the default executor
 * @param {object} [opts.agentProfileService] for the default executor
 */
function createSpecialistBackend({
  apiKey,
  model = DEFAULT_MODEL,
  callModel,
  fetchImpl,
  timeoutMs = 30000,
  totalTimeoutMs = 120000,
  maxTokens = 4096,
  maxIterations = 10,
  toolExecutors,
  registryService,
  agentProfileService,
} = {}) {
  if (!callModel && !apiKey) {
    throw new Error('createSpecialistBackend: apiKey or callModel is required');
  }
  const model_ = model;
  const call = callModel || ((args) => defaultCallModel({ ...args, model: model_, maxTokens, apiKey, fetchImpl }));

  // Default executors (only the metadata tool). `toolExecutors` is a TRUSTED
  // construction-time parameter (Codex R2 M1): the allowlist gate verifies the
  // tool NAME (from caps), not the safety of the function behind it, so B2c-2 must
  // NEVER expose this override to an untrusted caller path. Injected executors
  // cannot EXPAND the surface (an extra name is rejected by the allowlist before
  // lookup), but they could replace the behavior of an allowed name.
  const executors = toolExecutors || {
    registry_metadata_search: createRegistryMetadataSearchExecutor({ registryService, agentProfileService }),
  };

  function buildTools(ctx) {
    const caps = (ctx.capabilityGrant && Array.isArray(ctx.capabilityGrant.caps)) ? ctx.capabilityGrant.caps : [];
    const allowed = new Set();
    const tools = [];
    for (const cap of caps) {
      const toolName = CAP_TO_TOOL[cap];
      if (toolName && TOOL_DEFS[toolName] && !allowed.has(toolName)) {
        allowed.add(toolName);
        tools.push(TOOL_DEFS[toolName]);
      }
    }
    return { allowed, tools };
  }

  async function executeToolUse(block, ctx, allowed) {
    const name = block && block.name;
    // Gate 2 (authoritative): name must be in the cap-derived allowed set.
    if (!name || !allowed.has(name)) {
      const e = new Error(`specialist: tool not permitted: ${name == null ? '(none)' : name}`);
      e.code = 'specialist:tool_denied';
      throw e;
    }
    // A valid tool_use MUST carry an id (the tool_result must reference it).
    // Missing/invalid id → fail-closed rather than append a malformed tool_result
    // (Codex R2 L1).
    if (typeof block.id !== 'string' || block.id.trim() === '') {
      const e = new Error('specialist: tool_use block missing a valid id');
      e.code = 'specialist:invalid_tool_use';
      throw e;
    }
    // Gate 3 (defense-in-depth, redundant-by-construction): `allowed` is built
    // from grant.caps ∩ CAP_TO_TOOL, so a name in `allowed` always has its cap in
    // the grant — gate 2 and gate 3 agree by construction. enforceCapability is
    // kept so the (frozen) context is RE-validated (assertOperatorContext +
    // isRealGrant) at tool-execution time, and to stay correct if the two ever
    // diverge in a future slice.
    enforceCapability(ctx, TOOL_TO_CAP[name]);
    const executor = executors[name];
    if (typeof executor !== 'function') {
      const e = new Error(`specialist: no executor for tool: ${name}`);
      e.code = 'specialist:no_executor';
      throw e;
    }
    const out = await executor((block && block.input) || {});
    return typeof out === 'string' ? out : JSON.stringify(out);
  }

  function extractText(content) {
    const blocks = Array.isArray(content) ? content : [];
    return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  }

  /**
   * Run one specialist turn. Returns { text, toolCallCount, iterations }.
   * @param {{ operatorContext: object, systemPrompt: string, userText: string }} args
   */
  async function runSpecialistTurn({ operatorContext, systemPrompt, userText } = {}) {
    // Gate 1 (entry): specialist contexts ONLY. isEnforced runs the full
    // assertOperatorContext (incl. isRealGrant forgery guard) first.
    if (!operatorContext || operatorContext.kind !== OPERATOR_KIND.SPECIALIST) {
      throw new Error('specialistBackend: requires a specialist operatorContext');
    }
    if (!isEnforced(operatorContext)) {
      throw new Error('specialistBackend: operatorContext is not enforced (refusing to run un-gated)');
    }

    const { allowed, tools } = buildTools(operatorContext);
    const tool_choice = tools.length > 0 ? { type: 'auto' } : undefined;
    const messages = [{ role: 'user', content: String(userText == null ? '' : userText) }];

    const outer = new AbortController();
    const totalTimer = setTimeout(() => outer.abort(), totalTimeoutMs);
    let toolCallCount = 0;
    try {
      for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
        const signal = combineSignals(outer.signal, timeoutMs);
        const data = await call({ system: systemPrompt, messages, tools, tool_choice, signal });
        const content = Array.isArray(data && data.content) ? data.content : [];
        const toolUses = content.filter((b) => b && b.type === 'tool_use');

        if (toolUses.length === 0) {
          // Terminal text ONLY from a clean end_turn (Codex R2 M3). A present-but-
          // non-end_turn stop (max_tokens truncation, pause_turn, refusal) must NOT
          // be surfaced as a completed answer — fail-closed. (A missing stop_reason
          // is treated as terminal: real Anthropic responses always carry one.)
          const stop = data && data.stop_reason;
          if (stop && stop !== 'end_turn') {
            const e = new Error(`specialist: unexpected stop_reason "${stop}"`);
            e.code = 'specialist:unexpected_stop';
            throw e;
          }
          return { text: extractText(content), toolCallCount, iterations: iteration };
        }

        // Preserve the FULL assistant content array (text + tool_use blocks).
        messages.push({ role: 'assistant', content });
        const toolResults = [];
        for (const tu of toolUses) {
          const result = await executeToolUse(tu, operatorContext, allowed);
          toolCallCount += 1;
          toolResults.push({ type: 'tool_result', tool_use_id: tu && tu.id, content: result });
        }
        // tool_result blocks immediately follow the assistant tool-use message.
        messages.push({ role: 'user', content: toolResults });
      }
      const e = new Error('specialist: max tool-use iterations exceeded');
      e.code = 'specialist:max_iterations';
      throw e;
    } catch (err) {
      // MD-3 timeout contract: surface a DISTINCT code when the deadline fired
      // (whole-turn outer.abort() → AbortError, or per-call AbortSignal.timeout →
      // TimeoutError, or the Anthropic SDK's APIUserAbortError) so the entry route
      // can map it to 504 instead of a generic 500. Non-timeout errors pass through.
      if (err && err.code === 'specialist:timeout') throw err;
      const isTimeout = outer.signal.aborted
        || (err && ['AbortError', 'TimeoutError', 'APIUserAbortError'].includes(err.name));
      if (isTimeout) {
        const e = new Error(`specialist: exceeded time budget (total ${totalTimeoutMs}ms / per-call ${timeoutMs}ms)`);
        e.code = 'specialist:timeout';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(totalTimer);
    }
  }

  return { runSpecialistTurn };
}

// Combine the whole-turn abort with a per-call timeout (node@22 AbortSignal.any).
function combineSignals(outerSignal, perCallMs) {
  const timeout = AbortSignal.timeout(perCallMs);
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([outerSignal, timeout]);
  return outerSignal; // fallback (older node): total-timeout only
}

module.exports = {
  createSpecialistBackend,
  createRegistryMetadataSearchExecutor,
  REGISTRY_METADATA_SEARCH_TOOL,
  CAP_TO_TOOL,
};
