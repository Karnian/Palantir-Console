const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createRunsRouter({ runService, lifecycleService, executionEngine, streamJsonEngine, conversationService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { task_id, status } = req.query;
    const runs = runService.listRuns({ task_id, status });
    res.json({ runs });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const run = runService.getRun(req.params.id);
    res.json({ run });
  }));

  router.get('/:id/events', asyncHandler(async (req, res) => {
    const afterId = req.query.after ? Number(req.query.after) : undefined;
    const events = runService.getRunEvents(req.params.id, afterId);
    res.json({ events });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const run = runService.createRun(req.body || {});
    res.status(201).json({ run });
  }));

  router.patch('/:id/status', asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    const run = runService.updateRunStatus(req.params.id, status);
    res.json({ run });
  }));

  // Send input to a running agent.
  //
  // v3 Phase 1.5: this endpoint is now a thin alias for
  //   POST /api/conversations/worker:<runId>/message
  // so every worker direct-chat path goes through conversationService and
  // therefore triggers the parent-notice router (lock-in #2, principle 9).
  // The pre-1.5 code called lifecycleService.sendAgentInput directly,
  // which bypassed the notice queue and violated principle 9.
  //
  // Backward-compatible fallback: if conversationService is not wired (old
  // test setups), fall back to lifecycleService directly.
  router.post('/:id/input', asyncHandler(async (req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

    if (conversationService) {
      try {
        const result = conversationService.sendMessage(`worker:${req.params.id}`, { text });
        // Preserve legacy alias contract: { status: 'ok' }. The newer
        // conversationService shape ({ status: 'sent', target: {...} }) is
        // surfaced under `delivery` so callers that want the extra detail
        // can still pull it out, but the top-level `status` must stay 'ok'
        // or the existing UI treats the call as a failure (spec §9.3).
        return res.json({ status: 'ok', delivery: result });
      } catch (err) {
        if (err && err.httpStatus) {
          return res.status(err.httpStatus).json({ error: err.message });
        }
        throw err;
      }
    }

    if (!lifecycleService) {
      return res.status(501).json({ error: 'Lifecycle service not configured' });
    }
    const sent = lifecycleService.sendAgentInput(req.params.id, text);
    if (!sent) return res.status(502).json({ error: 'Failed to deliver input to agent' });
    res.json({ status: 'ok' });
  }));

  // Cancel a running agent
  router.post('/:id/cancel', asyncHandler(async (req, res) => {
    if (!lifecycleService) {
      return res.status(501).json({ error: 'Lifecycle service not configured' });
    }
    lifecycleService.cancelRun(req.params.id);
    res.json({ status: 'ok' });
  }));

  // Get live output from agent's tmux/subprocess
  router.get('/:id/output', asyncHandler(async (req, res) => {
    if (!executionEngine) {
      return res.status(501).json({ error: 'Execution engine not configured' });
    }
    const lines = Math.min(Math.max(1, Number(req.query.lines || 100)), 2000);
    // Try streamJsonEngine first (claude workers), fall back to executionEngine (tmux)
    const output = (streamJsonEngine && streamJsonEngine.getOutput(req.params.id, lines))
      || executionEngine.getOutput(req.params.id, lines);
    res.json({ output });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    // Kill any running process before deleting
    const run = runService.getRun(req.params.id);
    if (['running', 'queued', 'needs_input'].includes(run.status)) {
      if (lifecycleService) {
        try { lifecycleService.cancelRun(req.params.id); } catch {}
      } else if (executionEngine) {
        try { executionEngine.kill(req.params.id); } catch {}
      }
    }
    runService.deleteRun(req.params.id);
    res.json({ status: 'ok' });
  }));

  return router;
}

module.exports = { createRunsRouter };
