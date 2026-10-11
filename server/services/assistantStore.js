'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { redactSecrets } = require('./memorySanitize');
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const MAX_MESSAGE_BYTES = 65536;

function utf8Prefix(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}
const sanitize = text => utf8Prefix(redactSecrets(text).text, MAX_MESSAGE_BYTES);

const contentHash = text => createHash('sha256').update(sanitize(text)).digest('hex');

function createAssistantStore(db, { maxMessages = 5000, now = () => new Date().toISOString() } = {}) {
  const active = () => db.prepare('SELECT thread_id FROM assistant_active_thread WHERE singleton = 1').get()?.thread_id;
  const requireThread = (id, includeDeleting = false) => {
    const row = db.prepare('SELECT * FROM assistant_threads WHERE id = ?').get(id);
    if (!row || row.deleting && !includeDeleting) throw fail('not_found', 404);
    return row;
  };
  function insert(threadId, role, content, extra = {}) {
    requireThread(threadId);
    const seq = db.prepare('SELECT next_seq FROM assistant_threads WHERE id = ?').get(threadId).next_seq;
    db.prepare('UPDATE assistant_threads SET next_seq = next_seq + 1 WHERE id = ?').run(threadId);
    const row = { id: randomUUID(), thread_id: threadId, seq, role, content: sanitize(content),
      turn_id: extra.turn_id || null, request_id: extra.request_id || null, status: extra.status || 'complete',
      model_session_id: extra.model_session_id || null, created_at: now() };
    db.prepare(`INSERT INTO assistant_messages
      (id, thread_id, seq, turn_id, role, content, request_id, status, model_session_id, created_at) VALUES
      (@id, @thread_id, @seq, @turn_id, @role, @content,
        @request_id, @status, @model_session_id, @created_at)`).run(row);
    return row;
  }
  function prune(id) {
    const count = db.prepare('SELECT count(*) AS n FROM assistant_messages WHERE thread_id = ?').get(id).n;
    if (count <= maxMessages) return;
    db.prepare(`DELETE FROM assistant_messages WHERE id IN
      (SELECT id FROM assistant_messages WHERE thread_id = ? AND status != 'partial' ORDER BY seq LIMIT ?)`)
      .run(id, count - maxMessages + 1);
    insert(id, 'system_note', '오래된 대화 기록을 정리함');
  }
  const newThread = db.transaction((title = '새 대화') => {
    const previous = active();
    if (previous) db.prepare('UPDATE assistant_threads SET archived_at = ? WHERE id = ?').run(now(), previous);
    const row = { id: randomUUID(), title: [...redactSecrets(title).text].slice(0, 80).join(''),
      created_at: now(), archived_at: null };
    db.prepare('INSERT INTO assistant_threads(id, title, created_at) VALUES (@id, @title, @created_at)').run(row);
    db.prepare(`INSERT INTO assistant_active_thread VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET thread_id = excluded.thread_id`).run(row.id);
    return row;
  });
  if (!active()) newThread();
  const findRequest = (id, requestId) => {
    const receipt = db.prepare('SELECT * FROM assistant_requests WHERE thread_id = ? AND request_id = ?')
      .get(id, requestId);
    if (!receipt) return null;
    const user = db.prepare('SELECT * FROM assistant_messages WHERE thread_id = ? AND request_id = ?')
      .get(id, requestId) || null;
    const assistant = db.prepare(`SELECT * FROM assistant_messages
      WHERE thread_id = ? AND turn_id = ? AND role = 'assistant'`).get(id, receipt.turn_id) || null;
    return { receipt, user, assistant };
  };
  const reserve = db.transaction(({ thread_id, request_id, text }) => {
    const content = sanitize(text);
    const prior = findRequest(thread_id, request_id);
    if (prior) {
      if (prior.receipt.content_hash !== contentHash(content)) throw fail('request_conflict');
      return { ...prior, replayed: true };
    }
    if (active() !== thread_id) throw fail('thread_not_active');
    const turn_id = randomUUID();
    const user = insert(thread_id, 'user', content, { turn_id, request_id });
    const assistant = insert(thread_id, 'assistant', '', { turn_id, status: 'partial' });
    const receipt = { thread_id, request_id, content_hash: contentHash(content), turn_id, status: 'partial' };
    db.prepare(`INSERT INTO assistant_requests VALUES
      (@thread_id, @request_id, @content_hash, @turn_id, @status)`).run(receipt);
    const thread = requireThread(thread_id);
    if (user.seq === 1) {
      db.prepare('UPDATE assistant_threads SET title = ? WHERE id = ?')
        .run([...redactSecrets(content).text].slice(0, 80).join(''), thread.id);
    }
    prune(thread_id);
    return { user, assistant, receipt, replayed: false };
  });
  const append = db.transaction((id, role, text, extra) => {
    const row = insert(id, role, text, extra); prune(id); return row;
  });
  const update = db.transaction((id, content, status, modelSessionId = null) => {
    const row = db.prepare('SELECT thread_id, turn_id FROM assistant_messages WHERE id = ?').get(id);
    db.prepare(`UPDATE assistant_messages SET content = ?, status = ?,
      model_session_id = coalesce(?, model_session_id) WHERE id = ?`)
      .run(sanitize(content), status, modelSessionId, id);
    if (row) db.prepare('UPDATE assistant_requests SET status = ? WHERE thread_id = ? AND turn_id = ?')
      .run(status, row.thread_id, row.turn_id);
  });
  function messages(id, { before, limit = 50 } = {}) {
    requireThread(id);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50
      || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) throw fail('invalid_query', 400);
    return db.prepare(`SELECT * FROM assistant_messages WHERE thread_id = ? AND seq < ?
      ORDER BY seq DESC LIMIT ?`).all(id, before ?? Number.MAX_SAFE_INTEGER, limit).reverse();
  }
  function window(id) {
    const rows = messages(id).map(row => {
      if (Buffer.byteLength(JSON.stringify(row)) <= 128 * 1024) return row;
      return { ...row, content: utf8Prefix(row.content, 8192), truncated: true };
    });
    while (Buffer.byteLength(JSON.stringify(rows)) > 256 * 1024) rows.shift();
    return rows;
  }
  function search(id, q, limit = 10) {
    if (typeof q !== 'string' || !q.trim() || q.length > 200
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw fail('invalid_query', 400);
    requireThread(id);
    if (active() !== id) throw fail('forbidden', 403);
    const rows = db.prepare(`SELECT seq, role, created_at, content FROM assistant_messages
      WHERE thread_id = ? AND instr(lower(content), lower(?)) > 0 ORDER BY seq DESC LIMIT ?`).all(id, q, limit);
    const results = rows.map(({ content, ...row }) => {
      const chars = [...content];
      const position = [...content.slice(0, content.toLowerCase().indexOf(q.toLowerCase()))].length;
      const start = Math.max(0, position - 256);
      return { ...row, thread_id: id, snippet: chars.slice(start, start + 512).join('') };
    });
    const response = { thread_id: id, results, clipped: false };
    while (Buffer.byteLength(JSON.stringify(response)) > 65536) { results.pop(); response.clipped = true; }
    return response;
  }
  return { active, newThread, reserve, append, update, findRequest, messages, window, search, sanitize,
    contentHash,
    recover: db.transaction(() => {
      db.prepare(`UPDATE assistant_messages SET status = 'error',
        content = CASE WHEN content = '' THEN '서버 재시작으로 중단됨'
        ELSE substr(content, 1, 16000) || char(10) || '서버 재시작으로 중단됨'
        END WHERE status = 'partial'`).run();
      db.prepare("UPDATE assistant_requests SET status = 'error' WHERE status = 'partial'").run();
    }),
    deletingThreads: () => db.prepare('SELECT id FROM assistant_threads WHERE deleting = 1').all(),
    markDeleting: db.transaction(id => {
      requireThread(id, true);
      if (id === active()) throw fail('thread_active');
      db.prepare('UPDATE assistant_threads SET deleting = 1 WHERE id = ?').run(id);
    }),
    list: () => db.prepare(`SELECT t.id, t.title, t.created_at, t.archived_at,
      count(m.id) AS message_count FROM assistant_threads t LEFT JOIN assistant_messages m ON m.thread_id = t.id
      WHERE t.deleting = 0 GROUP BY t.id ORDER BY t.created_at DESC, t.id`).all(),
    get(id, mid) {
      requireThread(id);
      const row = db.prepare('SELECT * FROM assistant_messages WHERE thread_id = ? AND id = ?').get(id, mid);
      if (!row) throw fail('not_found', 404);
      return row;
    },
    delete: db.transaction(id => {
      requireThread(id, true);
      if (id === active()) throw fail('thread_active');
      db.prepare('DELETE FROM assistant_requests WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM assistant_messages WHERE thread_id = ?').run(id);
      db.prepare('DELETE FROM assistant_threads WHERE id = ?').run(id);
    }),
  };
}
module.exports = { createAssistantStore, utf8Prefix, sanitize, MAX_MESSAGE_BYTES };
