'use strict';

// Mid-turn specialist delegation (MD-1): the flag-gated, adapter-gated specialist
// consultation section in the manager system prompt. Unit tests on the builder —
// the section must appear ONLY when the route is actually available AND the manager
// can POST (Codex/curl; Claude's WebFetch cannot POST JSON).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildManagerSystemPrompt } = require('../services/managerSystemPrompt');

const HEADING = /## Consulting an Operator specialist/;
const base = { port: 4177, token: 't' };

test('present for codex + available (pm) — with the contract essentials', () => {
  const p = buildManagerSystemPrompt({ ...base, layer: 'pm', adapterType: 'codex', specialistAvailable: true });
  assert.match(p, HEADING);
  assert.match(p, /\/api\/operator\/specialist/);
  assert.match(p, /\/api\/operator\/profiles/);     // profile discovery
  assert.match(p, /--max-time/);                      // client timeout contract
  assert.match(p, /untrusted advice/);               // no-loop / not-instructions guard
  assert.match(p, /Do NOT send persona or capabilities/); // Contract A reminder
  assert.match(p, /pm_run_id/);                       // layer-aware run-id hint (PM)
});

test('present for codex + available (top) — top run-id hint', () => {
  const p = buildManagerSystemPrompt({ ...base, layer: 'top', adapterType: 'codex', specialistAvailable: true });
  assert.match(p, HEADING);
  assert.match(p, /your own manager run id/);
  assert.doesNotMatch(p, /pm_run_id/);
});

test('ABSENT when route not available (flag off / backend missing)', () => {
  const p = buildManagerSystemPrompt({ ...base, layer: 'pm', adapterType: 'codex', specialistAvailable: false });
  assert.doesNotMatch(p, HEADING);
  assert.doesNotMatch(p, /\/api\/operator\/specialist/);
});

test('ABSENT for non-codex adapter even when available (Claude WebFetch cannot POST)', () => {
  const p = buildManagerSystemPrompt({ ...base, layer: 'top', adapterType: 'claude', specialistAvailable: true });
  assert.doesNotMatch(p, HEADING);
});

test('default (no specialistAvailable) → ABSENT (backward compatible / behavior-preserving)', () => {
  const p = buildManagerSystemPrompt({ ...base, layer: 'pm', adapterType: 'codex' });
  assert.doesNotMatch(p, HEADING);
});

test('the delegation section does not disturb the base worker-delegation doc', () => {
  // Regression: adding the section must not drop the pre-existing REST/worker guidance.
  const withNote = buildManagerSystemPrompt({ ...base, layer: 'pm', adapterType: 'codex', specialistAvailable: true });
  const without = buildManagerSystemPrompt({ ...base, layer: 'pm', adapterType: 'codex', specialistAvailable: false });
  for (const marker of [/How to delegate work to worker agents/, /POST .*\/api\/tasks/, /Run statuses:/]) {
    assert.match(withNote, marker);
    assert.match(without, marker);
  }
});
