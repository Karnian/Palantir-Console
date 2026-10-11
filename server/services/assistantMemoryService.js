'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { redactSecrets, detectInjection } = require('./memorySanitize');
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const KINDS = ['preference', 'fact', 'person', 'project', 'other'];
const hash = content => createHash('sha256').update(content).digest('hex');
function sanitizeContent(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('invalid_content', 400);
  const content = redactSecrets(value).text;
  if (detectInjection(value) || detectInjection(content)) throw fail('memory_injection', 400);
  if ([...value].length > 500 || [...content].length > 500) throw fail('memory_too_long', 400);
  return content;
}
function sanitizeText(value = '') {
  if (typeof value !== 'string') throw fail('invalid_reason', 400);
  return [...redactSecrets(value).text].slice(0, 300).join('');
}
function requireKind(kind) {
  if (!KINDS.includes(kind)) throw fail('invalid_kind', 400);
  return kind;
}
function serializeMemories(rows) {
  const sorted = [...rows].filter(row => row.status === undefined || row.status === 'active')
    .sort((a, b) => (a.kind !== 'preference') - (b.kind !== 'preference')
      || String(b.updated_at).localeCompare(String(a.updated_at)) || String(a.id).localeCompare(String(b.id)));
  const selected = [];
  let excluded = 0;
  const block = n => `기억 자료\n${selected.join('\n')}\n기억 ${n}개 더 있음`;
  // Reserve the largest possible omission notice, including delimiters, within the UTF-8 budget.
  for (const row of sorted) {
    const content = redactSecrets(row.content).text;
    const entry = redactSecrets(JSON.stringify({ id: row.id, kind: row.kind, content })).text;
    if (detectInjection(row.content) || detectInjection(content) || detectInjection(entry)) { excluded++; continue; }
    selected.push(entry);
    if (Buffer.byteLength(block(sorted.length)) > 4096) { selected.pop(); excluded++; }
  }
  return { text: block(excluded), omitted_count: excluded };
}

function createAssistantMemoryService(db, { now = () => new Date().toISOString() } = {}) {
  const subscribers = new Set();
  const state = () => ({ pending_count: db.prepare(
    "SELECT count(*) AS n FROM assistant_memory_proposals WHERE status = 'pending'").get().n,
  revision: db.prepare('SELECT revision FROM assistant_memory_revision WHERE singleton = 1').get().revision });
  const emit = () => { for (const fn of subscribers) fn(state()); };
  const bump = () => db.prepare(
    'UPDATE assistant_memory_revision SET revision = revision + 1 WHERE singleton = 1').run();
  function audit(action, memoryId, proposalId, text) {
    db.prepare(`INSERT INTO assistant_memory_audit VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), action, memoryId, proposalId, sanitizeText(text), now());
  }
  function memory(id) {
    const row = db.prepare('SELECT * FROM assistant_memories WHERE id = ?').get(id);
    if (!row) throw fail('not_found', 404);
    return row;
  }
  function capacity() {
    if (db.prepare("SELECT count(*) AS n FROM assistant_memories WHERE status = 'active'").get().n >= 200) {
      throw fail('active_memory_limit');
    }
  }
  function insert(content, kind, origin) {
    capacity();
    const row = { id: randomUUID(), content: sanitizeContent(content), kind: requireKind(kind),
      status: 'active', revision: 1, content_hash: '', created_at: now(), updated_at: now(), origin };
    row.content_hash = hash(row.content);
    db.prepare(`INSERT INTO assistant_memories VALUES
      (@id, @content, @kind, @status, @revision, @content_hash, @created_at, @updated_at, @origin)`).run(row);
    return row;
  }
  const createProposal = db.transaction((input, source, onCreated) => {
    if (!input || !['add', 'forget'].includes(input.operation)) throw fail('invalid_operation', 400);
    const user = db.prepare(`SELECT id FROM assistant_messages
      WHERE id = ? AND thread_id = ? AND role = 'user'`).get(source?.source_message_id, source?.source_thread_id);
    if (!user) throw fail('invalid_source', 409);
    if (state().pending_count >= 20) throw fail('pending_memory_limit');
    if (input.operation === 'forget' && (typeof input.memory_id !== 'string'
      || !/^[A-Za-z0-9:_-]{1,128}$/.test(input.memory_id))) throw fail('invalid_memory_id', 400);
    const target = input.operation === 'forget' ? memory(input.memory_id) : null;
    if (target && target.status !== 'active') throw fail('memory_not_active');
    const content = sanitizeContent(target ? target.content : input.content);
    const row = { id: randomUUID(), operation: input.operation, content,
      kind: requireKind(target ? target.kind : input.kind), reason: sanitizeText(input.reason),
      target_memory_id: target?.id || null, target_revision: target?.revision || null,
      target_content_hash: target?.content_hash || null, status: 'pending', revision: 1, content_hash: hash(content),
      source_thread_id: source.source_thread_id, source_message_id: source.source_message_id,
      proposed_at: now(), decided_at: null };
    db.prepare(`INSERT INTO assistant_memory_proposals VALUES
      (@id, @operation, @content, @kind, @reason, @target_memory_id, @target_revision, @target_content_hash,
        @status, @revision, @content_hash, @source_thread_id, @source_message_id, @proposed_at, @decided_at)`).run(row);
    audit('proposed', target?.id || null, row.id, row.reason);
    onCreated?.(row);
    return row;
  });
  const decide = db.transaction((id, input) => {
    if (input?.decision === 'approve') input = { ...input, decision: 'approved' };
    if (input?.decision === 'reject') input = { ...input, decision: 'rejected' };
    if (!input || !['approved', 'rejected'].includes(input.decision)
      || !Number.isSafeInteger(input.revision) || typeof input.content_hash !== 'string') {
      throw fail('invalid_decision', 400);
    }
    const row = db.prepare('SELECT * FROM assistant_memory_proposals WHERE id = ?').get(id);
    if (!row) throw fail('not_found', 404);
    if (row.revision !== input.revision || row.content_hash !== input.content_hash) throw fail('proposal_conflict');
    if (row.status !== 'pending') {
      if (row.status === input.decision) return { proposal: row, replayed: true };
      throw fail('proposal_conflict');
    }
    let target = null;
    if (row.operation === 'forget') {
      target = db.prepare('SELECT * FROM assistant_memories WHERE id = ?').get(row.target_memory_id);
      if (!target || target.status !== 'active' || target.revision !== row.target_revision
        || target.content_hash !== row.target_content_hash) {
        db.prepare("UPDATE assistant_memory_proposals SET status = 'stale', decided_at = ? WHERE id = ?")
          .run(now(), id);
        audit('stale', row.target_memory_id, id, row.reason);
        return { stale: true };
      }
    }
    let changed = null;
    if (input.decision === 'approved') {
      if (target) {
        db.prepare(`UPDATE assistant_memories SET status = 'archived', revision = revision + 1,
          updated_at = ? WHERE id = ?`).run(now(), target.id);
        changed = memory(target.id);
      } else changed = insert(row.content, row.kind, 'proposal');
      bump();
    }
    db.prepare('UPDATE assistant_memory_proposals SET status = ?, decided_at = ? WHERE id = ?')
      .run(input.decision, now(), id);
    audit(input.decision, changed?.id || null, id, row.reason);
    return { proposal: { ...row, status: input.decision, decided_at: now() }, memory: changed, replayed: false };
  });
  const add = db.transaction(input => {
    const row = insert(input?.content, input?.kind, 'human');
    audit('added', row.id, null, row.content); bump(); return row;
  });
  const edit = db.transaction((id, input, archive = false) => {
    const row = memory(id);
    if (!input || input.revision !== row.revision) throw fail('memory_conflict');
    if (archive && row.status !== 'active') throw fail('memory_not_active');
    if (!archive && input.content === undefined && input.kind === undefined) throw fail('invalid_content', 400);
    const content = sanitizeContent(input.content === undefined ? row.content : input.content);
    const kind = requireKind(input.kind === undefined ? row.kind : input.kind);
    db.prepare(`UPDATE assistant_memories SET content = ?, kind = ?, status = ?, revision = revision + 1,
      content_hash = ?, updated_at = ? WHERE id = ?`)
      .run(content, kind, archive ? 'archived' : row.status, hash(content), now(), id);
    audit(archive ? 'archived' : 'edited', id, null, content);
    if (row.status === 'active') bump();
    return memory(id);
  });
  return {
    state, get: memory,
    active: () => db.prepare("SELECT * FROM assistant_memories WHERE status = 'active'").all(),
    injection() { return serializeMemories(this.active()); },
    list: () => ({ memories: db.prepare('SELECT * FROM assistant_memories ORDER BY updated_at DESC, id').all(),
      proposals: db.prepare(`SELECT p.*, m.content AS source_content,
        CASE WHEN m.id IS NULL THEN 'deleted' ELSE 'available' END AS source_status
        FROM assistant_memory_proposals p LEFT JOIN assistant_messages m ON m.id = p.source_message_id
        WHERE p.status = 'pending' ORDER BY p.proposed_at, p.id`).all(), ...state() }),
    propose(input, source, onCreated) { const row = createProposal(input, source, onCreated); emit(); return row; },
    decision(id, input) {
      const result = decide(id, input);
      if (!result.replayed) emit();
      if (result.stale) throw fail('proposal_stale');
      return result;
    },
    add(input) { const row = add(input); emit(); return row; },
    edit(id, input) { const row = edit(id, input); emit(); return row; },
    archive(id, input) { const row = edit(id, input, true); emit(); return row; },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}
module.exports = { createAssistantMemoryService, serializeMemories, sanitizeContent, sanitizeText, KINDS };
