const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

function createProjectService(db) {
  const stmts = {
    getAll: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    getById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO projects (id, name, directory, description, color, budget_usd)
      VALUES (@id, @name, @directory, @description, @color, @budget_usd)
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

  function createProject({ name, directory, description, color, budget_usd }) {
    if (!name) throw new BadRequestError('Project name is required');
    const id = `proj_${crypto.randomUUID().slice(0, 8)}`;
    stmts.insert.run({
      id, name,
      directory: directory || null,
      description: description || null,
      color: color || '#3b82f6',
      budget_usd: budget_usd ?? null,
    });
    return stmts.getById.get(id);
  }

  const PROJECT_UPDATABLE = ['name', 'directory', 'description', 'color', 'budget_usd'];

  function updateProject(id, fields) {
    getProject(id);
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
