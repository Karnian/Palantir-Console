const crypto = require('node:crypto');
const { BadRequestError, NotFoundError } = require('../utils/errors');

const VALID_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done', 'failed'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_RECURRENCE = ['daily', 'weekly', 'monthly'];
// v3 Phase 1: task_kind classification for dispatch routing
const VALID_TASK_KINDS = ['code_change', 'investigation', 'review', 'docs', 'refactor', 'other'];
const DUE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// v3 Phase 1: requires_capabilities accepts array of strings or null.
// Stored as JSON string in DB; exposed as array on read.
function normalizeRequiresCapabilities(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!Array.isArray(value)) {
    throw new BadRequestError('requires_capabilities must be an array of strings or null');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new BadRequestError('requires_capabilities entries must be non-empty strings');
    }
  }
  return JSON.stringify(value);
}

function normalizeTaskKind(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!VALID_TASK_KINDS.includes(value)) {
    throw new BadRequestError(`Invalid task_kind: ${value} (valid: ${VALID_TASK_KINDS.join(', ')})`);
  }
  return value;
}

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

/**
 * @param {object} db - better-sqlite3 database instance
 * @param {EventEmitter|null} eventBus
 * @param {object} [opts]
 * @param {(id: string) => void} [opts.validatePresetId] - Optional validator called
 *   when preferred_preset_id is being set to a non-null string. Should throw
 *   NotFoundError or BadRequestError if the preset does not exist. Used for
 *   defense-in-depth validation independent of the HTTP layer (D2c).
 */
function createTaskService(db, eventBus, opts = {}) {
  const { validatePresetId } = opts;
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
      INSERT INTO tasks (
        id, project_id, title, description, status, priority, sort_order,
        due_date, recurrence, parent_task_id,
        task_kind, requires_capabilities, suggested_agent_profile_id, acceptance_criteria
      )
      VALUES (
        @id, @project_id, @title, @description, @status, @priority, @sort_order,
        @due_date, @recurrence, @parent_task_id,
        @task_kind, @requires_capabilities, @suggested_agent_profile_id, @acceptance_criteria
      )
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

  // v3 Phase 1: parse requires_capabilities from JSON on every read.
  function parseRow(row) {
    if (!row) return row;
    if (row.requires_capabilities) {
      try { row.requires_capabilities = JSON.parse(row.requires_capabilities); }
      catch { row.requires_capabilities = null; }
    }
    return row;
  }

  function listTasks({ project_id, status } = {}) {
    let rows;
    if (project_id) rows = stmts.getByProject.all(project_id);
    else if (status) rows = stmts.getByStatus.all(status);
    else rows = stmts.getAll.all();
    return rows.map(parseRow);
  }

  function getTask(id) {
    const task = parseRow(stmts.getById.get(id));
    if (!task) throw new NotFoundError(`Task not found: ${id}`);
    return task;
  }

  const insertTaskTxn = db.transaction((args) => {
    const maxSort = stmts.maxSortOrder.get().max_sort;
    stmts.insert.run({
      id: args.id,
      project_id: args.project_id || null,
      title: args.title,
      description: args.description || null,
      status: args.status || 'backlog',
      priority: args.priority || 'medium',
      sort_order: maxSort + 1,
      due_date: args.due_date ?? null,
      recurrence: args.recurrence ?? null,
      parent_task_id: args.parent_task_id ?? null,
      // v3 Phase 1
      task_kind: args.task_kind ?? null,
      requires_capabilities: args.requires_capabilities ?? null,
      suggested_agent_profile_id: args.suggested_agent_profile_id ?? null,
      acceptance_criteria: args.acceptance_criteria ?? null,
    });
    return parseRow(stmts.getById.get(args.id));
  });

  function normalizeRecurrence(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '' || value === 'none') return null;
    if (!VALID_RECURRENCE.includes(value)) {
      throw new BadRequestError(`Invalid recurrence: ${value}`);
    }
    return value;
  }

  function createTask(input = {}) {
    const {
      project_id, title, description, status, priority, due_date, recurrence, parent_task_id,
      task_kind, requires_capabilities, suggested_agent_profile_id, acceptance_criteria,
    } = input;
    if (!title) throw new BadRequestError('Task title is required');
    if (status && !VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`Invalid status: ${status}`);
    }
    if (priority && !VALID_PRIORITIES.includes(priority)) {
      throw new BadRequestError(`Invalid priority: ${priority}`);
    }
    const normalizedDue = normalizeDueDate(due_date);
    const normalizedRec = normalizeRecurrence(recurrence);
    // v3 Phase 1: new field validations
    const normalizedKind = normalizeTaskKind(task_kind);
    const normalizedCaps = normalizeRequiresCapabilities(requires_capabilities);
    const id = `task_${crypto.randomUUID().slice(0, 8)}`;
    const task = insertTaskTxn({
      id, project_id, title, description, status, priority,
      due_date: normalizedDue === undefined ? null : normalizedDue,
      recurrence: normalizedRec === undefined ? null : normalizedRec,
      parent_task_id: parent_task_id || null,
      task_kind: normalizedKind === undefined ? null : normalizedKind,
      requires_capabilities: normalizedCaps === undefined ? null : normalizedCaps,
      suggested_agent_profile_id: suggested_agent_profile_id || null,
      acceptance_criteria: acceptance_criteria ?? null,
    });
    if (eventBus) eventBus.emit('task:created', { task });
    return task;
  }

  const TASK_UPDATABLE = [
    'title', 'description', 'project_id', 'priority', 'due_date', 'recurrence',
    // v3 Phase 1
    'task_kind', 'requires_capabilities', 'suggested_agent_profile_id', 'acceptance_criteria',
    // v3 Phase 10E (worker preset linkage)
    'preferred_preset_id',
  ];

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
    // v3 Phase 1: normalize new fields on update
    if ('task_kind' in fields) {
      const n = normalizeTaskKind(fields.task_kind);
      fields = { ...fields, task_kind: n === undefined ? null : n };
    }
    if ('requires_capabilities' in fields) {
      const n = normalizeRequiresCapabilities(fields.requires_capabilities);
      fields = { ...fields, requires_capabilities: n === undefined ? null : n };
    }
    // D2c: defense-in-depth — validate preferred_preset_id at service layer
    if ('preferred_preset_id' in fields && fields.preferred_preset_id !== null) {
      if (typeof fields.preferred_preset_id !== 'string' || fields.preferred_preset_id.trim() === '') {
        throw new BadRequestError('preferred_preset_id must be a non-empty string or null');
      }
      if (validatePresetId) {
        try {
          validatePresetId(fields.preferred_preset_id);
        } catch (err) {
          // Re-throw NotFoundError as BadRequestError for a clean 400 at HTTP layer
          throw new BadRequestError(`preferred_preset_id not found: ${fields.preferred_preset_id}`);
        }
      }
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
    const task = parseRow(stmts.getById.get(id));
    if (eventBus) eventBus.emit('task:updated', { task });
    return task;
  }

  function updateTaskStatus(id, status) {
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`Invalid status: ${status}`);
    }
    const before = getTask(id);
    stmts.updateStatus.run(status, id);
    const task = parseRow(stmts.getById.get(id));
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
