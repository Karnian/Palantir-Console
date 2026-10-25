'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const { fixture: httpFixture, request, COOKIE, TOKEN } = require('./helpers/session-hub-fixture.cjs');

test('transcript is reverse paged, session scoped, bounded previews with full chunk refs', t => {
  const f = fixture(t); f.start();
  const other = f.core.submit({ kind: 'start', request_key: f.key(), cwd: '/private/other' });
  for (let i = 0; i < 4; i++) f.adapter.events.emit('event', { type: 'sdk_message', incarnation_id: f.iid,
    message: { type: 'assistant', message: { content: [{ type: 'text', text: '한'.repeat(3000) + i }] } } });
  f.adapter.events.emit('event', { type: 'sdk_message', incarnation_id: other.incarnation_id, message: { secret: 'other' } });
  const first = f.core.transcript(f.sid, undefined, 2);
  assert.equal(first.events.length, 2); assert.ok(first.events[0].seq > first.events[1].seq);
  assert.equal(first.events[0].truncated, true);
  assert.ok(Buffer.byteLength(first.events[0].preview) <= 4096);
  assert.ok(!first.events[0].preview.includes('\ufffd'));
  const ref = first.events[0].ref;
  assert.match(f.core.chunk(f.sid, ref.source, ref.id_or_seq).data, /assistant/);
  assert.equal(f.core.chunk(other.session_id, ref.source, ref.id_or_seq).found, false);
  const second = f.core.transcript(f.sid, first.next_before_seq, 2);
  assert.equal(second.events.length, 2); assert.equal(second.next_before_seq, null);
  assert.ok(second.events[0].seq < first.events[1].seq);
  assert.deepEqual(f.core.transcript('absent').events, []);
  assert.throws(() => f.core.transcript(f.sid, -1), /invalid_request/);
  assert.throws(() => f.core.transcript(f.sid, undefined, 101), /invalid_request/);
});
test('transcript HTTP preserves cookie/origin checks and validates paging', async t => {
  const f = httpFixture(t), calls = [];
  const service = { transcript: async (...args) => { calls.push(args); return { events: [], next_before_seq: null }; }, shutdown() {} };
  const app = f.app({ ownedSessionService: service });
  const url = '/api/owned-sessions/sid/transcript';
  assert.equal((await request(app).get(url + '?before_seq=44&limit=2').set('Cookie', COOKIE)).status, 200);
  assert.deepEqual(calls[0], ['sid', 44, 2]);
  assert.equal((await request(app).get(url).set('Authorization', `Bearer ${TOKEN}`)).status, 403);
  assert.equal((await request(app).get(url).set('Cookie', COOKIE).set('Sec-Fetch-Site', 'cross-site')).status, 403);
  for (const query of ['limit=0', 'limit=101', 'before_seq=-1', 'before_seq=1.2']) {
    assert.equal((await request(app).get(url + '?' + query).set('Cookie', COOKIE)).status, 400);
  }
});
test('deleted session transcript is empty and capability verdict comes from host gate', async t => {
  const f = fixture(t); f.start();
  const incarnation = f.state().incarnations[0];
  assert.equal(incarnation.control_available, true);
  assert.equal(incarnation.capabilityVerdict.observe, 'supported');
  assert.equal(incarnation.capabilityVerdict.prompt, 'unknown');
  f.adapter.events.emit('event', { type: 'sdk_message', incarnation_id: f.iid, message: { type: 'assistant', text: 'delete me' } });
  assert.equal(f.core.transcript(f.sid).events.length, 1);
  f.core.submit(f.req('close')); await f.settle();
  f.core.submit(f.req('delete')); await f.settle();
  assert.deepEqual(f.core.transcript(f.sid).events, []);
});
