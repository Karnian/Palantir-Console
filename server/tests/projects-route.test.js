'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { Duplex, Writable } = require('node:stream');
const { createProjectsRouter } = require('../routes/projects');
const { errorHandler } = require('../middleware/errorHandler');
const { BadRequestError, NotFoundError } = require('../utils/errors');

function createRouteApp({
  projectService,
  taskService,
  runService,
  lifecycleService,
  nodeBindingValidator,
  operatorCleanupService,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', createProjectsRouter({
    projectService,
    taskService: taskService || { listTasks: () => [] },
    runService,
    projectBriefService: null,
    operatorCleanupService,
    nodeBindingValidator,
    lifecycleService,
  }));
  app.use(errorHandler);
  return app;
}

function dispatch(app, method, url, body = undefined) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const socket = new Duplex({
      read() {},
      write(chunk, enc, cb) { cb(); },
    });
    socket.encrypted = false;
    const req = new http.IncomingMessage(socket);
    req.method = method;
    req.url = url;
    req.headers = {
      host: 'localhost',
      ...(payload ? {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      } : {}),
    };
    process.nextTick(() => {
      req.push(payload);
      req.push(null);
    });

    const chunks = [];
    const headers = new Map();
    let resolved = false;
    const res = new Writable({
      write(chunk, enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    res.statusCode = 200;
    res.setHeader = (name, value) => { headers.set(String(name).toLowerCase(), value); };
    res.getHeader = (name) => headers.get(String(name).toLowerCase());
    res.getHeaders = () => Object.fromEntries(headers);
    res.removeHeader = (name) => { headers.delete(String(name).toLowerCase()); };
    res.writeHead = (statusCode, reasonOrHeaders, maybeHeaders) => {
      res.statusCode = statusCode;
      const headerValues = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      for (const [name, value] of Object.entries(headerValues || {})) {
        res.setHeader(name, value);
      }
      return res;
    };
    res.end = (chunk, encoding, cb) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof cb === 'function') cb();
      if (!resolved) {
        resolved = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        if (text) {
          try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        resolve({ status: res.statusCode, body: parsed, text });
      }
      return res;
    };

    app.handle(req, res, (err) => {
      if (err) {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
        return;
      }
      if (!resolved) {
        resolved = true;
        resolve({ status: res.statusCode || 404, body: {}, text: '' });
      }
    });
  });
}

function createProjectService(overrides = {}) {
  return {
    listProjects: () => [],
    getProject: (id) => ({ id, name: 'Project' }),
    createProject: (body) => ({ id: 'proj_1', ...body }),
    updateProject: (id, body) => ({ id, ...body }),
    deleteProject: () => {},
    ...overrides,
  };
}

test('POST /api/projects validates node binding before sync createProject', async () => {
  const calls = [];
  const app = createRouteApp({
    projectService: createProjectService({
      createProject: (body) => {
        calls.push(['create', body]);
        return { id: 'proj_1', ...body };
      },
    }),
    nodeBindingValidator: {
      async validateBinding(binding) {
        calls.push(['validate', binding]);
      },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects', {
    name: 'Alpha',
    node_id: 'node-a',
    directory: '/srv/repo',
    mcp_config_path: '/control/mcp.json',
  });

  assert.equal(res.status, 201);
  assert.deepEqual(calls.map(([kind]) => kind), ['validate', 'create']);
  assert.deepEqual(calls[0][1], {
    nodeId: 'node-a',
    directory: '/srv/repo',
    mcpConfigPath: '/control/mcp.json',
  });
});

test('POST /api/projects returns validator 400 without calling createProject', async () => {
  let createCalled = false;
  const app = createRouteApp({
    projectService: createProjectService({
      createProject: () => {
        createCalled = true;
        return { id: 'proj_1' };
      },
    }),
    nodeBindingValidator: {
      async validateBinding() {
        throw new BadRequestError('Directory not found or outside exposed_roots on node node-a: /bad');
      },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects', {
    name: 'Alpha',
    node_id: 'node-a',
    directory: '/bad',
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Directory not found/);
  assert.equal(createCalled, false);
});

test('PATCH /api/projects/:id skips binding validator when binding fields are absent', async () => {
  let validateCalled = false;
  const app = createRouteApp({
    projectService: createProjectService(),
    nodeBindingValidator: {
      async validateBinding() {
        validateCalled = true;
      },
    },
  });

  const res = await dispatch(app, 'PATCH', '/api/projects/proj_1', { name: 'Renamed' });

  assert.equal(res.status, 200);
  assert.equal(validateCalled, false);
});

test('PATCH /api/projects/:id validates only submitted binding fields', async () => {
  const seen = [];
  const app = createRouteApp({
    projectService: createProjectService(),
    nodeBindingValidator: {
      async validateBinding(binding) {
        seen.push(binding);
      },
    },
  });

  const res = await dispatch(app, 'PATCH', '/api/projects/proj_1', { directory: '/new/repo' });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{
    nodeId: undefined,
    directory: '/new/repo',
    mcpConfigPath: undefined,
  }]);
});

test('PATCH /api/projects/:id validates EFFECTIVE binding when only node_id changes', async () => {
  // Rebinding node_id alone to a remote node must validate the STORED
  // directory/mcp_config_path against the new node — otherwise a stale local
  // path escapes bind-time validation and only fails at spawn (the exact
  // local↔remote mismatch N2-2 targets). Supervisor-added regression guard.
  const seen = [];
  const app = createRouteApp({
    projectService: createProjectService({
      getProject: (id) => ({
        id,
        name: 'Project',
        node_id: null,
        directory: '/local/only/repo',
        mcp_config_path: '/local/mcp.json',
      }),
    }),
    nodeBindingValidator: {
      async validateBinding(binding) {
        seen.push(binding);
      },
    },
  });

  const res = await dispatch(app, 'PATCH', '/api/projects/proj_1', { node_id: 'pi' });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{
    nodeId: 'pi',
    directory: '/local/only/repo',
    mcpConfigPath: '/local/mcp.json',
  }]);
});

test('PATCH /api/projects/:id preserves rebind 409 after binding validation', async () => {
  const calls = [];
  const conflict = new Error('operator thread is bound to the current node — reset the operator before rebinding');
  conflict.httpStatus = 409;
  const app = createRouteApp({
    projectService: createProjectService({
      updateProject: () => {
        calls.push('update');
        throw conflict;
      },
    }),
    nodeBindingValidator: {
      async validateBinding() {
        calls.push('validate');
      },
    },
  });

  const res = await dispatch(app, 'PATCH', '/api/projects/proj_1', { node_id: 'node-b' });

  assert.equal(res.status, 409);
  assert.match(res.body.error, /reset the operator/);
  assert.deepEqual(calls, ['validate', 'update']);
});

test('POST /api/projects/:id/reset delegates to operatorCleanupService.reset', async () => {
  const resetCalls = [];
  const app = createRouteApp({
    projectService: createProjectService(),
    operatorCleanupService: {
      reset(projectId) {
        resetCalls.push(projectId);
        return { cleared: true };
      },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects/proj_1/reset', {});

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'reset');
  assert.equal(res.body.projectId, 'proj_1');
  assert.deepEqual(resetCalls, ['proj_1']);
});

test('POST /api/projects/:id/retarget-queued collects queued worker runs for project and from node', async () => {
  const calls = [];
  const tasks = new Map([
    ['task_same_1', { id: 'task_same_1', project_id: 'proj_1' }],
    ['task_same_2', { id: 'task_same_2', project_id: 'proj_1' }],
    ['task_other_project', { id: 'task_other_project', project_id: 'proj_2' }],
    ['task_other_node', { id: 'task_other_node', project_id: 'proj_1' }],
    ['task_manager', { id: 'task_manager', project_id: 'proj_1' }],
  ]);
  const app = createRouteApp({
    projectService: createProjectService({
      getProject: (id) => ({ id, name: 'Project', node_id: 'node-new', directory: '/srv/repo' }),
    }),
    taskService: {
      listTasks: () => [],
      getTask: (id) => tasks.get(id),
    },
    runService: {
      listRuns: (filter) => {
        calls.push(['listRuns', filter]);
        return [
          { id: 'run_1', task_id: 'task_same_1', node_id: 'node-old', status: 'queued', is_manager: 0 },
          { id: 'run_2', task_id: 'task_same_2', node_id: 'node-old', status: 'queued', is_manager: 0 },
          { id: 'run_other_project', task_id: 'task_other_project', node_id: 'node-old', status: 'queued', is_manager: 0 },
          { id: 'run_other_node', task_id: 'task_other_node', node_id: 'node-x', status: 'queued', is_manager: 0 },
          { id: 'run_manager', task_id: 'task_manager', node_id: 'node-old', status: 'queued', is_manager: 1 },
        ];
      },
      retargetQueuedRuns: (ids, fromNodeId, toNodeId) => {
        calls.push(['retarget', ids, fromNodeId, toNodeId]);
        return { moved: ids.length };
      },
    },
    nodeBindingValidator: {
      async validateBinding(binding) {
        calls.push(['validate', binding]);
      },
    },
    lifecycleService: {
      scheduleDrainForNode(nodeId) {
        calls.push(['drain', nodeId]);
      },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects/proj_1/retarget-queued', { fromNodeId: 'node-old' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { moved: 2, runIds: ['run_1', 'run_2'] });
  assert.deepEqual(calls, [
    ['listRuns', { status: 'queued' }],
    ['validate', { nodeId: 'node-new', directory: '/srv/repo' }],
    ['retarget', ['run_1', 'run_2'], 'node-old', 'node-new'],
    ['drain', 'node-new'],
  ]);
});

test('POST /api/projects/:id/retarget-queued returns moved 0 without validation when no targets match', async () => {
  let validateCalled = false;
  let retargetCalled = false;
  let drainCalled = false;
  const app = createRouteApp({
    projectService: createProjectService({
      getProject: (id) => ({ id, name: 'Project', node_id: 'node-new', directory: '/srv/repo' }),
    }),
    taskService: {
      listTasks: () => [],
      getTask: () => ({ id: 'task_1', project_id: 'proj_1' }),
    },
    runService: {
      listRuns: () => [{ id: 'run_1', task_id: 'task_1', node_id: 'node-other', status: 'queued', is_manager: 0 }],
      retargetQueuedRuns: () => { retargetCalled = true; return { moved: 1 }; },
    },
    nodeBindingValidator: {
      async validateBinding() { validateCalled = true; },
    },
    lifecycleService: {
      scheduleDrainForNode() { drainCalled = true; },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects/proj_1/retarget-queued', { fromNodeId: 'node-old' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { moved: 0 });
  assert.equal(validateCalled, false);
  assert.equal(retargetCalled, false);
  assert.equal(drainCalled, false);
});

test('POST /api/projects/:id/retarget-queued validates target node before moving runs', async () => {
  let retargetCalled = false;
  const app = createRouteApp({
    projectService: createProjectService({
      getProject: (id) => ({ id, name: 'Project', node_id: 'node-new', directory: '/bad' }),
    }),
    taskService: {
      listTasks: () => [],
      getTask: () => ({ id: 'task_1', project_id: 'proj_1' }),
    },
    runService: {
      listRuns: () => [{ id: 'run_1', task_id: 'task_1', node_id: 'node-old', status: 'queued', is_manager: 0 }],
      retargetQueuedRuns: () => { retargetCalled = true; return { moved: 1 }; },
    },
    nodeBindingValidator: {
      async validateBinding() {
        throw new BadRequestError('Directory not found or outside exposed_roots on node node-new: /bad');
      },
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects/proj_1/retarget-queued', { fromNodeId: 'node-old' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /Directory not found/);
  assert.equal(retargetCalled, false);
});

test('POST /api/projects/:id/retarget-queued propagates project 404', async () => {
  const app = createRouteApp({
    projectService: createProjectService({
      getProject: (id) => { throw new NotFoundError(`Project not found: ${id}`); },
    }),
    taskService: {
      listTasks: () => [],
      getTask: () => null,
    },
    runService: {
      listRuns: () => [],
      retargetQueuedRuns: () => ({ moved: 0 }),
    },
  });

  const res = await dispatch(app, 'POST', '/api/projects/missing/retarget-queued', { fromNodeId: 'node-old' });

  assert.equal(res.status, 404);
  assert.match(res.body.error, /Project not found/);
});
