const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createDatabase } = require('../db/database');
const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');

// A1 (docs/specs/memory-augmentation-brief.md §2-①) — Korean FTS recall.
//
// buildMatchQuery defaults to exact-quoted tokens; retrieve runs TWO-PASS:
//   pass 1  exact tokens (`"메모리"`)  — identical ranking to pre-A1
//   pass 2  prefix tokens (`"메모리"*`) — fills only the slots pass 1 left empty
// Korean 조사 attach as suffixes (메모리+를), so the stem is a PREFIX of the
// inflected token: `"메모리"` misses `메모리를`, `"메모리"*` catches it. Two-pass
// makes the inflected form reachable (recall fix) while GUARANTEEING that no exact
// hit is ever displaced from top-K by a short over-matching prefix (the precision
// trap Codex demonstrated for a pure-prefix query). Applies to L1 + L2.

function setupL1(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-ftsko-l1-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  db.prepare("INSERT INTO projects (id, name) VALUES ('p1', 'Proj One')").run();
  return createMemoryService(db);
}

function setupL2(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-ftsko-l2-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(() => { try { close(); } catch { /* */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return createMasterMemoryService(db);
}

// ---------------------------------------------------------------------------
// L1 (PM project memory)
// ---------------------------------------------------------------------------

test('L1: 조사-inflected content is reachable by a stem query (the recall fix)', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', content: '메모리를 정리하는 규칙' });
  const rows = svc.retrieveForProject('p1', { taskContext: '메모리' });
  assert.ok(rows.some((r) => /메모리를 정리/.test(r.content)), 'stem 메모리 matches inflected 메모리를 via prefix-fill');
});

test('L1: exact-token content still matches (no regression)', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', content: '메모리 구조 설계 규칙' });
  const rows = svc.retrieveForProject('p1', { taskContext: '메모리' });
  assert.ok(rows.some((r) => /메모리 구조/.test(r.content)), 'standalone 메모리 token still matches');
});

test('L1: 2-char stem query matches (no trigram 3-char floor)', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', content: '회의록 작성 절차' });
  const rows = svc.retrieveForProject('p1', { taskContext: '회의' });
  assert.ok(rows.some((r) => /회의록/.test(r.content)), '2-char stem 회의 matches 회의록 via unicode61 prefix');
});

test('L1: English / code-path recall unchanged', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', origin: 'human', content: 'run npm test with node@22 ABI' });
  const rows = svc.retrieveForProject('p1', { taskContext: 'npm test' });
  assert.ok(rows.some((r) => /npm test/.test(r.content)), 'English tokens unaffected');
});

test('L1 precision: exact-token hit ranks before prefix-only noise (two-pass kill-test)', (t) => {
  const svc = setupL1(t);
  // Kill-test design (Codex R2): exact item LOW importance, prefix-only noise HIGH.
  // Under a (buggy) pure-prefix query both match `"메모리"*` and the `importance DESC`
  // tie-break would push the noise AHEAD of the exact hit -> the final assert FAILS.
  // two-pass returns the exact hit from pass 1 first regardless of importance -> PASSES.
  // (Without this importance skew the assert passes even for pure-prefix, proving nothing.)
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', importance: 1, content: '메모리 정책 핵심 규칙' });
  for (let i = 0; i < 15; i++) {
    svc.createMemoryItem({ projectId: 'p1', kind: 'pitfall', origin: 'human', importance: 10, content: `메모리지옥 회피 사례 ${i}` });
  }
  const rows = svc.retrieveForProject('p1', { taskContext: '메모리', limit: 12 });
  const exactIdx = rows.findIndex((r) => /메모리 정책 핵심/.test(r.content));
  const firstNoiseIdx = rows.findIndex((r) => /메모리지옥/.test(r.content));
  assert.ok(exactIdx >= 0, 'exact-token item survives top-K');
  assert.ok(firstNoiseIdx === -1 || exactIdx < firstNoiseIdx, 'exact-token hit ranks before any prefix-only noise');
});

test('L1: inflected query does NOT reach stem content (documented asymmetry)', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', content: '메모리 정리 절차' });
  // exact "메모리를" != token "메모리"; prefix "메모리를"* cannot reach the shorter stem.
  // Queries are normally stems, so this asymmetry is the accepted A1 limitation.
  const rows = svc.retrieveForProject('p1', { taskContext: '메모리를' });
  assert.ok(!rows.some((r) => /메모리 정리 절차/.test(r.content)), 'inflected query does not reach stem-token content');
});

test('L1: FTS-operator / malicious input is sanitized — returns array, no throw', (t) => {
  const svc = setupL1(t);
  svc.createMemoryItem({ projectId: 'p1', kind: 'convention', origin: 'human', content: '메모리 보안 규칙' });
  const rows = svc.retrieveForProject('p1', { taskContext: '메모리" OR (SELECT 1) AND * NEAR' });
  assert.ok(Array.isArray(rows), 'tokens are quoted + params bound -> no throw');
});

// ---------------------------------------------------------------------------
// L2 (Master user memory)
// ---------------------------------------------------------------------------

test('L2: 조사-inflected content is reachable by a stem query', (t) => {
  const svc = setupL2(t);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', content: '보고서를 한국어로 작성한다' });
  const rows = svc.retrieve('user', { taskContext: '보고서' });
  assert.ok(rows.some((r) => /보고서를/.test(r.content)), 'stem 보고서 matches inflected 보고서를');
});

test('L2: exact-token content still matches (no regression)', (t) => {
  const svc = setupL2(t);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', content: '보고서 양식 통일' });
  const rows = svc.retrieve('user', { taskContext: '보고서' });
  assert.ok(rows.some((r) => /보고서 양식/.test(r.content)), 'standalone 보고서 token still matches');
});

test('L2: 2-char stem query matches via prefix', (t) => {
  const svc = setupL2(t);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', content: '회의록 공유 규칙' });
  const rows = svc.retrieve('user', { taskContext: '회의' });
  assert.ok(rows.some((r) => /회의록/.test(r.content)), '2-char stem 회의 matches 회의록');
});

test('L2: English recall unchanged (mirror of L1)', (t) => {
  const svc = setupL2(t);
  svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', content: 'always reply with concise answers' });
  const rows = svc.retrieve('user', { taskContext: 'concise reply' });
  assert.ok(rows.some((r) => /concise/.test(r.content)), 'English tokens unaffected');
});

test('L2 precision: exact-token hit ranks before prefix-only noise (two-pass kill-test)', (t) => {
  const svc = setupL2(t);
  // exact item LOW importance, prefix-only noise HIGH — see L1 kill-test note (Codex R2).
  svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', importance: 1, content: '보고서 작성 규칙 핵심' });
  for (let i = 0; i < 15; i++) {
    svc.createMemoryItem({ scope: 'user', kind: 'preference', origin: 'human', importance: 10, content: `보고서양식 변형 ${i}` });
  }
  const rows = svc.retrieve('user', { taskContext: '보고서', limit: 12 });
  const exactIdx = rows.findIndex((r) => /보고서 작성 규칙/.test(r.content));
  const firstNoiseIdx = rows.findIndex((r) => /보고서양식/.test(r.content));
  assert.ok(exactIdx >= 0, 'exact-token item survives top-K');
  assert.ok(firstNoiseIdx === -1 || exactIdx < firstNoiseIdx, 'exact-token hit ranks before prefix-only noise');
});
