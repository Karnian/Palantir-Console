'use strict';

const EVIDENCE_ID_CAP = 20;

function parseEvidence(json) {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeString(value, max = 128) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

function appendDedup(out, values, max = EVIDENCE_ID_CAP) {
  for (const value of values) {
    const safe = safeString(value, 512);
    if (!safe || out.includes(safe)) continue;
    if (out.length >= max) break;
    out.push(safe);
  }
  return out;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function safeWinnerEvidenceBase(base) {
  const out = {};
  if (Number.isFinite(base.schema_version)) out.schema_version = base.schema_version;
  for (const key of ['origin', 'rule', 'original_kind', 'source_content_hash']) {
    const value = safeString(base[key]);
    if (value) out[key] = value;
  }
  for (const [key, value] of Object.entries(base)) {
    if (key in out) continue;
    if (key === 'candidate_ids' || key === 'run_ids' || key === 'source_content_hashes' || key === 'project_ids' || key === 'merged_from_ids') continue;
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function buildMergedEvidence(winner, losers) {
  const rows = [winner, ...losers];
  const evidences = rows.map((row) => parseEvidence(row.evidence_json));
  const base = safeWinnerEvidenceBase(evidences[0] || {});

  const candidateIds = [];
  const runIds = [];
  const sourceContentHashes = [];
  const projectIds = [];
  const mergedFromIds = [];

  for (const evidence of evidences) {
    appendDedup(candidateIds, stringArray(evidence.candidate_ids));
    appendDedup(runIds, stringArray(evidence.run_ids));
    appendDedup(sourceContentHashes, stringArray(evidence.source_content_hashes));
    appendDedup(sourceContentHashes, [evidence.source_content_hash]);
    appendDedup(projectIds, stringArray(evidence.project_ids));
    appendDedup(mergedFromIds, stringArray(evidence.merged_from_ids));
  }

  appendDedup(sourceContentHashes, rows.map((row) => row.content_hash));
  appendDedup(projectIds, rows.map((row) => row.project_id).filter(Boolean));
  appendDedup(mergedFromIds, losers.map((row) => row.id));

  const anyCrossProject = rows.some((row) => row.scope === 'cross_project')
    || evidences.some((evidence) => evidence.cross_project === true);

  if (candidateIds.length) base.candidate_ids = candidateIds;
  if (runIds.length) base.run_ids = runIds;
  if (sourceContentHashes.length) base.source_content_hashes = sourceContentHashes;
  if (projectIds.length) base.project_ids = projectIds;
  if (mergedFromIds.length) base.merged_from_ids = mergedFromIds;
  if (anyCrossProject) base.cross_project = true;
  base.slice2a_merged = true;

  return JSON.stringify(base);
}

function itemOrderSql() {
  // O13 + PR5 invariant: human authority and pinned permanence trump score.
  // A non-human high-score row must never supersede a human row.
  return `
    ORDER BY
      CASE origin WHEN 'human' THEN 1 ELSE 0 END DESC,
      pinned DESC,
      (confidence * importance) DESC,
      CASE origin
        WHEN 'deterministic' THEN 2
        WHEN 'llm_candidate' THEN 1
        ELSE 0
      END DESC,
      created_at ASC,
      rowid_pk ASC
  `;
}

function processItemGroups(db, keyColumn, loserScopes) {
  const where = keyColumn === 'fact_key'
    ? "status = 'active' AND fact_key IS NOT NULL"
    : "status = 'active'";

  const groups = db.prepare(`
    SELECT owner_type, owner_id, ${keyColumn} AS key_value, COUNT(*) AS n
    FROM master_memory_items
    WHERE ${where}
    GROUP BY owner_type, owner_id, ${keyColumn}
    HAVING COUNT(*) > 1
    ORDER BY owner_type ASC, owner_id ASC, ${keyColumn} ASC
  `).all();

  const rowsByKey = db.prepare(`
    SELECT *
    FROM master_memory_items
    WHERE status = 'active'
      AND owner_type IS @owner_type
      AND owner_id IS @owner_id
      AND ${keyColumn} IS @key_value
    ${itemOrderSql()}
  `);

  const updateWinner = db.prepare(`
    UPDATE master_memory_items
    SET source_count = @source_count,
        evidence_json = @evidence_json,
        pinned = @pinned,
        valid_to = @valid_to,
        updated_at = datetime('now')
    WHERE id = @id
      AND status = 'active'
  `);

  const supersedeLoser = db.prepare(`
    UPDATE master_memory_items
    SET status = 'superseded',
        superseded_by = @winner_id,
        valid_to = datetime('now'),
        updated_at = datetime('now')
    WHERE id = @id
      AND status = 'active'
  `);

  for (const group of groups) {
    const rows = rowsByKey.all({
      owner_type: group.owner_type,
      owner_id: group.owner_id,
      key_value: group.key_value,
    });
    if (rows.length < 2) continue;

    const [winner, ...losers] = rows;
    const sourceCount = rows.reduce((sum, row) => sum + (Number(row.source_count) || 0), 0);
    const evidenceJson = buildMergedEvidence(winner, losers);

    // Protection inheritance (O13 + PR5): if ANY row in the group is pinned,
    // the winner inherits pinned=1. If ANY row is human-origin, winner.valid_to
    // is cleared to NULL (human permanence). This is independent of sort order —
    // e.g. a pinned-deterministic loser's "keep this" flag must survive on the
    // human winner even when the human row already ranked first.
    const groupHasPinned = rows.some((row) => row.pinned === 1);
    const groupHasHuman = rows.some((row) => row.origin === 'human');
    const inheritedPinned = (winner.pinned === 1 || groupHasPinned) ? 1 : 0;
    const inheritedValidTo = groupHasHuman ? null : winner.valid_to;

    const winnerRes = updateWinner.run({
      id: winner.id,
      source_count: sourceCount,
      evidence_json: evidenceJson,
      pinned: inheritedPinned,
      valid_to: inheritedValidTo,
    });
    if (winnerRes.changes !== 1) {
      throw new Error(`slice2a merge failed to update winner ${winner.id}`);
    }

    for (const loser of losers) {
      const loserRes = supersedeLoser.run({ id: loser.id, winner_id: winner.id });
      if (loserRes.changes !== 1) {
        throw new Error(`slice2a merge failed to supersede loser ${loser.id}`);
      }
      loserScopes.add(loser.scope);
    }
  }
}

function mergeCandidateGroups(db) {
  const groups = db.prepare(`
    SELECT owner_type, owner_id, rule, dedup_key, COUNT(*) AS n
    FROM master_memory_candidates
    GROUP BY owner_type, owner_id, rule, dedup_key
    HAVING COUNT(*) > 1
    ORDER BY owner_type ASC, owner_id ASC, rule ASC, dedup_key ASC
  `).all();

  const rowsByKey = db.prepare(`
    SELECT rowid AS _rowid, id
    FROM master_memory_candidates
    WHERE owner_type IS @owner_type
      AND owner_id IS @owner_id
      AND rule IS @rule
      AND dedup_key IS @dedup_key
    ORDER BY created_at ASC, rowid ASC, id ASC
  `);

  const deleteCandidate = db.prepare('DELETE FROM master_memory_candidates WHERE id = ?');

  for (const group of groups) {
    const rows = rowsByKey.all({
      owner_type: group.owner_type,
      owner_id: group.owner_id,
      rule: group.rule,
      dedup_key: group.dedup_key,
    });
    if (rows.length < 2) continue;
    for (const loser of rows.slice(1)) {
      const res = deleteCandidate.run(loser.id);
      if (res.changes !== 1) {
        throw new Error(`slice2a merge failed to delete candidate loser ${loser.id}`);
      }
    }
  }
}

function bumpMaintenanceRevisions(db, scopes) {
  if (!scopes.size) return;
  const bump = db.prepare(`
    INSERT INTO master_memory_revision(scope, revision, owner_type, owner_id)
    VALUES (?, 1, 'user', 'user')
    ON CONFLICT(scope) DO UPDATE SET revision = revision + 1
  `);

  // One-time slice-2a maintenance bump: the active set changed because losers
  // were superseded. This does not alter normal L2 revision bump rules.
  for (const scope of Array.from(scopes).sort()) {
    bump.run(scope);
  }
}

function verifyNoOwnerConflicts(db) {
  const hashConflicts = db.prepare(`
    SELECT owner_type, owner_id, content_hash, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
    FROM master_memory_items
    WHERE status = 'active'
    GROUP BY owner_type, owner_id, content_hash
    HAVING COUNT(*) > 1
  `).all();

  const factKeyConflicts = db.prepare(`
    SELECT owner_type, owner_id, fact_key, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
    FROM master_memory_items
    WHERE fact_key IS NOT NULL
      AND status = 'active'
    GROUP BY owner_type, owner_id, fact_key
    HAVING COUNT(*) > 1
  `).all();

  const candidateConflicts = db.prepare(`
    SELECT owner_type, owner_id, rule, dedup_key, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
    FROM master_memory_candidates
    GROUP BY owner_type, owner_id, rule, dedup_key
    HAVING COUNT(*) > 1
  `).all();

  if (hashConflicts.length || factKeyConflicts.length || candidateConflicts.length) {
    const detail = JSON.stringify({
      content_hash: hashConflicts,
      fact_key: factKeyConflicts,
      candidates: candidateConflicts,
    });
    throw new Error(`slice2a owner-key conflicts remain after merge: ${detail}`);
  }
}

function runSlice2aMerge(db) {
  const loserScopes = new Set();
  processItemGroups(db, 'content_hash', loserScopes);
  processItemGroups(db, 'fact_key', loserScopes);
  bumpMaintenanceRevisions(db, loserScopes);
  mergeCandidateGroups(db);
  verifyNoOwnerConflicts(db);
}

module.exports = {
  runSlice2aMerge,
  _private: {
    buildMergedEvidence,
  },
};
