'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
const { SimulatedCrash } = require('../sessionHost/faults');

async function submit(f, request) {
  const accepted = f.core.submit(request);
  await f.settle();
  return f.core.lookup(accepted.request_key);
}
async function start(f) {
  const accepted = f.start();
  await f.settle();
  return f.core.lookup(accepted.request_key);
}

for (const async of [false, true]) {
  const mode = async ? 'async' : 'sync';
  test(`S1-b2a ${mode} adapter returns values and initialization at the contracted time`, async t => {
    const f = fixture(t, { async });
    const settings = f.adapter.checkSettings('/work');
    assert.equal(typeof settings?.then === 'function', async);
    let initialized = false;
    f.adapter.events.on('event', event => { if (event.type === 'initialization') initialized = true; });
    const accepted = f.start();
    assert.equal(initialized, !async);
    assert.equal(accepted.state, async ? 'accepted' : 'done');
    await f.settle();
    assert.equal(f.core.lookup(accepted.request_key).state, 'done');
    assert.equal(typeof f.adapter.accountInfo(f.iid)?.then === 'function', async);
    assert.equal(f.core.idle(f.sid), true);
  });

  test(`S1-b2a ${mode} normal 20 prompts and 10 approvals preserve exact evidence`, async t => {
    const f = fixture(t, { async });
    assert.equal((await start(f)).state, 'done');
    for (let n = 0; n < 20; n++) {
      const delivery = await submit(f, f.req('prompt', { body: `prompt-${n}` }));
      assert.equal(delivery.state, 'completed');
      assert.equal(delivery.outcome, 'completed');
    }
    for (let n = 0; n < 10; n++) {
      f.adapter.toolRequest(f.iid, `tool-${n}`);
      assert.equal((await submit(f, f.req('tool_decision', {
        target_tool_use_id: `tool-${n}`, body: { behavior: 'allow' }
      }))).state, 'provider_observed');
    }
    assert.equal(f.adapter.log.received.length, 20);
    assert.equal(f.adapter.log.executions.length, 10);
    assert.equal(f.state().deliveries.filter(delivery => delivery.state === 'unknown').length, 0);
  });

  for (const point of ['after_sending_commit', 'after_effect_before_written', 'before_accepted_reply']) {
    test(`S1-b2a ${mode} crash ${point} never retransmits`, async t => {
      const f = fixture(t, { async, drop: true });
      await start(f);
      const baseline = await submit(f, f.req('prompt', { body: 'baseline' }));
      f.adapter.emit(f.iid, 'lifecycle', { command_uuid: baseline.message_uuid, state: 'completed' });
      const request = f.req('prompt', { body: 'crash' });
      f.faults.arm(point);
      await assert.rejects(submit(f, request), SimulatedCrash);
      const count = f.adapter.log.received.length;
      assert.equal(count, point === 'after_sending_commit' || (async && point === 'before_accepted_reply') ? 1 : 2);
      f.reboot().recover();
      const recovered = f.core.submit(request);
      assert.equal(recovered.state, async && point === 'before_accepted_reply' ? 'expired' : 'unknown');
      assert.equal(f.adapter.log.received.length, count);
      assert.equal(f.state().incarnations[0].state, 'orphaned');
    });
  }

  test(`S1-b2a ${mode} interrupt receipt correlates and blocks replay`, async t => {
    const f = fixture(t, { async, manual: true, noReceipt: true });
    await start(f);
    const prompt = await submit(f, f.req('prompt'));
    const request = f.req('interrupt');
    const interrupt = await submit(f, request);
    assert.equal(interrupt.state, 'written');
    f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: 'other', still_queued: [] });
    assert.equal(f.d(interrupt.id).state, 'written');
    f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: interrupt.id, still_queued: [] });
    assert.equal(f.d(interrupt.id).state, 'provider_observed');
    assert.equal(f.core.submit(request).id, interrupt.id);
    f.adapter.emit(f.iid, 'result', { user_message_uuids: [prompt.message_uuid], is_error: true, subtype: 'error_during_execution' });
    assert.equal(f.d(interrupt.id).state, 'completed');
    assert.equal(f.adapter.log.interrupts.length, 1);
  });

  test(`S1-b2a ${mode} stop then resume preserves conversation and close prevents resume`, async t => {
    const f = fixture(t, { async });
    await start(f);
    await submit(f, f.req('prompt'));
    const conversation = f.state().session.claude_session_id;
    assert.equal((await submit(f, f.req('stop'))).state, 'done');
    assert.equal(f.state().session.state, 'active');
    const resumed = await submit(f, f.req('resume'));
    assert.equal(resumed.state, 'done');
    f.iid = resumed.incarnation_id;
    assert.equal(f.adapter.log.startRequests[1].claude_session_id, conversation);
    await submit(f, f.req('prompt'));
    assert.equal(f.adapter.log.received.length, 2);
    assert.equal((await submit(f, f.req('close'))).state, 'done');
    assert.equal((await submit(f, f.req('resume'))).state, 'rejected');
    assert.equal(f.adapter.log.starts.length, 2);
  });
}
