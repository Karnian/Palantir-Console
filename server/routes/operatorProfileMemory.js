'use strict';

// Profile-scoped R4 "remember" (R4b): POST /api/operator/profiles/:id/memory/remember.
//
// Mirrors the workspace remember (routes/memory.js) but keys memory by a PROFILE
// owner (owner_type='profile', owner_id=<operator_profiles.id>, project_id NULL).
// Actor split is identical: a cookie-authenticated human writes ACTIVE memory
// (createMemoryItem, R4a-ready); bearer (PM/CLI) or none (untrusted) stages an R4
// CANDIDATE (never directly active). All content is sanitized (secret redaction +
// injection rejection + length cap) before it touches memory.
//
// Facts are NOT supported for profile memory: fact_key carries the env.* reserved
// namespace + upsertFact is not profile-wired (its revision path is workspace-only).
// Profile facts are rejected with a clear 400.

const crypto = require('node:crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');
const { sanitizeProposalContent } = require('../services/memorySanitize');

const VALID_KINDS = ['convention', 'pitfall', 'heuristic', 'constraint']; // no 'fact'
const MAX_REMEMBER_LEN = 2000;
const PUBLIC_FIELDS = ['id', 'owner_type', 'owner_id', 'kind', 'content', 'importance', 'confidence', 'status', 'origin', 'created_at'];

function toPublicMemory(row) {
  if (!row) return null;
  const out = {};
  for (const f of PUBLIC_FIELDS) if (f in row) out[f] = row[f];
  return out;
}

function createOperatorProfileMemoryRouter({ memoryService, operatorProfileService }) {
  if (!operatorProfileService || typeof operatorProfileService.getProfile !== 'function') {
    throw new Error('createOperatorProfileMemoryRouter: operatorProfileService is required');
  }
  const router = express.Router();

  router.post('/:id/memory/remember', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    // Fail closed FIRST: the auth middleware must have set req.auth (a write endpoint
    // must not fail open, and this must hold even for an unknown profile id — Codex
    // R4b R2 MINOR: auth guard precedes the profile lookup).
    if (!req.auth || !['cookie', 'bearer', 'none'].includes(req.auth.method)) {
      return res.status(500).json({ error: 'auth_misconfigured' });
    }
    const profileId = req.params.id;
    // Resolve the profile — getProfile throws NotFoundError → 404 for an unknown id.
    operatorProfileService.getProfile(profileId);
    // ONLY a cookie-authenticated human writes active memory; bearer/none → candidate.
    const isHumanActive = req.auth.method === 'cookie';

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const rawContent = typeof body.content === 'string' ? body.content : '';
    const { kind } = body;
    if (!rawContent.trim()) throw new BadRequestError('content is required');
    if (kind === 'fact') {
      throw new BadRequestError('facts are not supported for profile memory (workspace only)');
    }
    if (!VALID_KINDS.includes(kind)) {
      throw new BadRequestError(`kind must be one of ${VALID_KINDS.join('|')}`);
    }
    let importance;
    if (body.importance !== undefined && body.importance !== null) {
      importance = Number.parseInt(body.importance, 10);
      if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
        throw new BadRequestError('importance must be an integer 1-10');
      }
    }

    // Sanitize before anything touches memory (secret redact + injection reject + cap).
    const s = sanitizeProposalContent(rawContent, { maxLen: MAX_REMEMBER_LEN });
    if (!s.ok) throw new BadRequestError(`content rejected: ${s.reasons.join(',') || 'sanitize_failed'}`);
    const content = s.content;

    if (isHumanActive) {
      const item = memoryService.createMemoryItem({
        profileId, kind, content, origin: 'human', importance, status: 'active',
      });
      return res.status(201).json({ memory: toPublicMemory(item), origin: 'human' });
    }

    // bearer (PM/CLI) or none (untrusted) → R4 candidate. Deduped by kind+content;
    // distilled later (R4b-2), never directly active.
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
    const cand = memoryService.createCandidate({
      profileId,
      rule: 'R4',
      rawJson: { schema_version: 1, rule: 'R4', kind, content, importance: importance ?? null },
      dedupKey: `r4:${kind}:${hash}`,
    });
    return res.status(202).json({
      candidate: cand ? { id: cand.id, status: cand.status } : null,
      origin: req.auth.method === 'bearer' ? 'pm' : 'anon',
    });
  }));

  return router;
}

module.exports = { createOperatorProfileMemoryRouter };
