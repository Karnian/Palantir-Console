'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createEventBus } = require('../services/eventBus');
const { createWebhookService } = require('../services/webhookService');
const { createApp } = require('../app');

const FIXED_NOW = '2026-06-14T00:00:00.000Z';

function silentLogger(warnings = []) {
  return {
    warn(message) {
      warnings.push(message);
    },
  };
}

function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        if (predicate()) return resolve();
        if (Date.now() >= deadline) {
          assert.ok(predicate(), 'condition was not met before timeout');
          return resolve();
        }
      } catch (err) {
        return reject(err);
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function workerRun(overrides = {}) {
  return {
    id: 'run_1',
    task_id: 'task_1',
    project_id: 'project_1',
    node_id: 'node_1',
    status: 'running',
    is_manager: 0,
    agent_profile_id: 'agent_profile_1',
    agent_name: 'Codex Worker',
    prompt: 'must-not-leak',
    result: 'must-not-leak',
    output: 'must-not-leak',
    ...overrides,
  };
}

function needsInputData(overrides = {}) {
  const run = overrides.run || workerRun({ status: 'needs_input' });
  return {
    runId: run.id,
    run,
    from_status: 'running',
    to_status: 'needs_input',
    reason: 'idle_timeout',
    task_id: run.task_id,
    project_id: run.project_id,
    priority: 'alert',
    ...overrides,
  };
}

function endedData(status, overrides = {}) {
  const run = overrides.run || workerRun({ status });
  return {
    run,
    from_status: 'running',
    to_status: status,
    reason: status === 'failed' ? 'stream-json-exit-error(1)' : 'agent-exit-success',
    task_id: run.task_id,
    project_id: run.project_id,
    ...overrides,
  };
}

function parseBody(call) {
  return JSON.parse(call.body);
}

function createHarness({
  webhookUrl = 'http://127.0.0.1:3100/webhook?team=core',
  allowPrivate = false,
  postImpl,
  now = () => FIXED_NOW,
} = {}) {
  const eventBus = createEventBus();
  const posts = [];
  const runEvents = [];
  const warnings = [];
  const runService = {
    addRunEvent(runId, eventType, payloadJson) {
      runEvents.push({
        runId,
        eventType,
        payload: payloadJson ? JSON.parse(payloadJson) : null,
      });
    },
  };
  const service = createWebhookService({
    eventBus,
    runService,
    webhookUrl,
    allowPrivate,
    postImpl: postImpl || (async (args) => {
      posts.push(args);
      return { ok: true, status: 204 };
    }),
    now,
    logger: silentLogger(warnings),
  });
  return { eventBus, service, posts, runEvents, warnings };
}

test('webhook: run:needs_input posts whitelisted payload', async () => {
  const h = createHarness();

  h.eventBus.emit('run:needs_input', needsInputData());
  await waitFor(() => h.posts.length === 1);

  const call = h.posts[0];
  const payload = parseBody(call);
  assert.deepEqual(Object.keys(payload).sort(), [
    'agent',
    'event',
    'node_id',
    'project_id',
    'reason',
    'run_id',
    'server_ts',
    'status',
    'task_id',
  ]);
  assert.deepEqual(payload, {
    event: 'needs_input',
    run_id: 'run_1',
    task_id: 'task_1',
    project_id: 'project_1',
    node_id: 'node_1',
    status: 'needs_input',
    reason: 'idle_timeout',
    agent: 'Codex Worker',
    server_ts: FIXED_NOW,
  });
  assert.equal(payload.prompt, undefined);
  assert.equal(payload.result, undefined);
  assert.equal(payload.output, undefined);
  assert.equal(call.urlStr, 'http://127.0.0.1:3100/webhook?team=core');
  assert.equal(call.hostname, '127.0.0.1');
  assert.equal(call.ip, '127.0.0.1');
  assert.equal(call.family, 4);
  assert.equal(call.headers.Host, '127.0.0.1');
  assert.equal(call.headers['Content-Type'], 'application/json');
  assert.equal(call.headers['Content-Length'], Buffer.byteLength(call.body));
  assert.equal(h.runEvents[0].eventType, 'webhook:sent');
  assert.deepEqual(h.runEvents[0].payload, { event: 'needs_input', status: 204 });
});

test('webhook: run:ended failed posts', async () => {
  const h = createHarness();

  h.eventBus.emit('run:ended', endedData('failed'));
  await waitFor(() => h.posts.length === 1);

  const payload = parseBody(h.posts[0]);
  assert.equal(payload.event, 'failed');
  assert.equal(payload.status, 'failed');
  assert.equal(payload.reason, 'stream-json-exit-error(1)');
});

test('webhook: event node_id overrides run node_id', async () => {
  const h = createHarness();

  h.eventBus.emit('run:needs_input', needsInputData({
    node_id: 'node_from_event',
    run: workerRun({ status: 'needs_input', node_id: 'node_from_run' }),
  }));
  await waitFor(() => h.posts.length === 1);

  const payload = parseBody(h.posts[0]);
  assert.equal(payload.node_id, 'node_from_event');
});

test('webhook: run:ended completed/cancelled/stopped are skipped', async () => {
  const h = createHarness();

  h.eventBus.emit('run:ended', endedData('completed'));
  h.eventBus.emit('run:ended', endedData('cancelled'));
  h.eventBus.emit('run:ended', endedData('stopped'));
  await flush();

  assert.equal(h.posts.length, 0);
  assert.equal(h.runEvents.length, 0);
});

test('webhook: run:completed failed is ignored but run:ended failed posts', async () => {
  const h = createHarness();

  h.eventBus.emit('run:completed', endedData('failed', { reason: 'tmux-only-path' }));
  await flush();
  assert.equal(h.posts.length, 0);

  h.eventBus.emit('run:ended', endedData('failed', { reason: 'stream-json-failed' }));
  await waitFor(() => h.posts.length === 1);
  assert.equal(parseBody(h.posts[0]).reason, 'stream-json-failed');
});

test('webhook: agent and reason are stringified and capped', async () => {
  const h = createHarness();
  const longReason = { toString: () => 'r'.repeat(250) };
  const longAgent = 'a'.repeat(250);

  h.eventBus.emit('run:needs_input', needsInputData({
    reason: longReason,
    run: workerRun({ status: 'needs_input', agent_name: '', agent_profile_id: longAgent }),
  }));
  await waitFor(() => h.posts.length === 1);

  const payload = parseBody(h.posts[0]);
  assert.equal(payload.reason.length, 200);
  assert.equal(payload.agent.length, 200);
  assert.equal(payload.reason, 'r'.repeat(200));
  assert.equal(payload.agent, 'a'.repeat(200));
});

test('webhook: missing URL is no-op with zero subscriptions', () => {
  const subscribers = [];
  const eventBus = {
    subscribe(callback) {
      subscribers.push(callback);
      return () => {};
    },
  };

  const service = createWebhookService({
    eventBus,
    runService: { addRunEvent() { throw new Error('should not be called'); } },
    webhookUrl: '',
    postImpl: () => { throw new Error('should not be called'); },
    now: () => FIXED_NOW,
    logger: silentLogger(),
  });

  assert.equal(subscribers.length, 0);
  assert.doesNotThrow(() => service.stop());
});

test('webhook: postImpl sync throw and async reject never escape eventBus emit', async (t) => {
  const cases = [
    ['sync throw', () => { throw new Error('sync boom'); }],
    ['async reject', async () => { throw new Error('async boom'); }],
  ];

  for (const [name, postImpl] of cases) {
    await t.test(name, async () => {
      const h = createHarness({ postImpl });
      let laterSubscriberCalled = false;
      h.eventBus.subscribe((event) => {
        if (event.channel === 'run:needs_input') laterSubscriberCalled = true;
      });

      assert.doesNotThrow(() => h.eventBus.emit('run:needs_input', needsInputData()));
      assert.equal(laterSubscriberCalled, true);
      await waitFor(() => h.runEvents.some((e) => e.eventType === 'webhook:error'));

      const errorEvent = h.runEvents.find((e) => e.eventType === 'webhook:error');
      assert.equal(errorEvent.runId, 'run_1');
      assert.equal(errorEvent.payload.event, 'needs_input');
      assert.equal(errorEvent.payload.reason, 'network_error');
    });
  }
});

test('webhook: manager runs are skipped', async () => {
  const h = createHarness();

  h.eventBus.emit('run:needs_input', needsInputData({
    run: workerRun({ is_manager: 1, status: 'needs_input' }),
  }));
  h.eventBus.emit('run:ended', endedData('failed', {
    run: workerRun({ is_manager: 1, status: 'failed' }),
  }));
  await flush();

  assert.equal(h.posts.length, 0);
  assert.equal(h.runEvents.length, 0);
});

test('webhook: stop unsubscribes', async () => {
  const h = createHarness();

  h.service.stop();
  h.eventBus.emit('run:needs_input', needsInputData());
  await flush();

  assert.equal(h.posts.length, 0);
});

test('webhook: SSRF-blocked URL records webhook:error and does not call postImpl', async () => {
  const h = createHarness({
    webhookUrl: 'http://10.0.0.1/webhook',
    postImpl: async (args) => {
      h.posts.push(args);
      return { ok: true, status: 200 };
    },
  });

  h.eventBus.emit('run:needs_input', needsInputData());
  await waitFor(() => h.runEvents.some((e) => e.eventType === 'webhook:error'));

  assert.equal(h.posts.length, 0);
  const errorEvent = h.runEvents.find((e) => e.eventType === 'webhook:error');
  assert.equal(errorEvent.payload.reason, 'ssrf_blocked');
});

test('webhook: allowPrivate permits private URL while preserving pinned IP', async () => {
  const h = createHarness({
    webhookUrl: 'http://10.2.3.4:9444/webhook',
    allowPrivate: true,
  });

  h.eventBus.emit('run:needs_input', needsInputData());
  await waitFor(() => h.posts.length === 1);

  assert.equal(h.posts[0].ip, '10.2.3.4');
  assert.equal(h.posts[0].family, 4);
  assert.equal(h.posts[0].hostname, '10.2.3.4');
  assert.equal(h.posts[0].port, '9444');
});

async function mkTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('webhook: createApp uses options.webhookUrl before env and shutdown stops subscription', async (t) => {
  const prevWebhookUrl = process.env.PALANTIR_WEBHOOK_URL;
  process.env.PALANTIR_WEBHOOK_URL = 'http://10.0.0.1/env-webhook';

  const storageRoot = await mkTempDir('palantir-webhook-storage-');
  const fsRoot = await mkTempDir('palantir-webhook-fs-');
  const dbDir = await mkTempDir('palantir-webhook-db-');
  const pluginsRoot = await mkTempDir('palantir-webhook-plugins-');
  const dbPath = path.join(dbDir, 'test.db');
  const posts = [];
  let closed = false;
  const app = createApp({
    storageRoot,
    fsRoot,
    dbPath,
    pluginsRoot,
    authToken: null,
    authResolverOpts: { hasKeychain: () => false },
    webhookUrl: 'http://127.0.0.1:4321/option-webhook',
    webhookPostImpl: async (args) => {
      posts.push(args);
      return { ok: true, status: 202 };
    },
    webhookNow: () => FIXED_NOW,
    webhookLogger: silentLogger(),
  });

  t.after(async () => {
    if (!closed) app.shutdown();
    if (prevWebhookUrl === undefined) delete process.env.PALANTIR_WEBHOOK_URL;
    else process.env.PALANTIR_WEBHOOK_URL = prevWebhookUrl;
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(dbDir, { recursive: true, force: true });
    await fs.rm(pluginsRoot, { recursive: true, force: true });
  });

  app.services.eventBus.emit('run:needs_input', needsInputData());
  await waitFor(() => posts.length === 1);
  assert.equal(posts[0].urlStr, 'http://127.0.0.1:4321/option-webhook');

  app.shutdown();
  closed = true;
  app.services.eventBus.emit('run:needs_input', needsInputData({ run: workerRun({ id: 'run_after_shutdown' }) }));
  await flush();
  assert.equal(posts.length, 1);
});

test('eventBus emit isolates a throwing subscriber so later subscribers still fire', () => {
  // webhook reliability depends on this: a webhook subscriber registered
  // AFTER a misbehaving one (e.g. PM auto-review) must still receive events.
  const bus = createEventBus();
  const seen = [];
  bus.subscribe(() => { throw new Error('boom from an earlier subscriber'); });
  bus.subscribe((event) => { seen.push(event.channel); });

  assert.doesNotThrow(() => bus.emit('run:ended', { to_status: 'failed' }));
  assert.deepEqual(seen, ['run:ended'], 'later subscriber fires despite earlier throw');
});
