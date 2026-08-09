'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createDatabase } = require('../db/database');
const { createTaskService } = require('../services/taskService');
const { createActionLedgerService } = require('../services/actionLedgerService');
const { createActionsRouter } = require('../routes/actions');
const { invokeApp } = require('./helpers/invokeApp');
const PARAMS = { repo: 'acme/widgets', title: 'Ship it', body: 'Please ship', labels: ['ops'] };
function setup(t) {
  const handle = createDatabase(':memory:'); handle.migrate();
  const taskService = createTaskService(handle.db, null);
  const ledger = createActionLedgerService(handle.db, { actionIdFactory: () => 'action-' + Math.random() });
  t.after(() => handle.close());
  return { db: handle.db, taskService, ledger };
}
function appFor(taskService, ledger, method) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.auth = { method }; next(); });
  app.use('/api/actions', createActionsRouter({ taskService, ledger }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}
test('migration and service enforce and project goal_kind without leaking CHECK failures', (t) => {
  const { db, taskService } = setup(t);
  const ordinary = taskService.createTask({ title: 'ordinary' });
  assert.equal(ordinary.goal_kind, 'deliverable');
  assert.throws(() => db.prepare("UPDATE tasks SET goal_kind='invalid' WHERE id=?").run(ordinary.id), /CHECK constraint/);
  assert.throws(() => db.prepare("UPDATE tasks SET goal_kind='action', goal_enabled=0 WHERE id=?").run(ordinary.id), /CHECK constraint/);
  assert.throws(() => taskService.createTask({ title: 'bad', goal_kind: 'action', goal_enabled: 0 }), error => error.status === 400);
  const task = taskService.createTask({ title: 'action', goal_kind: 'action', goal_enabled: 1 });
  assert.equal(taskService.getTask(task.id).goal_kind, 'action');
  assert.equal(taskService.listTasks().find(row => row.id === task.id).goal_kind, 'action');
  assert.throws(() => taskService.updateTask(task.id, { goal_enabled: 0 }), error => error.status === 400);
});
test('declaration contract is authenticated, idempotent, action-only, and provenance-immutable', async (t) => {
  const { db, taskService, ledger } = setup(t);
  const actionTask = taskService.createTask({ title: 'action', goal_kind: 'action', goal_enabled: 1 });
  const ordinary = taskService.createTask({ title: 'ordinary' });
  const body = { task_id: actionTask.id, action_slot: 'primary', params: PARAMS };
  assert.equal((await invokeApp(appFor(taskService, ledger, 'none'), { method: 'POST', path: '/api/actions', body })).status, 403);
  assert.equal((await invokeApp(appFor(taskService, ledger, 'cookie'), { method: 'POST', path: '/api/actions', body: { ...body, action_slot: 'cookie' } })).status, 201);
  const first = await invokeApp(appFor(taskService, ledger, 'bearer'), { method: 'POST', path: '/api/actions', body });
  assert.equal(first.status, 201);
  const replay = await invokeApp(appFor(taskService, ledger, 'bearer'), { method: 'POST', path: '/api/actions', body });
  assert.equal(replay.status, 200); assert.equal(replay.body.action.id, first.body.action.id);
  assert.equal((await invokeApp(appFor(taskService, ledger, 'bearer'), { method: 'POST', path: '/api/actions', body: { ...body, params: { ...PARAMS, title: 'changed' } } })).status, 409);
  assert.equal((await invokeApp(appFor(taskService, ledger, 'bearer'), { method: 'POST', path: '/api/actions', body: { ...body, task_id: ordinary.id, action_slot: 'ordinary' } })).status, 400);
  assert.equal((await invokeApp(appFor(taskService, ledger, 'bearer'), { method: 'POST', path: '/api/actions', body: { ...body, action_slot: 'spoof', declared_by_method: 'cookie' } })).status, 400);
  const stored = db.prepare('SELECT * FROM actions WHERE id=?').get(first.body.action.id);
  assert.equal(stored.declared_by_method, 'bearer'); assert.equal(stored.status, 'awaiting_approval');
  assert.throws(() => db.prepare("UPDATE actions SET declared_by_method='cookie' WHERE id=?").run(stored.id), /immutable/);
  assert.equal(ledger.listEvents(stored.id).length, 1, 'declaration stays awaiting approval with no execution event');
});
