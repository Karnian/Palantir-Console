// Client-side conversation-id helpers (ESM, browser-safe).
// Mirrors the server-side server/utils/conversationId.js producer/consumer seams.
// Cannot import the Node util directly — kept in sync manually.
//
// Phase 4 (FINAL CLEANUP): dual-read removed. Producer emits `operator:` and
// consumers accept `operator:` ONLY.

const OPERATOR_PREFIX = 'operator:';

/**
 * Produce the canonical conversation id for a project-scoped operator.
 * Emits `operator:<projectId>`.
 */
export function operatorConversationId(projectId) {
  return `${OPERATOR_PREFIX}${projectId}`;
}

/**
 * Parse a project-scoped conversation id (operator: only).
 * Returns { projectId } or null. Empty projectId (`operator:`) → null.
 */
export function parseProjectConversationId(id) {
  if (typeof id !== 'string') return null;
  if (id.startsWith(OPERATOR_PREFIX) && id.length > OPERATOR_PREFIX.length) {
    return { projectId: id.slice(OPERATOR_PREFIX.length) };
  }
  return null;
}

/**
 * Equality: does `id` name the project-scoped operator for `projectId`?
 * Accepts `operator:<projectId>` only.
 */
export function conversationIdMatchesProject(id, projectId) {
  const parsed = parseProjectConversationId(id);
  return parsed !== null && parsed.projectId === String(projectId);
}
