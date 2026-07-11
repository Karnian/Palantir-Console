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

function createVerifyChecksRouter({ verifyCheckService, taskService, goalFeatureActive = require('../services/goalMode').goalFeatureActive }) {
  const router = express.Router();

  // G2 §6 (Codex BLOCKER-1): the whole verify_check surface is inert unless goal
  // mode is active (PALANTIR_GOAL_MODE=1 + separated PALANTIR_PM_TOKEN). The
  // command-check cookie gate is only spoof-proof once the Operator no longer
  // holds PALANTIR_TOKEN, which only happens when goalFeatureActive() — so gate
  // the entire router on it to keep the security boundary consistent.
  router.use((req, res, next) => {
    if (!goalFeatureActive()) {
      return res.status(503).json({ error: 'goal mode not active — set PALANTIR_GOAL_MODE=1 with a separated PALANTIR_PM_TOKEN' });
    }
    next();
  });

  router.get('/', asyncHandler(async (req, res) => {
    const projectId = req.query.project_id;
    const checks = projectId ? verifyCheckService.listForProject(projectId) : verifyCheckService.listChecks();
    res.json({ checks });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    res.json({ check: verifyCheckService.getCheck(Number(req.params.id)) });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const body = req.body || {};
    // command checks are a shell-execution gate → human (cookie) only (§6).
    if (body.kind === 'command' && method !== 'cookie') {
      return res.status(403).json({ error: 'command verify_check requires human (cookie) auth' });
    }
    const check = verifyCheckService.createCheck(body, { actor: actorFor(method) });
    res.status(201).json({ check });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const id = Number(req.params.id);
    const existing = verifyCheckService.getCheck(id);
    if (existing.kind === 'command' && method !== 'cookie') {
      return res.status(403).json({ error: 'editing a command verify_check requires human (cookie) auth' });
    }
    const check = verifyCheckService.updateCheck(id, req.body || {}, { actor: actorFor(method) });
    res.json({ check });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
    const id = Number(req.params.id);
    const existing = verifyCheckService.getCheck(id);
    if (existing.kind === 'command' && method !== 'cookie') {
      return res.status(403).json({ error: 'deleting a command verify_check requires human (cookie) auth' });
    }
    res.json(verifyCheckService.deleteCheck(id));
  }));

  // POST /assign  { task_id, check_id|null } — assign (or clear) a task's Gate 1
  // check. command assignment is human-only (§6) and the check's project must
  // match the task's project (no cross-project command execution).
  router.post('/assign', asyncHandler(async (req, res) => {
    const method = requireAuth(req);
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
