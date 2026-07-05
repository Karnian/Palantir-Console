const express = require('express');
const { asyncHandler } = require('../middleware/asyncHandler');
const { validateCreateProject, validateUpdateProject } = require('../middleware/validate');
const { BadRequestError } = require('../utils/errors');

function normalizeQueueNodeId(value) {
  const normalized = String(value || '').trim();
  return normalized || 'local';
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function normalizeProjectSourceType(value) {
  return value === null || value === undefined || value === '' ? 'legacy_directory' : value;
}

function normalizeMcpConfigSource(value) {
  return value === null || value === undefined || value === '' ? 'legacy_control_plane_path' : value;
}

function mergeProjectSource(current, body) {
  const base = current || {};
  const patch = body || {};
  const sourceType = normalizeProjectSourceType(hasOwn(patch, 'source_type') ? patch.source_type : base.source_type);
  const inheritedRepoRef = base.source_type === 'legacy_directory' && base.repo_ref === 'HEAD' ? null : base.repo_ref;
  return {
    source_type: sourceType,
    repo_url: hasOwn(patch, 'repo_url') ? patch.repo_url : base.repo_url,
    repo_ref: hasOwn(patch, 'repo_ref') ? patch.repo_ref : inheritedRepoRef,
    repo_subdir: hasOwn(patch, 'repo_subdir') ? patch.repo_subdir : base.repo_subdir,
    node_id: hasOwn(patch, 'node_id') ? patch.node_id : base.node_id,
    directory: hasOwn(patch, 'directory') ? patch.directory : base.directory,
    allow_non_git_dir: hasOwn(patch, 'allow_non_git_dir') ? patch.allow_non_git_dir : base.allow_non_git_dir,
    mcp_config_path: hasOwn(patch, 'mcp_config_path') ? patch.mcp_config_path : base.mcp_config_path,
    mcp_config_source: normalizeMcpConfigSource(
      hasOwn(patch, 'mcp_config_source') ? patch.mcp_config_source : base.mcp_config_source,
    ),
    mcp_config_relpath: hasOwn(patch, 'mcp_config_relpath') ? patch.mcp_config_relpath : base.mcp_config_relpath,
  };
}

function hasParentSegment(value) {
  return String(value || '')
    .split(/[\\/]+/)
    .some((segment) => segment === '..');
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== '';
}

function assertRepoRelpath(value) {
  if (!value || typeof value !== 'string') {
    throw new BadRequestError('mcp_config_relpath is required when mcp_config_source is repo_relpath');
  }
  if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new BadRequestError('mcp_config_relpath must be relative');
  }
  if (hasParentSegment(value)) {
    throw new BadRequestError('mcp_config_relpath must not contain ..');
  }
  if (!value.endsWith('.json')) {
    throw new BadRequestError('mcp_config_relpath must end with .json');
  }
}

function assertCoherentSource(effective) {
  const sourceType = normalizeProjectSourceType(effective?.source_type);
  if (sourceType === 'git') {
    if (!isPresent(effective.repo_url)) throw new BadRequestError('repo_url is required for git projects');
    if (isPresent(effective.directory)) throw new BadRequestError('directory is not allowed when source_type is git');
    if (Number(effective.allow_non_git_dir || 0) !== 0) {
      throw new BadRequestError('allow_non_git_dir is not allowed when source_type is git');
    }
    if (effective.mcp_config_source === 'repo_relpath') {
      assertRepoRelpath(effective.mcp_config_relpath);
    }
    return;
  }

  if (isPresent(effective.repo_url)) throw new BadRequestError('repo_url is not allowed when source_type is legacy_directory');
  if (isPresent(effective.repo_ref)) throw new BadRequestError('repo_ref is not allowed when source_type is legacy_directory');
  if (isPresent(effective.repo_subdir)) throw new BadRequestError('repo_subdir is not allowed when source_type is legacy_directory');
  if (effective.mcp_config_source === 'repo_relpath') {
    throw new BadRequestError('mcp_config_source repo_relpath is not allowed when source_type is legacy_directory');
  }
  if (isPresent(effective.mcp_config_relpath)) {
    throw new BadRequestError('mcp_config_relpath is not allowed when source_type is legacy_directory');
  }
}

function createProjectsRouter({
  projectService,
  taskService,
  runService,
  projectBriefService,
  operatorCleanupService,
  nodeBindingValidator,
  lifecycleService,
  repoPreflightService,
}) {
  const router = express.Router();

  async function preflightRepoIfNeeded(effective) {
    if (effective.source_type !== 'git' || !repoPreflightService) return {};
    const result = await repoPreflightService.preflight({
      repoUrl: effective.repo_url,
      repoRef: effective.repo_ref,
      nodeId: effective.node_id,
    });
    if (result?.skipped) return {};
    return {
      last_repo_preflight_at: new Date().toISOString(),
      last_repo_preflight_error: null,
      ...(result?.fingerprint ? { repo_remote_fingerprint: result.fingerprint } : {}),
    };
  }

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

  router.post('/', validateCreateProject, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const effective = mergeProjectSource(null, body);
    assertCoherentSource(effective);
    const repoPreflightFields = await preflightRepoIfNeeded(effective);
    if (effective.source_type !== 'git' && nodeBindingValidator) {
      await nodeBindingValidator.validateBinding({
        nodeId: body.node_id,
        directory: body.directory,
        mcpConfigPath: body.mcp_config_path,
      });
    }
    const project = projectService.createProject({ ...body, ...repoPreflightFields });
    res.status(201).json({ project });
  }));

  router.patch('/:id', validateUpdateProject, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const current = projectService.getProject(req.params.id);
    const effective = mergeProjectSource(current, body);
    assertCoherentSource(effective);
    const repoPreflightFields = await preflightRepoIfNeeded(effective);
    if (effective.source_type !== 'git' && nodeBindingValidator && (
      hasOwn(body, 'node_id') || hasOwn(body, 'directory') || hasOwn(body, 'mcp_config_path')
    )) {
      // Validate the EFFECTIVE binding (current row merged with the patch),
      // not just the fields present in the body. Rebinding node_id alone to a
      // remote node while leaving the stored (local-path) directory untouched
      // must still validate that directory against the new node — that stale
      // local↔remote path mismatch is exactly what bind-time validation exists
      // to catch. `getProject` throws 404 for a missing id before we touch the
      // executor.
      await nodeBindingValidator.validateBinding({
        nodeId: hasOwn(body, 'node_id') ? body.node_id : current.node_id,
        directory: hasOwn(body, 'directory') ? body.directory : current.directory,
        mcpConfigPath: hasOwn(body, 'mcp_config_path') ? body.mcp_config_path : current.mcp_config_path,
      });
    }
    const project = projectService.updateProject(req.params.id, { ...body, ...repoPreflightFields });
    res.json({ project });
  }));

  router.post('/:id/retarget-queued', asyncHandler(async (req, res) => {
    if (!runService || typeof runService.listRuns !== 'function' || typeof runService.retargetQueuedRuns !== 'function') {
      return res.status(501).json({ error: 'runService not wired' });
    }
    if (!taskService || typeof taskService.getTask !== 'function') {
      return res.status(501).json({ error: 'taskService not wired' });
    }

    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, 'fromNodeId')) {
      throw new BadRequestError('fromNodeId is required');
    }

    const project = projectService.getProject(req.params.id);
    const fromNodeId = normalizeQueueNodeId(body.fromNodeId);
    const toNodeId = normalizeQueueNodeId(project.node_id);
    const queuedRuns = runService.listRuns({ status: 'queued' }) || [];
    const runIds = [];

    for (const run of queuedRuns) {
      if (!run || Number(run.is_manager) !== 0) continue;
      if (normalizeQueueNodeId(run.node_id) !== fromNodeId) continue;
      if (!run.task_id) continue;
      const task = taskService.getTask(run.task_id);
      if (task && String(task.project_id || '') === String(project.id)) {
        runIds.push(run.id);
      }
    }

    if (runIds.length === 0) {
      return res.json({ moved: 0 });
    }

    if ((project.source_type || 'legacy_directory') === 'git') {
      await preflightRepoIfNeeded(mergeProjectSource(project, { node_id: toNodeId }));
    } else if (nodeBindingValidator) {
      await nodeBindingValidator.validateBinding({
        nodeId: toNodeId,
        directory: project.directory,
      });
    }

    const result = runService.retargetQueuedRuns(runIds, fromNodeId, toNodeId);
    if (result.moved > 0 && lifecycleService && typeof lifecycleService.scheduleDrainForNode === 'function') {
      lifecycleService.scheduleDrainForNode(toNodeId);
    }
    res.json({ moved: result.moved, runIds });
  }));

  router.post('/:id/reset', asyncHandler(async (req, res) => {
    projectService.getProject(req.params.id); // verify exists
    if (!operatorCleanupService) {
      return res.status(501).json({ error: 'operatorCleanupService not wired' });
    }
    const result = operatorCleanupService.reset(req.params.id);
    res.json({ status: 'reset', projectId: req.params.id, ...result });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    // v3 Phase 3a: tear down any live Operator for this project BEFORE deleting
    // the row (spec §5 책임 분담표). operatorCleanupService is idempotent and
    // safe to call on projects that never had an Operator. The project row
    // delete cascades to project_briefs, but the in-memory adapter
    // session and managerRegistry slot are NOT cascaded by SQLite and
    // must be scrubbed explicitly.
    //
    // Codex R1 finding #2: if dispose throws we MUST abort the delete.
    // Otherwise we lose the only durable reference (the project row)
    // needed to locate and clean up the orphaned in-memory Operator state
    // later. Failing the request lets the user retry once the adapter
    // is healthy, or manually /reset first.
    if (operatorCleanupService) {
      try {
        operatorCleanupService.dispose(req.params.id);
      } catch (err) {
        return res.status(502).json({
          error: 'pm_dispose_failed',
          message: `Refusing to delete project — Operator teardown failed: ${err.message}. Try POST /api/manager/pm/${req.params.id}/reset first, or retry after resolving the underlying adapter error.`,
        });
      }
    }
    projectService.deleteProject(req.params.id);
    res.json({ status: 'ok' });
  }));

  // v3 Phase 1: project brief endpoints (conventions, known_pitfalls).
  // pm_thread_id/pm_adapter are NOT exposed here — those are managed by
  // operatorCleanupService (Phase 3a), not by user edits. Read returns those
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
