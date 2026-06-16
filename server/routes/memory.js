// server/routes/memory.js
//
// Memory Layer: read-only GET surface for L1 project memory.
//
//   GET /api/projects/:projectId/memory  -> { memory: [...active rows] }
//
// Read→inject only. No external write endpoint here: the `remember` write API
// is PR2b (R4) and is gated on a cookie-vs-bearer actor distinction (spec §8).
// PR2a adds R6 env facts whose evidence_json carries run provenance, so the
// GET response is field-whitelisted (no evidence_json / content_hash leak).

const crypto = require('node:crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const { sanitizeProposalContent, redactSecrets, detectInjection } = require('../services/memorySanitize');

const VALID_KINDS = ['convention', 'pitfall', 'heuristic', 'constraint', 'fact'];
const MAX_REMEMBER_LEN = 2000;

// PR2a: whitelist the fields the GET surface exposes. evidence_json (run/task
// provenance, potential secrets), content_hash, superseded_by, rowid_pk are
// deliberately excluded (Codex cross-review BLOCKER — evidence must not leak).
const PUBLIC_FIELDS = [
  'id', 'project_id', 'kind', 'content', 'fact_key',
  'origin', 'importance', 'confidence', 'source_count', 'status',
  'pinned', 'valid_to', 'archived_at',
  'created_at', 'updated_at', 'reviewed_at',
];

function toPublicMemory(row) {
  const out = {};
  for (const field of PUBLIC_FIELDS) {
    if (row && field in row) out[field] = row[field];
  }
  return out;
}

// Recursively redact secrets from an evidence snapshot before exposing it on the
// provenance endpoint. evidence_json is otherwise whitelisted OUT of the list
// surface (it can carry run/task provenance + excerpts); the correction UI needs
// to show it, so redact secret-looking strings and bound size/depth (Codex).
function redactEvidence(value, depth = 0) {
  if (depth > 6) return null;
  if (typeof value === 'string') return redactSecrets(value).text.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactEvidence(v, depth + 1));
  if (value && typeof value === 'object') {
    // null-proto output + redact KEYS too: a secret can appear as an object key
    // (e.g. {"ghp_…": true}), not just a value (Codex SERIOUS).
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      out[redactSecrets(String(k)).text.slice(0, 200)] = redactEvidence(v, depth + 1);
    }
    return out;
  }
  return value;
}

function createMemoryRouter({ memoryService, projectService }) {
  const router = express.Router();

  router.get('/:projectId/memory', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const { projectId } = req.params;
    if (!projectId) throw new BadRequestError('projectId is required');
    // Verify the project exists before listing — otherwise a typo'd or
    // deleted project id returns a misleading 200 [] (Codex cross-review).
    if (projectService) {
      let project = null;
      try { project = projectService.getProject(projectId); } catch { project = null; }
      if (!project) throw new NotFoundError(`project not found: ${projectId}`);
    }
    // ?status=active(default)|archived|superseded|all — correction UI needs the
    // non-active rows; injection always uses the default 'active'.
    const allowed = ['active', 'archived', 'superseded', 'all'];
    const status = allowed.includes(req.query.status) ? req.query.status : 'active';
    res.json({ memory: memoryService.listForProject(projectId, status).map(toPublicMemory) });
  }));

  // ML R4: explicit "remember this" write. Actor split by how the caller
  // authenticated (req.auth.method, set in middleware/auth.js):
  //   - cookie (a human in the browser) -> ACTIVE immediately (non-fact via
  //     createMemoryItem origin='human'; fact via upsertFact origin='human').
  //   - bearer (PM/CLI) OR none (auth-disabled) -> a R4 CANDIDATE, never
  //     directly active; the distiller promotes it like any other candidate, so
  //     a leaked token / open dev box can stage but not inject active memory.
  //   - kind='fact' is human(cookie)-only — the promoter rejects fact candidates.
  // Caveat: under a single shared PALANTIR_TOKEN the cookie/bearer split is a
  // best-effort actor hint, not spoof-proof (see auth.js).
  router.post('/:projectId/memory/remember', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const { projectId } = req.params;
    if (!projectId) throw new BadRequestError('projectId is required');
    if (projectService) {
      let project = null;
      try { project = projectService.getProject(projectId); } catch { project = null; }
      if (!project) throw new NotFoundError(`project not found: ${projectId}`);
    }

    // Fail closed: the auth middleware must have set req.auth. If it's missing,
    // the middleware wasn't mounted — refuse rather than defaulting to a method
    // (Codex SERIOUS: a write endpoint must not fail open).
    if (!req.auth || !['cookie', 'bearer', 'none'].includes(req.auth.method)) {
      return res.status(500).json({ error: 'auth_misconfigured' });
    }
    const method = req.auth.method;
    // ONLY a cookie-authenticated human writes active memory. bearer (PM/CLI)
    // and none (auth-disabled) are untrusted -> R4 candidate, never active.
    const isHumanActive = method === 'cookie';

    const body = req.body || {};
    const rawContent = typeof body.content === 'string' ? body.content : '';
    const { kind, factKey } = body;
    if (!rawContent.trim()) throw new BadRequestError('content is required');
    if (!VALID_KINDS.includes(kind)) throw new BadRequestError(`kind must be one of ${VALID_KINDS.join('|')}`);
    if (kind === 'fact') {
      if (typeof factKey !== 'string' || !factKey.trim()) {
        throw new BadRequestError('factKey is required for a fact');
      }
      const fk = factKey.trim();
      // ASCII dot-separated identifiers ONLY. An allowlist rejects Unicode dot
      // lookalikes (U+FF0E, U+2024, …) that would otherwise bypass the env.
      // reservation below (Codex SERIOUS d).
      if (!/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i.test(fk)) {
        throw new BadRequestError('fact_key must be ASCII dot-separated identifiers (a-z, 0-9, _, .)');
      }
      // The 'env.' fact_key namespace is reserved for the deterministic R6 rule;
      // a human/PM write there could silently clobber a system fact via the
      // fact_key supersede (Codex SERIOUS — origin-crossing supersede).
      if (fk.toLowerCase().startsWith('env.')) {
        throw new BadRequestError('fact_key prefix "env." is reserved for system facts');
      }
      // Facts are human(cookie)-only: the promoter rejects fact candidates, so a
      // bearer/none fact would be unpromotable (Codex BLOCKER, first round).
      if (!isHumanActive) {
        throw new BadRequestError('facts can only be remembered via human (cookie) auth');
      }
    }
    let importance;
    if (body.importance !== undefined && body.importance !== null) {
      importance = Number.parseInt(body.importance, 10);
      if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
        throw new BadRequestError('importance must be an integer 1-10');
      }
    }

    // Sanitize before anything touches memory — EVERY kind redacts secrets,
    // rejects injection markers, and is length-capped, so neither a human active
    // write nor a PM candidate can smuggle a secret/instruction into the PM
    // context (Codex SERIOUS). Facts differ only by skipping the prose length
    // FLOOR (they're short key-values) — see the fact branch below.
    let content;
    if (kind === 'fact') {
      // Facts skip the prose length floor (they're short key-values) but a fact
      // is rendered into the PM memory block too, so it MUST reject injection
      // and collapse whitespace — otherwise a newline role-marker (\nSystem: …)
      // breaks out of the bullet and becomes a PM instruction (Codex BLOCKER
      // c/e). Secrets are redacted as well.
      if (detectInjection(rawContent)) {
        throw new BadRequestError('content rejected: injection');
      }
      content = redactSecrets(rawContent.trim()).text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMEMBER_LEN);
    } else {
      const s = sanitizeProposalContent(rawContent, { maxLen: MAX_REMEMBER_LEN });
      if (!s.ok) throw new BadRequestError(`content rejected: ${s.reasons.join(',') || 'sanitize_failed'}`);
      content = s.content;
    }

    if (isHumanActive) {
      let item;
      if (kind === 'fact') {
        item = memoryService.upsertFact({ projectId, factKey: factKey.trim(), content, importance, origin: 'human' });
      } else {
        item = memoryService.createMemoryItem({ projectId, kind, content, origin: 'human', importance, status: 'active' });
      }
      return res.status(201).json({ memory: item ? toPublicMemory(item) : null, origin: 'human' });
    }

    // bearer (PM/CLI) or none (untrusted) -> R4 candidate (non-fact only; facts
    // refused above). Content is already sanitized. Deduped by kind+content;
    // distilled later, never directly active — a leaked token can stage but not
    // inject active memory.
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
    const cand = memoryService.createCandidate({
      projectId,
      rule: 'R4',
      rawJson: { schema_version: 1, rule: 'R4', kind, content, importance: importance ?? null },
      dedupKey: `r4:${kind}:${hash}`,
    });
    return res.status(202).json({ candidate: cand ? { id: cand.id, status: cand.status } : null, origin: method === 'bearer' ? 'pm' : 'anon' });
  }));

  // PR4: post-hoc correction. PATCH an item by id within its project.
  //   { action: 'update', content }   -> edit active content (re-sanitized)
  //   { action: 'archive' }           -> hide from injection (active -> archived)
  //   { action: 'restore' }           -> archived -> active
  //   { action: 'review' }            -> stamp reviewed_at
  //   { action: 'pin', pinned }       -> protect from PR5 decay/cap
  router.patch('/:projectId/memory/:id', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    // Correction mutates the active injected set — human(cookie)-only, mirroring
    // the R4 active-write rule (bearer/none can stage candidates but must not
    // mutate active memory). Fail closed (Codex SERIOUS — actor-split bypass).
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'memory correction requires human (cookie) auth' });
    }
    const { projectId, id } = req.params;
    if (!projectId || !id) throw new BadRequestError('projectId and id are required');
    const item = memoryService.getMemoryItem(id);
    // not-found OR cross-project access both look like 404 (don't leak existence).
    if (!item || item.project_id !== projectId) throw new NotFoundError('memory item not found');

    const body = req.body || {};
    const action = body.action;
    let result;
    if (action === 'update') {
      const raw = typeof body.content === 'string' ? body.content : '';
      if (!raw.trim()) throw new BadRequestError('content is required');
      // re-sanitize edited content with the same rules as remember.
      let content;
      if (item.kind === 'fact') {
        if (detectInjection(raw)) throw new BadRequestError('content rejected: injection');
        content = redactSecrets(raw.trim()).text.replace(/\s+/g, ' ').trim().slice(0, MAX_REMEMBER_LEN);
      } else {
        const s = sanitizeProposalContent(raw, { maxLen: MAX_REMEMBER_LEN });
        if (!s.ok) throw new BadRequestError(`content rejected: ${s.reasons.join(',') || 'sanitize_failed'}`);
        content = s.content;
      }
      try {
        result = memoryService.updateMemoryContent({ id, content });
      } catch (err) {
        if (err && err.code === 'MEMORY_DUPLICATE') throw new BadRequestError(err.message);
        throw err;
      }
    } else if (action === 'archive') {
      result = memoryService.archiveMemory(id);
    } else if (action === 'restore') {
      try {
        result = memoryService.restoreMemory(id);
      } catch (err) {
        if (err && (err.code === 'MEMORY_DUPLICATE' || err.code === 'MEMORY_CAP_FULL')) throw new BadRequestError(err.message);
        throw err;
      }
    } else if (action === 'review') {
      result = memoryService.markReviewed(id);
    } else if (action === 'pin') {
      result = memoryService.setPinned({ id, pinned: !!body.pinned });
    } else {
      throw new BadRequestError('action must be one of update|archive|restore|review|pin');
    }
    if (!result) {
      throw new BadRequestError(`action "${action}" is not applicable to an item in status "${item.status}"`);
    }
    res.json({ memory: toPublicMemory(result) });
  }));

  // PR4: provenance for a single item — evidence snapshot, recursively redacted.
  router.get('/:projectId/memory/:id/provenance', asyncHandler(async (req, res) => {
    if (!memoryService) {
      return res.status(501).json({ error: 'memoryService_unavailable' });
    }
    const { projectId, id } = req.params;
    if (!projectId || !id) throw new BadRequestError('projectId and id are required');
    const item = memoryService.getMemoryItem(id);
    if (!item || item.project_id !== projectId) throw new NotFoundError('memory item not found');
    let evidence = {};
    try { const p = JSON.parse(item.evidence_json || '{}'); if (p && typeof p === 'object') evidence = p; } catch { evidence = {}; }
    res.json({ id: item.id, origin: item.origin, evidence: redactEvidence(evidence) });
  }));

  return router;
}

module.exports = { createMemoryRouter, toPublicMemory };
