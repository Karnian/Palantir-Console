const crypto = require('node:crypto');
const { detectInjection, redactSecrets } = require('./memorySanitize');

// L2 Master memory — cross-project, user-scoped GOVERNED TOP-K RETRIEVAL.
// Mirrors L1 services/memoryService.js (factory(db, eventBus), prepared stmts, FTS5 top-K + fallback,
// revision counter, injection ledger, injection-time re-sanitize). DE-SCOPED per docs/specs/master-memory-brief.md
// §12: lean retrieval ONLY — no distillation/graph. Scope is 'user' (global) or 'cross_project'.
//
// NOTE (Codex U4 follow-up): buildMatchQuery / capRowsByContentLength are copied from memoryService rather
// than shared to keep P1a from touching L1; extracting a shared retrieval-util is a follow-up cleanup.

const TOP_K = 12;          // governed top-K — NEVER top-1 (spike: raw top-1 = 53%, top-K required)
const CHAR_CAP = 2000;
const MAX_QUERY_TERMS = 32;
const VALID_SCOPES = new Set(['user', 'cross_project']);
const VALID_MASTER_KINDS = new Set(['constraint', 'preference', 'commitment', 'decision', 'fact', 'pattern']);
const VALID_CANDIDATE_RULES = new Set(['R4', 'XPROJECT']);
const VALID_CANDIDATE_STATUSES = new Set(['pending', 'promoted', 'rejected', 'merged']);
const L1_KIND_TO_MASTER_KIND = new Map([
  ['convention', 'pattern'],
  ['pitfall', 'pattern'],
  ['heuristic', 'pattern'],
]);
const PUBLIC_CANDIDATE_FIELDS = [
  'id', 'scope', 'rule', 'dedup_key', 'status', 'promoted_to', 'created_at',
];
const CANDIDATE_PREVIEW_CAP = 120;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createMasterMemoryService(db, eventBus) {
  const bumpRevisionStmt = db.prepare(`
    INSERT INTO master_memory_revision(scope, revision)
    VALUES (?, 1)
    ON CONFLICT(scope) DO UPDATE SET revision = revision + 1
  `);
  const getRevisionStmt = db.prepare('SELECT revision FROM master_memory_revision WHERE scope = ?');

  const insertItemStmt = db.prepare(`
    INSERT INTO master_memory_items (
      id, scope, project_id, kind, fact_key, content, content_hash,
      evidence_json, origin, source_count, confidence, importance, status
    ) VALUES (
      @id, @scope, @projectId, @kind, @factKey, @content, @contentHash,
      @evidenceJson, @origin, @sourceCount, @confidence, @importance, @status
    )
  `);
  const getItemByIdStmt = db.prepare('SELECT * FROM master_memory_items WHERE id = ?');
  const getActiveByHashStmt = db.prepare(
    "SELECT * FROM master_memory_items WHERE scope = ? AND content_hash = ? AND status = 'active'"
  );
  const mergeByHashStmt = db.prepare(
    "UPDATE master_memory_items SET source_count = source_count + 1, updated_at = datetime('now') " +
    "WHERE scope = ? AND content_hash = ? AND status = 'active'"
  );

  // top-K FTS retrieval (bm25 ASC = most relevant first) + recency/importance tie-break.
  const ftsRetrieveStmt = db.prepare([
    'SELECT mi.*',
    'FROM master_memory_items mi',
    'JOIN master_memory_fts ON master_memory_fts.rowid = mi.rowid_pk',
    'WHERE master_memory_fts MATCH @q',
    '  AND mi.scope = @scope',
    "  AND mi.status = 'active'",
    "  AND (mi.valid_to IS NULL OR datetime(mi.valid_to) > datetime('now'))",
    'ORDER BY bm25(master_memory_fts) ASC, mi.importance DESC, mi.updated_at DESC',
    'LIMIT @k',
  ].join('\n'));
  const fallbackRetrieveStmt = db.prepare(`
    SELECT * FROM master_memory_items
    WHERE scope = @scope AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
    LIMIT @k
  `);

  const listActiveStmt = db.prepare(`
    SELECT * FROM master_memory_items
    WHERE scope = ? AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
  `);
  const listByStatusStmt = db.prepare(
    'SELECT * FROM master_memory_items WHERE scope = ? AND status = ? ORDER BY importance DESC, updated_at DESC'
  );
  const listAllStmt = db.prepare(
    "SELECT * FROM master_memory_items WHERE scope = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END, importance DESC, updated_at DESC"
  );

  const getActiveFactByKeyStmt = db.prepare(
    "SELECT * FROM master_memory_items WHERE scope = ? AND fact_key = ? AND status = 'active'"
  );
  const supersedeFactStmt = db.prepare(
    "UPDATE master_memory_items SET status='superseded', superseded_by=@newId, valid_to=datetime('now'), updated_at=datetime('now') " +
    "WHERE scope=@scope AND fact_key=@factKey AND status='active'"
  );
  const archiveStmt = db.prepare(
    "UPDATE master_memory_items SET status='archived', archived_at=datetime('now'), archive_reason=@reason, updated_at=datetime('now') WHERE id=@id AND status='active'"
  );

  const getInjectionStmt = db.prepare('SELECT * FROM master_memory_injection WHERE master_run_id = ? AND scope = ?');
  const recordInjectionStmt = db.prepare(`
    INSERT INTO master_memory_injection(master_run_id, scope, injected_revision, injected_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(master_run_id, scope) DO UPDATE SET injected_revision = excluded.injected_revision, injected_at = excluded.injected_at
  `);

  // P1c Slice 1: Master candidates. Use ON CONFLICT against only the dedup
  // UNIQUE so CHECK violations (bad rule/scope/raw_json) still surface.
  const insertCandidateStmt = db.prepare(`
    INSERT INTO master_memory_candidates (id, scope, rule, raw_json, dedup_key)
    VALUES (@id, @scope, @rule, @rawJson, @dedupKey)
    ON CONFLICT(rule, scope, dedup_key) DO NOTHING
  `);
  const getCandidateByDedupStmt = db.prepare(`
    SELECT *
    FROM master_memory_candidates
    WHERE rule = ? AND scope = ? AND dedup_key = ?
  `);
  const listCandidatesStmt = db.prepare(`
    SELECT id, scope, rule, dedup_key, status, promoted_to, created_at, raw_json
    FROM master_memory_candidates
    WHERE scope = ? AND status = ?
    ORDER BY created_at ASC, id ASC
  `);
  const getPendingCandidateStmt = db.prepare(`
    SELECT *
    FROM master_memory_candidates
    WHERE id = ? AND status = 'pending'
  `);
  const setCandidateStatusStmt = db.prepare(`
    UPDATE master_memory_candidates
    SET status = @status,
        promoted_to = @promotedTo,
        updated_at = datetime('now')
    WHERE id = @id
      AND status = 'pending'
  `);
  const countActiveL1ProjectsByHashStmt = db.prepare(`
    SELECT COUNT(DISTINCT project_id) AS n
    FROM memory_items
    WHERE content_hash = ?
      AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
  `);

  function _bumpRevision(scope) { bumpRevisionStmt.run(normScope(scope)); }
  function getRevision(scope) {
    const row = getRevisionStmt.get(scope);
    return row ? row.revision : 0;
  }

  function normalizeEvidenceJson(evidenceJson) {
    if (evidenceJson === undefined || evidenceJson === null) return '{}';
    if (typeof evidenceJson === 'string') { JSON.parse(evidenceJson); return evidenceJson; }
    return JSON.stringify(evidenceJson);
  }
  function isUniqueConstraint(err, indexName) {
    return Boolean(err && err.code === 'SQLITE_CONSTRAINT_UNIQUE' && typeof err.message === 'string' && err.message.includes(indexName));
  }
  function normScope(scope) {
    const s = scope || 'user';
    if (!VALID_SCOPES.has(s)) throw new Error(`invalid scope: ${s}`);
    return s;
  }

  function normalizeCandidateRawJson(rawJson) {
    if (rawJson === undefined || rawJson === null) throw new Error('rawJson is required');
    const raw = typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('rawJson must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('rawJson must be a JSON object');
    }
    const sanitized = { ...parsed };
    if ('content' in sanitized) {
      if (typeof sanitized.content !== 'string') {
        const e = new Error('rawJson.content rejected: not a string');
        e.code = 'MEMORY_CONTENT_REJECTED';
        throw e;
      }
      if (detectInjection(sanitized.content)) {
        const e = new Error('rawJson.content rejected: injection');
        e.code = 'MEMORY_CONTENT_REJECTED';
        throw e;
      }
      const content = redactSecrets(sanitized.content).text.replace(/\s+/g, ' ').trim().slice(0, CHAR_CAP);
      if (!content) {
        const e = new Error('rawJson.content rejected: empty after redaction');
        e.code = 'MEMORY_CONTENT_REJECTED';
        throw e;
      }
      sanitized.content = content;
    }
    return { raw: JSON.stringify(sanitized), parsed: sanitized };
  }

  function parseCandidateRaw(candidate) {
    try {
      const parsed = JSON.parse(candidate.raw_json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function toPublicCandidate(row) {
    if (!row) return null;
    const out = {};
    for (const field of PUBLIC_CANDIDATE_FIELDS) {
      if (field in row) out[field] = row[field];
    }
    const raw = parseCandidateRaw(row);
    out.kind = raw && typeof raw.kind === 'string' ? raw.kind.trim().slice(0, 64) : null;
    const content = raw && typeof raw.content === 'string' ? raw.content : '';
    out.preview = redactSecrets(content).text.replace(/\s+/g, ' ').trim().slice(0, CANDIDATE_PREVIEW_CAP);
    return out;
  }

  function normalizeCandidateRule(rule) {
    if (!VALID_CANDIDATE_RULES.has(rule)) throw new Error(`rule must be one of ${Array.from(VALID_CANDIDATE_RULES).join('|')}`);
    return rule;
  }

  function normalizeCandidateStatus(status) {
    const s = status || 'pending';
    if (!VALID_CANDIDATE_STATUSES.has(s)) throw new Error(`status must be one of ${Array.from(VALID_CANDIDATE_STATUSES).join('|')}`);
    return s;
  }

  function mapCandidateKind(kind) {
    if (typeof kind !== 'string' || !kind.trim()) return null;
    const k = kind.trim();
    return L1_KIND_TO_MASTER_KIND.get(k) || k;
  }

  function validContentHash(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  }

  function normalizeImportance(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return 5;
    return Math.min(10, Math.max(1, n));
  }

  function normalizeConfidence(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0.5;
    return Math.max(0, Math.min(1, n));
  }

  function rejectPendingCandidate(id, reason) {
    const res = setCandidateStatusStmt.run({ status: 'rejected', promotedTo: null, id });
    if (res.changes !== 1) {
      const e = new Error('candidate status flip raced (not pending)');
      e.code = 'MASTER_MEMORY_CANDIDATE_RACE';
      throw e;
    }
    return { candidateId: id, promoted: false, skipped: true, reason };
  }

  // Write-time sanitize (Codex SERIOUS): redact secrets ALWAYS; reject injection for untrusted origins
  // (human / llm_candidate) so a raw secret / injection string never persists to be returned by
  // retrieve()/listForScope()/getMemoryItem(). Skips the MIN_LEN floor so short legit memories
  // ('node 22') persist — mirrors L1 R4 "secret redact·injection reject·cap; length floor skip".
  // deterministic = system-generated facts (redact only). buildInjectionBlock re-checks at inject time.
  function sanitizeForStore(content, origin) {
    if (origin !== 'deterministic' && detectInjection(content)) {
      const e = new Error('content rejected: injection marker'); e.code = 'MEMORY_CONTENT_REJECTED'; throw e;
    }
    const out = redactSecrets(content).text.replace(/\s+/g, ' ').trim().slice(0, CHAR_CAP);
    if (!out) { const e = new Error('content rejected: empty after redaction'); e.code = 'MEMORY_CONTENT_REJECTED'; throw e; }
    return out;
  }

  const insertItemTx = db.transaction((item) => {
    insertItemStmt.run(item);
    if (item.status === 'active') _bumpRevision(item.scope);
    return getItemByIdStmt.get(item.id);
  });
  const mergeByHashTx = db.transaction((scope, contentHash) => {
    mergeByHashStmt.run(scope, contentHash);
    return getActiveByHashStmt.get(scope, contentHash);
  });

  function createMemoryItem({ scope, projectId, kind, content, factKey, evidenceJson, origin, importance, confidence, sourceCount, status } = {}) {
    const s = normScope(scope);
    if (!kind) throw new Error('kind is required');
    if (!content) throw new Error('content is required');
    if (!origin) throw new Error('origin is required');
    if (kind === 'fact' && !factKey) throw new Error('factKey is required for fact items');
    if (kind !== 'fact' && factKey) throw new Error('factKey is only allowed for fact items');

    const safeContent = sanitizeForStore(content, origin);
    const item = {
      id: crypto.randomUUID(),
      scope: s,
      projectId: projectId || null,
      kind,
      factKey: factKey || null,
      content: safeContent,
      contentHash: sha256(safeContent),
      evidenceJson: normalizeEvidenceJson(evidenceJson),
      origin,
      sourceCount: sourceCount ?? 1,
      confidence: confidence ?? 0.5,
      importance: importance ?? 5,
      status: status || 'active',
    };
    try {
      return insertItemTx(item);
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) return mergeByHashTx(s, item.contentHash);
      throw err;
    }
  }

  function createCandidate({ scope, rule, rawJson, dedupKey } = {}) {
    const s = normScope(scope);
    const r = normalizeCandidateRule(rule);
    const key = typeof dedupKey === 'string' ? dedupKey : '';
    if (key.length < 1 || key.length > 512) throw new Error('dedupKey length must be between 1 and 512');
    const { raw } = normalizeCandidateRawJson(rawJson);
    insertCandidateStmt.run({
      id: crypto.randomUUID(),
      scope: s,
      rule: r,
      rawJson: raw,
      dedupKey: key,
    });
    return toPublicCandidate(getCandidateByDedupStmt.get(r, s, key));
  }

  function listCandidates(scope, status = 'pending') {
    return listCandidatesStmt.all(normScope(scope), normalizeCandidateStatus(status)).map(toPublicCandidate);
  }

  const promoteCandidateTx = db.transaction((candidateId) => {
    if (!candidateId) throw new Error('candidateId is required');
    const candidate = getPendingCandidateStmt.get(candidateId);
    if (!candidate) return null;

    const raw = parseCandidateRaw(candidate);
    if (!raw) return rejectPendingCandidate(candidate.id, 'bad_raw_json');

    const originalKind = typeof raw.kind === 'string' ? raw.kind.trim() : null;
    const kind = mapCandidateKind(originalKind);
    if (!kind || !VALID_MASTER_KINDS.has(kind)) {
      return rejectPendingCandidate(candidate.id, 'bad_kind');
    }
    if (kind === 'fact') {
      return rejectPendingCandidate(candidate.id, 'fact_not_allowed');
    }

    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!content.trim()) return rejectPendingCandidate(candidate.id, 'bad_content');
    if (detectInjection(content)) return rejectPendingCandidate(candidate.id, 'injection');

    let safeContent;
    try {
      safeContent = sanitizeForStore(content, 'deterministic');
    } catch (err) {
      if (err && err.code === 'MEMORY_CONTENT_REJECTED') {
        return rejectPendingCandidate(candidate.id, 'sanitize_rejected');
      }
      throw err;
    }
    const contentHash = sha256(safeContent);
    let sourceContentHash = contentHash;
    if (candidate.rule === 'XPROJECT') {
      const rawContentHash = validContentHash(raw.content_hash) ? raw.content_hash.toLowerCase() : null;
      if (!rawContentHash || sha256(content) !== rawContentHash || contentHash !== rawContentHash) {
        return rejectPendingCandidate(candidate.id, 'xproject_content_hash_mismatch');
      }
      sourceContentHash = rawContentHash;
      const activeProjects = countActiveL1ProjectsByHashStmt.get(sourceContentHash).n;
      if (activeProjects < 2) {
        return rejectPendingCandidate(candidate.id, 'xproject_recheck_failed');
      }
    }

    const promoteScope = candidate.rule === 'XPROJECT' ? 'user' : candidate.scope;
    // Pre-check exact collisions so approval records distinguish "created" from
    // "folded into an existing active item"; createMemoryItem still guards a late
    // UNIQUE race, but that path does not expose a merge signal without changing
    // its public API.
    const existing = getActiveByHashStmt.get(promoteScope, contentHash);
    const merged = !!existing;
    let item;
    if (merged) {
      mergeByHashStmt.run(promoteScope, contentHash);
      item = getActiveByHashStmt.get(promoteScope, contentHash);
      if (!item) {
        const e = new Error('merge target raced (not active)');
        e.code = 'MASTER_MEMORY_CANDIDATE_RACE';
        throw e;
      }
    } else {
      item = createMemoryItem({
        scope: promoteScope,
        kind,
        factKey: null,
        content: safeContent,
        evidenceJson: {
          schema_version: 1,
          origin: 'deterministic',
          rule: candidate.rule,
          candidate_ids: [candidate.id],
          original_kind: originalKind,
          source_content_hash: sourceContentHash,
        },
        origin: 'deterministic',
        importance: normalizeImportance(raw.importance),
        confidence: normalizeConfidence(raw.confidence),
        sourceCount: 1,
        status: 'active',
      });
    }

    const res = setCandidateStatusStmt.run({
      status: merged ? 'merged' : 'promoted',
      promotedTo: item.id,
      id: candidate.id,
    });
    if (res.changes !== 1) {
      const e = new Error('candidate status flip raced (not pending)');
      e.code = 'MASTER_MEMORY_CANDIDATE_RACE';
      throw e;
    }
    return { candidateId: candidate.id, promoted: true, merged, item };
  });

  function promoteCandidate({ candidateId } = {}) {
    const result = promoteCandidateTx(candidateId);
    if (result && result.promoted && eventBus) {
      try { eventBus.emit('master_memory:promoted', { scope: result.item.scope, memoryItemId: result.item.id, candidateId, merged: result.merged }); } catch { /* */ }
    }
    return result;
  }

  // Human "remember this" convenience → active human-origin memory.
  function remember({ scope, content, kind = 'preference', projectId, importance, confidence, evidenceJson } = {}) {
    return createMemoryItem({ scope, projectId, kind, content, origin: 'human', importance, confidence: confidence ?? 0.9, evidenceJson });
  }

  // fact_key upsert with supersede semantics (mirrors L1 upsertFact). origin must be CHECK-allowed.
  const upsertFactTx = db.transaction((item) => {
    const existing = getActiveFactByKeyStmt.get(item.scope, item.factKey);
    if (existing && existing.content_hash === item.contentHash) return existing; // no-op, no bump
    if (existing) supersedeFactStmt.run({ newId: item.id, scope: item.scope, factKey: item.factKey });
    insertItemStmt.run(item);
    _bumpRevision(item.scope);
    return getItemByIdStmt.get(item.id);
  });
  function upsertFact({ scope, factKey, content, evidenceJson, importance, origin = 'deterministic' } = {}) {
    const s = normScope(scope);
    if (!factKey) throw new Error('factKey is required');
    if (!content) throw new Error('content is required');
    const safeContent = sanitizeForStore(content, origin);
    const item = {
      id: crypto.randomUUID(), scope: s, projectId: null, kind: 'fact', factKey,
      content: safeContent, contentHash: sha256(safeContent), evidenceJson: normalizeEvidenceJson(evidenceJson),
      origin, sourceCount: 1, confidence: 0.9, importance: importance ?? 5, status: 'active',
    };
    try {
      return upsertFactTx(item);
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) return getActiveByHashStmt.get(s, item.contentHash) || null;
      throw err;
    }
  }

  // FTS5 MATCH builder: punctuation acts as a SEPARATOR (code paths / foo-bar split into tokens), each
  // token quoted, OR-joined. escape-safe; empty -> null fallback. (Copied from L1 memoryService.)
  function buildMatchQuery(taskContext) {
    const trimmed = typeof taskContext === 'string' ? taskContext.trim() : '';
    if (!trimmed) return null;
    const tokens = trimmed.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean).slice(0, MAX_QUERY_TERMS);
    if (tokens.length === 0) return null;
    return tokens.map((t) => `"${t}"`).join(' OR ');
  }
  function getEffectiveLimit(limit) {
    const n = Number.parseInt(limit, 10);
    if (!Number.isFinite(n) || n <= 0) return TOP_K;
    return Math.min(n, TOP_K);
  }
  function capRowsByContentLength(rows) {
    const capped = [];
    let total = 0;
    for (const row of rows || []) {
      const length = row && row.content ? row.content.length : 0;
      if (total === 0 || total + length <= CHAR_CAP) { capped.push(row); total += length; } else break;
    }
    return capped;
  }

  // Governed TOP-K retrieval: FTS narrow on taskContext, else importance-ordered fallback. Char-capped.
  function retrieve(scope, options = {}) {
    try {
      const s = normScope(scope);
      const { taskContext, limit } = options || {};
      const k = getEffectiveLimit(limit);
      const q = buildMatchQuery(taskContext);
      if (!q) return capRowsByContentLength(fallbackRetrieveStmt.all({ scope: s, k }));
      try {
        return capRowsByContentLength(ftsRetrieveStmt.all({ scope: s, q, k }));
      } catch {
        return capRowsByContentLength(fallbackRetrieveStmt.all({ scope: s, k }));
      }
    } catch {
      return [];
    }
  }

  // Caching-safe injection block: "## User Memory" + injection-time re-sanitize (reject injection markers,
  // redact secrets) so no stored row leaks into the Master payload. Mirrors L1 buildInjectionBlock.
  function buildInjectionBlock(rows) {
    try {
      if (!Array.isArray(rows) || rows.length === 0) return null;
      const lines = ['## User Memory'];
      for (const row of rows) {
        if (!row || !row.content) continue;
        const raw = String(row.content);
        if (detectInjection(raw)) continue;
        const safe = redactSecrets(raw).text.replace(/\s+/g, ' ').trim().slice(0, CHAR_CAP);
        if (!safe) continue;
        lines.push(`- [${row.kind}] ${safe}`);
      }
      return lines.length > 1 ? lines.join('\n') : null;
    } catch {
      return null;
    }
  }

  function listForScope(scope, status = 'active') {
    const s = normScope(scope);
    if (status === 'all') return listAllStmt.all(s);
    if (status === 'active') return listActiveStmt.all(s);
    return listByStatusStmt.all(s, status);
  }

  function getMemoryItem(id) { return getItemByIdStmt.get(id) || null; }

  const archiveTx = db.transaction((id) => {
    const before = getItemByIdStmt.get(id);
    const res = archiveStmt.run({ id, reason: 'manual' });
    if (res.changes !== 1) return null;
    _bumpRevision(before.scope);
    return getItemByIdStmt.get(id);
  });
  function archiveMemory(id) {
    if (!id) throw new Error('id is required');
    return archiveTx(id);
  }

  function getInjectionRecord(masterRunId, scope) { return getInjectionStmt.get(masterRunId, normScope(scope)) || null; }
  function recordInjection(masterRunId, scope, revision) { recordInjectionStmt.run(masterRunId, normScope(scope), revision); }
  // Caching-safe gate: inject only once per (masterRunId, scope) until THAT scope's revision advances.
  function shouldInject(masterRunId, scope) {
    const s = normScope(scope);
    const revision = getRevision(s);
    const rec = getInjectionRecord(masterRunId, s);
    return { inject: !rec || rec.injected_revision < revision, revision, block: null };
  }

  return {
    _bumpRevision,
    getRevision,
    createMemoryItem,
    createCandidate,
    listCandidates,
    promoteCandidate,
    remember,
    upsertFact,
    retrieve,
    buildInjectionBlock,
    listForScope,
    getMemoryItem,
    archiveMemory,
    getInjectionRecord,
    recordInjection,
    shouldInject,
  };
}

module.exports = { createMasterMemoryService };
