'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../services/observeSnapshotPolicy');
const secret = 'sk-ant-api03-' + 'Q'.repeat(80);
test('answer finalizer caps at 8000 UTF-16 units and preserves surrogate boundaries', () => {
  assert.equal(typeof policy.finalizeAnswerText, 'function');
  assert.deepEqual(policy.finalizeAnswerText('safe 한글 😀'), { value: 'safe 한글 😀', redacted: false, truncated: false });
  assert.deepEqual(policy.finalizeAnswerText(null), { value: '', redacted: false, truncated: false });
  assert.equal(policy.finalizeAnswerText('q'.repeat(8000)).truncated, false);
  const capped = policy.finalizeAnswerText('q'.repeat(8001));
  assert.deepEqual(capped, { value: 'q'.repeat(8000), redacted: false, truncated: true });
  assert.deepEqual(policy.finalizeAnswerText('q'.repeat(7999) + '😀tail'),
    { value: 'q'.repeat(7999), redacted: false, truncated: true });
  assert.equal(policy.finalizeAnswerText('q'.repeat(7998) + '😀tail').value, 'q'.repeat(7998) + '😀');
  assert.equal(policy.finalizeAnswerText('q'.repeat(7999) + '\ud800tail').value, 'q'.repeat(7999));
});
test('answer redacts before and after truncation and tracks only cap-induced truncation', () => {
  const safe = policy.finalizeAnswerText(secret.repeat(100));
  assert.equal(safe.redacted, true);
  assert.equal(safe.truncated, false, 'sanitization alone is not truncation');
  assert.equal(safe.value.includes(secret), false);
  const boundary = policy.finalizeAnswerText('q'.repeat(7989) + ' Basic YTpieAAB');
  assert.equal(boundary.redacted, true);
  assert.equal(boundary.truncated, true);
  assert.equal(boundary.value, 'q'.repeat(7989) + ' [REDACTED]');
  const both = policy.finalizeAnswerText(secret + ' ' + 'q'.repeat(8100));
  assert.equal(both.redacted, true);
  assert.equal(both.truncated, true);
});
test('answer fixed points hold for deterministic random unicode, surrogates and secret patterns', () => {
  let state = 0x517ac;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const alphabet = ['q', '한', '字', ' ', '\n', '<', '>', '/', '_', '\u200b', 'Ａ', '😀', '\ud800', '\udfff',
    ' ' + secret + ' ', ' ghp_' + 'Z'.repeat(36) + ' ', 'Bearer ' + 'B'.repeat(60), 'Basic YTpieAAB'];
  for (let i = 0; i < 1200; i++) {
    let input = '';
    const size = next() % 500;
    for (let j = 0; j < size; j++) input += alphabet[next() % alphabet.length];
    input += 'q '.repeat(next() % 5000);
    const output = policy.finalizeAnswerText(input);
    assert.equal(policy.finalizeAnswerText(output.value).value, output.value, `iteration ${i}`);
    assert.ok(output.value.length <= 8000);
    assert.equal(output.value.includes(secret), false);
    assert.equal(output.value.includes('ghp_' + 'Z'.repeat(36)), false);
    assert.equal(typeof output.truncated, 'boolean');
  }
});
test('shared answer finalizer preserves finalizeText return shape, cap and existing surrogate behavior', () => {
  assert.deepEqual(policy.finalizeText('safe'), { value: 'safe', redacted: false });
  for (const max of [undefined, 8000, 0, 2001, '200', null]) {
    assert.deepEqual(policy.finalizeText('q'.repeat(2100), max), { value: 'q'.repeat(2000), redacted: false });
  }
  assert.equal(policy.finalizeText('q'.repeat(1999) + '😀').value, 'q'.repeat(1999) + '\ud83d');
  assert.deepEqual(policy.finalizeText('q'.repeat(201), 200), { value: 'q'.repeat(200), redacted: false });
});
test('answer uses the same three-pass fallback and retains truncation after fallback', () => {
  for (const input of ['safe', 'q'.repeat(8000)]) {
    let calls = 0;
    const changing = value => { calls++; return { text: String(calls) + value + 'q', redacted: false }; };
    const result = policy._finalizeWithRedactor(input, 8000, false, changing, true);
    assert.deepEqual(result, { value: '[redacted]', redacted: true, truncated: input.length === 8000 });
    assert.equal(calls, 6);
    assert.equal(policy.finalizeAnswerText(result.value).value, result.value);
  }
});
