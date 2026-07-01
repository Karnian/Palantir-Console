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
