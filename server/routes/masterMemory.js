// server/routes/masterMemory.js
//
// L2 Master Memory (user-scoped, cross-project) HTTP surface. P1b.
//
//   GET  /api/master-memory            -> { memory: [...active user-scope rows] }
//   POST /api/master-memory/remember   -> human (cookie) writes ACTIVE user memory
//
// Mirrors routes/memory.js (field whitelist, cookie-actor gate, fact env. reservation). De-scoped per
// docs/specs/master-memory-brief.md §12: governed retrieval only. The bearer/none CANDIDATE path and the
// deterministic capture rules are P1c (no distiller/candidate table for L2 yet), so P1b accepts ONLY a
// cookie-authenticated human write and rejects bearer/none rather than failing open.

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');

const VALID_KINDS = ['constraint', 'preference', 'commitment', 'decision', 'fact', 'pattern'];
const PUBLIC_FIELDS = [
  'id', 'scope', 'project_id', 'kind', 'content', 'fact_key',
  'origin', 'importance', 'confidence', 'source_count', 'status',
  'pinned', 'valid_to', 'archived_at', 'created_at', 'updated_at', 'reviewed_at',
];
const VALID_SCOPES = ['user', 'cross_project'];

function toPublic(row) {
  const out = {};
  for (const f of PUBLIC_FIELDS) if (row && f in row) out[f] = row[f];
  return out;
}

function createMasterMemoryRouter({ masterMemoryService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    // default only when ABSENT; an invalid scope fails closed (Codex SERIOUS — don't silently bucket to user)
    const scope = req.query.scope === undefined ? 'user' : req.query.scope;
    if (!VALID_SCOPES.includes(scope)) throw new BadRequestError(`scope must be one of ${VALID_SCOPES.join('|')}`);
    const allowed = ['active', 'archived', 'superseded', 'all'];
    const status = allowed.includes(req.query.status) ? req.query.status : 'active';
    res.json({ memory: masterMemoryService.listForScope(scope, status).map(toPublic) });
  }));

  // Explicit "remember this" — cookie (human) only writes ACTIVE user memory. bearer/none are rejected
  // in P1b (the candidate path that would stage an untrusted write is P1c). Fail-closed on missing auth.
  router.post('/remember', asyncHandler(async (req, res) => {
    if (!masterMemoryService) return res.status(501).json({ error: 'masterMemoryService_unavailable' });
    if (!req.auth || !['cookie', 'bearer', 'none'].includes(req.auth.method)) {
      return res.status(500).json({ error: 'auth_misconfigured' });
    }
    if (req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'master memory remember requires human (cookie) auth' });
    }

    const body = req.body || {};
    // default only when ABSENT; an invalid scope fails closed rather than writing active user memory (Codex SERIOUS)
    const scope = (body.scope === undefined || body.scope === null) ? 'user' : body.scope;
    if (!VALID_SCOPES.includes(scope)) throw new BadRequestError(`scope must be one of ${VALID_SCOPES.join('|')}`);
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
      let item;
      if (kind === 'fact') {
        const fk = typeof factKey === 'string' ? factKey.trim() : '';
        if (!fk) throw new BadRequestError('factKey is required for a fact');
        if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(fk)) {
          throw new BadRequestError('fact_key must be ASCII dot-separated identifiers (a-z, 0-9, _, .)');
        }
        if (fk.toLowerCase().startsWith('env.')) {
          throw new BadRequestError('fact_key prefix "env." is reserved for system facts');
        }
        // human fact through the fact_key supersede path (origin='human').
        item = masterMemoryService.upsertFact({ scope, factKey: fk, content: rawContent, importance, origin: 'human' });
      } else {
        item = masterMemoryService.remember({ scope, kind, content: rawContent, importance });
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
