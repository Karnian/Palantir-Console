// Client-side conversation-id helpers (ESM, browser-safe).
// Mirrors the server-side server/utils/conversationId.js producer/consumer seams.
// Cannot import the Node util directly — kept in sync manually.
//
// Phase 2: producer emits `operator:`, consumers dual-read `pm:` / `operator:`.

const LEGACY_PM_PREFIX = 'pm:';
const OPERATOR_PREFIX = 'operator:';

/**
 * Produce the canonical conversation id for a project-scoped operator.
 * Phase 2: emits `operator:<projectId>`.
 */
export function operatorConversationId(projectId) {
  return `${OPERATOR_PREFIX}${projectId}`;
}

/**
 * Parse a project-scoped conversation id (dual-read: accepts `pm:` or `operator:` prefix).
 * Returns { projectId } or null. Empty projectId (`pm:` / `operator:`) → null.
 */
export function parseProjectConversationId(id) {
  if (typeof id !== 'string') return null;
  for (const prefix of [LEGACY_PM_PREFIX, OPERATOR_PREFIX]) {
    if (id.startsWith(prefix) && id.length > prefix.length) {
      return { projectId: id.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Dual-read equality: does `id` name the project-scoped operator for `projectId`?
 * Accepts both `pm:<projectId>` and `operator:<projectId>`.
 */
export function conversationIdMatchesProject(id, projectId) {
  const parsed = parseProjectConversationId(id);
  return parsed !== null && parsed.projectId === String(projectId);
}
