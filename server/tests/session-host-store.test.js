'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { fixture } = require('./helpers/session-host-fixture');

test('§4.1 independent WAL schema, snapshot seq and replay insertion have no gap', t => {
  const f = fixture(t); f.start();
  const db = new Database(f.dbPath);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.prepare('SELECT version FROM host_schema_versions').get().version, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('owned_sessions','incarnations','deliveries','tool_requests','control_requests','events','request_tombstones')").get().n, 7);
  const snap = f.core.snapshot(f.sid); f.prompt();
  const replay = f.core.eventsSince(snap.seq_high);
  assert.ok(replay.events.length > 0);
  assert.equal(replay.events[0].seq, snap.seq_high + 1);
  assert.ok(replay.events.some(e => e.type === 'sdk'));
  assert.ok(replay.events.some(e => e.type === 'transition'));
  assert.equal(new Set(replay.events.map(e => e.seq)).size, replay.events.length);
  db.close();
});

test('§8.1 DB write failure refuses new send and new execution (provider spies cover both)', t => {
  const f = fixture(t); f.start(); f.prompt();
  assert.equal(f.adapter.log.starts.length, 1); assert.equal(f.adapter.log.received.length, 1);
  const old = f.faults.hit.bind(f.faults);
  f.faults.hit = point => { if (point === 'db_write') throw new Error('disk_full'); old(point); };
  assert.throws(() => f.prompt(), /disk_full/);
  assert.throws(() => f.core.submit({ request_key: f.key(), kind: 'start' }), /storage_unavailable/);
  assert.equal(f.adapter.log.starts.length, 1); assert.equal(f.adapter.log.received.length, 1);
});
