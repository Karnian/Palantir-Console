// P5-6: conversationService unit tests
//
// Targets the internal mechanics of conversationService:
//   - sendMessage routing (top / pm / worker)
//   - parent-notice queue (queueParentNotice / peek-then-drain)
//   - commitDrainParentNotices race-safety (splice, not delete)
//   - resolveParentSlot (worker→Top, worker→PM branches)
//   - onSlotCleared scrub via managerRegistry
//
// All dependencies are stubs — no real processes are started.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createConversationService } = require('../services/conversationService');

// ---------------------------------------------------------------------------
// DB helper
// ---------------------------------------------------------------------------

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-cu-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeFakeAdapter({ rejectTurn = false } = {}) {
  const calls = [];
  return {
    calls,
    isSessionAlive: () => true,
    detectExitCode: () => null,
    emitSessionEndedIfNeeded: () => {},
    runTurn(runId, payload) {
      if (rejectTurn) return { accepted: false };
      calls.push({ runId, payload });
      return { accepted: true };
    },
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
    disposeSession: () => {},
  };
}

function makeFakeLifecycle({ deliverOk = true } = {}) {
  const delivered = [];
  return {
    delivered,
    sendAgentInput(runId, text) {
      delivered.push({ runId, text });
      return deliverOk;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared setup for a Top run + registry
// ---------------------------------------------------------------------------

function seedTopRun(rs, registry, adapter) {
  const run = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive('top', run.id, adapter);
  return run;
}

function seedWorkerRun(db, rs, { parentRunId = null } = {}) {
  db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES ('p-w','WProj')`).run();
  db.prepare(`INSERT OR IGNORE INTO tasks (id, project_id, title, status) VALUES ('t-w','p-w','T','backlog')`).run();
  db.prepare(`INSERT OR IGNORE INTO agent_profiles (id, name, type, command) VALUES ('a-w','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: 't-w', agent_profile_id: 'a-w', prompt: 'work' });
  if (parentRunId) {
    db.prepare(`UPDATE runs SET parent_run_id = ? WHERE id = ?`).run(parentRunId, run.id);
  }
  rs.updateRunStatus(run.id, 'running', { force: true });
  return rs.getRun(run.id);
}

// ---------------------------------------------------------------------------
// sendMessage: routing
// ---------------------------------------------------------------------------

test('conv: sendMessage to top dispatches runTurn on top adapter', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: null,
  });

  seedTopRun(rs, registry, adapter);
  const result = conv.sendMessage('top', { text: 'hello top' });

  assert.equal(result.status, 'sent');
  assert.equal(result.target.kind, 'top');
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].payload.text, 'hello top');
});

test('conv: sendMessage to invalid conversation id throws 400', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  let caught;
  try { conv.sendMessage('!!!bad!!!', { text: 'hi' }); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw');
  assert.equal(caught.httpStatus, 400);
});

test('conv: sendMessage with empty text throws 400', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  let caught;
  try { conv.sendMessage('top', { text: '' }); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw');
  assert.equal(caught.httpStatus, 400);
});

test('conv: sendMessage to top throws 404 when no active top run', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  let caught;
  try { conv.sendMessage('top', { text: 'hello' }); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw');
  assert.equal(caught.httpStatus, 404);
});

test('conv: sendMessage to worker delivers via lifecycleService', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const lc = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: lc,
  });

  const worker = seedWorkerRun(db, rs);
  const result = conv.sendMessage(`worker:${worker.id}`, { text: 'hello worker' });

  assert.equal(result.status, 'sent');
  assert.equal(result.target.kind, 'worker');
  assert.equal(lc.delivered.length, 1);
  assert.equal(lc.delivered[0].text, 'hello worker');
});

test('conv: sendMessage to worker throws 502 when delivery fails', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const lc = makeFakeLifecycle({ deliverOk: false });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: lc,
  });

  const worker = seedWorkerRun(db, rs);
  let caught;
  try { conv.sendMessage(`worker:${worker.id}`, { text: 'fail' }); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw');
  assert.equal(caught.httpStatus, 502);
});

// ---------------------------------------------------------------------------
// Parent notice queue — peek-then-drain
// ---------------------------------------------------------------------------

test('conv: queueParentNotice + consumeParentNotices drains all entries', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  conv.queueParentNotice('run-A', 'notice 1');
  conv.queueParentNotice('run-A', 'notice 2');

  const first = conv.consumeParentNotices('run-A');
  assert.deepEqual(first, ['notice 1', 'notice 2']);

  const second = conv.consumeParentNotices('run-A');
  assert.deepEqual(second, [], 'queue is empty after first drain');
});

test('conv: commitDrainParentNotices splices only count items (race-safety)', async (t) => {
  // This is the lock-in: commitDrainParentNotices(runId, count) must remove
  // EXACTLY `count` items from the head, not wipe the entire queue.
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  conv.queueParentNotice('run-B', 'n1');
  conv.queueParentNotice('run-B', 'n2');
  conv.queueParentNotice('run-B', 'n3');

  // Simulate: peek returns 2 notices, then a concurrent worker adds 'n3'
  // We commitDrain with count=2 (only n1+n2 were seen at peek time).
  // Access the internal method exposed on the service.
  conv.queueParentNotice('run-B', 'n4'); // arrived between peek and commit

  // Now queue is [n1, n2, n3, n4]
  // commitDrain with count=2 should remove n1+n2, leaving [n3, n4]
  // Note: we need to access the internal method — it's exposed in the factory
  // closure but not the public API. We test it indirectly via the send path,
  // OR we call it directly if exported. Let's call consumeParentNotices and
  // check what remains after a drain of exactly 2.
  //
  // The test strategy: peek(2), drain(2), then consume-all to verify n3+n4 remain.
  // We call the internal commitDrainParentNotices by reaching into the service
  // using the fact that the function is defined inside and closed over pendingNotices.
  // Since it's not exported, we test it via the sendToManagerSlot path instead.

  // Simpler: reset queue to [n1, n2, n3, n4] and test consumeParentNotices
  // does a full delete (which is correct). We then test that commitDrain leaves tail.
  // Actually commitDrainParentNotices IS reachable indirectly through sendMessage
  // to a top manager run. Let's wire that path:

  const adapter = makeFakeAdapter();
  const topRun = seedTopRun(rs, registry, adapter);

  // Clear the queue we built up and seed a clean test
  conv.clearParentNotices('run-B');
  conv.queueParentNotice(topRun.id, 'early-notice-1');
  conv.queueParentNotice(topRun.id, 'early-notice-2');

  // Between peek (which sees 2) and commitDrain, a concurrent push lands:
  // simulate by making the adapter's runTurn add one more to the queue.
  const origRunTurn = adapter.runTurn.bind(adapter);
  adapter.runTurn = (runId, payload) => {
    // concurrently queue another notice DURING the turn
    conv.queueParentNotice(topRun.id, 'concurrent-notice');
    return origRunTurn(runId, payload);
  };

  conv.sendMessage('top', { text: 'trigger drain' });

  // After commit-drain: the 2 early notices should be gone, but the concurrent one survives.
  // We can verify via clearParentNotices (check count) — actually let's use consumeParentNotices.
  const remaining = conv.consumeParentNotices(topRun.id);
  assert.equal(remaining.length, 1, 'exactly 1 concurrent notice survives the drain');
  assert.equal(remaining[0], 'concurrent-notice');
});

test('conv: clearParentNotices drops all pending notices for a run', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  conv.queueParentNotice('run-X', 'n1');
  conv.queueParentNotice('run-X', 'n2');
  conv.clearParentNotices('run-X');

  assert.deepEqual(conv.consumeParentNotices('run-X'), []);
});

// ---------------------------------------------------------------------------
// resolveParentSlot: worker→Top and worker→PM
// ---------------------------------------------------------------------------

test('conv: worker→Top notice queued when parent is active Top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const lc = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: lc,
  });

  const topRun = seedTopRun(rs, registry, adapter);
  const worker = seedWorkerRun(db, rs, { parentRunId: topRun.id });

  conv.sendMessage(`worker:${worker.id}`, { text: 'direct worker msg' });

  // A notice should be queued for the Top run's id
  const notices = conv.consumeParentNotices(topRun.id);
  assert.equal(notices.length, 1, 'parent notice queued for Top');
  assert.match(notices[0], /system notice/);
});

test('conv: worker→Top notice dropped when parent run is no longer active', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const lc = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: lc,
  });

  const topRun = seedTopRun(rs, registry, adapter);
  const worker = seedWorkerRun(db, rs, { parentRunId: topRun.id });

  // Clear Top slot so parent is no longer the active run
  registry.clearActive('top', topRun.id);

  conv.sendMessage(`worker:${worker.id}`, { text: 'late message' });

  // No notice should survive — parent is gone
  const notices = conv.consumeParentNotices(topRun.id);
  assert.equal(notices.length, 0, 'notice dropped when parent not active');
});

test('conv: top message includes prepended pending notices', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const lc = makeFakeLifecycle();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: lc,
  });

  const topRun = seedTopRun(rs, registry, adapter);

  // Pre-queue a notice for the Top run
  conv.queueParentNotice(topRun.id, '[system notice] some warning');

  conv.sendMessage('top', { text: 'user message' });

  // The adapter should have received a message with the notice prepended
  assert.equal(adapter.calls.length, 1);
  const sentText = adapter.calls[0].payload.text;
  assert.match(sentText, /\[system notice\]/);
  assert.match(sentText, /user message/);
});

// ---------------------------------------------------------------------------
// onSlotCleared: notice queue scrub
// ---------------------------------------------------------------------------

test('conv: managerRegistry.onSlotCleared listener scrubs pending notices', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => adapter },
    lifecycleService: null,
  });

  // Wire the onSlotCleared hook — this is what app.js / pmSpawnService do
  registry.onSlotCleared(({ runId }) => conv.clearParentNotices(runId));

  const topRun = seedTopRun(rs, registry, adapter);
  conv.queueParentNotice(topRun.id, 'some notice');

  // Clearing the slot should trigger the hook and drop the notice
  registry.clearActive('top', topRun.id);

  const remaining = conv.consumeParentNotices(topRun.id);
  assert.equal(remaining.length, 0, 'notices scrubbed when slot is cleared');
});

// ---------------------------------------------------------------------------
// P6-8: pm:<id> sendMessage 라우팅
// ---------------------------------------------------------------------------

// Helper: PM run을 registry 에 seed
function seedPmRun(db, rs, registry, pmAdapter, { projectId = 'proj-pm1', parentTopRunId = null } = {}) {
  db.prepare(`INSERT OR IGNORE INTO projects (id, name, pm_enabled) VALUES ('${projectId}','PMProj',1)`).run();
  const run = rs.createRun({
    is_manager: true,
    manager_adapter: 'codex',
    manager_layer: 'pm',
    conversation_id: `pm:${projectId}`,
    parent_run_id: parentTopRunId || null,
    prompt: `pm for ${projectId}`,
  });
  rs.updateRunStatus(run.id, 'running', { force: true });
  registry.setActive(`pm:${projectId}`, run.id, pmAdapter);
  return rs.getRun(run.id);
}

test('conv: sendMessage to pm:<id> dispatches runTurn on PM adapter', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => pmAdapter },
    lifecycleService: null,
  });

  seedPmRun(db, rs, registry, pmAdapter);
  const result = conv.sendMessage('pm:proj-pm1', { text: 'hello pm' });

  assert.equal(result.status, 'sent');
  assert.equal(result.target.kind, 'pm');
  assert.equal(result.target.projectId, 'proj-pm1');
  assert.equal(pmAdapter.calls.length, 1);
  assert.equal(pmAdapter.calls[0].payload.text, 'hello pm');
});

test('conv: sendMessage to pm:<id> throws 404 when no active PM', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  let caught;
  try { conv.sendMessage('pm:no-such-project', { text: 'hi' }); } catch (e) { caught = e; }
  assert.ok(caught, 'should throw');
  assert.equal(caught.httpStatus, 404);
  assert.match(caught.message, /No active PM manager session/);
});

test('conv: PM→Top notice queued when PM message has active parent Top', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => topAdapter },
    lifecycleService: null,
  });

  const topRun = seedTopRun(rs, registry, topAdapter);
  const pmRun = seedPmRun(db, rs, registry, pmAdapter, { parentTopRunId: topRun.id });

  // PM adapter is registered directly — but managerAdapterFactory.getAdapter returns topAdapter.
  // The registry returns pmAdapter for the pm: slot, which is what sendToManagerSlot uses.
  // We need to ensure the correct adapter is returned per slot.
  // Override so registry-bound adapter is used (matches real app.js wiring):
  const conv2 = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  // sendMessage to PM — pmAdapter is in registry, so it gets the call
  conv2.sendMessage(`pm:proj-pm1`, { text: 'PM task update' });

  // PM's parent_run_id = topRun.id, and topRun is still active Top
  // → notice should be queued for topRun.id
  const notices = conv2.consumeParentNotices(topRun.id);
  assert.equal(notices.length, 1, 'PM→Top notice queued');
  assert.match(notices[0], /\[system notice\]/);
});

test('conv: PM→Top notice dropped when parent Top is no longer active', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  const topRun = seedTopRun(rs, registry, topAdapter);
  seedPmRun(db, rs, registry, pmAdapter, { parentTopRunId: topRun.id });

  // Clear the Top slot → parent is no longer active
  registry.clearActive('top');

  conv.sendMessage('pm:proj-pm1', { text: 'PM message after top gone' });

  // No notice should be queued — parent Top is gone
  const notices = conv.consumeParentNotices(topRun.id);
  assert.equal(notices.length, 0, 'notice dropped when parent Top not active');
});

// ---------------------------------------------------------------------------
// P6-8: onSlotCleared via probeActive dead detection
// ---------------------------------------------------------------------------

test('conv: onSlotCleared fires via probeActive when adapter reports dead session', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });

  // Adapter that reports the session as dead on first isSessionAlive call
  const deadAdapter = {
    ...makeFakeAdapter(),
    isSessionAlive: () => false,
    detectExitCode: () => 1,
    emitSessionEndedIfNeeded: () => {},
    disposeSession: () => {},
  };

  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => deadAdapter },
    lifecycleService: null,
  });

  // Wire onSlotCleared to scrub notices (same as app.js)
  registry.onSlotCleared(({ runId }) => conv.clearParentNotices(runId));

  const topRun = seedTopRun(rs, registry, deadAdapter);
  conv.queueParentNotice(topRun.id, 'queued notice');

  // probeActive detects the dead adapter → fires onSlotCleared → conv.clearParentNotices
  const probeResult = registry.probeActive('top');
  assert.equal(probeResult, null, 'probeActive returns null for dead session');

  // Notice should be scrubbed by the onSlotCleared hook
  const remaining = conv.consumeParentNotices(topRun.id);
  assert.equal(remaining.length, 0, 'notice scrubbed via probeActive dead detection');
});

// ---------------------------------------------------------------------------
// P6-8: onSlotCleared via setActive replacement
// ---------------------------------------------------------------------------

test('conv: onSlotCleared fires via setActive replacement and scrubs old run notices', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter1 = makeFakeAdapter();
  const adapter2 = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  // Wire onSlotCleared
  registry.onSlotCleared(({ runId }) => conv.clearParentNotices(runId));

  // Seed first Top run
  const run1 = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top1' });
  rs.updateRunStatus(run1.id, 'running', { force: true });
  registry.setActive('top', run1.id, adapter1);

  conv.queueParentNotice(run1.id, 'notice for old run');

  // Replace with a second Top run (setActive triggers onSlotCleared for run1)
  const run2 = rs.createRun({ is_manager: true, manager_adapter: 'claude-code', prompt: 'top2' });
  rs.updateRunStatus(run2.id, 'running', { force: true });
  registry.setActive('top', run2.id, adapter2);

  // run1's notices should be scrubbed
  const remaining1 = conv.consumeParentNotices(run1.id);
  assert.equal(remaining1.length, 0, 'old run notices scrubbed on setActive replacement');

  // run2 should be the new active Top
  assert.equal(registry.getActiveRunId('top'), run2.id);
});

test('conv: onSlotCleared for PM slot scrubs PM notices on setActive replacement', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, null);
  const registry = createManagerRegistry({ runService: rs });
  const adapter1 = makeFakeAdapter();
  const adapter2 = makeFakeAdapter();
  const conv = createConversationService({
    runService: rs, managerRegistry: registry,
    managerAdapterFactory: { getAdapter: () => makeFakeAdapter() },
    lifecycleService: null,
  });

  registry.onSlotCleared(({ runId }) => conv.clearParentNotices(runId));

  db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES ('proj-slot','SlotProj')`).run();

  // First PM run
  const pm1 = rs.createRun({
    is_manager: true, manager_adapter: 'codex', manager_layer: 'pm',
    conversation_id: 'pm:proj-slot', prompt: 'pm1',
  });
  rs.updateRunStatus(pm1.id, 'running', { force: true });
  registry.setActive('pm:proj-slot', pm1.id, adapter1);

  conv.queueParentNotice(pm1.id, 'pm notice for old slot');

  // Spawn a new PM (rotation) — setActive fires onSlotCleared for pm1
  const pm2 = rs.createRun({
    is_manager: true, manager_adapter: 'codex', manager_layer: 'pm',
    conversation_id: 'pm:proj-slot', prompt: 'pm2',
  });
  rs.updateRunStatus(pm2.id, 'running', { force: true });
  registry.setActive('pm:proj-slot', pm2.id, adapter2);

  // pm1's notices should be gone
  const remaining = conv.consumeParentNotices(pm1.id);
  assert.equal(remaining.length, 0, 'old PM run notices scrubbed on PM rotation');

  // pm2 should be the active PM
  assert.equal(registry.getActiveRunId('pm:proj-slot'), pm2.id);
});
