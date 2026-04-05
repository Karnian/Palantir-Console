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
    update: db.prepare(`
      UPDATE projects
      SET name = COALESCE(@name, name),
          directory = COALESCE(@directory, directory),
          description = COALESCE(@description, description),
          color = COALESCE(@color, color),
          budget_usd = COALESCE(@budget_usd, budget_usd),
          updated_at = datetime('now')
      WHERE id = @id
    `),
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

  function updateProject(id, fields) {
    getProject(id); // throws if not found
    stmts.update.run({ id, name: null, directory: null, description: null, color: null, budget_usd: null, ...fields });
    return stmts.getById.get(id);
  }

  function deleteProject(id) {
    getProject(id);
    stmts.delete.run(id);
  }

  return { listProjects, getProject, createProject, updateProject, deleteProject };
}

module.exports = { createProjectService };
