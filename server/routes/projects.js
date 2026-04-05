const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createProjectsRouter({ projectService, taskService }) {
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

  return router;
}

module.exports = { createProjectsRouter };
