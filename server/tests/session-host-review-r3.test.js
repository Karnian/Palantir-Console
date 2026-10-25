'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');

for (const kind of ['tool_decision', 'question_answer']) for (const disruption of ['interrupt', 'abort', 'exit']) {
  test(`R3-01 unknown ${kind} tainted by ${disruption} cannot become observed on normal tool result`, t => {
    const f = fixture(t, { manualTools: true }); f.start();
    const name = kind === 'question_answer' ? 'AskUserQuestion' : 'Bash';
    const body = kind === 'question_answer' ? { answer: 'yes' } : { behavior: 'allow' };
    f.adapter.toolRequest(f.iid, 'baseline', name);
    const baseline = f.core.submit(f.req(kind, { target_tool_use_id: 'baseline', body }));
    f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'baseline', is_error: false, content: kind === 'question_answer' ? 'yes' : 'ok' });
    assert.equal(f.d(baseline.id).state, 'provider_observed');
    const controller = f.adapter.toolRequest(f.iid, 'unknown', name);
    const decide = f.adapter.decide;
    f.adapter.decide = (...args) => { decide(...args); throw new Error('ambiguous_effect'); };
    const d = f.core.submit(f.req(kind, { target_tool_use_id: 'unknown', body }));
    assert.equal(d.state, 'unknown');
    if (disruption === 'interrupt') f.core.submit(f.req('interrupt'));
    else if (disruption === 'abort') controller.abort();
    else f.adapter.exit(f.iid);
    f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'unknown', is_error: false, content: kind === 'question_answer' ? 'yes' : 'ok' });
    assert.equal(f.d(d.id).tainted, 1);
    assert.equal(f.d(d.id).state, 'unknown'); assert.equal(f.d(d.id).reason, 'tool_finished');
    assert.equal(f.adapter.log.decisions.length, 2);
    assert.equal(f.adapter.log.executions.length, kind === 'tool_decision' ? 2 : 0);
  });
}

test('R3-02 stop accepted before delayed missing init remains active after exit and can resume', t => {
  const f = fixture(t, { late: true, manual: true, noExit: true }); f.start(); f.prompt();
  const req = f.req('stop'); const stop = f.core.submit(req);
  assert.equal(stop.state, 'accepted'); assert.equal(stop.stage, 'close_sent');
  f.adapter.emit(f.iid, 'system_init', { capabilities: [] });
  assert.equal(f.state().incarnations[0].close_after_turn, 1);
  assert.equal(f.state().controls.filter(c => c.reason === 'capability_missing').length, 0);
  f.adapter.exit(f.iid);
  assert.equal(f.core.submit(req).state, 'done'); assert.equal(f.state().session.state, 'active');
  assert.equal(f.state().controls.filter(c => c.reason === 'capability_missing').length, 0);
  const resumed = f.core.submit(f.req('resume')); assert.equal(resumed.state, 'done'); f.iid = resumed.incarnation_id;
  assert.equal(f.state().incarnations.at(-1).close_after_turn, 0);
  f.adapter.options.late = false; f.adapter.options.manual = false; f.adapter.options.capabilities = [];
  f.prompt();
  assert.equal(f.state().controls.filter(c => c.reason === 'capability_missing').length, 1);
  assert.equal(f.adapter.log.closes.length, 2); assert.equal(f.adapter.log.starts.length, 2);
});

for (const otherCause of [false, true]) test(`R3-03 target result clears interrupt effect barrier only, otherCause=${otherCause}`, t => {
  const f = fixture(t, { manual: true, manualTools: true, noReceipt: true }); f.start(); const p = f.prompt();
  if (otherCause) {
    f.adapter.toolRequest(f.iid, 'other'); const decide = f.adapter.decide;
    f.adapter.decide = (...args) => { decide(...args); throw new Error('ambiguous_tool'); };
    f.core.submit(f.req('tool_decision', { target_tool_use_id: 'other', body: { behavior: 'allow' } }));
  }
  const interrupt = f.adapter.interrupt;
  f.adapter.interrupt = (...args) => { interrupt(...args); throw new Error('ambiguous_interrupt'); };
  const d = f.core.submit(f.req('interrupt')); assert.equal(d.state, 'unknown');
  assert.equal(f.d(d.id).attribution_pending, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: ['wrong'], is_error: true, subtype: 'error_during_execution' });
  assert.equal(f.d(d.id).attribution_pending, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  assert.equal(f.d(d.id).state, 'completed'); assert.equal(f.d(d.id).attribution_pending, 0);
  assert.equal(f.state().incarnations[0].attribution_uncertain, otherCause ? 2 : 0);
  if (otherCause) {
    f.adapter.emit(f.iid, 'tool_result', { tool_use_id: 'other', is_error: false, content: 'ok' });
    assert.equal(f.state().incarnations[0].attribution_uncertain, 0);
  }
  assert.equal(f.adapter.log.interrupts.length, 1);
});

test('R3-03 completed interrupt result cannot release an existing permanent barrier', t => {
  const f = fixture(t, { manual: true, noReceipt: true }); f.start(); const p = f.prompt();
  const interrupt = f.adapter.interrupt;
  f.adapter.interrupt = (...args) => { interrupt(...args); throw new Error('ambiguous_interrupt'); };
  const d = f.core.submit(f.req('interrupt'));
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: true, subtype: 'error_during_execution' });
  f.adapter.emit(f.iid, 'interrupt_receipt', { interrupt_id: d.id, still_queued: ['survivor'] });
  assert.equal(f.d(d.id).state, 'completed'); assert.equal(f.d(d.id).attribution_pending, 0);
  assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
  f.adapter.emit(f.iid, 'result', { user_message_uuids: [p.message_uuid], is_error: false });
  assert.equal(f.state().incarnations[0].attribution_uncertain, 1);
  assert.equal(f.prompt().state, 'rejected'); assert.equal(f.adapter.log.received.length, 1);
});
