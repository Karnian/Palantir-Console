'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const snapshotPolicy = require('../services/observeSnapshotPolicy');
const secret = 'sk-ant-api03-' + 'Q'.repeat(80);

function createSeededRandom() {
  let randomState = 0x517ac;
  return () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return randomState >>> 0;
  };
}
test('TEXT and LABEL fixed-point properties, safe preservation and sentinel removal', () => {
  const next = createSeededRandom();
  for (const [finalizeSlot, cap] of [[snapshotPolicy.finalizeText, 2000], [snapshotPolicy.finalizeLabel, 64]]) {
    assert.equal(finalizeSlot('한글-safe/path_12').value, '한글-safe/path_12');
    assert.equal(finalizeSlot(finalizeSlot === snapshotPolicy.finalizeText ? '[redacted]' : 'redacted').value,
      finalizeSlot === snapshotPolicy.finalizeText ? '[redacted]' : 'redacted');
    for (let iteration = 0; iteration < 500; iteration++) {
      const alphabet = ['q', '한', '字', ' ', '\n', '<', '>', '/', '_', '\u200b', 'Ａ'];
      let candidate = '';
      for (let characterIndex = 0; characterIndex < next() % 300; characterIndex++) {
        candidate += alphabet[next() % alphabet.length];
      }
      candidate += ' ' + secret + ' ghp_' + 'Z'.repeat(36);
      candidate += 'q '.repeat(next() % 2100);
      const finalized = finalizeSlot(candidate);
      assert.deepEqual(finalizeSlot(finalized.value).value, finalized.value);
      assert.ok(finalized.value.length <= cap);
      if (finalizeSlot === snapshotPolicy.finalizeLabel) {
        assert.match(finalized.value, /^[\p{L}\p{N}._/-]*$/u);
      }
      assert.equal(finalized.value.includes(secret), false);
      assert.equal(finalized.value.includes('ghp_' + 'Z'.repeat(36)), false);
    }
  }
});
test('OPAQUE HMAC matches native crypto for long and unicode salts', () => {
  for (const salt of ['salt', '한글', 'x'.repeat(100)]) {
    const raw = '/private/sensitive';
    assert.equal(snapshotPolicy.opaquePath(salt, 3, raw), 'g3-' + crypto.createHmac('sha256', salt).update(raw)
      .digest('hex').slice(0, 16));
  }
  assert.equal(snapshotPolicy.canonicalEncode(['domain', ['a', 'b'], null]), '["domain",["a","b"],null]');
  assert.notEqual(snapshotPolicy.canonicalEncode(['domain', 'a+b', 'c']), snapshotPolicy.canonicalEncode(
    ['domain', 'a', 'b+c']));
  assert.throws(() => snapshotPolicy.canonicalEncode(['domain', {}]));
});
test('preview and status closed schemas preserve valid structural hex without redaction', () => {
  const candidate = {
    schema: 'palantir.snapshot-exclude-preview/1',
    machine_id: 'm',
    reader_build: 'a'.repeat(16),
    op: 'instruction',
    target: 'codex:s:n1',
    ts: null,
    preview: 'safe preview',
    equiv_count: 2,
    token: 'b'.repeat(64)
  };
  assert.deepEqual(snapshotPolicy.validateExcludePreview(candidate), {
    ok: true
  });
  assert.equal(snapshotPolicy.validateExcludePreview({ ...candidate, op: 'cwd' }).ok, false);
  assert.equal(snapshotPolicy.validateExcludePreview({ ...candidate, target: 'cwd' }).ok, false);
  assert.equal(snapshotPolicy.validateExcludePreview({
    ...candidate,
    secret
  }).ok, false);
  assert.equal(snapshotPolicy.validateExcludePreview({
    ...candidate,
    preview: secret
  }).ok, false);
  assert.equal(snapshotPolicy.validateExcludePreview({
    ...candidate,
    token: 'B'.repeat(64)
  }).ok, false);
  const snapshot = {
    schema: 'palantir.snapshot-status/1',
    machine_id: 'm',
    reader_build: 'a'.repeat(16),
    code: 'ok',
    counts: {
      registered: 1
    }
  };
  assert.deepEqual(snapshotPolicy.validateStatusEnvelope(snapshot), {
    ok: true
  });
  assert.equal(snapshotPolicy.validateStatusEnvelope({
    ...snapshot,
    code: secret
  }).ok, false);
  assert.equal(snapshotPolicy.validateStatusEnvelope({
    ...snapshot,
    counts: {
      secret: 1
    }
  }).ok, false);
  assert.equal(snapshotPolicy.validateStatusEnvelope({
    ...snapshot,
    counts: {
      registered: -1
    }
  }).ok, false);
});
test('redact after truncation and label conversion closes newly formed credential boundaries', () => {
  assert.equal(snapshotPolicy.finalizeText('safe normal', 200).value, 'safe normal');
  const boundary = snapshotPolicy.finalizeText('Basic YTpieAAB', 10);
  assert.equal(boundary.value, '[REDACTED]');
  assert.equal(boundary.redacted, true);
  const label = snapshotPolicy.finalizeLabel('ghp@' + 'Z'.repeat(36));
  assert.equal(label.value, '_REDACTED_');
  assert.equal(label.redacted, true);
  assert.equal(snapshotPolicy.finalizeLabel(label.value).value, label.value);
  for (let iteration = 1; iteration <= 64; iteration++) {
    const safe = '한q/_-'.repeat(iteration).slice(0, 64);
    assert.equal(snapshotPolicy.finalizeLabel(safe).value, safe);
    assert.equal(snapshotPolicy.finalizeText(safe, 200).value, safe);
  }
  assert.equal(snapshotPolicy.isSafeId('safe_id'), true);
  assert.equal(snapshotPolicy.isSafeId('ghp_' + 'Z'.repeat(36)), false);
});

test('review 8 opaque paths delegate HMAC to node crypto with no handwritten SHA implementation', () => {
  const source = fs.readFileSync(require.resolve('../services/observeSnapshotPolicy'), 'utf8');
  assert.equal(snapshotPolicy.opaquePath('salt', 2, '/safe'),
    'g2-' + crypto.createHmac('sha256', 'salt').update('/safe').digest('hex').slice(0, 16));
  assert.match(source, /require\(['"]node:crypto['"]\)/);
  assert.doesNotMatch(source, /function sha256|rotateRight|roundConstants/);
});

test('review 10 nonconverging redactors reach fixed TEXT and LABEL fallback values after three passes', () => {
  assert.equal(snapshotPolicy.finalizeText('safe preserved').value, 'safe preserved');
  assert.equal(snapshotPolicy.finalizeLabel('safe-label').value, 'safe-label');
  assert.equal(typeof snapshotPolicy._finalizeWithRedactor, 'function');
  for (const [isLabel, fallback] of [[false, '[redacted]'], [true, 'redacted']]) {
    let calls = 0;
    function changingRedactor(text) {
      calls++;
      return { text: text + 'q', redacted: false };
    }
    const finalized = snapshotPolicy._finalizeWithRedactor('safe', 200, isLabel, changingRedactor);
    assert.deepEqual(finalized, { value: fallback, redacted: true });
    assert.equal(calls, 6);
    const finalizeSlot = isLabel ? snapshotPolicy.finalizeLabel : snapshotPolicy.finalizeText;
    assert.equal(finalizeSlot(finalized.value).value, fallback);
  }
});

test('R7 shared slot predicates enforce INT TIME LABEL and ENUM boundaries', () => {
  assert.equal(snapshotPolicy.isSafeInteger(0), true);
  assert.equal(snapshotPolicy.isSafeInteger(1000000000), true);
  assert.equal(snapshotPolicy.isSafeTimestamp('2026-10-08T02:00:00.000Z'), true);
  assert.equal(snapshotPolicy.isSafeLabel('safe/repo-1'), true);
  assert.equal(snapshotPolicy.isSafeEnum('agent_type', 'claude'), true);
  for (const value of [-1, 1000000001, Number.MAX_SAFE_INTEGER, null, '1', {}, []]) {
    assert.equal(snapshotPolicy.isSafeInteger(value), false);
  }
  for (const value of ['-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', null, 0]) {
    assert.equal(snapshotPolicy.isSafeTimestamp(value), false);
  }
  assert.equal(snapshotPolicy.isSafeLabel('x'.repeat(65)), false);
  assert.equal(snapshotPolicy.isSafeLabel('unsafe label'), false);
  assert.equal(snapshotPolicy.isSafeEnum('agent_type', {}), false);
  assert.equal(snapshotPolicy.isSafeEnum('unknown-slot', 'claude'), false);
});

test('PR1d session total is a required closed integer slot and prompt_trunc is accepted', t => {
  const os = require('node:os');
  const path = require('node:path');
  const { createSnapshots } = require('./helpers/work-board-fixture.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr1d-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = createSnapshots(root).alpha;
  const session = snapshot.sessions[0];
  session.instruction_total = 401;
  session.orca_link.evidence = 'prompt_trunc';
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
  for (const bad of [-1, 1.1, '401', null, undefined])
    assert.equal(snapshotPolicy.validateSession({ ...session, instruction_total: bad }).ok, false);
  assert.equal(snapshotPolicy.validateSession({ ...session, link_text: 'raw' }).ok, false);
  snapshot.instructions.push({ ...snapshot.instructions[0] });
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, false);
});

test('PR1d S1 provider link_blocked coverage accepts only integer zero or one', t => {
  const os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-link-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot({
    homeDir: root, configDir: path.join(root, 'config'), now: new Date('2026-10-08T03:00:00.000Z'),
    readerBuild: 'a'.repeat(16), runOrca: () => null
  });
  for (const provider of ['claude', 'codex']) {
    for (const value of [0, 1]) {
      snapshot.coverage[provider].link_blocked = value;
      assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
    }
    for (const value of [2, -1, true, null, '1']) {
      snapshot.coverage[provider].link_blocked = value;
      assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, false);
    }
    snapshot.coverage[provider].link_blocked = 0;
  }
});
