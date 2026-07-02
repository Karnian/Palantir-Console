'use strict';

// Shared conversation-id / operator-layer helpers — the single seam for the
// PM → Operator rename (docs/specs/operator-rename-plan.md).
//
// Phase 4 (FINAL CLEANUP): dual-read removed. The legacy `pm:` prefix and the
// `'pm'` manager_layer are no longer recognized. Producers emit `operator:` /
// `'operator'` (Phase 2), persisted data was migrated (Phase 1 + migration 046),
// and there is no remaining source of the legacy form. Consumers now accept the
// `operator:` prefix and the `'operator'` layer ONLY.

const OPERATOR_CONV_PREFIX = 'operator:';
const PROJECT_CONV_PREFIXES = [OPERATOR_CONV_PREFIX];

const OPERATOR_LAYER = 'operator';

// PRODUCER seam: the conversation id for a project-scoped operator.
function conversationIdForProject(projectId) {
  return `${OPERATOR_CONV_PREFIX}${projectId}`;
}

// CONSUMER seam: parse a project-scoped conversation id (operator: only).
// Returns { projectId } or null. An empty projectId (`operator:`) → null,
// preserving the existing parseConversationId('operator:') === null contract.
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

// Does `id` name project-scoped-operator `projectId`? (replaces inline
// `conversation_id === \`operator:${projectId}\`` fail-closed checks.)
function conversationIdMatchesProject(id, projectId) {
  const parsed = parseProjectConversationId(id);
  return parsed !== null && parsed.projectId === projectId;
}

// Is this manager_layer the project-scoped operator role?
function isProjectLayer(layer) {
  return layer === OPERATOR_LAYER;
}

// Normalize any conversation id to its CANONICAL form. With dual-read removed
// this is identity for `operator:<id>`; non-project ids ('top', 'worker:...',
// anything else) also pass through unchanged. Kept as the single registry
// slot-key + comparison normalizer so call sites remain stable.
function canonicalConversationId(id) {
  const parsed = parseProjectConversationId(id);
  return parsed ? conversationIdForProject(parsed.projectId) : id;
}

module.exports = {
  OPERATOR_CONV_PREFIX,
  PROJECT_CONV_PREFIXES,
  OPERATOR_LAYER,
  conversationIdForProject,
  parseProjectConversationId,
  isProjectConversationId,
  conversationIdMatchesProject,
  isProjectLayer,
  canonicalConversationId,
};
