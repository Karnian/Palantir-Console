'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');
const { sanitizeProposalContent } = require('../services/memorySanitize');

const L1_KINDS = new Set(['convention', 'pitfall', 'heuristic', 'constraint']);
const MASTER_KINDS = new Set(['constraint', 'preference', 'commitment', 'decision', 'pattern']);
const MAX_CONTENT = 2000;

function proposalBody(req) {
  if (!req.auth || !['cookie', 'bearer', 'worker', 'none'].includes(req.auth.method)) {
    const err = new Error('auth_misconfigured');
    err.httpStatus = 500;
    throw err;
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  // Owner identity is derived from the route's authoritative run/conversation.
  // Reject owner-like fields rather than silently ignoring a caller attempting
  // to steer storage to another scope.
  const forbidden = ['owner_id', 'ownerId', 'project_id', 'projectId', 'profile_id', 'profileId', 'scope'];
  if (forbidden.some((key) => Object.hasOwn(body, key))) {
    throw new BadRequestError('memory proposal owner/scope is server-derived');
  }
  const sanitized = sanitizeProposalContent(body.content, { maxLen: MAX_CONTENT });
  if (!sanitized.ok) {
    throw new BadRequestError(`content rejected: ${sanitized.reasons.join(',') || 'sanitize_failed'}`);
  }
  let importance = null;
  if (body.importance !== undefined && body.importance !== null) {
    importance = Number(body.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 10) {
      throw new BadRequestError('importance must be an integer 1-10');
    }
  }
  return {
    target: body.target == null ? null : String(body.target),
    kind: typeof body.kind === 'string' ? body.kind.trim() : '',
    content: sanitized.content,
    importance,
  };
}

function createDedupKey(kind, content, { master = false } = {}) {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 32);
  return master ? `r4:${kind}::${hash}` : `r4:${kind}:${hash}`;
}

function createMemoryProposalsRouter({
  conversationService,
  runService,
  memoryService,
  masterMemoryService,
  projectService,
} = {}) {
  const router = express.Router();

  router.post('/conversations/:id/memory/propose', asyncHandler(async (req, res) => {
    const input = proposalBody(req);
    const resolved = conversationService && conversationService.resolveConversation(req.params.id);
    if (!resolved || !resolved.run || !resolved.run.is_manager) {
      throw new NotFoundError('active manager conversation not found');
    }
    if (
      req.auth.actor === 'manager'
      && req.auth.managerRunId !== resolved.run.id
    ) {
      throw new ForbiddenError('manager capability does not own this conversation');
    }

    if (resolved.kind === 'top') {
      if (input.target && input.target !== 'user') {
        throw new BadRequestError('Top memory proposals target user memory only');
      }
      if (!MASTER_KINDS.has(input.kind)) {
        throw new BadRequestError(`kind must be one of ${Array.from(MASTER_KINDS).join('|')}`);
      }
      const candidate = masterMemoryService.createCandidate({
        scope: 'user',
        rule: 'R4',
        rawJson: {
          schema_version: 1,
          rule: 'R4',
          kind: input.kind,
          content: input.content,
          importance: input.importance,
          proposed_by: { type: 'top', run_id: resolved.run.id },
        },
        dedupKey: createDedupKey(input.kind, input.content, { master: true }),
      });
      return res.status(202).json({
        candidate: { id: candidate.id, status: candidate.status },
        owner: { type: 'user', id: 'user' },
      });
    }

    if (resolved.kind !== 'pm') {
      throw new BadRequestError('manager conversation cannot propose memory');
    }
    if (!L1_KINDS.has(input.kind)) {
      throw new BadRequestError(`kind must be one of ${Array.from(L1_KINDS).join('|')}`);
    }
    const target = input.target || 'workspace';
    if (!['workspace', 'profile'].includes(target)) {
      throw new BadRequestError('Operator memory proposal target must be workspace|profile');
    }

    let candidate;
    let owner;
    if (target === 'workspace') {
      const turnContext = conversationService
        && typeof conversationService.getLastTurnContext === 'function'
        ? conversationService.getLastTurnContext(resolved.run.id)
        : null;
      const projectId = turnContext
        ? turnContext.workspaceProjectId
        : resolved.projectId;
      if (!projectId) throw new BadRequestError('Operator turn has no workspace memory owner');
      if (projectService) projectService.getProject(projectId);
      candidate = memoryService.createCandidate({
        projectId,
        rule: 'R4',
        rawJson: {
          schema_version: 1,
          rule: 'R4',
          kind: input.kind,
          content: input.content,
          importance: input.importance,
          proposed_by: { type: 'operator', run_id: resolved.run.id },
        },
        dedupKey: createDedupKey(input.kind, input.content),
      });
      owner = { type: 'workspace', id: projectId };
    } else {
      const instanceId = resolved.instanceId || resolved.run.operator_instance_id;
      const instance = instanceId && runService && runService.getOperatorInstance(instanceId);
      if (!instance || !instance.profile_id) {
        throw new BadRequestError('Operator conversation has no profile owner');
      }
      candidate = memoryService.createCandidate({
        profileId: instance.profile_id,
        rule: 'R4',
        rawJson: {
          schema_version: 1,
          rule: 'R4',
          kind: input.kind,
          content: input.content,
          importance: input.importance,
          proposed_by: { type: 'operator', run_id: resolved.run.id },
        },
        dedupKey: createDedupKey(input.kind, input.content),
      });
      owner = { type: 'profile', id: instance.profile_id };
    }

    res.status(202).json({
      candidate: { id: candidate.id, status: candidate.status },
      owner,
    });
  }));

  router.post('/runs/:id/memory/propose', asyncHandler(async (req, res) => {
    const input = proposalBody(req);
    if (req.auth.method === 'worker' && req.auth.runId !== req.params.id) {
      throw new ForbiddenError('worker proposal token does not match this run');
    }
    if (input.target && input.target !== 'workspace') {
      throw new BadRequestError('Worker memory proposals target their workspace only');
    }
    if (!L1_KINDS.has(input.kind)) {
      throw new BadRequestError(`kind must be one of ${Array.from(L1_KINDS).join('|')}`);
    }
    let run;
    try { run = runService.getRun(req.params.id); } catch { run = null; }
    if (!run || run.is_manager) {
      throw new NotFoundError('workspace worker run not found');
    }
    if (!['running', 'needs_input'].includes(run.status)) {
      throw new ForbiddenError('worker run is no longer active');
    }
    const projectId = req.auth.method === 'worker'
      ? req.auth.projectId
      : runService.getRunEvents(run.id)
        .filter((event) => event.event_type === 'security:worker_capability_scoped')
        .map((event) => {
          try { return JSON.parse(event.payload_json || '{}').project_id || null; } catch { return null; }
        })
        .find(Boolean) || run.project_id;
    if (!projectId) throw new NotFoundError('workspace worker run not found');
    if (projectService) projectService.getProject(projectId);
    const rawJson = {
        schema_version: 1,
        rule: 'R4',
        kind: input.kind,
        content: input.content,
        importance: input.importance,
        proposed_by: { type: 'worker', run_id: run.id, task_id: run.task_id || null },
    };
    const dedupKey = createDedupKey(input.kind, input.content);
    const quota = memoryService.createWorkerCandidate({
      runId: run.id,
      projectId,
      rule: 'R4',
      rawJson,
      dedupKey,
    });
    if (quota.limited) {
      const err = new Error(`worker memory proposal quota exceeded (${quota.limit} per run)`);
      err.status = 429;
      err.details = { limit: quota.limit };
      throw err;
    }
    const candidate = quota.candidate;
    res.status(202).json({
      candidate: { id: candidate.id, status: candidate.status },
      owner: { type: 'workspace', id: projectId },
    });
  }));

  return router;
}

module.exports = { createMemoryProposalsRouter };
