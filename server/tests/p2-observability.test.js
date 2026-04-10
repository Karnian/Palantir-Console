// P2-3 / P2-4: observability round.
//
// P2-3 is locked by sse-channels.test.js (static assertion against
// hooks.js). This file covers the P2-4 derivePmProjectId diagnostic
// hook — a pure observability addition that does not change return
// behavior but surfaces drift between the JOIN-derived project id and
// the conversation_id 'pm:<id>' path.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePmProjectId,
  setDerivePmProjectIdDiagnostics,
} = require('../services/runService');

test('P2-4: derivePmProjectId returns joinPid when only JOIN is present', () => {
  const run = { id: 'r1', project_id: 'proj_a', manager_layer: null, conversation_id: null };
  assert.equal(derivePmProjectId(run), 'proj_a');
});

test('P2-4: derivePmProjectId returns parsed pid when only conversation_id is present', () => {
  const run = {
    id: 'r2',
    project_id: null,
    manager_layer: 'pm',
    conversation_id: 'pm:proj_b',
  };
  assert.equal(derivePmProjectId(run), 'proj_b');
});

test('P2-4: derivePmProjectId prefers JOIN path when both agree', () => {
  const run = {
    id: 'r3',
    project_id: 'proj_c',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_c',
  };
  assert.equal(derivePmProjectId(run), 'proj_c');
});

test('P2-4: derivePmProjectId fires diagnostic hook on mismatch and still returns JOIN pid', (t) => {
  const received = [];
  setDerivePmProjectIdDiagnostics((payload) => received.push(payload));
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  const run = {
    id: 'r4',
    project_id: 'proj_join',
    manager_layer: 'pm',
    conversation_id: 'pm:proj_other',
  };
  const result = derivePmProjectId(run);
  assert.equal(result, 'proj_join', 'JOIN path is authoritative even on mismatch');
  assert.equal(received.length, 1, 'diagnostic fired exactly once');
  assert.equal(received[0].runId, 'r4');
  assert.equal(received[0].joinPid, 'proj_join');
  assert.equal(received[0].parsedPid, 'proj_other');
  assert.equal(received[0].conversationId, 'pm:proj_other');
});

test('P2-4: derivePmProjectId does NOT fire diagnostic when only one source is present', (t) => {
  const received = [];
  setDerivePmProjectIdDiagnostics((payload) => received.push(payload));
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  derivePmProjectId({ id: 'r5', project_id: 'p', manager_layer: null });
  derivePmProjectId({ id: 'r6', project_id: null, manager_layer: 'pm', conversation_id: 'pm:p' });
  derivePmProjectId({ id: 'r7', project_id: null, manager_layer: null });

  assert.equal(received.length, 0, 'no diagnostic when sources cannot disagree');
});

test('P2-4: derivePmProjectId tolerates a throwing diagnostic hook', (t) => {
  setDerivePmProjectIdDiagnostics(() => { throw new Error('hook exploded'); });
  t.after(() => setDerivePmProjectIdDiagnostics(null));

  const run = {
    id: 'r8',
    project_id: 'a',
    manager_layer: 'pm',
    conversation_id: 'pm:b',
  };
  // Must not propagate the hook's throw.
  const result = derivePmProjectId(run);
  assert.equal(result, 'a');
});

test('P2-4: derivePmProjectId handles null / malformed runs without throwing', () => {
  assert.equal(derivePmProjectId(null), null);
  assert.equal(derivePmProjectId(undefined), null);
  assert.equal(derivePmProjectId({}), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'pm:' }), null);
  assert.equal(derivePmProjectId({ manager_layer: 'pm', conversation_id: 'notpm:x' }), null);
});
