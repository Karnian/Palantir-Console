const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateCreateTask, validateUpdateTask } = require('../middleware/validate');

function createTasksRouter({ taskService, lifecycleService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { project_id, status } = req.query;
    const tasks = taskService.listTasks({ project_id, status });
    res.json({ tasks });
  }));

  router.post('/', validateCreateTask, asyncHandler(async (req, res) => {
    const task = taskService.createTask(req.body || {});
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
    const task = taskService.updateTask(req.params.id, req.body || {});
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

  // Execute: spawn agent for this task
  router.post('/:id/execute', asyncHandler(async (req, res) => {
    if (!lifecycleService) {
      const task = taskService.getTask(req.params.id);
      return res.json({ status: 'not_implemented', message: 'Lifecycle service not configured', task });
    }
    const { agent_profile_id, prompt } = req.body || {};
    if (!agent_profile_id) {
      return res.status(400).json({ error: 'agent_profile_id is required' });
    }
    const run = lifecycleService.executeTask(req.params.id, {
      agentProfileId: agent_profile_id,
      prompt: prompt || '',
    });
    res.status(201).json({ run });
  }));

  return router;
}

module.exports = { createTasksRouter };
