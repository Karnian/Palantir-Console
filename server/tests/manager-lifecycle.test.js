// PR2 — manager lifecycle leak fixes (P1-2, P1-4, NEW-B2, P1-5).
//
// These four leaks all share the same shape: a live manager slot exits the
// registry via some path that *almost* does the right thing but forgets a
// piece — disposeSession, notifySlotCleared, or both. The tests below stub
// a minimal adapter that records every dispose call and drive each of the
// four code paths through managerRegistry / app.shutdown. Real Claude /
// Codex subprocesses are not spawned; the goal is to verify the registry's
// cleanup contract, not the adapters.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createRunService } = require('../services/runService');
const { createManagerRegistry } = require('../services/managerRegistry');
const { createApp } = require('../app');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-lifecycle-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function makeFakeAdapter(opts = {}) {
  // { isAlive, exitCode, disposeThrows } for tests to flip individually.
  const calls = { dispose: [], emitEnded: [], kill: [] };
  let alive = opts.isAlive !== undefined ? opts.isAlive : true;
  return {
    calls,
    setAlive(v) { alive = v; },
    isSessionAlive: () => alive,
    detectExitCode: () => (opts.exitCode !== undefined ? opts.exitCode : null),
    emitSessionEndedIfNeeded: (runId, reason) => {
      calls.emitEnded.push({ runId, reason });
    },
    disposeSession: (runId) => {
      calls.dispose.push(runId);
      if (opts.disposeThrows) throw new Error('simulated dispose failure');
    },
    // Other methods the registry doesn't touch directly — present so any
    // accidental call surfaces in test output instead of TypeErrors.
    runTurn: () => ({ accepted: true }),
    getUsage: () => null,
    getSessionId: () => null,
    getOutput: () => null,
  };
}

// Seed a manager run row so runService.updateRunStatus in probeActive has
// something to act on. Uses createRunService directly; no HTTP.
function seedManagerRun(db, { conversationId = 'top', layer = 'top' } = {}) {
  const rs = createRunService(db, null);
  const run = rs.createRun({
    is_manager: true,
    manager_layer: layer,
    conversation_id: conversationId,
    prompt: 'hello',
  });
  return { run, runService: rs };
}

// ---- P1-4: setActive replacement disposes the previous adapter ----

test('P1-4 setActive replacement disposes previous adapter', async (t) => {
  const db = await mkdb(t);
  const { runService: rs } = seedManagerRun(db);
  const { run: run2 } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const adapter1 = makeFakeAdapter();
  const adapter2 = makeFakeAdapter();

  reg.setActive('top', 'run-1', adapter1);
  reg.setActive('top', run2.id, adapter2);

  assert.deepEqual(adapter1.calls.dispose, ['run-1'], 'previous adapter must be disposed');
  assert.deepEqual(adapter2.calls.dispose, [], 'new adapter must NOT be disposed on install');
  assert.equal(reg.getActiveRunId('top'), run2.id);
});

test('P1-4 setActive replacement still installs new run when dispose throws', async (t) => {
  const db = await mkdb(t);
  const { runService: rs } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const bad = makeFakeAdapter({ disposeThrows: true });
  const good = makeFakeAdapter();

  reg.setActive('top', 'run-1', bad);
  // Must not throw — log-and-continue is required so the new run isn't
  // stranded by a leaky old one.
  reg.setActive('top', 'run-2', good);

  assert.deepEqual(bad.calls.dispose, ['run-1']);
  assert.equal(reg.getActiveRunId('top'), 'run-2');
});

test('P1-4 setActive with same runId does NOT dispose', async (t) => {
  const db = await mkdb(t);
  const { runService: rs } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();

  reg.setActive('top', 'run-1', adapter);
  reg.setActive('top', 'run-1', adapter); // idempotent

  assert.deepEqual(adapter.calls.dispose, [], 'same runId must not trigger dispose');
});

// ---- NEW-B2: probeActive dead-session path disposes the adapter ----

test('NEW-B2 probeActive dead-session path calls disposeSession', async (t) => {
  const db = await mkdb(t);
  const { run, runService: rs } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter({ isAlive: false, exitCode: 0 });

  reg.setActive('top', run.id, adapter);
  const result = reg.probeActive('top');

  assert.equal(result, null, 'dead probe returns null');
  assert.deepEqual(adapter.calls.dispose, [run.id], 'adapter must be disposed after natural exit');
  assert.equal(adapter.calls.emitEnded.length, 1, 'session_ended emit still fires');
  assert.equal(adapter.calls.emitEnded[0].reason, 'natural-exit');
  assert.equal(reg.getActiveRunId('top'), null, 'slot cleared after probe');
});

test('NEW-B2 probeActive dead-session survives disposeSession throw', async (t) => {
  const db = await mkdb(t);
  const { run, runService: rs } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter({ isAlive: false, disposeThrows: true });

  reg.setActive('top', run.id, adapter);
  // probeActive must not throw even if dispose fails.
  const result = reg.probeActive('top');

  assert.equal(result, null);
  assert.deepEqual(adapter.calls.dispose, [run.id]);
  assert.equal(reg.getActiveRunId('top'), null, 'slot still cleared despite dispose failure');
});

// ---- P1-2: probeActive getRun-throw path notifies slot-cleared ----

test('P1-2 probeActive getRun-throw path fires notifySlotCleared', async (t) => {
  const db = await mkdb(t);
  const { run, runService: rs } = seedManagerRun(db);
  // Wrap getRun to throw — simulates a corrupted row or a closed db handle.
  const wrappedRs = {
    ...rs,
    getRun: () => { throw new Error('simulated db read failure'); },
  };
  const reg = createManagerRegistry({ runService: wrappedRs });
  const adapter = makeFakeAdapter({ isAlive: true });

  let notifiedRunId = null;
  reg.onSlotCleared(({ runId }) => { notifiedRunId = runId; });

  reg.setActive('top', run.id, adapter);
  const result = reg.probeActive('top');

  assert.equal(result, null);
  assert.equal(notifiedRunId, run.id, 'slot-cleared listener must fire on getRun throw path');
  assert.equal(reg.getActiveRunId('top'), null);
});

// ---- P1-5: app.shutdown disposes every live manager slot ----

test('P1-5 app.shutdown integration: real sweep disposes every live slot', async (t) => {
  // Codex PR2 R1 suggestion #1: drive the actual app.shutdown() closure
  // with live slots wired through createApp(). The unit test below
  // ('sweep iterates snapshot...') only re-executes the algorithm; this
  // test proves that server/app.js and the registry are actually wired
  // together and will catch a drift regression (e.g. someone refactors
  // the loop in app.js without updating the unit test).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-shutdown-int-'));
  const dbPath = path.join(dir, 'test.db');
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-store-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fs-'));
  const app = createApp({
    dbPath, storageRoot, fsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  // Seed two slots via the real managerRegistry exposed on app.
  const reg = app.managerRegistry;
  assert.ok(reg, 'app.managerRegistry must be exposed for tests');
  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter({ disposeThrows: true });
  reg.setActive('top', 'int-top-1', topAdapter);
  reg.setActive('pm:int-proj-1', 'int-pm-1', pmAdapter);

  // Exercise the real shutdown closure — must sweep both slots AND
  // tolerate the pm slot's dispose throwing.
  app.shutdown();

  assert.deepEqual(topAdapter.calls.dispose, ['int-top-1'], 'app.shutdown must dispose top slot via real wiring');
  assert.deepEqual(pmAdapter.calls.dispose, ['int-pm-1'], 'app.shutdown must still dispose pm slot even though it throws');
});

test('P1-5 app.shutdown is safe when no managers are active', async (t) => {
  // Smoke test the real createApp()'s shutdown path with zero live
  // managers — this is the common case and must not throw. The richer
  // "dispose sweep iterates and tolerates failure" coverage lives in
  // the unit test below, which drives managerRegistry directly.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-shutdown-'));
  const dbPath = path.join(dir, 'test.db');
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-store-'));
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fs-'));
  const app = createApp({
    dbPath, storageRoot, fsRoot,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
    await fs.rm(fsRoot, { recursive: true, force: true });
  });

  // Must not throw even though no managers were spawned.
  app.shutdown();
});

test('P1-5 app.shutdown sweep iterates snapshot and disposes each slot', async (t) => {
  // Unit-style: build a registry + seed two slots (top + one PM) + drive
  // the same sweep algorithm app.shutdown uses. Verifies both dispose
  // calls land and neither failure stops the other.
  const db = await mkdb(t);
  const { run: topRun, runService: rs } = seedManagerRun(db);
  const { run: pmRun } = seedManagerRun(db, {
    conversationId: 'pm:proj-1',
    layer: 'pm',
  });
  const reg = createManagerRegistry({ runService: rs });

  const topAdapter = makeFakeAdapter();
  const pmAdapter = makeFakeAdapter({ disposeThrows: true }); // hostile path
  reg.setActive('top', topRun.id, topAdapter);
  reg.setActive('pm:proj-1', pmRun.id, pmAdapter);

  // Replicate the app.shutdown sweep loop verbatim. If this ever drifts
  // from server/app.js, update both places.
  const snap = reg.snapshot();
  const slots = [];
  if (snap.top) slots.push(snap.top);
  for (const pm of (snap.pms || [])) slots.push(pm);
  for (const slot of slots) {
    try {
      const adapter = reg.getActiveAdapter(slot.conversationId);
      if (adapter && typeof adapter.disposeSession === 'function') {
        adapter.disposeSession(slot.runId);
      }
    } catch { /* log-and-continue in prod; swallow here */ }
  }

  assert.deepEqual(topAdapter.calls.dispose, [topRun.id], 'top slot must be disposed');
  assert.deepEqual(pmAdapter.calls.dispose, [pmRun.id], 'pm slot must be disposed even though it throws');
});

// ---- Regression: notifySlotCleared still fires on explicit clearActive ----

test('clearActive fires notifySlotCleared (regression guard)', async (t) => {
  const db = await mkdb(t);
  const { run, runService: rs } = seedManagerRun(db);
  const reg = createManagerRegistry({ runService: rs });
  const adapter = makeFakeAdapter();

  let notifiedRunId = null;
  reg.onSlotCleared(({ runId }) => { notifiedRunId = runId; });

  reg.setActive('top', run.id, adapter);
  reg.clearActive('top');

  assert.equal(notifiedRunId, run.id);
  // clearActive is an explicit user action — does NOT dispose the adapter.
  // Disposal on explicit clear is a separate decision; today pmCleanupService
  // is the single dispose owner on the delete-project / /reset path. Pinning
  // current behavior so future changes are intentional.
  assert.deepEqual(adapter.calls.dispose, []);
});
