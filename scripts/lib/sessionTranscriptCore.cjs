'use strict';

const crypto = require('node:crypto');
const snapshotPolicy = require('../../server/services/observeSnapshotPolicy.js');
const TRANSCRIPT_METADATA_LIMIT = 100000;
const PARSE_STATES = new WeakMap();
const computeHmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const computeKeyFingerprint = key => crypto.createHash('sha256').update(key).digest('hex');
const safeId = snapshotPolicy.isSafeId;
const isIdentityComponent = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) && safeId(value);
const normalizeDeletionText = value => value.normalize('NFC').trim();

function streamLimit() { const error = new Error('stream_limit'); error.streamLimit = true; throw error; }

function checkMetadata(size, max = TRANSCRIPT_METADATA_LIMIT) { if (size > max) streamLimit(); }

// Spec §1.4: the first identity from complete records survives a later limit failure.
function selectFirstTranscriptIdentity(provider, record, identity) {
  if (identity.selected) return;
  if (provider === 'codex' && record.type === 'session_meta') {
    identity.selected = true;
    identity.sessionId = record.payload?.id;
  } else if (provider === 'claude' && isIdentityComponent(record.sessionId)) {
    identity.selected = true;
    identity.sessionId = record.sessionId;
  }
}

function transcriptSource(input, provider, observation, { readStatusTail, transcriptRecords, metadataCheck = checkMetadata } = {}) {
  const headers = [];
  const array = Array.isArray(input);
  const source = array ? input : { streaming: true, limited: true, find(predicate) { return headers.find(predicate); } };
  if (array) source.limited = false;
  else source.statusRecords = () => readStatusTail(input, observation);
  const analysis = { byUuid: new Map(), firstTime: null, lastTime: null, duplicates: 0, invalidTime: 0,
    mixed: false, queuedDuplicate: false, sidechainOnly: true, singleSession: true, count: 0,
    journalOnly: true, brokenJson: false, hasSessionIdentity: false, instructionCandidates: 0, summaryCandidates: 0 };
  if (array) analysis.classifications = new WeakMap();
  const seen = new Set(), users = new Set(), queued = new Set(), sessions = new Set();
  let hasMeta = false, hasSid = false, hasCwd = false, hasBranch = false, firstSid;
  let timestampInput, timestampOutput;
  function observe(record) {
    analysis.count++;
    if (analysis.journalOnly && (Object.hasOwn(record, 'sessionId') || !['launched', 'started', 'result'].includes(record.type))) analysis.journalOnly = false;
    const state = PARSE_STATES.get(record);
    if (state?.invalid && !state.pending) analysis.brokenJson = true;
    if (provider === 'codex' && record.type === 'session_meta' && !hasMeta) {
      hasMeta = true;
      const payload = record.payload;
      headers.push({ type: 'session_meta', payload: payload ? { id: payload.id, cwd: payload.cwd,
        git: { branch: payload.git?.branch }, source: isRecordObject(payload.source)
          ? (Object.hasOwn(payload.source, 'subagent') ? { subagent: true } : {}) : payload.source,
        thread_source: payload.thread_source } : undefined });
    }
    if (provider === 'claude') {
      if (!hasSid && isIdentityComponent(record.sessionId)) {
        hasSid = true; firstSid = record.sessionId; headers.push({ sessionId: record.sessionId });
      }
      if (!hasCwd && typeof record.cwd === 'string') { hasCwd = true; headers.push({ cwd: record.cwd }); }
      if (!hasBranch && typeof record.gitBranch === 'string') { hasBranch = true; headers.push({ gitBranch: record.gitBranch }); }
    }
    if (record.timestamp !== timestampInput) { timestampInput = record.timestamp; timestampOutput = toIsoTimestamp(timestampInput); }
    const ts = timestampOutput || null;
    analysis.currentTime = ts;
    if (ts && (!analysis.firstTime || ts < analysis.firstTime)) analysis.firstTime = ts;
    if (ts && (!analysis.lastTime || ts > analysis.lastTime)) analysis.lastTime = ts;
    if (Object.hasOwn(record, 'timestamp') && !(typeof record.timestamp === 'string' && record.timestamp === ts)
      && !snapshotPolicy.isSafeTimestamp(record.timestamp)) analysis.invalidTime++;
    const sid = provider === 'claude' ? record.sessionId : record.type === 'session_meta' ? record.payload?.id : undefined;
    if (typeof sid === 'string') sessions.add(sid);
    if (provider === 'claude' ? Object.hasOwn(record, 'sessionId') : record.type === 'session_meta')
      analysis.hasSessionIdentity = true;
    if (record.isSidechain !== true) analysis.sidechainOnly = false;
    if (record.sessionId !== firstSid || !hasSid) analysis.singleSession = false;
    if (typeof record.uuid === 'string' && record.uuid) analysis.byUuid.set(record.uuid, Object.hasOwn(record, 'parentUuid')
      ? { parentUuid: typeof record.parentUuid === 'string' || record.parentUuid === null ? record.parentUuid : false } : {});
    const user = provider === 'claude' ? record.type === 'user'
      : record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user';
    const classification = provider === 'claude' ? classifyClaudeRecord(record)
      : user ? classifyCodexMessage(record.payload) : null;
    analysis.currentClassification = classification;
    if (array) analysis.classifications.set(record, classification);
    const attachment = provider === 'claude' && isQueuedInstruction(record, classification);
    if (classification?.kind && !classification.empty) analysis.instructionCandidates++;
    const identity = provider === 'claude' ? record.uuid : record.payload?.id;
    if ((user || attachment) && isIdentityComponent(identity)) {
      if (seen.has(identity)) {
        analysis.duplicates++;
        if (attachment) analysis.queuedDuplicate = true;
      }
      seen.add(identity);
    }
    if (provider === 'claude' && user) for (const id of [record.uuid, record.source_uuid, record.delivery_id,
      record.message?.uuid, record.message?.source_uuid, record.message?.delivery_id])
      if (typeof id === 'string') users.add(id);
    if (attachment) for (const id of [record.uuid, record.source_uuid, record.delivery_id, record.attachment.source_uuid, record.attachment.delivery_id])
      if (typeof id === 'string') queued.add(id);
    if (source.limited) metadataCheck(analysis.byUuid.size + seen.size + users.size + queued.size + sessions.size);
  }
  function finish() {
    delete analysis.currentClassification;
    analysis.mixed = sessions.size > 1;
    analysis.singleSession &&= sessions.size === 1;
    analysis.sidechainOnly &&= analysis.count > 0;
    if (source.limited) metadataCheck(analysis.byUuid.size + seen.size + users.size + queued.size + sessions.size);
    for (const id of queued) if (users.has(id)) { analysis.queuedDuplicate = true; break; }
  }
  source.analysis = analysis;
  if (array) {
    for (const record of input) { observe(record); selectFirstTranscriptIdentity(provider, record, observation); }
    finish();
  } else source[Symbol.iterator] = function* () {
    for (const record of transcriptRecords(input, observation)) { observe(record); yield record; }
    finish();
  };
  return source;
}

// Spec §3 / host R7: Date accepts extended years that the shared TIME slot forbids.
function toIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const timestamp = new Date(milliseconds).toISOString();
  return snapshotPolicy.isSafeTimestamp(timestamp) ? timestamp : null;
}

function hasValidLocalKey(config) {
  return typeof config.local_key === 'string'
    && /^[0-9a-f]{64}$/.test(config.local_key)
    && config.key_fingerprint === computeKeyFingerprint(config.local_key);
}

function isRecordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Spec §1: unsupported JSON values and blocks become coverage, never collection-wide exceptions.
function parseTranscriptRecord(line, terminated = true) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    record = {};
    PARSE_STATES.set(record, { invalid: true, pending: !terminated });
    return record;
  }
  if (!isRecordObject(record)) {
    record = {};
    PARSE_STATES.set(record, { invalid: true, pending: false });
    return record;
  }
  for (const container of [record.message, record.payload]) {
    if (isRecordObject(container) && Array.isArray(container.content)) {
      container.content = container.content.map(block => {
        if (isRecordObject(block)) return block;
        const replacement = {};
        PARSE_STATES.set(replacement, { invalid: true, pending: false });
        return replacement;
      });
    }
  }
  return record;
}

function countInvalidBlocks(record) {
  const content = record.message?.content ?? record.payload?.content;
  return Array.isArray(content) ? content.filter(block => PARSE_STATES.get(block)?.invalid).length : 0;
}

// Spec §1.1: first matching row wins; output and origin conflicts precede slash/shell wrappers.
function isQueuedInstruction(record, classification) {
  if (record.type !== 'attachment' || record.attachment?.type !== 'queued_command'
    || !isIdentityComponent(record.uuid) || !toIsoTimestamp(record.timestamp)) return false;
  if (classification === undefined) classification = classifyClaudeRecord(record);
  return Boolean(classification?.kind);
}

function classifyClaudeRecord(record) {
  const queued = record.type === 'attachment' && record.attachment?.type === 'queued_command';
  if (queued) {
    const attachment = record.attachment;
    if (attachment.origin?.kind !== 'human') return null;
    if (record.isMeta || record.isCompactSummary || record.isSidechain === true) return null;
    if (attachment.humanTurn === false || attachment.commandMode !== 'prompt'
      || typeof attachment.prompt !== 'string') return { unverified: true };
    record = { ...record, type: 'user', message: { content: attachment.prompt }, origin: attachment.origin };
  }
  const content = record.message?.content;
  if (record.type !== 'user') {
    return null;
  }
  if (Array.isArray(content) && content.length && content.every(block => block.type === 'tool_result')) {
    return null;
  }
  if (record.isMeta || record.isCompactSummary || record.isSidechain) {
    return null;
  }
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block
    .type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n\n') : '';
  const attachments = Array.isArray(content) ? content.filter(block => block.type === 'image').length : 0;
  if (/^<(task-notification|local-command-stdout|local-command-caveat|bash-stdout|bash-stderr)>/.test(text)) {
    return null;
  }
  if (['task_notification', 'scheduled'].includes(record.turnOrigin) || record.promptSource === 'system') {
    return null;
  }
  const slash = /^<(command-name|command-message)>/.test(text);
  const shell = text.startsWith('<bash-input>');
  if (record.origin?.kind !== undefined && record.origin.kind !== 'human') {
    return slash || shell ? {
      unknown: true
    } : null;
  }
  if (slash && record.origin === undefined) {
    return { kind: 'slash', text, attachments };
  }
  if (shell) {
    return {
      kind: 'shell',
      text,
      attachments
    };
  }
  if (record.origin?.kind === 'human' || record.turnOrigin === 'human' || ['typed', 'queued',
    'suggestion_accepted'].includes(record.promptSource)) {
    return {
      kind: 'human',
      text,
      attachments
    };
  }
  return {
    unknown: true
  };
}

// Spec §1.2(C): injected and unknown blocks never become exported human text.
function classifyCodexBlock(block) {
  if (block.type === 'input_image') {
    return {
      kind: 'attachment',
      structure: ['image']
    };
  }
  if (block.type !== 'input_text' || typeof block.text !== 'string') {
    return {
      kind: 'unknown',
      structure: ['unknown']
    };
  }
  const text = block.text;
  const structure = ['text', normalizeDeletionText(text)];
  if (/^(<environment_context>|<codex_internal_context>|# AGENTS.md instructions)/.test(text)) {
    return {
      kind: 'injected',
      structure
    };
  }
  if (text.startsWith('<send_user_message_question_reply>')) {
    return {
      kind: 'reply',
      text,
      structure
    };
  }
  if (/^<[^>]+>/.test(text)) {
    return {
      kind: 'unknown',
      structure
    };
  }
  return {
    kind: 'human',
    text,
    structure
  };
}

function classifyCodexMessage(payload) {
  if (!Array.isArray(payload.content)) {
    return {
      unverified: true
    };
  }
  const parts = [];
  const structure = [];
  let attachments = 0;
  let unknown_blocks = 0;
  let reply = false;
  for (const block of payload.content) {
    const classification = classifyCodexBlock(block);
    structure.push(classification.structure);
    if (classification.kind === 'attachment') {
      attachments++;
    } else if (classification.kind === 'unknown') {
      unknown_blocks++;
    } else if (classification.kind === 'reply') {
      reply = true;
      parts.push(classification.text);
    } else if (classification.kind === 'human') {
      parts.push(classification.text);
    }
  }
  return {
    kind: reply ? 'reply' : 'human',
    text: parts.join('\n\n'),
    attachments,
    unknown_blocks,
    structure,
    empty: !parts.length && !attachments
  };
}

// Spec §1.2(A): source and thread_source determine mode independently of inclusion.
function determineCodexRunMode(source, threadSource) {
  if ((source === 'cli' || source === 'vscode') && threadSource === 'user') {
    return 'interactive';
  }
  if (source === 'exec' && threadSource === 'user') {
    return 'exec';
  }
  if (source && typeof source === 'object' && Object.hasOwn(source, 'subagent')) {
    return 'subagent';
  }
  return 'unsupported';
}

// Spec §1.2: payload.id wins; otherwise count original user messages, never replacement history.
function codexIdentitySuffix(payloadId, originalUserNumber) {
  if (payloadId === undefined) {
    return `n${originalUserNumber}`;
  }
  return isIdentityComponent(payloadId) ? `i${payloadId}` : null;
}

// Spec §1.4: recoverability follows the parent chain, not the first record type.
function recoverClaudeFirstInstruction(record, byUuid) {
  if (!Object.hasOwn(record, 'parentUuid')) {
    return 'unknown';
  }
  const seen = new Set();
  let ancestorRecord = record;
  while (ancestorRecord.parentUuid !== null) {
    if (typeof ancestorRecord.parentUuid !== 'string' || seen.has(ancestorRecord.parentUuid) || !byUuid.has(
      ancestorRecord.parentUuid)) {
      return 'unrecoverable';
    }
    seen.add(ancestorRecord.parentUuid);
    ancestorRecord = byUuid.get(ancestorRecord.parentUuid);
    if (!Object.hasOwn(ancestorRecord, 'parentUuid')) {
      return 'unknown';
    }
  }
  return 'recoverable';
}

function compareRecordTimes(left, right) {
  const a = left.ts || '', b = right.ts || '';
  return (a < b ? -1 : a > b ? 1 : 0) || left.position - right.position;
}

// Keep status fields and instruction classification inputs, dropping assistant and tool bodies immediately.
function statusRecord(record) {
  if (PARSE_STATES.get(record)?.invalid) return record;
  const projected = {};
  for (const key of ['type', 'uuid', 'parentUuid', 'timestamp', 'isSidechain', 'isMeta', 'isCompactSummary',
    'origin', 'turnOrigin', 'promptSource']) if (Object.hasOwn(record, key)) projected[key] = record[key];
  const content = value => Array.isArray(value) ? value.map(block => ({ type: block.type, text: block.text })) : value;
  if (record.message) projected.message = record.type === 'assistant'
    ? { stop_reason: record.message.stop_reason } : { content: content(record.message.content) };
  if (claudeLocalCommandStdout(record)) {
    if (record.type === 'user') projected.message = { content: '<local-command-stdout>' };
    else {
      projected.subtype = 'local_command';
      projected.content = '<local-command-stdout>';
    }
  }
  if (record.attachment) {
    const value = record.attachment;
    projected.attachment = { type: value.type, origin: value.origin, humanTurn: value.humanTurn,
      commandMode: value.commandMode, prompt: value.type === 'queued_command' ? value.prompt : undefined };
  }
  if (record.payload) {
    const value = record.payload;
    projected.payload = { type: value.type, turn_id: value.turn_id, role: value.role,
      content: value.role === 'user' ? content(value.content) : undefined };
  }
  return projected;
}

// Complete JSON without a final newline remains usable; only an unfinished final record is ignored.
function transcriptStatus(provider, input) {
  const records = input.streaming ? input.statusRecords() : input;
  if (!records) return snapshotPolicy.unknownStatus('truncated');
  const windowed = records.windowed === true;
  const complete = records.filter((record, index) => {
    const parseState = PARSE_STATES.get(record);
    return !(index === records.length - 1 && parseState?.invalid && parseState.pending);
  });
  if (complete.some(record => PARSE_STATES.get(record)?.invalid))
    return snapshotPolicy.unknownStatus('parse_failed');
  return provider === 'claude' ? claudeStatus(complete, windowed) : codexStatus(complete, windowed);
}

function statusAt(state, record) {
  return { state, source: 'transcript', evidence_at: toIsoTimestamp(record.timestamp), reason: null };
}

function orderedStatusRecords(records) {
  let previous = null;
  for (const record of records) {
    const ts = toIsoTimestamp(record.timestamp);
    if (!ts || previous && ts < previous) return false;
    previous = ts;
  }
  return true;
}

function claudeInterrupted(record) {
  if (record.type !== 'user') return false;
  const content = record.message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(text);
}

function claudeLocalCommandStdout(record) {
  const content = record.type === 'user' ? record.message?.content
    : record.type === 'system' && record.subtype === 'local_command' ? record.content : null;
  return typeof content === 'string' && content.startsWith('<local-command-stdout>');
}

// Follow terminal-to-instruction ancestry; scan readable ancestors for cycles, allowing missing earlier parents.
function claudeStatus(records, windowed = false) {
  const traversal = records.filter(record => record.isSidechain !== true && typeof record.uuid === 'string');
  const chain = traversal.filter(record => ['user', 'assistant', 'system'].includes(record.type));
  const byId = new Map(traversal.map(record => [record.uuid, record]));
  if (byId.size !== traversal.length) return snapshotPolicy.unknownStatus('branch_ambiguous');
  let instruction = null, previousChain = null, anchor = null;
  for (const record of records) {
    const classification = classifyClaudeRecord(record);
    if (classification?.kind && !claudeInterrupted(record)) {
      instruction = record;
      anchor = record.type === 'attachment' && record.parentUuid == null ? previousChain : record;
    }
    if (byId.get(record.uuid) === record && ['user', 'assistant', 'system'].includes(record.type))
      previousChain = record;
  }
  if (!instruction) return snapshotPolicy.unknownStatus(windowed ? 'truncated' : 'no_instruction');
  const main = new Set(), visited = new Set();
  let current = chain.at(-1), bound = false;
  if (!current) return snapshotPolicy.unknownStatus(windowed ? 'truncated' : 'status_format_unsupported');
  while (current) {
    if (visited.has(current)) return snapshotPolicy.unknownStatus('branch_ambiguous');
    if (!current.uuid) return snapshotPolicy.unknownStatus('status_format_unsupported');
    visited.add(current); // Each readable UUID is visited once; a revisit ends this bounded walk.
    if (!bound) {
      if (current === anchor) bound = true;
      else main.add(current);
    }
    if (!Object.hasOwn(current, 'parentUuid')
      || !(current.parentUuid === null || typeof current.parentUuid === 'string')) {
      if (bound) break;
      return snapshotPolicy.unknownStatus('status_format_unsupported');
    }
    if (current.parentUuid === null) break;
    const parent = byId.get(current.parentUuid);
    if (!parent) {
      if (bound) break;
      return snapshotPolicy.unknownStatus(windowed ? 'truncated' : 'instruction_unbound');
    }
    current = parent;
  }
  if (!bound) return snapshotPolicy.unknownStatus(windowed && !anchor ? 'truncated' : 'instruction_unbound');
  if (instruction.type === 'user' && (!Object.hasOwn(instruction, 'parentUuid')
    || !(instruction.parentUuid === null || typeof instruction.parentUuid === 'string')))
    return snapshotPolicy.unknownStatus('status_format_unsupported');
  const remaining = records.slice(records.indexOf(instruction) + 1);
  if (remaining.some(record => record.isSidechain !== true
    && ['user', 'assistant'].includes(record.type) && typeof record.uuid !== 'string'))
    return snapshotPolicy.unknownStatus('status_format_unsupported');
  const after = remaining.filter(record => main.has(record));
  const evidence = [instruction];
  const commandWrapper = /^<(command-name|command-message)>/.test(classifyClaudeRecord(instruction)?.text || '');
  let status = statusAt('working', instruction);
  for (const record of after) {
    if (claudeInterrupted(record)) {
      evidence.push(record);
      status = statusAt('interrupted', record);
    } else if (commandWrapper && claudeLocalCommandStdout(record)) {
      evidence.push(record);
      status = { ...statusAt('ended', record), reason: 'local_command' };
    } else if (record.type === 'assistant') {
      const stop = record.message?.stop_reason;
      const status_format_ok = stop === null || ['end_turn', 'tool_use'].includes(stop);
      if (!status_format_ok) return snapshotPolicy.unknownStatus('status_format_unsupported');
      evidence.push(record);
      status = statusAt(stop === 'end_turn' ? 'ended' : 'working', record);
    } else if (record.type === 'user' && Array.isArray(record.message?.content)
      && record.message.content.some(block => block.type === 'tool_result')) {
      evidence.push(record);
      status = statusAt('working', record);
    }
  }
  // Attachment clocks do not order transitions; actual state evidence must be monotonic in file order.
  if (!orderedStatusRecords(evidence))
    return snapshotPolicy.unknownStatus('order_unknown');
  return status;
}

function codexStatus(records, windowed = false) {
  let instruction = null, started = null, turn = null;
  for (const record of records) {
    if (record.type === 'event_msg' && record.payload?.type === 'task_started') started = record;
    const eventUser = record.type === 'event_msg' && record.payload?.type === 'user_message';
    const classification = record.type === 'response_item' && record.payload?.type === 'message'
      && record.payload.role === 'user' ? classifyCodexMessage(record.payload) : null;
    const messageUser = classification?.kind && !classification.empty;
    if (eventUser || messageUser) { instruction = record; turn = started; }
  }
  if (!instruction) return snapshotPolicy.unknownStatus(windowed ? 'truncated' : 'no_instruction');
  if (!turn) return snapshotPolicy.unknownStatus(windowed ? 'truncated' : 'turn_unbound');
  const status_format_ok = typeof turn.payload.turn_id === 'string' && turn.payload.turn_id.length > 0;
  if (!status_format_ok) return snapshotPolicy.unknownStatus('status_format_unsupported');
  const events = records.slice(records.indexOf(instruction) + 1).filter(record => record.type === 'event_msg'
    && ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type));
  if (!orderedStatusRecords([turn, instruction, ...events]))
    return snapshotPolicy.unknownStatus('order_unknown');
  let status = statusAt('working', instruction);
  for (const record of events) {
    if (typeof record.payload.turn_id !== 'string' || !record.payload.turn_id)
      return snapshotPolicy.unknownStatus('status_format_unsupported');
    if (record.payload.turn_id !== turn.payload.turn_id) return snapshotPolicy.unknownStatus('turn_unbound');
    status = statusAt(record.payload.type === 'task_complete' ? 'ended'
      : record.payload.type === 'turn_aborted' ? 'interrupted' : 'working', record);
  }
  return status;
}

// Spec §1.2: content identity uses block structure, NFC/trim text, and attachment count.
function computeInstructionFingerprint(config, instruction) {
  if (!hasValidLocalKey(config)) {
    return null;
  }
  const encoded = snapshotPolicy.canonicalEncode(['palantir.instruction-fingerprint/1', instruction.structure]);
  return computeHmac(config.local_key, encoded);
}

// Spec §3/§4: board refs bind identity, content fingerprint, timestamp, and machine.
function computeInstructionRef(config, instruction) {
  if (!instruction.fp) {
    return null;
  }
  const encoded = snapshotPolicy.canonicalEncode(['palantir.instr-ref/1', config.machine_id, instruction.id,
    instruction.fp, instruction.ts]);
  return computeHmac(config.local_key, encoded).slice(0, 16);
}

function transcriptSessionId(provider, records) {
  const record = provider === 'codex' ? records.find(record => record.type === 'session_meta')
    : records.find(record => isIdentityComponent(record.sessionId));
  const identity = { selected: false };
  if (record) selectFirstTranscriptIdentity(provider, record, identity);
  return identity.sessionId;
}

function countDuplicateRecordIdentities(provider, records, metadataCheck = checkMetadata) {
  if (records.analysis) return records.analysis.duplicates;
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    let identity;
    if (provider === 'claude' && (record.type === 'user' || isQueuedInstruction(record))) {
      identity = record.uuid;
    } else if (provider === 'codex' && record.type === 'response_item'
      && record.payload?.type === 'message' && record.payload.role === 'user') {
      identity = record.payload.id;
    }
    if (!isIdentityComponent(identity)) {
      continue;
    }
    if (seen.has(identity)) {
      duplicates++;
    }
    seen.add(identity);
    if (records.limited !== false) metadataCheck(seen.size);
  }
  return duplicates;
}

function hasMixedSessionIdentities(provider, records) {
  if (records.analysis) return records.analysis.mixed;
  const identities = new Set();
  for (const record of records) {
    const identity = provider === 'claude' ? record.sessionId
      : record.type === 'session_meta' ? record.payload?.id : undefined;
    if (typeof identity === 'string') {
      identities.add(identity);
    }
  }
  return identities.size > 1;
}

function countInvalidTimeRecords(records) {
  if (records.analysis) return records.analysis.invalidTime;
  let count = 0;
  for (const record of records) if (Object.hasOwn(record, 'timestamp') && !snapshotPolicy.isSafeTimestamp(record.timestamp)) count++;
  return count;
}

function parseIndependentTranscript(provider, records, providerCoverage, config, retainAllInstructions,
  displayOptions = {}, parseFile, metadataCheck = checkMetadata) {
  let streamedSession;
  let streamedCoverage;
  if (records.streaming) {
    streamedCoverage = Object.fromEntries(Object.keys(providerCoverage).map(key => [key, 0]));
    streamedSession = parseFile(provider, records, streamedCoverage, config, retainAllInstructions, displayOptions);
  }
  // Host R5: a single file cannot assign instructions from multiple explicit session identities.
  const mixedSession = hasMixedSessionIdentities(provider, records);
  if (mixedSession) {
    providerCoverage.mixed_session_withheld++;
  }
  const duplicates = countDuplicateRecordIdentities(provider, records, metadataCheck);
  let queuedDuplicate = false;
  if (records.analysis) {
    queuedDuplicate = records.analysis.queuedDuplicate;
    if (queuedDuplicate) providerCoverage.queued_duplicate_withheld++;
  } else if (provider === 'claude') {
    const userIds = new Set();
    for (const record of records) if (record.type === 'user') {
      for (const id of [record.uuid, record.source_uuid, record.delivery_id, record.message?.uuid,
        record.message?.source_uuid, record.message?.delivery_id]) if (typeof id === 'string') userIds.add(id);
      if (records.limited !== false) metadataCheck(userIds.size);
    }
    const queuedIds = new Set();
    for (const record of records) if (isQueuedInstruction(record)) {
      if (queuedIds.has(record.uuid) || [record.uuid, record.source_uuid, record.delivery_id, record.attachment.source_uuid, record.attachment.delivery_id]
        .some(id => userIds.has(id))) queuedDuplicate = true;
      queuedIds.add(record.uuid);
      if (records.limited !== false) metadataCheck(queuedIds.size);
    }
    if (queuedDuplicate) providerCoverage.queued_duplicate_withheld++;
  }
  providerCoverage.records_unverified += duplicates;
  // Host R9: one explicit invalid TIME withholds the file from export, lookup, and Orca evidence.
  const invalidTimeRecords = countInvalidTimeRecords(records);
  if (invalidTimeRecords > 0) {
    providerCoverage.records_unverified += invalidTimeRecords;
    providerCoverage.invalid_time_withheld++;
    return null;
  }
  let session;
  let comparisonFailed = false;
  try {
    if (records.streaming) {
      session = streamedSession;
      for (const key of Object.keys(providerCoverage)) providerCoverage[key] += streamedCoverage[key];
    } else session = parseFile(provider, records, providerCoverage, config, retainAllInstructions,
      { ...displayOptions, withheld: displayOptions.withheld || mixedSession || queuedDuplicate || duplicates > 0 });
  } catch (error) {
    if (error.streamLimit) throw error;
    // Spec §1: malformed candidates cannot abort unrelated sessions.
    providerCoverage.files_failed++;
    comparisonFailed = true;
  }
  // Spec §1.3 / v11: defer group-dependent coverage until all file identities are known.
  return {
    session: mixedSession || queuedDuplicate || duplicates > 0 ? null : session,
    comparison: session ? { provider: session.provider, sid: session.sid, firstAt: session.firstAt,
      lastAt: session.lastAt, link_text: session.link_text } : null,
    comparisonFailed,
    skipIfSingle: !session && duplicates === 0
  };
}

function representativeTranscriptCwd(provider, records) {
  if (provider === 'codex') {
    const cwd = records.find(record => record.type === 'session_meta')?.payload?.cwd;
    return typeof cwd === 'string' ? cwd : '';
  }
  return records.find(record => typeof record.cwd === 'string')?.cwd || '';
}

// Spec §1.2/§1.4/§2: only output-eligible sessions consume detail slots.
function snapshotSessionExclusion(readerOptions, config, session, checkSchema = true, buildSnapshotSession) {
  if (session.provider === 'codex' && config.invalidContentRuleSessions?.has(session.sid)) {
    return 'withheld_sessions';
  }
  if (session.cwd === null) {
    return 'cwd_unavailable';
  }
  if (session.run_mode === 'exec' && !readerOptions.includeExec) {
    return 'exec_sessions_excluded';
  }
  if (session.run_mode === 'subagent' || session.run_mode === 'unsupported') {
    return session.run_mode === 'subagent' ? 'subagent_excluded' : 'unsupported_sessions';
  }
  if (isSessionExcluded(config, session)) {
    return 'excluded_sessions';
  }
  const rules = session.provider === 'codex' ? config.exclude.instructions.filter(record =>
    record.id.startsWith(`codex:${session.sid}:n`)) : [];
  if (!hasValidLocalKey(config) || rules.some(record => record.key_fingerprint !== config.key_fingerprint)) {
    return session.provider === 'codex' ? 'withheld_sessions' : 'excluded_sessions';
  }
  const key = `${config.machine_id}:${session.provider}:${session.sid}`;
  if (!safeId(key) || (checkSchema
    && !snapshotPolicy.validateSession(buildSnapshotSession(config, session, key, [])).ok)) {
    return 'records_unverified';
  }
  return null;
}

function isSessionExcluded(config, parsedSession) {
  return config.exclude.sessions.includes(`${parsedSession.provider}:${parsedSession.sid}`);
}

function isInstructionExcluded(config, instruction) {
  return config.exclude.instructions.some(rule => (
    (rule.id === instruction.id && !/:n\d+$/.test(rule.id))
    || (
      /:n\d+$/.test(rule.id)
      && rule.id.split(':')[1] === instruction.id.split(':')[1]
      && rule.id.startsWith('codex:')
      && instruction.id.startsWith('codex:')
      && rule.key_fingerprint === config.key_fingerprint
      && rule.fingerprint === instruction.fp
    )
  ));
}

// Keep parser provenance private: transcript fields cannot forge invalid/pending markers.
function transcriptParseState(record) { return PARSE_STATES.get(record); }

// Answer lookup must withhold a session with any instruction deletion rule.
function hasSessionInstructionDeletionRule(config, session) {
  const prefix = `${session.provider}:${session.sid}:`;
  return config.exclude.instructions.some(rule => rule.id.startsWith(prefix));
}

module.exports = {
  streamLimit,
  checkMetadata,
  selectFirstTranscriptIdentity,
  transcriptSource,
  toIsoTimestamp,
  hasValidLocalKey,
  isRecordObject,
  parseTranscriptRecord,
  countInvalidBlocks,
  isQueuedInstruction,
  classifyClaudeRecord,
  classifyCodexBlock,
  classifyCodexMessage,
  determineCodexRunMode,
  codexIdentitySuffix,
  recoverClaudeFirstInstruction,
  compareRecordTimes,
  statusRecord,
  transcriptStatus,
  statusAt,
  orderedStatusRecords,
  claudeInterrupted,
  claudeLocalCommandStdout,
  claudeStatus,
  codexStatus,
  computeInstructionFingerprint,
  computeInstructionRef,
  transcriptSessionId,
  countDuplicateRecordIdentities,
  hasMixedSessionIdentities,
  countInvalidTimeRecords,
  parseIndependentTranscript,
  representativeTranscriptCwd,
  snapshotSessionExclusion,
  isSessionExcluded,
  isInstructionExcluded,
  transcriptParseState,
  safeId,
  isIdentityComponent,
  normalizeDeletionText,
  computeHmac,
  computeKeyFingerprint,
  hasSessionInstructionDeletionRule,
  TRANSCRIPT_METADATA_LIMIT
};
