'use strict';

const { BadRequestError } = require('../utils/errors');
const { sanitizeProposalContent } = require('../services/memorySanitize');

const VALID_STATUSES = ['pending', 'promoted', 'rejected', 'merged'];
const PROMOTABLE_KINDS = new Set(['convention', 'pitfall', 'heuristic', 'constraint']);
const REVIEW_CONTENT_MAX_LEN = 2000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function requireHumanCookie(req, res, action = 'memory candidate review') {
  if (!req.auth || req.auth.method !== 'cookie') {
    res.status(403).json({ error: `${action} requires human (cookie) auth` });
    return false;
  }
  return true;
}

function candidateStatus(value) {
  const status = value === undefined ? 'pending' : value;
  if (!VALID_STATUSES.includes(status)) {
    throw new BadRequestError(`status must be one of ${VALID_STATUSES.join('|')}`);
  }
  return status;
}

function candidateApprovalOverride(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const hasOverride = ['kind', 'content', 'importance'].some((key) => Object.hasOwn(input, key));
  if (!hasOverride) return null;
  return {
    kind: input.kind,
    content: input.content,
    importance: input.importance,
  };
}

function decodeCandidateCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BadRequestError('invalid candidate cursor');
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('invalid candidate cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      typeof parsed.created_at !== 'string' || !parsed.created_at ||
      parsed.created_at.length > 64 ||
      typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 128) {
    throw new BadRequestError('invalid candidate cursor');
  }
  return { createdAt: parsed.created_at, id: parsed.id };
}

function encodeCandidateCursor(row) {
  return Buffer.from(JSON.stringify({
    created_at: row.created_at,
    id: row.id,
  })).toString('base64url');
}

function candidatePage(memoryService, ownerType, ownerId, status, query = {}) {
  const requestedLimit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_PAGE_SIZE) {
    throw new BadRequestError(`limit must be an integer 1-${MAX_PAGE_SIZE}`);
  }
  const cursor = decodeCandidateCursor(query.cursor);
  const rows = memoryService.listCandidatePageForOwner(ownerType, ownerId, status, {
    limit: requestedLimit + 1,
    afterCreatedAt: cursor && cursor.createdAt,
    afterId: cursor && cursor.id,
  });
  const hasMore = rows.length > requestedLimit;
  const pageRows = hasMore ? rows.slice(0, requestedLimit) : rows;
  return {
    candidates: pageRows.map(toPublicCandidate),
    next_cursor: hasMore ? encodeCandidateCursor(pageRows[pageRows.length - 1]) : null,
  };
}

// Candidate raw_json can contain run/task excerpts and must never cross the API
// boundary. Only R4's already-sanitized operator prose gets review content, and
// it is sanitized again here for defense in depth. The full 2,000-character
// approval payload is shown: approval must never cover an unseen suffix.
function toPublicCandidate(row) {
  if (!row) return null;
  let kind = null;
  let preview = '';
  let importance = 5;
  let approvalMode = row.rule === 'R4' ? 'invalid' : 'distillation_required';
  let canPromote = false;
  if (row.rule === 'R4') {
    let raw = null;
    try { raw = JSON.parse(row.raw_json); } catch { raw = null; }
    const candidateKind = raw && typeof raw.kind === 'string' ? raw.kind.trim() : '';
    const sanitized = sanitizeProposalContent(raw && raw.content, { maxLen: REVIEW_CONTENT_MAX_LEN });
    if (PROMOTABLE_KINDS.has(candidateKind) && sanitized.ok) {
      kind = candidateKind;
      preview = sanitized.content;
      const candidateImportance = Number(raw.importance);
      importance = Number.isInteger(candidateImportance)
        && candidateImportance >= 1
        && candidateImportance <= 10
        ? candidateImportance
        : 5;
      approvalMode = 'deterministic';
      canPromote = row.status === 'pending';
    }
  }
  return {
    id: row.id,
    owner_type: row.owner_type,
    owner_id: row.owner_id,
    project_id: row.project_id,
    rule: row.rule,
    status: row.status,
    promoted_to: row.promoted_to,
    created_at: row.created_at,
    updated_at: row.updated_at,
    kind,
    preview,
    importance,
    approval_mode: approvalMode,
    can_promote: canPromote,
  };
}

module.exports = {
  candidatePage,
  candidateApprovalOverride,
  candidateStatus,
  decodeCandidateCursor,
  encodeCandidateCursor,
  requireHumanCookie,
  toPublicCandidate,
};
