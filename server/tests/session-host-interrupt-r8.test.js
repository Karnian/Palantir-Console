'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

function finish(f, prompt, result = true, lifecycle = 'completed') {
  if (result) f.adapter.emit(f.iid, 'result', { user_message_uuids: [prompt.message_uuid], is_error: false });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: prompt.message_uuid, state: lifecycle });
}

test('R8 late A interrupt completes from A result; B gets a new provider effect and can be interrupted', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const first = f.prompt('A');
  finish(f, first);
  const old = f.core.submit(f.req('interrupt'));
  assert.equal(f.d(old.id).state, 'completed');
  const second = f.prompt('B');
  const interrupt = f.core.submit(f.req('interrupt'));
  assert.notEqual(interrupt.id, old.id);
  assert.equal(interrupt.turn_gen, second.turn_gen);
  assert.equal(f.adapter.log.interrupts.length, 2);
  const duplicate = f.core.submit(f.req('interrupt'));
  assert.equal(duplicate.id, interrupt.id);
  assert.equal(f.adapter.log.interrupts.length, 2);
  f.adapter.emit(f.iid, 'result', {
    user_message_uuids: [second.message_uuid], is_error: true, subtype: 'error_during_execution'
  });
  f.adapter.emit(f.iid, 'lifecycle', { command_uuid: second.message_uuid, state: 'cancelled' });
  assert.equal(f.d(interrupt.id).state, 'completed');
  assert.equal(f.d(second.id).outcome, 'interrupted');
  assert.equal(f.core.idle(f.sid), true);
});

for (const lifecycle of ['completed', 'cancelled']) {
  test('R8 ' + lifecycle + ' without result keeps the unknown barrier until its own result', t => {
    const f = fixture(t, { manual: true, noReceipt: true });
    f.start();
    const prompt = f.prompt();
    const interrupt = f.core.submit(f.req('interrupt'));
    finish(f, prompt, false, lifecycle);
    assert.equal(f.d(interrupt.id).state, 'unknown');
    assert.equal(f.state().incarnations[0].interrupt_unknown, 1);
    f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: [] });
    assert.equal(f.d(interrupt.id).state, 'unknown');
    assert.equal(f.prompt().state, 'rejected');
    f.adapter.emit(f.iid, 'result', { user_message_uuids: [prompt.message_uuid], is_error: false });
    assert.equal(f.d(interrupt.id).state, 'completed');
    assert.equal(f.state().incarnations[0].interrupt_unknown, 0);
    f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: [] });
    assert.equal(f.d(interrupt.id).state, 'completed');
    assert.equal(f.state().incarnations[0].interrupt_unknown, 0);
    assert.equal(f.state().incarnations[0].attribution_uncertain, 0);
  });
}

test('R8 an observed receipt alone cannot complete an ended turn without its result', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const prompt = f.prompt();
  const interrupt = f.core.submit(f.req('interrupt'));
  assert.equal(interrupt.state, 'provider_observed');
  finish(f, prompt, false);
  assert.equal(f.d(interrupt.id).state, 'unknown');
  assert.equal(f.state().incarnations[0].interrupt_unknown, 1);
});

test('R8 a previous generation legacy interrupt is never an alias target for the live turn', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const first = f.prompt('A');
  finish(f, first);
  const old = f.core.submit(f.req('interrupt'));
  const second = f.prompt('B');
  // Reproduce a persisted pre-fix row, while the current turn already has a different generation.
  const Database = require('better-sqlite3');
  const database = new Database(f.dbPath);
  database.prepare("UPDATE deliveries SET state='provider_observed' WHERE id=?").run(old.id);
  database.close();
  const interrupt = f.core.submit(f.req('interrupt'));
  assert.notEqual(interrupt.id, old.id);
  assert.equal(interrupt.turn_gen, second.turn_gen);
  assert.equal(f.adapter.log.interrupts.length, 2);
});

test('R8 old result cannot clear a newer timed-out interrupt barrier after a late receipt', t => {
  const f = fixture(t, { manual: true, noReceipt: true });
  f.start();
  const old = f.prompt('old');
  finish(f, old, false);
  const current = f.prompt('current');
  const interrupt = f.core.submit(f.req('interrupt'));
  f.advance(10000);
  f.core.tick();
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: [] });
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [old.message_uuid], is_error: false });
  assert.equal(f.state().incarnations[0].interrupt_unknown, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [current.message_uuid], is_error: false });
  assert.equal(f.state().incarnations[0].interrupt_unknown, 0);
  assert.equal(f.d(interrupt.id).state, 'completed');
});

test('R8 tick settles a persisted pre-fix interrupt from its already observed result', t => {
  const f = fixture(t, { manual: true });
  f.start();
  const prompt = f.prompt();
  finish(f, prompt);
  const interrupt = f.core.submit(f.req('interrupt'));
  const Database = require('better-sqlite3');
  const database = new Database(f.dbPath);
  database.prepare("UPDATE deliveries SET state='provider_observed' WHERE id=?").run(interrupt.id);
  database.close();
  f.core.tick();
  assert.equal(f.d(interrupt.id).state, 'completed');
});
