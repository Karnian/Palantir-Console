const crypto = require('node:crypto');
const { sanitizeProposalContent, detectInjection, redactSecrets } = require('./memorySanitize');
const { normalizeOwner } = require('./ownerKey');

const TOP_K = 12;
const CHAR_CAP = 2000;
const MAX_QUERY_TERMS = 32;

// PR3a distill defaults (overridable per call).
const DEFAULT_ACTIVE_CAP = 200;        // soft cap: max active items per project
const DEFAULT_CONFIDENCE_CEILING = 0.7; // single-candidate promotions clamp here
const DEFAULT_MAX_LEN = 500;            // promoted content character ceiling
const DEFAULT_TTL_DAYS = 90;           // PR5d: TTL for auto (batch_llm) memories
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

// PR3c: LLM-proposed semantic merge. The DISTILLER decides whether a new lesson
// duplicates an existing memory (token Jaccard alone can't — `prefer A over B` ↔
// `prefer B over A` score 1.0, Codex Q1 NO-GO). The WRITER never trusts that
// blindly: it re-validates the proposed target (active / same kind / same project)
// and additionally requires a minimum token overlap as a sanity FLOOR so a
// hallucinated or clearly-unrelated target id can't fold two distinct lessons
// together. Direction/polarity is the model's job; the floor only rejects the
// obviously-wrong.
const FUZZY_MERGE_FLOOR = 0.3; // min token Jaccard for a model-proposed merge
const EVIDENCE_ID_CAP = 20;    // bound candidate_ids / run_ids growth on merge

// Distinct word tokens of a content string (same splitter as buildMatchQuery so
// the floor agrees with the FTS tokenization).
function contentTokenSet(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
}

// Jaccard overlap |A∩B| / |A∪B|; 0 when either set is empty.
function jaccardSimilarity(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const t of aSet) if (bSet.has(t)) inter += 1;
  return inter / (aSet.size + bSet.size - inter);
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

// PR3c: fold a merged candidate's provenance INTO an existing item's evidence
// (exact OR fuzzy merge). Accrues candidate_ids / run_ids (deduped, capped) on
// top of the existing snapshot so a reinforced lesson records every signal that
// supported it. source_count is bumped by the stmt; this only grows the id
// arrays and refreshes redaction metadata. Never raises confidence (PR3c-1).
function mergeEvidence(existingEvidenceJson, candidate, sanitized) {
  let base = {};
  try { const p = JSON.parse(existingEvidenceJson); if (p && typeof p === 'object') base = p; } catch { /* keep {} */ }
  let raw = {};
  try { const p = JSON.parse(candidate.raw_json); if (p && typeof p === 'object') raw = p; } catch { /* keep {} */ }
  const candRunIds = [];
  if (raw.fail_run) candRunIds.push(shortId(raw.fail_run.id));
  if (raw.fix_run) candRunIds.push(shortId(raw.fix_run.id));
  if (raw.pm_run_id) candRunIds.push(shortId(raw.pm_run_id));
  const append = (arr, add) => {
    const out = Array.isArray(arr) ? arr.filter((v) => typeof v === 'string').slice(0, EVIDENCE_ID_CAP) : [];
    for (const v of add.filter(Boolean)) {
      if (out.length >= EVIDENCE_ID_CAP) break;
      if (!out.includes(v)) out.push(v);
    }
    return out;
  };
  return JSON.stringify({
    ...base,
    candidate_ids: append(base.candidate_ids, [candidate.id]),
    run_ids: append(base.run_ids, candRunIds.filter(Boolean)),
    // preserve the higher redaction_version — never downgrade a future/external
    // evidence schema marker (Codex NIT).
    redaction_version: Math.max(Number(base.redaction_version) || 0, Number(sanitized.redactionVersion) || 0),
    redacted: !!(base.redacted || sanitized.redacted),
  });
}

function createMemoryService(db, eventBus) {
  const bumpRevisionStmt = db.prepare(`
    INSERT INTO project_memory_revision(project_id, revision, owner_type, owner_id)
    VALUES (?, 1, ?, ?)
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
      status,
      owner_type,
      owner_id
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
      @status,
      @ownerType,
      @ownerId
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
    WHERE owner_type = ?
      AND owner_id = ?
      AND content_hash = ?
      AND status = 'active'
  `);

  const mergeMemoryItemByHashStmt = db.prepare(`
    UPDATE memory_items
    SET source_count = source_count + 1,
        updated_at = datetime('now')
    WHERE owner_type = @ownerType
      AND owner_id = @ownerId
      AND content_hash = @contentHash
      AND status = 'active'
  `);

  // PR3c: fold a candidate into an existing active item by id (exact OR fuzzy
  // merge) — source_count++ and refreshed evidence. Confidence is NOT touched
  // here (PR3c-1: accrual only). Guarded by id + status so a raced archive can't
  // be resurrected.
  const mergeItemByIdStmt = db.prepare(`
    UPDATE memory_items
    SET source_count = source_count + 1,
        evidence_json = @evidenceJson,
        updated_at = datetime('now')
    WHERE id = @id
      AND status = 'active'
  `);

  // PR3c: resolve a model-proposed fuzzy merge target. Enforces active +
  // same-project + NOT-expired IN SQL (Codex BLOCKER 2: a TTL-expired row is
  // hidden from listForProject/retrieve but was still merge-able via status
  // alone). kind + token floor are checked by the caller in JS.
  const getMergeTargetStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE id = @id
      AND owner_type = @ownerType
      AND owner_id = @ownerId
      AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
  `);

  const fallbackRetrieveStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE owner_type = @ownerType
      AND owner_id = @ownerId
      AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
    LIMIT @k
  `);

  const ftsRetrieveStmt = db.prepare(
    [
      'SELECT mi.*',
      'FROM memory_items mi',
      'JOIN memory_fts ON memory_fts.rowid = mi.rowid_pk',
      'WHERE memory_fts MATCH @q',
      '  AND mi.owner_type = @ownerType',
      '  AND mi.owner_id = @ownerId',
      "  AND mi.status = 'active'",
      "  AND (mi.valid_to IS NULL OR datetime(mi.valid_to) > datetime('now'))",
      // bm25: lower score = more relevant -> ASC. recency tie-break keeps the
      // FTS path consistent with the fallback path's ORDER BY (Codex NIT).
      'ORDER BY bm25(memory_fts) ASC, mi.importance DESC, mi.updated_at DESC',
      'LIMIT @k',
    ].join('\n'),
  );

  const listForProjectStmt = db.prepare(`
    SELECT *
    FROM memory_items
    WHERE owner_type = ?
      AND owner_id = ?
      AND status = 'active'
      AND (valid_to IS NULL OR datetime(valid_to) > datetime('now'))
    ORDER BY importance DESC, updated_at DESC
  `);

  function _bumpRevision(projectId) {
    const { owner_type, owner_id } = normalizeOwner({ project_id: projectId });
    bumpRevisionStmt.run(projectId, owner_type, owner_id);
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

  const mergeMemoryItemByHashTx = db.transaction((ownerType, ownerId, contentHash) => {
    mergeMemoryItemByHashStmt.run({ ownerType, ownerId, contentHash });
    return getActiveMemoryItemByHashStmt.get(ownerType, ownerId, contentHash);
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
    const { owner_type, owner_id } = normalizeOwner({ project_id: projectId });
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
      ownerType: owner_type,
      ownerId: owner_id,
    };

    try {
      return insertMemoryItemTx(item);
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) {
        // S5-STORAGE: pass owner directly (already resolved above at normalizeOwner call).
        return mergeMemoryItemByHashTx(owner_type, owner_id, contentHash);
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
    "SELECT * FROM memory_items WHERE owner_type = ? AND owner_id = ? AND fact_key = ? AND status = 'active'"
  );
  const supersedeFactStmt = db.prepare(
    "UPDATE memory_items SET status='superseded', superseded_by=@newId, valid_to=datetime('now'), updated_at=datetime('now') WHERE owner_type=@ownerType AND owner_id=@ownerId AND fact_key=@factKey AND status='active'"
  );
  const upsertFactTx = db.transaction((item) => {
    const existing = getActiveFactByKeyStmt.get(item.ownerType, item.ownerId, item.factKey);
    if (existing && existing.content_hash === item.contentHash) {
      return existing; // unchanged -> no-op, no revision bump
    }
    if (existing) {
      supersedeFactStmt.run({
        newId: item.id,
        ownerType: item.ownerType,
        ownerId: item.ownerId,
        factKey: item.factKey,
      });
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
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
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
      ownerType,
      ownerId,
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
        return getActiveMemoryItemByHashStmt.get(ownerType, ownerId, contentHash) || null;
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

  // FTS5 MATCH builder. Default = exact-quoted tokens (the original behavior).
  // With { prefix: true } each token becomes a prefix term (`"tok"*`) so Korean
  // 조사-inflected forms are reachable (조사 attach as suffixes — 메모리+를 — so the
  // stem is a PREFIX of the inflected token; `"메모리"` misses `메모리를`, `"메모리"*`
  // catches it). NFC-normalized so canonical-equivalent 한글 compares equal (stored
  // app/LLM text is NFC; NFD content would need write-side NFC — out of A1 scope).
  // NOTE: a prefix term is a superset at the MATCH-SET level but NOT at the top-K
  // retrieval level — a short over-matching prefix can outrank exact hits in bm25.
  // retrieveForProject therefore runs exact-first then prefix-fill (see there).
  // A1 / docs/specs/memory-augmentation-brief.md §2-①.
  function buildMatchQuery(taskContext, opts = {}) {
    const raw = typeof taskContext === 'string' ? taskContext : '';
    const trimmed = raw.normalize('NFC').trim();
    if (!trimmed) {
      return null;
    }

    // Split on any non-(letter/number/underscore) run so punctuation acts as a
    // SEPARATOR (code paths / `foo-bar` split into distinct tokens) rather than
    // being stripped into one fused token. The prior `.replace(...)` collapsed
    // `memoryService.js` into `memoryservicejs`, a silent recall hole.
    const tokens = trimmed
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, MAX_QUERY_TERMS);

    if (tokens.length === 0) {
      return null;
    }

    const star = opts.prefix ? '*' : '';
    return tokens.map((token) => `"${token}"${star}`).join(' OR ');
  }

  function retrieveFallback(ownerType, ownerId, k) {
    return fallbackRetrieveStmt.all({ ownerType, ownerId, k });
  }

  function retrieveForProject(projectId, options = {}) {
    try {
      const { taskContext, limit } = options || {};
      const k = getEffectiveLimit(limit);
      const exactQ = buildMatchQuery(taskContext);
      const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });

      if (!exactQ) {
        return capRowsByContentLength(retrieveFallback(ownerType, ownerId, k));
      }

      try {
        // Two-pass (A1): exact hits first — identical ranking to pre-A1, so an
        // exact hit keeps its top-K position ahead of any prefix-only hit (the
        // existing char-cap budget still applies; NOT a strict returned-set superset).
        // Only when exact under-fills K do we prefix-fill the remaining slots,
        // making Korean 조사-inflected forms reachable without a short over-matching
        // prefix dominating. bm25: lower = more relevant -> ASC.
        const exactRows = ftsRetrieveStmt.all({ ownerType, ownerId, q: exactQ, k });
        if (exactRows.length >= k) {
          return capRowsByContentLength(exactRows);
        }
        const prefixQ = buildMatchQuery(taskContext, { prefix: true });
        const seen = new Set(exactRows.map((r) => r.id));
        const prefixRows = ftsRetrieveStmt
          .all({ ownerType, ownerId, q: prefixQ, k })
          .filter((r) => !seen.has(r.id));
        return capRowsByContentLength(exactRows.concat(prefixRows).slice(0, k));
      } catch (err) {
        return capRowsByContentLength(retrieveFallback(ownerType, ownerId, k));
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
        if (!row || !row.content) {
          continue;
        }
        // Injection-time defense-in-depth (Codex PR5c BLOCKER): active content is
        // sanitized at write, but re-guard here so no stored row (an R6 fact, or
        // a row written before a sanitize-rule change) can break the bullet or
        // leak a secret into the PM payload. Reject injection markers, redact
        // secrets, collapse whitespace; skip the length floor (facts are short).
        const raw = String(row.content);
        if (detectInjection(raw)) {
          continue;
        }
        const safe = redactSecrets(raw).text.replace(/\s+/g, ' ').trim().slice(0, CHAR_CAP);
        if (!safe) {
          continue;
        }
        lines.push(`- [${row.kind}] ${safe}`);
      }

      return lines.length > 1 ? lines.join('\n') : null;
    } catch (err) {
      return null;
    }
  }

  const listByStatusStmt = db.prepare(
    'SELECT * FROM memory_items WHERE owner_type = ? AND owner_id = ? AND status = ? ORDER BY importance DESC, updated_at DESC'
  );
  const listAllStatusStmt = db.prepare(
    "SELECT * FROM memory_items WHERE owner_type = ? AND owner_id = ? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END, importance DESC, updated_at DESC"
  );
  // status: 'active' (default; valid_to-filtered, used by injection) / 'archived'
  // / 'superseded' / 'all' (correction UI). Only the active path is injected.
  function listForProject(projectId, status = 'active') {
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
    if (status === 'all') return listAllStatusStmt.all(ownerType, ownerId);
    if (status === 'active') return listForProjectStmt.all(ownerType, ownerId);
    return listByStatusStmt.all(ownerType, ownerId, status);
  }

  // PR3c: existing-memory context for the distiller, made SAFE to embed in an LLM
  // prompt: secrets redacted, injection-marked rows skipped, whitespace collapsed,
  // content truncated, capped. Mirrors buildInjectionBlock's injection-time
  // re-sanitize (Codex BLOCKER 1: active rows — esp. R6 facts that bypass
  // write-time sanitize — must not leak a token into the distiller prompt).
  // Uses the unexpired/importance-ordered fallback query, so an expired row is
  // never offered as a merge target (defense alongside getMergeTargetStmt). The
  // cap is a KNOWN limitation — only the top-N actives are merge-eligible, so full
  // semantic dedup across a 200-cap project is a later slice; surfaced via
  // memory:distill_context_capped (Codex SERIOUS 3).
  function listActiveForDistill(projectId, max = 60) {
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
    const rows = fallbackRetrieveStmt.all({ ownerType, ownerId, k: max });
    const out = [];
    for (const r of rows) {
      const raw = String(r.content || '');
      if (detectInjection(raw)) continue; // never feed an injection-marked row to the model
      const safe = redactSecrets(raw).text.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!safe) continue;
      out.push({ id: r.id, kind: r.kind, content: safe });
    }
    let total = out.length;
    try { total = countActiveItemsStmt.get(ownerType, ownerId).n; } catch { /* */ }
    if (total > max && eventBus) {
      try { eventBus.emit('memory:distill_context_capped', { projectId, shown: out.length, total }); } catch { /* observability must never break distill */ }
    }
    return out;
  }

  // PR2b: rule candidates (R1b/R3/R4). Deterministic rules stage raw signals
  // here; PR3 batch LLM promotes them to active memory_items. Idempotent via an
  // owner-keyed pre-check plus UNIQUE(rule, owner_type, owner_id, dedup_key).
  // ON CONFLICT targets the owner-keyed dedup UNIQUE — a CHECK violation (bad
  // rule / non-object raw_json) must surface, not be swallowed like
  // `INSERT OR IGNORE` would (Codex cross-review SERIOUS).
  // S5-STORAGE: ON CONFLICT key updated from (rule, project_id, dedup_key) to
  // owner-keyed (rule, owner_type, owner_id, dedup_key) after migration 039 rebuild.
  // Adaptive: migration 039 may not have run yet (tests that stop at migration 037/038),
  // so we try the new owner-keyed ON CONFLICT first and fall back to the legacy key
  // (project_id-based) if the new constraint doesn't exist. The pre-check + try/catch
  // wrapper in createCandidate() handles any residual race regardless of which key fires.
  let insertCandidateStmt;
  try {
    insertCandidateStmt = db.prepare(
      'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (@id, @projectId, @rule, @rawJson, @dedupKey, @ownerType, @ownerId) ON CONFLICT(rule, owner_type, owner_id, dedup_key) DO NOTHING'
    );
  } catch (prepErr) {
    // Fall back ONLY when the owner-keyed UNIQUE does not exist yet (pre-039 DB).
    // Any other prepare error (e.g. a typo'd column name) MUST surface — never
    // silently degrade to the legacy path (Codex review SERIOUS-2).
    if (!/ON CONFLICT clause does not match/i.test(prepErr && prepErr.message)) throw prepErr;
    // Migration 039 not yet applied — fall back to the legacy project_id-keyed constraint.
    insertCandidateStmt = db.prepare(
      'INSERT INTO memory_candidates (id, project_id, rule, raw_json, dedup_key, owner_type, owner_id) VALUES (@id, @projectId, @rule, @rawJson, @dedupKey, @ownerType, @ownerId) ON CONFLICT(rule, project_id, dedup_key) DO NOTHING'
    );
  }
  const getCandidateByOwnerDedupStmt = db.prepare(
    'SELECT * FROM memory_candidates WHERE owner_type = ? AND owner_id = ? AND rule = ? AND dedup_key = ?'
  );
  const listCandidatesStmt = db.prepare(
    'SELECT * FROM memory_candidates WHERE owner_type = ? AND owner_id = ? AND status = ? ORDER BY created_at ASC, id ASC'
  );

  function createCandidate({ projectId, rule, rawJson, dedupKey } = {}) {
    if (!projectId) throw new Error('projectId is required');
    if (!rule) throw new Error('rule is required');
    if (!rawJson) throw new Error('rawJson is required');
    if (!dedupKey) throw new Error('dedupKey is required');
    const raw = typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson);
    // BLOCKER fix: validate type (non-null, non-array object) BEFORE the owner-dedup
    // pre-check so CHECK(json_type(raw_json)='object') is never swallowed by early return.
    // Symmetric with L2 masterMemoryService.normalizeCandidateRawJson pattern.
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('rawJson must be a non-null, non-array object');
    }
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
    // S5-STORAGE: owner-keyed dedup pre-check (common-case fast path).
    // DB table UNIQUE(rule, owner_type, owner_id, dedup_key) is the primary defense
    // after migration 039 rebuilt memory_candidates with the owner-keyed constraint.
    const existing = getCandidateByOwnerDedupStmt.get(ownerType, ownerId, rule, dedupKey);
    if (existing) return existing;
    // Race safety: ON CONFLICT(rule, owner_type, owner_id, dedup_key) DO NOTHING handles
    // concurrent inserts; try/catch catches any residual UNIQUE constraint error
    // (e.g. from a cross-process race window between pre-check and insert).
    // All other errors (CHECK violations, bad rule, etc.) are rethrown so they surface.
    try {
      insertCandidateStmt.run({ id: crypto.randomUUID(), projectId, rule, rawJson: raw, dedupKey, ownerType, ownerId });
    } catch (err) {
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return getCandidateByOwnerDedupStmt.get(ownerType, ownerId, rule, dedupKey);
      }
      throw err;
    }
    return getCandidateByOwnerDedupStmt.get(ownerType, ownerId, rule, dedupKey);
  }

  function listCandidates(projectId, status = 'pending') {
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
    return listCandidatesStmt.all(ownerType, ownerId, status);
  }

  // PR3b: projects that currently have at least one pending candidate — the
  // scheduler uses this to know which projects to enqueue a distill job for.
  const listPendingProjectsStmt = db.prepare(
    "SELECT DISTINCT project_id FROM memory_candidates WHERE status = 'pending'"
  );
  function listProjectsWithPendingCandidates() {
    return listPendingProjectsStmt.all().map((r) => r.project_id);
  }

  // P-A1 slice3b [5]: owner-keyed pending enumeration for distill scheduler.
  // Returns [{ownerType, ownerId}] pairs. Workspace owner_id=project_id (behavior-preserving).
  const listPendingOwnersStmt = db.prepare(
    "SELECT DISTINCT owner_type, owner_id FROM memory_candidates WHERE status = 'pending'"
  );
  function listOwnersWithPendingCandidates() {
    return listPendingOwnersStmt.all().map((r) => ({ ownerType: r.owner_type, ownerId: r.owner_id }));
  }

  // ------------------------------------------------------------------------
  // PR3a: batch-distill job queue (CAS lease) + candidate -> active promotion.
  // The deterministic rules stage candidates; a batch distiller claims a durable
  // job, generalizes the project's pending candidates, and promotes the result.
  // SQL contract documented in migration 027_memory_jobs.sql.
  // ------------------------------------------------------------------------
  const insertJobStmt = db.prepare(
    "INSERT INTO memory_jobs (id, kind, project_id, status, owner_type, owner_id) VALUES (?, ?, ?, 'pending', ?, ?)"
  );
  const getActiveJobStmt = db.prepare(
    "SELECT * FROM memory_jobs WHERE owner_type = ? AND owner_id = ? AND kind = ? AND status IN ('pending','running')"
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
    "    AND (@ownerType IS NULL OR (owner_type = @ownerType AND owner_id = @ownerId))" +
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
    const { owner_type: ownerType, owner_id: ownerId } = normalizeOwner({ project_id: projectId });
    const existing = getActiveJobStmt.get(ownerType, ownerId, kind);
    if (existing) return { job: existing, created: false };
    const id = crypto.randomUUID();
    try {
      insertJobStmt.run(id, kind, projectId, ownerType, ownerId);
    } catch (err) {
      // Lost the single-flight race (idx_memory_jobs_active) -> reuse the winner.
      if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { job: getActiveJobStmt.get(ownerType, ownerId, kind), created: false };
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
    let ownerType = null;
    let ownerId = null;
    if (projectId) {
      const norm = normalizeOwner({ project_id: projectId });
      ownerType = norm.owner_type;
      ownerId = norm.owner_id;
    }
    const info = claimStmt.run({ kind, token, ownerType, ownerId });
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
    "SELECT COUNT(*) AS n FROM memory_items WHERE owner_type = ? AND owner_id = ? AND status = 'active'"
  );
  const setCandidateStatusStmt = db.prepare(
    "UPDATE memory_candidates SET status=@status, promoted_to=@promotedTo, updated_at=datetime('now') WHERE id=@id AND status='pending'"
  );

  // PR5a hard-cap admission control. The lowest-score EVICTABLE active item:
  // never human, never pinned (those are protected). score = confidence*importance
  // (recency is only a tie-break — it belongs to decay, PR5d). Returns undefined
  // when every active row is protected.
  const lowestEvictableStmt = db.prepare(
    "SELECT id, (COALESCE(confidence,0) * COALESCE(importance,1)) AS score " +
    "FROM memory_items " +
    "WHERE owner_type=? AND owner_id=? AND status='active' AND pinned=0 AND origin!='human' " +
    "ORDER BY score ASC, COALESCE(reviewed_at, created_at) ASC, id ASC LIMIT 1"
  );
  const archiveVictimStmt = db.prepare(
    "UPDATE memory_items SET status='archived', archived_at=datetime('now'), archive_reason=@reason, updated_at=datetime('now') WHERE id=@id AND status='active'"
  );
  // PR5d TTL: stamp a valid_to on a freshly-promoted auto memory.
  const setValidToStmt = db.prepare(
    "UPDATE memory_items SET valid_to = datetime('now', @offset) WHERE id = @id"
  );
  // PR5d decay maintenance: active rows whose TTL has passed (datetime-normalized).
  const listExpiredStmt = db.prepare(
    "SELECT id, project_id FROM memory_items WHERE status='active' AND valid_to IS NOT NULL AND datetime(valid_to) <= datetime('now')"
  );
  const archiveExpiredStmt = db.prepare(
    "UPDATE memory_items SET status='archived', archived_at=datetime('now'), archive_reason='ttl_expired', updated_at=datetime('now') WHERE id=@id AND status='active'"
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
    ({ jobId, claimToken, proposals, activeCap, confidenceCeiling, maxLen, ttlDays }) => {
      const job = getJobByIdStmt.get(jobId);
      if (!job || job.status !== 'running' || job.claim_token !== claimToken) {
        const e = new Error('distill lease lost or not running');
        e.code = 'MEMORY_LEASE_LOST';
        throw e; // rolls back -> nothing written
      }
      const projectId = job.project_id;
      // S5-STORAGE: use owner columns directly from the job row (set by migration 033/036
      // backfill) instead of re-deriving from project_id. Falls back to normalizeOwner
      // only when the columns are absent (e.g. test fixtures created before migration 033).
      const ownerType = job.owner_type || normalizeOwner({ project_id: projectId }).owner_type;
      const ownerId = job.owner_id || normalizeOwner({ project_id: projectId }).owner_id;
      let activeCount = countActiveItemsStmt.get(ownerType, ownerId).n;
      const promoted = [];
      const skipped = [];
      const evicted = [];

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
        // Exact dup first; if none, honor a DISTILLER-proposed semantic merge
        // target — but re-validate it HERE (the writer never trusts the model):
        // active / same project / same kind, AND a token-overlap FLOOR so a
        // hallucinated or clearly-unrelated id can't fold two distinct lessons
        // together (Codex Q1 defense-in-depth). The model judges polarity; the
        // floor only rejects the obviously-wrong. Failed validation → treated as
        // a fresh item (no merge).
        let existing = getActiveMemoryItemByHashStmt.get(ownerType, ownerId, sha256(content));
        let fuzzy = false;
        if (!existing && p.mergeTargetId) {
          const target = getMergeTargetStmt.get({ id: p.mergeTargetId, ownerType, ownerId });
          // active + same-project + not-expired are enforced in SQL above; kind +
          // token floor here. The floor is a SANITY check (reject a hallucinated /
          // clearly-unrelated id), NOT a semantic guarantee — a polarity-reversed
          // duplicate passes the floor and relies entirely on the model's judgment
          // (Codex S4). PR3c-1 tolerates that because a merge never raises
          // confidence; the worst case is recoverable via the correction UI.
          if (target && target.kind === p.kind &&
              jaccardSimilarity(contentTokenSet(content), contentTokenSet(target.content)) >= FUZZY_MERGE_FLOOR) {
            existing = target;
            fuzzy = true;
          }
        }
        const confidence = clampConfidence(p.confidence, confidenceCeiling);
        const importance = clampImportance(p.importance);
        // Hard-cap ADMISSION CONTROL (PR5a): a new active row only enters a full
        // project by BEATING the lowest-score evictable item — never by blind
        // eviction (Codex BLOCKER). human/pinned are protected
        // (lowestEvictableStmt excludes them). A merge adds no row, so it skips
        // the cap entirely.
        if (!existing && activeCount >= activeCap) {
          const victim = lowestEvictableStmt.get(ownerType, ownerId);
          if (!victim) {
            skipped.push({ candidateId: p.candidateId, reason: 'active_cap_all_protected' });
            continue;
          }
          if (confidence * importance <= victim.score) {
            skipped.push({ candidateId: p.candidateId, reason: 'active_cap_low_score' });
            continue;
          }
          archiveVictimStmt.run({ id: victim.id, reason: 'cap_evicted' });
          activeCount -= 1;
          evicted.push({ itemId: victim.id, score: victim.score });
        }
        const merged = !!existing;
        let item;
        if (merged) {
          // exact OR fuzzy merge: accrue provenance only (PR3c-1) — source_count++
          // and evidence append. No new row, so the cap and the existing row's
          // valid_to are untouched (Codex Q4). Confidence is NOT raised here;
          // cross-run confidence is a later slice gated on the adversarial suite
          // (Codex Q6 ⑤). The project revision is intentionally NOT bumped here: a
          // merge leaves the injected CONTENT unchanged (only source_count +
          // evidence grow), so the content-based PM injection cache stays valid
          // and PMs don't re-inject for a provenance-only change (Codex 2차 NIT).
          // mergeItemByIdStmt guards status='active'; expired-target protection is
          // on the READ path (getMergeTargetStmt for fuzzy; exact-hash merge of a
          // soon-to-be-archived row is harmless — maintenance archives it next tick).
          const mres = mergeItemByIdStmt.run({ id: existing.id, evidenceJson: mergeEvidence(existing.evidence_json, cand, s) });
          // Must have hit the still-active target. 0 rows == it raced out of active
          // (cross-connection / WAL) between the read above and this write — roll
          // the batch back rather than mark a candidate merged into nothing
          // (Codex S2).
          if (mres.changes !== 1) {
            const e = new Error('merge target raced (not active)');
            e.code = 'MEMORY_CANDIDATE_RACE';
            throw e;
          }
          item = existing;
        } else {
          item = createMemoryItem({
            projectId,
            kind: p.kind,
            content,
            evidenceJson: buildPromotionEvidence(cand, s),
            origin: 'batch_llm',
            importance,
            confidence,
            sourceCount: 1,
            status: 'active',
          });
          activeCount += 1;
          // PR5d: a freshly-promoted auto memory gets a TTL so it decays unless
          // re-observed/pinned.
          if (ttlDays > 0) {
            setValidToStmt.run({ id: item.id, offset: `+${Math.floor(ttlDays)} days` });
          }
        }
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
        promoted.push({ candidateId: p.candidateId, itemId: item.id, merged, fuzzy });
      }
      return { projectId, promoted, skipped, evicted };
    },
  );

  // Emit lifecycle events AFTER the tx commits (Codex: accumulate during, emit
  // after). Summary-first when counts are large so the 200-event replay buffer
  // isn't flooded. never-throws.
  function emitMemoryEvents(result) {
    if (!eventBus || !result) return;
    try {
      const { projectId, promoted = [], evicted = [] } = result;
      if (promoted.length > 5) {
        eventBus.emit('memory:promoted', { projectId, count: promoted.length, batch: true });
      } else {
        for (const p of promoted) eventBus.emit('memory:promoted', { projectId, memoryItemId: p.itemId, merged: p.merged });
      }
      if (evicted.length > 5) {
        eventBus.emit('memory:evicted', { projectId, count: evicted.length, batch: true, reason: 'cap_evicted' });
      } else {
        for (const e of evicted) eventBus.emit('memory:evicted', { projectId, memoryItemId: e.itemId, score: e.score, reason: 'cap_evicted' });
      }
    } catch { /* observability must never break promotion */ }
  }

  function promoteCandidates({ jobId, claimToken, proposals, activeCap = DEFAULT_ACTIVE_CAP, confidenceCeiling = DEFAULT_CONFIDENCE_CEILING, maxLen = DEFAULT_MAX_LEN, ttlDays = DEFAULT_TTL_DAYS } = {}) {
    if (!jobId || !claimToken) throw new Error('jobId and claimToken are required');
    const result = promoteCandidatesBatchTx({ jobId, claimToken, proposals, activeCap, confidenceCeiling, maxLen, ttlDays });
    emitMemoryEvents(result);
    return result;
  }

  // PR5d decay maintenance: archive active rows whose TTL has passed so they
  // stop being injected AND free cap. Skips human/pinned/fact implicitly —
  // those are never given a valid_to (only batch_llm promotions are). One tx;
  // revision bumps per affected project; emits a single summary event.
  const expireStaleTx = db.transaction(() => {
    const rows = listExpiredStmt.all();
    const projects = new Set();
    let archived = 0;
    for (const r of rows) {
      const res = archiveExpiredStmt.run({ id: r.id });
      if (res.changes === 1) { archived += 1; projects.add(r.project_id); }
    }
    for (const pid of projects) _bumpRevision(pid);
    return archived;
  });
  function expireStaleMemories() {
    let count = 0;
    try { count = expireStaleTx(); } catch { return 0; }
    if (count > 0 && eventBus) {
      try { eventBus.emit('memory:decayed', { count, reason: 'ttl_expired' }); } catch { /* */ }
    }
    return count;
  }

  // ------------------------------------------------------------------------
  // PR4: post-hoc correction CRUD. update content / archive / restore / review
  // / pin. Any change to the ACTIVE injected set bumps the revision so the next
  // PM session re-injects; review/pin don't change injected text so they don't.
  // ------------------------------------------------------------------------
  const updateContentStmt = db.prepare(
    "UPDATE memory_items SET content=@content, content_hash=@contentHash, updated_at=datetime('now') WHERE id=@id AND status='active'"
  );
  const archiveStmt = db.prepare(
    "UPDATE memory_items SET status='archived', archived_at=datetime('now'), archive_reason='manual', updated_at=datetime('now') WHERE id=@id AND status='active'"
  );
  // restore clears archived_at AND archive_reason so a later re-archive doesn't
  // retain a stale reason (e.g. 'cap_evicted') — Codex SERIOUS.
  const restoreStmt = db.prepare(
    "UPDATE memory_items SET status='active', archived_at=NULL, archive_reason=NULL, updated_at=datetime('now') WHERE id=@id AND status='archived'"
  );
  // PR5d: marking an item reviewed is a re-observation — it refreshes valid_to
  // (extends the TTL) for auto memories. Permanent rows (valid_to IS NULL:
  // human/pinned/fact) stay permanent (Codex re-observation requirement).
  const markReviewedStmt = db.prepare(
    "UPDATE memory_items SET reviewed_at=datetime('now'), " +
    "valid_to = CASE WHEN valid_to IS NOT NULL THEN datetime('now', @offset) ELSE NULL END, " +
    "updated_at=datetime('now') WHERE id=@id"
  );
  const pinStmt = db.prepare(
    "UPDATE memory_items SET pinned=@pinned, updated_at=datetime('now') WHERE id=@id"
  );

  const updateContentTx = db.transaction(({ id, content, contentHash }) => {
    const before = getMemoryItemByIdStmt.get(id);
    const res = updateContentStmt.run({ id, content, contentHash });
    if (res.changes !== 1) return null; // missing or not active
    _bumpRevision(before.project_id);
    return getMemoryItemByIdStmt.get(id);
  });
  const archiveTx = db.transaction((id) => {
    const before = getMemoryItemByIdStmt.get(id);
    const res = archiveStmt.run({ id });
    if (res.changes !== 1) return null; // missing or not active
    _bumpRevision(before.project_id);
    return getMemoryItemByIdStmt.get(id);
  });
  // restore re-activates an archived row, so it is ALSO an admission into the
  // active set and must pass the hard cap (Codex: every active transition, not
  // just new inserts). If the project is full it evicts the lowest-score
  // evictable item iff the restored item beats it, else throws MEMORY_CAP_FULL.
  const restoreTx = db.transaction(({ id, activeCap }) => {
    const before = getMemoryItemByIdStmt.get(id);
    if (!before || before.status !== 'archived') return { item: null, evicted: null };
    // S5-STORAGE: read owner directly from the item row (backfilled by migration 033).
    // Falls back to normalizeOwner only when columns are absent (pre-033 test fixtures).
    const ownerType = before.owner_type || normalizeOwner({ project_id: before.project_id }).owner_type;
    const ownerId = before.owner_id || normalizeOwner({ project_id: before.project_id }).owner_id;
    let evicted = null;
    const activeCount = countActiveItemsStmt.get(ownerType, ownerId).n;
    if (activeCount >= activeCap) {
      const score = (before.confidence || 0) * (before.importance || 1);
      const victim = lowestEvictableStmt.get(ownerType, ownerId);
      if (!victim || score <= victim.score) {
        const e = new Error('cannot restore: active memory is at capacity');
        e.code = 'MEMORY_CAP_FULL';
        throw e;
      }
      archiveVictimStmt.run({ id: victim.id, reason: 'cap_evicted' });
      evicted = { itemId: victim.id, score: victim.score };
    }
    const res = restoreStmt.run({ id });
    if (res.changes !== 1) return { item: null, evicted: null };
    _bumpRevision(before.project_id);
    return { item: getMemoryItemByIdStmt.get(id), evicted };
  });

  function getMemoryItem(id) {
    return getMemoryItemByIdStmt.get(id) || null;
  }

  function updateMemoryContent({ id, content } = {}) {
    if (!id) throw new Error('id is required');
    if (!content || typeof content !== 'string') throw new Error('content is required');
    try {
      return updateContentTx({ id, content, contentHash: sha256(content) });
    } catch (err) {
      if (isUniqueConstraint(err, 'content_hash')) {
        const e = new Error('an active memory item with this content already exists');
        e.code = 'MEMORY_DUPLICATE';
        throw e;
      }
      throw err;
    }
  }

  function archiveMemory(id) {
    if (!id) throw new Error('id is required');
    return archiveTx(id);
  }

  function restoreMemory(id, { activeCap = DEFAULT_ACTIVE_CAP } = {}) {
    if (!id) throw new Error('id is required');
    let out;
    try {
      out = restoreTx({ id, activeCap });
    } catch (err) {
      // restoring re-activates the row; if an active item now shares its
      // content_hash or fact_key the partial-unique index fires.
      if (isUniqueConstraint(err, 'content_hash') || isUniqueConstraint(err, 'fact_key')) {
        const e = new Error('cannot restore: an active item with the same content or fact_key exists');
        e.code = 'MEMORY_DUPLICATE';
        throw e;
      }
      throw err; // MEMORY_CAP_FULL propagates
    }
    if (out.evicted && eventBus) {
      try {
        eventBus.emit('memory:evicted', {
          projectId: out.item ? out.item.project_id : null,
          memoryItemId: out.evicted.itemId, score: out.evicted.score, reason: 'cap_evicted',
        });
      } catch { /* observability must never break restore */ }
    }
    return out.item;
  }

  function markReviewed(id, { ttlDays = DEFAULT_TTL_DAYS } = {}) {
    if (!id) throw new Error('id is required');
    const res = markReviewedStmt.run({ id, offset: `+${Math.floor(ttlDays)} days` });
    return res.changes === 1 ? getMemoryItemByIdStmt.get(id) : null;
  }

  function setPinned({ id, pinned } = {}) {
    if (!id) throw new Error('id is required');
    const res = pinStmt.run({ id, pinned: pinned ? 1 : 0 });
    return res.changes === 1 ? getMemoryItemByIdStmt.get(id) : null;
  }

  // -------------------------------------------------------------------------
  // P-A1 slice 1: parity check + cross-scope conflict detection (slice-5 gate)
  // -------------------------------------------------------------------------

  // Scan ALL rows across the 9 owner-bearing tables and verify that
  // (owner_type, owner_id) matches normalizeOwner(old-key) for each row.
  // Returns a list of mismatches; empty list means parity holds.
  // L1 old-key = project_id; L2 old-key = scope.
  function checkOwnerParity() {
    const mismatches = [];

    // L1 tables: expected owner_type='workspace', owner_id=project_id
    const l1Tables = [
      { table: 'memory_items',             pk: 'id',            keyCol: 'project_id' },
      { table: 'memory_candidates',        pk: 'id',            keyCol: 'project_id' },
      { table: 'memory_jobs',              pk: 'id',            keyCol: 'project_id' },
      { table: 'project_memory_revision',  pk: 'project_id',    keyCol: 'project_id' },
      { table: 'pm_memory_injection',      pk: 'pm_run_id',     keyCol: 'project_id' },
    ];

    for (const { table, pk, keyCol } of l1Tables) {
      const rows = db.prepare(`SELECT ${pk}, ${keyCol}, owner_type, owner_id FROM ${table}`).all();
      for (const row of rows) {
        let expected;
        try {
          expected = normalizeOwner({ project_id: row[keyCol] });
        } catch {
          mismatches.push({ table, pk: row[pk], expected: null, actual: { owner_type: row.owner_type, owner_id: row.owner_id }, error: 'cannot_normalize_old_key' });
          continue;
        }
        if (row.owner_type !== expected.owner_type || row.owner_id !== expected.owner_id) {
          mismatches.push({
            table,
            pk: row[pk],
            expected,
            actual: { owner_type: row.owner_type, owner_id: row.owner_id },
          });
        }
      }
    }

    // L2 tables: expected owner_type='user', owner_id='user' (all scopes collapse)
    const l2Tables = [
      { table: 'master_memory_items',      pk: 'id',               keyCol: 'scope' },
      { table: 'master_memory_candidates', pk: 'id',               keyCol: 'scope' },
      { table: 'master_memory_revision',   pk: 'scope',            keyCol: 'scope' },
      { table: 'master_memory_injection',  pk: 'master_run_id',    keyCol: 'scope' },
    ];

    for (const { table, pk, keyCol } of l2Tables) {
      const rows = db.prepare(`SELECT ${pk}, ${keyCol}, owner_type, owner_id FROM ${table}`).all();
      for (const row of rows) {
        const pkVal = table === 'master_memory_injection' ? `${row.master_run_id}|${row.scope}` : row[pk];
        let expected;
        try {
          expected = normalizeOwner({ scope: row[keyCol] });
        } catch {
          mismatches.push({ table, pk: pkVal, expected: null, actual: { owner_type: row.owner_type, owner_id: row.owner_id }, error: 'cannot_normalize_old_key' });
          continue;
        }
        if (row.owner_type !== expected.owner_type || row.owner_id !== expected.owner_id) {
          mismatches.push({
            table,
            pk: pkVal,
            expected,
            actual: { owner_type: row.owner_type, owner_id: row.owner_id },
          });
        }
      }
    }

    return mismatches;
  }

  // Detect rows in master_memory_items and master_memory_candidates that WOULD
  // collide under a future slice-5 owner-UNIQUE key, now that scope∈{user,cross_project}
  // has been collapsed to ('user','user'). POLICY (merge/reject) is slice 5;
  // this function only DETECTS.
  //
  // Returns { items: [...], candidates: [...] } where each entry describes a
  // duplicate group: { owner_type, owner_id, key, key_value, count, ids }.
  function detectCrossScopeConflicts() {
    // Conflicts in master_memory_items:
    //   (a) duplicate (owner_type, owner_id, content_hash) for active rows
    //   (b) duplicate (owner_type, owner_id, fact_key) where fact_key NOT NULL for active rows
    const hashConflicts = db.prepare(`
      SELECT owner_type, owner_id, content_hash, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
      FROM master_memory_items
      WHERE owner_type IS NOT NULL AND owner_id IS NOT NULL AND status = 'active'
      GROUP BY owner_type, owner_id, content_hash
      HAVING COUNT(*) > 1
    `).all();

    const factKeyConflicts = db.prepare(`
      SELECT owner_type, owner_id, fact_key, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
      FROM master_memory_items
      WHERE owner_type IS NOT NULL AND owner_id IS NOT NULL
        AND fact_key IS NOT NULL AND status = 'active'
      GROUP BY owner_type, owner_id, fact_key
      HAVING COUNT(*) > 1
    `).all();

    const itemConflicts = [
      ...hashConflicts.map(r => ({
        owner_type: r.owner_type, owner_id: r.owner_id,
        key: 'content_hash', key_value: r.content_hash,
        count: r.n, ids: r.ids ? r.ids.split('|') : [],
      })),
      ...factKeyConflicts.map(r => ({
        owner_type: r.owner_type, owner_id: r.owner_id,
        key: 'fact_key', key_value: r.fact_key,
        count: r.n, ids: r.ids ? r.ids.split('|') : [],
      })),
    ];

    // Conflicts in master_memory_candidates:
    //   duplicate (owner_type, owner_id, rule, dedup_key) across all statuses.
    //   status='pending' was too narrow (missed promoted/merged/rejected rows that
    //   would violate a future owner-UNIQUE index). rule is included so that two
    //   different rules with the same dedup_key are NOT reported as false positives.
    const candConflicts = db.prepare(`
      SELECT owner_type, owner_id, rule, dedup_key, COUNT(*) AS n, GROUP_CONCAT(id, '|') AS ids
      FROM master_memory_candidates
      WHERE owner_type IS NOT NULL AND owner_id IS NOT NULL
      GROUP BY owner_type, owner_id, rule, dedup_key
      HAVING COUNT(*) > 1
    `).all().map(r => ({
      owner_type: r.owner_type, owner_id: r.owner_id,
      rule: r.rule,
      key: 'dedup_key', key_value: r.dedup_key,
      count: r.n, ids: r.ids ? r.ids.split('|') : [],
    }));

    return { items: itemConflicts, candidates: candConflicts };
  }

  return {
    _bumpRevision,
    getRevision,
    createMemoryItem,
    upsertFact,
    createCandidate,
    listCandidates,
    listProjectsWithPendingCandidates,
    listOwnersWithPendingCandidates,
    enqueueDistillJob,
    claimDistillJob,
    requeueStaleJobs,
    releaseDistillJob,
    promoteCandidates,
    expireStaleMemories,
    getMemoryItem,
    updateMemoryContent,
    archiveMemory,
    restoreMemory,
    markReviewed,
    setPinned,
    retrieveForProject,
    buildInjectionBlock,
    listForProject,
    listActiveForDistill,
    checkOwnerParity,
    detectCrossScopeConflicts,
  };
}

module.exports = { createMemoryService };
