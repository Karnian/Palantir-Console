'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');
function cards(f, count, state, text = '가🙂'.repeat(1000)) {
  const db = new Database(f.dbPath);
  const input = n => JSON.stringify({ text, index: n });
  const insert = db.prepare('INSERT INTO tool_requests(id,incarnation_id,tool_use_id,tool_name,input,state) VALUES(?,?,?,?,?,?)');
  db.transaction(() => { for (let n = 0; n < count; n++) insert.run('card-' + n, f.iid, 'use-' + n, 'Bash', input(n), state); })();
  db.close(); return input;
}
for (const state of ['pending', 'decided']) {
  test('R7 snapshot includes all 200 ' + state + ' approvals and every original input is recoverable', t => {
    const f = fixture(t); f.start(); const input = cards(f, 200, state);
    const snapshot = f.core.snapshot(f.sid);
    assert.equal(snapshot.state.tool_requests.length, 200);
    assert.equal(snapshot.more.tool_requests, false);
    assert.deepEqual(snapshot.state.tool_requests.map(row => row.id), Array.from({ length: 200 }, (_, n) => 'card-' + n));
    for (let n = 0; n < 200; n++) {
      const row = snapshot.state.tool_requests[n];
      assert.equal(row.input_truncated, true); assert.ok(Buffer.byteLength(row.input) <= 4096);
      assert.equal(row.input_bytes, Buffer.byteLength(input(n)));
      assert.equal(f.core.chunk(f.sid, 'tool_input', row.id, 0).data, input(n));
    }
  });
}
test('R7 terminal approval history remains capped with more=true', t => {
  const f = fixture(t); f.start(); cards(f, 200, 'expired');
  const snapshot = f.core.snapshot(f.sid);
  assert.equal(snapshot.state.tool_requests.length, 128); assert.equal(snapshot.more.tool_requests, true);
  assert.equal(snapshot.state.tool_requests[0].id, 'card-72');
});
test('R7 excessive pending previews shrink without dropping any approval or exceeding snapshot budget', t => {
  const f = fixture(t); f.start(); cards(f, 2100, 'pending');
  const snapshot = f.core.snapshot(f.sid);
  assert.equal(snapshot.state.tool_requests.length, 2100); assert.equal(snapshot.more.tool_requests, false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 8 * 1024 * 1024);
  assert.ok(snapshot.state.tool_requests.some(row => Buffer.byteLength(row.input) < 4096));
  assert.ok(snapshot.state.tool_requests.every(row => !row.input.includes('\ufffd') && row.input_bytes > 4096));
});
test('R7 unresolved deliveries and an older accepted control survive newer terminal history', t => {
  const f = fixture(t); f.start(); const db = new Database(f.dbPath);
  const delivery = db.prepare(`INSERT INTO deliveries(id,session_id,incarnation_id,kind,body,request_key,fingerprint,state,outcome,created_at,updated_at)
    VALUES(?,?,?,'prompt','"hello"',?,'hash',?,?,0,0)`);
  const control = db.prepare(`INSERT INTO control_requests(request_key,fingerprint,kind,session_id,stage,state,created_at,updated_at)
    VALUES(?,'hash','stop',?,'requested',?,0,0)`);
  db.transaction(() => {
    control.run('accepted-control', f.sid, 'accepted');
    for (let n = 0; n < 200; n++) {
      delivery.run('ongoing-' + n, f.sid, f.iid, 'ongoing-key-' + n, ['queued', 'sending', 'written', 'provider_observed'][n % 4], null);
    }
    for (let n = 0; n < 200; n++) {
      delivery.run('finished-' + n, f.sid, f.iid, 'finished-key-' + n, 'completed', 'completed');
      control.run('finished-control-' + n, f.sid, 'done');
    }
  })(); db.close();
  const snapshot = f.core.snapshot(f.sid);
  assert.equal(snapshot.state.deliveries.filter(row => row.id.startsWith('ongoing-')).length, 200);
  assert.equal(snapshot.state.deliveries.filter(row => row.id.startsWith('finished-')).length, 128);
  assert.ok(snapshot.state.controls.some(row => row.request_key === 'accepted-control'));
  assert.equal(snapshot.more.deliveries, true); assert.equal(snapshot.more.controls, true);
});

test('R7 metadata alone beyond wire budget fails explicitly instead of silently omitting approvals', t => {
  const f = fixture(t); f.start(); cards(f, 2100, 'pending', 'small input');
  const db = new Database(f.dbPath);
  db.prepare('UPDATE tool_requests SET tool_name=?').run('x'.repeat(4096));
  assert.throws(() => f.core.snapshot(f.sid), { code: 'snapshot_too_large' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tool_requests WHERE state='pending'").get().n, 2100);
  assert.equal(f.core.listSessions().sessions.length, 1); db.close();
});
