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
const { createProjectService } = require('../services/projectService');
const { createConversationService } = require('../services/conversationService');
const {
  createManagerMessageQueueService,
} = require('../services/managerMessageQueueService');
const { createConversationsRouter } = require('../routes/conversations');

function createHarness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-manager-queue-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const {
    eventBus: providedEventBus,
    withRunService = false,
    ...queueOptions
  } = options;
  const eventBus = providedEventBus || createEventBus();
  const runService = withRunService ? createRunService(handle.db, eventBus) : null;
  const service = createManagerMessageQueueService({
    db: handle.db,
    eventBus,
    ...(runService ? { runService } : {}),
    tickMs: 100000,
    ...queueOptions,
  });
  t.after(() => {
    service.stop();
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, handle, db: handle.db, eventBus, runService, service,
  };
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

test('public queue rows preserve only the validated turn codebase context', async (t) => {
  const h = createHarness(t);
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: {
      kind: 'pm',
      runId: 'run_operator',
      memoryOwnerType: 'workspace',
      memoryOwnerId: 'proj_secondary',
    },
  }));

  const queued = await h.service.enqueue('operator:oi_one', {
    text: 'inspect the secondary codebase',
    codebaseProjectId: 'proj_secondary',
    turnMode: 'codebase',
  }, { idempotencyKey: 'turn-context' });

  assert.equal(queued.message.codebase_project_id, 'proj_secondary');
  assert.equal(queued.message.memory_owner_type, 'workspace');
  assert.equal(queued.message.memory_owner_id, 'proj_secondary');
  assert.equal(h.service.getMessage(queued.message.id).codebase_project_id, 'proj_secondary');
  assert.equal('payload_json' in queued.message, false);
});

test('queue ignores caller-supplied memory ownership and persists the dispatch-derived primary', async (t) => {
  const h = createHarness(t);
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: {
      kind: 'pm',
      runId: 'run_operator',
      memoryOwnerType: 'workspace',
      memoryOwnerId: 'proj_primary',
    },
  }));

  const queued = await h.service.enqueue('operator:oi_one', {
    text: 'inspect the primary codebase',
    _resolvedMemoryOwner: { type: 'workspace', id: 'proj_spoofed' },
  }, { idempotencyKey: 'resolved-primary-owner' });

  assert.equal(queued.message.codebase_project_id, 'proj_primary');
  assert.equal(queued.message.memory_owner_type, 'workspace');
  assert.equal(queued.message.memory_owner_id, 'proj_primary');
});

test('a terminal event racing dispatcher return still persists the dispatch-derived memory owner', async (t) => {
  const h = createHarness(t);
  h.service.setDispatcher((_conversationId, _payload, messageId) => {
    h.service.completeFromEvent(messageId, 'run_operator', true);
    return {
      status: 'sent',
      target: {
        kind: 'pm',
        runId: 'run_operator',
        memoryOwnerType: 'workspace',
        memoryOwnerId: 'proj_fast',
      },
    };
  });

  const queued = await h.service.enqueue('operator:oi_fast', {
    text: 'return immediately',
  }, { idempotencyKey: 'fast-terminal-owner' });

  assert.equal(queued.status, 'sent');
  assert.equal(queued.message.status, 'delivered');
  assert.equal(queued.message.codebase_project_id, 'proj_fast');
  assert.equal(queued.message.memory_owner_type, 'workspace');
  assert.equal(queued.message.memory_owner_id, 'proj_fast');
  assert.equal(h.service.getMessage(queued.message.id).memory_owner_id, 'proj_fast');
  assert.deepEqual(queued.target, {
    kind: 'pm',
    runId: 'run_operator',
    memoryOwnerType: 'workspace',
    memoryOwnerId: 'proj_fast',
  });
});

test('a persisted terminal event closes the current owner lane after its live callback is lost', async (t) => {
  const baseEventBus = createEventBus();
  let droppedCallbacks = 0;
  const eventBus = {
    ...baseEventBus,
    subscribe(callback) {
      return baseEventBus.subscribe((event) => {
        if (
          droppedCallbacks === 0
          && event?.channel === 'run:event'
          && event.data?.eventType === 'mgr.turn_completed'
        ) {
          droppedCallbacks += 1;
          throw new Error('simulated lost queue completion callback');
        }
        callback(event);
      });
    },
  };
  const h = createHarness(t, { eventBus, withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_lost_completion',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  const dispatched = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    dispatched.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: run.id } };
  });
  h.service.start();

  const first = await h.service.enqueue(
    'operator:oi_lost_completion',
    { text: 'first scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_lost_completion',
      adapterInvocationId: 'oinv_lost_completion',
      requireImmediate: true,
    },
  );
  assert.equal(first.message.status, 'processing');

  h.runService.addRunEvent(run.id, 'mgr.turn_completed', JSON.stringify({
    summaryText: 'turn completed',
    data: { terminal: true, invocationId: 'oinv_lost_completion' },
  }));
  assert.equal(droppedCallbacks, 1, 'the live completion callback must actually be lost');
  assert.equal(
    h.service.getMessage(first.message.id).status,
    'processing',
    'the live path must not have completed the row',
  );

  await h.service.tick();
  assert.equal(h.service.getMessage(first.message.id).status, 'delivered');

  const next = await h.service.enqueue(
    'operator:oi_lost_completion',
    { text: 'next scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_after_lost_completion',
      adapterInvocationId: 'oinv_after_lost_completion',
      requireImmediate: true,
    },
  );
  assert.equal(next.status, 'sent');
  assert.equal(next.message.status, 'processing');
  assert.deepEqual(dispatched, [
    'oinv_lost_completion',
    'oinv_after_lost_completion',
  ]);
});

test('same-invocation non-terminal failures cannot exhaust persisted terminal reconciliation', async (t) => {
  const h = createHarness(t, { withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_candidate_exhaustion',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  const dispatched = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    dispatched.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: run.id } };
  });
  h.service.start();

  const first = await h.service.enqueue(
    'operator:oi_candidate_exhaustion',
    { text: 'scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_target',
      adapterInvocationId: 'oinv_target',
      requireImmediate: true,
    },
  );
  assert.equal(first.message.status, 'processing');

  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(run.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: 'oinv_target', terminal: true },
  }));
  for (let index = 0; index < 255; index += 1) {
    insertEvent.run(run.id, 'mgr.turn_failed', JSON.stringify({
      data: {
        kind: 'codex_error',
        invocationId: 'oinv_target',
        terminal: false,
      },
    }));
  }

  assert.equal(h.service.reconcilePersistedTerminalEvents(), 1);
  assert.equal(h.service.getMessage(first.message.id).status, 'delivered');
  await h.service.awaitDrain();

  const next = await h.service.enqueue(
    'operator:oi_candidate_exhaustion',
    { text: 'next scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_after_exhaustion',
      adapterInvocationId: 'oinv_after_exhaustion',
      requireImmediate: true,
    },
  );
  assert.equal(next.status, 'sent');
  assert.deepEqual(dispatched, ['oinv_target', 'oinv_after_exhaustion']);
});

test('a persisted numeric terminal flag cannot close the current owner lane', async (t) => {
  const h = createHarness(t, { withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_numeric_terminal',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  const dispatched = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    dispatched.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: run.id } };
  });
  h.service.start();

  const first = await h.service.enqueue(
    'operator:oi_numeric_terminal',
    { text: 'first scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_first',
      adapterInvocationId: 'oinv_first',
      requireImmediate: true,
    },
  );
  assert.equal(first.message.status, 'processing');

  h.runService.addRunEvent(run.id, 'mgr.turn_failed', JSON.stringify({
    data: { invocationId: 'oinv_first', terminal: 1 },
  }));
  assert.equal(
    h.service.getMessage(first.message.id).status,
    'processing',
    'the live path must reject numeric 1 as a terminal flag',
  );

  await h.service.tick();
  assert.equal(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id).status, 'running');
  assert.equal(h.service.getMessage(first.message.id).status, 'processing');
  assert.equal(h.service.getMessage(first.message.id).terminal_reason, null);

  await assert.rejects(
    h.service.enqueue(
      'operator:oi_numeric_terminal',
      { text: 'second scheduled turn', source: 'scheduled' },
      {
        idempotencyKey: 'invocation:oinv_second',
        adapterInvocationId: 'oinv_second',
        requireImmediate: true,
      },
    ),
    err => err.code === 'OPERATOR_BUSY' && err.retryable === true,
  );
  assert.deepEqual(dispatched, ['oinv_first']);
});

test('persisted duplicate terminal keys cannot disagree with the live JSON parser', async (t) => {
  const h = createHarness(t, { withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_duplicate_terminal',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  const dispatched = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    dispatched.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: run.id } };
  });
  h.service.start();

  const first = await h.service.enqueue(
    'operator:oi_duplicate_terminal',
    { text: 'first scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_first',
      adapterInvocationId: 'oinv_first',
      requireImmediate: true,
    },
  );
  assert.equal(first.message.status, 'processing');

  h.runService.addRunEvent(
    run.id,
    'mgr.turn_failed',
    '{"data":{"invocationId":"oinv_first","terminal":true,"terminal":false}}',
  );
  assert.equal(
    h.service.getMessage(first.message.id).status,
    'processing',
    'the live path must use JSON.parse and keep the last terminal value',
  );

  await h.service.tick();
  assert.equal(h.db.prepare('SELECT status FROM runs WHERE id = ?').get(run.id).status, 'running');
  assert.equal(h.service.getMessage(first.message.id).status, 'processing');
  assert.equal(h.service.getMessage(first.message.id).terminal_reason, null);

  await assert.rejects(
    h.service.enqueue(
      'operator:oi_duplicate_terminal',
      { text: 'second scheduled turn', source: 'scheduled' },
      {
        idempotencyKey: 'invocation:oinv_second',
        adapterInvocationId: 'oinv_second',
        requireImmediate: true,
      },
    ),
    err => err.code === 'OPERATOR_BUSY' && err.retryable === true,
  );
  assert.deepEqual(dispatched, ['oinv_first']);
});

test('a malformed newer event cannot hide an earlier persisted terminal event', async (t) => {
  const h = createHarness(t, { withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_malformed_terminal',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  const dispatched = [];
  h.service.setDispatcher((_conversationId, _payload, invocationId) => {
    dispatched.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: run.id } };
  });
  h.service.start();

  const first = await h.service.enqueue(
    'operator:oi_malformed_terminal',
    { text: 'first scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_first',
      adapterInvocationId: 'oinv_first',
      requireImmediate: true,
    },
  );
  assert.equal(first.message.status, 'processing');

  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(run.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: 'oinv_first', terminal: true },
  }));
  insertEvent.run(run.id, 'mgr.turn_failed', '{broken');

  assert.equal(h.service.reconcilePersistedTerminalEvents(), 1);
  assert.equal(h.service.getMessage(first.message.id).status, 'delivered');
  await h.service.awaitDrain();

  const next = await h.service.enqueue(
    'operator:oi_malformed_terminal',
    { text: 'second scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_second',
      adapterInvocationId: 'oinv_second',
      requireImmediate: true,
    },
  );
  assert.equal(next.status, 'sent');
  assert.equal(next.message.status, 'processing');
  assert.deepEqual(dispatched, ['oinv_first', 'oinv_second']);
});

test('stale-claim reconciliation uses the same terminal candidate scan', async (t) => {
  const h = createHarness(t);
  const runService = createRunService(h.db, h.eventBus);
  const run = runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_stale_terminal',
    prompt: 'operator',
  });
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: { kind: 'pm', runId: run.id },
  }));
  const original = await h.service.enqueue(
    'operator:oi_stale_terminal',
    { text: 'scheduled turn', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_stale_terminal',
      adapterInvocationId: 'oinv_stale_terminal',
      requireImmediate: true,
    },
  );
  h.service.stop();

  const insertEvent = h.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, ?, ?)
  `);
  insertEvent.run(run.id, 'mgr.turn_completed', JSON.stringify({
    data: { invocationId: 'oinv_stale_terminal', terminal: true },
  }));
  insertEvent.run(run.id, 'mgr.turn_failed', '{broken');
  h.db.prepare('UPDATE manager_message_queue SET lease_expires_at = 0 WHERE id = ?')
    .run(original.message.id);

  const restarted = createManagerMessageQueueService({
    db: h.db,
    eventBus: h.eventBus,
    tickMs: 100000,
  });
  t.after(() => restarted.stop());

  assert.equal(restarted.reconcileStaleClaims(), 1);
  const recovered = restarted.getMessage(original.message.id);
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.terminal_reason, 'turn_completed');
});

test('the current owner reconciler ignores non-terminal failures and preserves chat replay', async (t) => {
  const h = createHarness(t, { withRunService: true });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'top',
    conversation_id: 'top',
    prompt: 'top',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: { kind: 'top', runId: run.id },
  }));
  h.service.start();

  const original = await h.service.enqueue(
    'top',
    { text: 'replay after restart' },
    { idempotencyKey: 'own-non-terminal-key' },
  );
  h.runService.addRunEvent(run.id, 'mgr.turn_failed', JSON.stringify({
    summaryText: 'transient codex error',
    data: {
      kind: 'codex_error',
      message: 'boom',
      terminal: false,
      invocationId: original.message.id,
    },
  }));

  await h.service.tick();
  assert.equal(h.service.getMessage(original.message.id).status, 'processing');
  assert.equal(h.service.getMessage(original.message.id).terminal_reason, null);

  h.service.stop();
  h.db.prepare('UPDATE manager_message_queue SET lease_expires_at = 0 WHERE id = ?')
    .run(original.message.id);
  const restarted = createManagerMessageQueueService({
    db: h.db,
    eventBus: h.eventBus,
    tickMs: 100000,
  });
  t.after(() => restarted.stop());
  const replayed = [];
  restarted.setDispatcher((_conversationId, payload) => {
    replayed.push(payload.text);
    return { status: 'sent', target: { kind: 'top', runId: run.id } };
  });

  assert.equal(restarted.reconcileStaleClaims(), 1);
  await restarted.drainConversation('top');
  assert.equal(restarted.getMessage(original.message.id).status, 'processing');
  assert.deepEqual(replayed, ['replay after restart']);
});

test('the current owner reconciler never terminalizes an old but live turn', async (t) => {
  const h = createHarness(t, { withRunService: true, leaseMs: 1000 });
  const run = h.runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_long_turn',
    prompt: 'operator',
  });
  h.runService.updateRunStatus(run.id, 'running', { force: true });
  h.service.setDispatcher(() => ({
    status: 'sent',
    target: { kind: 'pm', runId: run.id },
  }));
  h.service.start();

  const active = await h.service.enqueue(
    'operator:oi_long_turn',
    { text: 'still working' },
    { idempotencyKey: 'long-live-turn' },
  );
  h.db.prepare(`
    UPDATE manager_message_queue
       SET created_at = '2000-01-01 00:00:00',
           updated_at = '2000-01-01 00:00:00',
           lease_expires_at = 0
     WHERE id = ?
  `).run(active.message.id);

  await h.service.tick();
  const afterTick = h.db.prepare(
    'SELECT status, claimed_by, lease_expires_at FROM manager_message_queue WHERE id = ?',
  ).get(active.message.id);
  assert.equal(afterTick.status, 'processing');
  assert.equal(afterTick.claimed_by, h.service._ownerId);
  assert.ok(
    Number(afterTick.lease_expires_at) > Date.now(),
    'a live turn keeps its lease regardless of absolute age',
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

// Why the delivery deadline can stay scheduler-row-only: a dispatch that has
// not yet been accepted has run_id=NULL, and handleSlotCleared matches on an
// exact run_id. It therefore CANNOT terminalize an in-flight row, so a later
// scheduled delivery can never slip past single-flight (countActive would have
// to be 0) and inherit the still-held drain lock. If this ever changes, an
// unbounded await opens up and the scheduler tick can hang on it.
test('a slot clear cannot terminalize a dispatch that has not been accepted yet', async (t) => {
  const h = createHarness(t);
  let releaseColdSpawn;
  h.service.setDispatcher(async () => {
    await new Promise((resolve) => { releaseColdSpawn = resolve; });
    return { status: 'sent', target: { kind: 'pm', runId: 'run_operator' } };
  });
  const pending = h.service.enqueue('operator:oi_slot', { text: 'cold spawn' }, {
    idempotencyKey: 'slot-clear-key',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const inFlight = h.db
    .prepare('SELECT id, status, run_id FROM manager_message_queue')
    .get();
  assert.equal(inFlight.status, 'sending');
  assert.equal(inFlight.run_id, null, 'run_id is only stamped after adapter acceptance');

  assert.deepEqual(
    h.service.handleSlotCleared({ conversationId: 'operator:oi_slot', runId: 'run_operator' }),
    [],
    'a slot clear must not terminalize an unaccepted row',
  );
  assert.equal(h.service.getMessage(inFlight.id).status, 'sending');

  releaseColdSpawn();
  await pending;
});

test('a non-terminal turn failure must not consume an ordinary chat row at-least-once replay', async (t) => {
  const h = createHarness(t);
  const runService = createRunService(h.db, h.eventBus);
  const run = runService.createRun({
    is_manager: true, manager_layer: 'top', conversation_id: 'top', prompt: 'top',
  });
  h.service.setDispatcher(() => ({ status: 'sent', target: { kind: 'top', runId: run.id } }));
  const original = await h.service.enqueue(
    'top',
    { text: 'replay me' },
    { idempotencyKey: 'non-terminal-key' },
  );
  assert.equal(original.message.status, 'processing');
  h.service.stop();

  // codexAdapter's non-terminal failure, carrying this row's invocation id.
  // It is NOT a completion, so restart recovery must fall through to the
  // ordinary at-least-once replay rather than terminalizing the row.
  runService.addRunEvent(run.id, 'mgr.turn_failed', JSON.stringify({
    summaryText: 'transient codex error',
    data: {
      kind: 'codex_error', message: 'boom',
      terminal: false, invocationId: original.message.id,
    },
  }));
  h.db.prepare('UPDATE manager_message_queue SET lease_expires_at = 0 WHERE id = ?')
    .run(original.message.id);

  const restarted = createManagerMessageQueueService({
    db: h.db, eventBus: h.eventBus, tickMs: 100000,
  });
  t.after(() => restarted.stop());
  const replayed = [];
  restarted.setDispatcher((_conversationId, payload) => {
    replayed.push(payload.text);
    return { status: 'sent', target: { kind: 'top', runId: run.id } };
  });

  assert.equal(restarted.reconcileStaleClaims(), 1);
  await restarted.drainConversation('top');
  const recovered = restarted.getMessage(original.message.id);
  assert.equal(recovered.status, 'processing', 'must not be terminalized by a non-terminal event');
  assert.equal(recovered.terminal_reason, null);
  assert.deepEqual(replayed, ['replay me']);
});

test('expired scheduler delivery becomes uncertain after restart and is never replayed', async (t) => {
  const h = createHarness(t, { leaseMs: 5 });
  let firstDispatches = 0;
  h.service.setDispatcher(() => {
    firstDispatches += 1;
    return { status: 'sent', target: { kind: 'pm', runId: 'run_before_restart' } };
  });
  const original = await h.service.enqueue(
    'operator:oi_restart',
    { text: 'do not duplicate', source: 'scheduled' },
    {
      idempotencyKey: 'invocation:oinv_restart',
      adapterInvocationId: 'oinv_restart',
      requireImmediate: true,
    },
  );
  assert.equal(original.message.status, 'processing');
  assert.equal(firstDispatches, 1);
  h.service.stop();
  h.db.prepare('UPDATE manager_message_queue SET lease_expires_at = 0 WHERE id = ?')
    .run(original.message.id);

  const replayed = [];
  const restarted = createManagerMessageQueueService({
    db: h.db,
    eventBus: h.eventBus,
    tickMs: 100000,
  });
  t.after(() => restarted.stop());
  restarted.setDispatcher((_conversationId, payload) => {
    replayed.push(payload.text);
    return { status: 'sent', target: { kind: 'pm', runId: 'run_after_restart' } };
  });

  assert.equal(restarted.reconcileStaleClaims(), 1);
  await restarted.drainConversation('operator:oi_restart');
  const recovered = restarted.getMessage(original.message.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.terminal_reason, 'restart_delivery_uncertain');
  assert.deepEqual(replayed, []);
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

test('a hung immediate scheduler dispatch times out and releases its conversation lane', async (t) => {
  const h = createHarness(t, { immediateDispatchTimeoutMs: 20 });
  let releaseColdSpawn;
  const invocationIds = [];
  const adapterCalls = [];
  h.service.setDispatcher(async (_conversationId, _payload, invocationId, control) => {
    invocationIds.push(invocationId);
    if (invocationId === 'oinv_hung') {
      await new Promise((resolve) => { releaseColdSpawn = resolve; });
      if (!control.canDispatch()) {
        const err = new Error('delivery fenced before adapter');
        err.code = 'OPERATOR_DELIVERY_CANCELLED';
        err.retryable = false;
        throw err;
      }
    }
    adapterCalls.push(invocationId);
    return { status: 'sent', target: { kind: 'pm', runId: 'run_operator' } };
  });

  await assert.rejects(
    h.service.enqueue(
      'operator:oi_test',
      { text: 'hung scheduled turn' },
      {
        idempotencyKey: 'invocation:oinv_hung',
        adapterInvocationId: 'oinv_hung',
        requireImmediate: true,
      },
    ),
    err => err.code === 'OPERATOR_DELIVERY_TIMEOUT' && err.retryable === false,
  );
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS count FROM manager_message_queue').get().count,
    0,
    'timed-out immediate reservation must not keep the FIFO lane active',
  );

  const next = await h.service.enqueue(
    'operator:oi_test',
    { text: 'next scheduled turn' },
    {
      idempotencyKey: 'invocation:oinv_next',
      adapterInvocationId: 'oinv_next',
      requireImmediate: true,
    },
  );
  assert.equal(next.status, 'sent');
  assert.deepEqual(invocationIds, ['oinv_hung', 'oinv_next']);
  assert.deepEqual(adapterCalls, ['oinv_next']);

  releaseColdSpawn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(adapterCalls, ['oinv_next'], 'timed-out cold spawn must never enter the adapter');
  assert.equal(h.service.getMessage(next.message.id).status, 'processing');
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

// S1: the durable claim fence is what keeps a timed-out scheduled delivery out
// of the adapter (issue #458 "중복 실행 0"). Every other test drives it through
// a dispatcher fake that calls control.canDispatch() itself, which proves the
// queue exposes the fence but NOT that conversationService honours it. This
// wires the real conversationService dispatcher so the production check is what
// gets exercised.
//
// Note the two assertDispatchAllowed() calls in sendToManagerSlot are
// deliberately redundant: the entry one rejects an already-dead delivery before
// doing any work, the adapter-boundary one closes the async cold-spawn window.
// Deleting only the second therefore survives — that is defense in depth, not a
// gap. What this test pins is that the fence reaches the recursion at all.
test('the real dispatcher keeps a timed-out cold spawn out of the adapter', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-queue-fence-'));
  const handle = createDatabase(path.join(dir, 'test.db'));
  handle.migrate();
  const eventBus = createEventBus();
  const runService = createRunService(handle.db, eventBus);
  const projectService = createProjectService(handle.db);
  const managerRegistry = createManagerRegistry({ runService });
  const queue = createManagerMessageQueueService({
    db: handle.db, eventBus, runService, tickMs: 100000, immediateDispatchTimeoutMs: 25,
  });
  t.after(() => {
    queue.stop();
    try { handle.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = projectService.createProject({ name: 'Fence folder', directory: '/tmp' });

  const runTurnCalls = [];
  const adapter = {
    isSessionAlive: () => true,
    disposeSession: () => true,
    runTurn: (runId) => { runTurnCalls.push(runId); return { accepted: true }; },
  };
  let releaseColdSpawn;
  const conversationService = createConversationService({
    runService,
    managerRegistry,
    projectService,
    lifecycleService: {},
    managerAdapterFactory: { getAdapter: () => adapter },
    eventBus,
    managerMessageQueueService: queue,
    operatorSpawnService: {
      // A cold spawn that outruns the delivery deadline — materialize + clone
      // + CLI spawn routinely can.
      ensureLiveOperator: () => new Promise((resolve) => {
        releaseColdSpawn = () => {
          const run = runService.createRun({
            is_manager: true,
            manager_layer: 'operator',
            conversation_id: `operator:${project.id}`,
            prompt: 'operator',
          });
          runService.updateRunStatus(run.id, 'running', { force: true });
          managerRegistry.setActive(`operator:${project.id}`, run.id, adapter);
          resolve({ run });
        };
      }),
    },
  });

  await assert.rejects(
    conversationService.sendMessage(`operator:${project.id}`, {
      text: 'scheduled turn',
      invocationId: 'oinv_fence',
    }),
    err => err.code === 'OPERATOR_DELIVERY_TIMEOUT',
  );

  // The abandoned spawn finishes afterwards and the recursion resumes.
  releaseColdSpawn();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runTurnCalls, [], 'a timed-out delivery must never reach the adapter');
});
