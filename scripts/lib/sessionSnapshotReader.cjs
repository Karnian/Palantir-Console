'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const snapshotPolicy = require('../../server/services/observeSnapshotPolicy.js');
const MAX_FILES = 10000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const IDENTITY_PREFIX_BYTES = 64 * 1024;
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
const normalizeLinkText = value => value.normalize('NFC').replace(/\s+/g, ' ').trim();

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
          if (budget.files++ >= MAX_FILES || fileStats.size > MAX_FILE_BYTES) {
            providerCoverage.files_failed++;
            continue;
          }
          result.push({ file: filePath, stats: fileStats });
        }
      } catch {
        providerCoverage.files_failed++;
      }
    }
  }
  walk(root, 0);
  return result;
}

// Spec §1.1: first matching row wins; output and origin conflicts precede slash/shell wrappers.
function classifyClaudeRecord(record) {
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
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1] || text.match(
      /<command-message>([\s\S]*?)<\/command-message>/)?.[1] || '';
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || '';
    return {
      kind: 'slash',
      text: [name, args].filter(Boolean).join(' '),
      attachments
    };
  }
  if (shell) {
    return {
      kind: 'shell',
      text: text.match(/<bash-input>([\s\S]*?)<\/bash-input>/)?.[1] || '',
      attachments
    };
  }
  if (record.origin?.kind === 'human' || record.turnOrigin === 'human' || ['typed', 'queued',
    'suggestion_accepted'].includes(record.promptSource)) {
    return {
      kind: 'human',
      text: text.replace(/^<pasted>([\s\S]*?)<\/pasted>$/, '$1'),
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
  return (left.ts || '').localeCompare(right.ts || '') || left.position - right.position;
}

function parseFile(provider, records, providerCoverage) {
  // Spec §1.2/§1.4: parse a nonwithheld file in original order before timestamp display sorting.
  const ordered = records.map((record, position) => ({
    record,
    position,
    ts: toIsoTimestamp(record.timestamp)
  }));
  const times = ordered.map(value => value.ts).filter(Boolean).sort();
  if (!times.length) {
    // Host R9: absent timestamps do not withhold a file, but original user candidates remain unverified.
    providerCoverage.records_unverified += records.filter(record => record.__invalid
      || (provider === 'claude' ? record.type === 'user'
        : record.type === 'response_item' && record.payload?.type === 'message'
          && record.payload.role === 'user')).length;
    return null;
  }
  let sessionId;
  let cwd = '';
  let branch = null;
  let run_mode = 'interactive';
  let title = null;
  const items = [];
  let unknown = 0;
  let compact = false;
  let compactBefore = false;
  let first = null;
  let metaBefore = false;
  let userNo = 0;
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
  const byUuid = new Map(records.filter(record => record.uuid).map(record => [record.uuid, record]));
  for (const {
    record,
    ts: timestamp,
    position
  } of ordered) {
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
        const coverageKey = 'queued_' + ({
          enqueue: 'enqueued',
          dequeue: 'dequeued',
          remove: 'removed'
        }[record.operation] || record.operation);
        if (Object.hasOwn(providerCoverage, coverageKey)) {
          providerCoverage[coverageKey]++;
        }
        continue;
      }
      if (record.type === 'ai-title') {
        const entry = record.aiTitle ?? record.title;
        if (timestamp && typeof entry === 'string') {
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
      if (classification.unknown) {
        unknown++;
        continue;
      }
      if (!first) {
        first = compactBefore ? 'unrecoverable' : recoverClaudeFirstInstruction(record, byUuid);
      }
      if (!isIdentityComponent(record.uuid) || !timestamp || !snapshotPolicy.isSafeInstructionId(
        `claude:${sessionId}:u${record.uuid}`)) {
        providerCoverage.records_unverified++;
        continue;
      }
      items.push({
        ...classification,
        id: `claude:${sessionId}:u${record.uuid}`,
        ts: timestamp,
        position,
        structure: [['text', normalizeDeletionText(classification.text)], ['attachments', classification.attachments]]
      });
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
      items.push({
        ...classification,
        id: `codex:${sessionId}:${suffix}`,
        ts: timestamp,
        position,
        structure: [...classification.structure, ['attachments', classification.attachments]]
      });
    }
  }
  // Spec §1.2/§1.4: timestamp display ordering cannot alter n identities or recovery evidence.
  items.sort(compareRecordTimes);
  providerCoverage.records_unknown += unknown;
  return {
    provider,
    sid: sessionId,
    cwd,
    branch,
    run_mode,
    title,
    items,
    unknown,
    first: first || 'unknown',
    compact: compact && !items.length,
    firstAt: times[0],
    lastAt: times[times.length - 1]
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
  const seen = new Set();
  let duplicates = 0;
  for (const record of records) {
    let identity;
    if (provider === 'claude' && record.type === 'user') {
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
  }
  return duplicates;
}

function hasMixedSessionIdentities(provider, records) {
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
  return records.filter(record => Object.hasOwn(record, 'timestamp')
    && !snapshotPolicy.isSafeTimestamp(record.timestamp)).length;
}

function parseIndependentTranscript(provider, records, providerCoverage) {
  // Host R5: a single file cannot assign instructions from multiple explicit session identities.
  const mixedSession = hasMixedSessionIdentities(provider, records);
  if (mixedSession) {
    providerCoverage.mixed_session_withheld++;
  }
  const duplicates = countDuplicateRecordIdentities(provider, records);
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
    session = parseFile(provider, records, providerCoverage);
  } catch {
    // Spec §1: malformed candidates cannot abort unrelated sessions.
    providerCoverage.files_failed++;
  }
  // Spec §1.3 / v11: defer group-dependent coverage until all file identities are known.
  return {
    session: mixedSession || duplicates > 0 ? null : session,
    skipIfSingle: !session && duplicates === 0
  };
}

// Spec §1.4: identity reads retain only grouping fields, never message content.
function parseTranscriptIdentityRecord(line) {
  try {
    const record = JSON.parse(line);
    if (isRecordObject(record)) {
      return { type: record.type, sessionId: record.sessionId, payload: { id: record.payload?.id },
        isSidechain: record.isSidechain };
    }
  } catch {}
  return { __invalid: true };
}

function inspectTranscriptIdentity(provider, data) {
  const records = data.split('\n').filter(value => value.trim()).map(parseTranscriptIdentityRecord);
  return { sessionId: transcriptSessionId(provider, records),
    sidechainOnly: records.length > 0 && records.every(record => record.isSidechain === true) };
}

// Spec §1.4: use complete prefix records; unresolved identities fall back to one bounded full read.
function readTranscriptIdentity(provider, fileDescriptor, fileSize) {
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
  const identity = inspectTranscriptIdentity(provider, data.subarray(0, completeEnd).toString('utf8'));
  if (!isIdentityComponent(identity.sessionId) && !completeFile) {
    return inspectTranscriptIdentity(provider, readTranscriptData(fileDescriptor));
  }
  return identity;
}

function readTranscriptData(fileDescriptor) {
  const data = fs.readFileSync(fileDescriptor, 'utf8');
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) {
    throw Error();
  }
  return data;
}

// Spec §1.1 / §1.3: only a directory segment plus exclusively sidechain records proves a subagent file.
function isClaudeSubagentFile(provider, file, sidechainOnly) {
  return provider === 'claude' && path.dirname(file).split(path.sep).includes('subagents') && sidechainOnly;
}

// Spec §2: verify the enumerated inode before reading; only one file's records remain in scope.
function summarizeTranscriptFile(provider, file, providerCoverage, windowSince) {
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(file.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStats = fs.fstatSync(fileDescriptor);
    if (openedStats.dev !== file.stats.dev || openedStats.ino !== file.stats.ino
      || openedStats.size > MAX_FILE_BYTES) {
      throw Error();
    }
    if (file.stats.mtimeMs < windowSince) {
      const identity = readTranscriptIdentity(provider, fileDescriptor, openedStats.size);
      providerCoverage.files_scanned++;
      if (isClaudeSubagentFile(provider, file.file, identity.sidechainOnly)) {
        providerCoverage.files_skipped++;
        return null;
      }
      return { file: file.file, sessionId: identity.sessionId, outsideWindow: true };
    }
    const data = readTranscriptData(fileDescriptor);
    const records = data.split('\n').filter(value => value.trim()).map(parseTranscriptRecord);
    providerCoverage.files_scanned++;
    const sidechainOnly = records.length > 0 && records.every(record => record.isSidechain === true);
    if (isClaudeSubagentFile(provider, file.file, sidechainOnly)) {
      providerCoverage.files_skipped++;
      return null;
    }
    const sessionId = transcriptSessionId(provider, records);
    const parsed = parseIndependentTranscript(provider, records, providerCoverage);
    return { file: file.file, sessionId, ...parsed };
  } catch {
    providerCoverage.files_failed++;
    return null;
  } finally {
    if (fileDescriptor !== undefined) {
      fs.closeSync(fileDescriptor);
    }
  }
}

function scanSessions(readerOptions, config) {
  const coverage = {
    claude: Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(coverageKey => [coverageKey, 0])),
    codex: Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.codex.map(coverageKey => [coverageKey, 0])),
    orca: { state: 'unavailable', code: 'orca_unavailable' }
  };
  const groups = new Map();
  const budget = { entries: 0, files: 0 };
  const roots = [
    ['claude', path.join(readerOptions.homeDir, '.claude', 'projects')],
    ['codex', path.join(readerOptions.homeDir, '.codex', 'sessions')]
  ];
  for (const [provider, root] of roots) {
    for (const file of listFiles(root, coverage[provider], budget)) {
      const summary = summarizeTranscriptFile(provider, file, coverage[provider],
        +readerOptions.now - 14 * 86400000);
      if (summary) {
        groupTranscriptFiles(groups, provider, summary);
      }
    }
  }
  const parsedSessions = [];
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
        parsedSessions.push(session);
      }
    }
  }
  const selectedSessions = parsedSessions.filter(session => {
    if (session.provider === 'codex' && config.invalidContentRuleSessions?.has(session.sid)) {
      coverage.codex.withheld_sessions++;
      return false;
    }
    const inWindow = Date.parse(session.lastAt) >= +readerOptions.now - 14 * 86400000
      && Date.parse(session.lastAt) <= +readerOptions.now;
    if (!inWindow && session.provider === 'claude') {
      coverage.claude.files_skipped++;
    }
    return inWindow;
  });
  for (const session of selectedSessions) {
    for (const instruction of session.items) {
      instruction.fp = computeInstructionFingerprint(config, instruction);
      instruction.ref = computeInstructionRef(config, instruction);
    }
  }
  return { all: selectedSessions, coverage };
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
    cli_version: 'unverified',
    format_unverified: true,
    first_record_at: parsedSession.firstAt,
    last_record_at: parsedSession.lastAt,
    first_instruction: parsedSession.first,
    compact_only_history: parsedSession.compact,
    ai_title: parsedSession.title === null ? null : snapshotPolicy.finalizeText(parsedSession.title, 200).value,
    instruction_count: kept.length,
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
  const finalizedText = snapshotPolicy.finalizeText(instruction.text);
  return {
    id: instruction.id,
    session_key: key,
    seq: index + 1,
    ts: instruction.ts,
    kind: instruction.kind,
    text: finalizedText.value,
    text_missing: !instruction.text,
    truncated: instruction.text.length > 2000,
    redacted: finalizedText.redacted,
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
    coverage
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
    if (parsedSession.run_mode === 'exec' && !readerOptions.includeExec) {
      providerCoverage.exec_sessions_excluded++;
      continue;
    }
    if (parsedSession.run_mode === 'subagent' || parsedSession.run_mode === 'unsupported') {
      providerCoverage[parsedSession.run_mode === 'subagent' ? 'subagent_excluded' : 'unsupported_sessions']++;
      continue;
    }
    if (isSessionExcluded(config, parsedSession)) {
      providerCoverage.excluded_sessions++;
      continue;
    }
    // Spec §2/§4 and host R6: content deletion and key withholding are scoped by provider and session.
    const rules = parsedSession.provider === 'codex' ? config.exclude.instructions.filter(record =>
      record.id.startsWith(`codex:${parsedSession.sid}:n`)) : [];
    if (!hasValidLocalKey(config) || rules.some(record => record.key_fingerprint !== config.key_fingerprint)) {
      if (parsedSession.provider === 'codex') {
        providerCoverage.withheld_sessions++;
      } else {
        providerCoverage.excluded_sessions++;
      }
      continue;
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
  const orca = readOrca(readerOptions, config, all, coverage, outputBudget);
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
  const edges = buildOrcaLinkCandidates(all, agents);
  applyOrcaLinks(all, edges);
  parseOrcaTerminals(terminals, edges, ids, out, coverage.orca, outputBudget);
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
        prompt: typeof agent.prompt === 'string' ? normalizeLinkText(agent.prompt) : '',
        cwd: rawPath,
        time: Date.parse(stateStartedAt || updatedAt)
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
    const last = parsedSession.items[parsedSession.items.length - 1];
    for (const agent of agents) {
      if (parsedSession.cwd !== agent.cwd) {
        continue;
      }
      const text = last ? normalizeLinkText(last.text) : '';
      let evidence = 'cwd_only';
      if (text && agent.prompt && text === agent.prompt && text.length >= 8) {
        evidence = 'prompt_exact';
      } else if (text && agent.prompt && (text.startsWith(agent.prompt) || agent.prompt.startsWith(text))
        && Math.min(text.length, agent.prompt.length) >= 24) {
        evidence = 'prompt_prefix';
      }
      const inTime = agent.time >= Date.parse(parsedSession.firstAt) && agent.time <= Date.parse(parsedSession
        .lastAt) + 600000;
      edges.push({
        session: parsedSession,
        agent,
        evidence,
        inTime
      });
    }
  }
  return edges;
}


// Spec §2.2: uniqueness must hold from pane to session and session to pane.
function applyOrcaLinks(all, edges) {
  for (const parsedSession of all.filter(parsedSession => parsedSession.output)) {
    const sessionEdges = edges.filter(edge => edge.session === parsedSession);
    if (!sessionEdges.length) {
      continue;
    }
    const edge = sessionEdges[0];
    const ambiguous = sessionEdges.length > 1 || edges.filter(value => value.agent.pane === edge.agent.pane).length > 1;
    parsedSession.output.orca_link = {
      evidence: ambiguous ? 'ambiguous' : edge.evidence,
      confirmed: !ambiguous && edge.evidence === 'prompt_exact' && edge.inTime,
      pane_key: ambiguous ? null : edge.agent.pane,
      terminal_handle: null
    };
  }
}


// Host R4/R6: project terminal fields without titles; only valid mapped worktrees are exported.
function parseOrcaTerminals(terminals, edges, ids, out, orcaCoverage, outputBudget) {
  for (const terminal of terminals.slice(0, snapshotPolicy.SNAPSHOT_LIMITS.terminals)) {
    if (!isRecordObject(terminal)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    if (!safeId(terminal.handle) || !ids.has(terminal.worktreeId) || !toOrcaIsoTimestamp(terminal.lastOutputAt)) {
      markOrcaPartial(orcaCoverage);
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
    if (!snapshotPolicy.validateOrcaTerminal(projectedTerminal).ok
      || !reserveOutputBytes(projectedTerminal, outputBudget)) {
      markOrcaPartial(orcaCoverage);
      continue;
    }
    out.terminals.push(projectedTerminal);
    for (const edge of related) {
      if (edge.session.output?.orca_link.pane_key === paneKey) {
        edge.session.output.orca_link.terminal_handle = terminal.handle;
      }
    }
  }
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
  } = scanSessions(readerOptions, config);
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
    count = /:n\d+$/.test(instruction.id) ? parsedSession.items.filter(otherInstruction => otherInstruction
      .fp === instruction.fp).length : 1;
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
    count = parsedSession.items.length;
    contentFingerprint = computeHmac(config.local_key, snapshotPolicy.canonicalEncode(
      ['palantir.exclude-session/1', parsedSession.items.map(instruction => [instruction.id, instruction.fp,
      instruction.ts])]));
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
  MAX_FILES,
  MAX_FILE_BYTES
};
