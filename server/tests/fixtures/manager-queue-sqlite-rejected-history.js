'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createDatabase } = require('../../db/database');
const { createEventBus } = require('../../services/eventBus');
const { createRunService } = require('../../services/runService');
const {
  createManagerMessageQueueService,
} = require('../../services/managerMessageQueueService');
const {
  MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
} = require('../../services/terminalEventReconciliation');

const HISTORY_COUNT = 12;
const NESTING_DEPTH = 1_000_000;
const EXPECTED_HISTORY_PAYLOAD_BYTES = 2_000_069;
const MAX_RECONCILIATION_MS = 500;
const MAX_HEAP_DELTA_BYTES = 32 * 1024 * 1024;
const dir = process.env.PALANTIR_QUEUE_REJECTED_HISTORY_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-queue-rejected-history-'));
const handle = createDatabase(path.join(dir, 'test.db'));
let service;
let originalParse;

try {
  handle.migrate();
  const eventBus = createEventBus();
  const runService = createRunService(handle.db, eventBus);
  service = createManagerMessageQueueService({
    db: handle.db,
    eventBus,
    runService,
    tickMs: 100_000,
  });
  const run = runService.createRun({
    is_manager: true,
    manager_layer: 'operator',
    conversation_id: 'operator:oi_rejected_history',
    prompt: 'operator',
  });
  runService.updateRunStatus(run.id, 'running', { force: true });
  handle.db.prepare(`
    INSERT INTO manager_message_queue (
      id, conversation_id, idempotency_key, adapter_invocation_id,
      payload_json, display_text, status, available_at,
      claimed_by, lease_expires_at, run_id
    ) VALUES (
      'msg_rejected_history', 'operator:oi_rejected_history',
      'invocation:oinv_target', 'oinv_target',
      '{}', 'target', 'processing', 0, ?, ?, ?
    )
  `).run(service._ownerId, Date.now() + 60_000, run.id);

  const insertEvent = handle.db.prepare(`
    INSERT INTO run_events (run_id, event_type, payload_json)
    VALUES (?, 'mgr.turn_completed', ?)
  `);
  const opening = '['.repeat(NESTING_DEPTH);
  const closing = ']'.repeat(NESTING_DEPTH);
  handle.db.transaction(() => {
    for (let index = 0; index < HISTORY_COUNT; index += 1) {
      const invocationId = `oinv_history_${String(index).padStart(2, '0')}`;
      const payload = `{"extra":${opening}0${closing},`
        + `"data":{"invocationId":"${invocationId}","terminal":true}}`;
      if (Buffer.byteLength(payload) !== EXPECTED_HISTORY_PAYLOAD_BYTES) {
        throw new Error(`unexpected history payload size: ${Buffer.byteLength(payload)}`);
      }
      insertEvent.run(run.id, payload);
    }
  })();
  const rejected = handle.db.prepare(`
    SELECT COUNT(*) AS count
    FROM run_events
    WHERE run_id = ? AND json_valid(payload_json) = 0
  `).get(run.id).count;
  if (rejected !== HISTORY_COUNT) {
    throw new Error(`expected ${HISTORY_COUNT} SQLite-rejected rows, received ${rejected}`);
  }

  originalParse = JSON.parse;
  let historicalPayloadParses = 0;
  let boundedPayloadParses = 0;
  let peakHeapBytes = process.memoryUsage().heapUsed;
  JSON.parse = function countedParse(value, ...args) {
    const parsed = originalParse.call(this, value, ...args);
    if (typeof value === 'string' && value.includes('"invocationId":"oinv_history_')) {
      historicalPayloadParses += 1;
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    }
    if (typeof value === 'string' && value.includes('"fallbackBoundMarker":true')) {
      boundedPayloadParses += 1;
    }
    return parsed;
  };
  const initialHeapBytes = process.memoryUsage().heapUsed;
  peakHeapBytes = Math.max(peakHeapBytes, initialHeapBytes);
  const startedAt = performance.now();
  const reconciledWithoutTarget = service.reconcilePersistedTerminalEvents();
  const elapsedMs = performance.now() - startedAt;
  console.log(
    `history=${HISTORY_COUNT} payload_bytes=${EXPECTED_HISTORY_PAYLOAD_BYTES} `
      + `parsed=${historicalPayloadParses} reconciled=${reconciledWithoutTarget} `
      + `elapsed_ms=${elapsedMs.toFixed(1)} `
      + `heap_before_mb=${(initialHeapBytes / 1024 / 1024).toFixed(1)} `
      + `heap_peak_mb=${(peakHeapBytes / 1024 / 1024).toFixed(1)} `
      + `heap_delta_mb=${((peakHeapBytes - initialHeapBytes) / 1024 / 1024).toFixed(1)}`,
  );
  if (reconciledWithoutTarget !== 0) {
    throw new Error(`unexpected reconciliation count: ${reconciledWithoutTarget}`);
  }
  if (historicalPayloadParses !== 0) {
    throw new Error(`parsed ${historicalPayloadParses} unrelated rejected payloads`);
  }
  if (elapsedMs > MAX_RECONCILIATION_MS) {
    throw new Error(`reconciliation took ${elapsedMs.toFixed(1)} ms`);
  }
  if (peakHeapBytes - initialHeapBytes > MAX_HEAP_DELTA_BYTES) {
    throw new Error(
      `reconciliation heap grew by `
        + `${((peakHeapBytes - initialHeapBytes) / 1024 / 1024).toFixed(1)} MB`,
    );
  }
  if (service.getMessage('msg_rejected_history').status !== 'processing') {
    throw new Error('unrelated rejected history settled the target row');
  }

  handle.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(run.id);
  const boundedOpening = '['.repeat(1000);
  const boundedClosing = ']'.repeat(1000);
  for (let index = 0; index < HISTORY_COUNT; index += 1) {
    insertEvent.run(
      run.id,
      `{"extra":${boundedOpening}0${boundedClosing},`
        + '"correlationHint":"oinv_target","fallbackBoundMarker":true,'
        + `"data":{"invocationId":"oinv_bounded_${index}","terminal":true}}`,
    );
  }
  const boundedReconciled = service.reconcilePersistedTerminalEvents();
  console.log(
    `bounded_history=${HISTORY_COUNT} bounded_parsed=${boundedPayloadParses} `
      + `bounded_reconciled=${boundedReconciled}`,
  );
  if (boundedPayloadParses !== MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES) {
    throw new Error(
      `parsed ${boundedPayloadParses} bounded candidates; `
        + `limit is ${MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES}`,
    );
  }
  if (boundedReconciled !== 0) {
    throw new Error(`unexpected bounded reconciliation count: ${boundedReconciled}`);
  }

  handle.db.prepare('DELETE FROM run_events WHERE run_id = ?').run(run.id);
  const targetPayload = `{"extra":${opening}0${closing},`
    + '"data":{"invocationId":"oinv_target","terminal":true}}';
  if (handle.db.prepare('SELECT json_valid(?) AS valid').get(targetPayload).valid !== 0) {
    throw new Error('target payload must exercise the SQLite-rejected fallback');
  }
  insertEvent.run(run.id, targetPayload);
  const reconciledTarget = service.reconcilePersistedTerminalEvents();
  const status = service.getMessage('msg_rejected_history').status;
  if (reconciledTarget !== 1 || status !== 'delivered') {
    throw new Error(`deep target did not settle: reconciled=${reconciledTarget} status=${status}`);
  }

  console.log(`target_reconciled=${reconciledTarget} status=${status}`);
} finally {
  if (originalParse) JSON.parse = originalParse;
  if (service) service.stop();
  try { handle.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
