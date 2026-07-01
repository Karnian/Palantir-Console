'use strict';

// Shared conversation-id / operator-layer helpers — the single seam for the
// PM → Operator rename (docs/specs/operator-rename-plan.md).
//
// Phase 0 (DUAL-READ): every consumer parses BOTH the legacy `pm:` prefix and the
// new `operator:` prefix, and treats manager_layer `'pm'` and `'operator'` as the
// same project-scoped-operator role. PRODUCERS still emit the legacy `pm:` / `'pm'`
// (conversationIdForProject returns `pm:` until Phase 2), so Phase 0 is 100%
// behavior-preserving — the system merely *understands* `operator:` before it ever
// *writes* it. This lets the Phase 1 data migration flip persisted values safely.

const LEGACY_PM_CONV_PREFIX = 'pm:';
const OPERATOR_CONV_PREFIX = 'operator:';
// Order matters only cosmetically; both are accepted on read.
const PROJECT_CONV_PREFIXES = [LEGACY_PM_CONV_PREFIX, OPERATOR_CONV_PREFIX];

const LEGACY_PM_LAYER = 'pm';
const OPERATOR_LAYER = 'operator';

// PRODUCER seam: the conversation id for a project-scoped operator (today's "PM").
// Still emits `pm:` in Phase 0/1; flips to `operator:` in Phase 2 at THIS one point.
function conversationIdForProject(projectId) {
  return `${LEGACY_PM_CONV_PREFIX}${projectId}`;
}

// CONSUMER seam: parse a project-scoped conversation id (accepts both prefixes).
// Returns { projectId } or null. An empty projectId (`pm:` / `operator:`) → null,
// preserving the existing parseConversationId('pm:') === null contract.
function parseProjectConversationId(id) {
  if (typeof id !== 'string') return null;
  for (const prefix of PROJECT_CONV_PREFIXES) {
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { projectId: id.slice(prefix.length) };
    }
  }
  return null;
}

function isProjectConversationId(id) {
  return parseProjectConversationId(id) !== null;
}

// Does `id` name project-scoped-operator `projectId`? (dual-read equality — replaces
// inline `conversation_id === \`pm:${projectId}\`` fail-closed checks.)
function conversationIdMatchesProject(id, projectId) {
  const parsed = parseProjectConversationId(id);
  return parsed !== null && parsed.projectId === projectId;
}

// Is this manager_layer the project-scoped operator role (legacy 'pm' or 'operator')?
function isProjectLayer(layer) {
  return layer === LEGACY_PM_LAYER || layer === OPERATOR_LAYER;
}

module.exports = {
  LEGACY_PM_CONV_PREFIX,
  OPERATOR_CONV_PREFIX,
  PROJECT_CONV_PREFIXES,
  LEGACY_PM_LAYER,
  OPERATOR_LAYER,
  conversationIdForProject,
  parseProjectConversationId,
  isProjectConversationId,
  conversationIdMatchesProject,
  isProjectLayer,
};
