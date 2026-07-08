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
const OPERATOR_INSTANCE_ID_PREFIX = 'oi_';

function operatorConversationPayload(id) {
  if (typeof id !== 'string') return null;
  if (!id.startsWith(OPERATOR_CONV_PREFIX) || id.length <= OPERATOR_CONV_PREFIX.length) return null;
  return id.slice(OPERATOR_CONV_PREFIX.length);
}

function isOperatorInstanceId(value) {
  return typeof value === 'string'
    && value.startsWith(OPERATOR_INSTANCE_ID_PREFIX)
    && value.length > OPERATOR_INSTANCE_ID_PREFIX.length;
}

function isInstanceConversationId(id) {
  const payload = operatorConversationPayload(id);
  return isOperatorInstanceId(payload);
}

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
      const projectId = id.slice(prefix.length);
      if (projectId.startsWith(OPERATOR_INSTANCE_ID_PREFIX)) return null;
      return { projectId };
    }
  }
  return null;
}

function normalizeLookupResult(row) {
  if (!row) return {};
  if (typeof row === 'string') return { instanceId: row };
  if (typeof row !== 'object') return {};
  return {
    instanceId: row.instanceId || row.instance_id || null,
    primaryProjectId: row.primaryProjectId || row.primary_project_id || row.projectId || row.project_id || null,
  };
}

function resolveOperatorConversationId(id, {
  lookupInstanceByProject,
  lookupInstanceById,
} = {}) {
  const payload = operatorConversationPayload(id);
  if (!payload) return null;

  if (payload.startsWith(OPERATOR_INSTANCE_ID_PREFIX)) {
    if (!isOperatorInstanceId(payload)) return null;
    const lookup = typeof lookupInstanceById === 'function'
      ? normalizeLookupResult(lookupInstanceById(payload))
      : {};
    const primaryProjectId = lookup.primaryProjectId || null;
    return {
      instanceId: payload,
      legacyProjectId: null,
      legacySlotId: primaryProjectId ? conversationIdForProject(primaryProjectId) : null,
      instanceConversationId: conversationIdForProject(payload),
      primaryProjectId,
    };
  }

  const legacyProjectId = payload;
  const lookup = typeof lookupInstanceByProject === 'function'
    ? normalizeLookupResult(lookupInstanceByProject(legacyProjectId))
    : {};
  const instanceId = lookup.instanceId || null;
  return {
    instanceId,
    legacyProjectId,
    legacySlotId: conversationIdForProject(legacyProjectId),
    instanceConversationId: instanceId ? conversationIdForProject(instanceId) : null,
    primaryProjectId: lookup.primaryProjectId || null,
  };
}

function createOperatorConversationIdResolver(db) {
  const lookupByProject = db.prepare(`
    SELECT
      oi.id AS instanceId,
      r.project_id AS primaryProjectId
    FROM operator_codebase_refs r
    JOIN operator_instances oi ON oi.id = r.instance_id
    WHERE r.project_id = ?
      AND r.role = 'primary'
    LIMIT 1
  `);
  const lookupById = db.prepare(`
    SELECT
      oi.id AS instanceId,
      r.project_id AS primaryProjectId
    FROM operator_instances oi
    LEFT JOIN operator_codebase_refs r
      ON r.instance_id = oi.id
     AND r.role = 'primary'
    WHERE oi.id = ?
    LIMIT 1
  `);

  return function resolveWithPrimaryLookups(id) {
    return resolveOperatorConversationId(id, {
      lookupInstanceByProject: (projectId) => lookupByProject.get(projectId) || null,
      lookupInstanceById: (instanceId) => lookupById.get(instanceId) || null,
    });
  };
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
  OPERATOR_INSTANCE_ID_PREFIX,
  conversationIdForProject,
  parseProjectConversationId,
  resolveOperatorConversationId,
  createOperatorConversationIdResolver,
  isInstanceConversationId,
  isProjectConversationId,
  conversationIdMatchesProject,
  isProjectLayer,
  canonicalConversationId,
};
