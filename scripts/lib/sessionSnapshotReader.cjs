'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const snapshotPolicy = require('../../server/services/observeSnapshotPolicy.js');
const MAX_FILES = 10000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const STREAM_LIMITS = { lineBytes: 8 * 1024 * 1024, fileBytes: 256 * 1024 * 1024, identities: 100000, smallFileBytes: MAX_FILE_BYTES };
function streamLimit() { const error = new Error('stream_limit'); error.streamLimit = true; throw error; }
function checkMetadata(size) { if (size > STREAM_LIMITS.identities) streamLimit(); }
// Spec §1.4: observations survive any later read/limit failure; paths stay local as hashes.
function observeTranscriptIdentity(record, observation) {
  const sid = observation.provider === 'claude' ? record.sessionId
    : record.type === 'session_meta' ? record.payload?.id : undefined;
  if (isIdentityComponent(sid)) observation.sessionIds.add(sid);
  const cwd = observation.provider === 'claude' ? record.cwd : record.payload?.cwd;
  if (typeof cwd === 'string' && cwd !== observation.lastCwd) {
    observation.cwdHashes.add(crypto.createHash('sha256').update(cwd).digest('hex'));
    observation.lastCwd = cwd;
  }
  if (observation.limited) checkMetadata(observation.sessionIds.size + observation.cwdHashes.size);
}
function* transcriptRecords(fd, observation) {
  const limited = observation?.limited !== false;
  function consume(line) {
    const record = parseTranscriptRecord(line);
    if (observation) observeTranscriptIdentity(record, observation);
    return record;
  }
  const chunk = Buffer.allocUnsafe(256 * 1024);
  let offset = 0, pending = [], pendingBytes = 0;
  while (true) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, STREAM_LIMITS.fileBytes + 1 - offset), offset);
    if (!count) break;
    offset += count;
    if (offset > STREAM_LIMITS.fileBytes) streamLimit();
    let start = 0, end;
    while ((end = chunk.indexOf(10, start)) >= 0 && end < count) {
      const bytes = pendingBytes + end - start;
      if (limited && bytes > STREAM_LIMITS.lineBytes) streamLimit();
      const line = pendingBytes ? Buffer.concat([...pending, chunk.subarray(start, end)], bytes).toString('utf8')
        : chunk.toString('utf8', start, end);
      pending = []; pendingBytes = 0; start = end + 1;
      if (line.trim()) yield consume(line);
    }
    const bytes = count - start;
    if (limited && pendingBytes + bytes > STREAM_LIMITS.lineBytes) streamLimit();
    if (bytes) { pending.push(Buffer.from(chunk.subarray(start, count))); pendingBytes += bytes; }
  }
  if (pendingBytes) {
    const line = Buffer.concat(pending, pendingBytes).toString('utf8');
    if (line.trim()) yield consume(line);
  }
}
function transcriptSource(fd, provider, validateOnly = false, observation) {
  const headers = [];
  const source = { streaming: true, limited: observation?.limited !== false, find(predicate) { return headers.find(predicate); } };
  const analysis = { byUuid: new Map(), firstTime: null, lastTime: null, duplicates: 0, invalidTime: 0,
    mixed: false, queuedDuplicate: false, sidechainOnly: true, singleSession: true, count: 0 };
  const seen = new Set(), users = new Set(), queued = new Set(), sessions = new Set();
  let hasMeta = false, hasSid = false, hasCwd = false, hasBranch = false, firstSid;
  let timestampInput, timestampOutput;
  function observe(record) {
    analysis.count++;
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
    if (record.isSidechain !== true) analysis.sidechainOnly = false;
    if (record.sessionId !== firstSid || !hasSid) analysis.singleSession = false;
    if (typeof record.uuid === 'string' && record.uuid) analysis.byUuid.set(record.uuid, Object.hasOwn(record, 'parentUuid')
      ? { parentUuid: typeof record.parentUuid === 'string' || record.parentUuid === null ? record.parentUuid : false } : {});
    const user = provider === 'claude' ? record.type === 'user'
      : record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user';
    const attachment = provider === 'claude' && isHumanQueuedInstruction(record);
    const identity = provider === 'claude' ? record.uuid : record.payload?.id;
    if ((user || attachment) && isIdentityComponent(identity)) {
      if (seen.has(identity)) analysis.duplicates++;
      seen.add(identity);
    }
    if (provider === 'claude' && user) for (const id of [record.uuid, record.source_uuid, record.delivery_id,
      record.message?.uuid, record.message?.source_uuid, record.message?.delivery_id])
      if (typeof id === 'string') users.add(id);
    if (attachment) for (const id of [record.uuid, record.attachment.source_uuid, record.attachment.delivery_id])
      if (typeof id === 'string') queued.add(id);
    if (source.limited) checkMetadata(analysis.byUuid.size + seen.size + users.size + queued.size + sessions.size);
  }
  function finish() {
    analysis.mixed = sessions.size > 1;
    analysis.singleSession &&= sessions.size === 1;
    analysis.sidechainOnly &&= analysis.count > 0;
    for (const id of queued) if (users.has(id)) { analysis.queuedDuplicate = true; break; }
  }
  source.analysis = analysis;
  // Most transcripts establish their identity and a timestamp in the first record.
  // A bounded lookahead leaves late metadata on the complete validation path.
  let lookahead = 0;
  for (const record of transcriptRecords(fd, observation)) {
    observe(record);
    if (analysis.firstTime && isIdentityComponent(transcriptSessionId(provider, source))) break;
    if (++lookahead >= 16) break;
  }
  const seedTime = analysis.firstTime;
  const ready = !validateOnly && analysis.firstTime && isIdentityComponent(transcriptSessionId(provider, source));
  analysis.byUuid.clear(); seen.clear(); users.clear(); queued.clear(); sessions.clear();
  Object.assign(analysis, { firstTime: null, lastTime: null, count: 0, duplicates: 0,
    invalidTime: 0, singleSession: true, sidechainOnly: true, mixed: false, queuedDuplicate: false });
  if (ready) {
    source.lazy = true;
    // parseFile checks timestamp availability before it consumes the iterator.
    analysis.firstTime = seedTime;
  }
  source[Symbol.iterator] = function* () {
    for (const record of transcriptRecords(fd, observation)) { observe(record); yield record; }
    finish();
  };
  if (!ready) {
    for (const record of source) {}
    source[Symbol.iterator] = () => transcriptRecords(fd, observation);
  }
  return source;
}
const IDENTITY_PREFIX_BYTES = 64 * 1024;
const RECENT_INSTRUCTIONS = 200;
class ReaderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReaderError';
    this.code = snapshotPolicy.STATUS_CODES.includes(code) ? code : 'internal_error';
  }
}
const fail = code => {
  throw new ReaderError(code);
};
const computeHmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const computeKeyFingerprint = key => crypto.createHash('sha256').update(key).digest('hex');
// Spec §3 / host R7: Date accepts extended years that the shared TIME slot forbids.
function toIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) {
    return null;
  }
  const timestamp = new Date(milliseconds).toISOString();
  return snapshotPolicy.isSafeTimestamp(timestamp) ? timestamp : null;
}
const safeId = snapshotPolicy.isSafeId;
const isIdentityComponent = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) && safeId(value);
const normalizeDeletionText = value => value.normalize('NFC').trim();

function isValidMachineLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(value) && !value.startsWith('-')
    && snapshotPolicy.finalizeLabel(value).value === value;
}

function validateReaderOptions(readerOptions) {
  const allowedKeys = [
    'homeDir', 'configDir', 'now', 'includeExec', 'readerBuild', 'runOrca', 'target', 'token', 'machineLabel'
  ];
  if (
    !readerOptions
    || Object.keys(readerOptions).some(key => !allowedKeys.includes(key))
    || typeof readerOptions.homeDir !== 'string'
    || !path.isAbsolute(readerOptions.homeDir)
    || typeof readerOptions.configDir !== 'string'
    || !path.isAbsolute(readerOptions.configDir)
    || (readerOptions.includeExec !== undefined && typeof readerOptions.includeExec !== 'boolean')
    || (readerOptions.runOrca !== undefined && typeof readerOptions.runOrca !== 'function')
    || (readerOptions.machineLabel !== undefined && !isValidMachineLabel(readerOptions.machineLabel))
    || !(readerOptions.now instanceof Date)
    || !Number.isFinite(+readerOptions.now)
    || !toIsoTimestamp(readerOptions.now.toISOString())
    || !toIsoTimestamp(new Date(+readerOptions.now - 14 * 86400000).toISOString())
    || typeof readerOptions.readerBuild !== 'string'
    || !snapshotPolicy.READER_BUILD_RE.test(readerOptions.readerBuild)
  ) {
    fail('request_invalid');
  }
  if (Number(process.versions.node.split('.')[0]) < 18) {
    fail('node_unsupported');
  }
  return readerOptions;
}

function configPath(readerOptions) {
  return path.join(readerOptions.configDir, 'observe.json');
}

function readConfig(readerOptions) {
  try {
    const file = configPath(readerOptions);
    const fileStats = fs.lstatSync(file);
    if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.size > 1024 * 1024) {
      fail('key_unavailable');
    }
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !safeId(config.machine_id)
      || !/^[A-Za-z0-9._-]{1,32}$/.test(config.machine_label)
      || snapshotPolicy.finalizeLabel(config.machine_label).value !== config.machine_label
      || typeof config.path_salt !== 'string'
      || !config.path_salt
      || !snapshotPolicy.isSafeInteger(config.path_gen)
      || !config.exclude
      || !['sessions', 'instructions'].every(key => Array.isArray(config.exclude[key]))
    ) {
      fail('key_unavailable');
    }
    const legacyCwdPrefixes = config.exclude.cwd_prefixes;
    // Host R6: unsupported nonempty legacy exclusions are invalid requests; never silently ignore their intent.
    if (legacyCwdPrefixes !== undefined && (!Array.isArray(legacyCwdPrefixes) || legacyCwdPrefixes.length !== 0)) {
      fail('request_invalid');
    }
    const invalidContentRuleSessions = new Set();
    for (const record of config.exclude.instructions) {
      if (!record || !snapshotPolicy.isSafeInstructionId(record.id)) {
        fail('key_unavailable');
      }
      // Spec §2/§4 and host R5: malformed content rules withhold their session, not the whole config.
      if (/^codex:[^:]+:n\d+$/.test(record.id) && !hasValidContentRuleFingerprints(record)) {
        invalidContentRuleSessions.add(record.id.split(':')[1]);
      }
    }
    // Keep derived validation state local; config updates persist only the original union of rules.
    Object.defineProperty(config, 'invalidContentRuleSessions', { value: invalidContentRuleSessions });
    return config;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    if (error instanceof ReaderError) {
      throw error;
    }
    fail('key_unavailable');
  }
}

function hasValidContentRuleFingerprints(rule) {
  return typeof rule.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(rule.fingerprint)
    && typeof rule.key_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(rule.key_fingerprint);
}

function hasValidLocalKey(config) {
  return typeof config.local_key === 'string'
    && /^[0-9a-f]{64}$/.test(config.local_key)
    && config.key_fingerprint === computeKeyFingerprint(config.local_key);
}

// Spec §2: O_EXCL rejects overlapping writers; the callback rereads the latest config.
function withConfigLock(readerOptions, operation) {
  fs.mkdirSync(readerOptions.configDir, {
    recursive: true,
    mode: 0o700
  });
  const lock = configPath(readerOptions) + '.lock';
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      fail('config_busy');
    }
    fail('internal_error');
  }
  try {
    return operation();
  } finally {
    fs.closeSync(fileDescriptor);
    fs.unlinkSync(lock);
  }
}

function writeConfig(readerOptions, config) {
  const temporaryPath = configPath(readerOptions) + '.tmp-' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(config), {
      flag: 'wx',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, configPath(readerOptions));
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

// Spec §2: only a missing file permits initial key creation; invalid existing keys never rotate.
function loadConfig(readerOptions) {
  validateReaderOptions(readerOptions);
  let config = readConfig(readerOptions);
  const existingConfig = config !== null;
  if (config) {
    if (!hasValidLocalKey(config)) {
      fail('key_unavailable');
    }
    if (readerOptions.machineLabel === undefined || readerOptions.machineLabel === config.machine_label) {
      return config;
    }
  }
  return withConfigLock(readerOptions, () => {
    config = readConfig(readerOptions);
    if (config) {
      if (!hasValidLocalKey(config)) {
        fail('key_unavailable');
      }
      // Spec §2: a label update rereads under the same lock and preserves every other stored field.
      if (readerOptions.machineLabel !== undefined && readerOptions.machineLabel !== config.machine_label) {
        config.machine_label = readerOptions.machineLabel;
        writeConfig(readerOptions, config);
      }
      return config;
    }
    if (existingConfig) {
      fail('key_unavailable');
    }
    const key = crypto.randomBytes(32).toString('hex');
    config = {
      machine_id: crypto.randomBytes(8).toString('hex'),
      machine_label: readerOptions.machineLabel ?? 'machine',
      path_salt: crypto.randomBytes(32).toString('hex'),
      path_gen: 0,
      local_key: key,
      key_fingerprint: computeKeyFingerprint(key),
      exclude: {
        sessions: [],
        instructions: []
      }
    };
    writeConfig(readerOptions, config);
    return config;
  });
}

function defaultRunOrca(args, bin = 'orca') {
  if ((process.env.NODE_TEST_CONTEXT || process.env.PALANTIR_BLOCK_REAL_SPAWN) && !path.isAbsolute(bin)) {
    return null;
  }
  try {
    return execFileSync(bin, args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch {
    return null;
  }
}

function isRecordObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Spec §1: unsupported JSON values and blocks become coverage, never collection-wide exceptions.
function parseTranscriptRecord(line) {
  try {
    const record = JSON.parse(line);
    if (!isRecordObject(record)) {
      return { __invalid: true };
    }
    for (const container of [record.message, record.payload]) {
      if (isRecordObject(container) && Array.isArray(container.content)) {
        container.content = container.content.map(block => isRecordObject(block) ? block : { __invalid: true });
      }
    }
    return record;
  } catch {
    return { __invalid: true };
  }
}

function countInvalidBlocks(record) {
  const content = record.message?.content ?? record.payload?.content;
  return Array.isArray(content) ? content.filter(block => block.__invalid).length : 0;
}

function listFiles(root, providerCoverage, budget) {
  const result = [];
  let ancestor = root;
  const boundary = path.dirname(path.dirname(path.dirname(root)));
  while (ancestor !== boundary) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) {
        return result;
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return result;
      }
      providerCoverage.files_failed++;
      return result;
    }
    ancestor = path.dirname(ancestor);
  }
  function walk(dir, depth) {
    if (depth > 32) {
      providerCoverage.files_failed++;
      return;
    }
    let directoryStats;
    try {
      directoryStats = fs.lstatSync(dir);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        providerCoverage.files_failed++;
      }
      return;
    }
    if (directoryStats.isSymbolicLink()) {
      return;
    }
    if (!directoryStats.isDirectory()) {
      return;
    }
    let names;
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      providerCoverage.files_failed++;
      return;
    }
    for (const name of names) {
      if (++budget.entries > MAX_FILES) {
        providerCoverage.files_failed++;
        return;
      }
      const filePath = path.join(dir, name);
      try {
        const fileStats = fs.lstatSync(filePath);
        if (fileStats.isSymbolicLink()) {
          continue;
        }
        if (fileStats.isDirectory()) {
          walk(filePath, depth + 1);
        } else if (fileStats.isFile() && name.endsWith('.jsonl')) {
          if (budget.files++ >= MAX_FILES) {
            providerCoverage.files_failed++;
            continue;
          }
          result.push({ file: filePath, stats: fileStats, root });
        }
      } catch {
        providerCoverage.files_failed++;
      }
    }
  }
  walk(root, 0);
  return result;
}

// Spec §1.4: copy bounded UTF-16 code units without retaining the source string.
function retainString(value, max) {
  return typeof value === 'string' ? Buffer.from(value.slice(0, max), 'utf16le').toString('utf16le') : null;
}

// Spec §1.1: first matching row wins; output and origin conflicts precede slash/shell wrappers.
function isHumanQueuedInstruction(record) {
  if (record.type !== 'attachment' || record.attachment?.type !== 'queued_command'
    || !isIdentityComponent(record.uuid) || !toIsoTimestamp(record.timestamp)) return false;
  const classification = classifyClaudeRecord(record);
  return classification?.kind === 'human';
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

function parseFile(provider, records, providerCoverage, config = {}, retainAllInstructions = false,
  displayOptions = {}) {
  // Spec §1.2/§1.4: parse a nonwithheld file in original order before timestamp display sorting.
  let firstTime = records.analysis?.firstTime || null, lastTime = records.analysis?.lastTime || null;
  const byUuid = records.analysis?.byUuid || new Map();
  if (!records.analysis) for (const record of records) {
    const ts = toIsoTimestamp(record.timestamp);
    if (ts && (!firstTime || ts < firstTime)) firstTime = ts;
    if (ts && (!lastTime || ts > lastTime)) lastTime = ts;
    if (record.uuid) {
      byUuid.set(record.uuid, Object.hasOwn(record, 'parentUuid') ? { parentUuid: record.parentUuid } : {});
      if (records.limited !== false) checkMetadata(byUuid.size);
    }
  }
  if (!firstTime) {
    for (const record of records) if (record.__invalid || (provider === 'claude'
      ? record.type === 'user' || classifyClaudeRecord(record)
      : record.type === 'response_item' && record.payload?.type === 'message' && record.payload.role === 'user'))
      providerCoverage.records_unverified++;
    return null;
  }
  let sessionId;
  let cwd = '';
  let branch = null;
  let run_mode = 'interactive';
  let title = null;
  const items = [];
  const retainedText = new Map();
  const retainedOrder = [];
  let targetText;
  const linkState = {};
  let unknown = 0;
  let compact = false;
  let compactBefore = false;
  let first = null;
  let metaBefore = false;
  let userNo = 0;
  let firstClaudeRecord = null;
  if (provider === 'codex') {
    const meta = records.find(record => record.type === 'session_meta')?.payload;
    if (!meta) {
      providerCoverage.records_unverified++;
      return null;
    }
    sessionId = meta.id;
    cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
    branch = meta.git?.branch;
    const source = meta.source;
    const thread = meta.thread_source;
    run_mode = determineCodexRunMode(source, thread);
  } else {
    sessionId = records.find(record => isIdentityComponent(record.sessionId))?.sessionId;
    cwd = records.find(record => typeof record.cwd === 'string')?.cwd || '';
    branch = records.find(record => typeof record.gitBranch === 'string')?.gitBranch;
  }
  if (!isIdentityComponent(sessionId)) {
    providerCoverage.records_unverified++;
    return null;
  }
  const readerOptions = displayOptions.readerOptions;
  const lastAt = Date.parse(lastTime);
  let displayExcluded = displayOptions.withheld || (!retainAllInstructions && readerOptions
    && (lastAt < +readerOptions.now - 14 * 86400000 || lastAt > +readerOptions.now
      || snapshotSessionExclusion(readerOptions, config, { provider, sid: sessionId,
        cwd: cwd.length > 4096 ? null : cwd, run_mode }, false) !== null));
  let position = -1;
  for (const record of records) {
    position++;
    const timestamp = records.lazy ? records.analysis.currentTime : toIsoTimestamp(record.timestamp);
    if (record.__invalid) {
      providerCoverage.records_unverified++;
      continue;
    }
    providerCoverage.records_unverified += countInvalidBlocks(record);
    if (provider === 'claude') {
      if (record.isCompactSummary) {
        compactBefore = true;
      }
      if (record.type === 'user' && typeof record.message?.content !== 'string' && !Array.isArray(record
        .message?.content)) {
        providerCoverage.records_unverified++;
        continue;
      }
      if (record.type === 'queue-operation') {
        const coverageKey = { enqueue: 'queued_enqueued', dequeue: 'queued_dequeued', remove: 'queued_removed' };
        if (typeof record.operation === 'string' && Object.hasOwn(coverageKey, record.operation))
          providerCoverage[coverageKey[record.operation]]++;
        continue;
      }
      if (record.type === 'ai-title') {
        const entry = record.aiTitle ?? record.title;
        if (typeof entry === 'string') {
          title = entry;
        }
        continue;
      }
      if (record.isCompactSummary) {
        compactBefore = true;
      }
      const classification = classifyClaudeRecord(record);
      if (!classification) {
        continue;
      }
      if (classification.unverified) { providerCoverage.records_unverified++; continue; }
      if (classification.unknown) {
        unknown++;
        continue;
      }
      if (!first) {
        first = compactBefore ? 'unrecoverable' : records.lazy ? 'unknown' : recoverClaudeFirstInstruction(record, byUuid);
        if (records.lazy && !compactBefore) firstClaudeRecord = Object.hasOwn(record, 'parentUuid') ? { parentUuid: record.parentUuid } : {};
      }
      if (!isIdentityComponent(record.uuid) || !timestamp || !snapshotPolicy.isSafeInstructionId(
        `claude:${sessionId}:u${record.uuid}`)) {
        providerCoverage.records_unverified++;
        continue;
      }
      if (record.type === 'attachment') providerCoverage.queued_delivered_attachment++;
      items.push(compactInstruction(config, {
        ...classification,
        id: `claude:${sessionId}:u${record.uuid}`,
        ts: timestamp,
        position,
        structure: [['text', normalizeDeletionText(classification.text)], ['attachments', classification.attachments]]
      }, linkState));
      if (records.limited !== false) checkMetadata(items.length);
      if (records.streaming) {
        const item = items[items.length - 1];
        retainedText.set(item, item.text);
        delete item.text;
        if (displayOptions.target?.instrId === item.id) targetText = retainedText.get(item);
        let low = 0, high = retainedOrder.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compareRecordTimes(retainedOrder[middle], item) <= 0) low = middle + 1;
          else high = middle;
        }
        retainedOrder.splice(low, 0, item);
        if (retainedOrder.length > RECENT_INSTRUCTIONS + 1) retainedText.delete(retainedOrder.splice(1, 1)[0]);
      }
    } else {
      if (record.type === 'session_meta') {
        metaBefore = true;
      }
      if (record.type === 'compacted') {
        compact = true;
        if (!first) {
          compactBefore = true;
        }
        continue;
      }
      if (record.type === 'event_msg' && record.payload?.type === 'user_message') {
        providerCoverage.records_unverified++;
        continue;
      }
      if (record.type !== 'response_item' || record.payload?.type !== 'message' || record.payload.role !== 'user') {
        continue;
      }
      userNo++;
      if (!first) {
        first = compactBefore ? 'unrecoverable' : metaBefore ? 'recoverable' : 'unknown';
      }
      const classification = classifyCodexMessage(record.payload);
      if (classification.unverified) {
        providerCoverage.records_unverified++;
        continue;
      }
      unknown += classification.unknown_blocks;
      if (classification.empty) {
        continue;
      }
      const rawId = record.payload.id;
      const suffix = codexIdentitySuffix(rawId, userNo);
      if (!suffix || !timestamp || !snapshotPolicy.isSafeInstructionId(`codex:${sessionId}:${suffix}`)) {
        providerCoverage.records_unverified++;
        continue;
      }
      items.push(compactInstruction(config, {
        ...classification,
        id: `codex:${sessionId}:${suffix}`,
        ts: timestamp,
        position,
        structure: [...classification.structure, ['attachments', classification.attachments]]
      }, linkState));
      if (records.limited !== false) checkMetadata(items.length);
      if (records.streaming) {
        const item = items[items.length - 1];
        retainedText.set(item, item.text);
        delete item.text;
        if (displayOptions.target?.instrId === item.id) targetText = retainedText.get(item);
        let low = 0, high = retainedOrder.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (compareRecordTimes(retainedOrder[middle], item) <= 0) low = middle + 1;
          else high = middle;
        }
        retainedOrder.splice(low, 0, item);
        if (retainedOrder.length > RECENT_INSTRUCTIONS + 1) retainedText.delete(retainedOrder.splice(1, 1)[0]);
      }
    }
  }
  if (records.lazy) {
    firstTime = records.analysis.firstTime; lastTime = records.analysis.lastTime;
    if (firstClaudeRecord) first = recoverClaudeFirstInstruction(firstClaudeRecord, byUuid);
    if (provider === 'claude') {
      cwd = records.find(record => typeof record.cwd === 'string')?.cwd || '';
      branch = records.find(record => typeof record.gitBranch === 'string')?.gitBranch;
    }
    displayExcluded = displayOptions.withheld || records.analysis.mixed || records.analysis.duplicates > 0
      || records.analysis.queuedDuplicate || records.analysis.invalidTime > 0 || (!retainAllInstructions && readerOptions
        && (Date.parse(lastTime) < +readerOptions.now - 14 * 86400000 || Date.parse(lastTime) > +readerOptions.now
          || snapshotSessionExclusion(readerOptions, config, { provider, sid: sessionId,
            cwd: cwd.length > 4096 ? null : cwd, run_mode }, false) !== null));
  }
  // Spec §1.2/§1.4: timestamp display ordering cannot alter n identities or recovery evidence.
  items.sort(compareRecordTimes);
  providerCoverage.records_unknown += unknown;
  const detail = boundSessionInstructions(items, config, providerCoverage, retainAllInstructions && !records.streaming);
  if (records.streaming) {
    if (displayOptions.target?.kind === 'instruction') detail.items = items.filter(item => item.id === displayOptions.target.instrId);
    if (displayOptions.target?.kind === 'session') detail.items = [];
    for (const item of detail.items) {
      item.text = retainedText.get(item) ?? (displayOptions.target?.instrId === item.id ? targetText : '') ?? '';
      if (item.equiv_count === undefined) item.equiv_count = items.filter(value => value.fp === item.fp).length;
    }
  }
  // Spec §1.4/§4: sanitize only retained output candidates; deletion rescans retain every instruction.
  detail.items = displayExcluded ? [] : detail.items.map(finalizeRetainedInstruction);
  if (cwd.length > 4096) {
    cwd = null;
    providerCoverage.records_unverified++;
  }
  return {
    provider: retainString(provider, 32),
    sid: retainString(sessionId, 64),
    cwd: retainString(cwd, 4096),
    branch: !displayExcluded && typeof branch === 'string'
      ? retainString(snapshotPolicy.finalizeLabel(branch).value, 64) : null,
    run_mode: retainString(run_mode, 32),
    title: displayExcluded || title === null ? null : retainString(snapshotPolicy.finalizeText(title, 200).value, 200),
    ...detail,
    link_text: linkState.summary || null,
    unknown,
    first: retainString(first || 'unknown', 32),
    compact: compact && !items.length,
    firstAt: retainString(firstTime, 24),
    lastAt: retainString(lastTime, 24)
  };
}

// Spec §1.4/§4: retain first plus recent instructions; confirmation still covers the whole file.
function boundSessionInstructions(items, config, providerCoverage, retainAllInstructions) {
  let sessionFingerprint = null;
  if (hasValidLocalKey(config)) {
    const digest = crypto.createHmac('sha256', config.local_key);
    digest.update('["palantir.exclude-session/1",[');
    for (let index = 0; index < items.length; index++) {
      if (index) digest.update(',');
      digest.update(JSON.stringify([items[index].id, items[index].fp, items[index].ts]));
    }
    sessionFingerprint = digest.update(']]').digest('hex');
  }
  const counts = new Map();
  for (const item of items) {
    counts.set(item.fp, (counts.get(item.fp) || 0) + 1);
  }
  const retained = retainAllInstructions || items.length <= RECENT_INSTRUCTIONS + 1 ? items
    : [items[0], ...items.slice(-RECENT_INSTRUCTIONS)];
  const kept = new Set(retained);
  let discardedDeleted = 0;
  let discardedContent = 0;
  for (const [index, item] of items.entries()) {
    if (kept.has(item)) {
      item.equiv_count = counts.get(item.fp);
      if (retained !== items) {
        item.original_seq = index + 1;
      }
    } else if (config.exclude && isInstructionExcluded(config, item)) {
      discardedDeleted++;
      if (/:n\d+$/.test(item.id)) {
        discardedContent++;
      }
    }
  }
  providerCoverage.records_unverified += items.length - retained.length;
  return { items: retained, instructionCount: items.length,
    sessionFingerprint: retainString(sessionFingerprint, 64), discardedDeleted, discardedContent };
}

// Spec §2.1: sanitize the complete instruction before truncating its display.
function finalizeInstructionText(rawText) {
  const finalized = snapshotPolicy.finalizeText(rawText);
  return { text: retainString(finalized.value, 2000), text_missing: !rawText, truncated: rawText.length > 2000,
    redacted: finalized.redacted };
}

function finalizeRetainedInstruction(instruction) {
  return { ...instruction, ...finalizeInstructionText(instruction.text) };
}

// Spec §2.2: compare producer forms using UTF-16 digests, lengths and bounded local prefixes.
function orcaWhitespace(c) {
  return c === 32 || c >= 9 && c <= 13 || c === 160 || c === 5760 || c >= 8192 && c <= 8202
    || [8232, 8233, 8239, 8287, 12288, 65279].includes(c);
}
function orcaPromptForm(raw) {
  let leading = 0;
  while (leading < Math.min(raw.length, 24576) && orcaWhitespace(raw.charCodeAt(leading))) leading++;
  if (raw.startsWith('You are working inside Orca, a multi-agent IDE.', leading)) return null;
  const n = Math.min(raw.length, 1664);
  let r = 0, value = '', line = false;
  while (r < n && orcaWhitespace(raw.charCodeAt(r))) r++;
  while (r < n && value.length < 200) {
    const c = raw.charCodeAt(r);
    if ([13, 10, 8232, 8233].includes(c)) {
      if (c === 13 && raw.charCodeAt(r + 1) === 10) r++;
      if (!line) value += ' ';
      line = true; r++; continue;
    }
    value += raw[r++]; line = false;
  }
  let truncated = value.length >= 200;
  if (r >= n && n < raw.length) {
    for (let rest = r; rest < raw.length; rest++) if (!orcaWhitespace(raw.charCodeAt(rest))) { truncated = true; break; }
  }
  if (value.length < 200) {
    let end = value.length;
    while (end && orcaWhitespace(value.charCodeAt(end - 1))) end--;
    value = value.slice(0, end);
  } else {
    const last = value.charCodeAt(value.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) { value = value.slice(0, -1); truncated = true; }
  }
  return { value, truncated };
}
function summarizeLinkText(rawText, agent = false) {
  const form = agent ? { value: rawText, truncated: false } : orcaPromptForm(rawText);
  if (!form) return null;
  return { hash: crypto.createHash('sha256').update(Buffer.from(form.value, 'utf16le')).digest('hex'),
    length: form.value.length, truncated: form.truncated,
    ...(agent ? { prefix_hashes: Array.from({ length: Math.min(form.value.length, 200) - Math.min(form.value.length, 23) },
      (_, index) => crypto.createHash('sha256').update(Buffer.from(form.value.slice(0, index + 24), 'utf16le')).digest('hex')) } : {}) };
}

// Spec §1.4/§2/§3: compute identity before discarding unbounded text and block structure.
function compactInstruction(config, instruction, linkState) {
  if (!linkState.last || compareRecordTimes(instruction, linkState.last) >= 0) {
    linkState.last = { ts: instruction.ts, position: instruction.position };
    linkState.summary = summarizeLinkText(instruction.text);
  }
  instruction.fp = computeInstructionFingerprint(config, instruction);
  const ref = computeInstructionRef(config, instruction);
  return {
    id: retainString(instruction.id, 160),
    ts: retainString(instruction.ts, 24),
    position: instruction.position,
    kind: retainString(instruction.kind, 32),
    text: instruction.text,
    attachments: instruction.attachments,
    unknown_blocks: instruction.unknown_blocks || 0,
    fp: retainString(instruction.fp, 64),
    ref: retainString(ref, 16)
  };
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
  if (provider === 'codex') {
    return records.find(record => record.type === 'session_meta')?.payload?.id;
  }
  return records.find(record => isIdentityComponent(record.sessionId))?.sessionId;
}

// Host R2 decision: group file identities only; metadata and messages never cross file boundaries.
function groupTranscriptFiles(groups, provider, file) {
  const sessionId = file.sessionId;
  if (file.sessionIds?.length > 1) {
    for (const sid of file.sessionIds) groupTranscriptFiles(groups, provider, { ...file, sessionId: sid, sessionIds: null });
    return;
  }
  const key = isIdentityComponent(sessionId) ? `${provider}:${sessionId}` : `${provider}:file:${file.file}`;
  let group = groups.get(key);
  if (!group) {
    group = { provider, sessionId, files: new Map() };
    groups.set(key, group);
  }
  // Spec §1.3: retain one compact result per file, never its original records.
  group.files.set(file.file, file);
}

function countDuplicateRecordIdentities(provider, records) {
  if (records.analysis) return records.analysis.duplicates;
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    let identity;
    if (provider === 'claude' && (record.type === 'user' || isHumanQueuedInstruction(record))) {
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
    checkMetadata(seen.size);
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
  displayOptions = {}) {
  let streamedSession;
  let streamedCoverage;
  if (records.lazy) {
    streamedCoverage = Object.fromEntries(Object.keys(providerCoverage).map(key => [key, 0]));
    streamedSession = parseFile(provider, records, streamedCoverage, config, retainAllInstructions, displayOptions);
  }
  // Host R5: a single file cannot assign instructions from multiple explicit session identities.
  const mixedSession = hasMixedSessionIdentities(provider, records);
  if (mixedSession) {
    providerCoverage.mixed_session_withheld++;
  }
  const duplicates = countDuplicateRecordIdentities(provider, records);
  let queuedDuplicate = false;
  if (records.analysis) {
    queuedDuplicate = records.analysis.queuedDuplicate;
    if (queuedDuplicate) providerCoverage.queued_duplicate_withheld++;
  } else if (provider === 'claude') {
    const userIds = new Set();
    for (const record of records) if (record.type === 'user') {
      for (const id of [record.uuid, record.source_uuid, record.delivery_id, record.message?.uuid,
        record.message?.source_uuid, record.message?.delivery_id]) if (typeof id === 'string') userIds.add(id);
      checkMetadata(userIds.size);
    }
    for (const record of records) if (isHumanQueuedInstruction(record)
      && [record.uuid, record.attachment.source_uuid, record.attachment.delivery_id].some(id => userIds.has(id))) queuedDuplicate = true;
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
  try {
    if (records.lazy) {
      session = streamedSession;
      for (const key of Object.keys(providerCoverage)) providerCoverage[key] += streamedCoverage[key];
    } else session = parseFile(provider, records, providerCoverage, config, retainAllInstructions,
      { ...displayOptions, withheld: displayOptions.withheld || mixedSession || queuedDuplicate || duplicates > 0 });
  } catch (error) {
    if (error.streamLimit) throw error;
    // Spec §1: malformed candidates cannot abort unrelated sessions.
    providerCoverage.files_failed++;
  }
  // Spec §1.3 / v11: defer group-dependent coverage until all file identities are known.
  return {
    session: mixedSession || queuedDuplicate || duplicates > 0 ? null : session,
    skipIfSingle: !session && duplicates === 0
  };
}

// Spec §1.4: identity reads retain only grouping fields, never message content.
function parseTranscriptIdentityRecord(line) {
  try {
    const record = JSON.parse(line);
    if (isRecordObject(record)) {
      return { type: record.type, sessionId: record.sessionId, cwd: record.cwd, payload: { id: record.payload?.id, cwd: record.payload?.cwd },
        isSidechain: record.isSidechain };
    }
  } catch {}
  return { __invalid: true };
}

function inspectTranscriptIdentity(provider, data, observation) {
  const records = data.split('\n').filter(value => value.trim()).map(parseTranscriptIdentityRecord);
  if (observation) for (const record of records) observeTranscriptIdentity(record, observation);
  const sessionId = transcriptSessionId(provider, records);
  const cwd = records.find(record => typeof record.cwd === 'string' || typeof record.payload?.cwd === 'string');
  const rawCwd = cwd?.cwd || cwd?.payload?.cwd;
  return { sessionId, cwdHash: typeof rawCwd === 'string' ? crypto.createHash('sha256').update(rawCwd).digest('hex') : null, singleSession: records.every(record => record.sessionId === sessionId),
    sidechainOnly: records.length > 0 && records.every(record => record.isSidechain === true) };
}

// Spec §1.4: use complete prefix records; unresolved identities fall back to one bounded full read.
function readTranscriptIdentity(provider, fileDescriptor, fileSize, verifySidechain, observation) {
  const prefix = Buffer.alloc(Math.min(fileSize, IDENTITY_PREFIX_BYTES));
  let bytesRead = 0;
  while (bytesRead < prefix.length) {
    const count = fs.readSync(fileDescriptor, prefix, bytesRead, prefix.length - bytesRead, bytesRead);
    if (count === 0) {
      break;
    }
    bytesRead += count;
  }
  const data = prefix.subarray(0, bytesRead);
  const completeFile = bytesRead < prefix.length || fileSize <= bytesRead;
  const completeEnd = completeFile ? bytesRead : data.lastIndexOf(10) + 1;
  const identity = inspectTranscriptIdentity(provider, data.subarray(0, completeEnd).toString('utf8'), observation);
  // A complete top-level header can precede an overlong message in the first line.
  // Accept only syntactically complete fields; quoted or nested commas are never boundaries.
  if (!isIdentityComponent(identity.sessionId) && !completeFile) {
    const prefixText = data.toString('utf8');
    let depth = 0, quoted = false, escaped = false, boundary = -1;
    for (let index = 0; index < prefixText.length; index++) {
      const character = prefixText[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') depth--;
      else if (character === ',' && depth === 1) boundary = index;
    }
    if (boundary > 0) {
      const header = inspectTranscriptIdentity(provider, prefixText.slice(0, boundary) + '}', observation);
      if (isIdentityComponent(header.sessionId)) {
        identity.sessionId = header.sessionId;
        identity.cwdHash = header.cwdHash;
        identity.sidechainOnly = false;
        identity.singleSession = false;
      }
    }
  }
  if (!completeFile && (!isIdentityComponent(identity.sessionId) || verifySidechain && identity.sidechainOnly)) {
    let sessionId, cwdHash = null, singleSession = true, sidechainOnly = true, count = 0;
    for (const record of transcriptRecords(fileDescriptor, observation)) {
      count++;
      const cwd = provider === 'claude' ? record.cwd : record.payload?.cwd;
      if (!cwdHash && typeof cwd === 'string') cwdHash = crypto.createHash('sha256').update(cwd).digest('hex');
      const id = provider === 'claude' ? record.sessionId : record.type === 'session_meta' ? record.payload?.id : undefined;
      if (!sessionId && isIdentityComponent(id)) sessionId = id;
      if (record.sessionId !== sessionId) singleSession = false;
      if (record.isSidechain !== true) sidechainOnly = false;
    }
    return { sessionId, cwdHash, singleSession, sidechainOnly: count > 0 && sidechainOnly };
  }
  return identity;
}

// Spec §1.4: preserved mtimes require a complete tail record to prove the file is outside the window.
function readTranscriptTailTime(fileDescriptor, fileSize) {
  const start = Math.max(0, fileSize - IDENTITY_PREFIX_BYTES);
  const buffer = Buffer.alloc(fileSize - start);
  let bytesRead = 0;
  while (bytesRead < buffer.length) {
    const count = fs.readSync(fileDescriptor, buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
    if (count === 0) {
      break;
    }
    bytesRead += count;
  }
  const data = buffer.subarray(0, bytesRead);
  const firstComplete = start === 0 ? 0 : data.indexOf(10) + 1;
  if (start > 0 && firstComplete === 0) {
    return null;
  }
  const lines = data.subarray(firstComplete).toString('utf8').split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const record = JSON.parse(lines[index]);
      return isRecordObject(record) ? toIsoTimestamp(record.timestamp) : null;
    } catch {}
  }
  return null;
}

function isTranscriptOutsideWindow(stats, fileDescriptor, windowSince) {
  if (stats.mtimeMs >= windowSince) {
    return false;
  }
  const tailTime = readTranscriptTailTime(fileDescriptor, stats.size);
  return tailTime !== null && Date.parse(tailTime) < windowSince;
}

// Spec §1.4: only the exact projects-relative layout can identify a sidechain transcript.
function claudeSubagentSessionId(provider, file, root) {
  if (provider !== 'claude' || !root) {
    return null;
  }
  const parts = path.relative(root, file).split(path.sep);
  const workflow = parts.length === 6 && parts[3] === 'workflows' && /^[A-Za-z0-9_-]+$/.test(parts[4]);
  return (parts.length === 4 || workflow) && parts[0] !== '..' && isIdentityComponent(parts[1])
    && parts[2] === 'subagents' && /^agent-.+\.jsonl$/.test(parts[parts.length - 1]) ? parts[1] : null;
}

// Spec §2: verify the enumerated inode before reading; only one file's records remain in scope.
function summarizeTranscriptFile(provider, file, providerCoverage, windowSince, config = {}, requestedTarget = null,
  scanContext = {}) {
  const retainedFile = retainString(file.file, 4096);
  const subagentSid = claudeSubagentSessionId(provider, file.file, file.root);
  const parts = file.root ? path.relative(file.root, file.file).split(path.sep) : [];
  const workflowJournal = provider === 'claude' && parts.length === 6 && parts[0] !== '..'
    && isIdentityComponent(parts[1]) && parts[2] === 'subagents' && parts[3] === 'workflows'
    && /^[A-Za-z0-9_-]+$/.test(parts[4]) && parts[5] === 'journal.jsonl';
  let fileDescriptor;
  let identity = {};
  const observation = { provider, sessionIds: new Set(), cwdHashes: new Set(), limited: true };
  try {
    fileDescriptor = fs.openSync(file.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStats = fs.fstatSync(fileDescriptor);
    if (openedStats.dev !== file.stats.dev || openedStats.ino !== file.stats.ino) {
      throw Error();
    }
    fs.fstatSync(fileDescriptor);
    observation.limited = openedStats.size > STREAM_LIMITS.smallFileBytes;
    if (workflowJournal) {
      let journalOnly = true;
      for (const record of transcriptRecords(fileDescriptor, observation)) {
        if (Object.hasOwn(record, 'sessionId') || !['launched', 'started', 'result'].includes(record.type)) { journalOnly = false; break; }
      }
      if (journalOnly) { providerCoverage.files_scanned++; providerCoverage.files_skipped++; return null; }
    }
    const outsideWindow = isTranscriptOutsideWindow(openedStats, fileDescriptor, windowSince);
    if (outsideWindow || requestedTarget) {
      identity = readTranscriptIdentity(provider, fileDescriptor, openedStats.size,
        subagentSid !== null, observation);

      if (subagentSid !== null && subagentSid === identity.sessionId && identity.sidechainOnly
        && identity.singleSession) {
        providerCoverage.files_scanned++;
        providerCoverage.files_skipped++;
        return null;
      }
      // Spec §4: inspect unrelated identities for grouping, retaining full details only for the requested session.
      if (outsideWindow || !matchesRequestedSession(requestedTarget, { provider, sid: identity.sessionId })) {
        providerCoverage.files_scanned++;
        return { file: retainedFile,
          sessionId: identity.sessionId?.length <= 64 ? retainString(identity.sessionId, 64) : null, outsideWindow };
      }
    }
    identity = readTranscriptIdentity(provider, fileDescriptor, openedStats.size, false, observation);
    const records = transcriptSource(fileDescriptor, provider, subagentSid !== null, observation);
    providerCoverage.files_scanned++;
    const sessionId = transcriptSessionId(provider, records);
    const sidechainOnly = !records.lazy && records.analysis.sidechainOnly && records.analysis.singleSession;
    if (subagentSid !== null && subagentSid === sessionId && sidechainOnly) {
      providerCoverage.files_skipped++;
      return null;
    }
    const parsed = parseIndependentTranscript(provider, records, providerCoverage, config, requestedTarget !== null,
      { readerOptions: scanContext.readerOptions, target: requestedTarget,
        withheld: scanContext.groups?.get(`${provider}:${sessionId}`)?.files.size > 0 });
    if (subagentSid !== null && subagentSid === sessionId && records.analysis.sidechainOnly && records.analysis.singleSession) {
      providerCoverage.files_skipped++;
      return null;
    }
    return { file: retainedFile, firstAt: records.analysis.firstTime, lastAt: records.analysis.lastTime,
      blocked: !parsed?.session && (records.analysis.invalidTime > 0 || records.analysis.duplicates > 0
        || records.analysis.mixed || records.analysis.queuedDuplicate),
      cwdHash: identity.cwdHash || observation.cwdHashes.values().next().value || null,
      cwdHashes: [...observation.cwdHashes], sessionIds: records.analysis.mixed ? [...observation.sessionIds] : null,
      sessionId: sessionId?.length <= 64 ? retainString(sessionId, 64) : null, ...parsed };
  } catch (error) {
    providerCoverage.files_failed++;
    if (error.streamLimit) providerCoverage.large_file_withheld++;
    if (observation.sessionIds.size > 1) providerCoverage.mixed_session_withheld++;
    if (error.streamLimit || observation.sessionIds.size || isIdentityComponent(identity.sessionId)) return {
      file: retainedFile, sessionId: observation.sessionIds.values().next().value || identity.sessionId || subagentSid,
      sessionIds: [...observation.sessionIds], blocked: true,
      cwdHash: observation.cwdHashes.values().next().value || identity.cwdHash || null,
      cwdHashes: [...observation.cwdHashes]
    };
    return null;
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }
}

// Spec §1.4: rank by last observation, keeping only the bounded number of detailed sessions.
function compareSessionFiles(left, right) {
  return right.session.lastAt.localeCompare(left.session.lastAt) || left.scanIndex - right.scanIndex;
}

function discardSessionDetails(file, details) {
  if (file.session) {
    const { provider, sid, firstAt, lastAt, link_text } = file.session;
    details.delete(`${provider}:${sid}`);
    file.session = { provider, sid, firstAt, lastAt, link_text };
    file.detailsDiscarded = true;
  }
}

// Spec §1.2/§1.4/§2: only output-eligible sessions consume detail slots.
function snapshotSessionExclusion(readerOptions, config, session, checkSchema = true) {
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

function matchesRequestedSession(target, session) {
  if (!target) {
    return true;
  }
  const [provider, sid] = target.kind === 'session'
    ? [target.provider, target.sessionId] : target.instrId.split(':');
  return session.provider === provider && session.sid === sid;
}

function retainScannedDetails(groups, details, provider, file, windowSince, readerOptions, requestedTarget) {
  const key = isIdentityComponent(file.sessionId) ? `${provider}:${file.sessionId}` : `${provider}:file:${file.file}`;
  const group = groups.get(key);
  if (group.files.size > 1 && isIdentityComponent(group.sessionId)) {
    for (const groupedFile of group.files.values()) {
      discardSessionDetails(groupedFile, details);
    }
    return;
  }
  if (!file.session) {
    return;
  }
  const last = Date.parse(file.session.lastAt);
  if (last < windowSince || last > +readerOptions.now || file.snapshotExclusion !== null
    || !matchesRequestedSession(requestedTarget, file.session)) {
    discardSessionDetails(file, details);
    return;
  }
  details.set(`${provider}:${file.session.sid}`, file);
  if (details.size > snapshotPolicy.SNAPSHOT_LIMITS.sessions) {
    const ranked = [...details.values()].sort(compareSessionFiles);
    discardSessionDetails(ranked[ranked.length - 1], details);
  }
}

// Spec §1.4: grouping can invalidate an earlier candidate; refill only final selected identities.
function restoreSelectedDetails(files, details, config, coverage, windowSince, readerOptions, requestedTarget) {
  const selected = new Set(files);
  for (const file of details.values()) {
    if (!selected.has(file)) {
      discardSessionDetails(file, details);
    }
  }
  const sessions = [];
  for (const file of files) {
    if (file.detailsDiscarded) {
      const provider = file.session.provider;
      const counters = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS[provider].map(key => [key, 0]));
      const restored = summarizeTranscriptFile(provider, file.source, counters, windowSince, config, requestedTarget,
        { readerOptions });
      if (!restored?.session || restored.session.sid !== file.session.sid
        || restored.session.lastAt !== file.session.lastAt || restored.session.firstAt !== file.session.firstAt
        || (!requestedTarget && snapshotSessionExclusion(readerOptions, config, restored.session) !== null)) {
        coverage[provider].files_failed++;
        file.blocked = true;
        continue;
      }
      file.session = restored.session;
      file.detailsDiscarded = false;
      details.set(`${provider}:${file.session.sid}`, file);
    }
    sessions.push(file.session);
  }
  return sessions;
}

function scanSessions(readerOptions, config, requestedTarget = null) {
  const coverage = {
    claude: Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(coverageKey => [coverageKey, 0])),
    codex: Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.codex.map(coverageKey => [coverageKey, 0])),
    orca: { state: 'unavailable', code: 'orca_unavailable' }
  };
  const groups = new Map();
  const scanContext = { readerOptions, groups };
  const details = new Map();
  const windowSince = +readerOptions.now - 14 * 86400000;
  let scanIndex = 0;
  const budget = { entries: 0, files: 0 };
  const roots = [
    ['claude', path.join(readerOptions.homeDir, '.claude', 'projects')],
    ['codex', path.join(readerOptions.homeDir, '.codex', 'sessions')]
  ];
  for (const [provider, root] of roots) {
    for (const file of listFiles(root, coverage[provider], budget)) {
      const summary = summarizeTranscriptFile(provider, file, coverage[provider],
        windowSince, config, requestedTarget, scanContext);
      if (summary) {
        if (summary.session) {
          summary.snapshotExclusion = requestedTarget ? null
            : snapshotSessionExclusion(readerOptions, config, summary.session);
          summary.cwdHash = typeof summary.session.cwd === 'string'
            ? crypto.createHash('sha256').update(summary.session.cwd).digest('hex') : null;
        }
        summary.scanIndex = scanIndex++;
        summary.source = { file: retainString(file.file, 4096), root: retainString(root, 4096),
          stats: { dev: file.stats.dev, ino: file.stats.ino } };
        groupTranscriptFiles(groups, provider, summary);
        retainScannedDetails(groups, details, provider, summary, windowSince, readerOptions, requestedTarget);
      }
    }
  }
  const parsedFiles = [];
  for (const group of groups.values()) {
    const providerCoverage = coverage[group.provider];
    const multiFile = isIdentityComponent(group.sessionId) && group.files.size > 1;
    if (multiFile) {
      providerCoverage.multi_file_withheld++;
    }
    for (const file of group.files.values()) {
      if (file.outsideWindow) {
        if (!multiFile && group.provider === 'claude') {
          providerCoverage.files_skipped++;
        }
        if (!multiFile && group.provider === 'codex' && config.invalidContentRuleSessions?.has(group.sessionId)) {
          providerCoverage.withheld_sessions++;
        }
        continue;
      }
      if (!multiFile && file.skipIfSingle && group.provider === 'claude') {
        providerCoverage.files_skipped++;
      }
      const session = multiFile ? null : file.session;
      if (session) {
        parsedFiles.push(file);
      }
    }
  }
  const linkCandidates = [];
  const blockedFiles = new Set();
  for (const group of groups.values()) for (const file of group.files.values()) {
    if ((file.blocked || group.files.size > 1) && !file.outsideWindow && file.cwdHash && !blockedFiles.has(file.file)) {
      blockedFiles.add(file.file);
      for (const cwdHash of file.cwdHashes?.length ? file.cwdHashes : [file.cwdHash])
        linkCandidates.push({ file, session: { provider: group.provider, cwdHash,
          cwd: null, link_text: null, blocked: true, firstAt: file.session?.firstAt || file.firstAt,
          lastAt: file.session?.lastAt || file.lastAt } });
    }
  }
  const selectedFiles = parsedFiles.filter(file => {
    const session = file.session;
    // Spec §2.2: excluded sessions still prevent a false unique pane match, without retaining text or paths.
    if (!requestedTarget && file.cwdHash) {
      const { provider, sid, firstAt, lastAt } = session;
      linkCandidates.push({ file, session: { provider, sid, firstAt, lastAt,
        cwd: null, link_text: session.link_text, cwdHash: file.cwdHash } });
    }
    if (session.provider === 'codex' && config.invalidContentRuleSessions?.has(session.sid)) {
      coverage.codex.withheld_sessions++;
      return false;
    }
    const inWindow = Date.parse(session.lastAt) >= +readerOptions.now - 14 * 86400000
      && Date.parse(session.lastAt) <= +readerOptions.now;
    if (!inWindow && session.provider === 'claude') {
      coverage.claude.files_skipped++;
    }
    if (!inWindow) {
      return false;
    }
    if (file.snapshotExclusion !== null) {
      if (file.snapshotExclusion !== 'cwd_unavailable') {
        coverage[session.provider][file.snapshotExclusion]++;
      }
      return false;
    }
    return matchesRequestedSession(requestedTarget, session);
  });
  if (selectedFiles.length > snapshotPolicy.SNAPSHOT_LIMITS.sessions) {
    selectedFiles.sort(compareSessionFiles);
    for (const file of selectedFiles.slice(snapshotPolicy.SNAPSHOT_LIMITS.sessions)) {
      coverage[file.session.provider].records_unverified++;
    }
    selectedFiles.length = snapshotPolicy.SNAPSHOT_LIMITS.sessions;
  }
  const all = restoreSelectedDetails(selectedFiles, details, config, coverage, windowSince, readerOptions,
    requestedTarget);
  const selected = new Set(selectedFiles.filter(file => all.includes(file.session)));
  for (const entry of linkCandidates) if (entry.file.blocked && entry.file.detailsDiscarded) Object.assign(entry.session, {
    blocked: true, link_text: null, firstAt: undefined, lastAt: undefined
  });
  return { all, coverage, linkCandidates: linkCandidates.filter(entry => !selected.has(entry.file))
    .map(entry => entry.session) };
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

// Spec §3: assemble only allowlisted session and instruction slots.
function buildSnapshotSession(config, parsedSession, key, kept) {
  return {
    key,
    provider: parsedSession.provider,
    run_mode: parsedSession.run_mode,
    session_id: parsedSession.sid,
    cwd_id: snapshotPolicy.opaquePath(config.path_salt, config.path_gen, parsedSession.cwd),
    path_gen: config.path_gen,
    repo_label: parsedSession.cwd ? snapshotPolicy.finalizeLabel(path.basename(parsedSession.cwd)).value : null,
    git_branch: typeof parsedSession.branch === 'string' ? snapshotPolicy.finalizeLabel(parsedSession.branch)
      .value : null,
    cli_version: retainString('unverified', 32),
    format_unverified: true,
    first_record_at: parsedSession.firstAt,
    last_record_at: parsedSession.lastAt,
    first_instruction: parsedSession.first,
    compact_only_history: parsedSession.compact,
    ai_title: parsedSession.title === null ? null : snapshotPolicy.finalizeText(parsedSession.title, 200).value,
    instruction_count: kept.length,
    instruction_total: parsedSession.instructionCount,
    unknown_count: parsedSession.unknown,
    orca_link: {
      evidence: 'none',
      confirmed: false,
      pane_key: null,
      terminal_handle: null
    }
  };
}

function buildSnapshotInstruction(instruction, key, index) {
  const display = instruction.redacted === undefined
    ? finalizeInstructionText(instruction.text) : instruction;
  return {
    id: instruction.id,
    session_key: key,
    seq: instruction.original_seq ?? index + 1,
    ts: instruction.ts,
    kind: instruction.kind,
    text: display.text,
    text_missing: display.text_missing,
    truncated: display.truncated,
    redacted: display.redacted,
    attachments: instruction.attachments,
    unknown_blocks: instruction.unknown_blocks || 0,
    ref: instruction.ref
  };
}

function buildSnapshotEnvelope(readerOptions, config, coverage, sessions, instructions, orca) {
  return {
    schema: snapshotPolicy.SNAPSHOT_SCHEMA,
    machine: {
      id: config.machine_id,
      label: config.machine_label
    },
    generated_at: readerOptions.now.toISOString(),
    window_since: new Date(+readerOptions.now - 14 * 86400000).toISOString(),
    reader_version: '1',
    reader_build: readerOptions.readerBuild,
    redaction_version: snapshotPolicy.REDACTION_VERSION,
    policy_version: snapshotPolicy.POLICY_VERSION,
    coverage,
    sessions,
    instructions,
    orca
  };
}

// Spec §3 / host R7: apply the shared byte limit per candidate, reserving envelope/link overhead.
function reserveOutputBytes(candidate, outputBudget) {
  const bytes = Buffer.byteLength(JSON.stringify(candidate));
  if (outputBudget.bytes + bytes > snapshotPolicy.SNAPSHOT_LIMITS.bytes - 256 * 1024) {
    return false;
  }
  outputBudget.bytes += bytes;
  return true;
}

function projectSnapshotInstructions(kept, key, remainingCount, providerCoverage, outputBudget) {
  const projected = [];
  for (const instruction of kept) {
    const candidate = buildSnapshotInstruction(instruction, key, projected.length);
    if (projected.length >= remainingCount || !snapshotPolicy.validateInstruction(candidate).ok
      || !reserveOutputBytes(candidate, outputBudget)) {
      providerCoverage.records_unverified++;
      continue;
    }
    projected.push(candidate);
  }
  return projected;
}

function runSnapshot(inputOptions) {
  const readerOptions = validateReaderOptions(inputOptions);
  const config = readerOptions.machineLabel === undefined
    ? readConfig(readerOptions) || loadConfig(readerOptions) : loadConfig(readerOptions);
  const {
    all,
    coverage,
    linkCandidates
  } = scanSessions(readerOptions, config);
  const sessions = [];
  const instructions = [];
  const outputBudget = { bytes: 0 };
  for (const parsedSession of all) {
    const providerCoverage = coverage[parsedSession.provider];
    if (sessions.length >= snapshotPolicy.SNAPSHOT_LIMITS.sessions) {
      providerCoverage.records_unverified++;
      continue;
    }
    providerCoverage.deleted_instructions += parsedSession.discardedDeleted;
    if (parsedSession.provider === 'codex') {
      providerCoverage.content_rule_excluded += parsedSession.discardedContent;
    }
    const kept = parsedSession.items.filter(instruction => {
      if (!isInstructionExcluded(config, instruction)) {
        return true;
      }
      providerCoverage.deleted_instructions++;
      if (/:n\d+$/.test(instruction.id)) {
        providerCoverage.content_rule_excluded++;
      }
      return false;
    });
    const key = `${config.machine_id}:${parsedSession.provider}:${parsedSession.sid}`;
    if (!safeId(key)) {
      providerCoverage.records_unverified++;
      continue;
    }
    const projectedInstructions = projectSnapshotInstructions(kept, key,
      snapshotPolicy.SNAPSHOT_LIMITS.instructions - instructions.length, providerCoverage, outputBudget);
    const session = buildSnapshotSession(config, parsedSession, key, projectedInstructions);
    if (!snapshotPolicy.validateSession(session).ok || !reserveOutputBytes(session, outputBudget)) {
      providerCoverage.records_unverified++;
      continue;
    }
    sessions.push(session);
    parsedSession.output = session;
    instructions.push(...projectedInstructions);
  }
  const orca = readOrca(readerOptions, config, [...all, ...linkCandidates], coverage, outputBudget);
  const result = buildSnapshotEnvelope(readerOptions, config, coverage, sessions, instructions, orca);
  if (!snapshotPolicy.validateSnapshot(result).ok) {
    fail('internal_error');
  }
  return result;
}

// Spec §2.2 / §2.3: project successful CLI envelopes; retain bare-array compatibility.
function parseOrcaResponse(response, collection) {
  if (Array.isArray(response)) {
    return { items: response, truncated: false };
  }
  if (!isRecordObject(response) || response.ok !== true || !isRecordObject(response.result)
    || !Array.isArray(response.result[collection])) {
    return null;
  }
  return { items: response.result[collection], truncated: response.result.truncated === true };
}

// Spec §2.1: Orca also uses epoch milliseconds; transcript TIME rules stay separate.
function toOrcaIsoTimestamp(value) {
  if (typeof value !== 'number') {
    return toIsoTimestamp(value);
  }
  const date = new Date(value);
  return Number.isFinite(value) && Number.isFinite(+date) ? toIsoTimestamp(date.toISOString()) : null;
}

function orcaTerminalPaneKey(terminal) {
  if (typeof terminal.tabId === 'string' && typeof terminal.leafId === 'string') {
    return `${terminal.tabId}:${terminal.leafId}`;
  }
  return terminal.tabId === undefined && terminal.leafId === undefined ? terminal.paneKey : null;
}

function readOrca(readerOptions, config, all, coverage, outputBudget) {
  const out = {
    worktrees: [],
    terminals: []
  };
  const run = readerOptions.runOrca || defaultRunOrca;
  let worktreeResponseData;
  let terminalResponseData;
  try {
    const worktreeResponse = run(['worktree', 'ps', '--json']);
    const terminalResponse = run(['terminal', 'list', '--json']);
    if (typeof worktreeResponse !== 'string' || typeof terminalResponse !== 'string') {
      return out;
    }
    worktreeResponseData = parseOrcaResponse(JSON.parse(worktreeResponse), 'worktrees');
    terminalResponseData = parseOrcaResponse(JSON.parse(terminalResponse), 'terminals');
    if (!worktreeResponseData || !terminalResponseData) {
      return out;
    }
  } catch {
    return out;
  }
  coverage.orca = {
    state: 'ok',
    code: null
  };
  const worktrees = worktreeResponseData.items;
  const terminals = terminalResponseData.items;
  if (worktreeResponseData.truncated || terminalResponseData.truncated
    || worktrees.length > snapshotPolicy.SNAPSHOT_LIMITS.worktrees
    || terminals.length > snapshotPolicy.SNAPSHOT_LIMITS.terminals) {
    markOrcaPartial(coverage.orca);
  }
  const {
    agents,
    ids
  } = parseOrcaWorktrees(worktrees, config, out, coverage.orca, outputBudget);
  const globalPartial = coverage.orca.state !== 'ok';
  const edges = buildOrcaLinkCandidates(all, agents);
  applyOrcaLinks(all, edges);
  const terminalPartial = parseOrcaTerminals(terminals, edges, agents, ids, out, coverage.orca, outputBudget);
  // Spec §2.2: trusted terminal paths restrict cancellation; inventory failures remain global.
  for (const session of all) {
    if (!session.output) continue;
    const scopedPartial = session.cwdHash ? terminalPartial.cwdHashes.has(session.cwdHash)
      : terminalPartial.cwds.has(session.cwd);
    if (globalPartial || terminalPartial.global || scopedPartial) {
      session.output.orca_link.confirmed = false;
      session.output.orca_link.terminal_handle = null;
      if (!globalPartial && !terminalPartial.global && scopedPartial) {
        session.output.orca_link.evidence = 'ambiguous';
        session.output.orca_link.pane_key = null;
      }
    }
  }
  return out;
}

// Spec §2.1: Orca fields are projected into closed output slots; prompts stay local.
function mapOrcaEnum(key, value) {
  return snapshotPolicy.isSafeEnum(key, value) ? value : 'unknown';
}

function markOrcaPartial(orcaCoverage) {
  // Host R7: unavailable describes rejected source items while partial preserves valid siblings.
  orcaCoverage.state = 'partial';
  orcaCoverage.code = 'orca_unavailable';
}

function parseOrcaWorktrees(worktrees, config, out, orcaCoverage, outputBudget) {
  const agents = [];
  const ids = new Map();
  for (const worktree of worktrees.slice(0, snapshotPolicy.SNAPSHOT_LIMITS.worktrees)) {
    if (!isRecordObject(worktree)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const rawPath = worktree.path ?? worktree.worktreePath;
    if (typeof rawPath !== 'string') {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const rawId = worktree.worktreeId ?? worktree.id;
    if (typeof rawId !== 'string') {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const idPart = rawId.split('::')[0];
    const worktreeId = rawId.includes('::')
      ? `${idPart}::${snapshotPolicy.opaquePath(config.path_salt, config.path_gen, rawPath)}` : rawId;
    if (!safeId(worktreeId)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const when = toOrcaIsoTimestamp(worktree.lastActivityAt);
    if (!when) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const liveTerminals = worktree.liveTerminalCount === undefined
      ? (worktree.liveTerminals === undefined ? 0 : worktree.liveTerminals) : worktree.liveTerminalCount;
    if (!snapshotPolicy.isSafeInteger(liveTerminals)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    const exportedAgents = [];
    const localAgents = [];
    if (Object.hasOwn(worktree, 'agents') && !Array.isArray(worktree.agents)) {
      markOrcaPartial(orcaCoverage);
    }
    const sourceAgents = Array.isArray(worktree.agents) ? worktree.agents : [];
    if (sourceAgents.length > snapshotPolicy.SNAPSHOT_LIMITS.agents) {
      markOrcaPartial(orcaCoverage);
    }
    for (const agent of sourceAgents.slice(0, snapshotPolicy.SNAPSHOT_LIMITS.agents)) {
      if (!isRecordObject(agent)) {
        markOrcaPartial(orcaCoverage);
        continue;
      }
      const stateStartedAt = toOrcaIsoTimestamp(agent.stateStartedAt);
      const updatedAt = toOrcaIsoTimestamp(agent.updatedAt);
      if (!safeId(agent.paneKey) || !(stateStartedAt || updatedAt)) {
        markOrcaPartial(orcaCoverage);
        continue;
      }
      const projectedAgent = {
        pane_key: agent.paneKey,
        state: mapOrcaEnum('agent_state', agent.state),
        agent_type: mapOrcaEnum('agent_type', agent.agentType),
        state_started_at: stateStartedAt || updatedAt,
        updated_at: updatedAt || stateStartedAt,
        interrupted: agent.interrupted === true
      };
      if (!snapshotPolicy.validateOrcaAgent(projectedAgent).ok) {
        markOrcaPartial(orcaCoverage);
        continue;
      }
      exportedAgents.push(projectedAgent);
      localAgents.push({
        pane: agent.paneKey,
        prompt: summarizeLinkText(typeof agent.prompt === 'string' ? agent.prompt : '', true),
        provider: agent.agentType,
        cwd: rawPath,
        cwdHash: crypto.createHash('sha256').update(rawPath).digest('hex'),
        times: [stateStartedAt, updatedAt].filter(Boolean).map(Date.parse)
      });
    }
    const projectedWorktree = {
      worktree_id: worktreeId,
      repo_label: snapshotPolicy.finalizeLabel(typeof worktree.repoLabel === 'string' ? worktree.repoLabel
        : path.basename(rawPath)).value,
      path_id: snapshotPolicy.opaquePath(config.path_salt, config.path_gen, rawPath),
      branch: snapshotPolicy.finalizeLabel(typeof worktree.branch === 'string' ? worktree.branch : 'unknown').value,
      status: mapOrcaEnum('status', worktree.status),
      last_activity_at: when,
      live_terminals: liveTerminals,
      agents: exportedAgents
    };
    if (!snapshotPolicy.validateOrcaWorktree(projectedWorktree).ok
      || !reserveOutputBytes(projectedWorktree, outputBudget)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    agents.push(...localAgents);
    ids.set(rawId, worktreeId);
    out.worktrees.push(projectedWorktree);
  }
  return {
    agents,
    ids
  };
}


// Spec §2.2: exact/prefix thresholds and the [first, last + 10 minutes] window are independent evidence.
function buildOrcaLinkCandidates(all, agents) {
  const edges = [];
  for (const parsedSession of all) {
    const text = parsedSession.link_text;
    for (const agent of agents) {
      const sameCwd = parsedSession.cwdHash ? parsedSession.cwdHash === agent.cwdHash
        : parsedSession.cwd !== null && parsedSession.cwd === agent.cwd;
      if (!sameCwd) {
        continue;
      }
      let evidence = 'cwd_only';
      if (text && text.hash === agent.prompt.hash && text.length === agent.prompt.length) {
        if (text.truncated) evidence = 'prompt_trunc';
        else if (text.length >= 8) evidence = 'prompt_exact';
      }
      if (evidence === 'cwd_only' && text && !text.truncated && text.length >= 24 && text.length < agent.prompt.length
        && agent.prompt.prefix_hashes[text.length - 24] === text.hash) evidence = 'prompt_prefix';
      const inTime = agent.times.some(time => time >= Date.parse(parsedSession.firstAt)
        && time <= Date.parse(parsedSession.lastAt) + 600000);
      const eligible = ['prompt_exact', 'prompt_trunc'].includes(evidence) && inTime
        && agent.provider === parsedSession.provider;
      edges.push({
        session: parsedSession,
        agent,
        evidence,
        inTime, eligible
      });
    }
  }
  return edges;
}


function blockedTimeOverlaps(session, agent) {
  const first = Date.parse(session.firstAt), last = Date.parse(session.lastAt);
  return !Number.isFinite(first) || !Number.isFinite(last)
    || agent.times.some(time => time >= first && time <= last + 600000);
}

// Spec §2.2: uniqueness must hold from pane to session and session to pane.
function applyOrcaLinks(all, edges) {
  for (const parsedSession of all.filter(parsedSession => parsedSession.output)) {
    const sessionEdges = edges.filter(edge => edge.session === parsedSession);
    if (!sessionEdges.length) {
      continue;
    }
    const candidates = sessionEdges.filter(edge => edge.eligible);
    const edge = candidates[0] || sessionEdges[0];
    const ambiguous = candidates.length > 1 || (edge.eligible && edges.filter(value => value.eligible
      && value.agent.pane === edge.agent.pane).length > 1) || (edge.eligible && edges.some(other =>
        other.agent === edge.agent && other.session.blocked
        && (!other.session.provider || other.session.provider === edge.agent.provider)
        && blockedTimeOverlaps(other.session, edge.agent)));
    parsedSession.output.orca_link = {
      evidence: ambiguous ? 'ambiguous' : edge.evidence,
      confirmed: !ambiguous && edge.eligible,
      pane_key: ambiguous ? null : edge.agent.pane,
      terminal_handle: null
    };
  }
}


// Host R4/R6: project terminal fields without titles; only valid mapped worktrees are exported.
function parseOrcaTerminals(terminals, edges, agents, ids, out, orcaCoverage, outputBudget) {
  const partial = { global: false, cwds: new Set(), cwdHashes: new Set() };
  function rejectTerminal(terminal) {
    markOrcaPartial(orcaCoverage);
    const rawPath = terminal?.worktreePath;
    const rawId = terminal?.worktreeId;
    const separator = typeof rawId === 'string' ? rawId.indexOf('::') : -1;
    let scopedPath = null;
    if (typeof rawPath === 'string' && rawPath) {
      if (path.isAbsolute(rawPath) && (separator < 0 || rawId.slice(separator + 2) === rawPath)) {
        scopedPath = rawPath;
      }
    } else if ((rawPath === '' || rawPath === undefined) && separator >= 0
      && rawId.indexOf('::', separator + 2) < 0) {
      const idPath = rawId.slice(separator + 2);
      if (idPath && path.isAbsolute(idPath)) scopedPath = idPath;
    }
    if (!scopedPath || agents.some(agent => agent.pane === orcaTerminalPaneKey(terminal || {}))) {
      partial.global = true;
      return;
    }
    // The derived path restricts cancellation only; it is never link evidence or output.
    partial.cwds.add(scopedPath);
    partial.cwdHashes.add(crypto.createHash('sha256').update(scopedPath).digest('hex'));
  }
  for (const terminal of terminals.slice(0, snapshotPolicy.SNAPSHOT_LIMITS.terminals)) {
    if (!isRecordObject(terminal)) {
      rejectTerminal(terminal);
      continue;
    }
    if (!safeId(terminal.handle) || !ids.has(terminal.worktreeId) || !toOrcaIsoTimestamp(terminal.lastOutputAt)) {
      rejectTerminal(terminal);
      continue;
    }
    const paneKey = orcaTerminalPaneKey(terminal);
    const related = edges.filter(edge => edge.agent.pane === paneKey);
    const projectedTerminal = {
      handle: terminal.handle,
      worktree_id: ids.get(terminal.worktreeId),
      agent_identity: mapOrcaEnum('agent_type', terminal.agentIdentity),
      last_output_at: toOrcaIsoTimestamp(terminal.lastOutputAt),
      connected: terminal.connected === true
    };
    if (!snapshotPolicy.validateOrcaTerminal(projectedTerminal).ok) {
      rejectTerminal(terminal);
      continue;
    }
    if (!reserveOutputBytes(projectedTerminal, outputBudget)) {
      markOrcaPartial(orcaCoverage);
      partial.global = true;
      continue;
    }
    out.terminals.push(projectedTerminal);
    for (const edge of related) {
      if (edge.session.output?.orca_link.pane_key === paneKey) {
        edge.session.output.orca_link.terminal_handle = terminal.handle;
      }
    }
  }
  return partial;
}

function isValidExcludeTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return false;
  }
  const keys = target.kind === 'instruction'
    ? ['kind', 'instrId', 'ref']
    : target.kind === 'session'
      ? ['kind', 'provider', 'sessionId']
      : [];
  if (Object.keys(target).length !== keys.length || !keys.every(key => Object.hasOwn(target, key))) {
    return false;
  }
  if (target.kind === 'instruction') {
    return snapshotPolicy.isSafeInstructionId(target.instrId) && /^[0-9a-f]{16}$/.test(target.ref);
  }
  if (target.kind === 'session') {
    return snapshotPolicy.ENUMS.provider.includes(target.provider) && isIdentityComponent(target.sessionId);
  }
  return false;
}

function encodeExcludeTarget(target) {
  if (target.kind === 'instruction') {
    return snapshotPolicy.canonicalEncode(['instruction', target.instrId, target.ref]);
  }
  if (target.kind === 'session') {
    return snapshotPolicy.canonicalEncode(['session', target.provider, target.sessionId]);
  }
  fail('request_invalid');
}


// Spec §4: bind machine, operation, canonical target, build, current fingerprint, and timestamp.
function computeConfirmationToken(readerOptions, config, contentFingerprint, timestamp) {
  const encoded = snapshotPolicy.canonicalEncode(['palantir.exclude-confirm/1', config.machine_id, readerOptions
    .target.kind, encodeExcludeTarget(readerOptions.target), readerOptions.readerBuild, contentFingerprint, timestamp]);
  return computeHmac(config.local_key, encoded);
}

// Spec §2.1/§4: quoted multiline credentials must be redacted before deriving a first-line preview.
function instructionPreview(rawText) {
  const sanitizedText = snapshotPolicy.finalizeText(rawText).value;
  return snapshotPolicy.finalizeText(sanitizedText.split(/\r?\n/)[0], 200).value;
}

function resolveTarget(readerOptions, config, checkRef) {
  if (!isValidExcludeTarget(readerOptions.target)) {
    fail('request_invalid');
  }
  if (!hasValidLocalKey(config)) {
    fail('key_unavailable');
  }
  const {
    all
  } = scanSessions(readerOptions, config, readerOptions.target);
  const entry = readerOptions.target;
  let target;
  let timestamp = null;
  let preview = null;
  let count = 0;
  let contentFingerprint;
  let rule;
  if (entry.kind === 'instruction') {
    const parsedSession = all.find(parsedSession => parsedSession.items.some(instruction => instruction.id ===
      entry.instrId));
    const instruction = parsedSession?.items.find(instruction => instruction.id === entry.instrId);
    if (!instruction) {
      fail('target_not_found');
    }
    if (checkRef && instruction.ref !== entry.ref) {
      fail('target_changed');
    }
    target = instruction.id;
    timestamp = instruction.ts;
    preview = instructionPreview(instruction.text);
    count = /:n\d+$/.test(instruction.id) ? instruction.equiv_count : 1;
    contentFingerprint = instruction.fp;
    rule = {
      id: instruction.id,
      ...(/:n\d+$/.test(instruction.id) ? {
        fingerprint: instruction.fp,
        key_fingerprint: config.key_fingerprint
      } : {})
    };
  } else if (entry.kind === 'session') {
    const parsedSession = all.find(parsedSession => parsedSession.provider === entry.provider && parsedSession
      .sid === entry.sessionId);
    if (!parsedSession) {
      fail('target_not_found');
    }
    target = `session:${entry.provider}:${entry.sessionId}`;
    count = parsedSession.instructionCount;
    contentFingerprint = parsedSession.sessionFingerprint;
  }
  const token = computeConfirmationToken(readerOptions, config, contentFingerprint, timestamp);
  return {
    target,
    ts: timestamp,
    preview,
    count,
    token,
    rule
  };
}

function excludeQuery(inputOptions) {
  const readerOptions = validateReaderOptions(inputOptions);
  if (!isValidExcludeTarget(readerOptions.target)) {
    fail('request_invalid');
  }
  const config = readConfig(readerOptions);
  if (!config) {
    fail('key_unavailable');
  }
  const resolvedTarget = resolveTarget(readerOptions, config, true);
  const result = {
    schema: 'palantir.snapshot-exclude-preview/1',
    machine_id: config.machine_id,
    reader_build: readerOptions.readerBuild,
    op: readerOptions.target.kind,
    target: resolvedTarget.target,
    ts: resolvedTarget.ts,
    preview: resolvedTarget.preview,
    equiv_count: resolvedTarget.count,
    token: resolvedTarget.token
  };
  if (!snapshotPolicy.validateExcludePreview(result).ok) {
    fail('internal_error');
  }
  return result;
}

// Spec §2: rules only grow by union; never remove or overwrite a concurrent registration.
function unionExcludeRule(latest, target, resolvedTarget) {
  let changed = false;
  const entry = target;
  if (entry.kind === 'instruction') {
    if (!latest.exclude.instructions.some(value => JSON.stringify(value) === JSON.stringify(resolvedTarget.rule))) {
      latest.exclude.instructions.push(resolvedTarget.rule);
      changed = true;
    }
  } else {
    const value = `${entry.provider}:${entry.sessionId}`;
    if (!latest.exclude.sessions.includes(value)) {
      latest.exclude.sessions.push(value);
      changed = true;
    }
  }
  return changed;
}

function excludeCommit(inputOptions) {
  const readerOptions = validateReaderOptions(inputOptions);
  if (typeof readerOptions.token !== 'string' || !/^[0-9a-f]{64}$/.test(readerOptions.token)
    || !isValidExcludeTarget(readerOptions.target)) {
    fail('request_invalid');
  }
  const config = readConfig(readerOptions);
  if (!config || !hasValidLocalKey(config)) {
    fail('key_unavailable');
  }
  const status = (code, index = 0) => ({
    schema: 'palantir.snapshot-status/1',
    machine_id: config.machine_id,
    reader_build: readerOptions.readerBuild,
    code,
    counts: {
      registered: index
    }
  });
  let result;
  try {
    result = withConfigLock(readerOptions, () => {
      const latest = readConfig(readerOptions);
      if (!latest || !hasValidLocalKey(latest)) {
        fail('key_unavailable');
      }
      let resolvedTarget;
      try {
        resolvedTarget = resolveTarget(readerOptions, latest, false);
      } catch (error) {
        if (error.code === 'target_not_found') {
          return status('confirm_mismatch');
        }
        throw error;
      }
      if (latest.machine_id !== config.machine_id || latest.key_fingerprint !== config.key_fingerprint
        || resolvedTarget.token !== readerOptions.token) {
        return status('confirm_mismatch');
      }
      const changed = unionExcludeRule(latest, readerOptions.target, resolvedTarget);
      if (changed) {
        writeConfig(readerOptions, latest);
      }
      return status('ok', changed ? 1 : 0);
    });
  } catch (error) {
    if (error instanceof ReaderError) {
      throw error;
    }
    fail('internal_error');
  }
  if (!snapshotPolicy.validateStatusEnvelope(result).ok) {
    fail('internal_error');
  }
  return result;
}
module.exports = {
  ReaderError,
  runSnapshot,
  excludeQuery,
  excludeCommit,
  loadConfig,
  defaultRunOrca,
  STREAM_LIMITS,
  orcaPromptForm,
  MAX_FILES,
  MAX_FILE_BYTES
};
