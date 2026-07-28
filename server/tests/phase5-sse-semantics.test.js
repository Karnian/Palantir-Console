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
