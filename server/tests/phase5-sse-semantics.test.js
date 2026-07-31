// v3 Phase 5 — SSE lifecycle event semantic enrichment.
// Spec §9.8: run:status / run:ended / run:needs_input / run:completed
// payloads carry from_status / to_status / reason / task_id / project_id / node_id
// so clients can filter and prioritize without re-reading the DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createEventBus } = require('../services/eventBus');
const { createRunService } = require('../services/runService');
const { createProjectService } = require('../services/projectService');
const { createTaskService } = require('../services/taskService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-phase5-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function collectEvents(bus) {
  const events = [];
  const unsub = bus.subscribe((e) => events.push(e));
  return { events, unsub };
}

test('Phase 5: updateRunStatus emits run:status with semantic envelope', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'alpha' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1', node_id: 'local' });

  const { events } = collectEvents(bus);
  rs.updateRunStatus(run.id, 'running', { force: true, reason: 'test-start' });

  const statusEvent = events.find(e => e.channel === 'run:status');
  assert.ok(statusEvent);
  assert.equal(statusEvent.data.from_status, 'queued');
  assert.equal(statusEvent.data.to_status, 'running');
  assert.equal(statusEvent.data.reason, 'test-start');
  assert.equal(statusEvent.data.task_id, task.id);
  assert.equal(statusEvent.data.project_id, project.id);
  assert.equal(statusEvent.data.node_id, 'local');
  assert.equal(statusEvent.data.run.id, run.id);
});

test('Phase 5: terminal transition emits run:ended with semantic envelope', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'alpha' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1', node_id: 'local' });
  rs.updateRunStatus(run.id, 'running', { force: true });

  const { events } = collectEvents(bus);
  rs.updateRunStatus(run.id, 'failed', { force: true, reason: 'agent-exit-error(7)' });

  const ended = events.find(e => e.channel === 'run:ended');
  assert.ok(ended);
  assert.equal(ended.data.from_status, 'running');
  assert.equal(ended.data.to_status, 'failed');
  assert.equal(ended.data.reason, 'agent-exit-error(7)');
  assert.equal(ended.data.task_id, task.id);
  assert.equal(ended.data.project_id, project.id);
  assert.equal(ended.data.node_id, 'local');
});

test('Phase 5: repeated forced write of the same terminal state is a silent no-op', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'terminal-cas' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  rs.updateRunStatus(run.id, 'running', { force: true });

  const { events } = collectEvents(bus);
  const first = rs.updateRunStatus(run.id, 'failed', { force: true, reason: 'first' });
  const second = rs.updateRunStatus(run.id, 'failed', { force: true, reason: 'duplicate' });

  assert.equal(second.status, 'failed');
  assert.equal(second.ended_at, first.ended_at);
  assert.equal(events.filter((event) => event.channel === 'run:ended').length, 1);
  assert.equal(events.filter((event) => event.channel === 'run:status').length, 1);
  assert.equal(
    rs.getRunEvents(run.id).filter((event) => event.event_type === 'status:failed').length,
    1,
  );

  // The dropped write still leaves a trace. The observer that loses the race
  // may be the one that knew why — an idle timeout can beat a rate-limit
  // classification — so its reason is kept as an annotate-only event rather
  // than discarded.
  const duplicates = rs.getRunEvents(run.id)
    .filter((event) => event.event_type === 'status:duplicate_terminal');
  assert.equal(duplicates.length, 1);
  assert.deepEqual(JSON.parse(duplicates[0].payload_json), {
    status: 'failed',
    reason: 'duplicate',
  });

  // `force` still permits a real transition away from a terminal state.
  rs.updateRunStatus(run.id, 'queued', { force: true, reason: 'manual-requeue' });
  assert.equal(rs.getRun(run.id).status, 'queued');
});

test('Phase 5: the unforced status route still rejects a repeated terminal write', async (t) => {
  const db = await mkdb(t);
  const rs = createRunService(db, createEventBus());
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'terminal-unforced' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  rs.updateRunStatus(run.id, 'completed', { force: true });

  // De-duplicating internal observers must not quietly relax the external API
  // contract: PATCH /api/runs/:id/status is unforced, and a terminal run
  // refusing further writes is the behavior its callers were given.
  assert.throws(
    () => rs.updateRunStatus(run.id, 'completed'),
    /Cannot transition run from 'completed' to 'completed'/,
  );
});

test('Phase 5: force still permits transitions between distinct terminal states', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'terminal-force' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  rs.updateRunStatus(run.id, 'completed', { force: true, reason: 'first-observation' });

  const { events } = collectEvents(bus);
  const corrected = rs.updateRunStatus(run.id, 'failed', {
    force: true,
    reason: 'authoritative-correction',
  });

  assert.equal(corrected.status, 'failed');
  const ended = events.filter((event) => event.channel === 'run:ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].data.from_status, 'completed');
  assert.equal(ended[0].data.to_status, 'failed');
  assert.equal(ended[0].data.reason, 'authoritative-correction');
});

test('Phase 5: markRunStarted emits run:status with from_status and reason', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'alpha' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });

  const { events } = collectEvents(bus);
  rs.markRunStarted(run.id, { tmux_session: null });

  const status = events.find(e => e.channel === 'run:status');
  assert.ok(status);
  assert.equal(status.data.from_status, 'queued');
  assert.equal(status.data.to_status, 'running');
  assert.equal(status.data.reason, 'started');
  assert.equal(status.data.task_id, task.id);
  assert.equal(status.data.project_id, project.id);
});

test('Phase 5: updateRunStatus without reason still ships null reason', async (t) => {
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'alpha' });
  const task = ts.createTask({ title: 'T', project_id: project.id });
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });

  const { events } = collectEvents(bus);
  rs.updateRunStatus(run.id, 'running', { force: true });
  const status = events.find(e => e.channel === 'run:status');
  assert.equal(status.data.reason, null);
});

test('Phase 5: R1 fix — createRun emits normalized run:status envelope', async (t) => {
  // Regression for codex R1: the initial queued emission used to ship
  // bare `{ run }` which left SSE subscribers with a mixed schema on
  // the same channel.
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const project = ps.createProject({ name: 'alpha' });
  const task = ts.createTask({ title: 'T', project_id: project.id });

  const { events } = collectEvents(bus);
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  const status = events.find(e => e.channel === 'run:status');
  assert.ok(status);
  assert.equal(status.data.run.id, run.id);
  // Envelope fields are all present (no undefined on the wire).
  // from_status is null for a fresh create — there is no prior status.
  assert.equal(status.data.from_status, null);
  assert.equal(status.data.to_status, 'queued');
  assert.equal(status.data.reason, 'created');
  assert.equal(status.data.task_id, task.id);
  assert.equal(status.data.project_id, project.id);
});

test('Phase 5: backwards compat — run field still present at top level', async (t) => {
  // Existing subscribers that read event.data.run (pre-Phase 5) must
  // keep working. The enriched fields are ADDITIVE, not a replacement.
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const task = ts.createTask({ title: 'T', project_id: ps.createProject({ name: 'x' }).id });
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });

  const { events } = collectEvents(bus);
  rs.updateRunStatus(run.id, 'running', { force: true });
  const status = events.find(e => e.channel === 'run:status');
  assert.ok(status.data.run);
  assert.equal(status.data.run.id, run.id);
  assert.equal(status.data.run.status, 'running');
});

// Codex review: the CAS loop re-reads the row on every attempt, so a
// terminalReason captured BEFORE the loop describes a transition that may no
// longer be the one being written. Passing a function makes the reason a
// property of the row actually won, not of the row first observed.
//
// The race is injected by wrapping db.prepare(): the CAS statement mutates the
// row through the same connection right before its first .run(), so attempt 1
// matches nothing and attempt 2 writes against the new status. With a
// non-conditional WHERE, attempt 1 would succeed and these assertions fail.
for (const [parked, raced, expected] of [
  ['needs_input', 'running', null],
  ['running', 'needs_input', 'idle_timeout'],
]) {
  test(`Phase 5: terminalReason is derived per CAS attempt (${parked} → ${raced})`, async (t) => {
    const db = await mkdb(t);
    const ps = createProjectService(db);
    const ts = createTaskService(db, null);
    const task = ts.createTask({ title: 'T', project_id: ps.createProject({ name: 'cas-reason' }).id });
    db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();

    let casStatement = null;
    let raceArmed = false;
    const realPrepare = db.prepare.bind(db);
    const racingDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
        return (sql) => {
          const stmt = realPrepare(sql);
          if (!/UPDATE runs[\s\S]*WHERE id = \? AND status = \?/.test(sql)) return stmt;
          casStatement = stmt;
          return new Proxy(stmt, {
            get(sTarget, sProp, sReceiver) {
              if (sProp !== 'run') return Reflect.get(sTarget, sProp, sReceiver);
              return (...args) => {
                // Armed only for the cancel below; the setup transitions above
                // use this same statement and must not consume the injection.
                if (raceArmed) {
                  raceArmed = false;
                  // A competing writer lands between our read and our write.
                  realPrepare('UPDATE runs SET status = ? WHERE id = ?').run(raced, args[args.length - 2]);
                }
                return sTarget.run(...args);
              };
            },
          });
        };
      },
    });

    const rs = createRunService(racingDb, null);
    const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
    rs.updateRunStatus(run.id, 'running', { force: true });
    rs.updateRunStatus(run.id, parked, { force: true, reason: parked === 'needs_input' ? 'idle_timeout' : 'go' });

    assert.ok(casStatement, 'the CAS statement must have been prepared');

    raceArmed = true;
    rs.updateRunStatus(run.id, 'cancelled', {
      force: true,
      // Stands in for lifecycleService's idleTimeoutTerminalReason: a pure
      // function of the row it is handed. Whether THAT function reads the right
      // signals is pinned in lifecycle.test.js; what matters here is only which
      // row it gets handed.
      terminalReason: latest => (latest.status === 'needs_input' ? 'idle_timeout' : null),
    });

    const final = rs.getRun(run.id);
    assert.equal(final.status, 'cancelled');
    assert.equal(
      final.terminal_reason,
      expected,
      'terminal_reason must describe the row the winning CAS attempt wrote',
    );
  });
}

test('Phase 5: a duplicate terminal observation drops its reason rather than guessing', async (t) => {
  // The backfill this test used to assert was removed on purpose. By the time a
  // duplicate observation is dropped, the row is already terminal, so a
  // write-time derivation has nothing left to read — it would either produce
  // nothing or describe a transition that already happened. A missing reason
  // beats a wrong one; terminal_reason is display provenance and never feeds
  // retry or status decisions. The loser's reason survives as an annotate-only
  // event, which is what the audit trail actually needs.
  const db = await mkdb(t);
  const bus = createEventBus();
  const rs = createRunService(db, bus);
  const ps = createProjectService(db);
  const ts = createTaskService(db, null);
  const task = ts.createTask({ title: 'T', project_id: ps.createProject({ name: 'no-guess' }).id });
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command) VALUES ('a1','A','codex','codex')`).run();
  const run = rs.createRun({ task_id: task.id, agent_profile_id: 'a1' });
  rs.updateRunStatus(run.id, 'running', { force: true });
  rs.updateRunStatus(run.id, 'cancelled', { force: true });

  const { events } = collectEvents(bus);
  rs.updateRunStatus(run.id, 'cancelled', {
    force: true,
    reason: 'idle_timeout',
    terminalReason: () => 'idle_timeout',
  });

  assert.equal(rs.getRun(run.id).terminal_reason, null, 'no reason is invented after the fact');
  assert.equal(
    events.filter(e => e.channel === 'run:ended').length,
    0,
    'a duplicate terminal observation still emits nothing',
  );
  const annotated = rs.getRunEvents(run.id)
    .filter(e => e.event_type === 'status:duplicate_terminal');
  assert.equal(annotated.length, 1, "the loser's reason is preserved as an annotation");
  assert.equal(JSON.parse(annotated[0].payload_json).reason, 'idle_timeout');
});
