// server/routes/masterMemory.js
//
// L2 Master Memory (user-scoped, cross-project) HTTP surface. P1b.
//
//   GET  /api/master-memory            -> { memory: [...active user-scope rows] }
//   POST /api/master-memory/remember   -> cookie writes ACTIVE; bearer/none stages R4 candidate
//   GET  /api/master-memory/candidates -> cookie-only candidate review queue
//
// Mirrors routes/memory.js (field whitelist, cookie-actor gate, fact env. reservation). De-scoped per
// docs/specs/master-memory-brief.md §12: governed retrieval only. P1c Slice 1 adds a candidate path for
// untrusted remember calls; promotion is human-approved and writes deterministic-origin active memory.

const crypto = require('node:crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { detectInjection, redactSecrets } = require('../services/memorySanitize');

const VALID_KINDS = ['constraint', 'preference', 'commitment', 'decision', 'fact', 'pattern'];
const PUBLIC_FIELDS = [
  'id', 'scope', 'project_id', 'kind', 'content', 'fact_key',
  'origin', 'importance', 'confidence', 'source_count', 'status',
  'pinned', 'valid_to', 'archived_at', 'created_at', 'updated_at', 'reviewed_at',
];
const VALID_SCOPES = ['user', 'cross_project'];
const VALID_CANDIDATE_STATUSES = ['pending', 'promoted', 'rejected', 'merged'];
const MAX_REMEMBER_LEN = 2000;

function toPublic(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) if (row && f in row) out[f] = row[f];
  return out;
}

function toPublicCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    rule: row.rule,
    dedup_key: row.dedup_key,
    status: row.status,
    promoted_to: row.promoted_to,
    created_at: row.created_at,
    kind: row.kind ?? null,
    preview: row.preview ?? '',
  };
}

function validateScope(scope) {
  if (!VALID_SCOPES.includes(scope)) throw new BadRequestError(`scope must be one of ${VALID_SCOPES.join('|')}`);
  return scope;
}

function validateFactKey(factKey) {
  const fk = typeof factKey === 'string' ? factKey.trim() : '';
  if (!fk) throw new BadRequestError('factKey is required for a fact');
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(fk)) {
    throw new BadRequestError('fact_key must be ASCII dot-separated identifiers (a-z, 0-9, _, .)');
  }
  if (fk.toLowerCase().startsWith('env.')) {
    throw new BadRequestError('fact_key prefix "env." is reserved for system facts');
  }
  return fk;
}

function sanitizeMasterContent(rawContent) {
  if (detectInjection(rawContent)) {
    throw new BadRequestError('content rejected: injection marker');
  }
  const content = redactSecrets(rawContent.trim()).text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMEMBER_LEN);
  if (!content) throw new BadRequestError('content rejected: empty after redaction');
  return content;
}

function createMasterMemoryRouter({ masterMemoryService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    // default only when ABSENT; an invalid scope fails closed (Codex SERIOUS — don't silently bucket to user)
    const scope = validateScope(req.query.scope === undefined ? 'user' : req.query.scope);
    const allowed = ['active', 'archived', 'superseded', 'all'];
    const status = allowed.includes(req.query.status) ? req.query.status : 'active';
    res.json({ memory: masterMemoryService.listForScope(scope, status).map(toPublic) });
  }));

  router.get('/candidates', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'master memory candidates require human (cookie) auth' });
    }
    const scope = validateScope(req.query.scope === undefined ? 'user' : req.query.scope);
    const status = req.query.status === undefined ? 'pending' : req.query.status;
    if (!VALID_CANDIDATE_STATUSES.includes(status)) {
      throw new BadRequestError(`status must be one of ${VALID_CANDIDATE_STATUSES.join('|')}`);
    }
    res.json({ candidates: masterMemoryService.listCandidates(scope, status) });
  }));

  router.post('/candidates/:id/promote', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'master memory candidate promotion requires human (cookie) auth' });
    }
    const result = masterMemoryService.promoteCandidate({ candidateId: req.params.id });
    if (!result) throw new NotFoundError('master memory candidate not found');
    if (!result.promoted) {
      const status = result.reason === 'cap_rejected' ? 'pending' : 'rejected';
      return res.status(409).json({ candidate: { id: result.candidateId, status }, reason: result.reason });
    }
    res.json({
      memory: toPublic(result.item),
      candidate: { id: result.candidateId, status: result.merged ? 'merged' : 'promoted', promoted_to: result.item.id },
    });
  }));

  // Post-hoc correction CRUD for master memory. Cookie-only: bearer/none can
  // stage candidates, but cannot mutate the active injected user-memory set.
  router.patch('/:id', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'master memory correction requires human (cookie) auth' });
    }
    const { id } = req.params;
    const item = masterMemoryService.getMemoryItem(id);
    if (!item) throw new NotFoundError('master memory item not found');

    const body = req.body || {};
    const action = body.action;
    let result;
    try {
      if (action === 'update') {
        const patch = {};
        if (body.content !== undefined) {
          if (typeof body.content !== 'string' || !body.content.trim()) throw new BadRequestError('content is required');
          patch.content = body.content;
        }
        if (body.importance !== undefined) {
          const importance = Number(body.importance);
          if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
            throw new BadRequestError('importance must be an integer 1-10');
          }
          patch.importance = importance;
        }
        if (body.pinned !== undefined) patch.pinned = !!body.pinned;
        if (!Object.keys(patch).length) throw new BadRequestError('at least one of content|importance|pinned is required');
        result = masterMemoryService.updateMemory(id, patch);
      } else if (action === 'archive') {
        result = masterMemoryService.archiveMemory(id);
      } else if (action === 'restore') {
        result = masterMemoryService.restoreMemory(id);
        if (result && result.skipped && result.reason === 'cap_rejected') {
          return res.status(409).json({ memory: null, reason: 'cap_rejected' });
        }
      } else if (action === 'pin') {
        if (body.pinned === undefined) throw new BadRequestError('pinned is required');
        result = masterMemoryService.pinMemory(id, !!body.pinned);
      } else if (action === 'review') {
        result = masterMemoryService.markReviewed(id);
      } else {
        throw new BadRequestError('action must be one of update|archive|restore|pin|review');
      }
    } catch (err) {
      if (err && err.code === 'MEMORY_CONTENT_REJECTED') {
        throw new BadRequestError(`content rejected: ${err.message.replace(/^content rejected:\s*/, '')}`);
      }
      if (err && err.code === 'MEMORY_DUPLICATE') {
        throw new BadRequestError(err.message);
      }
      throw err;
    }
    if (!result) {
      throw new BadRequestError(`action "${action}" is not applicable to an item in status "${item.status}"`);
    }
    res.json({ memory: toPublic(result) });
  }));

  // Explicit "remember this" — cookie (human) writes ACTIVE user memory; bearer/none stage a sanitized
  // R4 candidate for human approval. Fail-closed on missing auth.
  router.post('/remember', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    if (!req.auth || !['cookie', 'bearer', 'none'].includes(req.auth.method)) {
      return res.status(500).json({ error: 'auth_misconfigured' });
    }
    const isHumanActive = req.auth.method === 'cookie';

    const body = req.body || {};
    // default only when ABSENT; an invalid scope fails closed rather than writing active user memory (Codex SERIOUS)
    const scope = validateScope((body.scope === undefined || body.scope === null) ? 'user' : body.scope);
    const rawContent = typeof body.content === 'string' ? body.content : '';
    const { kind, factKey } = body;
    if (!rawContent.trim()) throw new BadRequestError('content is required');
    if (!VALID_KINDS.includes(kind)) throw new BadRequestError(`kind must be one of ${VALID_KINDS.join('|')}`);

    let importance;
    if (body.importance !== undefined && body.importance !== null) {
      importance = Number(body.importance); // not parseInt — reject "7abc"/7.9 (Codex NIT)
      if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
        throw new BadRequestError('importance must be an integer 1-10');
      }
    }

    try {
      const content = sanitizeMasterContent(rawContent);
      if (!isHumanActive) {
        if (kind === 'fact') {
          throw new BadRequestError('facts require human (cookie) auth and cannot be staged as a candidate');
        }
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
        const candidate = masterMemoryService.createCandidate({
          scope,
          rule: 'R4',
          rawJson: {
            schema_version: 1,
            rule: 'R4',
            kind,
            content,
            factKey: null,
            importance: importance ?? null,
          },
          dedupKey: `r4:${kind}::${hash}`,
        });
        return res.status(202).json({
          candidate: toPublicCandidate(candidate),
          origin: req.auth.method === 'bearer' ? 'pm' : 'anon',
        });
      }

      const fk = kind === 'fact' ? validateFactKey(factKey) : null;
      let item;
      if (kind === 'fact') {
        // human fact through the fact_key supersede path (origin='human').
        item = masterMemoryService.upsertFact({ scope, factKey: fk, content, importance, origin: 'human' });
      } else {
        item = masterMemoryService.remember({ scope, kind, content, importance });
      }
      res.status(201).json({ memory: toPublic(item) });
    } catch (err) {
      // The service sanitizes at write (secret redact + injection reject); surface a rejection as 400.
      if (err && err.code === 'MEMORY_CONTENT_REJECTED') {
        throw new BadRequestError(`content rejected: ${err.message.replace(/^content rejected:\s*/, '')}`);
      }
      throw err;
    }
  }));

  return router;
}

module.exports = { createMasterMemoryRouter };
