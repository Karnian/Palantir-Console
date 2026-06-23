'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  WORKSPACE_BINDING,
  WORKSPACE_BOUND_SURFACES,
  assertWorkspaceBound,
} = require('../utils/workspaceBinding');

test('folder binding is allowed on every bound surface (legacy/coder unchanged)', () => {
  for (const surface of WORKSPACE_BOUND_SURFACES) {
    assert.doesNotThrow(() => assertWorkspaceBound('folder', surface), `folder should pass ${surface}`);
  }
});

test('none binding throws fail-closed on every bound surface', () => {
  for (const surface of WORKSPACE_BOUND_SURFACES) {
    assert.throws(
      () => assertWorkspaceBound('none', surface),
      /cannot access folder-bound surface/,
      `none should throw on ${surface}`,
    );
  }
});

test('none binding throw carries WORKSPACE_UNBOUND code', () => {
  try {
    assertWorkspaceBound('none', 'shell');
    assert.fail('expected throw');
  } catch (e) {
    assert.strictEqual(e.code, 'WORKSPACE_UNBOUND');
  }
});

test('unknown surface throws (typo guard, fail-closed — never silently allow)', () => {
  assert.throws(() => assertWorkspaceBound('folder', 'bogus'), /unknown surface/);
  assert.throws(() => assertWorkspaceBound('none', 'bogus'), /unknown surface/);
});

test('invalid binding throws (only none|folder)', () => {
  assert.throws(() => assertWorkspaceBound('weird', 'shell'), /invalid binding/);
  assert.throws(() => assertWorkspaceBound(undefined, 'shell'), /invalid binding/);
  assert.throws(() => assertWorkspaceBound(null, 'shell'), /invalid binding/);
});

test('surface check precedes binding check (unknown surface throws even for valid binding)', () => {
  // An unknown surface must fail as a typo guard regardless of binding, so a
  // future caller can never accidentally pass an unlisted surface with folder.
  assert.throws(() => assertWorkspaceBound('folder', 'fs_typo'), /unknown surface/);
});

test('WORKSPACE_BINDING enum values + frozen', () => {
  assert.strictEqual(WORKSPACE_BINDING.NONE, 'none');
  assert.strictEqual(WORKSPACE_BINDING.FOLDER, 'folder');
  assert.ok(Object.isFrozen(WORKSPACE_BINDING));
  assert.ok(Object.isFrozen(WORKSPACE_BOUND_SURFACES));
});

test('WORKSPACE_BOUND_SURFACES is the exact reviewed boundary (locks the list)', () => {
  // The whole point of this slice is a FIXED reviewed boundary. A plain forEach
  // over the list would still pass if someone dropped fs/l1_capture/project_route,
  // so pin the exact set (Codex review). Any add/remove must update this + review.
  assert.deepStrictEqual([...WORKSPACE_BOUND_SURFACES], [
    'spawn_cwd',
    'shell',
    'fs',
    'project_scope',
    'worktree',
    'xproject_scan',
    'l1_capture',
    'project_route',
  ]);
  // No duplicate surfaces.
  assert.strictEqual(new Set(WORKSPACE_BOUND_SURFACES).size, WORKSPACE_BOUND_SURFACES.length);
});
