'use strict';

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const express = require('express');

const manifestModulePath = require.resolve('../services/managerOperationManifest');
const { managerOperationManifest, getManagerOperation, renderOperationPath } = require(manifestModulePath);
const { managerCapabilityRequestAllowed } = require('../middleware/auth');
const { createApp } = require('../app');
const {
  buildManagerSystemPrompt,
  buildManagerSystemPromptWithTrace,
} = require('../services/managerSystemPrompt');
const { createDatabase } = require('../db/database');
const { createTaskService } = require('../services/taskService');
const { createProjectService } = require('../services/projectService');
const { createVerifyCheckService } = require('../services/verifyCheckService');
const { createConversationService } = require('../services/conversationService');
const { createTasksRouter } = require('../routes/tasks');
const { createRunsRouter } = require('../routes/runs');
const { createProjectsRouter } = require('../routes/projects');
const { createMemoryRouter } = require('../routes/memory');
const { createAgentsRouter } = require('../routes/agents');
const { createSkillPacksRouter } = require('../routes/skillPacks');
const { createConversationsRouter } = require('../routes/conversations');
const { createOperatorProfilesRouter } = require('../routes/operatorProfiles');
const { createOperatorProfileMemoryRouter } = require('../routes/operatorProfileMemory');
const { createOperatorSchedulesRouter } = require('../routes/operatorSchedules');
const { createMemoryProposalsRouter } = require('../routes/memoryProposals');
const { createVerifyChecksRouter } = require('../routes/verifyChecks');
const { createDispatchAuditRouter } = require('../routes/dispatchAudit');
const { createActionsRouter } = require('../routes/actions');
const { createActionLedgerService } = require('../services/actionLedgerService');
const { createOperatorSpecialistRouter } = require('../routes/operatorSpecialist');
const { invokeApp } = require('./helpers/invokeApp');

const METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const LAYERS = ['top', 'operator'];
const AVAILABILITY = new Set(['always', 'goal_mode', 'specialist_mounted']);

function walkObjects(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) walkObjects(child, visit);
}

function allowlisted(operation, requestPath, layer) {
  return managerCapabilityRequestAllowed(
    { method: operation.method, originalUrl: requestPath },
    { layer },
  );
}

function templatePattern(pathTemplate) {
  const escaped = pathTemplate
    .split(/(\{[^}]+\})/)
    .map(part => /^\{[^}]+\}$/.test(part)
      ? '[^/]+'
      : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('');
  return new RegExp(`^${escaped}$`);
}

function operationForCall(method, requestPath, layer) {
  const pathOnly = requestPath.split('?')[0];
  return managerOperationManifest.operations.find(operation => (
    operation.method === method
    && operation.layers.includes(layer)
    && templatePattern(operation.path_template).test(pathOnly)
  ));
}

function operationPathOnly(renderedPath) {
  const apiIndex = renderedPath.indexOf('/api/');
  return apiIndex < 0 ? renderedPath : renderedPath.slice(apiIndex).split('?')[0];
}

function promptVisibleFor(operation, layer, adapterType) {
  if (!operation.prompt.visible || !operation.layers.includes(layer)) return false;
  const layerVariants = operation.prompt.layer_variants || {};
  if (Object.keys(layerVariants).length > 0 && layerVariants[layer] !== 'visible') return false;
  const adapterVariants = operation.prompt.adapter_variants || {};
  return Object.keys(adapterVariants).length === 0 || adapterVariants[adapterType] === 'visible';
}

function managerRouteApp(mountPath, router, auth) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use(mountPath, router);
  app.use((err, _req, res, _next) => {
    res.status(err.status || err.statusCode || err.httpStatus || 500).json({ error: err.message });
  });
  return app;
}

async function invokeManagerRoute(mountPath, router, auth, request) {
  return invokeApp(managerRouteApp(mountPath, router, auth), request);
}

function assertOperatorOnly(operationId, requestPath) {
  const operation = getManagerOperation(operationId);
  assert.equal(allowlisted(operation, requestPath, 'operator'), true);
  assert.equal(allowlisted(operation, requestPath, 'top'), false);
}

async function assertManagerRunInterventionDenied(endpoint) {
  const response = await invokeManagerRoute(
    '/api/runs',
    createRunsRouter({
      runService: { getRun: () => ({ id: 'manager-target', is_manager: 1 }) },
      lifecycleService: {
        sendAgentInput: async () => true,
        cancelRun: async () => true,
      },
    }),
    { method: 'bearer', actor: 'manager', layer: 'operator', managerRunId: 'operator-1' },
    {
      method: 'POST',
      path: `/api/runs/manager-target/${endpoint}`,
      body: endpoint === 'input' ? { text: 'hello' } : undefined,
    },
  );
  assert.equal(response.status, 403);
}

function assertGoalServiceInvariant(kind) {
  const { db, migrate, close } = createDatabase(':memory:');
  migrate();
  try {
    const taskService = createTaskService(db, null);
    const goal = taskService.createTask({ title: 'goal' });
    db.prepare('UPDATE tasks SET goal_enabled = 1 WHERE id = ?').run(goal.id);
    if (kind === 'generic') {
      taskService.updateTaskStatus(goal.id, 'done');
      assert.throws(
        () => taskService.updateTask(goal.id, { description: 'manager mutation' }, { actor: { actor: 'manager' } }),
        /manager capability cannot/,
      );
    } else {
      assert.throws(
        () => taskService.updateTaskStatus(goal.id, 'done', { actor: { actor: 'manager' } }),
        /manager capability cannot/,
      );
    }
  } finally {
    close();
  }
}

function createExecuteRouter() {
  return createTasksRouter({
    taskService: { getTask: id => ({ id }) },
    lifecycleService: { executeTask: async id => ({ id: `run-for-${id}` }) },
  });
}

async function executeStatus(layer, managerRunId, pmRunId) {
  const body = { agent_profile_id: 'agent-1', prompt: 'work' };
  if (pmRunId !== undefined) body.pm_run_id = pmRunId;
  return (await invokeManagerRoute(
    '/api/tasks',
    createExecuteRouter(),
    { method: 'bearer', actor: 'manager', layer, managerRunId },
    { method: 'POST', path: '/api/tasks/task-1/execute', body },
  )).status;
}

function replaceExampleFixtures(value, fixtures) {
  if (Array.isArray(value)) return value.map(item => replaceExampleFixtures(item, fixtures));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceExampleFixtures(item, fixtures)]));
  }
  if (value === 'PROJECT_ID') return fixtures.projectId;
  if (value === 'TASK_ID') return fixtures.taskId;
  return value;
}

async function replayVerifyRequest(operationId, requestExampleName) {
  const { db, migrate, close } = createDatabase(':memory:');
  migrate();
  try {
    const projectId = createProjectService(db).createProject({ name: 'Manifest replay', repo_path: '/tmp/manifest-replay' }).id;
    const taskService = createTaskService(db, null);
    const task = taskService.createTask({ title: 'Manifest replay task', project_id: projectId });
    const verifyCheckService = createVerifyCheckService(db);
    const artifact = verifyCheckService.createCheck({
      project_id: projectId,
      name: `artifact-${operationId}`,
      kind: 'artifact',
      spec: { files: [{ glob: 'dist/output/**', must_exist: true }] },
    }, { actor: 'operator' });
    const command = verifyCheckService.createCheck({
      project_id: projectId,
      name: `command-${operationId}`,
      kind: 'command',
      spec: { command: 'true' },
    }, { actor: 'human' });
    const operation = getManagerOperation(`verify_checks.${operationId}`);
    const requestExample = operation.request_examples[requestExampleName];
    const targetId = requestExample.target === 'command' ? command.id : artifact.id;
    let body;
    if (requestExample.body_example) {
      const [layer, name] = requestExample.body_example;
      body = replaceExampleFixtures(operation.request_body.examples[layer][name], {
        projectId,
        taskId: task.id,
      });
      if (Object.prototype.hasOwnProperty.call(body, 'check_id')) body.check_id = targetId;
    }
    const requests = {
      create: { method: 'POST', path: '/api/verify-checks', body },
      assign: { method: 'POST', path: '/api/verify-checks/assign', body },
      update: { method: 'PATCH', path: `/api/verify-checks/${targetId}`, body },
      delete: { method: 'DELETE', path: `/api/verify-checks/${targetId}` },
    };
    const response = await invokeManagerRoute(
      '/api/verify-checks',
      createVerifyChecksRouter({ verifyCheckService, taskService, goalFeatureActive: () => true }),
      { method: 'bearer', actor: 'manager', layer: 'operator', managerRunId: 'operator-1' },
      requests[operationId],
    );
    assert.equal(response.status, requestExample.expected_status, `${operation.id}:${requestExampleName}`);
    return response;
  } finally {
    close();
  }
}

async function assertVerifyCommandDenied(kind) {
  await replayVerifyRequest(kind, 'command_forbidden');
}

// Every critical manifest marker has one executable enforcement witness here.
// The set-equality test below makes both additions and removals fail closed.
const CRITICAL_ENFORCEMENT = Object.freeze({
  'runs.send_input:operator_only': {
    basis: 'manager allowlist is Operator-only',
    verify: async () => assertOperatorOnly('runs.send_input', '/api/runs/run-1/input'),
  },
  'runs.send_input:worker_target_only': {
    basis: 'runs route rejects manager targets',
    verify: async () => assertManagerRunInterventionDenied('input'),
  },
  'runs.cancel:operator_only': {
    basis: 'manager allowlist is Operator-only',
    verify: async () => assertOperatorOnly('runs.cancel', '/api/runs/run-1/cancel'),
  },
  'runs.cancel:worker_target_only': {
    basis: 'runs route rejects manager targets',
    verify: async () => assertManagerRunInterventionDenied('cancel'),
  },
  'tasks.update:reorder_not_task_id': {
    basis: 'manager allowlist rejects PATCH reorder variants',
    verify: async () => {
      for (const layer of LAYERS) {
        for (const path of ['/api/tasks/reorder', '/api/tasks/REORDER', '/api/tasks/%72eorder']) {
          assert.equal(managerCapabilityRequestAllowed({ method: 'PATCH', originalUrl: path }, { layer }), false);
        }
        // Harmless allowlist facts: reorder is PATCH-only, so GET/DELETE fall
        // through to /:id and return 404 rather than reaching the static route.
        assert.equal(managerCapabilityRequestAllowed({ method: 'GET', originalUrl: '/api/tasks/reorder' }, { layer }), true);
        assert.equal(managerCapabilityRequestAllowed({ method: 'DELETE', originalUrl: '/api/tasks/reorder' }, { layer }), true);
      }
    },
  },
  'tasks.update:goal_task_not_done': {
    basis: 'task service rejects a manager mutation that leaves a goal task done',
    verify: async () => assertGoalServiceInvariant('generic'),
  },
  'tasks.update_status:goal_task_done_forbidden': {
    basis: 'task service rejects manager done transition for a goal task',
    verify: async () => assertGoalServiceInvariant('status'),
  },
  'tasks.execute:operator_pm_run_self_attribution': {
    basis: 'tasks route binds Operator pm_run_id to the calling run',
    verify: async () => {
      assert.equal(await executeStatus('operator', 'operator-1', 'operator-2'), 403);
      assert.equal(await executeStatus('operator', 'operator-1', 'operator-1'), 201);
    },
  },
  'tasks.execute:top_no_pm_run_attribution': {
    basis: 'tasks route forbids Top from claiming an Operator run',
    verify: async () => {
      assert.equal(await executeStatus('top', 'top-1', 'operator-1'), 403);
      assert.equal(await executeStatus('top', 'top-1', undefined), 201);
      assert.equal(await executeStatus('top', 'top-1', null), 201);
    },
  },
  'conversations.message:top_no_worker_alias': {
    basis: 'manager allowlist prevents Top from using worker conversation aliases',
    verify: async () => {
      const operation = getManagerOperation('conversations.message');
      assert.equal(allowlisted(operation, '/api/conversations/worker:run-1/message', 'top'), false);
      assert.equal(allowlisted(operation, '/api/conversations/worker:run-1/message', 'operator'), true);
    },
  },
  'dispatch_audit.create:operator_pm_run_self_attribution': {
    basis: 'dispatch-audit route binds pm_run_id to the calling manager run',
    verify: async () => {
      const response = await invokeManagerRoute(
        '/api/dispatch-audit',
        createDispatchAuditRouter({ reconciliationService: { recordClaim: () => assert.fail('recordClaim must not be called') } }),
        { method: 'bearer', actor: 'manager', layer: 'operator', managerRunId: 'operator-1' },
        { method: 'POST', path: '/api/dispatch-audit', body: { project_id: 'project-1', pm_run_id: 'operator-2', pm_claim: { kind: 'task_complete' } } },
      );
      assert.equal(response.status, 403);
    },
  },
  'operator_specialist.invoke:own_origin_run': {
    basis: 'specialist route binds originRunId to the calling manager run',
    verify: async () => {
      const response = await invokeManagerRoute(
        '/api/operator/specialist',
        createOperatorSpecialistRouter({
          specialistService: { invokeSpecialist: async () => assert.fail('invokeSpecialist must not be called') },
          runService: { getRun: () => assert.fail('getRun must not be called') },
          operatorProfileService: { getProfile: () => assert.fail('getProfile must not be called') },
        }),
        { method: 'bearer', actor: 'manager', layer: 'top', managerRunId: 'top-1' },
        { method: 'POST', path: '/api/operator/specialist', body: { profileId: 'profile-1', userText: 'question', originRunId: 'top-2' } },
      );
      assert.equal(response.status, 403);
    },
  },
  'verify_checks.create:artifact_only': {
    basis: 'verify-check route rejects manager command-check creation',
    verify: async () => assertVerifyCommandDenied('create'),
  },
  'verify_checks.assign:artifact_only': {
    basis: 'verify-check route rejects manager command-check assignment',
    verify: async () => assertVerifyCommandDenied('assign'),
  },
  'verify_checks.update:artifact_only': {
    basis: 'verify-check route rejects manager command-check edits',
    verify: async () => assertVerifyCommandDenied('update'),
  },
  'verify_checks.delete:artifact_only': {
    basis: 'verify-check route rejects manager command-check deletion',
    verify: async () => assertVerifyCommandDenied('delete'),
  },
});

test('manager operation manifest has stable, deeply frozen plain data', () => {
  assert.equal(managerOperationManifest.contract_scope, 'manager_agent_calls_not_route_validator_source');
  const ids = managerOperationManifest.operations.map(operation => operation.id);
  assert.equal(new Set(ids).size, ids.length, 'operation ids must be unique');

  for (const operation of managerOperationManifest.operations) {
    assert.match(operation.id, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/);
    assert.ok(METHODS.has(operation.method), `${operation.id}: method`);
    assert.ok(AVAILABILITY.has(operation.availability), `${operation.id}: availability`);
    assert.ok(operation.layers.length > 0, `${operation.id}: layers`);
    assert.ok(operation.layers.every(layer => LAYERS.includes(layer)), `${operation.id}: layers enum`);
    assert.match(operation.path_template, /^\/api\/(?:[^/?#{}]+|\{[a-z][a-z0-9_]*\})(?:\/(?:[^/?#{}]+|\{[a-z][a-z0-9_]*\}))*$/);
    assert.equal(operation.request_body.contract_scope, 'manager_agent_call_not_route_validator_source');
    assert.ok(Array.isArray(operation.canonical_cases) && operation.canonical_cases.length > 0);
  }

  walkObjects(managerOperationManifest, value => {
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
    assert.ok(Object.isFrozen(value), 'every manifest object/array must be frozen');
  });

  const firstJson = JSON.stringify(managerOperationManifest);
  assert.throws(() => { managerOperationManifest.operations[0].id = 'mutated'; }, TypeError);
  assert.equal(JSON.stringify(managerOperationManifest), firstJson);
  delete require.cache[manifestModulePath];
  assert.equal(JSON.stringify(require(manifestModulePath).managerOperationManifest), firstJson);
});

test('every manifest canonical case is accepted only for its declared layers', () => {
  for (const operation of managerOperationManifest.operations) {
    for (const requestPath of operation.canonical_cases) {
      for (const layer of LAYERS) {
        assert.equal(
          allowlisted(operation, requestPath, layer),
          operation.layers.includes(layer),
          `${operation.id} ${layer} ${operation.method} ${requestPath}`,
        );
      }
    }
  }
});

function assertPromptProvenance({ text, segments, trace, referencedOperationIds }, layer) {
    assert.equal(text, segments.map(segment => segment.text).join(''), `${layer}: segment serialization`);
    const operationSegments = segments.filter(segment => segment.kind === 'operation');
    assert.deepEqual(trace, operationSegments, `${layer}: trace must derive from serialized operation segments`);
    assert.deepEqual(referencedOperationIds, operationSegments.map(segment => segment.id));
    for (const segment of segments) {
      if (segment.kind === 'literal') {
        assert.deepEqual(Object.keys(segment).sort(), ['kind', 'text']);
        assert.equal(segment.text.includes('/api/'), false, `${layer}: /api/ literal outside operation segment`);
      } else {
        assert.deepEqual(Object.keys(segment).sort(), ['id', 'kind', 'method', 'renderedPath', 'text']);
      }
    }
    const traced = new Set(referencedOperationIds);
    const expected = new Set(managerOperationManifest.operations
      .filter(operation => promptVisibleFor(operation, layer, 'codex'))
      .map(operation => operation.id));
    assert.deepEqual([...traced].sort(), [...expected].sort(), `${layer}: visible operation trace`);

    for (const entry of trace) {
      assert.deepEqual(Object.keys(entry).sort(), ['id', 'kind', 'method', 'renderedPath', 'text']);
      assert.equal(entry.method, getManagerOperation(entry.id).method, `${entry.id}: trace method`);
      assert.match(operationPathOnly(entry.renderedPath), templatePattern(getManagerOperation(entry.id).path_template));
    }

    assert.ok(operationSegments.length > 20, `${layer}: prompt API operation segments`);

    for (const operation of managerOperationManifest.operations.filter(item => !item.prompt.visible)) {
      assert.equal(traced.has(operation.id), false, `${operation.id}: hidden operation must not be traced`);
    }
}

function tracedPrompt(layer) {
  return buildManagerSystemPromptWithTrace({
    adapter: null,
    port: 4317,
    apiBaseUrl: 'http://manager.manifest.test:4317/prefix',
    layer,
    adapterType: 'codex',
    token: 'fixed-manager-capability',
    specialistAvailable: true,
  });
}

test('prompt text and provenance are serialized from the same structured segments', () => {
  for (const layer of LAYERS) {
    assertPromptProvenance(tracedPrompt(layer), layer);
  }
});

test('prompt query examples are owned by the operation query declarations', () => {
  for (const operation of managerOperationManifest.operations) {
    const declared = new Map(operation.query.map(query => [query.name, String(query.example)]));
    for (const line of operation.prompt.lines) {
      if (!line.query) continue;
      const entries = [...new URLSearchParams(line.query).entries()];
      assert.ok(entries.length > 0, `${operation.id}: empty prompt query`);
      for (const [name, value] of entries) {
        assert.equal(declared.get(name), value, `${operation.id}: prompt query ${name}`);
      }
    }
  }
});

test('manager prompt normalizes legacy and invalid layers to byte-identical Top output', () => {
  const args = { adapter: null, port: 4317, adapterType: 'codex', specialistAvailable: true };
  const top = buildManagerSystemPrompt({ ...args, layer: 'top' });
  for (const layer of ['pm', null, 'bogus']) {
    assert.equal(buildManagerSystemPrompt({ ...args, layer }), top, String(layer));
  }
});

test('curl examples derive explicit methods and guard implicit GET from the manifest', () => {
  const text = buildManagerSystemPrompt({
    adapter: null,
    port: 4317,
    layer: 'operator',
    adapterType: 'codex',
    specialistAvailable: true,
  });
  for (const id of ['tasks.create', 'tasks.update_status', 'tasks.delete', 'operator_specialist.invoke']) {
    const operation = getManagerOperation(id);
    assert.match(text, new RegExp(`curl[^\\n]*-X ${operation.method} [^\\n]*${operation.path_template.replace(/\{[^}]+\}/g, '[^/\\s]+')}`));
  }
  for (const id of ['runs.list', 'operator_profiles.list']) {
    const operation = getManagerOperation(id);
    assert.equal(operation.method, 'GET');
    assert.match(text, new RegExp(`curl[^\\n]*(?<!-X GET )${operation.path_template}`));
    assert.doesNotMatch(text, new RegExp(`-X GET [^\\n]*${operation.path_template}`));
  }
});

test('prompt render override is a minimal transform and cannot drift from its canonical example', () => {
  const operation = getManagerOperation('tasks.execute');
  assert.deepEqual(
    operation.request_body.examples.operator.rest.skill_pack_ids,
    ['PACK_ID', '...'],
  );
  const override = operation.request_body.prompt_render_overrides.operator.rest;
  assert.deepEqual(override, { raw_json_values: [{ path: ['skill_pack_ids', 1], value: '...' }] });
  const rendered = '{"agent_profile_id":"AGENT_ID","prompt":"detailed work instructions here","pm_run_id":"YOUR_OWN_OPERATOR_RUN_ID","skill_pack_ids":["PACK_ID",...]}';
  assert.match(buildManagerSystemPrompt({ adapter: null, port: 4317, layer: 'operator' }), new RegExp(rendered.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(rendered.replace('["PACK_ID",...]', '["PACK_ID","..."]'), JSON.stringify(operation.request_body.examples.operator.rest));
});

test('verify-check manifest examples replay through the real router, service, and database', async () => {
  for (const operationName of ['create', 'update', 'assign', 'delete']) {
    const operation = getManagerOperation(`verify_checks.${operationName}`);
    assert.deepEqual(Object.keys(operation.request_examples).sort(), ['artifact_success', 'command_forbidden']);
    assert.equal(operation.request_examples.command_forbidden.expected_status, 403);
    assert.ok(operation.request_examples.command_forbidden.note);
    await replayVerifyRequest(operationName, 'artifact_success');
    await replayVerifyRequest(operationName, 'command_forbidden');
  }
});

test('every request-body example declares its executable replay boundary', () => {
  const replayedOperations = new Set([
    'actions.declare', 'runs.send_input', 'tasks.create', 'tasks.update', 'tasks.update_status', 'tasks.execute',
    'conversations.message', 'conversations.memory_propose', 'dispatch_audit.create',
    'operator_specialist.invoke', 'verify_checks.create', 'verify_checks.assign', 'verify_checks.update',
  ]);
  const bodyOperations = managerOperationManifest.operations.filter(operation => (
    Object.values(operation.request_body.examples).some(layer => Object.keys(layer).length > 0)
  ));
  assert.deepEqual(bodyOperations.map(operation => operation.id).sort(), [...replayedOperations].sort());
  for (const operation of bodyOperations) {
    assert.ok(['mounted_route_success', 'real_service_validation', 'real_service_database'].includes(operation.request_body.replay.mode), `${operation.id}: replay mode`);
    for (const [layer, examples] of Object.entries(operation.request_body.examples)) {
      for (const [name, body] of Object.entries(examples)) {
        assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${operation.id}:${layer}:${name}`);
      }
    }
  }
});

async function replayBodyExample(operation, layer, name, example) {
  const { db, migrate, close } = createDatabase(':memory:');
  migrate();
  try {
    const project = createProjectService(db).createProject({ name: `Replay ${operation.id}`, repo_path: '/tmp/manifest-replay' });
    const taskService = createTaskService(db, null);
    const task = taskService.createTask({ title: 'Replay target', project_id: project.id });
    const managerRunId = layer === 'operator' ? 'operator-run-1' : 'top-run-1';
    const fixtures = {
      projectId: project.id,
      taskId: task.id,
    };
    let body = replaceExampleFixtures(example, fixtures);
    const replaceStrings = value => {
      if (Array.isArray(value)) return value.map(replaceStrings);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceStrings(item)]));
      const replacements = {
        '...': 'A documented example value long enough for route validation.',
        AGENT_ID: 'agent-1',
        YOUR_OWN_OPERATOR_RUN_ID: managerRunId,
        YOUR_OWN_PM_RUN_ID: managerRunId,
        RUN_ID: managerRunId,
        PROFILE_ID: 'profile-1',
      };
      if (typeof value === 'string' && value.includes('|')) return value.split('|')[0];
      return replacements[value] || value;
    };
    body = replaceStrings(body);
    if (Object.prototype.hasOwnProperty.call(body, 'project_id')) body.project_id = project.id;
    if (Object.prototype.hasOwnProperty.call(body, 'task_id')) body.task_id = task.id;
    const pathParams = {
      run_id: 'worker-run-1',
      task_id: task.id,
      conversation_id: layer === 'operator' ? `operator:${project.id}` : 'top',
    };
    const requestPath = renderOperationPath(operation.id, { path_params: pathParams });
    let mountPath;
    let router;
    if (operation.id === 'runs.send_input') {
      mountPath = '/api/runs';
      router = createRunsRouter({
        runService: { getRun: () => ({ id: 'worker-run-1', is_manager: 0, status: 'running' }) },
        lifecycleService: { sendAgentInput: async () => true },
      });
    } else if (operation.id.startsWith('tasks.')) {
      mountPath = '/api/tasks';
      router = createTasksRouter({
        taskService,
        lifecycleService: { executeTask: async id => ({ id: `run-for-${id}` }) },
      });
    } else if (operation.id === 'actions.declare') {
      taskService.updateTask(task.id, { goal_enabled: 1, goal_kind: 'action' });
      mountPath = '/api/actions';
      router = createActionsRouter({ ledger: createActionLedgerService(db), taskService });
    } else if (operation.id === 'conversations.memory_propose') {
      mountPath = '/api';
      const resolvedKind = layer === 'operator' ? 'pm' : 'top';
      router = createMemoryProposalsRouter({
        conversationService: {
          resolveConversation: () => ({
            kind: resolvedKind,
            projectId: project.id,
            run: { id: managerRunId, is_manager: 1 },
          }),
          getLastTurnContext: () => ({ workspaceProjectId: project.id }),
        },
        runService: {},
        memoryService: { createCandidate: () => ({ id: 1, status: 'pending' }) },
        masterMemoryService: { createCandidate: () => ({ id: 1, status: 'pending' }) },
        projectService: { getProject: id => ({ id }) },
      });
    } else if (operation.id === 'conversations.message') {
      mountPath = '/api/conversations';
      router = createConversationsRouter({
        conversationService: createConversationService({
          runService: {},
          managerRegistry: { probeActive: () => null },
          managerAdapterFactory: {},
        }),
        runService: {},
      });
    } else if (operation.id === 'dispatch_audit.create') {
      mountPath = '/api/dispatch-audit';
      router = createDispatchAuditRouter({ reconciliationService: { recordClaim: () => ({ id: 1 }) } });
    } else if (operation.id === 'operator_specialist.invoke') {
      mountPath = '/api/operator/specialist';
      router = createOperatorSpecialistRouter({
        specialistService: { invokeSpecialist: async () => ({ text: 'ok' }) },
        runService: { getRun: () => ({ id: managerRunId, is_manager: 1, manager_layer: layer, status: 'running' }) },
        operatorProfileService: { getProfile: () => ({ id: 'profile-1', enabled: 1 }) },
      });
    } else {
      assert.fail(`${operation.id}:${layer}:${name} has no route replay`);
    }
    const response = await invokeManagerRoute(
      mountPath,
      router,
      { method: 'bearer', actor: 'manager', layer, managerRunId },
      { method: operation.method, path: requestPath, body },
    );
    if (operation.request_body.replay.mode === 'real_service_validation') {
      assert.equal(response.status, operation.request_body.replay.success_boundary_status, `${operation.id}:${layer}:${name} must pass body validation before its unavailable-session boundary`);
      assert.match(response.body.error, /No active (?:Top|PM) manager session/);
    } else {
      assert.ok(response.status >= 200 && response.status < 300, `${operation.id}:${layer}:${name} returned ${response.status} ${JSON.stringify(response.body)}`);
    }
  } finally {
    close();
  }
}

test('declared non-verify body examples reach their named replay boundary', async () => {
  for (const operation of managerOperationManifest.operations) {
    if (operation.id.startsWith('verify_checks.')) continue;
    for (const [layer, examples] of Object.entries(operation.request_body.examples)) {
      for (const [name, example] of Object.entries(examples)) {
        await replayBodyExample(operation, layer, name, example);
      }
    }
  }
});

let manifestAppSeq = 0;
function manifestAppOptions(options = {}) {
  manifestAppSeq += 1;
  const root = path.join(os.tmpdir(), `palantir-manifest-${process.pid}-${manifestAppSeq}`);
  fs.mkdirSync(root, { recursive: true });
  return {
    dbPath: ':memory:',
    storageRoot: root,
    fsRoot: root,
    authToken: null,
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
    ...options,
  };
}

function productionRouterMounts(app) {
  const candidates = new Set(['/api']);
  for (const operation of managerOperationManifest.operations) {
    const segments = operation.path_template.split('/').filter(Boolean);
    for (let count = 1; count <= segments.length; count += 1) {
      if (segments.slice(0, count).some(segment => segment.startsWith('{'))) break;
      candidates.add(`/${segments.slice(0, count).join('/')}`);
    }
  }
  const ordered = [...candidates].sort((left, right) => left.length - right.length);
  const mounts = [];
  for (const layer of app.router.stack) {
    if (!layer.handle?.stack || !Array.isArray(layer.matchers)) continue;
    const mountPath = ordered.find(candidate => layer.matchers.some(matcher => matcher(candidate)?.path === candidate));
    if (mountPath) mounts.push([mountPath, layer.handle]);
  }
  return mounts;
}

test('availability metadata equals gates on production createApp instances', async () => {
  const expectedGoalMode = ['verify_checks.assign', 'verify_checks.create', 'verify_checks.delete', 'verify_checks.get', 'verify_checks.list', 'verify_checks.update'];
  assert.deepEqual(managerOperationManifest.operations.filter(item => item.availability === 'goal_mode').map(item => item.id).sort(), expectedGoalMode);
  assert.deepEqual(managerOperationManifest.operations.filter(item => item.availability === 'specialist_mounted').map(item => item.id), ['operator_specialist.invoke']);

  const gatedApp = createApp(manifestAppOptions({ goalFeatureActive: () => false }));
  const availableApp = createApp(manifestAppOptions({ goalFeatureActive: () => true }));
  const specialistApp = createApp(manifestAppOptions({
    goalFeatureActive: () => false,
    operatorSpecialistEnabled: true,
    specialistBackend: { runSpecialistTurn: async () => ({ text: 'ok' }) },
  }));
  try {
    assert.equal(gatedApp.services.actionBroker, undefined, 'createApp must not construct an action broker');
    assert.equal((await invokeApp(gatedApp, { method: 'GET', path: '/api/verify-checks' })).status, 503);
    assert.equal((await invokeApp(availableApp, { method: 'GET', path: '/api/verify-checks' })).status, 200);
    assert.equal((await invokeApp(gatedApp, { method: 'GET', path: '/api/tasks' })).status, 200);
    assert.equal(productionRouterMounts(gatedApp).some(([path]) => path === '/api/operator/specialist'), false);
    assert.equal(productionRouterMounts(specialistApp).some(([path]) => path === '/api/operator/specialist'), true);
  } finally {
    await Promise.all([gatedApp.shutdown(), availableApp.shutdown(), specialistApp.shutdown()]);
  }
});

test('tasks.update owns reorder_not_task_id and auth behavior matches each method', async () => {
  const keys = new Set(managerOperationManifest.operations.flatMap(operation => (
    operation.constraints.map(constraint => `${operation.id}:${constraint.id}`)
  )));
  assert.ok(keys.has('tasks.update:reorder_not_task_id'));
  assert.equal(keys.has('tasks.get:reorder_not_task_id'), false);
  assert.equal(keys.has('tasks.delete:reorder_not_task_id'), false);
  await CRITICAL_ENFORCEMENT['tasks.update:reorder_not_task_id'].verify();
});

test('critical manifest set equals executable enforcement map and every witness runs', async () => {
  const criticalKeys = managerOperationManifest.operations.flatMap(operation => (
    operation.constraints
      .filter(constraint => constraint.critical)
      .map(constraint => `${operation.id}:${constraint.id}`)
  )).sort();
  assert.deepEqual(criticalKeys, Object.keys(CRITICAL_ENFORCEMENT).sort());
  for (const [key, enforcement] of Object.entries(CRITICAL_ENFORCEMENT)) {
    assert.ok(enforcement.basis, `${key}: enforcement basis`);
    await enforcement.verify();
  }
});

test('auth trailing-slash behavior stays operation-specific', () => {
  const exactOnly = [
    ['POST', '/api/tasks'],
    ['POST', '/api/dispatch-audit'],
    ['POST', '/api/operator/specialist'],
    ['POST', '/api/verify-checks'],
    ['POST', '/api/verify-checks/assign'],
  ];
  for (const [method, path] of exactOnly) {
    assert.equal(managerCapabilityRequestAllowed({ method, originalUrl: path }, { layer: 'operator' }), true, `${method} ${path}`);
    assert.equal(managerCapabilityRequestAllowed({ method, originalUrl: `${path}/` }, { layer: 'operator' }), false, `${method} ${path}/`);
  }
  assert.equal(managerCapabilityRequestAllowed({ method: 'POST', originalUrl: '/api/tasks/task-1/execute' }, { layer: 'operator' }), true);
  assert.equal(managerCapabilityRequestAllowed({ method: 'POST', originalUrl: '/api/tasks/task-1/execute/' }, { layer: 'operator' }), true);
});

function enumerateExpressRoutes(router, prefix = '') {
  const routes = [];
  for (const layer of router.stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of paths) {
        assert.equal(typeof routePath, 'string', 'route collision audit requires enumerable string paths');
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push({ method: method.toUpperCase(), routePath: `${prefix}${routePath}` });
        }
      }
    } else if (layer.handle?.stack) {
      assert.ok(layer.regexp?.fast_slash || layer.path === '/', 'nested routers must expose an enumerable mount path');
      routes.push(...enumerateExpressRoutes(layer.handle, prefix));
    }
  }
  return routes;
}

function routeShapeMatchesManifest(routePath, pathTemplate) {
  const routeSegments = routePath.split('/').filter(Boolean);
  const manifestSegments = pathTemplate.split('/').filter(Boolean);
  if (routeSegments.length !== manifestSegments.length) return false;
  return routeSegments.every((segment, index) => (
    segment.startsWith(':')
      ? /^\{[^}]+\}$/.test(manifestSegments[index])
      : segment === manifestSegments[index]
  ));
}

function routeWitness(routePath) {
  return routePath
    .replace(/:([A-Za-z0-9_]+)(?:\([^)]*\))?[?+*]?/g, 'route-param');
}

function assertNoCapturedRoutes(mounts) {
  for (const [mountPath, router] of mounts) {
    for (const route of enumerateExpressRoutes(router)) {
      const fullRoutePath = `${mountPath}${route.routePath === '/' ? '' : route.routePath}`;
      const localSegments = route.routePath.split('/').filter(Boolean);
      if (!localSegments.some(segment => !segment.startsWith(':'))) continue;
      const witness = routeWitness(fullRoutePath);
      for (const layer of LAYERS) {
        const captured = managerCapabilityRequestAllowed({ method: route.method, originalUrl: witness }, { layer });
        if (!captured) continue;
        assert.ok(
          managerOperationManifest.operations.some(operation => (
            operation.method === route.method
            && operation.layers.includes(layer)
            && routeShapeMatchesManifest(fullRoutePath, operation.path_template)
          )),
          `${route.method} ${fullRoutePath} is captured by the ${layer} manager allowlist without an exact manifest operation`,
        );
      }
    }
  }
}

test('production createApp router stack is audited for manager wildcard capture', async () => {
  const app = createApp(manifestAppOptions({
    goalFeatureActive: () => true,
    operatorSpecialistEnabled: true,
    specialistBackend: { runSpecialistTurn: async () => ({ text: 'ok' }) },
  }));
  try {
    assertNoCapturedRoutes(productionRouterMounts(app));
  } finally {
    await app.shutdown();
  }
});

test('required hostile regressions are rejected by executable witnesses', async () => {
  const operatorPrompt = tracedPrompt('operator');

  // A: a method-mismatched hard-coded call is an untraced output occurrence.
  const rogueLiteral = { kind: 'literal', text: '\n- Rogue write: POST http://manager.manifest.test:4317/prefix/api/runs' };
  assert.throws(() => assertPromptProvenance({
    ...operatorPrompt,
    text: `${operatorPrompt.text}${rogueLiteral.text}`,
    segments: [...operatorPrompt.segments, rogueLiteral],
  }, 'operator'), /\/api\/ literal outside operation segment/);

  // B: operationReference() was evaluated with trace but its returned fragment
  // was discarded instead of being interpolated into the final prompt.
  assert.throws(() => assertPromptProvenance({
    ...operatorPrompt,
    trace: [...operatorPrompt.trace, operatorPrompt.trace[0]],
  }, 'operator'), /trace must derive from serialized operation segments/);

  // Same path template, wrong operation id/method attribution.
  const crossed = operatorPrompt.segments.map(entry => entry.id === 'tasks.update'
    ? { ...entry, id: 'tasks.delete' }
    : entry);
  assert.throws(() => assertPromptProvenance({
    text: operatorPrompt.text,
    segments: crossed,
    trace: crossed.filter(entry => entry.kind === 'operation'),
    referencedOperationIds: crossed.filter(entry => entry.kind === 'operation').map(entry => entry.id),
  }, 'operator'), /visible operation trace|trace method/);

  // The pre-round-3 artifact_path body really reaches the route and is 400,
  // proving the documented 201 replay would fail if that example returned.
  const { db, migrate, close } = createDatabase(':memory:');
  migrate();
  try {
    const projectId = createProjectService(db).createProject({ name: 'Old body mutant' }).id;
    const verifyCheckService = createVerifyCheckService(db);
    const response = await invokeManagerRoute(
      '/api/verify-checks',
      createVerifyChecksRouter({ verifyCheckService, taskService: createTaskService(db, null), goalFeatureActive: () => true }),
      { method: 'bearer', actor: 'manager', layer: 'operator' },
      { method: 'POST', path: '/api/verify-checks', body: { project_id: projectId, name: 'old', kind: 'artifact', artifact_path: 'dist/output' } },
    );
    assert.equal(response.status, 400);
    assert.match(response.body.error, /spec must be an object/);
  } finally {
    close();
  }

  // Any availability reclassification changes the exact runtime-gate sets.
  const mutatedAvailability = managerOperationManifest.operations.map(operation => (
    operation.id === 'runs.list' ? { ...operation, availability: 'goal_mode' } : operation
  ));
  assert.throws(() => assert.deepEqual(
    mutatedAvailability.filter(item => item.availability === 'goal_mode').map(item => item.id).sort(),
    ['verify_checks.assign', 'verify_checks.create', 'verify_checks.delete', 'verify_checks.get', 'verify_checks.list', 'verify_checks.update'],
  ));

  // A static route on the second /api/tasks router is captured by GET /:id and
  // therefore must have an exact manifest declaration.
  const rogueRouter = express.Router();
  rogueRouter.get('/rogue-static', (_req, res) => res.json({ ok: true }));
  assert.throws(() => assertNoCapturedRoutes([['/api/tasks', rogueRouter]]), /without an exact manifest operation/);

  const queryMutant = { ...getManagerOperation('runs.list'), query: getManagerOperation('runs.list').query.map(query => (
    query.name === 'status' ? { ...query, example: 'failed' } : query
  )) };
  const statusLine = queryMutant.prompt.lines.find(line => line.query?.startsWith('status='));
  assert.notEqual(new Map(queryMutant.query.map(query => [query.name, String(query.example)])).get('status'), new URLSearchParams(statusLine.query).get('status'));
});
