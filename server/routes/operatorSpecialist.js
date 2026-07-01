'use strict';

/**
 * Operator specialist entry route (P-B2c-3).
 *
 * The ONLY external surface that reaches `specialistService.invokeSpecialist`.
 * A human (cookie) or PM/CLI (bearer) POSTs a one-shot folder-less specialist
 * turn; the specialist runs deny-by-default on the dedicated backend and its
 * trace rides the origin run's event stream.
 *
 * Tier2 REST capability enforcement is intentionally ABSENT (Codex + athena
 * convergence): the specialist backend exposes the model only text + the single
 * server-executed `registry_metadata_search` tool — NO network/http/shell tool —
 * so a running specialist physically cannot reach any REST route. Route-level
 * capability gating would be dead code. The additive allowlist in the backend is
 * the authoritative boundary.
 *
 * This router is mounted ONLY when the specialist feature is enabled
 * (PALANTIR_OPERATOR_SPECIALIST=1 + a backend); when off the route does not exist.
 */

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError } = require('../utils/errors');
const { canonicalConversationId } = require('../utils/conversationId'); // PM→Operator Phase 0: dual-read origin guard

// Bound model-bound inputs to keep token cost + injection surface in check. The
// fixed safety preamble (buildSpecialistSystemPrompt) is always prepended and is
// never overridable, so persona/userText cannot weaken the deny-by-default policy.
const USER_TEXT_MAX = 8000;
const ID_MAX = 256; // profileId / originRunId — bounded; they reach trace payloads
// A live manager turn is the only valid trace anchor for a specialist it delegates.
const ACTIVE_ORIGIN_STATUSES = new Set(['running', 'needs_input']);

function createOperatorSpecialistRouter({ specialistService, runService, operatorProfileService }) {
  if (!specialistService || typeof specialistService.invokeSpecialist !== 'function') {
    throw new Error('createOperatorSpecialistRouter: specialistService is required');
  }
  if (!runService || typeof runService.getRun !== 'function') {
    throw new Error('createOperatorSpecialistRouter: runService is required');
  }
  if (!operatorProfileService || typeof operatorProfileService.getProfile !== 'function') {
    throw new Error('createOperatorSpecialistRouter: operatorProfileService is required');
  }
  const router = express.Router();

  // POST /api/operator/specialist
  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const { profileId, persona, capabilities, userText, originRunId, originConversationId } = body;

    // ── request validation (clear 400s before delegating) ──
    if (typeof userText !== 'string' || userText.trim() === '') {
      throw new BadRequestError('userText is required');
    }
    if (userText.length > USER_TEXT_MAX) {
      throw new BadRequestError(`userText too long (max ${USER_TEXT_MAX} chars)`);
    }
    if (typeof profileId !== 'string' || profileId.trim() === '') {
      throw new BadRequestError('profileId is required');
    }
    if (profileId.length > ID_MAX) {
      throw new BadRequestError(`profileId too long (max ${ID_MAX} chars)`);
    }
    if (typeof originRunId !== 'string' || originRunId.trim() === '') {
      throw new BadRequestError('originRunId is required');
    }
    if (originRunId.length > ID_MAX) {
      throw new BadRequestError(`originRunId too long (max ${ID_MAX} chars)`);
    }
    // Contract A (PF-3): the operator profile is authoritative for persona +
    // capabilities. Reject request-level values (rather than silently discarding)
    // so there is no audit ambiguity about what actually ran. Use `!== undefined`
    // (not `!= null`): JSON can only send `null`, and an explicit `"persona": null`
    // is a PRESENT field that must be rejected, not treated as absent (Codex R2).
    if (persona !== undefined) {
      throw new BadRequestError('persona is defined by the operator profile, not the request');
    }
    if (capabilities !== undefined) {
      throw new BadRequestError('capabilities are defined by the operator profile, not the request');
    }
    if (originConversationId != null && typeof originConversationId !== 'string') {
      throw new BadRequestError('originConversationId must be a string');
    }

    // ── origin-run gate ── (getRun throws NotFoundError → 404 if missing)
    // The specialist is invoked in the context of an ACTIVE MANAGER turn; events
    // are emitted onto that run's stream. A worker / terminal run is rejected.
    //
    // ACCEPTED TRACE-INTEGRITY DEBT (MD-3, user decision 2026-07-01): the gate is
    // "is this SOME active manager run", NOT "is this the CALLER's own run". With a
    // shared PALANTIR_TOKEN there is no per-caller identity, so a manager COULD name
    // another active manager's run as originRunId → the specialist trace
    // (specialist:invoked/result) would land on THAT run's stream. This is bounded to
    // trace-attribution confusion — NO content leak (run:event frames + event payloads
    // carry lengths/ids, plus a capped error message on the error path, but never
    // memory/prompt/output) — and single-tenant + trusted
    // managers make it out of the threat model. MD-2a already mitigates the ACCIDENTAL
    // case (each manager is told its own top_run_id/pm_run_id). Enforcing self-reference
    // needs a minted per-run secret (env→header→validate) and is deferred to a
    // multi-tenant initiative; the self-ref-not-enforced behavior is locked by
    // specialist-entry.test.js so a future change is a conscious one.
    const originRun = runService.getRun(originRunId);
    if (originRun.is_manager !== 1) { // strict (SQLite 0/1); not a truthy check
      throw new BadRequestError('originRunId must reference a manager run');
    }
    if (!ACTIVE_ORIGIN_STATUSES.has(originRun.status)) {
      throw new BadRequestError(`originRunId must reference an active run (status: ${originRun.status})`);
    }
    // Codex R2 SERIOUS: validate the conflict HERE (clean 400) — otherwise the
    // service throws a plain Error → errorHandler 500 leaking the internal message.
    // dual-read (PM→Operator Phase 0, Codex R3): canonical compare so a `pm:` caller
    // and a migrated `operator:` origin run (or vice-versa) don't false-reject.
    if (originConversationId != null
      && canonicalConversationId(originConversationId) !== canonicalConversationId(originRun.conversation_id)) {
      throw new BadRequestError('originConversationId does not match the origin run');
    }

    // Resolve the profile (getProfile throws NotFoundError → 404 for an unknown
    // id). Contract A: the profile's persona + capabilities are authoritative;
    // its stored capabilities are already filtered to valid caps (PF-1), and
    // createSpecialistContext fail-closes on anything unknown.
    const profile = operatorProfileService.getProfile(profileId);

    // Delegate. invokeSpecialist re-validates the run, builds a specialist context,
    // injects User memory, runs the backend, and emits specialist:invoked/result/
    // error on the origin run.
    let result;
    try {
      result = await specialistService.invokeSpecialist({
        profileId,
        persona: profile.persona,
        capabilities: profile.capabilities,
        userText,
        originRunId,
        originConversationId,
      });
    } catch (err) {
      // MD-3 timeout contract: the backend tags a deadline breach with
      // code 'specialist:timeout' — surface it as 504 Gateway Timeout (a
      // distinct, retryable signal) rather than a generic 500. Other failures
      // propagate to the central errorHandler unchanged.
      if (err && err.code === 'specialist:timeout') {
        return res.status(504).json({ error: 'specialist_timeout' });
      }
      throw err;
    }

    res.json(result);
  }));

  return router;
}

module.exports = { createOperatorSpecialistRouter };
