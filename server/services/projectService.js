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

function createProjectService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    getById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO projects (
        id, name, directory, description, color, budget_usd,
        pm_enabled, preferred_pm_adapter
      )
      VALUES (
        @id, @name, @directory, @description, @color, @budget_usd,
        @pm_enabled, @preferred_pm_adapter
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

  function createProject({ name, directory, description, color, budget_usd, pm_enabled, preferred_pm_adapter }) {
    if (!name) throw new BadRequestError('Project name is required');
    const id = `proj_${crypto.randomUUID().slice(0, 8)}`;
    const normalizedPmEnabled = normalizePmEnabled(pm_enabled);
    const normalizedAdapter = normalizePmAdapter(preferred_pm_adapter);
    stmts.insert.run({
      id, name,
      directory: directory || null,
      description: description || null,
      color: color || '#3b82f6',
      budget_usd: budget_usd ?? null,
      // v3 Phase 1: PM settings default to enabled + no preference
      pm_enabled: normalizedPmEnabled === undefined ? 1 : normalizedPmEnabled,
      preferred_pm_adapter: normalizedAdapter === undefined ? null : normalizedAdapter,
    });
    return stmts.getById.get(id);
  }

  const PROJECT_UPDATABLE = [
    'name', 'directory', 'description', 'color', 'budget_usd',
    // v3 Phase 1
    'pm_enabled', 'preferred_pm_adapter',
  ];

  function updateProject(id, fields) {
    getProject(id);
    // v3 Phase 1: normalize PM fields
    if ('pm_enabled' in fields) {
      const n = normalizePmEnabled(fields.pm_enabled);
      fields = { ...fields, pm_enabled: n === undefined ? null : n };
    }
    if ('preferred_pm_adapter' in fields) {
      const n = normalizePmAdapter(fields.preferred_pm_adapter);
      fields = { ...fields, preferred_pm_adapter: n === undefined ? null : n };
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
