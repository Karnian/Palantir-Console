'use strict';

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');

const { createApp } = require('../app');
const { managerOperationManifest } = require('../services/managerOperationManifest');
const { invokeApp } = require('./helpers/invokeApp');

const LAYERS = ['top', 'operator'];
const PROJECTED_FIELDS = [
  'id',
  'method',
  'path_template',
  'path_params',
  'query',
  'request_body',
  'constraints',
];

let appSequence = 0;
function manifestAppOptions(options = {}) {
  appSequence += 1;
  const root = path.join(os.tmpdir(), `palantir-agent-context-${process.pid}-${appSequence}`);
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

function availableFor(operation, { goalActive, specialistAvailable }) {
  return operation.availability === 'always'
    || (operation.availability === 'goal_mode' && goalActive)
    || (operation.availability === 'specialist_mounted' && specialistAvailable);
}

function expectedOperationIds(layer, gates) {
  return managerOperationManifest.operations
    .filter(operation => operation.layers.includes(layer) && availableFor(operation, gates))
    .map(operation => operation.id);
}

function managerAuthorization(app, layer) {
  const conversationId = layer === 'top' ? 'top' : `operator:agent-context-${appSequence}`;
  const run = app.services.runService.createRun({
    is_manager: true,
    manager_layer: layer,
    conversation_id: conversationId,
    manager_adapter: 'codex',
    prompt: `${layer} agent context`,
  });
  app.services.runService.updateRunStatus(run.id, 'running', { force: true });
  app.managerRegistry.setActive(conversationId, run.id, {
    isSessionAlive: () => true,
    detectExitCode: () => null,
    disposeSession: () => true,
  });
  const token = app.services.managerCapabilityTokenService.mint(run.id, {
    conversationId,
    layer,
  });
  return { Authorization: `Bearer ${token}` };
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
    const mountPath = ordered.find(candidate => (
      layer.matchers.some(matcher => matcher(candidate)?.path === candidate)
    ));
    if (mountPath) mounts.push([mountPath, layer.handle]);
  }
  return mounts;
}

function enumerateExpressRoutes(router, prefix = '') {
  const routes = [];
  for (const layer of router.stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of paths) {
        assert.equal(typeof routePath, 'string', 'route drift guard requires enumerable string paths');
        for (const [method, enabled] of Object.entries(layer.route.methods)) {
          if (enabled) routes.push({ method: method.toUpperCase(), routePath: `${prefix}${routePath}` });
        }
      }
    } else if (layer.handle?.stack) {
      assert.ok(
        layer.regexp?.fast_slash || layer.path === '/',
        'nested routers must expose an enumerable mount path',
      );
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

function mountedOperationIds(app) {
  const routes = productionRouterMounts(app).flatMap(([mountPath, router]) => (
    enumerateExpressRoutes(router).map(route => ({
      method: route.method,
      path: `${mountPath}${route.routePath === '/' ? '' : route.routePath}`,
    }))
  ));
  return new Set(managerOperationManifest.operations
    .filter(operation => routes.some(route => (
      route.method === operation.method
      && routeShapeMatchesManifest(route.path, operation.path_template)
    )))
    .map(operation => operation.id));
}

test('agent context derives layer and authority from manager capabilities', async () => {
  const app = createApp(manifestAppOptions({
    authToken: 'agent-context-token',
    pmToken: 'agent-context-pm-token',
    agentProcessIsolation: true,
  }));
  try {
    const topAuthorization = managerAuthorization(app, 'top');
    const operatorAuthorization = managerAuthorization(app, 'operator');

    const top = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context',
      headers: topAuthorization,
    });
    assert.equal(top.status, 200);
    assert.equal(top.body.layer, 'top');
    assert.ok(top.body.operations.every(operation => (
      managerOperationManifest.operations.find(candidate => candidate.id === operation.id)
        .layers.includes('top')
    )));

    const operator = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context',
      headers: operatorAuthorization,
    });
    assert.equal(operator.status, 200);
    assert.equal(operator.body.layer, 'operator');
    assert.ok(operator.body.operations.every(operation => (
      managerOperationManifest.operations.find(candidate => candidate.id === operation.id)
        .layers.includes('operator')
    )));
    assert.notDeepEqual(
      top.body.operations.map(operation => operation.id),
      operator.body.operations.map(operation => operation.id),
      'top and operator operation lists must differ',
    );

    const cookie = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context',
      headers: { Cookie: 'palantir_token=agent-context-token' },
    });
    assert.equal(cookie.status, 403);
    assert.match(cookie.body.error, /manager capability required/);

    for (const token of ['agent-context-token', 'agent-context-pm-token']) {
      const bearer = await invokeApp(app, {
        method: 'GET', path: '/api/agent-context', headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(bearer.status, 403);
      assert.match(bearer.body.error, /manager capability required/);
    }

    const workerToken = app.services.workerProposalTokenService.mint('worker-run', {
      projectId: 'worker-project',
    });
    const worker = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context',
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    assert.equal(worker.status, 403);

    const mismatch = await invokeApp(app, {
      method: 'GET', path: '/api/agent-context?layer=top', headers: operatorAuthorization,
    });
    assert.equal(mismatch.status, 400);

    const matching = await invokeApp(app, {
      method: 'GET', path: '/api/agent-context?layer=operator', headers: operatorAuthorization,
    });
    assert.equal(matching.status, 200);
    assert.equal(matching.headers['cache-control'], 'private, no-store');
    assert.equal(matching.headers.vary, 'Authorization', 'per-caller responses must not be shared across Authorization values');
    assert.equal(matching.headers.vary, 'Authorization');

    const post = await invokeApp(app, {
      method: 'POST', path: '/api/agent-context', headers: topAuthorization,
    });
    assert.equal(post.status, 403);
    const lookalike = await invokeApp(app, {
      method: 'GET', path: '/api/agent-contextX', headers: topAuthorization,
    });
    assert.equal(lookalike.status, 403);
  } finally {
    await app.shutdown();
  }
});

test('agent context fails closed when authentication is disabled', async () => {
  const app = createApp(manifestAppOptions({ authToken: null }));
  try {
    const response = await invokeApp(app, { method: 'GET', path: '/api/agent-context' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /manager capability required/);
  } finally {
    await app.shutdown();
  }
});

test('agent context projection and runtime gates cannot drift from production routes', async () => {
  for (const goalActive of [false, true]) {
    for (const specialistAvailable of [false, true]) {
      const app = createApp(manifestAppOptions({
        authToken: 'agent-context-drift-token',
        agentProcessIsolation: true,
        goalFeatureActive: () => goalActive,
        ...(specialistAvailable ? {
          operatorSpecialistEnabled: true,
          specialistBackend: { runSpecialistTurn: async () => ({ text: 'ok' }) },
        } : {}),
      }));
      try {
        const authorizations = Object.fromEntries(
          LAYERS.map(layer => [layer, managerAuthorization(app, layer)]),
        );
        const mounts = productionRouterMounts(app);
        const mountedIds = mountedOperationIds(app);
        // A2: the gate moved to kind level, so a 200 on GET /api/verify-checks no
        // longer signals goal mode — artifact reads are open in both modes.
        const verifyChecksResponse = await invokeApp(app, {
          method: 'GET', path: '/api/verify-checks',
          headers: { Authorization: 'Bearer agent-context-drift-token' },
        });
        assert.equal(verifyChecksResponse.status, 200, 'artifact verify-check reads stay available');
        // The drift guard must still PROBE the runtime, never copy the expectation
        // (`runtimeGoalActive = goalActive` would make this test assert nothing).
        // `POST /assign` is the operation that stayed wholly goal-gated, so it is
        // the honest runtime signal now.
        const goalGateResponse = await invokeApp(app, {
          method: 'POST', path: '/api/verify-checks/assign', body: { task_id: 'probe', check_id: null },
          headers: { Authorization: 'Bearer agent-context-drift-token' },
        });
        // `/assign` runs requireAuth BEFORE the goal check, so an unauthenticated
        // probe against an auth-enabled app would 401 and be misread as "goal
        // active". Fail loudly instead of judging on a response that never
        // reached the gate we are probing.
        assert.notEqual(goalGateResponse.status, 401,
          'goal-gate probe must reach the goal check, not stop at the auth gate');
        const runtimeGoalActive = goalGateResponse.status !== 503;
        const runtimeSpecialistAvailable = mounts.some(([mountPath]) => (
          mountPath === '/api/operator/specialist'
        ));

        assert.equal(
          runtimeGoalActive,
          goalActive,
          'goal manifest gate must equal the mounted route gate',
        );
        assert.equal(
          runtimeSpecialistAvailable,
          specialistAvailable,
          'specialist manifest gate must equal the production mount gate',
        );

        for (const layer of LAYERS) {
          const response = await invokeApp(app, {
            method: 'GET',
            path: '/api/agent-context',
            headers: authorizations[layer],
          });
          assert.equal(response.status, 200);
          assert.equal(response.body.layer, layer);

          const advertisedIds = response.body.operations.map(operation => operation.id);
          const expectedIds = expectedOperationIds(layer, { goalActive, specialistAvailable });
          assert.deepEqual(advertisedIds, expectedIds, `${layer}: manifest filter and order`);

          for (const operation of response.body.operations) {
            assert.deepEqual(Object.keys(operation).sort(), [...PROJECTED_FIELDS].sort());
            assert.equal(Object.hasOwn(operation, 'prompt'), false);
            assert.equal(Object.hasOwn(operation, 'canonical_cases'), false);
            assert.ok(
              managerOperationManifest.operations
                .find(candidate => candidate.id === operation.id)
                .layers.includes(layer),
            );
          }

          if (layer === 'operator') {
            assert.ok(advertisedIds.includes('runs.send_input'), 'operator-scoped operation is present');
          } else {
            assert.equal(advertisedIds.includes('runs.send_input'), false);
          }
          assert.equal(
            advertisedIds.includes('operator_specialist.invoke'),
            specialistAvailable,
          );

          const runtimeReachableIds = managerOperationManifest.operations
            .filter(operation => (
              operation.layers.includes(layer)
              && mountedIds.has(operation.id)
              && availableFor(operation, {
                goalActive: runtimeGoalActive,
                specialistAvailable: runtimeSpecialistAvailable,
              })
            ))
            .map(operation => operation.id);
          assert.deepEqual(
            advertisedIds,
            runtimeReachableIds,
            `${layer}: advertised operations equal actually reachable production routes`,
          );

          const layerHasGoalOperations = managerOperationManifest.operations.some(operation => (
            operation.layers.includes(layer) && operation.availability === 'goal_mode'
          ));
          if (!goalActive && layerHasGoalOperations) {
            // Mutation witness: dropping the goal_mode gate adds verify-check
            // operations and must fail the exact manifest/runtime equality above.
            const droppedGoalGateIds = managerOperationManifest.operations
              .filter(operation => (
                operation.layers.includes(layer)
                && mountedIds.has(operation.id)
                && (
                  operation.availability !== 'specialist_mounted'
                  || runtimeSpecialistAvailable
                )
              ))
              .map(operation => operation.id);
            assert.notDeepEqual(droppedGoalGateIds, advertisedIds, 'dropping goal_mode gate is detected');
          }
        }
      } finally {
        await app.shutdown();
      }
    }
  }
});
