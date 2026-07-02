'use strict';

// PM→Operator rename Phase 4 (FINAL CLEANUP) — shared conversation-id helpers.
// Dual-read removed: producers emit `operator:` and consumers accept
// `operator:` ONLY. The legacy `pm:` prefix and `'pm'` layer are no longer
// recognized.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  conversationIdForProject,
  parseProjectConversationId,
  isProjectConversationId,
  conversationIdMatchesProject,
  isProjectLayer,
  canonicalConversationId,
  OPERATOR_CONV_PREFIX,
} = require('../utils/conversationId');

test('conversationIdForProject: emits operator: (producer seam)', () => {
  assert.equal(conversationIdForProject('alpha'), 'operator:alpha');
});

test('parseProjectConversationId: operator: only (pm: no longer parses)', () => {
  assert.deepEqual(parseProjectConversationId('operator:alpha'), { projectId: 'alpha' });
  // legacy pm: is no longer a project conversation id
  assert.equal(parseProjectConversationId('pm:alpha'), null);
  // empty projectId → null (preserves parseConversationId('operator:')===null contract)
  assert.equal(parseProjectConversationId('operator:'), null);
  assert.equal(parseProjectConversationId('pm:'), null);
  // non-project ids → null
  assert.equal(parseProjectConversationId('top'), null);
  assert.equal(parseProjectConversationId('worker:r1'), null);
  assert.equal(parseProjectConversationId(''), null);
  assert.equal(parseProjectConversationId(null), null);
  assert.equal(parseProjectConversationId(42), null);
});

test('isProjectConversationId: operator: true, pm:/others false', () => {
  assert.equal(isProjectConversationId('operator:x'), true);
  assert.equal(isProjectConversationId('pm:x'), false);
  assert.equal(isProjectConversationId('operator:'), false);
  assert.equal(isProjectConversationId('top'), false);
});

test('conversationIdMatchesProject: operator: equality only (pm: no longer matches)', () => {
  assert.equal(conversationIdMatchesProject('operator:alpha', 'alpha'), true);
  assert.equal(conversationIdMatchesProject('pm:alpha', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('operator:beta', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('top', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('operator:', 'alpha'), false);
});

test('isProjectLayer: only operator is the project-operator role (pm rejected)', () => {
  assert.equal(isProjectLayer('operator'), true);
  assert.equal(isProjectLayer('pm'), false);
  assert.equal(isProjectLayer('top'), false);
  assert.equal(isProjectLayer(null), false);
  assert.equal(isProjectLayer(undefined), false);
});

test('prefix constant is the expected wire value', () => {
  assert.equal(OPERATOR_CONV_PREFIX, 'operator:');
});

// Dual-read at the routerService chokepoint (constructed with a stub projectService).
test('routerService.isValidConversationId accepts operator: only', () => {
  const { createRouterService } = require('../services/routerService');
  const svc = createRouterService({ projectService: { listProjects: () => [] } });
  assert.equal(svc.isValidConversationId('operator:alpha'), true);
  assert.equal(svc.isValidConversationId('pm:alpha'), false);
  assert.equal(svc.isValidConversationId('operator:'), false);
  assert.equal(svc.isValidConversationId('top'), true);
  assert.equal(svc.isValidConversationId('worker:r1'), true);
});

test('canonicalConversationId: identity for operator: (dual-read removed)', () => {
  assert.equal(canonicalConversationId('operator:alpha'), 'operator:alpha');
  // legacy pm: is no longer a project id → passes through unchanged (not collapsed)
  assert.equal(canonicalConversationId('pm:alpha'), 'pm:alpha');
  assert.equal(canonicalConversationId('top'), 'top');
  assert.equal(canonicalConversationId('worker:r1'), 'worker:r1');
  assert.equal(canonicalConversationId('operator:'), 'operator:'); // non-project (empty) passes through
});

test('managerRegistry: slots are keyed by operator: (pm: no longer addresses the slot)', () => {
  const { createManagerRegistry } = require('../services/managerRegistry');
  const reg = createManagerRegistry({ runService: { getRun: (id) => ({ id }) } });
  const adapter = { isSessionAlive: () => true, disposeSession() {} };
  reg.setActive('operator:alpha', 'run1', adapter); // written in the operator form
  // found via operator: ...
  assert.equal(reg.getActiveRunId('operator:alpha'), 'run1');
  assert.ok(reg.getActiveAdapter('operator:alpha'));
  // ... but NO LONGER found via the legacy pm: form (dual-read removed)
  assert.equal(reg.getActiveRunId('pm:alpha'), null);
  // snapshot exposes the operator: form — what /api/manager/status and the UI see.
  const snap = reg.snapshot();
  assert.equal(snap.pms.length, 1);
  assert.equal(snap.pms[0].conversationId, 'operator:alpha');
  reg.clearActive('operator:alpha');
  assert.equal(reg.getActiveRunId('operator:alpha'), null);
});
