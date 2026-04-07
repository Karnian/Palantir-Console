const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'failed'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_RECURRENCE = ['daily', 'weekly', 'monthly'];
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Compute the next due_date for a recurring task. Always advances strictly
// past `from`. Returns ISO YYYY-MM-DD string. Used by completion handler and
// the periodic catch-up tick.
function nextDueDate(from, recurrence) {
  const m = DUE_DATE_RE.exec(from || '');
  if (!m) return null;
  const d = new Date(Number(m[0].slice(0, 4)), Number(m[0].slice(5, 7)) - 1, Number(m[0].slice(8, 10)));
  if (recurrence === 'daily') d.setDate(d.getDate() + 1);
  else if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normalizeDueDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !DUE_DATE_RE.test(value)) {
    throw new BadRequestError(`Invalid due_date: must be YYYY-MM-DD or null`);
  }
  // Reject impossible calendar dates (e.g. 2026-13-40)
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new BadRequestError(`Invalid due_date: ${value}`);
  }
  return value;
}

function createTaskService(db, eventBus) {
  const stmts = {
    getAll: db.prepare(`
      SELECT t.*, p.name as project_name, p.color as project_color
      FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
      ORDER BY t.sort_order ASC, t.created_at DESC
    `),
    getByProject: db.prepare(`
      SELECT t.*, p.name as project_name, p.color as project_color
      FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.project_id = ?
      ORDER BY t.sort_order ASC, t.created_at DESC
    `),
    getByStatus: db.prepare(`
      SELECT t.*, p.name as project_name, p.color as project_color
      FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.status = ?
      ORDER BY t.sort_order ASC, t.created_at DESC
    `),
    getById: db.prepare(`
      SELECT t.*, p.name as project_name, p.color as project_color
      FROM tasks t LEFT JOIN projects p ON t.project_id = p.id
      WHERE t.id = ?
    `),
    insert: db.prepare(`
      INSERT INTO tasks (id, project_id, title, description, status, priority, sort_order, due_date, recurrence, parent_task_id)
      VALUES (@id, @project_id, @title, @description, @status, @priority, @sort_order, @due_date, @recurrence, @parent_task_id)
    `),
    // update: dynamic — see dynamicUpdate() below
    updateStatus: db.prepare(`
      UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?
    `),
    updateSortOrder: db.prepare(`
      UPDATE tasks SET sort_order = ?, updated_at = datetime('now') WHERE id = ?
    `),
    delete: db.prepare('DELETE FROM tasks WHERE id = ?'),
    maxSortOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM tasks'),
  };

  function listTasks({ project_id, status } = {}) {
    if (project_id) return stmts.getByProject.all(project_id);
    if (status) return stmts.getByStatus.all(status);
    return stmts.getAll.all();
  }

  function getTask(id) {
    const task = stmts.getById.get(id);
    if (!task) throw new NotFoundError(`Task not found: ${id}`);
    return task;
  }

  const insertTaskTxn = db.transaction(({ id, project_id, title, description, status, priority, due_date, recurrence, parent_task_id }) => {
    const maxSort = stmts.maxSortOrder.get().max_sort;
    stmts.insert.run({
      id,
      project_id: project_id || null,
      title,
      description: description || null,
      status: status || 'backlog',
      priority: priority || 'medium',
      sort_order: maxSort + 1,
      due_date: due_date ?? null,
      recurrence: recurrence ?? null,
      parent_task_id: parent_task_id ?? null,
    });
    return stmts.getById.get(id);
  });

  function normalizeRecurrence(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 'none') return null;
    if (!VALID_RECURRENCE.includes(value)) {
      throw new BadRequestError(`Invalid recurrence: ${value}`);
    }
    return value;
  }

  function createTask({ project_id, title, description, status, priority, due_date, recurrence, parent_task_id }) {
    if (!title) throw new BadRequestError('Task title is required');
    if (status && !VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`Invalid status: ${status}`);
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      throw new BadRequestError(`Invalid priority: ${priority}`);
    }
    const normalizedDue = normalizeDueDate(due_date);
    const normalizedRec = normalizeRecurrence(recurrence);
    const id = `task_${crypto.randomUUID().slice(0, 8)}`;
    const task = insertTaskTxn({
      id, project_id, title, description, status, priority,
      due_date: normalizedDue === undefined ? null : normalizedDue,
      recurrence: normalizedRec === undefined ? null : normalizedRec,
      parent_task_id: parent_task_id || null,
    });
    if (eventBus) eventBus.emit('task:created', { task });
    return task;
  }

  const TASK_UPDATABLE = ['title', 'description', 'project_id', 'priority', 'due_date', 'recurrence'];

  function updateTask(id, fields) {
    getTask(id);
    if (fields.priority && !VALID_PRIORITIES.includes(fields.priority)) {
      throw new BadRequestError(`Invalid priority: ${fields.priority}`);
    }
    if ('due_date' in fields) {
      fields = { ...fields, due_date: normalizeDueDate(fields.due_date) };
    }
    if ('recurrence' in fields) {
      fields = { ...fields, recurrence: normalizeRecurrence(fields.recurrence) };
    }
    const setClauses = [];
    const params = { id };
    for (const col of TASK_UPDATABLE) {
      if (col in fields) {
        setClauses.push(`${col} = @${col}`);
        params[col] = fields[col] ?? null;
      }
    }
    if (setClauses.length > 0) {
      setClauses.push("updated_at = datetime('now')");
      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
    }
    const task = stmts.getById.get(id);
    if (eventBus) eventBus.emit('task:updated', { task });
    return task;
  }

  function updateTaskStatus(id, status) {
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`Invalid status: ${status}`);
    }
    const before = getTask(id);
    stmts.updateStatus.run(status, id);
    const task = stmts.getById.get(id);
    if (eventBus) eventBus.emit('task:updated', { task });
    // Recurring task completion: spawn next instance.
    // Only fires on the done transition (avoids duplicates if PATCHed twice).
    // If the parent has a due_date, the next instance gets the next computed
    // date for that recurrence. Without a due_date, recurrence still spawns
    // a fresh dateless copy ("infinite repeat" mode).
    if (status === 'done' && before.status !== 'done' && task.recurrence) {
      const next = task.due_date ? nextDueDate(task.due_date, task.recurrence) : null;
      try {
        const child = createTask({
          project_id: task.project_id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          due_date: next, // null is fine — dateless recurring task
          recurrence: task.recurrence,
          parent_task_id: task.id,
        });
        if (eventBus) eventBus.emit('task:recurring-spawned', { parent: task, child });
      } catch (err) {
        // Don't fail the status update if spawning fails (e.g. invalid date)
        if (eventBus) eventBus.emit('task:recurring-error', { task, error: err.message });
      }
    }
    return task;
  }

  function reorderTasks(orderedIds) {
    if (!Array.isArray(orderedIds)) {
      throw new BadRequestError('orderedIds must be an array');
    }
    const reorder = db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        stmts.updateSortOrder.run(i, orderedIds[i]);
      }
    });
    reorder();
  }

  function deleteTask(id) {
    getTask(id);
    stmts.delete.run(id);
    if (eventBus) eventBus.emit('task:updated', { taskId: id, deleted: true });
  }

  return { listTasks, getTask, createTask, updateTask, updateTaskStatus, reorderTasks, deleteTask };
}

module.exports = { createTaskService };
