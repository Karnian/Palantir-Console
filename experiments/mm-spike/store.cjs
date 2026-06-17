'use strict';
// Master Memory spike store — minimal FTS-only ops. CommonJS for standalone `node store.cjs`.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');

function open(dbPath) {
  const db = new Database(dbPath || ':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

function ingestEvent(db, e) {
  const id = e.id || uid('evt');
  const occurred_at = e.occurred_at || new Date().toISOString();
  const content = e.content_redacted == null ? null : String(e.content_redacted);
  const metadata_hash = sha([e.source, e.event_type, e.actor, e.project_id, occurred_at].join('|'));
  db.prepare(`INSERT INTO mm_events (id,source,event_type,actor,project_id,occurred_at,content_redacted,sensitivity,ttl_at,metadata_hash,content_hash)
    VALUES (@id,@source,@event_type,@actor,@project_id,@occurred_at,@content_redacted,@sensitivity,@ttl_at,@metadata_hash,@content_hash)`)
    .run({ id, source: e.source, event_type: e.event_type, actor: e.actor || null, project_id: e.project_id || null,
      occurred_at, content_redacted: content, sensitivity: e.sensitivity || 'normal', ttl_at: e.ttl_at || null,
      metadata_hash, content_hash: content == null ? null : sha(content) });
  // U3: only events that carry content get a retrievable chunk (broad metadata-only events do not)
  if (content != null) {
    db.prepare(`INSERT INTO mm_chunks (id,owner_type,owner_id,text,project_id,sensitivity) VALUES (?,?,?,?,?,?)`)
      .run(uid('chk'), 'event', id, content, e.project_id || null, e.sensitivity || 'normal');
  }
  return id;
}

// canonical retrieval/render text from claim components
function claimText(c) {
  const obj = typeof c.object_json === 'string' ? c.object_json : JSON.stringify(c.object_json);
  return `${c.subject} ${c.predicate}: ${obj}${c.context ? ' (' + c.context + ')' : ''}`;
}

function upsertClaim(db, c, evidenceEventIds) {
  const id = c.id || uid('clm');
  const object_json = typeof c.object_json === 'string' ? c.object_json : JSON.stringify(c.object_json);
  const content_hash = sha([c.subject, c.predicate, object_json, c.scope_project_id ?? '', c.context ?? ''].join('|'));
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO mm_claims (id,subject,predicate,object_json,scope_project_id,context,kind,page,slot_key,source_kind,status,confidence,importance,explicitness,pinned,valid_from,valid_to,supersedes_id,content_hash)
      VALUES (@id,@subject,@predicate,@object_json,@scope_project_id,@context,@kind,@page,@slot_key,@source_kind,@status,@confidence,@importance,@explicitness,@pinned,@valid_from,@valid_to,@supersedes_id,@content_hash)`)
      .run({ id, subject: c.subject, predicate: c.predicate, object_json, scope_project_id: c.scope_project_id ?? null,
        context: c.context ?? null, kind: c.kind, page: c.page ?? null, slot_key: c.slot_key ?? null,
        source_kind: c.source_kind || 'human', status: c.status || 'active', confidence: c.confidence ?? 0.5,
        importance: c.importance ?? 5, explicitness: c.explicitness ?? 5, pinned: c.pinned ? 1 : 0,
        valid_from: c.valid_from ?? null, valid_to: c.valid_to ?? null, supersedes_id: c.supersedes_id ?? null, content_hash });
    db.prepare(`INSERT INTO mm_chunks (id,owner_type,owner_id,text,project_id,sensitivity) VALUES (?,?,?,?,?,?)`)
      .run(uid('chk'), 'claim', id, claimText(c), c.scope_project_id ?? null, c.sensitivity || 'normal');
    for (const evId of (evidenceEventIds || [])) {
      db.prepare(`INSERT OR IGNORE INTO mm_claim_evidence (claim_id,event_id) VALUES (?,?)`).run(id, evId);
    }
  });
  tx();
  return id;
}

// FTS5 MATCH builder: tokenize to words, quote each, OR-join (escape-safe; empty -> null)
function ftsQuery(text) {
  const toks = String(text).match(/[\p{L}\p{N}_]+/gu) || [];
  if (!toks.length) return null;
  return toks.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
}

// distilled-claim retrieval (A7-style): FTS over claim chunks -> active claims
function retrieve(db, query, k = 5, scope = null) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.prepare(`
    SELECT cl.*, bm25(mm_chunks_fts) AS rank
    FROM mm_chunks_fts
    JOIN mm_chunks ch ON ch.rowid_pk = mm_chunks_fts.rowid AND ch.owner_type='claim'
    JOIN mm_claims cl ON cl.id = ch.owner_id
    WHERE mm_chunks_fts MATCH ? AND cl.status='active'
      AND (cl.scope_project_id IS NULL OR cl.scope_project_id = ?)
    ORDER BY rank ASC, cl.importance DESC
    LIMIT ?`).all(m, scope, k);
}

// raw-event retrieval (A4-style): FTS over original event text (noisy, undistilled)
function retrieveRaw(db, query, k = 5, scope = null) {
  const m = ftsQuery(query);
  if (!m) return [];
  return db.prepare(`
    SELECT ch.text AS text, ch.owner_id AS event_id, bm25(mm_chunks_fts) AS rank
    FROM mm_chunks_fts
    JOIN mm_chunks ch ON ch.rowid_pk = mm_chunks_fts.rowid AND ch.owner_type='event'
    WHERE mm_chunks_fts MATCH ?
      AND (ch.project_id IS NULL OR ch.project_id = ?)
    ORDER BY rank ASC
    LIMIT ?`).all(m, scope, k);
}

const getClaim = (db, id) => db.prepare(`SELECT * FROM mm_claims WHERE id=?`).get(id);
const claimsBySlot = (db, page, slot, excludeId) =>
  db.prepare(`SELECT * FROM mm_claims WHERE page=? AND slot_key=? AND status='active' AND id != ?`).all(page, slot, excludeId || '');
const recentClaims = (db, n) =>
  db.prepare(`SELECT * FROM mm_claims WHERE status='active' ORDER BY rowid DESC LIMIT ?`).all(n);

module.exports = { open, ingestEvent, upsertClaim, retrieve, retrieveRaw, getClaim, claimsBySlot, recentClaims, claimText, ftsQuery, sha, uid };

// smoke
if (require.main === module) {
  const db = open(':memory:');
  const ev = ingestEvent(db, { source: 'remember', event_type: 'explicit', actor: 'human', content_redacted: 'tests must use node --test, not jest' });
  upsertClaim(db, { subject: 'user', predicate: 'test runner', object_json: 'node --test (not jest)', kind: 'constraint',
    page: 'UserConstraints', slot_key: 'testing', source_kind: 'human', confidence: 1.0, importance: 8, pinned: 1 }, [ev]);
  console.log('claim retrieve:', retrieve(db, 'run the test suite', 3).map((x) => x.object_json));
  console.log('raw retrieve:  ', retrieveRaw(db, 'run the test suite', 3).map((x) => x.text));
  console.log('OK store works (claim + event chunks)');
}
