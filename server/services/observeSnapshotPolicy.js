'use strict';

const { redactSecrets, REDACTION_VERSION } = require('./memorySanitize');
const { createHmac } = require('node:crypto');
const SNAPSHOT_SCHEMA = 'palantir.session-snapshot/1';
const POLICY_VERSION = 1;
const INSTR_ID_RE = /^(claude|codex):[A-Za-z0-9_-]{1,64}:[uin][A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;
const READER_BUILD_RE = /^[0-9a-f]{16}$/;
const STATUS_CODES = Object.freeze(['ok', 'node_unsupported', 'config_busy', 'key_unavailable',
  'target_changed', 'confirm_mismatch', 'target_not_found', 'request_invalid', 'internal_error', 'orca_unavailable']);
const ENUMS = Object.freeze({
  provider: ['claude', 'codex'],
  run_mode: ['interactive', 'exec', 'subagent', 'unsupported'],
  kind: ['human', 'slash', 'shell', 'reply'],
  first_instruction: ['recoverable', 'unrecoverable', 'unknown'],
  evidence: ['prompt_exact', 'prompt_prefix', 'cwd_only', 'ambiguous', 'none'],
  state: ['ok', 'unavailable', 'partial'],
  agent_state: ['idle', 'running', 'busy', 'waiting', 'completed', 'error', 'stopped', 'unknown'],
  status: ['active', 'idle', 'archived', 'running', 'stopped', 'unknown'],
  agent_type: ['claude', 'codex', 'unknown'],
  cli_version: ['unverified'],
  reader_version: ['1']
});
const COVERAGE_KEYS = Object.freeze({
  claude: ['files_scanned', 'files_skipped', 'files_failed', 'records_unknown', 'records_unverified',
    'excluded_sessions', 'deleted_instructions', 'queued_enqueued', 'queued_dequeued', 'queued_removed',
    'multi_file_withheld', 'mixed_session_withheld', 'invalid_time_withheld'],
  codex: ['files_scanned', 'files_failed', 'exec_sessions_excluded', 'subagent_excluded',
    'unsupported_sessions', 'records_unknown', 'records_unverified', 'withheld_sessions',
    'content_rule_excluded', 'excluded_sessions', 'deleted_instructions',
    'multi_file_withheld', 'mixed_session_withheld', 'invalid_time_withheld']
});
const COUNT_KEYS = [...new Set([...COVERAGE_KEYS.claude, ...COVERAGE_KEYS.codex, 'registered', 'equiv_count'])];

// Spec §2.1: redact → slot conversion/truncation → redact; accept a fixed point within three passes.
function finalize(inputValue, max, labelSlot, redactor = redactSecrets) {
  let value = inputValue == null ? '' : String(inputValue);
  let redacted = false;
  for (let index = 0; index < 3; index++) {
    const before = value;
    const firstRedaction = redactor(value);
    redacted ||= firstRedaction.redacted;
    value = (labelSlot ? firstRedaction.text.replace(/[^\p{L}\p{N}._/-]/gu, '_') : firstRedaction.text).slice(0, max);
    const lastRedaction = redactor(value);
    value = lastRedaction.text;
    redacted ||= lastRedaction.redacted;
    if (value === before) {
      return {
        value,
        redacted
      };
    }
  }
  return {
    value: labelSlot ? 'redacted' : '[redacted]',
    redacted: true
  };
}

function finalizeText(inputValue, max = 2000) {
  return finalize(inputValue, Number.isInteger(max) && max >= 10 && max <= 2000 ? max : 2000, false);
}

function finalizeLabel(inputValue) {
  return finalize(inputValue, 64, true);
}

// Spec §3/§4: arrays and a leading domain tag keep HMAC tuple boundaries unambiguous.
function canonicalEncode(array) {
  function valid(value) {
    return value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value ===
      'number' && Number.isSafeInteger(value) || Array.isArray(value) && value.every(valid);
  }
  if (!Array.isArray(array) || typeof array[0] !== 'string' || !valid(array)) {
    throw new TypeError('request_invalid');
  }
  return JSON.stringify(array);
}
function opaquePath(salt, generation, rawPath) {
  const digest = createHmac('sha256', salt).update(rawPath).digest('hex');
  return `g${generation}-${digest.slice(0, 16)}`;
}
const integerSlot = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
const booleanSlot = value => typeof value === 'boolean';
const idSlot = value => typeof value === 'string' && ID_RE.test(value) && !redactSecrets(value).redacted;
const instructionIdSlot = value => typeof value === 'string' && INSTR_ID_RE.test(value) && !redactSecrets(value)
  .redacted;
const timeSlot = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const opaqueSlot = value => typeof value === 'string' && /^g\d{1,10}-[0-9a-f]{16}$/.test(value);
const enumSlot = key => value => ENUMS[key].includes(value);
const textSlot = max => value => typeof value === 'string' && value.length <= max && finalizeText(value, max)
  .value === value;
const labelSlot = value => typeof value === 'string' && value.length <= 64 && /^[\p{L}\p{N}._/-]*$/u.test(
  value) && finalizeLabel(value).value === value;
const nullable = predicate => value => value === null || predicate(value);
const literal = inputValue => value => value === inputValue;
const hexSlot = length => value => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
const countSlots = keys => Object.fromEntries(keys.map(key => [key, integerSlot]));
const linkSchema = {
  evidence: enumSlot('evidence'),
  confirmed: booleanSlot,
  pane_key: nullable(idSlot),
  terminal_handle: nullable(idSlot)
};
const sessionSchema = {
  key: idSlot,
  provider: enumSlot('provider'),
  run_mode: enumSlot('run_mode'),
  session_id: idSlot,
  cwd_id: opaqueSlot,
  path_gen: integerSlot,
  repo_label: nullable(labelSlot),
  git_branch: nullable(labelSlot),
  cli_version: enumSlot('cli_version'),
  format_unverified: booleanSlot,
  first_record_at: timeSlot,
  last_record_at: timeSlot,
  first_instruction: enumSlot('first_instruction'),
  compact_only_history: booleanSlot,
  ai_title: nullable(textSlot(200)),
  instruction_count: integerSlot,
  unknown_count: integerSlot,
  orca_link: linkSchema
};
const instructionSchema = {
  id: instructionIdSlot,
  session_key: idSlot,
  seq: integerSlot,
  ts: timeSlot,
  kind: enumSlot('kind'),
  text: textSlot(2000),
  text_missing: booleanSlot,
  truncated: booleanSlot,
  redacted: booleanSlot,
  attachments: integerSlot,
  unknown_blocks: integerSlot,
  ref: hexSlot(16)
};
const agentSchema = {
  pane_key: idSlot,
  state: enumSlot('agent_state'),
  agent_type: enumSlot('agent_type'),
  state_started_at: timeSlot,
  updated_at: timeSlot,
  interrupted: booleanSlot
};
const worktreeSchema = {
  worktree_id: idSlot,
  repo_label: labelSlot,
  path_id: opaqueSlot,
  branch: labelSlot,
  status: enumSlot('status'),
  last_activity_at: timeSlot,
  live_terminals: integerSlot,
  agents: [agentSchema, 1000]
};
const terminalSchema = {
  handle: idSlot,
  worktree_id: idSlot,
  agent_identity: enumSlot('agent_type'),
  last_output_at: timeSlot,
  connected: booleanSlot
};
const SNAPSHOT_LIMITS = Object.freeze({
  sessions: 300,
  instructions: 10000,
  worktrees: 1000,
  terminals: 2000,
  agents: 1000,
  bytes: 16 * 1024 * 1024
});
const snapshotSchema = {
  schema: literal(SNAPSHOT_SCHEMA),
  machine: {
    id: idSlot,
    label: value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(value) && labelSlot(value)
  },
  generated_at: timeSlot,
  window_since: timeSlot,
  reader_version: enumSlot('reader_version'),
  reader_build: hexSlot(16),
  redaction_version: value => integerSlot(value) && value >= REDACTION_VERSION,
  policy_version: value => integerSlot(value) && value >= POLICY_VERSION,
  coverage: {
    claude: countSlots(COVERAGE_KEYS.claude),
    codex: countSlots(COVERAGE_KEYS.codex),
    orca: {
      state: enumSlot('state'),
      code: nullable(value => STATUS_CODES.includes(value))
    }
  },
  sessions: [sessionSchema, SNAPSHOT_LIMITS.sessions],
  instructions: [instructionSchema, SNAPSHOT_LIMITS.instructions],
  orca: {
    worktrees: [worktreeSchema, SNAPSHOT_LIMITS.worktrees],
    terminals: [terminalSchema, SNAPSHOT_LIMITS.terminals]
  }
};

// Spec §3: recursively reject unknown keys rather than silently accepting extra data.
function validate(object, schema) {
  function walk(value, slotSchema, schemaPath) {
    if (typeof slotSchema === 'function') {
      if (!slotSchema(value)) {
        throw schemaPath;
      }
      return;
    }
    if (Array.isArray(slotSchema)) {
      if (!Array.isArray(value) || value.length > slotSchema[1]) {
        throw schemaPath;
      }
      value.forEach((inputValue, index) => walk(inputValue, slotSchema[0], `${schemaPath}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw schemaPath;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(slotSchema, key)) {
        throw `${schemaPath}.${key}`;
      }
    }
    for (const key of Object.keys(slotSchema)) {
      walk(value[key], slotSchema[key], `${schemaPath}.${key}`);
    }
  }
  try {
    walk(object, schema, '$');
    if (Buffer.byteLength(JSON.stringify(object)) > SNAPSHOT_LIMITS.bytes) {
      throw '$';
    }
    return {
      ok: true
    };
  } catch (path) {
    return {
      ok: false,
      code: 'request_invalid',
      path: typeof path === 'string' ? path : '$'
    };
  }
}

function validateSnapshot(object) {
  const validation = validate(object, snapshotSchema);
  if (!validation.ok) {
    return validation;
  }
  const keys = new Set(object.sessions.map(session => session.key));
  if (keys.size !== object.sessions.length || new Set(object.instructions.map(instruction => instruction.id))
    .size !== object.instructions.length || object.instructions.some(instruction => !keys.has(instruction
    .session_key))) {
    return {
      ok: false,
      code: 'request_invalid',
      path: '$.instructions'
    };
  }
  return validation;
}

function validateExcludePreview(object) {
  return validate(object, {
    schema: literal('palantir.snapshot-exclude-preview/1'),
    machine_id: idSlot,
    reader_build: hexSlot(16),
    op: value => ['instruction', 'session'].includes(value),
    target: value => typeof value === 'string' && (instructionIdSlot(value) || /^session:[A-Za-z0-9:_-]{1,128}$/
      .test(value) && !redactSecrets(value).redacted),
    ts: nullable(timeSlot),
    preview: nullable(textSlot(200)),
    equiv_count: integerSlot,
    token: hexSlot(64)
  });
}

function validateStatusEnvelope(object) {
  const schema = {
    schema: literal('palantir.snapshot-status/1'),
    machine_id: idSlot,
    reader_build: hexSlot(16),
    code: value => STATUS_CODES.includes(value),
    counts: value => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(
      ([key, count]) => COUNT_KEYS.includes(key) && integerSlot(count))
  };
  return validate(object, schema);
}
// Test-only seam for exercising nonconvergence; production entry points always use redactSecrets.
module.exports = {
  _finalizeWithRedactor: finalize,
  isSafeInteger: integerSlot,
  isSafeTimestamp: timeSlot,
  isSafeLabel: labelSlot,
  isSafeEnum: (key, value) => Object.hasOwn(ENUMS, key) && enumSlot(key)(value),
  validateSession: object => validate(object, sessionSchema),
  validateInstruction: object => validate(object, instructionSchema),
  validateOrcaWorktree: object => validate(object, worktreeSchema),
  validateOrcaAgent: object => validate(object, agentSchema),
  validateOrcaTerminal: object => validate(object, terminalSchema),
  SNAPSHOT_LIMITS,
  isSafeId: idSlot,
  isSafeInstructionId: instructionIdSlot,
  SNAPSHOT_SCHEMA,
  POLICY_VERSION,
  REDACTION_VERSION,
  INSTR_ID_RE,
  ID_RE,
  READER_BUILD_RE,
  STATUS_CODES,
  ENUMS,
  COVERAGE_KEYS,
  COUNT_KEYS,
  finalizeText,
  finalizeLabel,
  opaquePath,
  canonicalEncode,
  validateSnapshot,
  validateExcludePreview,
  validateStatusEnvelope
};
