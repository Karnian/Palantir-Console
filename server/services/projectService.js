const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

const VALID_PM_ADAPTERS = ['claude', 'codex'];

function normalizePmAdapter(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!VALID_PM_ADAPTERS.includes(value)) {
    throw new BadRequestError(`Invalid preferred_pm_adapter: ${value} (valid: ${VALID_PM_ADAPTERS.join(', ')}, or null)`);
  }
  return value;
}

function normalizePmEnabled(value) {
  if (value === undefined) return undefined;
  // Accept boolean, 0/1, or null (→ default 1)
  if (value === null) return 1;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new BadRequestError(`Invalid pm_enabled: must be boolean or 0/1`);
}

function normalizeMcpConfigPath(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestError('mcp_config_path must be a string');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('/')) {
    throw new BadRequestError('mcp_config_path must be an absolute path (starting with /)');
  }
  if (!trimmed.endsWith('.json')) {
    throw new BadRequestError('mcp_config_path must end with .json');
  }
  return trimmed;
}

function normalizeTestCommand(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestError('test_command must be a string');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 500) {
    throw new BadRequestError('test_command must be 500 characters or fewer');
  }
  return trimmed;
}

function normalizeNodeId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestError('node_id must be a string or null');
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeAllowNonGitDir(value) {
  if (value === undefined) return undefined;
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0' || value === null) return 0;
  throw new BadRequestError('allow_non_git_dir must be boolean or 0/1');
}

function createProjectService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    getById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    getNodeById: db.prepare('SELECT * FROM nodes WHERE id = ?'),
    getBriefThread: db.prepare('SELECT pm_thread_id FROM project_briefs WHERE project_id = ?'),
    countLiveOperatorRuns: db.prepare(`
      SELECT COUNT(*) AS count FROM runs
      WHERE conversation_id = ?
        AND manager_layer = 'operator'
        AND is_manager = 1
        AND status IN ('queued', 'running', 'needs_input')
    `),
    insert: db.prepare(`
      INSERT INTO projects (
        id, name, directory, description, color, budget_usd,
        pm_enabled, preferred_pm_adapter, mcp_config_path, test_command,
        node_id, allow_non_git_dir
      )
      VALUES (
        @id, @name, @directory, @description, @color, @budget_usd,
        @pm_enabled, @preferred_pm_adapter, @mcp_config_path, @test_command,
        @node_id, @allow_non_git_dir
      )
    `),
    // update: dynamic — see updateProject() below
    delete: db.prepare('DELETE FROM projects WHERE id = ?'),
  };

  function listProjects() {
    return stmts.getAll.all();
  }

  function getProject(id) {
    const project = stmts.getById.get(id);
    if (!project) throw new NotFoundError(`Project not found: ${id}`);
    return project;
  }

  function validateExecutableNode(nodeId) {
    if (nodeId === undefined || nodeId === null) return nodeId;
    const node = stmts.getNodeById.get(nodeId);
    if (!node) throw new BadRequestError(`Unknown node_id: ${nodeId}`);
    if (Number(node.can_execute) !== 1 || Number(node.files_only) === 1) {
      throw new BadRequestError(`Node ${nodeId} cannot host execution`);
    }
    return nodeId;
  }

  function createProject({ name, directory, description, color, budget_usd, pm_enabled, preferred_pm_adapter, mcp_config_path, test_command, node_id, allow_non_git_dir }) {
    if (!name) throw new BadRequestError('Project name is required');
    const id = `proj_${crypto.randomUUID().slice(0, 8)}`;
    const normalizedPmEnabled = normalizePmEnabled(pm_enabled);
    const normalizedAdapter = normalizePmAdapter(preferred_pm_adapter);
    const normalizedMcpPath = normalizeMcpConfigPath(mcp_config_path);
    const normalizedTestCommand = normalizeTestCommand(test_command);
    const normalizedNodeId = validateExecutableNode(normalizeNodeId(node_id));
    const normalizedAllowNonGitDir = normalizeAllowNonGitDir(allow_non_git_dir);
    stmts.insert.run({
      id, name,
      directory: directory || null,
      description: description || null,
      color: color || '#3b82f6',
      budget_usd: budget_usd ?? null,
      // v3 Phase 1: PM settings default to enabled + no preference
      pm_enabled: normalizedPmEnabled === undefined ? 1 : normalizedPmEnabled,
      preferred_pm_adapter: normalizedAdapter === undefined ? null : normalizedAdapter,
      mcp_config_path: normalizedMcpPath === undefined ? null : normalizedMcpPath,
      test_command: normalizedTestCommand === undefined ? null : normalizedTestCommand,
      node_id: normalizedNodeId === undefined ? null : normalizedNodeId,
      allow_non_git_dir: normalizedAllowNonGitDir === undefined ? 0 : normalizedAllowNonGitDir,
    });
    return stmts.getById.get(id);
  }

  const PROJECT_UPDATABLE = [
    'name', 'directory', 'description', 'color', 'budget_usd',
    // v3 Phase 1
    'pm_enabled', 'preferred_pm_adapter',
    // v3 Phase 4 (P4-2): project-scoped MCP config file path
    'mcp_config_path',
    // H-1: opt-in harvest test command
    'test_command',
    // Fleet P1a
    'node_id', 'allow_non_git_dir',
  ];

  function updateProject(id, fields) {
    const current = getProject(id);
    // v3 Phase 1: normalize PM fields
    if ('pm_enabled' in fields) {
      const n = normalizePmEnabled(fields.pm_enabled);
      fields = { ...fields, pm_enabled: n === undefined ? null : n };
    }
    if ('preferred_pm_adapter' in fields) {
      const n = normalizePmAdapter(fields.preferred_pm_adapter);
      fields = { ...fields, preferred_pm_adapter: n === undefined ? null : n };
    }
    // P5-7: normalize mcp_config_path (absolute path + .json extension)
    if ('mcp_config_path' in fields) {
      const n = normalizeMcpConfigPath(fields.mcp_config_path);
      fields = { ...fields, mcp_config_path: n === undefined ? null : n };
    }
    if ('test_command' in fields) {
      const n = normalizeTestCommand(fields.test_command);
      fields = { ...fields, test_command: n === undefined ? null : n };
    }
    if ('node_id' in fields) {
      const n = validateExecutableNode(normalizeNodeId(fields.node_id));
      const nextNode = n === undefined ? null : n;
      const currentResolved = current.node_id || 'local';
      const nextResolved = nextNode || 'local';
      if (currentResolved !== nextResolved) {
        // Stored thread affinity (survives restarts)…
        const brief = stmts.getBriefThread.get(id);
        // …AND live Operator runs. Operator spawn registers the manager run
        // BEFORE pm_thread_id is persisted (thread id arrives on thread.started),
        // so a brief-only check has a window where a live Operator escapes the
        // guard (Codex P1a review, SERIOUS #2).
        const liveOps = stmts.countLiveOperatorRuns.get(`operator:${id}`).count;
        if (brief?.pm_thread_id || liveOps > 0) {
          const err = new Error('operator thread is bound to the current node — reset the operator before rebinding');
          err.httpStatus = 409;
          throw err;
        }
      }
      fields = { ...fields, node_id: n === undefined ? null : n };
    }
    if ('allow_non_git_dir' in fields) {
      const n = normalizeAllowNonGitDir(fields.allow_non_git_dir);
      fields = { ...fields, allow_non_git_dir: n === undefined ? 0 : n };
    }
    const setClauses = [];
    const params = { id };
    for (const col of PROJECT_UPDATABLE) {
      if (col in fields) {
        setClauses.push(`${col} = @${col}`);
        params[col] = fields[col] ?? null;
      }
    }
    if (setClauses.length > 0) {
      setClauses.push("updated_at = datetime('now')");
      db.prepare(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
    }
    return stmts.getById.get(id);
  }

  function deleteProject(id) {
    getProject(id);
    stmts.delete.run(id);
  }

  return { listProjects, getProject, createProject, updateProject, deleteProject };
}

module.exports = { createProjectService };
