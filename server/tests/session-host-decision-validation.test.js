'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/session-host-fixture');
for (const answer of [{ Choice: 'A' }, { 'Which?': '' }, { 'Which?': '  ' }, { 'Which?': 3 },
  { 'Which?': 'A', Extra: 'B' }, {}, [], null, '']) {
  test('R5 admission rejects malformed answer without creating a delivery: ' + JSON.stringify(answer), t => {
    const f = fixture(t); f.start();
    f.adapter.toolRequest(f.iid, 'question', 'AskUserQuestion', { questions: [{ question: 'Which?' }] });
    const before = f.state().deliveries.length;
    const request = f.req('question_answer', { target_tool_use_id: 'question', body: { answer } });
    const rejected = f.core.submitWithReceipt(request);
    assert.equal(rejected.durable, false); assert.equal(rejected.code, 'invalid_answer');
    assert.equal(f.state().deliveries.length, before); assert.equal(f.state().tool_requests[0].state, 'pending');
    assert.equal(f.adapter.log.decisions.length, 0);
    const good = f.core.submit({ ...request, body: { answer: 'A' } });
    assert.equal(good.state, 'provider_observed'); assert.equal(f.adapter.log.decisions.length, 1);
  });
}
for (const body of [undefined, {}, { behavior: 'answer', answer: 'A' }, { behavior: 'allow', message: 3 }]) {
  test('R5 malformed tool decision never defaults to allow: ' + JSON.stringify(body), t => {
    const f = fixture(t); f.start(); f.adapter.toolRequest(f.iid, 'tool');
    const request = f.req('tool_decision', { target_tool_use_id: 'tool', body });
    const receipt = f.core.submitWithReceipt(request);
    assert.equal(receipt.durable, false); assert.equal(receipt.code, 'invalid_decision');
    assert.equal(f.state().deliveries.length, 0); assert.equal(f.state().tool_requests[0].state, 'pending');
    assert.equal(f.adapter.log.executions.length, 0);
    assert.equal(f.core.submit({ ...request, body: { behavior: 'allow' } }).state, 'provider_observed');
  });
}
