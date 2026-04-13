const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

function createSkillPacksRouter({ skillPackService }) {
  const router = express.Router();

  // GET /api/skill-packs — list (optional ?scope=global|project&project_id=)
  router.get('/', asyncHandler(async (req, res) => {
    const { scope, project_id } = req.query;
    const packs = skillPackService.listSkillPacks({ scope, project_id });
    res.json({ skill_packs: packs });
  }));

  // GET /api/skill-packs/templates — list MCP server templates (read-only)
  router.get('/templates', asyncHandler(async (req, res) => {
    const templates = skillPackService.listMcpTemplates();
    res.json({ templates });
  }));

  // POST /api/skill-packs ��� create
  router.post('/', asyncHandler(async (req, res) => {
    const pack = skillPackService.createSkillPack(req.body || {});
    res.status(201).json({ skill_pack: pack });
  }));

  // GET /api/skill-packs/:id — get
  router.get('/:id', asyncHandler(async (req, res) => {
    const pack = skillPackService.getSkillPack(req.params.id);
    res.json({ skill_pack: pack });
  }));

  // PATCH /api/skill-packs/:id — update
  router.patch('/:id', asyncHandler(async (req, res) => {
    const pack = skillPackService.updateSkillPack(req.params.id, req.body || {});
    res.json({ skill_pack: pack });
  }));

  // DELETE /api/skill-packs/:id — delete
  router.delete('/:id', asyncHandler(async (req, res) => {
    skillPackService.deleteSkillPack(req.params.id);
    res.json({ status: 'ok' });
  }));

  // GET /api/skill-packs/:id/export — export as JSON (Phase 4-3)
  router.get('/:id/export', asyncHandler(async (req, res) => {
    const pack = skillPackService.getSkillPack(req.params.id);
    // Strip internal fields
    const exported = {
      name: pack.name,
      description: pack.description,
      scope: pack.scope,
      icon: pack.icon,
      color: pack.color,
      priority: pack.priority,
      prompt_full: pack.prompt_full,
      prompt_compact: pack.prompt_compact,
      mcp_servers: pack.mcp_servers,
      checklist: pack.checklist,
      conflict_policy: pack.conflict_policy,
      inject_checklist: pack.inject_checklist,
      requires_capabilities: pack.requires_capabilities,
    };
    res.json({ skill_pack: exported });
  }));

  // POST /api/skill-packs/import — import from JSON (Phase 4-3)
  router.post('/import', asyncHandler(async (req, res) => {
    const { skill_pack: data, project_id } = req.body || {};
    if (!data || !data.name) {
      return res.status(400).json({ error: 'skill_pack with name is required' });
    }
    // Override project_id if provided
    const createData = {
      ...data,
      project_id: project_id || data.project_id,
    };
    const pack = skillPackService.createSkillPack(createData);
    res.status(201).json({ skill_pack: pack });
  }));

  return router;
}

// Project binding sub-router: mounted at /api/projects
function createProjectBindingsRouter({ skillPackService }) {
  const router = express.Router();

  // GET /api/projects/:id/skill-packs
  router.get('/:id/skill-packs', asyncHandler(async (req, res) => {
    const bindings = skillPackService.listProjectBindings(req.params.id);
    res.json({ bindings });
  }));

  // POST /api/projects/:id/skill-packs
  router.post('/:id/skill-packs', asyncHandler(async (req, res) => {
    const binding = skillPackService.bindToProject(req.params.id, req.body || {});
    res.status(201).json({ binding });
  }));

  // PATCH /api/projects/:id/skill-packs/:packId
  router.patch('/:id/skill-packs/:packId', asyncHandler(async (req, res) => {
    const binding = skillPackService.updateProjectBinding(req.params.id, req.params.packId, req.body || {});
    res.json({ binding });
  }));

  // DELETE /api/projects/:id/skill-packs/:packId
  router.delete('/:id/skill-packs/:packId', asyncHandler(async (req, res) => {
    skillPackService.unbindFromProject(req.params.id, req.params.packId);
    res.json({ status: 'ok' });
  }));

  return router;
}

// Task binding sub-router: mounted at /api/tasks
function createTaskBindingsRouter({ skillPackService }) {
  const router = express.Router();

  // GET /api/tasks/:id/skill-packs
  router.get('/:id/skill-packs', asyncHandler(async (req, res) => {
    const bindings = skillPackService.listTaskBindings(req.params.id);
    res.json({ bindings });
  }));

  // POST /api/tasks/:id/skill-packs — pinned_by is server-decided (always 'user' from API)
  router.post('/:id/skill-packs', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const binding = skillPackService.bindToTask(req.params.id, {
      ...body,
      callerType: 'user', // UI/API = always 'user'
    });
    res.status(201).json({ binding });
  }));

  // DELETE /api/tasks/:id/skill-packs/:packId
  router.delete('/:id/skill-packs/:packId', asyncHandler(async (req, res) => {
    skillPackService.unbindFromTask(req.params.id, req.params.packId, { callerType: 'user' });
    res.json({ status: 'ok' });
  }));

  return router;
}

// Run snapshots sub-router: mounted at /api/runs
function createRunSnapshotsRouter({ skillPackService }) {
  const router = express.Router();

  // GET /api/runs/:id/skill-packs
  router.get('/:id/skill-packs', asyncHandler(async (req, res) => {
    const snapshots = skillPackService.listRunSnapshots(req.params.id);
    // Attach acceptance checks if available
    const checks = skillPackService.listAcceptanceChecks(req.params.id);
    const checksMap = {};
    for (const c of checks) {
      if (!checksMap[c.check_index]) checksMap[c.check_index] = c;
    }
    res.json({ skill_packs: snapshots, acceptance_checks: checks });
  }));

  // PATCH /api/runs/:id/skill-packs/checks — update check state (Phase 4-4)
  router.patch('/:id/skill-packs/checks', asyncHandler(async (req, res) => {
    const { checks } = req.body || {};
    if (!Array.isArray(checks)) {
      return res.status(400).json({ error: 'checks must be an array of { check_index, checked }' });
    }
    skillPackService.updateAcceptanceChecks(req.params.id, checks);
    const updated = skillPackService.listAcceptanceChecks(req.params.id);
    res.json({ acceptance_checks: updated });
  }));

  return router;
}

// Attach sub-router factories as static methods for app.js wiring
createSkillPacksRouter.projectBindings = createProjectBindingsRouter;
createSkillPacksRouter.taskBindings = createTaskBindingsRouter;
createSkillPacksRouter.runSnapshots = createRunSnapshotsRouter;

module.exports = { createSkillPacksRouter };
