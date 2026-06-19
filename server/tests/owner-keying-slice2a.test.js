'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { createMemoryService } = require('../services/memoryService');
const { createMasterMemoryService } = require('../services/masterMemoryService');
const { runSlice2aMerge } = require('../services/ownerMergeSlice2a');
const { createDatabase } = require('../db/database');

const migrationsDir = path.join(__dirname, '../db/migrations');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function setupDbThrough033(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-ok-slice2a-'));
  const db = new Database(path.join(dir, 'test.db'));
  db.pragma('foreign_keys = ON');
  applyMigrationsThrough(db, 33);

  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return db;
}

function applyMigrationsThrough(db, maxVersion) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const files = fs.readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const version = Number.parseInt(file.split('_')[0], 10);
    if (version > maxVersion) break;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
    })();
  }
}

function applySlice2a(db) {
  const sql034 = fs.readFileSync(path.join(migrationsDir, '034_owner_keying_slice2a.sql'), 'utf8');
  db.transaction(() => {
    runSlice2aMerge(db);
    db.exec(sql034);
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (34)').run();
  })();
}

function seedItem(db, overrides = {}) {
  const content = overrides.content || `content ${crypto.randomUUID()}`;
  const id = overrides.id || crypto.randomUUID();
  const kind = overrides.kind || (overrides.factKey ? 'fact' : 'pattern');
  const row = {
    id,
    scope: overrides.scope || 'user',
    project_id: overrides.projectId || null,
    kind,
    fact_key: kind === 'fact' ? overrides.factKey : null,
    content,
    content_hash: overrides.contentHash || sha256(content),
    evidence_json: JSON.stringify(overrides.evidence || {}),
    origin: overrides.origin || 'deterministic',
    source_count: overrides.sourceCount ?? 1,
    confidence: overrides.confidence ?? 0.5,
    importance: overrides.importance ?? 5,
    pinned: overrides.pinned ? 1 : 0,
    status: overrides.status || 'active',
    created_at: overrides.createdAt || '2026-01-01 00:00:00',
    owner_type: overrides.ownerType || 'user',
    owner_id: overrides.ownerId || 'user',
  };

  db.prepare(`
    INSERT INTO master_memory_items (
      id, scope, project_id, kind, fact_key, content, content_hash,
      evidence_json, origin, source_count, confidence, importance, pinned,
      status, created_at, owner_type, owner_id
    ) VALUES (
      @id, @scope, @project_id, @kind, @fact_key, @content, @content_hash,
      @evidence_json, @origin, @source_count, @confidence, @importance, @pinned,
      @status, @created_at, @owner_type, @owner_id
    )
  `).run(row);

  return row;
}

function seedCandidate(db, overrides = {}) {
  const row = {
    id: overrides.id || crypto.randomUUID(),
    scope: overrides.scope || 'user',
    rule: overrides.rule || 'R4',
    raw_json: JSON.stringify(overrides.rawJson || { content: 'candidate', kind: 'pattern' }),
    dedup_key: overrides.dedupKey || crypto.randomUUID(),
    status: overrides.status || 'pending',
    created_at: overrides.createdAt || '2026-01-01 00:00:00',
    owner_type: overrides.ownerType || 'user',
    owner_id: overrides.ownerId || 'user',
  };

  db.prepare(`
    INSERT INTO master_memory_candidates (
      id, scope, rule, raw_json, dedup_key, status, created_at, owner_type, owner_id
    ) VALUES (
      @id, @scope, @rule, @raw_json, @dedup_key, @status, @created_at, @owner_type, @owner_id
    )
  `).run(row);

  return row;
}

function activeItemsByHash(db, hash) {
  return db.prepare(`
    SELECT *
    FROM master_memory_items
    WHERE content_hash = ? AND status = 'active'
    ORDER BY rowid_pk ASC
  `).all(hash);
}

function allItemsByIds(db, ids) {
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT *
    FROM master_memory_items
    WHERE id IN (${placeholders})
    ORDER BY id ASC
  `).all(...ids);
}

function assertNoL2Conflicts(db) {
  const conflicts = createMemoryService(db).detectCrossScopeConflicts();
  assert.deepEqual(conflicts.items, []);
  assert.deepEqual(conflicts.candidates, []);
}

function assertSqliteUnique(fn) {
  assert.throws(fn, (err) => err && err.code === 'SQLITE_CONSTRAINT_UNIQUE');
}

test('slice2a merges active content_hash duplicates and preserves cross_project provenance', (t) => {
  const db = setupDbThrough033(t);
  const content = 'Use the same migration helper for sqlite changes.';
  const hash = sha256(content);
  const user = seedItem(db, {
    id: 'content-user',
    scope: 'user',
    content,
    contentHash: hash,
    origin: 'deterministic',
    sourceCount: 2,
    confidence: 0.9,
    importance: 8,
    evidence: { candidate_ids: ['cand-user'], run_ids: ['run-user'], source_content_hash: 'source-user' },
  });
  const cross = seedItem(db, {
    id: 'content-cross',
    scope: 'cross_project',
    projectId: 'proj-cross',
    content,
    contentHash: hash,
    origin: 'llm_candidate',
    sourceCount: 3,
    confidence: 0.4,
    importance: 5,
    evidence: { candidate_ids: ['cand-cross'], run_ids: ['run-cross'], source_content_hashes: ['source-cross'] },
  });

  applySlice2a(db);

  const active = activeItemsByHash(db, hash);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, user.id);
  assert.equal(active[0].source_count, 5);

  const loser = db.prepare('SELECT * FROM master_memory_items WHERE id=?').get(cross.id);
  assert.equal(loser.status, 'superseded');
  assert.equal(loser.superseded_by, user.id);
  assert.ok(loser.valid_to);

  const evidence = JSON.parse(active[0].evidence_json);
  assert.equal(evidence.slice2a_merged, true);
  assert.equal(evidence.cross_project, true);
  assert.deepEqual(evidence.candidate_ids.sort(), ['cand-cross', 'cand-user'].sort());
  assert.deepEqual(evidence.run_ids.sort(), ['run-cross', 'run-user'].sort());
  assert.ok(evidence.source_content_hashes.includes(hash));
  assert.ok(evidence.source_content_hashes.includes('source-user'));
  assert.ok(evidence.source_content_hashes.includes('source-cross'));
  assert.deepEqual(evidence.project_ids, ['proj-cross']);
  assert.deepEqual(evidence.merged_from_ids, [cross.id]);
  assertNoL2Conflicts(db);
});

test('slice2a merges fact_key duplicates with differing content hashes', (t) => {
  const db = setupDbThrough033(t);
  const factKey = 'env.node_version';
  const user = seedItem(db, {
    id: 'fact-user-node22',
    scope: 'user',
    kind: 'fact',
    factKey,
    content: 'node 22',
    origin: 'deterministic',
    confidence: 0.5,
    importance: 5,
  });
  const cross = seedItem(db, {
    id: 'fact-cross-node20',
    scope: 'cross_project',
    kind: 'fact',
    factKey,
    content: 'node 20',
    origin: 'deterministic',
    confidence: 0.9,
    importance: 5,
  });

  applySlice2a(db);

  const active = db.prepare(`
    SELECT *
    FROM master_memory_items
    WHERE fact_key=? AND status='active'
  `).all(factKey);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, cross.id);
  assert.equal(active[0].content, 'node 20');

  const loser = db.prepare('SELECT * FROM master_memory_items WHERE id=?').get(user.id);
  assert.equal(loser.status, 'superseded');
  assert.equal(loser.superseded_by, cross.id);

  const evidence = JSON.parse(active[0].evidence_json);
  assert.ok(evidence.source_content_hashes.includes(user.content_hash));
  assert.ok(evidence.source_content_hashes.includes(cross.content_hash));
  assertNoL2Conflicts(db);
});

function assertWinnerForTwoRowHashGroup(t, leftOverrides, rightOverrides, expectedId) {
  const db = setupDbThrough033(t);
  const content = 'Winner ordering shared content.';
  const hash = sha256(content);
  seedItem(db, {
    id: 'left',
    scope: 'user',
    content,
    contentHash: hash,
    ...leftOverrides,
  });
  seedItem(db, {
    id: 'right',
    scope: 'cross_project',
    content,
    contentHash: hash,
    ...rightOverrides,
  });

  applySlice2a(db);
  const active = activeItemsByHash(db, hash);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, expectedId);
}

test('slice2a winner tiebreak: human origin beats higher score (O13 invariant)', (t) => {
  // human conf=0.4/imp=5 (score=2.0) must beat deterministic conf=0.9/imp=5 (score=4.5)
  assertWinnerForTwoRowHashGroup(
    t,
    { confidence: 0.4, importance: 5, origin: 'human' },
    { confidence: 0.9, importance: 5, origin: 'deterministic' },
    'left',
  );
});

test('slice2a winner tiebreak: origin decides when scores tie', (t) => {
  assertWinnerForTwoRowHashGroup(
    t,
    { confidence: 0.5, importance: 6, origin: 'deterministic' },
    { confidence: 0.5, importance: 6, origin: 'human' },
    'right',
  );
});

test('slice2a winner tiebreak: pinned decides when score and origin tie', (t) => {
  assertWinnerForTwoRowHashGroup(
    t,
    { confidence: 0.5, importance: 6, origin: 'deterministic', pinned: 0 },
    { confidence: 0.5, importance: 6, origin: 'deterministic', pinned: 1 },
    'right',
  );
});

test('slice2a winner tiebreak: created_at decides when score origin and pinned tie', (t) => {
  assertWinnerForTwoRowHashGroup(
    t,
    { confidence: 0.5, importance: 6, origin: 'deterministic', pinned: 0, createdAt: '2026-01-02 00:00:00' },
    { confidence: 0.5, importance: 6, origin: 'deterministic', pinned: 0, createdAt: '2026-01-01 00:00:00' },
    'right',
  );
});

test('slice2a keeps human and pinned content recoverable through superseded rows', (t) => {
  const db = setupDbThrough033(t);
  const human = seedItem(db, {
    id: 'protect-human',
    scope: 'user',
    kind: 'fact',
    factKey: 'preference.shell',
    content: 'Human prefers zsh.',
    origin: 'human',
    confidence: 0.8,
    importance: 5,
  });
  const llm = seedItem(db, {
    id: 'protect-llm',
    scope: 'cross_project',
    kind: 'fact',
    factKey: 'preference.shell',
    content: 'LLM guessed fish.',
    origin: 'llm_candidate',
    confidence: 0.8,
    importance: 5,
  });
  const pinned = seedItem(db, {
    id: 'protect-pinned',
    scope: 'cross_project',
    kind: 'fact',
    factKey: 'preference.editor',
    content: 'Pinned deterministic value.',
    origin: 'deterministic',
    confidence: 0.9,
    importance: 8,
    pinned: 1,
  });
  const humanLowerScore = seedItem(db, {
    id: 'protect-human-lower-score',
    scope: 'user',
    kind: 'fact',
    factKey: 'preference.editor',
    content: 'Human lower score value.',
    origin: 'human',
    confidence: 0.5,
    importance: 5,
  });

  applySlice2a(db);

  const shellWinner = db.prepare("SELECT * FROM master_memory_items WHERE fact_key='preference.shell' AND status='active'").get();
  assert.equal(shellWinner.id, human.id);

  const editorWinner = db.prepare("SELECT * FROM master_memory_items WHERE fact_key='preference.editor' AND status='active'").get();
  // Human must win over pinned-deterministic regardless of score.
  assert.equal(editorWinner.id, humanLowerScore.id);
  // pinned flag inherited from the pinned-deterministic loser.
  assert.equal(editorWinner.pinned, 1);
  // human permanence: valid_to must be null.
  assert.equal(editorWinner.valid_to, null);

  const shellRows = allItemsByIds(db, [human.id, llm.id]);
  assert.deepEqual(new Set(shellRows.map((row) => row.content)), new Set(['Human prefers zsh.', 'LLM guessed fish.']));
  const editorRows = allItemsByIds(db, [pinned.id, humanLowerScore.id]);
  assert.deepEqual(new Set(editorRows.map((row) => row.content)), new Set(['Pinned deterministic value.', 'Human lower score value.']));

  const shellEvidence = JSON.parse(shellWinner.evidence_json);
  assert.ok(shellEvidence.merged_from_ids.includes(llm.id));
  const editorEvidence = JSON.parse(editorWinner.evidence_json);
  // humanLowerScore is the winner; pinned is the loser — so merged_from_ids must contain pinned.id.
  assert.ok(editorEvidence.merged_from_ids.includes(pinned.id));
});

test('slice2a deletes duplicate candidate losers across all statuses', (t) => {
  const db = setupDbThrough033(t);
  const first = seedCandidate(db, {
    id: 'cand-first',
    scope: 'user',
    rule: 'R4',
    dedupKey: 'candidate-dup',
    createdAt: '2026-01-01 00:00:00',
  });
  const loser = seedCandidate(db, {
    id: 'cand-loser',
    scope: 'cross_project',
    rule: 'R4',
    dedupKey: 'candidate-dup',
    status: 'rejected',
    createdAt: '2026-01-02 00:00:00',
  });

  applySlice2a(db);

  const rows = db.prepare(`
    SELECT *
    FROM master_memory_candidates
    WHERE owner_type='user' AND owner_id='user' AND rule='R4' AND dedup_key='candidate-dup'
  `).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM master_memory_candidates WHERE id=?').get(loser.id).n, 0);
  assertNoL2Conflicts(db);
});

test('slice2a owner-unique indexes exist, reject fresh owner duplicates, and keep old indexes', (t) => {
  const db = setupDbThrough033(t);
  const content = 'Owner unique content.';
  const contentHash = sha256(content);
  seedItem(db, { id: 'idx-content', scope: 'user', content, contentHash });
  seedItem(db, { id: 'idx-fact', scope: 'user', kind: 'fact', factKey: 'idx.fact', content: 'idx fact user' });
  seedCandidate(db, { id: 'idx-cand', scope: 'user', rule: 'R4', dedupKey: 'idx-candidate' });

  applySlice2a(db);

  const itemIndexes = db.prepare('PRAGMA index_list(master_memory_items)').all().map((row) => row.name);
  assert.ok(itemIndexes.includes('idx_master_memory_owner_content_hash'));
  assert.ok(itemIndexes.includes('idx_master_memory_owner_factkey'));
  assert.ok(itemIndexes.includes('idx_master_memory_content_hash'));
  assert.ok(itemIndexes.includes('idx_master_memory_factkey'));

  const candidateIndexes = db.prepare('PRAGMA index_list(master_memory_candidates)').all();
  assert.ok(candidateIndexes.map((row) => row.name).includes('idx_master_memory_candidates_owner_dedup'));
  const oldCandidateUnique = candidateIndexes.some((row) => {
    if (!row.unique || row.name === 'idx_master_memory_candidates_owner_dedup') return false;
    const cols = db.prepare(`PRAGMA index_info(${row.name})`).all().map((info) => info.name);
    return cols.join('|') === 'rule|scope|dedup_key';
  });
  assert.equal(oldCandidateUnique, true);

  assertSqliteUnique(() => seedItem(db, {
    id: 'idx-content-dup',
    scope: 'cross_project',
    content,
    contentHash,
  }));
  assertSqliteUnique(() => seedItem(db, {
    id: 'idx-fact-dup',
    scope: 'cross_project',
    kind: 'fact',
    factKey: 'idx.fact',
    content: 'idx fact cross',
  }));
  assertSqliteUnique(() => seedCandidate(db, {
    id: 'idx-cand-dup',
    scope: 'cross_project',
    rule: 'R4',
    dedupKey: 'idx-candidate',
  }));
});

test('slice2a leaves scope-keyed reads and dual-write owner fields working', (t) => {
  const db = setupDbThrough033(t);
  const content = 'Scope keyed winner retrieval target.';
  const hash = sha256(content);
  const winner = seedItem(db, {
    id: 'read-winner',
    scope: 'user',
    content,
    contentHash: hash,
    origin: 'human',
    confidence: 0.9,
    importance: 8,
  });
  seedItem(db, {
    id: 'read-loser',
    scope: 'cross_project',
    projectId: 'proj-read',
    content,
    contentHash: hash,
    origin: 'deterministic',
    confidence: 0.9,
    importance: 8,
  });
  const fact = seedItem(db, {
    id: 'read-fact',
    scope: 'user',
    kind: 'fact',
    factKey: 'read.fact',
    content: 'read fact winner',
    origin: 'human',
  });
  seedItem(db, {
    id: 'read-fact-loser',
    scope: 'cross_project',
    kind: 'fact',
    factKey: 'read.fact',
    content: 'read fact loser',
    origin: 'deterministic',
  });

  applySlice2a(db);

  const master = createMasterMemoryService(db);
  const retrieved = master.retrieve('user', { taskContext: 'Scope keyed winner retrieval target', limit: 5 });
  assert.ok(retrieved.some((row) => row.id === winner.id));
  const listed = master.listForScope('user');
  assert.ok(listed.some((row) => row.id === winner.id));
  assert.ok(listed.some((row) => row.id === fact.id && row.fact_key === 'read.fact'));

  assert.deepEqual(createMemoryService(db).checkOwnerParity(), []);

  const fresh = master.createMemoryItem({
    scope: 'user',
    kind: 'pattern',
    content: 'Fresh dual-write slice2a item.',
    origin: 'human',
  });
  const freshRow = db.prepare('SELECT owner_type, owner_id FROM master_memory_items WHERE id=?').get(fresh.id);
  assert.deepEqual(freshRow, { owner_type: 'user', owner_id: 'user' });

  const candHash = sha256('Fresh dual-write slice2a candidate.');
  const candidate = master.createCandidate({
    scope: 'cross_project',
    rule: 'XPROJECT',
    rawJson: { content: 'Fresh dual-write slice2a candidate.', kind: 'pattern', content_hash: candHash },
    dedupKey: `fresh-${candHash}`,
  });
  const candRow = db.prepare('SELECT owner_type, owner_id FROM master_memory_candidates WHERE id=?').get(candidate.id);
  assert.deepEqual(candRow, { owner_type: 'user', owner_id: 'user' });
});

test('slice2a merge routine is idempotent after conflicts are clean', (t) => {
  const db = setupDbThrough033(t);
  const content = 'Idempotent duplicate content.';
  const hash = sha256(content);
  seedItem(db, { id: 'idem-user', scope: 'user', content, contentHash: hash, confidence: 0.9, importance: 8 });
  seedItem(db, { id: 'idem-cross', scope: 'cross_project', content, contentHash: hash, confidence: 0.3, importance: 4 });
  seedCandidate(db, { id: 'idem-cand-user', scope: 'user', dedupKey: 'idem-cand' });
  seedCandidate(db, { id: 'idem-cand-cross', scope: 'cross_project', dedupKey: 'idem-cand' });

  applySlice2a(db);
  const beforeItems = db.prepare(`
    SELECT id, status, superseded_by, valid_to, source_count, evidence_json
    FROM master_memory_items
    ORDER BY id
  `).all();
  const beforeCandidates = db.prepare('SELECT id, status FROM master_memory_candidates ORDER BY id').all();

  runSlice2aMerge(db);

  const afterItems = db.prepare(`
    SELECT id, status, superseded_by, valid_to, source_count, evidence_json
    FROM master_memory_items
    ORDER BY id
  `).all();
  const afterCandidates = db.prepare('SELECT id, status FROM master_memory_candidates ORDER BY id').all();
  assert.deepEqual(afterItems, beforeItems);
  assert.deepEqual(afterCandidates, beforeCandidates);
  assertNoL2Conflicts(db);
});

test('slice2a merge routine is a no-op on a no-duplicate baseline', (t) => {
  const db = setupDbThrough033(t);
  seedItem(db, { id: 'baseline-user', scope: 'user', content: 'baseline user' });
  seedItem(db, { id: 'baseline-cross', scope: 'cross_project', content: 'baseline cross' });
  seedCandidate(db, { id: 'baseline-cand-user', scope: 'user', dedupKey: 'baseline-user' });
  seedCandidate(db, { id: 'baseline-cand-cross', scope: 'cross_project', dedupKey: 'baseline-cross' });

  const beforeItems = db.prepare('SELECT id, status, source_count, evidence_json FROM master_memory_items ORDER BY id').all();
  const beforeCandidateCount = db.prepare('SELECT COUNT(*) AS n FROM master_memory_candidates').get().n;

  runSlice2aMerge(db);

  const afterItems = db.prepare('SELECT id, status, source_count, evidence_json FROM master_memory_items ORDER BY id').all();
  const afterCandidateCount = db.prepare('SELECT COUNT(*) AS n FROM master_memory_candidates').get().n;
  assert.deepEqual(afterItems, beforeItems);
  assert.equal(afterCandidateCount, beforeCandidateCount);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM master_memory_items WHERE status='superseded'").get().n, 0);
  assertNoL2Conflicts(db);
});

test('slice2a strong invariants: human wins adversarially over high-score llm, pinned inherited, valid_to null', (t) => {
  // Adversarial: llm conf=1.0/imp=10 (score=10) vs human conf=0.4/imp=5 (score=2).
  // O13 + PR5: human must always win, regardless of score difference.
  const db = setupDbThrough033(t);
  const factKey = 'adversarial.invariant';
  const humanRow = seedItem(db, {
    id: 'adv-human',
    scope: 'user',
    kind: 'fact',
    factKey,
    content: 'Human value — must survive.',
    origin: 'human',
    confidence: 0.4,
    importance: 5,
    pinned: 0,
  });
  const llmRow = seedItem(db, {
    id: 'adv-llm',
    scope: 'cross_project',
    kind: 'fact',
    factKey,
    content: 'LLM guess — must lose.',
    origin: 'llm_candidate',
    confidence: 1.0,
    importance: 10,
    pinned: 1,
  });

  applySlice2a(db);

  const active = db.prepare(`
    SELECT * FROM master_memory_items WHERE fact_key=? AND status='active'
  `).get(factKey);

  // Invariant 1: if group has human row → surviving active row must have origin='human'.
  assert.equal(active.origin, 'human', 'human origin must survive (O13)');
  // Invariant 2: if group has pinned row → surviving active row must have pinned=1.
  assert.equal(active.pinned, 1, 'pinned must be inherited from loser');
  // Invariant 3: if group has human row → surviving valid_to must be null.
  assert.equal(active.valid_to, null, 'human permanence: valid_to must be null');
  // Specific: human row is the winner.
  assert.equal(active.id, humanRow.id, 'human row must be the winner (not high-score llm)');

  const loser = db.prepare('SELECT * FROM master_memory_items WHERE id=?').get(llmRow.id);
  assert.equal(loser.status, 'superseded');
  assert.equal(loser.superseded_by, humanRow.id);
});

test('slice2a pinned winner: pinned row wins over higher-score non-pinned non-human', (t) => {
  // When no human row is present, pinned beats score.
  const db = setupDbThrough033(t);
  const factKey = 'pinned.invariant';
  const pinnedRow = seedItem(db, {
    id: 'pinned-winner',
    scope: 'cross_project',
    kind: 'fact',
    factKey,
    content: 'Pinned deterministic — must win.',
    origin: 'deterministic',
    confidence: 0.3,
    importance: 4,
    pinned: 1,
  });
  seedItem(db, {
    id: 'high-score-loser',
    scope: 'user',
    kind: 'fact',
    factKey,
    content: 'High score non-pinned — must lose.',
    origin: 'llm_candidate',
    confidence: 0.9,
    importance: 9,
    pinned: 0,
  });

  applySlice2a(db);

  const active = db.prepare(`
    SELECT * FROM master_memory_items WHERE fact_key=? AND status='active'
  `).get(factKey);
  assert.equal(active.id, pinnedRow.id, 'pinned row must win over higher-score non-pinned');
  assert.equal(active.pinned, 1);
});

// Slice2b service logic runs on top of the slice2a owner-unique structure:
// remember({scope:'cross_project'}) with content already active under 'user'
// now owner-merges into the existing row instead of returning the slice2a
// fail-safe null.
test('slice2a owner indexes + slice2b service: cross_project remember owner-merges into user row', (t) => {
  const db = setupDbThrough033(t);
  const content = 'Dual-owner remember fail-safe content.';

  // Seed the content under 'user' scope first.
  const userRow = seedItem(db, {
    id: 'remember-user-existing',
    scope: 'user',
    content,
    origin: 'human',
    confidence: 0.9,
    importance: 5,
  });

  applySlice2a(db); // installs owner-unique index

  // After slice2a the owner-unique index blocks a second active row with the
  // same (owner, hash) regardless of scope; slice2b owner-keyed reads fold it
  // into the existing row before the duplicate insert path escapes.
  const master = createMasterMemoryService(db);
  const result = master.remember({ scope: 'cross_project', content, kind: 'preference' });

  assert.equal(result.id, userRow.id, 'cross-scope remember returns the existing owner row');
  assert.equal(result.source_count, 2);

  // Existing user row remains active and human-origin.
  const existing = db.prepare('SELECT * FROM master_memory_items WHERE id=?').get(userRow.id);
  assert.equal(existing.status, 'active');
  assert.equal(existing.scope, 'user');
  assert.equal(existing.origin, 'human');

  // No second active row was created.
  const activeRows = db.prepare(
    "SELECT COUNT(*) AS n FROM master_memory_items WHERE content_hash=? AND status='active'"
  ).get(userRow.content_hash);
  assert.equal(activeRows.n, 1, 'only the original user row must remain active');
});

test('database migrate hook runs slice2a merge before applying migration 034 indexes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-ok-slice2a-hook-'));
  const dbPath = path.join(dir, 'test.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  applyMigrationsThrough(raw, 33);
  const content = 'Hook migration duplicate content.';
  const hash = sha256(content);
  seedItem(raw, { id: 'hook-user', scope: 'user', content, contentHash: hash, confidence: 0.9, importance: 8 });
  seedItem(raw, { id: 'hook-cross', scope: 'cross_project', content, contentHash: hash, confidence: 0.3, importance: 4 });
  seedCandidate(raw, { id: 'hook-cand-user', scope: 'user', dedupKey: 'hook-cand' });
  seedCandidate(raw, { id: 'hook-cand-cross', scope: 'cross_project', dedupKey: 'hook-cand' });
  raw.close();

  const { db, migrate, close } = createDatabase(dbPath);
  t.after(() => { try { close(); } catch { /* ignore */ } });
  migrate();

  // 034 was the max when slice2a landed; slice3 (036) is now also applied.
  assert.ok(db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version >= 34);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM master_memory_items WHERE content_hash=? AND status='active'").get(hash).n, 1);
  assert.equal(db.prepare("SELECT status FROM master_memory_items WHERE id='hook-cross'").get().status, 'superseded');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM master_memory_candidates WHERE dedup_key='hook-cand'").get().n, 1);
  const indexNames = db.prepare('PRAGMA index_list(master_memory_items)').all().map((row) => row.name);
  assert.ok(indexNames.includes('idx_master_memory_owner_content_hash'));
  assertNoL2Conflicts(db);
});
