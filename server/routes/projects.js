const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createProjectsRouter({ projectService, taskService, projectBriefService }) {
  const router = express.Router();

  router.get('/', asyncHandler(async (req, res) => {
    const projects = projectService.listProjects();
    res.json({ projects });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const project = projectService.getProject(req.params.id);
    res.json({ project });
  }));

  router.get('/:id/tasks', asyncHandler(async (req, res) => {
    projectService.getProject(req.params.id); // verify exists
    const tasks = taskService.listTasks({ project_id: req.params.id });
    res.json({ tasks });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const project = projectService.createProject(req.body || {});
    res.status(201).json({ project });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const project = projectService.updateProject(req.params.id, req.body || {});
    res.json({ project });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    projectService.deleteProject(req.params.id);
    res.json({ status: 'ok' });
  }));

  // v3 Phase 1: project brief endpoints (conventions, known_pitfalls).
  // pm_thread_id/pm_adapter are NOT exposed here — those are managed by
  // pmCleanupService (Phase 3a), not by user edits. Read returns those
  // fields for visibility but PATCH ignores them.
  router.get('/:id/brief', asyncHandler(async (req, res) => {
    if (!projectBriefService) return res.status(501).json({ error: 'project_brief_service_unavailable' });
    projectService.getProject(req.params.id); // verify exists
    const brief = projectBriefService.ensureBrief(req.params.id);
    res.json({ brief });
  }));

  router.patch('/:id/brief', asyncHandler(async (req, res) => {
    if (!projectBriefService) return res.status(501).json({ error: 'project_brief_service_unavailable' });
    projectService.getProject(req.params.id); // verify exists
    // v3 Phase 1: true partial update. Only keys *actually present* in the
    // request body are forwarded to updateBrief. Destructuring would always
    // include both keys as undefined, which updateBrief would then write as
    // NULL, silently wiping the omitted field. Codex caught this in Phase 1
    // cross-review as a merge blocker.
    //
    // pm_thread_id / pm_adapter are also in the internal managed set — even
    // if the client sends them, they do not enter `fields` and cannot overwrite
    // the managed columns.
    const body = req.body || {};
    const fields = {};
    if ('conventions' in body) fields.conventions = body.conventions;
    if ('known_pitfalls' in body) fields.known_pitfalls = body.known_pitfalls;
    const brief = projectBriefService.updateBrief(req.params.id, fields);
    res.json({ brief });
  }));

  return router;
}

module.exports = { createProjectsRouter };
