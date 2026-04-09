// server/services/routerService.js
//
// v3 Phase 6 (spec §9.5): deterministic 3-step conversation-target
// matcher. Given a raw user message + the UI's current selection,
// decides which conversation id this message should be posted to.
//
// This service is intentionally **stateless** and free of any network
// or DB coupling beyond a project lookup: it exists so both the client
// and a future Top-layer LLM dispatcher can share the same routing
// rules, and so the matcher is cheap to unit-test with node:test.
//
// Rules (in order — first match wins):
//
//   1. **Explicit prefix.**
//      If the text starts with `@<name>` (or `@<id>`), the `<name>`
//      is resolved against the project list (case-insensitive name OR
//      exact project id). If that resolves to a project with
//      `pm_enabled !== 0`, the target is `pm:<projectId>` and the
//      `@<name>` token is stripped from the rewritten text.
//
//   2. **Current UI context.**
//      If the caller provided a `currentConversationId` (what the
//      user is "looking at" in the chat panel), and that id is a
//      valid shape (`top` | `pm:<projectId>` | `worker:<runId>`), it
//      becomes the target with the text unchanged.
//
//   3. **Project-name fuzzy match (exact-only for Phase 6).**
//      Only runs if step 2 had no current context. The text is
//      scanned for the first token that matches a project name
//      case-insensitively. If a single unique match is found the
//      target is `pm:<projectId>` with the original text unchanged.
//      Multiple matches → ambiguous → default target + `ambiguous`
//      flag so the caller can ask the user to disambiguate.
//
//   4. **Default.**
//      Fall through to `defaultConversationId` (usually `'top'`).
//
// Return shape:
//   {
//     target: 'top' | 'pm:<id>' | 'worker:<id>',
//     text: <string>,              // possibly rewritten (step 1 strip)
//     matchedRule: '1_explicit' | '2_current' | '3_namematch' | '4_default',
//     ambiguous?: true,            // set on step 3 multi-match
//     candidates?: [{projectId, name}],  // set on ambiguous
//   }

const VALID_TARGET_PREFIXES = ['top', 'pm:', 'worker:'];

function isValidConversationId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id === 'top') return true;
  if (id.startsWith('pm:') && id.length > 3) return true;
  if (id.startsWith('worker:') && id.length > 7) return true;
  return false;
}

// Parse a leading "@<name>" token. Returns { name, rest } or null.
// Name is whatever comes between '@' and the next whitespace — we
// deliberately do NOT split on punctuation because project names can
// contain hyphens / underscores / digits.
function parseExplicitMention(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^\s*@([^\s]+)\s*(.*)$/s);
  if (!m) return null;
  return { name: m[1], rest: m[2] };
}

// Normalize for case-insensitive match.
function norm(s) {
  return (s || '').toLowerCase().trim();
}

function createRouterService({ projectService, logger } = {}) {
  const log = logger || (() => {});

  function listEnabledProjects() {
    if (!projectService) return [];
    try {
      return projectService.listProjects().filter(p => p.pm_enabled !== 0);
    } catch {
      return [];
    }
  }

  // Core matcher. Accepts plain values so tests don't need to mock.
  function resolveTarget({
    text,
    currentConversationId,
    defaultConversationId = 'top',
  } = {}) {
    const original = typeof text === 'string' ? text : '';

    // --- Rule 1: explicit @mention ---
    const mention = parseExplicitMention(original);
    if (mention) {
      const projects = listEnabledProjects();
      const needle = norm(mention.name);
      // Exact id match wins over name match (ids are unique + the PM
      // thread id format is not human-friendly so a name collision is
      // statistically impossible, but we order for determinism).
      let hit = projects.find(p => p.id === mention.name);
      if (!hit) hit = projects.find(p => norm(p.name) === needle);
      if (hit) {
        const rewritten = mention.rest.trim();
        return {
          target: `pm:${hit.id}`,
          text: rewritten.length > 0 ? rewritten : original, // keep body if strip leaves nothing
          matchedRule: '1_explicit',
        };
      }
      // Unresolved @mention → fall through; log only (no throw — the
      // user might have typed a stray @ character).
      log(`router: unresolved @mention "${mention.name}"`);
    }

    // --- Rule 2: current UI context ---
    if (currentConversationId && isValidConversationId(currentConversationId)) {
      return {
        target: currentConversationId,
        text: original,
        matchedRule: '2_current',
      };
    }

    // --- Rule 3: project-name fuzzy match (exact-insensitive only) ---
    // Only when step 2 was absent. Avoids surprising users who are
    // actively in a conversation from being silently redirected.
    if (!currentConversationId) {
      const projects = listEnabledProjects();
      const tokens = original
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const tokenSet = new Set(tokens);
      const hits = projects.filter(p => tokenSet.has(norm(p.name)));
      if (hits.length === 1) {
        return {
          target: `pm:${hits[0].id}`,
          text: original,
          matchedRule: '3_namematch',
        };
      }
      if (hits.length > 1) {
        return {
          target: defaultConversationId,
          text: original,
          matchedRule: '3_namematch',
          ambiguous: true,
          candidates: hits.map(p => ({ projectId: p.id, name: p.name })),
        };
      }
    }

    // --- Rule 4: default ---
    return {
      target: isValidConversationId(defaultConversationId) ? defaultConversationId : 'top',
      text: original,
      matchedRule: '4_default',
    };
  }

  return { resolveTarget, isValidConversationId, parseExplicitMention };
}

module.exports = { createRouterService };
