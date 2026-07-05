const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DISPATCH_BLOCK_REASONS,
  explainDispatch,
} = require('../services/dispatchPolicy');

function executableNode(fields = {}) {
  return {
    id: 'node-a',
    reachable: 1,
    can_execute: 1,
    files_only: 0,
    max_concurrent: null,
    ...fields,
  };
}

function profile(fields = {}) {
  return {
    id: 'profile-a',
    max_concurrent: 2,
    ...fields,
  };
}

function explain(overrides = {}) {
  return explainDispatch({
    node: executableNode(),
    profile: profile(),
    runningOnNodeForProfile: 0,
    runningTotalOnNode: 0,
    ...overrides,
  });
}

test('DISPATCH_BLOCK_REASONS preserves dispatch priority order', () => {
  assert.deepEqual(DISPATCH_BLOCK_REASONS, [
    'node_unreachable',
    'node_not_executable',
    'node_cordoned',
    'profile_missing',
    'profile_capacity',
    'node_capacity',
  ]);
});

test('explainDispatch reports profile_missing for a queued run whose profile is gone', () => {
  assert.deepEqual(explain({ profile: null }), {
    ok: false,
    reason: 'profile_missing',
  });
});

test('explainDispatch reports node reasons before profile_missing', () => {
  assert.deepEqual(explain({ node: null, profile: null }), {
    ok: false,
    reason: 'node_unreachable',
  });
  assert.deepEqual(explain({ node: executableNode({ can_execute: 0 }), profile: null }), {
    ok: false,
    reason: 'node_not_executable',
  });
  assert.deepEqual(explain({ node: executableNode({ cordoned: 1 }), profile: null }), {
    ok: false,
    reason: 'node_cordoned',
  });
});

test('explainDispatch allows dispatch when node and capacity checks pass', () => {
  assert.deepEqual(explain(), { ok: true, reason: null });
});

test('explainDispatch treats a missing node as node_unreachable', () => {
  assert.deepEqual(explain({ node: null }), {
    ok: false,
    reason: 'node_unreachable',
  });
});

test('explainDispatch reports node_unreachable before capability and capacity reasons', () => {
  const result = explain({
    node: executableNode({
      reachable: 0,
      can_execute: 0,
      files_only: 1,
      max_concurrent: 1,
    }),
    profile: profile({ max_concurrent: 1 }),
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  });

  assert.deepEqual(result, { ok: false, reason: 'node_unreachable' });
});

test('explainDispatch reports node_not_executable before profile and node capacity', () => {
  const result = explain({
    node: executableNode({
      can_execute: 0,
      max_concurrent: 1,
    }),
    profile: profile({ max_concurrent: 1 }),
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  });

  assert.deepEqual(result, { ok: false, reason: 'node_not_executable' });
});

test('explainDispatch treats files_only nodes as node_not_executable', () => {
  const result = explain({
    node: executableNode({ files_only: 1 }),
  });

  assert.deepEqual(result, { ok: false, reason: 'node_not_executable' });
});

test('explainDispatch reports node_cordoned after executability and before profile/capacity', () => {
  assert.deepEqual(explain({ node: executableNode({ cordoned: 1 }) }), {
    ok: false,
    reason: 'node_cordoned',
  });

  assert.deepEqual(explain({
    node: executableNode({ reachable: 0, can_execute: 0, cordoned: 1, max_concurrent: 1 }),
    profile: null,
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  }), { ok: false, reason: 'node_unreachable' });

  assert.deepEqual(explain({
    node: executableNode({ can_execute: 0, cordoned: 1, max_concurrent: 1 }),
    profile: null,
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  }), { ok: false, reason: 'node_not_executable' });

  assert.deepEqual(explain({
    node: executableNode({ cordoned: 1, max_concurrent: 1 }),
    profile: null,
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  }), { ok: false, reason: 'node_cordoned' });
});

test('explainDispatch reports profile_capacity before node_capacity', () => {
  const result = explain({
    node: executableNode({ max_concurrent: 1 }),
    profile: profile({ max_concurrent: 1 }),
    runningOnNodeForProfile: 1,
    runningTotalOnNode: 1,
  });

  assert.deepEqual(result, { ok: false, reason: 'profile_capacity' });
});

test('explainDispatch reports node_capacity when only node total capacity is full', () => {
  const result = explain({
    node: executableNode({ max_concurrent: 1 }),
    profile: profile({ max_concurrent: 5 }),
    runningOnNodeForProfile: 0,
    runningTotalOnNode: 1,
  });

  assert.deepEqual(result, { ok: false, reason: 'node_capacity' });
});
