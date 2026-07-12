const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateCreateTask, validateUpdateTask } = require('../middleware/validate');
const { NotFoundError } = require('../utils/errors');
const { redactSecrets } = require('../services/memorySanitize');

// G4c: worker-controlled strings are capped + secret-redacted server-side before
// they reach the UI (codex plan-review SERIOUS). output_tail is deliberately NOT
// surfaced. Preact escapes on render; this is defense-in-depth + payload bound.
const CAP = 2000;
function cap(v, n = CAP) {
  if (v == null) return null;
  const s = String(v);
  return s.length <= n ? s : s.slice(0, n);
}
function redactCap(v, n = CAP) {
  if (v == null) return null;
  let text = String(v);
  try { text = redactSecrets(text).text; } catch { /* redactor best-effort */ }
  return cap(text, n);
}

// Aggregate a goal task's detail for the TaskDetail UI — no N+1, allowlist-only
// projection (no absolute workspace paths, no output_tail, capped/redacted).
function buildGoalDetail(task, runs, check) {
  if (!task || !task.goal_enabled) return { goal_enabled: false };
  const goalRuns = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.goal_active && !r.is_manager)
    .sort((a, b) => Number(a._seq || 0) - Number(b._seq || 0)); // rowid ASC = attempt order
  const attempts = goalRuns.map((r) => {
    let acceptance = null;
    try {
      const a = r.acceptance_json ? JSON.parse(r.acceptance_json) : null;
      if (a && typeof a === 'object') {
        acceptance = { status: a.status, passed: a.passed, kind: a.kind, gate: !!a.gate, name: cap(a.name, 120), reason: cap(a.reason, 120) };
      }
    } catch { acceptance = null; }
    let goalReport = null;
    try {
      const g = r.goal_report ? JSON.parse(r.goal_report) : null;
      if (g && typeof g === 'object') {
        goalReport = {
          goal_status: cap(g.goal_status, 60),
          summary: redactCap(g.summary),
          blockers: Array.isArray(g.blockers) ? g.blockers.slice(0, 10).map((b) => redactCap(b, 300)) : [],
        };
      }
    } catch { goalReport = null; }
    return {
      run_id: r.id,
      attempt: Number(r.retry_count || 0) + 1,
      status: r.status,
      verdict: r.goal_verdict || null,
      verdict_reason: cap(r.goal_verdict_reason, 120),
      acceptance,
      goal_report: goalReport,
      created_at: r.created_at,
    };
  });
  let delivery = null;
  try {
    const d = task.goal_delivery_json ? JSON.parse(task.goal_delivery_json) : null;
    if (d && typeof d === 'object') {
      delivery = {
        mode: d.mode || null,
        state: d.state || null,
        run_id: d.run_id || null,
        reason: cap(d.reason, 120),
        branch: cap(d.branch, 200),
        base: cap(d.base, 80),
        stat: cap(d.stat, 4000),
        bundle: d.bundle ? { files: Array.isArray(d.bundle.files) ? d.bundle.files.length : 0, truncated: !!d.bundle.truncated } : null,
        delivered_at: d.delivered_at || null,
      };
    }
  } catch { delivery = null; }
  return {
    goal_enabled: true,
    goal_max_attempts: task.goal_max_attempts,
    acceptance_criteria: cap(task.acceptance_criteria, 4000),
    verify_check: check ? { id: check.id, name: cap(check.name, 120), kind: check.kind, created_by: check.created_by } : null,
    attempts,
    delivery,
    tip_run_id: attempts.length ? attempts[attempts.length - 1].run_id : null,
  };
}

function createTasksRouter({ taskService, lifecycleService, presetService, goalDeliveryService = null, runService = null, verifyCheckService = null }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { project_id, status } = req.query;
    const tasks = taskService.listTasks({ project_id, status });
    res.json({ tasks });
  }));

  router.post('/', validateCreateTask, asyncHandler(async (req, res) => {
    const body = req.body || {};
    if ('preferred_preset_id' in body) {
      const pid = body.preferred_preset_id;
      if (pid !== null && pid !== undefined) {
        if (typeof pid !== 'string' || !pid) {
          return res.status(400).json({ error: 'preferred_preset_id must be a string or null' });
        }
        if (presetService) {
          try { presetService.getPreset(pid); }
          catch (e) {
            if (e instanceof NotFoundError || e.name === 'NotFoundError') {
              return res.status(400).json({ error: `Unknown preset id: ${pid}` });
            }
            throw e;
          }
        }
      }
    }
    const task = taskService.createTask(body);
    res.status(201).json({ task });
  }));

  // IMPORTANT: /reorder MUST come before /:id to avoid being captured as a param
  router.patch('/reorder', asyncHandler(async (req, res) => {
    const { orderedIds } = req.body || {};
    taskService.reorderTasks(orderedIds);
    res.json({ status: 'ok' });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const task = taskService.getTask(req.params.id);
    res.json({ task });
  }));

  router.patch('/:id', validateUpdateTask, asyncHandler(async (req, res) => {
    const body = req.body || {};
    // Gap #1: validate preferred_preset_id before writing to DB
    if ('preferred_preset_id' in body) {
      const pid = body.preferred_preset_id;
      if (pid !== null && pid !== undefined) {
        if (typeof pid !== 'string' || !pid) {
          return res.status(400).json({ error: 'preferred_preset_id must be a string or null' });
        }
        if (presetService) {
          try { presetService.getPreset(pid); }
          catch (e) {
            if (e instanceof NotFoundError || e.name === 'NotFoundError') {
              return res.status(400).json({ error: `Unknown preset id: ${pid}` });
            }
            throw e;
          }
        }
      }
    }
    const task = taskService.updateTask(req.params.id, body);
    res.json({ task });
  }));

  router.patch('/:id/status', asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    const task = taskService.updateTaskStatus(req.params.id, status);
    res.json({ task });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    taskService.deleteTask(req.params.id);
    res.json({ status: 'ok' });
  }));

  // G4c §5h: read-only goal detail aggregate for the TaskDetail UI. Standard app
  // auth; allowlist-projected + capped/redacted (buildGoalDetail).
  router.get('/:id/goal', asyncHandler(async (req, res) => {
    const task = taskService.getTask(req.params.id); // 404 if missing
    if (!task.goal_enabled) return res.json({ goal: { goal_enabled: false } });
    const runs = runService ? runService.listRuns({ task_id: task.id }) : [];
    let check = null;
    if (task.verify_check_id && verifyCheckService) {
      try { check = verifyCheckService.getCheck(task.verify_check_id); } catch { check = null; }
    }
    res.json({ goal: buildGoalDetail(task, runs, check) });
  }));

  // G4b §5j: manual re-deliver (e.g. after a transient promote failure). This
  // ONLY re-runs deliver(), which enforces the gate2-tip rule — there is NO path
  // to promote a non-gate2 attempt (codex plan-review B3). Human (cookie) only:
  // delivery force-points a git ref, a human-authority action.
  router.post('/:id/goal/deliver', asyncHandler(async (req, res) => {
    if (!goalDeliveryService) {
      return res.status(501).json({ error: 'Goal delivery not configured' });
    }
    if (!req.auth || req.auth.method !== 'cookie') {
      return res.status(403).json({ error: 'goal delivery requires human (cookie) auth' });
    }
    taskService.getTask(req.params.id); // 404 if missing
    const result = await goalDeliveryService.deliver(req.params.id);
    res.json({ result });
  }));

  // Execute: spawn agent for this task
  router.post('/:id/execute', asyncHandler(async (req, res) => {
    if (!lifecycleService) {
      const task = taskService.getTask(req.params.id);
      return res.json({ status: 'not_implemented', message: 'Lifecycle service not configured', task });
    }
    const { agent_profile_id, prompt, skill_pack_ids, preset_id, pm_run_id } = req.body || {};
    if (!agent_profile_id) {
      return res.status(400).json({ error: 'agent_profile_id is required' });
    }
    if (skill_pack_ids !== undefined && !Array.isArray(skill_pack_ids)) {
      return res.status(400).json({ error: 'skill_pack_ids must be an array' });
    }
    if (preset_id !== undefined && preset_id !== null && typeof preset_id !== 'string') {
      return res.status(400).json({ error: 'preset_id must be a string' });
    }
    const run = await lifecycleService.executeTask(req.params.id, {
      agentProfileId: agent_profile_id,
      prompt: prompt || '',
      skillPackIds: skill_pack_ids || undefined,
      presetId: preset_id || undefined,
      pmRunId: typeof pm_run_id === 'string' ? pm_run_id : null,
    });
    res.status(201).json({ run });
  }));

  return router;
}

module.exports = { createTasksRouter, buildGoalDetail };
