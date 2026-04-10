// P2-3 / P2-4 / P3-6: observability round.
//
// P2-3 is locked by sse-channels.test.js (static assertion against
// hooks.js). This file covers the P2-4 derivePmProjectId diagnostic
// hook — a pure observability addition that does not change return
// behavior but surfaces drift between the JOIN-derived project id and
// the conversation_id 'pm:<id>' path.
//
// P3-6: wires the diagnostic hook (set inside createRunService) to the
// eventBus so server-side observers and run_events get the mismatch signal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const EventEmitter = require('node:events');

const {
  derivePmProjectId,
  setDerivePmProjectIdDiagnostics,
  createRunService,
} = require('../services/runService');
const { createDatabase } = require('../db/database');

test('P2-4: derivePmProjectId returns joinPid when only JOIN is present', () => {
  const run = { id: 'r1', project_id: 'proj_a', manager_layer: null, conversation_id: null };
  assert.equal(derivePmProjectId(run), 'proj_a');
});

test('P2-4: derivePmProjectId returns parsed pid when only conversation_id is present', () => {
  const run = {
    id: 'r2',
    project_id: null,
    manager_layer: 'pm',
    conversation_id: 'pm:proj_b',
  };
  assert.equal(derivePmProjectId(run), 'proj_b');
});

test('P2-4: derivePmProjectId prefers JOIN path when both agree', () => {
  const run = {
    id: 'r3',
    project_id: 'proj_c',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_c',
  };
  assert.equal(derivePmProjectId(run), 'proj_c');
});

test('P2-4: derivePmProjectId fires diagnostic hook on mismatch and still returns JOIN pid', (t) => {
  const received = [];
  setDerivePmProjectIdDiagnostics((payload) => received.push(payload));
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  const run = {
    id: 'r4',
    project_id: 'proj_join',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_other',
  };
  const result = derivePmProjectId(run);
  assert.equal(result, 'proj_join', 'JOIN path is authoritative even on mismatch');
  assert.equal(received.length, 1, 'diagnostic fired exactly once');
  assert.equal(received[0].runId, 'r4');
  assert.equal(received[0].joinPid, 'proj_join');
  assert.equal(received[0].parsedPid, 'proj_other');
  assert.equal(received[0].conversationId, 'pm:proj_other');
});

test('P2-4: derivePmProjectId does NOT fire diagnostic when only one source is present', (t) => {
  const received = [];
  setDerivePmProjectIdDiagnostics((payload) => received.push(payload));
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  derivePmProjectId({ id: 'r5', project_id: 'p', manager_layer: null });
  derivePmProjectId({ id: 'r6', project_id: null, manager_layer: 'pm', conversation_id: 'pm:p' });
  derivePmProjectId({ id: 'r7', project_id: null, manager_layer: null });

  assert.equal(received.length, 0, 'no diagnostic when sources cannot disagree');
});

test('P2-4: derivePmProjectId tolerates a throwing diagnostic hook', (t) => {
  setDerivePmProjectIdDiagnostics(() => { throw new Error('hook exploded'); });
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  const run = {
    id: 'r8',
    project_id: 'a',
    manager_layer: 'pm',
    conversation_id: 'pm:b',
  };
  // Must not propagate the hook's throw.
  const result = derivePmProjectId(run);
  assert.equal(result, 'a');
});

test('P2-4: derivePmProjectId handles null / malformed runs without throwing', () => {
  assert.equal(derivePmProjectId(null), null);
  assert.equal(derivePmProjectId(undefined), null);
  assert.equal(derivePmProjectId({}), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'pm:' }), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'notpm:x' }), null);
});

// ---------------------------------------------------------------------------
// P3-6: eventBus wiring via createRunService
// ---------------------------------------------------------------------------

async function mkTestDb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-p3obs-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
    // Reset the module-level diagnostic hook so P2-4 tests are not affected
    // by P3-6 wiring introduced by createRunService calls in this suite.
    setDerivePmProjectIdDiagnostics(null);
  });
  return db;
}

test('P3-6: createRunService wires derivePmProjectId to emit diagnostic:pm_project_mismatch on eventBus', async (t) => {
  const db = await mkTestDb(t);
  const mockBus = new EventEmitter();
  const received = [];
  mockBus.on('diagnostic:pm_project_mismatch', (payload) => received.push(payload));

  // Instantiating the service registers the diagnostic hook
  createRunService(db, mockBus);

  // Now trigger a mismatch directly via derivePmProjectId
  const run = {
    id: 'r_p3_bus',
    project_id: 'proj_join',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_other',
  };
  derivePmProjectId(run);

  assert.equal(received.length, 1, 'diagnostic:pm_project_mismatch fired exactly once');
  assert.equal(received[0].runId, 'r_p3_bus');
  assert.equal(received[0].derived, 'proj_join');
  assert.equal(received[0].joined, 'proj_other');
  assert.equal(received[0].conversationId, 'pm:proj_other');
});

test('P3-6: createRunService wires derivePmProjectId to record diagnostic run_event on mismatch', async (t) => {
  const db = await mkTestDb(t);
  const mockBus = new EventEmitter();

  // Seed a real PM run row so addRunEvent can foreign-key insert
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('ap_p3','PA','codex','codex')`).run();
  db.prepare(`INSERT INTO projects (id, name) VALUES ('proj_p3_j', 'JoinProj')`).run();
  db.prepare(`INSERT INTO projects (id, name) VALUES ('proj_p3_o', 'OtherProj')`).run();

  const runService = createRunService(db, mockBus);

  // Create a PM manager run with conversation_id matching project join
  const run = runService.createRun({
    is_manager: true,
    manager_layer: 'pm',
    conversation_id: 'pm:proj_p3_j',
  });

  // Manually trigger derivePmProjectId with a mismatch between row's project_id
  // (from the JOIN path, currently null since no task) and conversation_id path.
  // We fabricate a run object that mimics the mismatch condition.
  const mismatchRun = {
    id: run.id,
    project_id: 'proj_p3_j',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_p3_o',
  };
  derivePmProjectId(mismatchRun);

  // Verify a diagnostic run_event was recorded
  const events = runService.getRunEvents(run.id);
  const diagEvent = events.find(e => e.event_type === 'diagnostic');
  assert.ok(diagEvent, 'diagnostic run_event recorded');
  const payload = JSON.parse(diagEvent.payload_json);
  assert.equal(payload.subtype, 'pm_project_mismatch');
  assert.equal(payload.joinPid, 'proj_p3_j');
  assert.equal(payload.parsedPid, 'proj_p3_o');
});

test('P3-6: diagnostic wiring is resilient — emitting on mockBus that throws does not propagate', async (t) => {
  const db = await mkTestDb(t);
  const throwingBus = new EventEmitter();
  throwingBus.emit = () => { throw new Error('bus exploded'); };

  createRunService(db, throwingBus);

  const run = {
    id: 'r_p3_safe',
    project_id: 'a',
    manager_layer: 'pm',
    conversation_id: 'pm:b',
  };
  // Must not throw even though the bus is broken
  const result = derivePmProjectId(run);
  assert.equal(result, 'a', 'return value unaffected when bus throws');
});

test('P3-6: diagnostic:pm_project_mismatch is in SERVER_EMITS and not in CLIENT_REQUIRED_LIVE', () => {
  const { SERVER_EMITS, CLIENT_REQUIRED_LIVE } = require('../services/eventChannels');
  assert.ok(SERVER_EMITS.includes('diagnostic:pm_project_mismatch'), 'channel in SERVER_EMITS');
  assert.ok(!CLIENT_REQUIRED_LIVE.includes('diagnostic:pm_project_mismatch'), 'channel NOT in CLIENT_REQUIRED_LIVE');
});
