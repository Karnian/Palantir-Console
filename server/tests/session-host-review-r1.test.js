'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');

test('R1-01 resume carries saved Claude session identity; start has no resume flag', t => {
  const f = fixture(t); f.start(); const saved = 'claude-session-distinct-from-owned-id';
  const db = new Database(f.dbPath);
  db.prepare('UPDATE owned_sessions SET claude_session_id=? WHERE id=?').run(saved, f.sid); db.close();
  f.core.submit(f.req('stop')); const r = f.core.submit(f.req('resume'));
  assert.equal(r.state, 'done');
  assert.equal(f.adapter.log.startRequests?.[0].resume, undefined);
  assert.equal(f.adapter.log.startRequests?.[1].resume, true);
  assert.equal(f.adapter.log.startRequests?.[1].claude_session_id, saved);
});

test('R1-02 receipts correlate request id and late receipt cannot clear unknown barrier', t => {
  const f = fixture(t, { manual: true, noReceipt: true }); f.start(); const p = f.prompt();
  const a = f.core.submit(f.req('interrupt')); f.advance(10000); f.core.tick?.();
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: 'wrong', still_queued: [] });
  assert.equal(f.d(a.id).state, 'unknown');
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: a.id, still_queued: [] });
  assert.equal(f.state().incarnations[0].interrupt_unknown, 1);
  assert.equal(f.prompt('blocked').state, 'rejected');
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  assert.equal(f.d(a.id).state, 'completed'); assert.equal(f.state().incarnations[0].interrupt_unknown, 0);
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: p.message_uuid, state: 'cancelled' });
  const b = f.core.submit(f.req('interrupt'));
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: a.id, still_queued: [] });
  assert.equal(f.d(b.id).state, 'written');
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: b.id, still_queued: [] });
  assert.equal(f.d(b.id).state, 'provider_observed'); assert.equal(f.adapter.log.interrupts.length, 2);
});

test('R1-03 interrupt stays written until injected-clock receipt deadline, no real timer', t => {
  const f = fixture(t, { noReceipt: true, manual: true }); f.start(); f.prompt();
  const d = f.core.submit(f.req('interrupt')); assert.equal(d.state, 'written');
  f.advance(9999); f.core.tick(); assert.equal(f.d(d.id).state, 'written');
  f.advance(1); f.core.tick(); assert.equal(f.d(d.id).state, 'unknown');
  assert.equal(f.state().incarnations[0].interrupt_unknown, 1); assert.equal(f.adapter.log.interrupts.length, 1);
});

test('R1-04 duplicate interrupt key alias is durable after completion and reboot', t => {
  const f = fixture(t, { manual: true }); f.start(); const p = f.prompt();
  const a = f.core.submit(f.req('interrupt')), alias = f.req('interrupt');
  assert.equal(f.core.submit(alias).id, a.id);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: false });
  assert.equal(f.core.submit(alias).id, a.id); assert.equal(f.adapter.log.interrupts.length, 1);
  f.reboot().recover(); assert.equal(f.core.submit(alias).id, a.id);
  assert.equal(f.core.submit({ ...alias, body: 'different' }).status, 409);
});

for (const phase of ['deleting', 'deleted']) test(`R1-05 ${phase} rejects new requests without retaining body or events`, t => {
  const f = fixture(t); f.start(); f.prompt(); f.core.submit(f.req('close'));
  if (phase === 'deleting') {
    f.faults.arm('after_deleting_commit'); assert.throws(() => f.core.submit(f.req('delete')), SimulatedCrash); f.reboot();
  } else f.core.submit(f.req('delete'));
  const req = f.req('prompt', { body: 'MUST-NOT-BE-STORED' }); const response = f.core.submit(req);
  assert.equal(response.state, 'rejected');
  const db = new Database(f.dbPath);
  assert.equal(db.prepare('SELECT count(*) n FROM deliveries WHERE request_key=?').get(req.request_key).n, 0);
  assert.equal(db.prepare("SELECT count(*) n FROM events WHERE json LIKE '%MUST-NOT-BE-STORED%'").get().n, 0);
  assert.equal(f.core.submit(req).state, 'rejected'); db.close(); assert.equal(f.adapter.log.received.length, 1);
});

test('R1-06 capability auto-close has durable close_sent intent and async exit closes session', t => {
  const f = fixture(t, { capabilities: [], noExit: true }); f.start(); f.prompt();
  const c = f.state().controls.find(c => c.reason === 'capability_missing');
  assert.equal(c?.kind, 'close'); assert.equal(c?.stage, 'close_sent'); assert.equal(c?.state, 'accepted');
  assert.equal(f.state().session.state, 'active'); f.adapter.exit(f.iid);
  assert.equal(f.state().session.state, 'closed');
  assert.equal(f.state().controls.find(x => x.request_key === c.request_key).state, 'done');
  assert.equal(f.adapter.log.closes.length, 1);
});

for (const first of ['cancelled', 'completed']) test(`R1-07 first terminal ${first} survives late opposite lifecycle`, t => {
  const f = fixture(t, { manual: true }); f.start(); const d = f.prompt();
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: d.message_uuid, state: first }); const before = f.d(d.id);
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: d.message_uuid, state: first === 'cancelled' ? 'completed' : 'cancelled' });
  assert.equal(f.d(d.id).state, before.state); assert.equal(f.d(d.id).outcome, before.outcome);
});

for (const mode of ['match', 'query_failed', 'mismatch_confirmed']) test(`R1-08 pending start recovery ${mode} has correct final control result`, t => {
  const f = fixture(t); const req = { request_key: f.key(), kind: 'start' };
  f.faults.arm('after_spawn_before_identity'); assert.throws(() => f.core.submit(req), SimulatedCrash);
  const id = f.adapter.log.starts[0], child = f.adapter.children.get(id);
  f.probe.checks.set(`${child.pid}:${child.startedAt}`, mode); f.reboot().recover();
  const c = f.core.submit(req);
  assert.equal(c.state, mode === 'mismatch_confirmed' ? 'failed' : 'blocked');
  assert.equal(c.reason, mode === 'mismatch_confirmed' ? 'exited_before_confirm' : 'control_lost');
  assert.equal(f.adapter.log.starts.length, 1);
});

for (const mode of ['match', 'query_failed', 'mismatch_confirmed', 'never_started']) test(`R1-08 pending resume recovery ${mode} preserves reservation and spawn count`, t => {
  const f = fixture(t); f.start(); f.core.submit(f.req('stop')); const req = f.req('resume');
  f.faults.arm(mode === 'never_started' ? 'after_spawn_sent_before_spawn' : 'after_spawn_before_identity');
  assert.throws(() => f.core.submit(req), SimulatedCrash);
  if (mode !== 'never_started') {
    const id = f.adapter.log.starts.at(-1), child = f.adapter.children.get(id);
    f.probe.checks.set(`${child.pid}:${child.startedAt}`, mode);
  }
  const count = f.adapter.log.starts.length; f.reboot().recover(); const c = f.core.submit(req);
  assert.equal(c.state, ['match', 'query_failed'].includes(mode) ? 'blocked' : 'failed');
  assert.equal(c.reason, mode === 'never_started' ? 'not_started' : mode === 'mismatch_confirmed' ? 'exited_before_confirm' : 'control_lost');
  assert.equal(f.adapter.log.starts.length, count);
});

test('R1-09-17 error subtype is retained with errored prompt outcome', t => {
  const f = fixture(t, { manual: true }); f.start(); const d = f.prompt();
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [d.message_uuid], is_error: true, subtype: 'error_max_turns' });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: d.message_uuid, state: 'completed' });
  assert.equal(f.d(d.id).outcome, 'errored'); assert.equal(f.d(d.id).reason, 'error_max_turns');
});

test('R1-10 finished tool error unknown has no attribution barrier; resultless decision recovery stays unknown', t => {
  const f = fixture(t, { toolError: true }); f.start(); f.adapter.toolRequest(f.iid, 'done');
  const done = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'done' }));
  assert.equal(done.state, 'unknown'); assert.equal(f.state().incarnations[0].attribution_uncertain, 0);
  assert.equal(f.prompt().state, 'completed'); assert.equal(f.adapter.log.executions.length, 1);
  f.adapter.options.manualTools = true; f.adapter.toolRequest(f.iid, 'pending');
  const pending = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'pending' }));
  f.reboot().recover(); assert.equal(f.d(pending.id).state, 'unknown');
  assert.equal(f.core.submit(f.req('tool_decision', { target_tool_use_id: 'pending' })).state, 'rejected');
  assert.equal(f.adapter.log.executions.length, 2);
});

test('R1-11 missing capability plus missing lifecycle: no idle close until exit, prompt unknown, no extra send', t => {
  const f = fixture(t, { capabilities: [], omitLifecycle: true }); f.start(); const p = f.prompt();
  assert.equal(p.state, 'written'); assert.equal(f.core.idle(f.sid), false); assert.equal(f.adapter.log.closes.length, 0);
  assert.equal(f.prompt().state, 'rejected'); f.adapter.exit(f.iid);
  assert.equal(f.d(p.id).state, 'unknown'); assert.equal(f.state().session.state, 'closed');
  f.start(); f.adapter.options.omitLifecycle = false; f.prompt();
  assert.equal(f.adapter.log.closes.length, 1); assert.equal(f.adapter.log.received.length, 2);
});

test('R1-12 abort at after_sending_commit cancels delivery with zero decide for that card', t => {
  const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 'baseline');
  f.core.submit(f.req('tool_decision', { target_tool_use_id: 'baseline' }));
  const ac = f.adapter.toolRequest(f.iid, 'abort'); const old = f.faults.hit.bind(f.faults);
  f.faults.hit = point => { old(point); if (point === 'after_sending_commit') ac.abort(); };
  const d = f.core.submit(f.req('tool_decision', { target_tool_use_id: 'abort' }));
  assert.equal(d.state, 'cancelled'); assert.equal(f.adapter.log.decisions.length, 1);
  assert.equal(f.adapter.log.decisions.some(x => x.tool_use_id === 'abort'), false);
});

test('R1-13 observed committed before written cannot regress on late written commit', t => {
  const f = fixture(t, { drop: true }); f.start(); const old = f.faults.hit.bind(f.faults); let witnessed;
  f.faults.hit = point => {
    old(point); if (point !== 'after_effect_before_written') return;
    const db = new Database(f.dbPath); const d = db.prepare('SELECT * FROM deliveries ORDER BY rowid DESC LIMIT 1').get();
    db.transaction(() => {
      db.prepare("UPDATE deliveries SET state='provider_observed' WHERE id=? AND state='sending'").run(d.id);
      db.prepare("INSERT INTO events(session_id,incarnation_id,type,json,created_at) VALUES(?,?,?,?,?)").run(f.sid, f.iid, 'test_observed', '{}', f.time);
    })();
    witnessed = db.prepare('SELECT state FROM deliveries WHERE id=?').get(d.id).state; db.close();
  };
  const d = f.prompt(); assert.equal(witnessed, 'provider_observed'); assert.equal(d.state, 'provider_observed');
  assert.equal(f.adapter.log.received.length, 1);
});

test('R1-14 delayed unknown original executes once and result attaches only to original', t => {
  const f = fixture(t, { late: true }); f.start(); const send = f.adapter.send;
  f.adapter.send = (...args) => { send(...args); throw new Error('effect returned ambiguously'); };
  const req = f.req('prompt', { body: 'original' }), p = f.core.submit(req);
  assert.equal(p.state, 'unknown'); assert.equal(f.prompt('second').state, 'rejected');
  assert.equal(f.core.submit(req).id, p.id); f.adapter.flush();
  assert.equal(f.d(p.id).outcome, 'completed');
  assert.equal(f.state().deliveries.find(x => x.id !== p.id).outcome, null);
  assert.equal(f.adapter.log.received.length, 1);
});

test('R1-15 system_init emitted only for first prompt and first capability verdict cannot be replaced', t => {
  const f = fixture(t); f.start(); f.prompt(); f.prompt();
  const init = f.core.eventsSince(0).events.filter(x => x.type === 'sdk' && x.json.type === 'system_init');
  assert.equal(init.length, 1);
  f.adapter.emit(f.iid, 'system_init', { capabilities: [] });
  assert.equal(f.state().incarnations[0].close_after_turn, 0);
  assert.equal(f.prompt().state, 'completed'); assert.equal(f.adapter.log.received.length, 3);
});

test('R1-16 WAL writer between snapshot state and seq is visible in snapshot or replay, never lost', t => {
  const readHooks = {}; const f = fixture(t, { readHooks }); f.start(); let inserted;
  readHooks.afterState = () => {
    delete readHooks.afterState;
    const db = new Database(f.dbPath);
    db.transaction(() => {
      db.prepare('UPDATE owned_sessions SET title=? WHERE id=?').run('concurrent-title', f.sid);
      inserted = Number(db.prepare('INSERT INTO events(session_id,type,json,created_at) VALUES(?,?,?,?)').run(f.sid, 'test_writer', '{}', f.time).lastInsertRowid);
    })(); db.close();
  };
  const snap = f.core.snapshot(f.sid); assert.ok(inserted);
  const replay = f.core.eventsSince(snap.seq_high);
  assert.ok(snap.state.session.title === 'concurrent-title' || replay.events.some(x => x.seq === inserted));
});
