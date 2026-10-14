'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const core = require('./sessionTranscriptCore.cjs');
const reader = require('./sessionSnapshotReader.cjs');
const policy = require('../../server/services/observeSnapshotPolicy.js');
const RAW_LIMIT = 1024 * 1024;
// One per-read counter covers explicit walks and array callbacks, including
// many short loops that would otherwise never reach an individual checkpoint.
function deadlineStep(checkDeadline) {
  let iterations = 0;
  return () => { if ((++iterations & 4095) === 0) checkDeadline?.(); };
}
function checked(callback, step) {
  return (a, b, c, d) => { step(); return callback(a, b, c, d); };
}
function checkedIndexOf(rows, value, step) {
  for (let index = 0; index < rows.length; index++) { step(); if (rows[index] === value) return index; }
  return -1;
}
const fileFingerprint = stats => crypto.createHash('sha256')
  .update(`palantir-file/1:${stats.dev.toString(10)}:${stats.ino.toString(10)}`).digest('hex').slice(0, 16);
const failure = reason => ({ status: 'unbound', reason });
const transparent = r => r.type === 'attachment' || r.isMeta === true || r.isCompactSummary === true;
const instruction = r => { const c = core.classifyClaudeRecord(r); return Boolean(c?.kind && !c.empty && !core.claudeInterrupted(r)); };
// The common parser owns identity, mixed/duplicate/time holds and classification. This callback
// collects instruction fingerprints and positions only; it never creates snapshot display slots.
function collectAnswerSession(provider, source, coverage, config, step) {
  const items = []; let position = -1, userNumber = 0, compact = false, firstCompact = false;
  source.answerItems = items;
  let firstRecord = null;
  for (const record of source) {
    step();
    position++;
    if (core.transcriptParseState(record)?.invalid) continue;
    if (record.isCompactSummary || record.type === 'compacted') { compact = true; if (!firstRecord) firstCompact = true; }
    const user = record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user';
    if (provider === 'codex' && user) userNumber++;
    const classification = source.analysis.currentClassification;
    if (!classification?.kind || classification.empty || classification.unverified) continue;
    const suffix = provider === 'claude' ? core.isIdentityComponent(record.uuid) ? 'u' + record.uuid : null
      : core.codexIdentitySuffix(record.payload?.id, userNumber);
    const ts = source.analysis.currentTime;
    if (!suffix || !ts) continue;
    firstRecord ||= record;
    const structure = provider === 'claude' ? [['text', core.normalizeDeletionText(classification.text)],
      ['attachments', classification.attachments]] : [...classification.structure, ['attachments', classification.attachments]];
    const item = { suffix, position, ts, structure };
    item.fp = core.computeInstructionFingerprint(config, item);
    const observedSid = core.transcriptSessionId(provider, source);
    if (core.isIdentityComponent(observedSid)) {
      item.id = `${provider}:${observedSid}:${suffix}`;
      item.ref = core.computeInstructionRef(config, item);
    }
    items.push(item);
    core.checkMetadata(items.length);
  }
  const sid = core.transcriptSessionId(provider, source), meta = source.find(checked(r => r.type === 'session_meta', step))?.payload;
  if (!core.isIdentityComponent(sid) || !source.analysis.firstTime || provider === 'codex' && !meta) return null;
  for (const item of items) {
    step();
    item.id = `${provider}:${sid}:${item.suffix}`;
    item.ref = core.computeInstructionRef(config, item);
    delete item.structure; delete item.suffix;
  }
  const cwd = core.representativeTranscriptCwd(provider, source);
  return { provider, sid, items: items.filter(checked(i => policy.isSafeInstructionId(i.id), step)), cwd: cwd.length > 4096 ? null : cwd,
    run_mode: provider === 'codex' ? core.determineCodexRunMode(meta.source, meta.thread_source) : 'interactive',
    status: core.transcriptStatus(provider, source), firstAt: source.analysis.firstTime, lastAt: source.analysis.lastTime,
    first: firstCompact ? 'unrecoverable' : provider === 'claude' && firstRecord
      ? core.recoverClaudeFirstInstruction(firstRecord, source.analysis.byUuid) : 'recoverable',
    compact: compact && !items.length, instructionCount: items.length };
}
function projectSession(config, session, key) {
  return { key, provider: session.provider, run_mode: session.run_mode, session_id: session.sid,
    cwd_id: policy.opaquePath(config.path_salt, config.path_gen, session.cwd), path_gen: config.path_gen,
    repo_label: session.cwd ? policy.finalizeLabel(path.basename(session.cwd)).value : null,
    git_branch: null, cli_version: 'unverified', format_unverified: true, status: session.status,
    first_record_at: session.firstAt, last_record_at: session.lastAt, first_instruction: session.first,
    compact_only_history: session.compact, ai_title: null, instruction_count: 0,
    instruction_total: session.instructionCount, unknown_count: 0,
    orca_link: { evidence: 'none', confirmed: false, pane_key: null, terminal_handle: null } };
}
function projectAnswerRecord(record, provider, step) {
  const row = core.statusRecord(record);
  if (provider === 'claude' && record.type === 'assistant') {
    const parts = Array.isArray(record.message?.content) ? record.message.content
      .filter(checked(b => b.type === 'text' && typeof b.text === 'string', step)).map(checked(b => b.text, step)) : [];
    row.answerBytes = parts.reduce(checked((n, s) => n + Buffer.byteLength(s), step), Math.max(0, parts.length - 1) * 2);
    row.answerParts = parts.length;
    if (record.message?.stop_reason !== 'tool_use' && !transparent(record) && record.isSidechain !== true)
      row.answerText = row.answerBytes <= RAW_LIMIT ? parts.join('\n\n') : null;
    row.message.id = record.message?.id;
    row.toolUseIds = Array.isArray(record.message?.content) ? record.message.content
      .filter(checked(b => b.type === 'tool_use', step)).map(checked(b => typeof b.id === 'string' ? b.id : null, step)) : [];
  } else if (provider === 'claude' && record.type === 'user' && Array.isArray(record.message?.content)) {
    row.toolResultIds = record.message.content.filter(checked(b => b.type === 'tool_result', step))
      .map(checked(b => typeof b.tool_use_id === 'string' ? b.tool_use_id : null, step));
  } else if (provider === 'codex') {
    const p = record.payload;
    if (p?.type === 'message' && p.role === 'assistant') {
      row.payload.phase = p.phase;
      const parts = Array.isArray(p.content) ? p.content.filter(checked(b => b.type === 'output_text' && typeof b.text === 'string', step)).map(checked(b => b.text, step)) : [];
      row.answerBytes = parts.reduce(checked((n, s) => n + Buffer.byteLength(s), step), Math.max(0, parts.length - 1) * 2);
      if (record.type === 'response_item' && p.phase === 'final_answer')
        row.answerText = row.answerBytes <= RAW_LIMIT ? parts.join('\n\n') : null;
    }
    if (record.type === 'event_msg' && p?.type === 'task_complete') {
      row.payload.completed_at = p.completed_at;
      row.answerBytes = typeof p.last_agent_message === 'string' ? Buffer.byteLength(p.last_agent_message) : 0;
      row.answerText = row.answerBytes <= RAW_LIMIT && typeof p.last_agent_message === 'string' ? p.last_agent_message : null;
    }
  }
  return row;
}
function claudeAnswer(rows, position, step) {
  const target = rows[position];
  if (core.isQueuedInstruction(target)) return { status: 'queued_joined' };
  // Every main-chain record can bridge ancestry, including metadata and compact summaries.
  const relevant = rows.filter(checked(r => r.isSidechain !== true, step));
  const traversal = relevant.filter(checked(r => typeof r.uuid === 'string', step));
  const byId = new Map(traversal.map(checked(r => [r.uuid, r], step)));
  if (byId.size !== traversal.length) return failure('branch_conflict');
  if (!target || !instruction(target) || transparent(target) || target.isSidechain === true) return failure('chain_broken');
  const starters = relevant.filter(checked(r => r.type === 'user' && !transparent(r) && instruction(r), step));
  const labels = new Map(starters.map(checked(r => [r, r === target ? 'bound' : 'other'], step)));
  function label(row) {
    if (labels.has(row)) return labels.get(row);
    const visited = new Set(), chain = []; let current = row, result;
    while (current && !labels.has(current)) {
      step();
      if (visited.has(current)) { result = 'cycle'; break; }
      visited.add(current); chain.push(current);
      if (current.parentUuid === null) { result = 'other'; break; }
      if (typeof current.parentUuid !== 'string') { result = 'unsupported'; break; }
      if (!byId.has(current.parentUuid)) { result = 'missing'; break; }
      current = byId.get(current.parentUuid);
    }
    result = result || labels.get(current) || 'other';
    for (const entry of chain) { step(); labels.set(entry, result); }
    return result;
  }
  const positions = new Map(rows.map(checked((row, index) => [row, index], step)));
  // Earlier history is outside this execution. Later rows with missing ancestry remain
  // ambiguous unless their parent chain reaches another starter or a detached root.
  const candidates = relevant.filter(checked(r => positions.get(r) > position
    && !transparent(r)
    && ['user', 'assistant', 'system'].includes(r.type), step));
  if (candidates.some(checked(r => label(r) === 'missing', step))) return failure('chain_broken');
  if (candidates.some(checked(r => label(r) === 'cycle', step))) return failure('branch_conflict');
  if (candidates.some(checked(r => label(r) === 'unsupported', step))) return failure('unsupported_format');
  const segment = relevant.filter(checked(r => label(r) === 'bound', step));
  const significant = segment.filter(checked(r => !transparent(r) && ['user', 'assistant', 'system'].includes(r.type), step));
  // Cache each starting row and every transparent intermediate row. Each parent
  // edge is traversed at most once, including shared metadata/attachment chains.
  const effectiveParents = new Map();
  function effectiveParent(row) {
    if (effectiveParents.has(row)) return effectiveParents.get(row);
    const chain = [row], seen = new Set([row]);
    let parent = byId.get(row.parentUuid);
    while (parent && transparent(parent)) {
      step();
      if (effectiveParents.has(parent)) { parent = effectiveParents.get(parent); break; }
      if (seen.has(parent)) { parent = null; break; }
      seen.add(parent); chain.push(parent); parent = byId.get(parent.parentUuid);
    }
    for (const entry of chain) { step(); effectiveParents.set(entry, parent); }
    return parent;
  }
  const boundary = starters.filter(checked(r => r !== target && label(effectiveParent(r)) === 'bound', step));
  // Collapse an assistant message before computing ancestry. Result arrival order
  // does not determine which tool-call records belong to that message node.
  const messages = new Map(), nodeOf = new Map(), nodes = [], messageRoots = new Map();
  function messageRoot(row) {
    const path = []; let current = row;
    while (!messageRoots.has(current)) {
      step();
      path.push(current);
      const parent = effectiveParent(current);
      if (parent?.type !== 'assistant' || parent.message?.id !== row.message.id) break;
      current = parent;
    }
    const root = messageRoots.get(current) || current;
    for (const entry of path) { step(); messageRoots.set(entry, root); }
    return root;
  }
  for (const row of significant) {
    step();
    const key = row.type === 'assistant' && typeof row.message?.id === 'string' && row.message.id && messageRoot(row);
    let node = key && messages.get(key);
    if (!node) {
      node = { rows: [], parents: new Set(), children: new Set(), calls: new Set() };
      nodes.push(node); if (key) messages.set(key, node);
    }
    node.rows.push(row); nodeOf.set(row, node);
    for (const id of row.toolUseIds || []) { step(); node.calls.add(id); }
  }
  const root = nodeOf.get(target);
  for (const row of significant.filter(checked(r => r !== target, step))) {
    step();
    const node = nodeOf.get(row), parent = nodeOf.get(effectiveParent(row));
    if (parent && parent !== node) { node.parents.add(parent); parent.children.add(node); }
  }
  // A following instruction cuts the segment, but still prevents its parent from
  // qualifying as a terminal parallel result.
  for (const row of boundary) { step(); nodeOf.get(effectiveParent(row))?.children.add(row); }
  function matchedResult(node) {
    if (!node.rows) return false;
    const row = node.rows[0], parent = [...node.parents][0];
    return node.rows.length === 1 && node.parents.size === 1 && row.type === 'user'
      && !instruction(row) && row.toolResultIds?.length > 0 && parent.rows[0].type === 'assistant'
      && row.toolResultIds.every(checked(id => typeof id === 'string' && id.length > 0 && parent.calls.has(id), step));
  }
  const competingChildren = nodes.some(checked(n => {
    const children = [...n.children], ordinary = children.filter(checked(child => !matchedResult(child), step));
    return ordinary.length > 1 || children.length > 1 && ordinary.some(checked(child =>
      child.rows?.[0]?.type === 'user' && child.rows[0].toolResultIds?.length > 0 && !instruction(child.rows[0]), step));
  }, step));
  if (competingChildren) return failure('branch_conflict');
  const leafResults = new Set(nodes.filter(checked(n => n.children.size === 0 && matchedResult(n), step)));
  function pathFrom(head) {
    const path = new Set(); let node = head;
    while (node && !path.has(node)) {
      step();
      path.add(node);
      if (node === root) return path;
      if (node.parents.size !== 1) return null;
      node = [...node.parents][0];
    }
    return null;
  }
  const main = [nodeOf.get(significant.at(-1)), nodes.filter(checked(n => !leafResults.has(n), step)).at(-1)]
    .map(checked(pathFrom, step)).find(checked(path => path && nodes.every(checked(n => path.has(n) || leafResults.has(n), step)), step));
  if (!main || nodes.some(checked(n => n !== root && n.parents.size !== 1, step))) return failure('branch_conflict');
  const mainSignificant = significant.filter(checked(r => main.has(nodeOf.get(r)), step));
  // Apply the shared transition function to the linearized message path. Every
  // grouped assistant block is on that path; terminal result satellites are not.
  const stateRows = mainSignificant.map(checked((r, index) => index === 0 ? r : {
    ...r, parentUuid: mainSignificant[index - 1].uuid
  }, step));
  const state = core.claudeStatus(stateRows);
  if (state.state === 'unknown') return failure(state.reason === 'branch_ambiguous' ? 'branch_conflict'
    : ['instruction_unbound', 'truncated'].includes(state.reason) ? 'chain_broken' : 'unsupported_format');
  const diag = { evidence_ids: [], segment: { start_id: target.uuid, end_id: mainSignificant.at(-1)?.uuid || target.uuid } };
  if (state.reason === 'local_command') return { status: 'local_command', diag };
  const evidence = mainSignificant.filter(checked(r => core.claudeInterrupted(r) || r.type === 'assistant'
    || r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some(checked(b => b.type === 'tool_result', step)), step)).at(-1);
  if (state.state === 'working') return { status: 'pending', diag };
  if (!evidence || !policy.isSafeTimestamp(evidence.timestamp)) return failure('unsupported_format');
  if (state.state === 'interrupted') return { status: 'interrupted', answer_at: evidence.timestamp,
    diag: { ...diag, evidence_ids: [evidence.uuid] } };
  // Old transcripts without message.id can prove only this terminal record, never a multi-record group.
  const group = evidence.message?.id ? mainSignificant.filter(checked(r => r.type === 'assistant'
    && r.message?.id === evidence.message.id && r.message.stop_reason !== 'tool_use', step)) : [evidence];
  const textRecords = group.filter(checked(r => r.answerParts > 0, step));
  const bytes = textRecords.reduce(checked((n, r) => n + (r.answerBytes || 0), step), Math.max(0, textRecords.length - 1) * 2);
  const text = bytes <= RAW_LIMIT ? textRecords.map(checked(r => r.answerText, step)).join('\n\n') : null;
  return { status: bytes > 0 ? 'final' : 'no_text', text, bytes, answer_at: evidence.timestamp,
    diag: { ...diag, evidence_ids: group.map(checked(r => r.uuid, step)) } };
}
function codexAnswer(rows, position, step) {
  let start = -1;
  for (let i = 0; i < position; i++) {
    step(); if (rows[i].type === 'event_msg' && rows[i].payload?.type === 'task_started') start = i;
  }
  if (start < 0) return failure('segment_conflict');
  let end = rows.length;
  for (let i = start + 1; i < rows.length; i++) {
    step(); if (rows[i].type === 'event_msg' && rows[i].payload?.type === 'task_started') { end = i; break; }
  }
  const segment = rows.slice(start, end), turn = rows[start].payload.turn_id;
  if (!policy.isSafeId(turn)) return failure('unsupported_format');
  const closings = segment.filter(checked(r => r.type === 'event_msg' && ['task_complete', 'turn_aborted'].includes(r.payload?.type), step));
  if (closings.length > 1 || closings.length === 0 && end < rows.length || position >= end
    || closings[0] && checkedIndexOf(rows, closings[0], step) < position
    || segment.some(checked(r => (r.type === 'turn_context' || r.type === 'event_msg'
      && (r.payload?.type?.startsWith('task_') || r.payload?.type === 'turn_aborted')) && r.payload?.turn_id !== turn, step))
    || end < rows.length && rows.slice(end).some(checked(r => r.payload?.turn_id === turn, step))) return failure('segment_conflict');
  const closing = closings[0];
  if (closing && segment.slice(checkedIndexOf(segment, closing, step) + 1).some(checked(r => r.payload?.role === 'assistant' || r.payload?.role === 'user', step))) return failure('segment_conflict');
  const assistants = segment.filter(checked(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'assistant', step));
  if (assistants.length && !assistants.some(checked(r => ['commentary', 'final_answer'].includes(r.payload.phase), step))
    && !closing?.answerBytes && closing?.payload.type !== 'turn_aborted') return failure('unsupported_format');
  const state = core.codexStatus(segment);
  if (state.state === 'unknown') return failure('unsupported_format');
  const diag = { evidence_ids: [], segment: { start_id: turn, end_id: closing ? turn : null } };
  if (state.state === 'working') return { status: 'pending', diag };
  const answerAt = closing.payload.type === 'task_complete' && policy.isSafeTimestamp(closing.payload.completed_at)
    ? closing.payload.completed_at : closing.timestamp;
  if (!policy.isSafeTimestamp(answerAt)) return failure('unsupported_format');
  const shared = segment.filter(checked(r => {
    if (r.type !== 'response_item' || r.payload?.type !== 'message' || r.payload.role !== 'user') return false;
    const classification = core.classifyCodexMessage(r.payload);
    return classification.kind && !classification.empty && !classification.unverified;
  }, step)).length > 1;
  if (state.state === 'interrupted') return { status: 'interrupted', answer_at: answerAt, shared_turn: shared,
    diag: { ...diag, evidence_ids: [turn] } };
  const candidate = closing.answerBytes > 0 ? closing : assistants.filter(checked(r => r.payload.phase === 'final_answer', step)).at(-1);
  const bytes = candidate?.answerBytes || 0;
  return { status: bytes > 0 ? 'final' : 'no_text', text: candidate?.answerText || null, bytes,
    answer_at: answerAt, shared_turn: shared, diag: { ...diag, evidence_ids: [turn] } };
}
function readAnswer(input) {
  const { instrId, ref, file_fp, diag = false } = input;
  const provider = input.provider || instrId?.split(':')[0], sid = instrId?.split(':')[1];
  if (!policy.isSafeInstructionId(instrId) || provider !== instrId.split(':')[0] || typeof ref !== 'string' || !/^[0-9a-f]{16}$/.test(ref)
    || typeof diag !== 'boolean') throw new reader.ReaderError('request_invalid');
  const homeDir = input.homeDir || os.homedir();
  const options = { homeDir, configDir: input.configDir || path.join(homeDir, '.config', 'palantir'), now: input.now instanceof Date ? input.now : new Date(input.now),
    readerBuild: input.readerBuild || '0000000000000000', includeExec: false };
  if (!Number.isFinite(+options.now) || !policy.isSafeTimestamp(options.now.toISOString())
    || !policy.READER_BUILD_RE.test(options.readerBuild) || typeof options.homeDir !== 'string' || !path.isAbsolute(options.homeDir)
    || typeof options.configDir !== 'string' || !path.isAbsolute(options.configDir)) throw new reader.ReaderError('request_invalid');
  const config = input.config || reader.loadConfig(options);
  const base = { schema: 'palantir.answer/1', kind: 'answer', machine_id: config.machine_id, reader_build: options.readerBuild,
    target: { instrId, ref, file_fp: file_fp || '0000000000000000' }, status: 'pending', reason: null, text: null,
    truncated: false, redacted: false, shared_turn: false, answer_at: null, observed_at: options.now.toISOString() };
  let unboundStart = null;
  function envelope(result) {
    const value = { ...base, status: result.status, reason: result.reason || null, answer_at: result.answer_at || null,
      shared_turn: result.shared_turn || false };
    if (result.status === 'final') {
      if (result.bytes > RAW_LIMIT) return envelope({ status: 'withheld', reason: 'too_large' });
      const finalized = policy.finalizeAnswerText(result.text);
      value.text = finalized.value; value.redacted = finalized.redacted; value.truncated = finalized.truncated;
    }
    if (diag) value.diag = result.diag || { evidence_ids: [], segment: { start_id: result.status === 'unbound' ? unboundStart : null, end_id: null } };
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
      if (result.status === 'unavailable') throw new reader.ReaderError('internal_error');
      return envelope({ status: 'unavailable', reason: 'read_limit' });
    }
    if (!policy.validateAnswerEnvelope(value, { allowDiag: diag }).ok) {
      if (result.status === 'unavailable') throw new reader.ReaderError('internal_error');
      return envelope({ status: 'unavailable', reason: 'exec_failed' });
    }
    return value;
  }
  const reject = (status, reason) => envelope({ status, reason });
  if (!file_fp) return reject('target_changed', 'file_missing');
  if (typeof file_fp !== 'string' || !/^[0-9a-f]{16}$/.test(file_fp)) throw new reader.ReaderError('request_invalid');
  const deadlineError = Object.assign(new Error('answer_deadline'), { answerDeadline: true });
  const clock = input.clock || Date.now;
  const checkDeadline = input.deadlineAt === undefined ? undefined : () => {
    if (clock() >= input.deadlineAt) throw deadlineError;
  };
  const step = deadlineStep(checkDeadline);
  try {
    checkDeadline?.();
    const coverage = Object.fromEntries(policy.COVERAGE_KEYS[provider].map(k => [k, 0]));
    const root = path.join(options.homeDir, provider === 'claude' ? '.claude/projects' : '.codex/sessions');
    const files = reader.listFiles(root, coverage, { entries: 0, files: 0 }, checkDeadline);
    checkDeadline?.();
    const matches = [];
    for (const file of files) {
      checkDeadline?.(); step();
      try { const stats = fs.lstatSync(file.file, { bigint: true });
        if (stats.isFile() && !stats.isSymbolicLink() && fileFingerprint(stats) === file_fp) matches.push({ ...file, identity: stats });
      } catch { coverage.files_failed++; }
    }
    checkDeadline?.();
    if (matches.length > 1) return reject('withheld', 'held');
    if (!matches.length) return coverage.files_failed ? reject('unavailable', 'read_limit') : reject('target_changed', 'file_missing');
    const file = matches[0]; let fd;
    try {
      checkDeadline?.();
      fd = fs.openSync(file.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const initial = fs.fstatSync(fd, { bigint: true });
      if (initial.dev !== file.identity.dev || initial.ino !== file.identity.ino) return reject('unavailable', 'file_changed');
      const observation = { provider, size: Number(initial.size), selected: false };
      const rows = []; let toolIdentifiers = 0;
      const partial = { held: false, sessions: new Set(), identities: new Set(), users: new Set(), queued: new Set() };
      function observePartial(record) {
        const sessionId = provider === 'claude' ? record.sessionId : record.type === 'session_meta' ? record.payload?.id : undefined;
        if (typeof sessionId === 'string') partial.sessions.add(sessionId);
        partial.held ||= partial.sessions.size > 1 || Object.hasOwn(record, 'timestamp') && !policy.isSafeTimestamp(record.timestamp);
        const user = provider === 'claude' ? record.type === 'user'
          : record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user';
        const queued = provider === 'claude' && core.isQueuedInstruction(record);
        const id = provider === 'claude' ? record.uuid : record.payload?.id;
        if ((user || queued) && core.isIdentityComponent(id)) {
          partial.held ||= partial.identities.has(id); partial.identities.add(id);
        }
        if (provider === 'claude' && user) for (const alias of [record.uuid, record.source_uuid, record.delivery_id,
          record.message?.uuid, record.message?.source_uuid, record.message?.delivery_id]) {
          if (typeof alias !== 'string') continue;
          partial.held ||= partial.queued.has(alias); partial.users.add(alias);
        }
        if (queued) for (const alias of [record.uuid, record.source_uuid, record.delivery_id,
          record.attachment.source_uuid, record.attachment.delivery_id]) {
          if (typeof alias !== 'string') continue;
          partial.held ||= partial.users.has(alias); partial.queued.add(alias);
        }
        core.checkMetadata(partial.sessions.size + partial.identities.size + partial.users.size + partial.queued.size);
      }
      const source = core.transcriptSource(fd, provider, observation, {
        transcriptRecords: function* (descriptor, observed) {
          for (const record of reader.transcriptRecords(descriptor, observed, checkDeadline)) {
            checkDeadline?.();
            observePartial(record);
            const row = projectAnswerRecord(record, provider, step);
            toolIdentifiers += (row.toolUseIds?.length || 0) + (row.toolResultIds?.length || 0);
            core.checkMetadata(rows.length + 1 + toolIdentifiers); rows.push(row); yield record;
            checkDeadline?.();
          }
        }, readStatusTail: () => rows
      });
      let parsed, readError;
      try { parsed = core.parseIndependentTranscript(provider, source, coverage, config, true, {}, (provider, source, coverage, config) => collectAnswerSession(provider, source, coverage, config, step)); } catch (e) { if (e === deadlineError) throw e; readError = e; }
      checkDeadline?.();
      let changed = false;
      try {
        const current = fs.fstatSync(fd, { bigint: true }), named = fs.statSync(file.file, { bigint: true });
        changed = current.dev !== initial.dev || current.ino !== initial.ino || current.size < initial.size
          || named.dev !== initial.dev || named.ino !== initial.ino;
      } catch { changed = true; }
      if (observation.selected && observation.sessionId !== sid) return reject('withheld', 'identity_mismatch');
      if (partial.held || source.analysis.mixed || source.analysis.duplicates || source.analysis.queuedDuplicate || source.analysis.invalidTime)
        return reject('withheld', 'held');
      const session = parsed?.session;
      const observedSession = session || (observation.selected && observation.sessionId === sid ? {
        provider, sid, cwd: core.representativeTranscriptCwd(provider, source),
        run_mode: provider === 'codex' ? core.determineCodexRunMode(source.find(r => r.type === 'session_meta')?.payload?.source,
          source.find(r => r.type === 'session_meta')?.payload?.thread_source) : 'interactive' } : null);
      if (observedSession) {
        if (observedSession.cwd?.length > 4096) observedSession.cwd = null;
        const exclusion = core.snapshotSessionExclusion(options, config, observedSession, Boolean(session), projectSession);
        if (exclusion) return reject('withheld', ['excluded_sessions', 'exec_sessions_excluded', 'subagent_excluded'].includes(exclusion) ? 'excluded' : 'held');
        if (core.hasSessionInstructionDeletionRule(config, observedSession)) return reject('withheld', 'deleted_rule');
      }
      if (!readError && !session) return reject('withheld', 'held');
      const target = (session?.items || source.answerItems || []).find(checked(item => item.id === instrId, step));
      if (target && target.ref !== ref || !readError && !target) return reject('target_changed', 'ref_mismatch');
      if (changed) return reject('unavailable', 'file_changed');
      if (readError) return reject('unavailable', readError.streamLimit ? 'read_limit' : 'exec_failed');
      if (provider === 'claude') unboundStart = rows[target.position]?.uuid || null;
      else for (let i = 0; i < target.position; i++) {
        step();
        if (rows[i].type === 'event_msg' && rows[i].payload?.type === 'task_started') unboundStart = rows[i].payload.turn_id;
      }
      if (source.analysis.brokenJson) return reject('unbound', 'unsupported_format');
      const result = provider === 'claude' ? claudeAnswer(rows, target.position, step) : codexAnswer(rows, target.position, step);
      checkDeadline?.();
      return envelope(result);
    } catch (error) {
      if (error === deadlineError) throw error;
      return reject('unavailable', error.streamLimit ? 'read_limit' : 'file_changed');
    }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  } catch (error) {
    if (error === deadlineError) return reject('unavailable', 'timeout');
    throw error;
  }
}
module.exports = { readAnswer, fileFingerprint };
