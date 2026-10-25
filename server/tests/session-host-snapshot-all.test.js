'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');
function history(f, count, body = '"done"', unknown = false) {
  const db = new Database(f.dbPath);
  const insert = db.prepare(`INSERT INTO deliveries
    (id,session_id,incarnation_id,kind,body,request_key,fingerprint,state,outcome,reason,attribution_pending,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'hash',?,?,?,?,0,0)`);
  db.transaction(() => {
    if (unknown) {
      insert.run('unknown-prompt', f.sid, f.iid, 'prompt', body, 'unknown-prompt-key', 'unknown', null, 'effect_failed', 1);
      insert.run('unknown-interrupt', f.sid, f.iid, 'interrupt', null, 'unknown-interrupt-key', 'unknown', null, 'interrupt_unconfirmed', 1);
    }
    for (let n = 0; n < count; n++) {
      insert.run('finished-' + n, f.sid, f.iid, 'prompt', body, 'finished-key-' + n, 'completed', 'completed', null, 0);
    }
  })();
  db.close();
}
test('R8 snapshot retains all 300 terminal deliveries and older unknown prompt and interrupt', t => {
  const f = fixture(t); f.start(); history(f, 300, '"done"', true);
  const snapshot = f.core.snapshot(f.sid);
  assert.equal(snapshot.state.deliveries.length, 302);
  assert.equal(snapshot.state.deliveries[0].attribution_pending, 1);
  assert.equal(snapshot.state.deliveries[1].reason, 'interrupt_unconfirmed');
  assert.equal(Object.hasOwn(snapshot, 'more'), false);
});
test('R8 all large delivery previews shrink to the injected budget with exact UTF-8 byte metadata', t => {
  const budget = 512 * 1024;
  const f = fixture(t, { snapshotMaxBytes: budget }); f.start();
  const body = JSON.stringify('가🙂'.repeat(2000)); history(f, 300, body);
  const snapshot = f.core.snapshot(f.sid);
  assert.equal(snapshot.state.deliveries.length, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= budget);
  for (const row of snapshot.state.deliveries) {
    assert.equal(row.body_bytes, Buffer.byteLength(body));
    assert.equal(row.body_truncated, Buffer.byteLength(row.body) < row.body_bytes);
    assert.ok(Buffer.byteLength(row.body) < 4096);
    assert.equal(row.body.includes('\ufffd'), false);
    assert.equal(f.core.chunk(f.sid, 'delivery_body', row.id, 0).data, body);
  }
});
test('R8 metadata overflow reports snapshot_too_large without dropping or deleting rows', t => {
  const f = fixture(t, { snapshotMaxBytes: 4096 }); f.start(); history(f, 50);
  assert.throws(() => f.core.snapshot(f.sid), { code: 'snapshot_too_large' });
  const db = new Database(f.dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliveries').get().n, 50); db.close();
  assert.equal(f.core.listSessions().sessions.length, 1);
});
