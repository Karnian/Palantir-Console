const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');

/**
 * Strip server-only fields before returning a skill_pack row to the client.
 * Per spec §6.2, `source_url` (full, query-included) must never be rendered
 * in UI/logs. Only `source_url_display` (query-stripped) is safe.
 */
function sanitizePack(row) {
  if (!row) return row;
  const { source_url: _, ...safe } = row;
  return safe;
}
function sanitizePacks(rows) {
  return Array.isArray(rows) ? rows.map(sanitizePack) : rows;
}

function createSkillPacksRouter({ skillPackService, registryService }) {
  const router = express.Router();

  // ─── Registry endpoints (must precede /:id routes) ───

  // GET /api/skill-packs/registry — registry listing + install status
  router.get('/registry', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const registry = registryService.getRegistry();
    // Build install status map
    const installed = skillPackService.listInstalledFromRegistry();
    const installMap = new Map();
    for (const row of installed) {
      installMap.set(row.registry_id, { localId: row.id, localVersion: row.registry_version });
    }
    // Annotate packs with install status
    const packs = (registry.packs || []).map(pack => {
      const info = installMap.get(pack.registry_id);
      return {
        ...pack,
        installed: !!info,
        localId: info ? info.localId : null,
        updateAvailable: info ? info.localVersion !== pack.registry_version : false,
        localVersion: info ? info.localVersion : null,
      };
    });
    res.json({
      source: registry.source,
      categories: registry.categories,
      packs,
    });
  }));

  // GET /api/skill-packs/registry/pack?id=<registryId> — single pack detail
  router.get('/registry/pack', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const registryId = req.query.id;
    if (!registryId) {
      return res.status(400).json({ error: 'id query parameter required' });
    }
    const pack = registryService.getRegistryPack(registryId);
    if (!pack) {
      return res.status(404).json({ error: `Registry pack not found: ${registryId}` });
    }
    // Add install status
    const local = skillPackService.findByRegistryId(registryId);
    res.json({
      pack: {
        ...pack,
        installed: !!local,
        localId: local ? local.id : null,
        localVersion: local ? local.registry_version : null,
        updateAvailable: local ? local.registry_version !== pack.registry_version : false,
      },
    });
  }));

  // POST /api/skill-packs/registry/install — install from registry
  router.post('/registry/install', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const { registry_id, confirmed_preview } = req.body || {};
    if (!registry_id) {
      return res.status(400).json({ error: 'registry_id is required' });
    }
    const registryPack = registryService.getRegistryPack(registry_id);
    if (!registryPack) {
      return res.status(404).json({ error: `Registry pack not found: ${registry_id}` });
    }
    const installed = skillPackService.installFromRegistry(registryPack, { confirmed_preview });
    res.status(201).json({ skill_pack: sanitizePack(installed) });
  }));

  // POST /api/skill-packs/registry/update — update installed pack from registry
  router.post('/registry/update', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const { registry_id } = req.body || {};
    if (!registry_id) {
      return res.status(400).json({ error: 'registry_id is required' });
    }
    const local = skillPackService.findByRegistryId(registry_id);
    if (!local) {
      return res.status(404).json({ error: `No installed pack found for registry_id: '${registry_id}'` });
    }
    const registryPack = registryService.getRegistryPack(registry_id);
    if (!registryPack) {
      return res.status(404).json({ error: `Registry pack not found: ${registry_id}` });
    }
    const updated = skillPackService.updateFromRegistry(local.id, registryPack);
    res.json({ skill_pack: sanitizePack(updated) });
  }));

  // POST /api/skill-packs/registry/refresh — deprecated in v1.1, kept for back-compat
  router.post('/registry/refresh', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const result = await registryService.refreshRemoteRegistry();
    res.json(result);
  }));

  // ─── v1.1: Install from URL ───

  router.post('/registry/install-url', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const { url, dry_run, preview_token, expected_hash } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: 'url required' });
    }

    const { canonicalUrl, displayUrl, pack, hash } = await registryService.fetchPackFromUrl(url);

    if (dry_run === true) {
      const token = registryService.issuePreviewToken(`url:${canonicalUrl}`, hash);
      return res.json({
        pack,
        hash,
        preview_token: token,
        source_url_display: displayUrl,
      });
    }

    if (!preview_token) {
      return res.status(400).json({ error: 'preview_token required for install (run dry_run first)' });
    }
    if (!expected_hash) {
      return res.status(400).json({ error: 'expected_hash required for install' });
    }
    registryService.consumePreviewToken(preview_token, `url:${canonicalUrl}`, expected_hash);

    // Gather bundled registry_ids for namespace collision check
    const bundledRegistry = registryService.getRegistry();
    const bundledRegistryIds = (bundledRegistry.packs || [])
      .map(p => p.registry_id)
      .filter(Boolean);

    const installed = skillPackService.installFromUrl({
      canonicalUrl, displayUrl, pack, hash, expected_hash, bundledRegistryIds,
    });
    res.status(201).json({ skill_pack: sanitizePack(installed) });
  }));

  router.post('/registry/check-update-url', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const { pack_id } = req.body || {};
    if (!pack_id) {
      return res.status(400).json({ error: 'pack_id required' });
    }
    const existing = skillPackService.getSkillPack(pack_id);
    if (existing.origin_type !== 'url' || !existing.source_url) {
      return res.status(400).json({ error: 'Not a URL-installed pack' });
    }

    const { pack, hash, displayUrl } = await registryService.fetchPackFromUrl(existing.source_url);
    const update_available = hash !== existing.source_hash;
    const token = registryService.issuePreviewToken(`pack:${pack_id}`, hash);

    res.json({
      update_available,
      new_hash: hash,
      new_pack_preview: pack,
      fetched_at: new Date().toISOString(),
      source_url_display: displayUrl,
      preview_token: token,
    });
  }));

  router.post('/registry/update-url', asyncHandler(async (req, res) => {
    if (!registryService) {
      return res.status(501).json({ error: 'Registry service not available' });
    }
    const { pack_id, preview_token, expected_hash } = req.body || {};
    if (!pack_id || !preview_token || !expected_hash) {
      return res.status(400).json({ error: 'pack_id, preview_token, expected_hash required' });
    }
    const existing = skillPackService.getSkillPack(pack_id);
    if (existing.origin_type !== 'url' || !existing.source_url) {
      return res.status(400).json({ error: 'Not a URL-installed pack' });
    }

    const { pack, hash } = await registryService.fetchPackFromUrl(existing.source_url);
    registryService.consumePreviewToken(preview_token, `pack:${pack_id}`, expected_hash);

    const updated = skillPackService.updateFromUrl({ pack_id, pack, hash, expected_hash });
    res.json({ skill_pack: sanitizePack(updated) });
  }));

  // ─── Existing Skill Pack CRUD ───

  // GET /api/skill-packs — list (optional ?scope=global|project&project_id=)
  router.get('/', asyncHandler(async (req, res) => {
    const { scope, project_id } = req.query;
    const packs = skillPackService.listSkillPacks({ scope, project_id });
    res.json({ skill_packs: sanitizePacks(packs) });
  }));

  // GET /api/skill-packs/templates — list MCP server templates (read-only)
  router.get('/templates', asyncHandler(async (req, res) => {
    const templates = skillPackService.listMcpTemplates();
    res.json({ templates });
  }));

  // POST /api/skill-packs — create (manual; origin_type='manual')
  router.post('/', asyncHandler(async (req, res) => {
    const pack = skillPackService.createSkillPack(req.body || {});
    res.status(201).json({ skill_pack: sanitizePack(pack) });
  }));

  // GET /api/skill-packs/:id — get
  router.get('/:id', asyncHandler(async (req, res) => {
    const pack = skillPackService.getSkillPack(req.params.id);
    res.json({ skill_pack: sanitizePack(pack) });
  }));

  // PATCH /api/skill-packs/:id — update
  router.patch('/:id', asyncHandler(async (req, res) => {
    const pack = skillPackService.updateSkillPack(req.params.id, req.body || {});
    res.json({ skill_pack: sanitizePack(pack) });
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
    // Override project_id if provided. Imports are marked origin_type='import'.
    const createData = {
      ...data,
      project_id: project_id || data.project_id,
      origin_type: 'import',
    };
    const pack = skillPackService.createSkillPack(createData);
    res.status(201).json({ skill_pack: sanitizePack(pack) });
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
