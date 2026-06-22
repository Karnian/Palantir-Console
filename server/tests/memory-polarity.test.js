// A2-④-a memory polarity gate — unit + integration tests.
//
// Coverage:
//   Unit — detectNegation (false-positive contract, true-positive contract,
//           double negation, hasHangul), polarityLost (language guard,
//           double-negation guard, single-negation loss), summarizeR4ReferenceContent (cap).
//   Integration — promoteCandidatesBatchTx:
//     • R4 polarity-lost → rejected + skipped[reason=polarity_lost]
//     • R4 polarity-preserved → promoted (byte-equiv)
//     • R4 Korean ref → English distilled output → language guard → promoted
//     • R3 / R1b → unaffected (byte-equiv)
//     • R4 no negation in ref → promoted (byte-equiv)
//   Distiller — liveDistiller.buildUserMessage exposes R4 content via
//     summarizeR4ReferenceContent (gate == distiller reference).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { detectNegation, polarityLost, summarizeR4ReferenceContent } = require('../services/memoryPolarity');
const { buildUserMessage } = require('../services/distillers/liveDistiller');
const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupDb(t) {
  const dir = mkTempDir('palantir-polarity-');
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(() => {
    try { close(); } catch { /* */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Proj One')").run();
  return db;
}

/**
 * Create a running distill job and return { svc, job }.
 */
function setupJob(db, { projectId = 'p1' } = {}) {
  const svc = createMemoryService(db);
  const { job: pending } = svc.enqueueDistillJob(projectId);
  const job = svc.claimDistillJob({});
  assert.ok(job, 'job claimed');
  return { svc, job };
}

/**
 * Insert a candidate via svc.createCandidate (handles owner_type/owner_id).
 * Returns the candidate row (has .id, .rule, .status, .raw_json, etc.).
 */
function seedCandidate(svc, _db, { projectId = 'p1', rule, rawObj }) {
  const dedupKey = `key-${Math.random().toString(36).slice(2)}`;
  return svc.createCandidate({ projectId, rule, rawJson: rawObj, dedupKey });
}

// ---------------------------------------------------------------------------
// 1. Unit — detectNegation false-positive contract
// ---------------------------------------------------------------------------
test('detectNegation: false-positive set must all yield count=0', () => {
  const falsePositives = [
    '보안',
    '안내',
    '안전',
    '미들웨어',
    '비동기',
    '비교',
    '불러오기',
    '관계없이',
    '상관없이',
    '문제없이',
    '불가피',
    '업데이트',
    // Claude-review regressions: compounds that contain a negation morpheme
    // followed by a space (잘못 = "mistake", not 못 negation) or starting with
    // 아니 (아니메 = "anime") must NOT false-match.
    '잘못 됐다',
    '잘못 처리됨',
    '아니메 캐릭터',
    '방안을 제안',
    // Codex-review regressions: conditional (~않으면) / concessive (~않아도) /
    // idiomatic (못지않다 = "not inferior", 아니면 = "if not") negations are
    // FALSE NEGATIVES by design (plan v0.3) — catching them would lossy-reject
    // a normal lesson whose polarity is actually preserved.
    '테스트가 통과하지 않으면 보류한다',
    'A 아니면 B를 사용한다',
    '이것은 저것에 못지않다',
    '실패하지 않아도 로그를 남긴다',
  ];
  for (const word of falsePositives) {
    const { count } = detectNegation(word);
    assert.equal(count, 0, `expected count=0 for "${word}", got ${count}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Unit — detectNegation true-positive contract
// ---------------------------------------------------------------------------
test('detectNegation: true-positive set must all yield count>=1', () => {
  const truePositives = [
    '하지 않는다',
    '쓰지 마라',
    '사용하지 않음',
    '아님',
    '못 한다',
    '금지',
    '미지원',
    // English contractions must count as exactly one negation (regression).
    "don't use eval",
    "doesn't work",
    // Copula conjugations + non-contracted / extra contractions must still fire.
    '아니다',
    '아니라',
    '아닌 경우',
    'cannot proceed',
    "isn't valid",
    "wouldn't work",
  ];
  for (const phrase of truePositives) {
    const { count } = detectNegation(phrase);
    assert.ok(count >= 1, `expected count>=1 for "${phrase}", got ${count}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Unit — detectNegation double-negation
// ---------------------------------------------------------------------------
test('detectNegation: double negation returns count >= 2', () => {
  const { count } = detectNegation('하지 않는 것이 아니다');
  assert.ok(count >= 2, `expected >= 2 for double negation, got ${count}`);
});

// ---------------------------------------------------------------------------
// 4. Unit — detectNegation hasHangul
// ---------------------------------------------------------------------------
test('detectNegation: hasHangul false for pure ASCII', () => {
  const { hasHangul } = detectNegation('do not use this');
  assert.equal(hasHangul, false);
});

test('detectNegation: hasHangul true for Korean text', () => {
  const { hasHangul } = detectNegation('이것을 쓰지 않는다');
  assert.equal(hasHangul, true);
});

// ---------------------------------------------------------------------------
// 5. Unit — polarityLost
// ---------------------------------------------------------------------------
test('polarityLost: null reference → false', () => {
  assert.equal(polarityLost(null, 'use this freely'), false);
});

test('polarityLost: empty string reference → false', () => {
  assert.equal(polarityLost('', 'use this freely'), false);
});

test('polarityLost: language guard — Korean ref, English content → false', () => {
  // Korean single negation in ref, but English content has no Hangul
  const ref = '쓰지 않는다';
  const content = 'Use this freely whenever possible.';
  assert.equal(polarityLost(ref, content), false, 'language mismatch → skip');
});

test('polarityLost: double-negation guard → false', () => {
  // ref has 2 negations: "하지 않는 것이 아니다"
  const ref = '하지 않는 것이 아니다';
  const content = '자유롭게 사용해라';
  assert.equal(polarityLost(ref, content), false, 'double negation in ref → skip');
});

test('polarityLost: single negation ref, zero negation content → true', () => {
  const ref = '이 패턴을 사용하지 않는다';
  const content = '이 패턴을 사용한다';
  assert.equal(polarityLost(ref, content), true, 'single negation lost → reject');
});

test('polarityLost: single negation ref, content also has negation → false', () => {
  const ref = '쓰지 마라';
  const content = '절대 쓰지 마라';
  assert.equal(polarityLost(ref, content), false, 'negation preserved → pass');
});

test('polarityLost: no negation in ref → false', () => {
  const ref = '항상 테스트를 먼저 작성한다';
  const content = '항상 테스트를 먼저 작성한다';
  assert.equal(polarityLost(ref, content), false, 'no negation in ref → pass');
});

test('polarityLost: English contraction single-negation loss → true (no double-count)', () => {
  // Regression (Claude review SERIOUS): don't/doesn't were counted twice
  // (EN_NEG_WORDS list + the \w+n't pattern), so a single contracted negation
  // hit count=2 and the double-negation guard silently disabled the gate for
  // every English contraction. They must count as exactly one.
  assert.equal(polarityLost("don't use eval", 'use eval freely'), true);
  assert.equal(polarityLost("doesn't support legacy mode", 'supports legacy mode'), true);
});

// ---------------------------------------------------------------------------
// 6. Unit — summarizeR4ReferenceContent cap + normalize
// ---------------------------------------------------------------------------
test('summarizeR4ReferenceContent: caps at 400 chars', () => {
  const long = 'a'.repeat(600);
  const result = summarizeR4ReferenceContent(long);
  assert.equal(result.length, 400);
});

test('summarizeR4ReferenceContent: normalizes whitespace', () => {
  const result = summarizeR4ReferenceContent('hello  \t  world\n\n foo');
  assert.equal(result, 'hello world foo');
});

test('summarizeR4ReferenceContent: non-string returns empty string', () => {
  assert.equal(summarizeR4ReferenceContent(null), '');
  assert.equal(summarizeR4ReferenceContent(undefined), '');
  assert.equal(summarizeR4ReferenceContent(42), '');
});

// ---------------------------------------------------------------------------
// 7. Integration — promote tx: R4 polarity-lost → rejected
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R4 polarity-lost → rejected + reason=polarity_lost', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  // raw.content has single negation; distilled content has zero
  const cand = seedCandidate(svc, db, {
    rule: 'R4',
    rawObj: { rule: 'R4', kind: 'pitfall', content: '이 방법을 사용하지 않는다' },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'pitfall', content: '이 방법을 사용한다' },
    ],
  });

  // Should have been skipped, not promoted
  assert.equal(result.promoted.length, 0, 'nothing promoted');
  assert.ok(result.skipped.find((s) => s.candidateId === cand.id && s.reason === 'polarity_lost'),
    'skipped with reason=polarity_lost');

  // DB: candidate must be 'rejected'
  const row = db.prepare('SELECT status FROM memory_candidates WHERE id=?').get(cand.id);
  assert.equal(row.status, 'rejected');

  // DB: no active memory item
  const items = db.prepare("SELECT * FROM memory_items WHERE project_id='p1'").all();
  assert.equal(items.length, 0, 'no active item created');
});

// ---------------------------------------------------------------------------
// 8. Integration — promote tx: R4 polarity-preserved → promoted (byte-equiv)
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R4 polarity-preserved → promoted', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  const cand = seedCandidate(svc, db, {
    rule: 'R4',
    rawObj: { rule: 'R4', kind: 'pitfall', content: '이 방법을 사용하지 않는다' },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'pitfall', content: '이 방법은 절대 사용하지 않는다' },
    ],
  });

  assert.equal(result.promoted.length, 1, 'should be promoted');
  assert.equal(result.skipped.length, 0, 'nothing skipped');

  const row = db.prepare('SELECT status FROM memory_candidates WHERE id=?').get(cand.id);
  assert.equal(row.status, 'promoted');
});

// ---------------------------------------------------------------------------
// 9. Integration — promote tx: R4 Korean ref → English content → language guard → promoted
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R4 Korean ref + English content → language guard skips reject → promoted', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  // ref is Korean with single negation; distilled content is English (no negation)
  // Language guard prevents false-positive rejection
  const cand = seedCandidate(svc, db, {
    rule: 'R4',
    rawObj: { rule: 'R4', kind: 'convention', content: '이 패턴을 쓰지 마라' },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'convention', content: 'Always use the alternative pattern instead.' },
    ],
  });

  // Language mismatch → language guard fires → polarityLost=false → promote
  assert.equal(result.promoted.length, 1, 'language guard: should promote despite polarity difference');
  assert.equal(result.skipped.filter((s) => s.reason === 'polarity_lost').length, 0);
});

// ---------------------------------------------------------------------------
// 10. Integration — promote tx: R3 candidate unaffected (byte-equiv)
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R3 candidate → no polarity check → promoted normally', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  const cand = seedCandidate(svc, db, {
    rule: 'R3',
    rawObj: { rule: 'R3', rationale: 'task completed successfully' },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'heuristic', content: 'Always run tests before merging.' },
    ],
  });

  assert.equal(result.promoted.length, 1, 'R3 → promoted');
  assert.equal(result.skipped.filter((s) => s.reason === 'polarity_lost').length, 0);
});

// ---------------------------------------------------------------------------
// 11. Integration — promote tx: R1b candidate unaffected (byte-equiv)
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R1b candidate → no polarity check → promoted normally', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  const cand = seedCandidate(svc, db, {
    rule: 'R1b',
    rawObj: {
      rule: 'R1b',
      fail_run: { id: 'run-fail' },
      fix_run: { id: 'run-fix', diff_stat: '2 files changed' },
    },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'convention', content: 'Always handle async errors with try/catch.' },
    ],
  });

  assert.equal(result.promoted.length, 1, 'R1b → promoted');
  assert.equal(result.skipped.filter((s) => s.reason === 'polarity_lost').length, 0);
});

// ---------------------------------------------------------------------------
// 12. Integration — promote tx: R4 no negation in ref → promoted (byte-equiv)
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: R4 no negation in ref → no polarity rejection → promoted', (t) => {
  const db = setupDb(t);
  const { svc, job } = setupJob(db);

  const cand = seedCandidate(svc, db, {
    rule: 'R4',
    rawObj: { rule: 'R4', kind: 'convention', content: '항상 테스트를 먼저 작성한다' },
  });

  const result = svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [
      { candidateId: cand.id, kind: 'convention', content: '테스트를 먼저 작성한다' },
    ],
  });

  assert.equal(result.promoted.length, 1, 'no negation in ref → promoted');
  assert.equal(result.skipped.filter((s) => s.reason === 'polarity_lost').length, 0);
});

// ---------------------------------------------------------------------------
// 12b. Integration — memory:polarity_rejected event carries NO content (untrusted)
// ---------------------------------------------------------------------------
test('promoteCandidatesBatchTx: polarity_rejected event emits {projectId,candidateId,rule} with no content', (t) => {
  const db = setupDb(t);
  const events = [];
  const eventBus = { emit: (name, payload) => events.push({ name, payload }) };
  const svc = createMemoryService(db, eventBus);
  svc.enqueueDistillJob('p1');
  const job = svc.claimDistillJob({});
  assert.ok(job, 'job claimed');

  const cand = seedCandidate(svc, db, {
    rule: 'R4',
    rawObj: { rule: 'R4', kind: 'pitfall', content: '이 방법을 사용하지 않는다' },
  });
  svc.promoteCandidates({
    jobId: job.id,
    claimToken: job.claim_token,
    proposals: [{ candidateId: cand.id, kind: 'pitfall', content: '이 방법을 사용한다' }],
  });

  const ev = events.find((e) => e.name === 'memory:polarity_rejected');
  assert.ok(ev, 'memory:polarity_rejected emitted');
  assert.equal(ev.payload.candidateId, cand.id);
  assert.equal(ev.payload.rule, 'R4');
  assert.equal(ev.payload.projectId, 'p1');
  // The untrusted content must never ride along on the event.
  assert.equal('content' in ev.payload, false, 'no content key in payload');
  assert.equal('raw_json' in ev.payload, false, 'no raw_json key in payload');
});

// ---------------------------------------------------------------------------
// 13. Distiller — liveDistiller.buildUserMessage R4 == summarizeR4ReferenceContent
// ---------------------------------------------------------------------------
test('liveDistiller.buildUserMessage: R4 content matches summarizeR4ReferenceContent output', () => {
  const rawContent = '이 패턴을 쓰지 않는다';
  const rawObj = { rule: 'R4', kind: 'pitfall', content: rawContent };

  const candidates = [{
    id: 'cand-1',
    rule: 'R4',
    raw_json: JSON.stringify(rawObj),
  }];

  const msg = buildUserMessage(candidates);

  // The expected text as the gate would compute it
  const expectedRef = summarizeR4ReferenceContent(rawContent);
  const expectedLine = `remembered pitfall: ${expectedRef}`;

  assert.ok(
    msg.includes(expectedLine),
    `buildUserMessage should include "${expectedLine}" but got:\n${msg}`
  );
});

test('liveDistiller.buildUserMessage: R4 long content is capped identically to gate', () => {
  const longContent = 'A'.repeat(600);
  const rawObj = { rule: 'R4', kind: 'convention', content: longContent };

  const candidates = [{ id: 'c1', rule: 'R4', raw_json: JSON.stringify(rawObj) }];
  const msg = buildUserMessage(candidates);

  const expectedRef = summarizeR4ReferenceContent(longContent);
  assert.ok(msg.includes(expectedRef), 'distiller uses same capped text as gate');
});

test('liveDistiller.buildUserMessage: R4 branch keys on trusted column rule, not raw_json.rule', () => {
  // raw_json deliberately OMITS rule — only the trusted candidate column says R4.
  // The gate (cand.rule) and distiller (c.rule) must agree (Codex review SERIOUS).
  const rawContent = '이 패턴을 쓰지 않는다';
  const rawObj = { kind: 'pitfall', content: rawContent };
  const candidates = [{ id: 'c1', rule: 'R4', raw_json: JSON.stringify(rawObj) }];

  const msg = buildUserMessage(candidates);
  const expectedRef = summarizeR4ReferenceContent(rawContent);
  assert.ok(
    msg.includes(`remembered pitfall: ${expectedRef}`),
    'R4 branch must be taken from the column rule even when raw_json.rule is missing'
  );
});
