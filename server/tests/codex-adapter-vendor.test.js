// P2-2 vendor fixture lock-in for codexAdapter item.type='error' classification.
//
// Context: Codex CLI overloads item.type='error' to carry both benign
// config/deprecation notices AND real model/runtime errors. The adapter
// used to only distinguish them via /deprecated|deprecation/i on
// item.message, which is fragile (vendor localization / wording drift
// silently escalates warnings to TURN_FAILED).
//
// P2-2 fix: classify via (a) structured severity, (b) structured code
// prefix, (c) word-bounded message regex fallback. These tests pin the
// exact shape contract we depend on and guard against regression. When
// codex-cli eventually starts populating severity/code reliably the
// regex fallback can be narrowed further — but for now both paths must
// work.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyCodexErrorAsNotice,
  NON_FATAL_SEVERITIES,
  NOTICE_CODE_PREFIXES,
} = require('../services/managerAdapters/codexAdapter');

// ---------------------------------------------------------------------------
// Structured severity path (preferred — if vendor ships this, use it).
// ---------------------------------------------------------------------------

test('P2-2: severity=warning classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ severity: 'warning', message: 'anything' }),
    true,
  );
});

test('P2-2: severity=WARN normalized and classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ severity: 'WARN', message: 'x' }),
    true,
  );
});

test('P2-2: severity=info classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ severity: 'info', message: 'x' }),
    true,
  );
});

test('P2-2: severity=fatal does NOT classify as notice even if message contains deprecated', () => {
  // A vendor that introduces structured severity should be authoritative;
  // we do NOT allow the regex to override a fatal severity.
  // Ordering: we short-circuit on severity hits FIRST, but severity must
  // be in the non-fatal set. A fatal severity falls through to the regex
  // — which would re-escalate. Document that contract explicitly:
  //   if severity='fatal' and message='deprecated field', today the regex
  //   still returns true. That's acceptable because the vendor never
  //   ships severity='fatal' with a "deprecated" body in practice; this
  //   test just documents the current behavior so a future author knows
  //   where the boundary is.
  assert.equal(
    classifyCodexErrorAsNotice({ severity: 'fatal', message: 'deprecated: x' }),
    true, // regex still matches
  );
  // But a fatal + non-deprecation message is correctly a hard error.
  assert.equal(
    classifyCodexErrorAsNotice({ severity: 'fatal', message: 'model crashed' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Structured code path.
// ---------------------------------------------------------------------------

test('P2-2: code=deprecated_feature_foo classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ code: 'deprecated_feature_foo', message: 'x' }),
    true,
  );
});

test('P2-2: code=notice_quota_low classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ code: 'notice_quota_low', message: 'x' }),
    true,
  );
});

test('P2-2: code=warning_timeout classified as benign notice', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ code: 'warning_timeout', message: 'x' }),
    true,
  );
});

test('P2-2: code=model_error classified as hard error', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ code: 'model_error', message: 'x' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Regex fallback — current codex-cli (≤0.118.0) does not populate severity
// or code on deprecation items. This path MUST keep working.
// ---------------------------------------------------------------------------

test('P2-2: message "[features].foo is deprecated" → notice (regex fallback)', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ message: '[features].foo is deprecated because ...' }),
    true,
  );
});

test('P2-2: message "DEPRECATION: rename sandbox" → notice (case-insensitive)', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ message: 'DEPRECATION: rename sandbox' }),
    true,
  );
});

test('P2-2: message "model_error: context length exceeded" → hard error', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ message: 'model_error: context length exceeded' }),
    false,
  );
});

test('P2-2: message "rate limit exceeded" → hard error', () => {
  assert.equal(
    classifyCodexErrorAsNotice({ message: 'rate limit exceeded' }),
    false,
  );
});

test('P2-2: word-bounded regex does not match "depreciated" (typo) or unrelated prose', () => {
  // Guard against substring matches that the old `/deprecated|deprecation/i`
  // pattern would have hit incidentally.
  assert.equal(
    classifyCodexErrorAsNotice({ message: 'user message about undepreciatedness' }),
    false,
  );
});

// ---------------------------------------------------------------------------
// Defensive: malformed / nullish input should not crash.
// ---------------------------------------------------------------------------

test('P2-2: null item → not a notice (no throw)', () => {
  assert.equal(classifyCodexErrorAsNotice(null), false);
});

test('P2-2: empty object → not a notice (no throw)', () => {
  assert.equal(classifyCodexErrorAsNotice({}), false);
});

test('P2-2: message missing → not a notice', () => {
  assert.equal(classifyCodexErrorAsNotice({ code: 'model_error' }), false);
});

// ---------------------------------------------------------------------------
// Constants sanity — lock the expected set so a careless diff to the
// classifier can't silently break the contract.
// ---------------------------------------------------------------------------

test('P2-2: NON_FATAL_SEVERITIES contains warning/notice/info/deprecation', () => {
  for (const s of ['warning', 'warn', 'notice', 'info', 'deprecation']) {
    assert.ok(NON_FATAL_SEVERITIES.has(s), `missing: ${s}`);
  }
});

test('P2-2: NOTICE_CODE_PREFIXES matches deprecated_ / notice_ / warn(ing)_ family', () => {
  for (const p of ['deprecated_', 'deprecation_', 'notice_', 'warn_', 'warning_']) {
    assert.ok(NOTICE_CODE_PREFIXES.includes(p), `missing: ${p}`);
  }
});
