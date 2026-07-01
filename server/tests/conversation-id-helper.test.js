'use strict';

// PM→Operator rename Phase 0 — shared conversation-id helpers + dual-read.
// Producers still emit `pm:`; consumers accept BOTH `pm:` and `operator:`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  conversationIdForProject,
  parseProjectConversationId,
  isProjectConversationId,
  conversationIdMatchesProject,
  isProjectLayer,
  canonicalConversationId,
  LEGACY_PM_CONV_PREFIX,
  OPERATOR_CONV_PREFIX,
} = require('../utils/conversationId');

test('conversationIdForProject: Phase 0 still emits legacy pm: (producer seam)', () => {
  assert.equal(conversationIdForProject('alpha'), 'pm:alpha');
});

test('parseProjectConversationId: dual-read pm: AND operator:', () => {
  assert.deepEqual(parseProjectConversationId('pm:alpha'), { projectId: 'alpha' });
  assert.deepEqual(parseProjectConversationId('operator:alpha'), { projectId: 'alpha' });
  // empty projectId → null (preserves parseConversationId('pm:')===null contract)
  assert.equal(parseProjectConversationId('pm:'), null);
  assert.equal(parseProjectConversationId('operator:'), null);
  // non-project ids → null
  assert.equal(parseProjectConversationId('top'), null);
  assert.equal(parseProjectConversationId('worker:r1'), null);
  assert.equal(parseProjectConversationId(''), null);
  assert.equal(parseProjectConversationId(null), null);
  assert.equal(parseProjectConversationId(42), null);
});

test('isProjectConversationId: both prefixes true, others false', () => {
  assert.equal(isProjectConversationId('pm:x'), true);
  assert.equal(isProjectConversationId('operator:x'), true);
  assert.equal(isProjectConversationId('pm:'), false);
  assert.equal(isProjectConversationId('top'), false);
});

test('conversationIdMatchesProject: dual-read equality (replaces inline pm: compare)', () => {
  assert.equal(conversationIdMatchesProject('pm:alpha', 'alpha'), true);
  assert.equal(conversationIdMatchesProject('operator:alpha', 'alpha'), true);
  assert.equal(conversationIdMatchesProject('pm:beta', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('operator:beta', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('top', 'alpha'), false);
  assert.equal(conversationIdMatchesProject('pm:', 'alpha'), false);
});

test('isProjectLayer: pm AND operator are the project-operator role', () => {
  assert.equal(isProjectLayer('pm'), true);
  assert.equal(isProjectLayer('operator'), true);
  assert.equal(isProjectLayer('top'), false);
  assert.equal(isProjectLayer(null), false);
  assert.equal(isProjectLayer(undefined), false);
});

test('prefix constants are the expected wire values', () => {
  assert.equal(LEGACY_PM_CONV_PREFIX, 'pm:');
  assert.equal(OPERATOR_CONV_PREFIX, 'operator:');
});

// Dual-read at the routerService chokepoint (constructed with a stub projectService).
test('routerService.isValidConversationId accepts operator: (dual-read chokepoint 2)', () => {
  const { createRouterService } = require('../services/routerService');
  const svc = createRouterService({ projectService: { listProjects: () => [] } });
  assert.equal(svc.isValidConversationId('pm:alpha'), true);
  assert.equal(svc.isValidConversationId('operator:alpha'), true);
  assert.equal(svc.isValidConversationId('operator:'), false);
  assert.equal(svc.isValidConversationId('top'), true);
  assert.equal(svc.isValidConversationId('worker:r1'), true);
});

test('canonicalConversationId: collapses pm:/operator: to the current producer form (Phase 0 = pm:)', () => {
  assert.equal(canonicalConversationId('pm:alpha'), 'pm:alpha');
  assert.equal(canonicalConversationId('operator:alpha'), 'pm:alpha'); // canonical = producer form
  assert.equal(canonicalConversationId('top'), 'top');
  assert.equal(canonicalConversationId('worker:r1'), 'worker:r1');
  assert.equal(canonicalConversationId('pm:'), 'pm:'); // non-project (empty) passes through
});

test('managerRegistry: slots are canonical — pm: and operator: address the SAME slot', () => {
  const { createManagerRegistry } = require('../services/managerRegistry');
  const reg = createManagerRegistry({ runService: { getRun: (id) => ({ id }) } });
  const adapter = { isSessionAlive: () => true, disposeSession() {} };
  reg.setActive('operator:alpha', 'run1', adapter); // written in the NEW form
  // found via BOTH forms (the dual-read window's core guarantee):
  assert.equal(reg.getActiveRunId('pm:alpha'), 'run1');
  assert.equal(reg.getActiveRunId('operator:alpha'), 'run1');
  assert.ok(reg.getActiveAdapter('pm:alpha'));
  // snapshot exposes the canonical (Phase 0 = pm:) form — what /api/manager/status
  // and therefore the UI sees, unchanged through Phase 1 (UI flip is Phase 2).
  const snap = reg.snapshot();
  assert.equal(snap.pms.length, 1);
  assert.equal(snap.pms[0].conversationId, 'pm:alpha');
  reg.clearActive('pm:alpha'); // clear via the OTHER form also hits the slot
  assert.equal(reg.getActiveRunId('operator:alpha'), null);
});
