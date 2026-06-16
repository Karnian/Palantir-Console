const crypto = require('node:crypto');
const { sanitizeProposalContent } = require('./memorySanitize');

const TOP_K = 12;
const CHAR_CAP = 2000;
const MAX_QUERY_TERMS = 32;

// PR3a distill defaults (overridable per call).
const DEFAULT_ACTIVE_CAP = 200;        // soft cap: max active items per project
const DEFAULT_CONFIDENCE_CEILING = 0.7; // single-candidate promotions clamp here
const DEFAULT_MAX_LEN = 500;            // promoted content character ceiling
const DISTILL_KIND = 'distill';
// kinds a distiller may produce — NOT 'fact' (R6 owns facts via upsertFact).
const PROMOTABLE_KINDS = new Set(['convention', 'pitfall', 'heuristic', 'constraint']);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function clampImportance(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 5;
  return Math.min(10, Math.max(1, n));
}

// Clamp to [0, ceiling] ⊆ [0,1] with NaN/out-of-range ceiling defended, so no
// caller of the public promote API can drive a value past the 0..1 CHECK and
// roll back the whole batch (Codex SERIOUS 3).
function clampConfidence(value, ceiling) {
  const c = Number.isFinite(ceiling) ? Math.max(0, Math.min(1, ceiling)) : DEFAULT_CONFIDENCE_CEILING;
  const v = Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(v, c));
}

// String-only, length-capped — keeps a crafted candidate from stuffing a huge
// value into the evidence snapshot via raw_json (Codex follow-up NIT).
function shortId(value, max = 128) {
  if (typeof value !== 'string') return null;
  return value.length <= max ? value : value.slice(0, max);
}

// Build the L1 evidence snapshot from the candidate's raw signal (BLOCKER ③:
// keep provenance conservatively — ids/rule/redaction, not untrusted free text).
// `rule` comes from the TRUSTED candidate column, not untrusted raw_json; all
// id-ish fields are string-checked and capped.
function buildPromotionEvidence(candidate, sanitized) {
  let raw = {};
  try {
    const parsed = JSON.parse(candidate.raw_json);
    if (parsed && typeof parsed === 'object') raw = parsed;
  } catch { /* keep {} */ }
  const runIds = [];
  if (raw.fail_run) runIds.push(shortId(raw.fail_run.id));
  if (raw.fix_run) runIds.push(shortId(raw.fix_run.id));
  if (raw.pm_run_id) runIds.push(shortId(raw.pm_run_id));
  return JSON.stringify({
    schema_version: 1,
    redaction_version: sanitized.redactionVersion,
    origin: 'batch_llm',
    rule: candidate.rule || null,
    candidate_ids: [candidate.id],
    task_id: shortId(raw.task_id),
    run_ids: runIds.filter(Boolean),
    redacted: sanitized.redacted,
  });
}

function createMemoryService(db, eventBus) {
  const bumpRevisionStmt = db.prepare(`
    INSERT INTO project_memory_revision(project_id, revision)
    VALUES (?, 1)
    ON CONFLICT(project_id) DO UPDATE SET revision = revision + 1
  `);

  const getRevisionStmt = db.prepare(`
    SELECT revision
    FROM project_memory_revision
    WHERE project_id = ?
  `);

  const insertMemoryItemStmt = db.prepare(`
    INSERT INTO memory_items (
      id,
      project_id,
      kind,
      fact_key,
      content,
      content_hash,
      evidence_json,
      origin,
      source_count,
      confidence,
      importance,
      status
    )
    VALUES (
      @id,
      @projectId,
      @kind,
      @factKey,
      @content,
      @contentHash,
      @evidenceJson,
      @origin,
      @sourceCount,
      @confidence,
      @importance,
      @status
    )
  `);

  const getMemoryItemByIdStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE id = ?
  `);

  const getActiveMemoryItemByHashStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE project_id = ?
      AND content_hash = ?
      AND status = 'active'
  `);

  const mergeMemoryItemByHashStmt = db.prepare(`
    UPDATE memory_items
    SET source_count = source_count + 1,
        updated_at = datetime('now')
    WHERE project_id = ?
      AND content_hash = ?
      AND status = 'active'
  `);

  const fallbackRetrieveStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE project_id = @projectId
      AND status = 'active'
      AND (valid_to IS NULL OR valid_to > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
    LIMIT @k
  `);

  const ftsRetrieveStmt = db.prepare(
    [
      'SELECT mi.*',
      'FROM memory_items mi',
      'JOIN memory_fts ON memory_fts.rowid = mi.rowid_pk',
      'WHERE memory_fts MATCH @q',
      '  AND mi.project_id = @projectId',
      "  AND mi.status = 'active'",
      "  AND (mi.valid_to IS NULL OR mi.valid_to > datetime('now'))",
      // bm25: lower score = more relevant -> ASC. recency tie-break keeps the
      // FTS path consistent with the fallback path's ORDER BY (Codex NIT).
      'ORDER BY bm25(memory_fts) ASC, mi.importance DESC, mi.updated_at DESC',
      'LIMIT @k',
    ].join('\n'),
  );

  const listForProjectStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE project_id = ?
      AND status = 'active'
      AND (valid_to IS NULL OR valid_to > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
  `);

  const getInjectionRecordStmt = db.prepare(`
    SELECT *
    FROM pm_memory_injection
    WHERE pm_run_id = ?
  `);

  const recordInjectionStmt = db.prepare(`
    INSERT INTO pm_memory_injection(pm_run_id, project_id, injected_revision, injected_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(pm_run_id) DO UPDATE SET
      injected_revision = excluded.injected_revision,
      injected_at = excluded.injected_at
  `);

  function _bumpRevision(projectId) {
    bumpRevisionStmt.run(projectId);
  }

  function getRevision(projectId) {
    const row = getRevisionStmt.get(projectId);
    return row ? row.revision : 0;
  }

  function normalizeEvidenceJson(evidenceJson) {
    if (evidenceJson === undefined || evidenceJson === null) {
      return '{}';
    }

    if (typeof evidenceJson === 'string') {
      JSON.parse(evidenceJson);
      return evidenceJson;
    }

    return JSON.stringify(evidenceJson);
  }

  function isUniqueConstraint(err, indexName) {
    return Boolean(
      err &&
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
        typeof err.message === 'string' &&
        err.message.includes(indexName),
    );
  }

  const insertMemoryItemTx = db.transaction((item) => {
    insertMemoryItemStmt.run(item);
    if (item.status === 'active') {
      _bumpRevision(item.projectId);
    }
    return getMemoryItemByIdStmt.get(item.id);
  });

  const mergeMemoryItemByHashTx = db.transaction((projectId, contentHash) => {
    mergeMemoryItemByHashStmt.run(projectId, contentHash);
    return getActiveMemoryItemByHashStmt.get(projectId, contentHash);
  });

  function createMemoryItem({
    projectId,
    kind,
    content,
    factKey,
    evidenceJson,
    origin,
    importance,
    confidence,
    sourceCount,
    status,
  } = {}) {
    if (!projectId) {
      throw new Error('projectId is required');
    }
    if (!kind) {
      throw new Error('kind is required');
    }
    if (!content) {
      throw new Error('content is required');
    }
    if (!origin) {
      throw new Error('origin is required');
    }
    if (kind === 'fact' && !factKey) {
      throw new Error('factKey is required for fact memory items');
    }
    if (kind !== 'fact' && factKey) {
      throw new Error('factKey is only allowed for fact memory items');
    }

    const finalEvidenceJson = normalizeEvidenceJson(evidenceJson);
    const finalStatus = status || 'active';
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const item = {
      id: crypto.randomUUID(),
      projectId,
      kind,
      factKey: factKey || null,
      content,
      contentHash,
      evidenceJson: finalEvidenceJson,
      origin,
      sourceCount: sourceCount ?? 1,
      confidence: confidence ?? 0.5,
      importance: importance ?? 5,
      status: finalStatus,
    };

    try {
      return insertMemoryItemTx(item);
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) {
        return mergeMemoryItemByHashTx(projectId, contentHash);
      }
      if (isUniqueConstraint(err, 'fact_key')) {
        throw err;
      }
      throw err;
    }
  }

  // R6 (PR2a): upsert a deterministic environment fact keyed by fact_key.
  // Supersedes the prior active fact (status='superseded', valid_to=now) and
  // inserts a fresh active row in ONE transaction; no-op (no revision bump)
  // when content is unchanged. origin='rule:R6'. This is the only writer that
  // may carry a fact_key, so it owns the supersede semantics createMemoryItem
  // deliberately refuses (it throws on fact_key conflict).
  const getActiveFactByKeyStmt = db.prepare(
    "SELECT * FROM memory_items WHERE project_id = ? AND fact_key = ? AND status = 'active'"
  );
  const supersedeFactStmt = db.prepare(
    "UPDATE memory_items SET status='superseded', superseded_by=@newId, valid_to=datetime('now'), updated_at=datetime('now') WHERE project_id=@projectId AND fact_key=@factKey AND status='active'"
  );
  const upsertFactTx = db.transaction((item) => {
    const existing = getActiveFactByKeyStmt.get(item.projectId, item.factKey);
    if (existing && existing.content_hash === item.contentHash) {
      return existing; // unchanged -> no-op, no revision bump
    }
    if (existing) {
      supersedeFactStmt.run({ newId: item.id, projectId: item.projectId, factKey: item.factKey });
    }
    insertMemoryItemStmt.run(item);
    _bumpRevision(item.projectId);
    return getMemoryItemByIdStmt.get(item.id);
  });

  // origin defaults to 'rule:R6' (the deterministic env-fact rule, the original
  // caller). R4 human remember passes origin='human' to upsert a person-authored
  // fact through the same fact_key supersede semantics. Must be a CHECK-allowed
  // origin ('human' is).
  function upsertFact({ projectId, factKey, content, evidenceJson, importance, origin = 'rule:R6' } = {}) {
    if (!projectId) throw new Error('projectId is required');
    if (!factKey) throw new Error('factKey is required');
    if (!content) throw new Error('content is required');
    const finalEvidenceJson = normalizeEvidenceJson(evidenceJson);
    const contentHash = crypto.createHash('sha256').update(content).digest('hex');
    const item = {
      id: crypto.randomUUID(),
      projectId,
      kind: 'fact',
      factKey,
      content,
      contentHash,
      evidenceJson: finalEvidenceJson,
      origin,
      sourceCount: 1,
      confidence: 0.9,
      importance: importance ?? 5,
      status: 'active',
    };
    try {
      return upsertFactTx(item);
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) {
        // The exact content is already active under a DIFFERENT key (e.g. a
        // human/seed memory). The transaction rolled back the supersede, so
        // the prior fact stays intact; treat this as a no-op and return the
        // existing holder rather than dropping the write silently (Codex
        // cross-review SERIOUS).
        return getActiveMemoryItemByHashStmt.get(projectId, contentHash) || null;
      }
      throw err;
    }
  }

  function getEffectiveLimit(limit) {
    const parsedLimit = Number.parseInt(limit, 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      return TOP_K;
    }
    return Math.min(parsedLimit, TOP_K);
  }

  function capRowsByContentLength(rows) {
    const capped = [];
    let total = 0;

    for (const row of rows || []) {
      const length = row && row.content ? row.content.length : 0;
      if (total === 0 || total + length <= CHAR_CAP) {
        capped.push(row);
        total += length;
      } else {
        break;
      }
    }

    return capped;
  }

  function buildMatchQuery(taskContext) {
    const trimmed = typeof taskContext === 'string' ? taskContext.trim() : '';
    if (!trimmed) {
      return null;
    }

    // Split on any non-(letter/number/underscore) run so punctuation acts as a
    // SEPARATOR (code paths / function names / `foo-bar` split into distinct
    // tokens) rather than being stripped into one fused token. The prior
    // `.replace(/[^\p{L}\p{N}_]/,'')` collapsed `memoryService.js` into
    // `memoryservicejs`, which never matched the FTS index — a silent recall
    // hole (independent Codex cross-review SERIOUS).
    const tokens = trimmed
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, MAX_QUERY_TERMS);

    if (tokens.length === 0) {
      return null;
    }

    return tokens.map((token) => `"${token}"`).join(' OR ');
  }

  function retrieveFallback(projectId, k) {
    return fallbackRetrieveStmt.all({ projectId, k });
  }

  function retrieveForProject(projectId, options = {}) {
    try {
      const { taskContext, limit } = options || {};
      const k = getEffectiveLimit(limit);
      const q = buildMatchQuery(taskContext);

      if (!q) {
        return capRowsByContentLength(retrieveFallback(projectId, k));
      }

      try {
        // bm25: lower score = more relevant -> ASC
        return capRowsByContentLength(ftsRetrieveStmt.all({ projectId, q, k }));
      } catch (err) {
        return capRowsByContentLength(retrieveFallback(projectId, k));
      }
    } catch (err) {
      return [];
    }
  }

  function buildInjectionBlock(rows) {
    try {
      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }

      const lines = ['## Learned Memory'];
      for (const row of rows) {
        if (!row) {
          continue;
        }
        lines.push(`- [${row.kind}] ${row.content}`);
      }

      return lines.length > 1 ? lines.join('\n') : null;
    } catch (err) {
      return null;
    }
  }

  function listForProject(projectId) {
    return listForProjectStmt.all(projectId);
  }

  function getInjectionRecord(pmRunId) {
    return getInjectionRecordStmt.get(pmRunId) || null;
  }

  function recordInjection(pmRunId, projectId, revision) {
    recordInjectionStmt.run(pmRunId, projectId, revision);
  }

  function shouldInject(pmRunId, projectId) {
    const revision = getRevision(projectId);
    const rec = getInjectionRecord(pmRunId);
    const inject = !rec || rec.injected_revision < revision;
    return { inject, revision, block: null };
  }

  // PR2b: rule candidates (R1b/R3/R4). Deterministic rules stage raw signals
  // here; PR3 batch LLM promotes them to active memory_items. Idempotent via
  // INSERT OR IGNORE against UNIQUE(rule, project_id, dedup_key).
  // ON CONFLICT targets ONLY the dedup UNIQUE — a CHECK violation (bad rule /
  // non-object raw_json) must surface, not be swallowed like `INSERT OR IGNORE`
  // would (Codex cross-review SERIOUS).
  const insertCandidateStmt = db.prepare(
    'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key) VALUES (@id, @projectId, @rule, @rawJson, @dedupKey) ON CONFLICT(rule, project_id, dedup_key) DO NOTHING'
  );
  const getCandidateByDedupStmt = db.prepare(
    'SELECT * FROM memory_candidates WHERE rule = ? AND project_id = ? AND dedup_key = ?'
  );
  const listCandidatesStmt = db.prepare(
    'SELECT * FROM memory_candidates WHERE project_id = ? AND status = ? ORDER BY created_at ASC, id ASC'
  );

  function createCandidate({ projectId, rule, rawJson, dedupKey } = {}) {
    if (!projectId) throw new Error('projectId is required');
    if (!rule) throw new Error('rule is required');
    if (!rawJson) throw new Error('rawJson is required');
    if (!dedupKey) throw new Error('dedupKey is required');
    const raw = typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson);
    JSON.parse(raw); // validate JSON shape before hitting the CHECK
    insertCandidateStmt.run({ id: crypto.randomUUID(), projectId, rule, rawJson: raw, dedupKey });
    // INSERT OR IGNORE -> on a dup the row is unchanged; return the holder.
    return getCandidateByDedupStmt.get(rule, projectId, dedupKey);
  }

  function listCandidates(projectId, status = 'pending') {
    return listCandidatesStmt.all(projectId, status);
  }

  // PR3b: projects that currently have at least one pending candidate — the
  // scheduler uses this to know which projects to enqueue a distill job for.
  const listPendingProjectsStmt = db.prepare(
    "SELECT DISTINCT project_id FROM memory_candidates WHERE status = 'pending'"
  );
  function listProjectsWithPendingCandidates() {
    return listPendingProjectsStmt.all().map((r) => r.project_id);
  }

  // ------------------------------------------------------------------------
  // PR3a: batch-distill job queue (CAS lease) + candidate -> active promotion.
  // The deterministic rules stage candidates; a batch distiller claims a durable
  // job, generalizes the project's pending candidates, and promotes the result.
  // SQL contract documented in migration 027_memory_jobs.sql.
  // ------------------------------------------------------------------------
  const insertJobStmt = db.prepare(
    "INSERT INTO memory_jobs (id, kind, project_id, status) VALUES (?, ?, ?, 'pending')"
  );
  const getActiveJobStmt = db.prepare(
    "SELECT * FROM memory_jobs WHERE kind = ? AND project_id = ? AND status IN ('pending','running')"
  );
  const getJobByIdStmt = db.prepare('SELECT * FROM memory_jobs WHERE id = ?');
  const getJobByTokenStmt = db.prepare(
    "SELECT * FROM memory_jobs WHERE kind = ? AND claim_token = ? AND status = 'running'"
  );

  // stale-lease recovery: a running row past its TTL is presumed dead. Requeue
  // if it has attempts left, else park it at failed. Two statements keep the
  // attempts threshold explicit.
  const requeueStaleStmt = db.prepare(
    "UPDATE memory_jobs SET status='pending', claim_token=NULL, locked_at=NULL, updated_at=datetime('now') " +
    "WHERE kind=@kind AND status='running' AND locked_at < datetime('now', @window) AND attempts < @maxAttempts"
  );
  const parkStaleStmt = db.prepare(
    "UPDATE memory_jobs SET status='failed', claim_token=NULL, last_error='lease expired (max attempts)', updated_at=datetime('now') " +
    "WHERE kind=@kind AND status='running' AND locked_at < datetime('now', @window) AND attempts >= @maxAttempts"
  );

  // CAS claim: flip exactly one pending+due row to running. changes()===1 => won.
  const claimStmt = db.prepare(
    "UPDATE memory_jobs " +
    "SET status='running', claim_token=@token, locked_at=datetime('now'), attempts=attempts+1, updated_at=datetime('now') " +
    "WHERE id = (" +
    "  SELECT id FROM memory_jobs" +
    "  WHERE kind=@kind AND status='pending'" +
    "    AND (run_after IS NULL OR run_after <= datetime('now'))" +
    "    AND (@projectId IS NULL OR project_id = @projectId)" +
    "  ORDER BY created_at ASC, id ASC LIMIT 1" +
    ") AND status='pending'"
  );

  // token-guarded release variants. The WHERE clause's claim_token + running
  // guard means a stolen (stale-requeued + re-claimed) lease can't be overwritten
  // by the original owner.
  const releaseDoneStmt = db.prepare(
    "UPDATE memory_jobs SET status='done', claim_token=NULL, last_error=NULL, updated_at=datetime('now') " +
    "WHERE id=@id AND claim_token=@token AND status='running'"
  );
  const releaseFailStmt = db.prepare(
    "UPDATE memory_jobs SET status='failed', claim_token=NULL, last_error=@lastError, updated_at=datetime('now') " +
    "WHERE id=@id AND claim_token=@token AND status='running'"
  );
  const releaseRetryStmt = db.prepare(
    "UPDATE memory_jobs SET status='pending', claim_token=NULL, locked_at=NULL, last_error=@lastError, run_after=@runAfter, updated_at=datetime('now') " +
    "WHERE id=@id AND claim_token=@token AND status='running'"
  );

  const backoffStampStmt = db.prepare("SELECT datetime('now', ?) AS ts");
  function backoffStamp(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return backoffStampStmt.get(`+${s} seconds`).ts;
  }

  function enqueueDistillJob(projectId, kind = DISTILL_KIND) {
    if (!projectId) throw new Error('projectId is required');
    const existing = getActiveJobStmt.get(kind, projectId);
    if (existing) return { job: existing, created: false };
    const id = crypto.randomUUID();
    try {
      insertJobStmt.run(id, kind, projectId);
    } catch (err) {
      // Lost the single-flight race (idx_memory_jobs_active) -> reuse the winner.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { job: getActiveJobStmt.get(kind, projectId), created: false };
      }
      throw err;
    }
    return { job: getJobByIdStmt.get(id), created: true };
  }

  function requeueStaleJobs({ kind = DISTILL_KIND, staleSeconds = 600, maxAttempts = 5 } = {}) {
    const window = `-${Math.max(1, Math.floor(staleSeconds))} seconds`;
    // Park first: an exhausted lease must go to failed, not back to pending.
    const parked = parkStaleStmt.run({ kind, window, maxAttempts }).changes;
    const requeued = requeueStaleStmt.run({ kind, window, maxAttempts }).changes;
    return { requeued, parked };
  }

  // Claim one job. Runs stale recovery first so a crashed worker's lease is
  // reclaimable. Returns the claimed row (with its fresh claim_token) or null.
  function claimDistillJob({ kind = DISTILL_KIND, projectId = null, staleSeconds = 600, maxAttempts = 5 } = {}) {
    requeueStaleJobs({ kind, staleSeconds, maxAttempts });
    const token = crypto.randomUUID();
    const info = claimStmt.run({ kind, token, projectId });
    if (info.changes !== 1) return null;
    return getJobByTokenStmt.get(kind, token);
  }

  // Release a claimed job. outcome:
  //   'done'   -> success (terminal)
  //   'failed' -> permanent failure: bad/insufficient data, won't retry (terminal)
  //   'retry'  -> transient (network/parse): back to pending w/ backoff, UNLESS
  //               attempts already hit maxAttempts -> failed.
  // Always token-guarded. Returns true iff this worker still held the lease.
  function releaseDistillJob({ jobId, claimToken, outcome, lastError = null, backoffSeconds = 60, maxAttempts = 5 } = {}) {
    if (!jobId || !claimToken) throw new Error('jobId and claimToken are required');
    if (outcome === 'done') {
      return releaseDoneStmt.run({ id: jobId, token: claimToken }).changes === 1;
    }
    if (outcome === 'failed') {
      return releaseFailStmt.run({ id: jobId, token: claimToken, lastError }).changes === 1;
    }
    if (outcome === 'retry') {
      const job = getJobByIdStmt.get(jobId);
      // attempts was incremented at claim time; exhausted => permanent failed.
      if (job && job.attempts >= maxAttempts) {
        return releaseFailStmt.run({ id: jobId, token: claimToken, lastError: lastError || 'max attempts reached' }).changes === 1;
      }
      return releaseRetryStmt.run({ id: jobId, token: claimToken, lastError, runAfter: backoffStamp(backoffSeconds) }).changes === 1;
    }
    throw new Error(`unknown release outcome: ${outcome}`);
  }

  // --- candidate -> active promotion (single transaction) ---
  const getCandidateByIdStmt = db.prepare('SELECT * FROM memory_candidates WHERE id = ?');
  const countActiveItemsStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM memory_items WHERE project_id = ? AND status = 'active'"
  );
  const setCandidateStatusStmt = db.prepare(
    "UPDATE memory_candidates SET status=@status, promoted_to=@promotedTo, updated_at=datetime('now') WHERE id=@id AND status='pending'"
  );

  // Promote distilled proposals to active memory_items in ONE transaction. This
  // writer is the SINGLE enforcement point for every safety invariant — the
  // lease, sanitize, kind, clamps, evidence — so no caller can bypass any of
  // them (Codex BLOCKER 1).
  //   ① lease re-checked at the top: a stale-then-stolen worker must not write.
  //   ② createMemoryItem + candidate status flip are inseparable: splitting them
  //      lets a re-claim double-count source_count; a double-promote is a no-op.
  //   ④ content is sanitized HERE (secrets redacted / injection rejected).
  //
  // proposals: [{ candidateId, kind, content, confidence?, importance? }]
  //   - content is RAW; the writer sanitizes it. evidence is built from the
  //     candidate's raw signal, not trusted from the caller.
  //   - 1 proposal == 1 candidate. Exact content_hash collisions merge
  //     (source_count++) via createMemoryItem; fuzzy merge is a later slice.
  const promoteCandidatesBatchTx = db.transaction(
    ({ jobId, claimToken, proposals, activeCap, confidenceCeiling, maxLen }) => {
      const job = getJobByIdStmt.get(jobId);
      if (!job || job.status !== 'running' || job.claim_token !== claimToken) {
        const e = new Error('distill lease lost or not running');
        e.code = 'MEMORY_LEASE_LOST';
        throw e; // rolls back -> nothing written
      }
      const projectId = job.project_id;
      let activeCount = countActiveItemsStmt.get(projectId).n;
      const promoted = [];
      const skipped = [];

      // Terminal failures (bad kind, sanitize reject) mark the candidate
      // 'rejected' so it leaves the pending scan; otherwise a permanently-bad
      // head candidate would refill every batch (oldest-first) and starve later
      // valid ones (Codex follow-up SERIOUS). Re-stageable conditions
      // (active_cap) keep it pending. Rejected rows are recoverable via PR4 UI.
      const rejectCandidate = (candidateId) => {
        setCandidateStatusStmt.run({ status: 'rejected', promotedTo: null, id: candidateId });
      };

      for (const p of proposals || []) {
        // A malformed entry (e.g. null) must not throw and roll back already-
        // processed siblings (Codex follow-up NIT).
        if (!p || typeof p !== 'object') {
          skipped.push({ candidateId: null, reason: 'malformed_proposal' });
          continue;
        }
        const cand = getCandidateByIdStmt.get(p.candidateId);
        // Candidate must still be a pending candidate of THIS project. Anything
        // else (already promoted/merged/rejected, wrong project, missing) is
        // skipped — never re-processed (BLOCKER ②).
        if (!cand || cand.status !== 'pending' || cand.project_id !== projectId) {
          skipped.push({ candidateId: p.candidateId, reason: 'not_pending' });
          continue;
        }
        // Durable enforcement: kind / sanitize / clamps / evidence ALL run
        // inside the writer so no caller of the public promoteCandidates can
        // bypass them (Codex BLOCKER 1, SERIOUS 3). runOnce-level checks become
        // defense-in-depth, not the last line.
        if (!PROMOTABLE_KINDS.has(p.kind)) {
          skipped.push({ candidateId: p.candidateId, reason: 'bad_kind' });
          rejectCandidate(p.candidateId);
          continue;
        }
        // BLOCKER ④: redact secrets / reject injection / length on the OUTPUT,
        // here at the writer — not just at the orchestrator.
        const s = sanitizeProposalContent(p.content, { maxLen });
        if (!s.ok) {
          skipped.push({ candidateId: p.candidateId, reason: `sanitize:${s.reasons.join(',') || 'failed'}` });
          rejectCandidate(p.candidateId);
          continue;
        }
        const content = s.content;
        const existing = getActiveMemoryItemByHashStmt.get(projectId, sha256(content));
        // Soft cap blocks only NEW active rows; a merge adds no row.
        if (!existing && activeCount >= activeCap) {
          skipped.push({ candidateId: p.candidateId, reason: 'active_cap' });
          continue;
        }
        const item = createMemoryItem({
          projectId,
          kind: p.kind,
          content,
          evidenceJson: buildPromotionEvidence(cand, s),
          origin: 'batch_llm',
          importance: clampImportance(p.importance),
          confidence: clampConfidence(p.confidence, confidenceCeiling),
          sourceCount: 1,
          status: 'active',
        });
        const merged = !!existing;
        if (!merged) activeCount += 1;
        const res = setCandidateStatusStmt.run({
          status: merged ? 'merged' : 'promoted',
          promotedTo: item.id,
          id: p.candidateId,
        });
        // The status flip must have hit a still-pending row. If not, something
        // raced inside the tx — roll the whole batch back rather than leak an
        // active item with no candidate provenance (BLOCKER ②).
        if (res.changes !== 1) {
          const e = new Error('candidate status flip raced (not pending)');
          e.code = 'MEMORY_CANDIDATE_RACE';
          throw e;
        }
        promoted.push({ candidateId: p.candidateId, itemId: item.id, merged });
      }
      return { projectId, promoted, skipped };
    },
  );

  function promoteCandidates({ jobId, claimToken, proposals, activeCap = DEFAULT_ACTIVE_CAP, confidenceCeiling = DEFAULT_CONFIDENCE_CEILING, maxLen = DEFAULT_MAX_LEN } = {}) {
    if (!jobId || !claimToken) throw new Error('jobId and claimToken are required');
    return promoteCandidatesBatchTx({ jobId, claimToken, proposals, activeCap, confidenceCeiling, maxLen });
  }

  return {
    _bumpRevision,
    getRevision,
    createMemoryItem,
    upsertFact,
    createCandidate,
    listCandidates,
    listProjectsWithPendingCandidates,
    enqueueDistillJob,
    claimDistillJob,
    requeueStaleJobs,
    releaseDistillJob,
    promoteCandidates,
    retrieveForProject,
    buildInjectionBlock,
    listForProject,
    getInjectionRecord,
    recordInjection,
    shouldInject,
  };
}

module.exports = { createMemoryService };
