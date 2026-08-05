'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const request = require('supertest');

const { createActionsRouter } = require('../routes/actions');
const { errorHandler } = require('../middleware/errorHandler');

const SECRET = 'route-secret-token-123456';
const RAW_ACTIONS = [
  {
    id: 'action-old',
    task_id: 'task-1',
    action_slot: 'issue-old',
    connector: 'github',
    operation: 'github.create_issue',
    status: 'succeeded',
    created_at: '2026-08-05T00:00:00.000Z',
    approved_at: '2026-08-05T00:01:00.000Z',
    approved_by: 'operator-1',
    approval_auth_method: 'cookie',
    approval_expires_at: '2026-08-05T01:00:00.000Z',
    external_id: '42',
    external_node_id: 'NODE_42',
    verdict: 'full_get_valid',
    repair_attempts: 0,
    next_reconcile_at: null,
    next_repair_at: null,
    reissues_action_id: null,
    params_json: JSON.stringify({
      repo: 'acme/widgets',
      title: 'Ship observability',
      body: 'private body with ' + SECRET,
      labels: ['P1', 'ops'],
    }),
    last_error: 'must never leak ' + SECRET,
    receipt_json: JSON.stringify({ token: SECRET }),
  },
  {
    id: 'action-new',
    task_id: 'task-2',
    action_slot: 'issue-new',
    connector: 'github',
    operation: 'github.create_issue',
    status: 'awaiting_approval',
    created_at: '2026-08-05T00:02:00.000Z',
    approved_at: null,
    approved_by: null,
    approval_auth_method: null,
    approval_expires_at: null,
    external_id: null,
    external_node_id: null,
    verdict: null,
    repair_attempts: 0,
    next_reconcile_at: null,
    next_repair_at: null,
    reissues_action_id: null,
    params_json: JSON.stringify({
      repo: 'acme/console',
      title: 'Review action',
      body: 'private body',
      labels: [],
    }),
  },
];

const EVENTS = {
  'action-old': [
    {
      id: 1,
      action_id: 'action-old',
      phase: 'execution.result',
      attempt_id: 'attempt-1',
      transport_class: 'response',
      request_digest: 'a'.repeat(64),
      external_request_id: 'request-1',
      candidate_external_id: 'NODE_42',
      ts: '2026-08-05T00:01:30.000Z',
      receipt_json: JSON.stringify({
        ok: true,
        html_url: 'https://github.example/acme/widgets/issues/42',
        authorization: 'Bearer ' + SECRET,
        nested: { secret: SECRET },
      }),
      error: 'token=' + SECRET,
    },
  ],
};

function createTestSurface() {
  const ledger = {
    listActions: () => RAW_ACTIONS,
    getAction: (id) => RAW_ACTIONS.find((action) => action.id === id) || null,
    listEvents: (id) => EVENTS[id] || [],
  };
  const router = createActionsRouter({ ledger });
  const app = express();
  app.use('/api/actions', router);
  app.use(errorHandler);
  return { app, router };
}

function injectRouter(router, method, requestPath) {
  const url = new URL(requestPath, 'http://actions.test');
  const relativePath = url.pathname.slice('/api/actions'.length) || '/';
  const layer = router.stack.find((candidate) => {
    if (!candidate.route?.methods?.[method]) return false;
    if (candidate.route.path === '/') return relativePath === '/';
    return candidate.route.path === '/:id' && /^\/[^/]+$/.test(relativePath);
  });
  if (!layer) return Promise.resolve({ status: 404, body: {} });

  const req = {
    query: Object.fromEntries(url.searchParams),
    params: layer.route.path === '/:id'
      ? { id: decodeURIComponent(relativePath.slice(1)) }
      : {},
  };
  return new Promise((resolve, reject) => {
    let finished = false;
    const settle = (response) => {
      if (finished) return;
      finished = true;
      resolve(response);
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        settle({ status: this.statusCode, body });
        return this;
      },
    };
    const next = (error) => {
      if (error) {
        settle({ status: error.status || 500, body: { error: error.message } });
      } else {
        settle({ status: 404, body: {} });
      }
    };
    try {
      layer.route.stack[0].handle(req, res, next);
    } catch (error) {
      reject(error);
    }
  });
}

async function createTestClient(t) {
  const { app, router } = createTestSurface();
  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    return (method, requestPath) => injectRouter(router, method, requestPath);
  }

  t.after(() => new Promise((resolve) => server.close(resolve)));
  return async (method, requestPath, body) => {
    const pending = request(server)[method](requestPath);
    return body === undefined ? pending : pending.send(body);
  };
}

test('GET /api/actions projects newest-first actions and filters by validated status', async (t) => {
  const client = await createTestClient(t);
  const all = await client('get', '/api/actions');

  assert.equal(all.status, 200);
  assert.deepEqual(all.body.actions.map((action) => action.id), ['action-new', 'action-old']);
  assert.deepEqual(all.body.actions[1].params_summary, {
    repo: 'acme/widgets',
    title: 'Ship observability',
    label_count: 2,
  });
  assert.equal(all.body.actions[1].approved_by, 'operator-1');
  assert.equal(all.body.actions[1].external_node_id, 'NODE_42');
  assert.equal(all.body.actions[1].repair_attempts, 0);
  assert.equal('params_json' in all.body.actions[1], false);
  assert.equal('last_error' in all.body.actions[1], false);
  assert.equal('receipt_json' in all.body.actions[1], false);

  const filtered = await client('get', '/api/actions?status=awaiting_approval');
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.actions.map((action) => action.id), ['action-new']);

  const invalid = await client('get', '/api/actions?status=not-a-status');
  assert.equal(invalid.status, 400);
});

test('GET /api/actions/:id returns projected evidence and redacts every raw secret', async (t) => {
  const client = await createTestClient(t);
  const response = await client('get', '/api/actions/action-old');

  assert.equal(response.status, 200);
  assert.equal(response.body.action.id, 'action-old');
  assert.equal(response.body.events.length, 1);
  assert.equal(response.body.events[0].phase, 'execution.result');
  assert.equal(response.body.events[0].receipt.ok, true);
  assert.equal(response.body.events[0].receipt.authorization, '[redacted]');
  assert.equal(response.body.events[0].receipt.nested.secret, '[redacted]');
  assert.match(response.body.events[0].error, /\[redacted\]/);
  assert.equal(JSON.stringify(response.body).includes(SECRET), false);
  assert.equal(JSON.stringify(response.body).includes('private body'), false);

  const missing = await client('get', '/api/actions/missing');
  assert.equal(missing.status, 404);
});

test('actions router exposes no mutating verb', async (t) => {
  const client = await createTestClient(t);
  assert.equal((await client('post', '/api/actions', {})).status, 404);
  assert.equal((await client('patch', '/api/actions/action-old', {})).status, 404);
  assert.equal((await client('delete', '/api/actions/action-old')).status, 404);
});
