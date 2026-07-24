'use strict';

const { randomUUID } = require('node:crypto');

const DEFAULT_PER_CONVERSATION_CAP = 50;
const DEFAULT_TICK_MS = 1000;
const DEFAULT_LEASE_MS = 30000;
const MAX_PAYLOAD_BYTES = 12 * 1024 * 1024;
const MAX_TERMINAL_RETRIES = 3;
const ACTIVE_STATUSES = Object.freeze(['queued', 'sending', 'processing']);

function createHttpError(message, httpStatus, code, retryable = false) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  err.retryable = retryable;
  return err;
}

function createManagerMessageQueueService({
  db,
  eventBus,
  runService,
  perConversationCap = DEFAULT_PER_CONVERSATION_CAP,
  tickMs = DEFAULT_TICK_MS,
  leaseMs = DEFAULT_LEASE_MS,
  logger,
} = {}) {
  if (!db) throw new Error('managerMessageQueueService: db is required');

  const ownerId = randomUUID();
  const log = logger || ((message) => console.warn(`[manager-message-queue] ${message}`));
  const drains = new Map();
  let dispatcher = null;
  let timer = null;
  let unsubscribe = null;
  let started = false;
  let stopped = false;

  const stmts = {
    getById: db.prepare('SELECT * FROM manager_message_queue WHERE id = ?'),
    getByKey: db.prepare(
      'SELECT * FROM manager_message_queue WHERE conversation_id = ? AND idempotency_key = ?',
    ),
    getByAdapterInvocation: db.prepare(
      'SELECT * FROM manager_message_queue WHERE adapter_invocation_id = ?',
    ),
    countActive: db.prepare(`
      SELECT COUNT(*) AS count
      FROM manager_message_queue
      WHERE conversation_id = ?
        AND status IN ('queued', 'sending', 'processing')
    `),
    insert: db.prepare(`
      INSERT INTO manager_message_queue (
        id, conversation_id, idempotency_key, adapter_invocation_id,
        payload_json, display_text, attachment_count, status, available_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `),
    activeForConversation: db.prepare(`
      SELECT 1
      FROM manager_message_queue
      WHERE conversation_id = ?
        AND status IN ('sending', 'processing')
      LIMIT 1
    `),
    nextQueued: db.prepare(`
      SELECT *
      FROM manager_message_queue
      WHERE conversation_id = ?
        AND status = 'queued'
      ORDER BY sequence ASC
      LIMIT 1
    `),
    claim: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'sending',
          attempt_count = attempt_count + 1,
          claim_token = ?,
          claimed_by = ?,
          lease_expires_at = ?,
          updated_at = datetime('now'),
          last_error = NULL
      WHERE id = ? AND status = 'queued'
    `),
    markProcessing: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'processing',
          run_id = ?,
          manager_adapter = ?,
          lease_expires_at = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'sending' AND claim_token = ? AND claimed_by = ?
    `),
    release: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'queued',
          available_at = ?,
          claim_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          run_id = NULL,
          manager_adapter = NULL,
          last_error = ?,
          updated_at = datetime('now')
      WHERE id = ? AND status = 'sending' AND claim_token = ? AND claimed_by = ?
    `),
    failClaim: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'failed',
          last_error = ?,
          terminal_reason = ?,
          claim_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          failed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
        AND status IN ('sending', 'processing')
        AND (? IS NULL OR claim_token = ?)
    `),
    complete: db.prepare(`
      UPDATE manager_message_queue
      SET status = ?,
          last_error = ?,
          terminal_reason = ?,
          claim_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END,
          failed_at = CASE WHEN ? = 'failed' THEN datetime('now') ELSE failed_at END,
          updated_at = datetime('now')
      WHERE id = ?
        AND status IN ('sending', 'processing')
        AND (? IS NULL OR run_id = ? OR (status = 'sending' AND run_id IS NULL))
    `),
    cancel: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'cancelled',
          terminal_reason = 'cancelled_by_user',
          cancelled_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ? AND conversation_id = ? AND status = 'queued'
    `),
    discardUnacceptedImmediate: db.prepare(`
      DELETE FROM manager_message_queue
      WHERE id = ? AND status IN ('queued', 'failed', 'cancelled')
    `),
    list: db.prepare(`
      SELECT *
      FROM manager_message_queue
      WHERE conversation_id = ?
      ORDER BY sequence DESC
      LIMIT ?
    `),
    runnableConversations: db.prepare(`
      SELECT q.conversation_id
      FROM manager_message_queue q
      WHERE q.status = 'queued'
        AND q.available_at <= ?
        AND q.sequence = (
          SELECT MIN(head.sequence)
          FROM manager_message_queue head
          WHERE head.conversation_id = q.conversation_id
            AND head.status = 'queued'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM manager_message_queue active
          WHERE active.conversation_id = q.conversation_id
            AND active.status IN ('sending', 'processing')
        )
      ORDER BY q.conversation_id
    `),
    staleClaims: db.prepare(`
      SELECT *
      FROM manager_message_queue
      WHERE status IN ('sending', 'processing')
        AND claimed_by <> ?
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      ORDER BY sequence
    `),
    recoverClaim: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'queued',
          available_at = ?,
          claim_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          run_id = NULL,
          manager_adapter = NULL,
          last_error = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND status IN ('sending', 'processing')
        AND claimed_by = ?
        AND lease_expires_at <= ?
    `),
    renewOwnLeases: db.prepare(`
      UPDATE manager_message_queue
      SET lease_expires_at = ?, updated_at = datetime('now')
      WHERE claimed_by = ? AND status IN ('sending', 'processing')
    `),
    terminalEvent: db.prepare(`
      SELECT event_type, payload_json
      FROM run_events
      WHERE run_id = ?
        AND event_type IN ('mgr.turn_completed', 'mgr.turn_failed')
        AND json_extract(payload_json, '$.data.invocationId') = ?
      ORDER BY id DESC
      LIMIT 1
    `),
    failRunActive: db.prepare(`
      UPDATE manager_message_queue
      SET status = 'failed',
          last_error = ?,
          terminal_reason = ?,
          claim_token = NULL,
          claimed_by = NULL,
          lease_expires_at = NULL,
          failed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE conversation_id = ?
        AND run_id = ?
        AND status IN ('sending', 'processing')
    `),
    activeForRun: db.prepare(`
      SELECT *
      FROM manager_message_queue
      WHERE conversation_id = ? AND run_id = ?
        AND status IN ('sending', 'processing')
      ORDER BY sequence
    `),
  };

  const enqueueTx = db.transaction((
    conversationId,
    payloadJson,
    displayText,
    attachmentCount,
    key,
    adapterInvocationId,
    requireImmediate,
    now,
  ) => {
    const existing = stmts.getByKey.get(conversationId, key);
    if (existing) return { row: existing, deduplicated: true };
    const count = Number(stmts.countActive.get(conversationId)?.count || 0);
    if (requireImmediate && count > 0) {
      throw createHttpError(
        `manager is busy with another turn for ${conversationId}`,
        409,
        'OPERATOR_BUSY',
        true,
      );
    }
    if (count >= perConversationCap) {
      throw createHttpError(
        `message queue is full for ${conversationId} (cap=${perConversationCap})`,
        429,
        'MANAGER_QUEUE_FULL',
        true,
      );
    }
    const id = randomUUID();
    const effectiveInvocationId = adapterInvocationId || id;
    stmts.insert.run(
      id,
      conversationId,
      key,
      effectiveInvocationId,
      payloadJson,
      displayText,
      attachmentCount,
      now,
    );
    return { row: stmts.getById.get(id), deduplicated: false };
  });

  const claimTx = db.transaction((conversationId, now) => {
    if (stmts.activeForConversation.get(conversationId)) return null;
    // Head-of-line blocking is intentional: a transiently delayed first row
    // must not let a later row overtake it and violate conversation FIFO.
    const row = stmts.nextQueued.get(conversationId);
    if (!row) return null;
    if (Number(row.available_at) > now) return null;
    const claimToken = randomUUID();
    const result = stmts.claim.run(
      claimToken,
      ownerId,
      now + leaseMs,
      row.id,
    );
    if (result.changes !== 1) return null;
    return stmts.getById.get(row.id);
  });

  function publicRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      idempotency_key: row.idempotency_key,
      client_message_id: row.adapter_invocation_id,
      sequence: row.sequence,
      display_text: row.display_text,
      attachment_count: row.attachment_count,
      status: row.status,
      attempt_count: row.attempt_count,
      run_id: row.run_id,
      manager_adapter: row.manager_adapter,
      last_error: row.last_error,
      terminal_reason: row.terminal_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      delivered_at: row.delivered_at,
      failed_at: row.failed_at,
      cancelled_at: row.cancelled_at,
    };
  }

  function emitRow(row) {
    if (!row || !eventBus) return;
    try {
      eventBus.emit('conversation:message_status', {
        conversationId: row.conversation_id,
        message: publicRow(row),
      });
    } catch { /* state persistence is authoritative */ }
  }

  function getMessage(id) {
    return publicRow(stmts.getById.get(id));
  }

  function listMessages(conversationId, { limit = 100 } = {}) {
    const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
    return stmts.list.all(conversationId, bounded).reverse().map(publicRow);
  }

  function setDispatcher(fn) {
    if (typeof fn !== 'function') throw new Error('manager message dispatcher must be a function');
    dispatcher = fn;
  }

  function retryPolicy(err, row) {
    const code = err?.code || null;
    const status = Number(err?.httpStatus || err?.status || 0);
    // Explicit permanent classification wins over generic HTTP status. For
    // example, a disabled/deleted Operator is a 404/409 but retrying it forever
    // would strand the FIFO lane instead of surfacing a terminal reason.
    if (err?.retryable === false) return { retry: false };
    if (
      code === 'OPERATOR_BUSY'
      || code === 'OPERATOR_MISSING'
      || status === 404
      || status === 409
    ) {
      return { retry: true, delayMs: code === 'OPERATOR_BUSY' ? 1000 : 5000, unlimited: true };
    }
    if (err?.retryable === true && Number(row.attempt_count) < MAX_TERMINAL_RETRIES) {
      return {
        retry: true,
        delayMs: Math.min(1000 * (2 ** Math.max(0, Number(row.attempt_count) - 1)), 10000),
        unlimited: false,
      };
    }
    return { retry: false };
  }

  async function drainConversation(conversationId) {
    if (stopped) return null;
    if (!dispatcher) return null;
    if (drains.has(conversationId)) return drains.get(conversationId);

    const work = (async () => {
      const claimed = claimTx(conversationId, Date.now());
      if (!claimed) return null;
      emitRow(claimed);

      let payload;
      try {
        payload = JSON.parse(claimed.payload_json);
      } catch (err) {
        stmts.failClaim.run(
          `invalid persisted payload: ${err.message}`,
          'invalid_payload',
          claimed.id,
          claimed.claim_token,
          claimed.claim_token,
        );
        const failed = stmts.getById.get(claimed.id);
        emitRow(failed);
        return { id: claimed.id, row: failed };
      }

      try {
        const result = await dispatcher(
          claimed.conversation_id,
          payload,
          claimed.adapter_invocation_id,
        );
        const runId = result?.target?.runId || null;
        if (!runId) {
          throw createHttpError(
            'manager accepted a queued message without a run id',
            502,
            'OPERATOR_DELIVERY_REJECTED',
            false,
          );
        }
        let managerAdapter = null;
        try {
          managerAdapter = runService?.getRun(runId)?.manager_adapter || null;
        } catch { /* snapshot is diagnostic only */ }
        stmts.markProcessing.run(
          runId,
          managerAdapter,
          Date.now() + leaseMs,
          claimed.id,
          claimed.claim_token,
          ownerId,
        );
        const processing = stmts.getById.get(claimed.id);
        emitRow(processing);
        return { id: claimed.id, row: processing, result };
      } catch (err) {
        const latest = stmts.getById.get(claimed.id);
        if (!latest || !['sending', 'processing'].includes(latest.status)) {
          return { id: claimed.id, row: latest };
        }
        const policy = retryPolicy(err, latest);
        if (policy.retry) {
          stmts.release.run(
            Date.now() + policy.delayMs,
            err?.message || 'manager temporarily unavailable',
            claimed.id,
            claimed.claim_token,
            ownerId,
          );
        } else {
          stmts.failClaim.run(
            err?.message || 'manager delivery failed',
            err?.code || 'delivery_failed',
            claimed.id,
            claimed.claim_token,
            claimed.claim_token,
          );
        }
        const updated = stmts.getById.get(claimed.id);
        emitRow(updated);
        return { id: claimed.id, row: updated, error: err };
      }
    })().finally(() => {
      drains.delete(conversationId);
    });

    drains.set(conversationId, work);
    return work;
  }

  async function enqueue(conversationId, payload, {
    idempotencyKey,
    adapterInvocationId,
    requireImmediate = false,
  } = {}) {
    const key = typeof idempotencyKey === 'string' && idempotencyKey.trim()
      ? idempotencyKey.trim()
      : randomUUID();
    if (key.length > 200) {
      throw createHttpError('idempotency key is too long', 400, 'INVALID_IDEMPOTENCY_KEY');
    }
    let payloadJson;
    try {
      payloadJson = JSON.stringify(payload || {});
    } catch {
      throw createHttpError('message payload must be JSON serializable', 400, 'INVALID_MESSAGE_PAYLOAD');
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw createHttpError(
        `message payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
        413,
        'MANAGER_MESSAGE_TOO_LARGE',
      );
    }
    const displayText = typeof payload?.text === 'string' ? payload.text.slice(0, 5000) : '';
    const attachmentCount = Array.isArray(payload?.images) ? payload.images.length : 0;
    const inserted = enqueueTx(
      conversationId,
      payloadJson,
      displayText,
      attachmentCount,
      key,
      adapterInvocationId || null,
      requireImmediate === true,
      Date.now(),
    );
    if (!inserted.deduplicated) emitRow(inserted.row);

    const dispatch = await drainConversation(conversationId);
    const row = stmts.getById.get(inserted.row.id);
    const immediate = ['processing', 'delivered'].includes(row?.status)
      && (
        dispatch?.id === inserted.row.id
        || (requireImmediate && inserted.deduplicated)
      );
    if (requireImmediate && !immediate) {
      // Scheduled turns already have a durable owner in operator_invocations.
      // If the adapter did not accept this turn, remove our temporary lane
      // reservation so the scheduler can retry the SAME invocation id later.
      // Retaining a cancelled/failed row would permanently deduplicate retries.
      if (row && !inserted.deduplicated) {
        stmts.discardUnacceptedImmediate.run(row.id);
      }
      if (dispatch?.error) throw dispatch.error;
      throw createHttpError(
        `manager is busy with another turn for ${conversationId}`,
        409,
        'OPERATOR_BUSY',
        true,
      );
    }
    return {
      status: immediate ? 'sent' : (row?.status || 'queued'),
      deliveryStatus: row?.status || 'queued',
      deduplicated: inserted.deduplicated,
      message: publicRow(row),
      ...(immediate
        ? {
            target: dispatch?.result?.target || {
              kind: conversationId === 'top' ? 'top' : 'pm',
              runId: row.run_id,
            },
          }
        : {}),
    };
  }

  function cancel(conversationId, id) {
    const existing = stmts.getById.get(id);
    if (!existing || existing.conversation_id !== conversationId) {
      throw createHttpError('queued message not found', 404, 'MANAGER_MESSAGE_NOT_FOUND');
    }
    if (existing.status !== 'queued') {
      throw createHttpError(
        `only queued messages can be cancelled (current=${existing.status})`,
        409,
        'MANAGER_MESSAGE_NOT_CANCELLABLE',
      );
    }
    const result = stmts.cancel.run(id, conversationId);
    if (result.changes !== 1) {
      throw createHttpError('queued message state changed before cancellation', 409, 'MANAGER_MESSAGE_NOT_CANCELLABLE');
    }
    const row = stmts.getById.get(id);
    emitRow(row);
    return publicRow(row);
  }

  function completeFromEvent(invocationId, runId, success, errorMessage = null) {
    const existing = stmts.getById.get(invocationId)
      || stmts.getByAdapterInvocation.get(invocationId);
    if (!existing) return null;
    const id = existing.id;
    const status = success ? 'delivered' : 'failed';
    const reason = success ? 'turn_completed' : 'turn_failed';
    const result = stmts.complete.run(
      status,
      errorMessage,
      reason,
      status,
      status,
      id,
      runId,
      runId,
    );
    if (result.changes !== 1) return null;
    const row = stmts.getById.get(id);
    emitRow(row);
    // A very fast adapter can emit the terminal event while the accepting
    // drain is still unwinding. Wait until that promise leaves the map before
    // claiming the FIFO successor.
    const activeDrain = drains.get(row.conversation_id);
    if (activeDrain) {
      void activeDrain.then(
        () => drainConversation(row.conversation_id),
        () => drainConversation(row.conversation_id),
      );
    } else {
      void drainConversation(row.conversation_id);
    }
    return publicRow(row);
  }

  function parseTerminalEvent(runId, eventType, eventId) {
    if (eventType !== 'mgr.turn_completed' && eventType !== 'mgr.turn_failed') return null;
    const event = runService && typeof runService.getRunEventById === 'function'
      ? runService.getRunEventById(runId, eventId)
      : null;
    if (!event || event.event_type !== eventType) return null;
    let payload;
    try { payload = event.payload_json ? JSON.parse(event.payload_json) : null; } catch { return null; }
    const id = payload?.data?.invocationId;
    if (!id || payload?.data?.terminal !== true) return null;
    return completeFromEvent(
      id,
      runId,
      eventType === 'mgr.turn_completed',
      eventType === 'mgr.turn_failed' ? (payload?.summaryText || 'manager turn failed') : null,
    );
  }

  function onEvent(event) {
    if (event?.channel !== 'run:event') return;
    try {
      parseTerminalEvent(event.data?.runId, event.data?.eventType, event.data?.eventId);
    } catch (err) {
      log(`terminal event correlation failed: ${err.message}`);
    }
  }

  function reconcileStaleClaims() {
    const now = Date.now();
    const stale = stmts.staleClaims.all(ownerId, now);
    for (const row of stale) {
      let terminal = null;
      if (row.run_id) {
        try {
          terminal = stmts.terminalEvent.get(row.run_id, row.adapter_invocation_id);
        } catch {
          terminal = null;
        }
      }
      if (terminal) {
        let payload;
        try { payload = JSON.parse(terminal.payload_json || '{}'); } catch { payload = {}; }
        completeFromEvent(
          row.adapter_invocation_id,
          row.run_id,
          terminal.event_type === 'mgr.turn_completed',
          terminal.event_type === 'mgr.turn_failed'
            ? (payload?.summaryText || 'manager turn failed')
            : null,
        );
        continue;
      }
      const recovered = stmts.recoverClaim.run(
        now,
        'recovered after server/claim owner restart; delivery may be retried',
        row.id,
        row.claimed_by,
        now,
      );
      if (recovered.changes === 1) emitRow(stmts.getById.get(row.id));
    }
    return stale.length;
  }

  function handleSlotCleared({ conversationId, runId } = {}) {
    if (!conversationId || !runId) return [];
    const active = stmts.activeForRun.all(conversationId, runId);
    if (active.length === 0) return [];
    stmts.failRunActive.run(
      'manager session ended before the turn completed',
      'session_ended_during_processing',
      conversationId,
      runId,
    );
    const failed = active
      .map(row => stmts.getById.get(row.id))
      .filter(Boolean);
    failed.forEach(emitRow);
    void drainConversation(conversationId);
    return failed.map(publicRow);
  }

  async function tick() {
    if (stopped) return [];
    stmts.renewOwnLeases.run(Date.now() + leaseMs, ownerId);
    reconcileStaleClaims();
    const conversations = stmts.runnableConversations.all(Date.now());
    return Promise.all(conversations.map(row => drainConversation(row.conversation_id)));
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    reconcileStaleClaims();
    if (eventBus && typeof eventBus.subscribe === 'function') unsubscribe = eventBus.subscribe(onEvent);
    timer = setInterval(() => {
      Promise.resolve(tick()).catch(err => log(`tick failed: ${err.message}`));
    }, Math.max(250, Number(tickMs) || DEFAULT_TICK_MS));
    if (typeof timer.unref === 'function') timer.unref();
    void tick();
  }

  function stop() {
    if (stopped && !started) return;
    stopped = true;
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  function awaitDrain() {
    return Promise.allSettled(Array.from(drains.values()));
  }

  return {
    setDispatcher,
    enqueue,
    getMessage,
    listMessages,
    cancel,
    drainConversation,
    completeFromEvent,
    handleSlotCleared,
    reconcileStaleClaims,
    tick,
    start,
    stop,
    awaitDrain,
    _ownerId: ownerId,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  DEFAULT_PER_CONVERSATION_CAP,
  MAX_PAYLOAD_BYTES,
  MAX_TERMINAL_RETRIES,
  createManagerMessageQueueService,
};
