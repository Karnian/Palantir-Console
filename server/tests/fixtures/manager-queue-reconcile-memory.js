'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../../db/database');
const {
  createManagerMessageQueueService,
} = require('../../services/managerMessageQueueService');

const ROW_COUNT = 90;
const PAYLOAD_BYTES = 1_843_232;
const dir = process.env.PALANTIR_QUEUE_MEMORY_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-queue-memory-'));
const handle = createDatabase(path.join(dir, 'test.db'));
let service;

try {
  handle.migrate();
  service = createManagerMessageQueueService({
    db: handle.db,
    tickMs: 100_000,
  });
  const payloadJson = `{"text":"${'x'.repeat(PAYLOAD_BYTES - 11)}"}`;
  if (Buffer.byteLength(payloadJson) !== PAYLOAD_BYTES) {
    throw new Error(`unexpected payload size: ${Buffer.byteLength(payloadJson)}`);
  }
  JSON.parse(payloadJson);

  const insert = handle.db.prepare(`
    INSERT INTO manager_message_queue (
      id, conversation_id, idempotency_key, adapter_invocation_id,
      payload_json, display_text, status, available_at,
      claimed_by, lease_expires_at, run_id
    ) VALUES (?, ?, ?, ?, ?, 'large payload', 'processing', 0, ?, ?, ?)
  `);
  handle.db.transaction(() => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
      insert.run(
        `msg_memory_${index}`,
        `operator:oi_memory_${index}`,
        `invocation:oinv_memory_${index}`,
        `oinv_memory_${index}`,
        payloadJson,
        service._ownerId,
        Date.now() + 60_000,
        `run_memory_${index}`,
      );
    }
  })();

  const reconciled = service.reconcilePersistedTerminalEvents();
  const rows = handle.db.prepare(`
    SELECT COUNT(*) AS count
    FROM manager_message_queue
    WHERE claimed_by = ? AND status = 'processing'
  `).get(service._ownerId).count;
  console.log(`reconciled=${reconciled} rows=${rows} payload_bytes=${PAYLOAD_BYTES}`);
} finally {
  if (service) service.stop();
  try { handle.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
}
