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

test('agent context requires a valid layer and inherits API authentication', async () => {
  const app = createApp(manifestAppOptions({ authToken: 'agent-context-token' }));
  try {
    const unauthorized = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context?layer=top',
    });
    assert.equal(unauthorized.status, 403);

    const authorization = { Authorization: 'Bearer agent-context-token' };
    const missing = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context',
      headers: authorization,
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /layer must be top or operator/);

    const bogus = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context?layer=bogus',
      headers: authorization,
    });
    assert.equal(bogus.status, 400);
    assert.match(bogus.body.error, /layer must be top or operator/);

    const authorized = await invokeApp(app, {
      method: 'GET',
      path: '/api/agent-context?layer=top',
      headers: authorization,
    });
    assert.equal(authorized.status, 200);
  } finally {
    await app.shutdown();
  }
});

test('agent context projection and runtime gates cannot drift from production routes', async () => {
  for (const goalActive of [false, true]) {
    for (const specialistAvailable of [false, true]) {
      const app = createApp(manifestAppOptions({
        goalFeatureActive: () => goalActive,
        ...(specialistAvailable ? {
          operatorSpecialistEnabled: true,
          specialistBackend: { runSpecialistTurn: async () => ({ text: 'ok' }) },
        } : {}),
      }));
      try {
        const mounts = productionRouterMounts(app);
        const mountedIds = mountedOperationIds(app);
        const goalGateResponse = await invokeApp(app, { method: 'GET', path: '/api/verify-checks' });
        const runtimeGoalActive = goalGateResponse.status === 200;
        const runtimeSpecialistAvailable = mounts.some(([mountPath]) => (
          mountPath === '/api/operator/specialist'
        ));

        assert.equal(runtimeGoalActive, goalActive, 'goal manifest gate must equal the mounted route gate');
        assert.equal(
          runtimeSpecialistAvailable,
          specialistAvailable,
          'specialist manifest gate must equal the production mount gate',
        );

        for (const layer of LAYERS) {
          const response = await invokeApp(app, {
            method: 'GET',
            path: `/api/agent-context?layer=${layer}`,
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
