const crypto = require('node:crypto');

const TOP_K = 12;
const CHAR_CAP = 2000;
const MAX_QUERY_TERMS = 32;

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

  function upsertFact({ projectId, factKey, content, evidenceJson, importance } = {}) {
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
      origin: 'rule:R6',
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

  return {
    _bumpRevision,
    getRevision,
    createMemoryItem,
    upsertFact,
    retrieveForProject,
    buildInjectionBlock,
    listForProject,
    getInjectionRecord,
    recordInjection,
    shouldInject,
  };
}

module.exports = { createMemoryService };
