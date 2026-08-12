'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');

// G2 — verify_checks CRUD + task assignment (Gate 1, spec §5a/§5k-3/§6).
//
// Actor model (§6): the authenticated method decides provenance + authorization.
//   - cookie → human. May author/edit/delete/assign ANY check kind.
//   - bearer/none → operator. May author/edit ARTIFACT checks only (advisory,
//     no execution surface). COMMAND checks (a shell gate) are human-only —
//     creating/editing/deleting/assigning one requires cookie auth (fail-closed).
// created_by is derived here and passed to the service; it is NEVER read from
// the request body (Codex SERIOUS-5).

function requireAuth(req) {
  if (!req.auth || !['cookie', 'bearer', 'none'].includes(req.auth.method)) {
    const e = new Error('auth_misconfigured');
    e.status = 500;
    throw e;
  }
  return req.auth.method;
}
function actorFor(method) { return method === 'cookie' ? 'human' : 'operator'; }

const GOAL_INACTIVE_ERROR = 'goal mode not active — set PALANTIR_GOAL_MODE=1 with a separated PALANTIR_PM_TOKEN';

function createVerifyChecksRouter({ verifyCheckService, taskService, goalFeatureActive = require('../services/goalMode').goalFeatureActive }) {
  const router = express.Router();

  // A2 §1.1: the two failures are DISTINCT and must stay distinct.
  //   goal mode off  -> 503 (the feature is not available in this deployment)
  //   goal mode on, non-cookie caller -> 403 (the caller lacks authority; the
  //   pre-G2 human-only contract). Collapsing 403 into 503 tells an Operator
  //   "come back when goal mode is on" for a request that will NEVER be allowed
  //   to it, and erases the human-only signal G2 established.
  function requireCommandWrite(res, method) {
    if (!goalFeatureActive()) {
      res.status(503).json({ error: GOAL_INACTIVE_ERROR });
      return false;
    }
    if (method !== 'cookie') {
      res.status(403).json({ error: 'command verify_check requires human (cookie) auth' });
      return false;
    }
    return true;
  }

  router.get('/', asyncHandler(async (req, res) => {
    const projectId = req.query.project_id;
    let checks = projectId ? verifyCheckService.listForProject(projectId) : verifyCheckService.listChecks();
    if (!goalFeatureActive()) checks = checks.filter((check) => check.kind !== 'command');
    res.json({ checks });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const check = verifyCheckService.getCheck(Number(req.params.id));
    if (check.kind === 'command' && !goalFeatureActive()) {
      throw new NotFoundError(`verify_check not found: ${req.params.id}`);
    }
    res.json({ check });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const body = req.body || {};
    if (body.kind === 'command' && !requireCommandWrite(res, method)) return;
    const check = verifyCheckService.createCheck(body, {
      actor: actorFor(method),
      commandWritable: goalFeatureActive() && method === 'cookie',
    });
    res.status(201).json({ check });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const id = Number(req.params.id);
    const existing = verifyCheckService.getCheck(id);
    if (existing.kind === 'command' && !requireCommandWrite(res, method)) return;
    if (req.body && req.body.attest === true && method !== 'cookie') {
      return res.status(403).json({ error: 'attesting a verify_check requires human (cookie) auth' });
    }
    const check = verifyCheckService.updateCheck(id, req.body || {}, {
      actor: actorFor(method),
      commandWritable: goalFeatureActive() && method === 'cookie',
    });
    res.json({ check });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const id = Number(req.params.id);
    const existing = verifyCheckService.getCheck(id);
    if (existing.kind === 'command' && !requireCommandWrite(res, method)) return;
    res.json(verifyCheckService.deleteCheck(id, { actor: actorFor(method) }));
  }));

  // POST /assign  { task_id, check_id|null } — assign (or clear) a task's Gate 1
  // check. command assignment is human-only (§6) and the check's project must
  // match the task's project (no cross-project command execution).
  router.post('/assign', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    // §1.1: assign is goal-territory (Gate 1) — the WHOLE operation stays behind
    // the goal gate for every kind. The per-kind cookie rule below is unchanged
    // from G2: only COMMAND assignment is human-only. Requiring cookie for
    // artifact assignment too would silently remove an Operator capability that
    // A2 never set out to touch.
    if (!goalFeatureActive()) {
      return res.status(503).json({ error: GOAL_INACTIVE_ERROR });
    }
    if (!taskService) return res.status(501).json({ error: 'taskService unavailable' });
    const { task_id: taskId, check_id: checkId } = req.body || {};
    if (!taskId) throw new BadRequestError('task_id is required');
    const task = taskService.getTask(taskId); // throws 404 if absent

    if (checkId === null || checkId === undefined) {
      const updated = taskService.assignVerifyCheck(taskId, null);
      return res.json({ task: updated });
    }
    const check = verifyCheckService.getCheck(Number(checkId)); // 404 if absent
    if (check.kind === 'command' && method !== 'cookie') {
      return res.status(403).json({ error: 'assigning a command verify_check requires human (cookie) auth' });
    }
    if (check.project_id && check.project_id !== task.project_id) {
      throw new BadRequestError('check project_id must match the task project_id');
    }
    const updated = taskService.assignVerifyCheck(taskId, check.id);
    res.json({ task: updated });
  }));

  return router;
}

module.exports = { createVerifyChecksRouter };
