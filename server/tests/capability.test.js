'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  CAPABILITIES,
  createLegacyGrant,
  createGrant,
  assertCapability,
  isCapability,
} = require('../utils/capability');

const ALL_CAPS = Object.values(CAPABILITIES);

test('CAPABILITIES is the exact reviewed vocabulary (locks the list)', () => {
  // Fixed reviewed baseline (Codex review): a forEach-only test would pass even
  // if a capability were dropped. P-B2 may ADD caps (route mapping); removing one
  // must update this + review.
  assert.deepStrictEqual(ALL_CAPS, [
    'shell', 'fs', 'network', 'mcp', 'browser', 'env', 'artifact', 'inherit_run_context',
    'dispatch_execute', 'task_write', 'run_control', 'run_read', 'dispatch_audit_write',
    'memory_write', 'project_write', 'conversation_send', 'registry_write',
    'project_read', 'workspace_content_read', 'fs_browse',
    'registry_metadata_search',
  ]);
  assert.strictEqual(new Set(ALL_CAPS).size, ALL_CAPS.length); // no dupes
  assert.ok(Object.isFrozen(CAPABILITIES));
});

test('CAP_SET is NOT exported (vocabulary is immutable to callers)', () => {
  const mod = require('../utils/capability');
  assert.strictEqual(mod.CAP_SET, undefined);
  assert.strictEqual(typeof isCapability, 'function');
  assert.ok(isCapability('shell') && !isCapability('bogus'));
});

test('legacy grant: every capability allowed (passthrough — existing behavior unchanged)', () => {
  const grant = createLegacyGrant();
  for (const cap of ALL_CAPS) {
    assert.doesNotThrow(() => assertCapability(grant, cap), `legacy should allow ${cap}`);
  }
});

test('explicit grant: deny-by-default — only listed caps allowed', () => {
  const grant = createGrant([CAPABILITIES.REGISTRY_METADATA_SEARCH]);
  assert.doesNotThrow(() => assertCapability(grant, 'registry_metadata_search'));
  for (const cap of ALL_CAPS) {
    if (cap === 'registry_metadata_search') continue;
    assert.throws(() => assertCapability(grant, cap), /capability denied/, `should deny ${cap}`);
  }
});

test('specialist minimal grant (O9): registry_metadata_search only — privileged surfaces denied', () => {
  const grant = createGrant([CAPABILITIES.REGISTRY_METADATA_SEARCH]);
  for (const cap of ['shell', 'fs', 'network', 'mcp', 'dispatch_execute', 'task_write',
    'memory_write', 'project_write', 'registry_write', 'conversation_send', 'fs_browse']) {
    assert.throws(() => assertCapability(grant, cap), /capability denied/);
  }
});

test('denied capability throw carries CAPABILITY_DENIED code', () => {
  try {
    assertCapability(createGrant([]), 'shell');
    assert.fail('expected throw');
  } catch (e) {
    assert.strictEqual(e.code, 'CAPABILITY_DENIED');
  }
});

test('🔒 forged grant is rejected (shape spoof of {legacy:true} does NOT pass)', () => {
  // The crux: only factory-issued (branded) grants are honored.
  assert.throws(() => assertCapability({ legacy: true }, 'shell'), /invalid or forged grant/);
  assert.throws(() => assertCapability({ legacy: true, caps: ['shell'] }, 'shell'), /invalid or forged grant/);
  assert.throws(() => assertCapability({ caps: ['shell'] }, 'shell'), /invalid or forged grant/);
});

test('🔒 grant cannot be escalated post-hoc (caps list is frozen)', () => {
  const grant = createGrant([CAPABILITIES.REGISTRY_METADATA_SEARCH]);
  assert.throws(() => grant.caps.push('shell'), TypeError); // frozen array
  assert.ok(Object.isFrozen(grant));
  assert.ok(Object.isFrozen(grant.caps));
  // still denied after the failed mutation attempt
  assert.throws(() => assertCapability(grant, 'shell'), /capability denied/);
});

test('omitted / malformed grant throws (fail-open guard — no "no grant ⇒ legacy")', () => {
  assert.throws(() => assertCapability(undefined, 'shell'), /invalid or forged grant/);
  assert.throws(() => assertCapability(null, 'shell'), /invalid or forged grant/);
  assert.throws(() => assertCapability('legacy', 'shell'), /invalid or forged grant/);
  assert.throws(() => assertCapability({}, 'shell'), /invalid or forged grant/);
});

test('unknown capability throws (typo guard) — even for a legacy grant', () => {
  assert.throws(() => assertCapability(createLegacyGrant(), 'bogus'), /unknown capability/);
  assert.throws(() => assertCapability(createGrant([]), 'bogus'), /unknown capability/);
});

test('createGrant rejects unknown capability + dedupes', () => {
  assert.throws(() => createGrant(['shell', 'bogus']), /unknown capability/);
  const g = createGrant(['shell', 'shell', 'fs']);
  assert.deepStrictEqual(g.caps, ['shell', 'fs']);
});
