// Client-side conversation-id helpers (ESM, browser-safe).
// Mirrors the server-side server/utils/conversationId.js producer/consumer seams.
// Cannot import the Node util directly — kept in sync manually.
//
// W-P5+: live Operator slots may be `operator:oi_*`, while project-scoped
// UI affordances still need the legacy `operator:<projectId>` alias for joins.
// Keep the project parser strict: instance ids must not masquerade as projects.

const OPERATOR_PREFIX = 'operator:';
const OPERATOR_INSTANCE_PREFIX = 'oi_';

/**
 * Produce the legacy project alias for project-scoped Operator UI paths.
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
    const projectId = id.slice(OPERATOR_PREFIX.length);
    if (projectId.startsWith(OPERATOR_INSTANCE_PREFIX)) return null;
    return { projectId };
  }
  return null;
}

/**
 * Predicate for the instance-scoped operator conversation form.
 */
export function isInstanceConversationId(id) {
  if (typeof id !== 'string') return false;
  if (!id.startsWith(OPERATOR_PREFIX) || id.length <= OPERATOR_PREFIX.length) return false;
  const instanceId = id.slice(OPERATOR_PREFIX.length);
  return instanceId.startsWith(OPERATOR_INSTANCE_PREFIX)
    && instanceId.length > OPERATOR_INSTANCE_PREFIX.length;
}

/**
 * Equality: does `id` name the project-scoped operator for `projectId`?
 * Accepts the legacy `operator:<projectId>` alias only; use server-provided
 * `legacyConversationId` / `primaryProjectId` when starting from `operator:oi_*`.
 */
export function conversationIdMatchesProject(id, projectId) {
  const parsed = parseProjectConversationId(id);
  return parsed !== null && parsed.projectId === String(projectId);
}
