// D2c — taskService.updateTask service-layer preferred_preset_id validation.
// Tests the validatePresetId callback injected at construction time,
// independent of the HTTP route layer.
//
// Uses a minimal DB stub that satisfies the better-sqlite3 interface without
// requiring the native addon (avoiding the ERR_DLOPEN_FAILED env issue).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskService } = require('../services/taskService');
const { BadRequestError } = require('../utils/errors');

/** Build a minimal better-sqlite3 stub for taskService unit testing. */
function makeStub() {
  const rows = {};

  const stmtFn = (sql) => {
    const normalized = sql.trim().toUpperCase();
    return {
      get: (params) => {
        // maxSortOrder query
        if (normalized.includes('MAX(SORT_ORDER)') || normalized.includes('MAX_SORT')) {
          return { max_sort: 0 };
        }
        // getById — positional param, params is a plain string id
        const id = (params && typeof params === 'object') ? (params.id || null) : params;
        return id ? (rows[id] || null) : null;
      },
      run: (params) => {
        if (normalized.startsWith('INSERT')) {
          rows[params.id] = { ...params, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          return { lastInsertRowid: params.id };
        }
        if (normalized.startsWith('UPDATE') && params?.id && rows[params.id]) {
          Object.assign(rows[params.id], params);
        }
        // positional UPDATE (updateStatus: status, id)
        if (normalized.startsWith('UPDATE') && Array.isArray(params)) {
          const [val, id] = params;
          if (rows[id]) rows[id].status = val;
        }
        return {};
      },
      all: (params) => {
        const vals = Object.values(rows);
        if (!params) return vals;
        if (typeof params === 'object' && params.project_id) {
          return vals.filter(r => r.project_id === params.project_id);
        }
        return vals;
      },
    };
  };

  const db = {
    prepare: (sql) => stmtFn(sql),
    // better-sqlite3 transaction(fn) returns a wrapped function; simplify to identity
    transaction: (fn) => fn,
  };
  return { db, rows };
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

test('taskService.updateTask — validatePresetId: invalid id → throws BadRequestError', () => {
  const { db } = makeStub();

  let validateCalled = false;
  const svc = createTaskService(db, null, {
    validatePresetId: (id) => {
      validateCalled = true;
      throw new Error(`Not found: ${id}`);
    },
  });

  const task = svc.createTask({ title: 'Test task' });
  assert.ok(task, 'task created');

  assert.throws(
    () => svc.updateTask(task.id, { preferred_preset_id: 'preset_unknown_d2c' }),
    (err) => {
      assert.ok(err instanceof BadRequestError,
        `expected BadRequestError, got ${err.constructor.name}: ${err.message}`);
      assert.match(err.message, /preferred_preset_id not found/);
      return true;
    },
  );
  assert.ok(validateCalled, 'validatePresetId callback was invoked');
});

test('taskService.updateTask — validatePresetId: null value skips validation', () => {
  const { db } = makeStub();

  let validateCalled = false;
  const svc = createTaskService(db, null, {
    validatePresetId: () => { validateCalled = true; },
  });
  const task = svc.createTask({ title: 'Test' });
  assert.ok(task, 'task created');

  // null should unlink without calling the validator
  assert.doesNotThrow(() => svc.updateTask(task.id, { preferred_preset_id: null }));
  assert.equal(validateCalled, false, 'null skips validatePresetId');
});

test('taskService.updateTask — key absent: skips validation entirely', () => {
  const { db } = makeStub();

  let validateCalled = false;
  const svc = createTaskService(db, null, {
    validatePresetId: () => { validateCalled = true; },
  });
  const task = svc.createTask({ title: 'Test' });
  assert.ok(task, 'task created');

  // Update title only — preferred_preset_id key not in patch → validator not called
  assert.doesNotThrow(() => svc.updateTask(task.id, { title: 'New title' }));
  assert.equal(validateCalled, false, 'absent key skips validatePresetId');
});

test('taskService.updateTask — no validatePresetId opt: accepts any string (backward compat)', () => {
  const { db } = makeStub();

  // createTaskService without validatePresetId → accepts any string
  const svc = createTaskService(db, null);
  const task = svc.createTask({ title: 'Test' });
  assert.ok(task, 'task created');
  assert.doesNotThrow(() => svc.updateTask(task.id, { preferred_preset_id: 'any_id_no_validation' }));
});

test('taskService.updateTask — validatePresetId: valid id → passes, no throw', () => {
  const { db } = makeStub();

  let validateCalled = false;
  const svc = createTaskService(db, null, {
    validatePresetId: () => { validateCalled = true; /* returns normally */ },
  });
  const task = svc.createTask({ title: 'Test' });
  assert.ok(task, 'task created');

  assert.doesNotThrow(() => svc.updateTask(task.id, { preferred_preset_id: 'valid_preset_id' }));
  assert.ok(validateCalled, 'validatePresetId was invoked for valid id');
});
