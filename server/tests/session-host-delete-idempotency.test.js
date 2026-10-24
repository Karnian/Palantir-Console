'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');

test('§8.1 request_key time: future six minutes rejected, 25h expired; existing key lookup precedes expiry', t => {
  const f = fixture(t); f.start(); const req = f.req('prompt'); f.core.submit(req);
  assert.equal(f.core.submit(f.req('prompt', { request_key: f.key(f.time + 360000) })).state, 'rejected');
  assert.equal(f.core.submit(f.req('prompt', { request_key: f.key(f.time - 25 * 3600000) })).state, 'expired');
  f.advance(2 * 86400000); assert.equal(f.core.submit(req).state, 'completed'); assert.equal(f.adapter.log.received.length, 1);
});

test('§8.1 active delete rejected; deleting crash resumes scrub, tombstone prevents replay after 30 days', t => {
  const f = fixture(t); f.start(); const req = f.req('prompt', { body: 'SECRET-BODY-UNIQUE' }); f.core.submit(req);
  f.adapter.toolRequest(f.iid, 't', 'Bash', { secret: 'SECRET-INPUT-UNIQUE' }); f.core.submit(f.req('tool_decision', { target_tool_use_id: 't' }));
  assert.equal(f.core.submit(f.req('delete')).state, 'rejected');
  f.core.submit(f.req('close')); const del = f.req('delete'); f.faults.arm('after_deleting_commit');
  assert.throws(() => f.core.submit(del), SimulatedCrash);
  f.reboot(); assert.equal(f.state().session.state, 'deleting'); f.core.recover();
  assert.equal(f.state().session.state, 'deleted'); assert.equal(f.core.submit(del).state, 'done');
  assert.equal(f.core.submit(req).session_deleted, 1); assert.equal(f.adapter.log.received.length, 1);
  const db = new Database(f.dbPath);
  assert.equal(db.prepare('SELECT count(*) n FROM deliveries').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM tool_requests').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM incarnations').get().n, 1);
  const retained = db.prepare('SELECT * FROM incarnations').get();
  assert.equal(retained.id, f.iid); assert.equal(retained.pid, null);
  assert.equal(retained.account_snapshot, null); assert.equal(retained.cli_path, null);
  assert.equal(db.prepare('SELECT cwd FROM owned_sessions WHERE id=?').get(f.sid).cwd, null);
  db.close();
  assert.equal(fs.readFileSync(f.dbPath).includes(Buffer.from('SECRET-BODY-UNIQUE')), false);
  assert.equal(fs.readFileSync(f.dbPath).includes(Buffer.from('SECRET-INPUT-UNIQUE')), false);
  assert.equal(f.core.eventsSince(0).snapshot_required, true);
  f.advance(31 * 86400000); f.reboot().recover();
  assert.equal(f.core.submit(req).state, 'expired'); assert.equal(f.adapter.log.received.length, 1);
});

test('§8.1 spawn error reason is fixed code, retained controls contain no cwd/error path after delete', t => {
  const f = fixture(t); f.start(); f.adapter.options.spawnError = '/secret/cli failure';
  const c = f.core.submit({ request_key: f.key(), kind: 'start', cwd: '/secret/cwd' });
  assert.equal(c.reason, 'spawn_failed'); f.sid = c.session_id; f.iid = c.incarnation_id;
  assert.equal(f.core.submit(f.req('close')).state, 'done'); f.core.submit(f.req('delete'));
  const db = new Database(f.dbPath); const rows = db.prepare('SELECT * FROM control_requests WHERE session_id=?').all(f.sid);
  assert.equal(JSON.stringify(rows).includes('/secret'), false); db.close(); assert.equal(f.adapter.log.starts.length, 2);
});
