'use strict';

const { pathToFileURL } = require('node:url');
const path = require('node:path');
const storeDefault = require('./observeSnapshotStore');
const { isSafeId, isSafeInstructionId } = require('./observeSnapshotPolicy');
const { redactSecrets } = require('./memorySanitize');

let board;
const loadBoard = () => {
  board ||= import(pathToFileURL(path.join(__dirname, '../public/app/lib/workBoard.js')).href);
  return board;
};
const MAX_BYTES = 65536;
const INCOMPLETE_KEYS = Object.freeze({
  claude: ['files_failed', 'records_unknown', 'records_unverified', 'multi_file_withheld',
    'mixed_session_withheld', 'invalid_time_withheld', 'large_file_withheld', 'queued_duplicate_withheld',
    'link_blocked'],
  codex: ['files_failed', 'records_unknown', 'records_unverified', 'unsupported_sessions', 'withheld_sessions',
    'multi_file_withheld', 'mixed_session_withheld', 'invalid_time_withheld', 'large_file_withheld', 'link_blocked'],
});
const FLAGS = ['text_missing', 'source_truncated', 'clipped_text', 'attachments', 'unknown_blocks'];
const REV_RE = /^[0-9a-f]{16}$/;
const size = value => Buffer.byteLength(JSON.stringify(value));
const invalid = () => { throw new Error('invalid_query'); };

function queryOptions(query, search = false, detail = false) {
  const allowed = detail ? ['rev', 'around'] : ['machine', 'provider', 'limit', 'cursor', ...(search ? ['q'] : [])];
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== 'string') invalid();
  }
  if (detail) {
    if (query.rev !== undefined && !REV_RE.test(query.rev)) invalid();
    if (query.around !== undefined && (!isSafeInstructionId(query.around) || !query.rev)) invalid();
    return query;
  }
  if (query.machine && !isSafeId(query.machine)) invalid();
  if (query.provider && !['claude', 'codex'].includes(query.provider)) invalid();
  if (search && (!query.q || query.q.length > 200)) invalid();
  const max = search ? 15 : 30;
  if (query.limit !== undefined && !/^[1-9][0-9]*$/.test(query.limit)) invalid();
  const limit = query.limit === undefined ? (search ? 10 : 20) : Number(query.limit);
  if (!Number.isSafeInteger(limit) || limit > max) invalid();
  let offset = 0;
  let rev = null;
  if (query.cursor !== undefined) {
    const match = /^([0-9a-f]{16})\.(0|[1-9][0-9]*)$/.exec(query.cursor);
    if (!match || !Number.isSafeInteger(Number(match[2]))) invalid();
    rev = match[1]; offset = Number(match[2]);
  }
  return { ...query, limit, offset, rev };
}

function instructionFlags(row, clipped = false) {
  if (!row) return [];
  const values = { text_missing: row.text_missing, source_truncated: row.truncated, clipped_text: clipped,
    attachments: row.attachments > 0, unknown_blocks: row.unknown_blocks > 0 };
  return FLAGS.filter(key => values[key]);
}

function sliceText(value, start, limit) {
  let end = Math.min(value.length, start + limit);
  const splitsPair = index => {
    const before = value.charCodeAt(index - 1);
    const after = value.charCodeAt(index);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  };
  if (splitsPair(start)) start++;
  if (splitsPair(end)) end--;
  return value.slice(start, end);
}

function createSessionHubBroker({ state, store = storeDefault, now = () => new Date() }) {
  async function load() {
    const result = store.readAllSnapshots(state);
    if (!result.ok) throw new Error('snapshot_unavailable');
    const helpers = await loadBoard();
    const readable = result.snapshots.filter(entry => entry.ok);
    const meta = {
      rev: storeDefault.snapshotRevision(result.snapshots),
      machines: readable.slice(0, 16).map(({ snapshot }) => ({
        id: snapshot.machine.id, label: snapshot.machine.label, generated_at: snapshot.generated_at,
        orca: snapshot.coverage.orca.state,
        incomplete: Object.fromEntries(Object.entries(INCOMPLETE_KEYS).map(([provider, keys]) =>
          [provider, keys.filter(key => snapshot.coverage[provider][key] > 0)])),
      })),
      machines_clipped: readable.length > 16,
      unreadable: result.snapshots.length - readable.length,
      now: now().toISOString(),
    };
    return { helpers, meta, cards: readable.flatMap(entry => helpers.snapshotCards(entry.snapshot)) };
  }

  function fullText(helpers, value) {
    return value == null ? null : redactSecrets(helpers.displayInstructionText(value)).text;
  }

  function text(helpers, value, cap) {
    const full = fullText(helpers, value);
    return full === null ? null : sliceText(full, 0, cap);
  }

  function summary(card, helpers) {
    const first = card.first_instruction === 'recoverable' ? card.instructions[0] : null;
    const recent = card.instructions.at(-1);
    const firstText = first?.text_missing ? null : text(helpers, first?.text, 120);
    const recentText = recent?.text_missing ? null : text(helpers, recent?.text, 120);
    return {
      key: card.key, machine: card.machine.label, provider: card.provider,
      repo: card.repo_label, branch: card.git_branch, title: text(helpers, card.ai_title, 80),
      first: firstText, first_status: card.first_instruction, compact_only_history: card.compact_only_history,
      first_flags: instructionFlags(first, firstText !== null && firstText !== text(helpers, first?.text, Infinity)),
      recent: recentText, recent_at: recent?.ts || null,
      recent_flags: instructionFlags(recent,
        recentText !== null && recentText !== text(helpers, recent?.text, Infinity)),
      format_unverified: card.format_unverified,
      instruction_total: card.instruction_total, instructions_held: card.instructions.length,
      last_record_at: card.last_record_at,
      orca: { link: card.orca_link.confirmed ? 'confirmed' : 'unknown',
        state: card.orca_link.confirmed ? card.agent?.state || null : null,
        state_since: card.orca_link.confirmed ? card.agent?.state_started_at || null : null },
    };
  }

  function snippet(helpers, row, query) {
    const full = fullText(helpers, row.text);
    const match = helpers.matchText(full, query);
    const line = match ? helpers.matchedLines(full, query) : full;
    const parts = helpers.highlightParts(line, query);
    const marked = parts.find(part => part.highlighted);
    const position = parts[0]?.highlighted ? 0 : parts[0]?.text.length || 0;
    const matchLength = marked?.text.length || 0;
    const centered = Math.floor(position + matchLength / 2 - 120);
    const start = match ? Math.max(0, Math.min(centered, line.length - 240)) : 0;
    const clipped = !match || line.length > 240 || line !== full;
    return { id: row.id, ts: row.ts, snippet: sliceText(line, start, 240),
      flags: instructionFlags(row, clipped) };
  }

  async function list(query, search = false) {
    const options = queryOptions(query, search);
    const { helpers, meta, cards } = await load();
    if (options.rev && options.rev !== meta.rev) throw new Error('snapshot_changed');
    if (search && !helpers.normalizeSearch(options.q).compact) invalid();
    const ranked = helpers.rankCards(cards, search ? options.q : '', options.machine, options.provider);
    const sessions = ranked.slice(options.offset, options.offset + options.limit).map(card => {
      const item = summary(card, helpers);
      if (search) {
        item.instructions = card.instructions.filter(row => helpers.matchText(row.text, options.q))
          .slice(0, 3).map(row => snippet(helpers, row, options.q));
        item.title_match = !!helpers.matchText(card.ai_title, options.q);
      }
      return item;
    });
    const response = { sessions, total: ranked.length, next: null, meta, clipped: false };
    const cursor = () => {
      const offset = options.offset + sessions.length;
      response.next = offset < ranked.length ? `${meta.rev}.${offset}` : null;
    };
    cursor();
    while (size(response) > MAX_BYTES && sessions.length) {
      sessions.pop(); response.clipped = true; cursor();
    }
    return response;
  }

  function instruction(row, helpers, cap) {
    const full = text(helpers, row.text, Infinity);
    const clipped = full.length > cap;
    return { id: row.id, ts: row.ts, kind: row.kind, text: text(helpers, row.text, cap),
      text_missing: row.text_missing, source_truncated: row.truncated, attachments: row.attachments,
      unknown_blocks: row.unknown_blocks, clipped_text: clipped };
  }

  async function detail(key, query) {
    if (!isSafeId(key)) invalid();
    const options = queryOptions(query, false, true);
    const { helpers, meta, cards } = await load();
    if (options.rev && options.rev !== meta.rev) throw new Error('snapshot_changed');
    const card = cards.find(item => item.key === key);
    if (!card) throw new Error('not_found');
    let rows = card.instructions.slice(-30);
    if (options.around) {
      const index = card.instructions.findIndex(row => row.id === options.around);
      if (index < 0) throw new Error('not_found');
      const start = Math.max(0, Math.min(index - 15, card.instructions.length - 30));
      rows = card.instructions.slice(start, start + 30);
    }
    const first = card.first_instruction === 'recoverable' ? card.instructions[0] : null;
    // Preserve the newest instruction even when an around window is far from the tail.
    const latest = card.instructions.at(-1);
    if (latest && !rows.includes(latest)) rows = [...rows.slice(0, 29), latest];
    const response = { session: summary(card, helpers), first: null, instructions: [], meta, clipped: false };
    for (const cap of [1500, 800, 400, 200]) {
      response.first = first ? instruction(first, helpers, cap) : null;
      response.instructions = rows.map(row => instruction(row, helpers, cap));
      response.clipped = !!response.first?.clipped_text || response.instructions.some(row => row.clipped_text);
      if (size(response) <= MAX_BYTES) return response;
    }
    const protectedIds = new Set([first?.id, options.around, latest?.id]);
    while (size(response) > MAX_BYTES) {
      const index = response.instructions.findIndex(row => !protectedIds.has(row.id));
      if (index < 0) throw new Error('snapshot_unavailable');
      response.instructions.splice(index, 1); response.clipped = true;
    }
    return response;
  }

  return { list: query => list(query), search: query => list(query, true), detail };
}

module.exports = { createSessionHubBroker, INCOMPLETE_KEYS, MAX_BYTES };
