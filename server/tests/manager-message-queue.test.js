'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');
const {
  createManagerMessageQueueService,
} = require('../services/managerMessageQueueService');
const { createConversationsRouter } = require('../routes/conversations');

function createHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-manager-queue-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const eventBus = createEventBus();
  const service = createManagerMessageQueueService({
    db: handle.db,
    eventBus,
    tickMs: 100000,
    ...options,
  });
  t.after(() => {
    service.stop();
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, handle, db: handle.db, eventBus, service };
}

test('durable queue preserves per-conversation FIFO and single-flight under concurrent sends', async (t) => {
  const h = createHarness(t);
  const dispatched = [];
  h.service.setDispatcher((conversationId, payload, messageId) => {
    dispatched.push({ conversationId, text: payload.text, messageId });
    return { status: 'sent', target: { kind: 'top', runId: 'run_top' } };
  });

  const first = await h.service.enqueue('top', { text: 'first' }, { idempotencyKey: 'key-1' });
  const [second, third] = await Promise.all([
    h.service.enqueue('top', { text: 'second' }, { idempotencyKey: 'key-2' }),
    h.service.enqueue('top', { text: 'third' }, { idempotencyKey: 'key-3' }),
  ]);

  assert.equal(first.status, 'sent');
  assert.equal(first.message.status, 'processing');
  assert.equal(second.message.status, 'queued');
  assert.equal(third.message.status, 'queued');
  assert.deepEqual(dispatched.map(item => item.text), ['first']);

  h.service.completeFromEvent(first.message.id, 'run_top', true);
  await h.service.awaitDrain();
  assert.deepEqual(dispatched.map(item => item.text), ['first', 'second']);
  assert.equal(h.service.getMessage(second.message.id).status, 'processing');
  assert.equal(h.service.getMessage(third.message.id).status, 'queued');

  h.service.completeFromEvent(second.message.id, 'run_top', true);
  await h.service.awaitDrain();
  assert.deepEqual(dispatched.map(item => item.text), ['first', 'second', 'third']);
  assert.equal(h.service.getMessage(third.message.id).status, 'processing');
});

test('idempotency key prevents duplicate insertion and duplicate dispatch', async (t) => {
  const h = createHarness(t);
  let calls = 0;
  h.service.setDispatcher(() => {
    calls += 1;
    return { status: 'sent', target: { kind: 'top', runId: 'run_top' } };
  });

  const first = await h.service.enqueue('top', { text: 'same' }, { idempotencyKey: 'stable-key' });
  const duplicate = await h.service.enqueue('top', { text: 'same' }, { idempotencyKey: 'stable-key' });

  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.message.id, first.message.id);
  assert.equal(calls, 1);
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS count FROM manager_message_queue').get().count,
    1,
  );
});

test('queue cap applies backpressure and queued-only cancellation is CAS-safe', async (t) => {
  const h = createHarness(t, { perConversationCap: 2 });
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: { kind: 'top', runId: 'run_top' },
  }));

  const first = await h.service.enqueue('top', { text: 'processing' }, { idempotencyKey: 'cap-1' });
  const second = await h.service.enqueue('top', { text: 'queued' }, { idempotencyKey: 'cap-2' });
  await assert.rejects(
    h.service.enqueue('top', { text: 'overflow' }, { idempotencyKey: 'cap-3' }),
    err => err.httpStatus === 429 && err.code === 'MANAGER_QUEUE_FULL',
  );

  const cancelled = h.service.cancel('top', second.message.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.throws(
    () => h.service.cancel('top', first.message.id),
    err => err.httpStatus === 409 && err.code === 'MANAGER_MESSAGE_NOT_CANCELLABLE',
  );
});

test('expired processing claim is recovered after restart and replayed at least once', async (t) => {
  const h = createHarness(t, { leaseMs: 10 });
  const firstDispatch = [];
  h.service.setDispatcher((_conversationId, payload) => {
    firstDispatch.push(payload.text);
    return { status: 'sent', target: { kind: 'top', runId: 'run_before_restart' } };
  });
  const original = await h.service.enqueue(
    'top',
    { text: 'survive restart' },
    { idempotencyKey: 'restart-key' },
  );
  assert.equal(original.message.status, 'processing');
  h.service.stop();
  h.db.prepare(
    'UPDATE manager_message_queue SET lease_expires_at = 0 WHERE id = ?',
  ).run(original.message.id);

  const restarted = createManagerMessageQueueService({
    db: h.db,
    eventBus: h.eventBus,
    tickMs: 100000,
  });
  t.after(() => restarted.stop());
  const replayed = [];
  restarted.setDispatcher((_conversationId, payload) => {
    replayed.push(payload.text);
    return { status: 'sent', target: { kind: 'top', runId: 'run_after_restart' } };
  });

  assert.equal(restarted.reconcileStaleClaims(), 1);
  await restarted.drainConversation('top');
  const recovered = restarted.getMessage(original.message.id);
  assert.equal(recovered.status, 'processing');
  assert.equal(recovered.run_id, 'run_after_restart');
  assert.equal(recovered.attempt_count, 2);
  assert.deepEqual(firstDispatch, ['survive restart']);
  assert.deepEqual(replayed, ['survive restart']);
});

test('terminal turn failure is visible and is not automatically replayed', async (t) => {
  const h = createHarness(t);
  let calls = 0;
  h.service.setDispatcher(() => {
    calls += 1;
    return { status: 'sent', target: { kind: 'top', runId: 'run_top' } };
  });
  const queued = await h.service.enqueue('top', { text: 'fail once' }, { idempotencyKey: 'fail-key' });

  h.service.completeFromEvent(queued.message.id, 'run_top', false, 'model rejected the turn');
  await h.service.tick();
  const failed = h.service.getMessage(queued.message.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.last_error, 'model rejected the turn');
  assert.equal(calls, 1);
});

test('an explicitly permanent 409 fails instead of blocking FIFO forever', async (t) => {
  const h = createHarness(t);
  h.service.setDispatcher(() => {
    const err = new Error('operator is disabled');
    err.httpStatus = 409;
    err.code = 'OPERATOR_DISABLED';
    err.retryable = false;
    throw err;
  });

  const result = await h.service.enqueue(
    'operator:oi_disabled',
    { text: 'will fail' },
    { idempotencyKey: 'disabled-key' },
  );
  assert.equal(result.message.status, 'failed');
  assert.equal(result.message.terminal_reason, 'OPERATOR_DISABLED');
});

test('a delayed FIFO head blocks later queued rows from overtaking it', async (t) => {
  const h = createHarness(t);
  const dispatched = [];
  let firstAttempt = true;
  h.service.setDispatcher((_conversationId, payload) => {
    dispatched.push(payload.text);
    if (firstAttempt) {
      firstAttempt = false;
      const err = new Error('temporary transport failure');
      err.retryable = true;
      throw err;
    }
    return { status: 'sent', target: { kind: 'top', runId: 'run_top' } };
  });

  const first = await h.service.enqueue(
    'top',
    { text: 'first' },
    { idempotencyKey: 'delayed-first' },
  );
  const second = await h.service.enqueue(
    'top',
    { text: 'second' },
    { idempotencyKey: 'must-wait' },
  );

  assert.equal(first.message.status, 'queued');
  assert.equal(second.message.status, 'queued');
  assert.deepEqual(dispatched, ['first']);
  await h.service.tick();
  assert.deepEqual(dispatched, ['first']);

  h.db.prepare(
    'UPDATE manager_message_queue SET available_at = 0 WHERE id = ?',
  ).run(first.message.id);
  await h.service.tick();
  assert.deepEqual(dispatched, ['first', 'first']);
  assert.equal(h.service.getMessage(first.message.id).status, 'processing');
  assert.equal(h.service.getMessage(second.message.id).status, 'queued');
});

test('scheduled invocation shares the same lane and cannot bypass a chat turn', async (t) => {
  const h = createHarness(t);
  const invocationIds = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    invocationIds.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: 'run_operator' } };
  });
  const chat = await h.service.enqueue(
    'operator:oi_test',
    { text: 'chat turn' },
    { idempotencyKey: 'chat-key' },
  );

  await assert.rejects(
    h.service.enqueue(
      'operator:oi_test',
      { text: 'scheduled turn', source: 'scheduled' },
      {
        idempotencyKey: 'invocation:oinv_test',
        adapterInvocationId: 'oinv_test',
        requireImmediate: true,
      },
    ),
    err => err.code === 'OPERATOR_BUSY' && err.retryable === true,
  );
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS count FROM manager_message_queue').get().count,
    1,
  );

  h.service.completeFromEvent(chat.message.id, 'run_operator', true);
  await h.service.awaitDrain();
  const scheduled = await h.service.enqueue(
    'operator:oi_test',
    { text: 'scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_test',
      adapterInvocationId: 'oinv_test',
      requireImmediate: true,
    },
  );
  assert.equal(scheduled.status, 'sent');
  assert.equal(scheduled.message.client_message_id, 'oinv_test');
  assert.equal(invocationIds.at(-1), 'oinv_test');
  h.service.completeFromEvent('oinv_test', 'run_operator', true);
  assert.equal(h.service.getMessage(scheduled.message.id).status, 'delivered');
});

test('a rejected immediate scheduler reservation can retry the same invocation id', async (t) => {
  const h = createHarness(t);
  let busy = true;
  h.service.setDispatcher(() => {
    if (busy) {
      const err = new Error('adapter is still busy');
      err.code = 'OPERATOR_BUSY';
      err.retryable = true;
      throw err;
    }
    return { status: 'sent', target: { kind: 'pm', runId: 'run_operator' } };
  });
  const options = {
    idempotencyKey: 'invocation:oinv_retry',
    adapterInvocationId: 'oinv_retry',
    requireImmediate: true,
  };

  await assert.rejects(
    h.service.enqueue('operator:oi_test', { text: 'scheduled turn' }, options),
    err => err.code === 'OPERATOR_BUSY',
  );
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS count FROM manager_message_queue').get().count,
    0,
  );

  busy = false;
  const retried = await h.service.enqueue(
    'operator:oi_test',
    { text: 'scheduled turn' },
    options,
  );
  assert.equal(retried.status, 'sent');
  assert.equal(retried.message.client_message_id, 'oinv_retry');
});

test('conversation queue API forwards idempotency, lists messages, and cancels queued rows', async () => {
  const calls = [];
  const conversationService = {
    resolveConversation: () => ({ kind: 'top', conversationId: 'top', run: null }),
    parseConversationId: () => ({ kind: 'top' }),
    getEvents: () => [],
    async sendMessage(id, payload) {
      calls.push({ kind: 'send', id, payload });
      return { status: 'queued', message: { id: 'msg-1', status: 'queued' } };
    },
    listManagerMessages(id, options) {
      calls.push({ kind: 'list', id, options });
      return [{ id: 'msg-1', status: 'queued' }];
    },
    cancelManagerMessage(id, messageId) {
      calls.push({ kind: 'cancel', id, messageId });
      return { id: messageId, status: 'cancelled' };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/conversations', createConversationsRouter({ conversationService }));

  const sent = await request(app)
    .post('/api/conversations/top/message')
    .set('Idempotency-Key', 'api-key')
    .send({ text: 'hello' })
    .expect(200);
  assert.equal(sent.body.message.status, 'queued');
  assert.equal(calls[0].payload.idempotencyKey, 'api-key');

  const listed = await request(app)
    .get('/api/conversations/top/messages?limit=25')
    .expect(200);
  assert.equal(listed.body.messages[0].id, 'msg-1');
  assert.equal(calls[1].options.limit, '25');

  const cancelled = await request(app)
    .delete('/api/conversations/top/messages/msg-1')
    .expect(200);
  assert.equal(cancelled.body.message.status, 'cancelled');
  assert.equal(calls[2].messageId, 'msg-1');
});

test('real API keeps a busy Top turn single-flight and auto-dispatches the FIFO successor', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-manager-queue-api-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const eventBus = createEventBus();
  const runService = createRunService(handle.db, eventBus);
  const managerRegistry = createManagerRegistry({ runService });
  const queue = createManagerMessageQueueService({
    db: handle.db,
    eventBus,
    runService,
    tickMs: 100000,
  });
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    lifecycleService: {},
    managerAdapterFactory: { getAdapter: () => null },
    eventBus,
    managerMessageQueueService: queue,
  });
  queue.start();
  const app = express();
  app.use(express.json());
  app.use('/api/conversations', createConversationsRouter({ conversationService, runService }));
  t.after(async () => {
    queue.stop();
    await queue.awaitDrain();
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = runService.createRun({
    is_manager: true,
    manager_layer: 'top',
    conversation_id: 'top',
    manager_adapter: 'codex',
    prompt: 'queue integration',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });
  const calls = [];
  const adapter = {
    runTurn(runId, payload) {
      calls.push({ runId, payload });
      return { accepted: true };
    },
    isSessionAlive: () => true,
    detectExitCode: () => null,
    disposeSession: () => true,
  };
  managerRegistry.setActive('top', run.id, adapter);

  const first = await request(app)
    .post('/api/conversations/top/message')
    .set('Idempotency-Key', 'api-first')
    .send({ text: 'first turn' })
    .expect(200);
  const second = await request(app)
    .post('/api/conversations/top/message')
    .set('Idempotency-Key', 'api-second')
    .send({ text: 'second turn' })
    .expect(200);

  assert.equal(first.body.status, 'sent');
  assert.equal(first.body.message.status, 'processing');
  assert.equal(second.body.status, 'queued');
  assert.equal(calls.length, 1);

  runService.addRunEvent(run.id, 'mgr.turn_completed', JSON.stringify({
    summaryText: 'turn completed',
    data: { terminal: true, invocationId: first.body.message.id },
  }));
  await queue.awaitDrain();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.displayText, 'second turn');

  const listed = await request(app)
    .get('/api/conversations/top/messages')
    .expect(200);
  const statuses = new Map(listed.body.messages.map(item => [item.idempotency_key, item.status]));
  assert.equal(statuses.get('api-first'), 'delivered');
  assert.equal(statuses.get('api-second'), 'processing');
});
