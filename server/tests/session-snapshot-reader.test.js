'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const snapshotReader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const snapshotPolicy = require('../services/observeSnapshotPolicy');
const SNAPSHOT_TIME = new Date('2026-10-08T03:00:00.000Z');
const RECORD_TIMESTAMP = '2026-10-08T02:00:00.000Z';
const SECRET_SENTINEL = 'sk-ant-api03-' + 'Q'.repeat(80);
function createFixture(testContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-test-'));
  testContext.after(() => fs.rmSync(root, {
    recursive: true,
    force: true
  }));
  const readerOptions = {
    homeDir: path.join(root, 'home'),
    configDir: path.join(root, 'config'),
    now: SNAPSHOT_TIME,
    readerBuild: '0123456789abcdef',
    runOrca: () => null
  };
  fs.mkdirSync(readerOptions.homeDir);
  function writeTranscript(provider, name, rows) {
    const transcriptPath = path.join(readerOptions.homeDir, provider === 'claude' ? '.claude/projects'
      : '.codex/sessions', name + '.jsonl');
    fs.mkdirSync(path.dirname(transcriptPath), {
      recursive: true
    });
    fs.writeFileSync(transcriptPath, rows.map(record => JSON.stringify(record)).join('\n'));
    return transcriptPath;
  }
  return {
    options: readerOptions,
    root,
    file: writeTranscript,
    config: () => JSON.parse(fs.readFileSync(path.join(readerOptions.configDir, 'observe.json'), 'utf8')),
    save: config => fs.writeFileSync(path.join(readerOptions.configDir, 'observe.json'), JSON.stringify(config))
  };
}
const claudeUserRecord = (text, extra = {}) => ({
  type: 'user',
  sessionId: 's',
  uuid: 'u',
  parentUuid: null,
  timestamp: RECORD_TIMESTAMP,
  cwd: '/sensitive/repo',
  message: {
    content: text
  },
  origin: {
    kind: 'human'
  },
  ...extra
});
const codexSessionMeta = (extra = {}) => ({
  type: 'session_meta',
  timestamp: RECORD_TIMESTAMP,
  payload: {
    id: 's',
    cwd: '/sensitive/repo',
    source: 'cli',
    thread_source: 'user',
    ...extra
  }
});
const codexMessage = (text, extra = {}) => ({
  type: 'response_item',
  timestamp: RECORD_TIMESTAMP,
  payload: {
    type: 'message',
    role: 'user',
    content: [{
      type: 'input_text',
      text
    }],
    ...extra
  }
});
function instructionTarget(instruction) {
  return {
    kind: 'instruction',
    instrId: instruction.id,
    ref: instruction.ref
  };
}
function assertReaderError(operation, expectedCode) {
  assert.throws(operation, error => error instanceof snapshotReader.ReaderError && error.code === expectedCode);
}
function assertCwdTargetRejected(fixture, target) {
  const file = path.join(fixture.options.configDir, 'observe.json');
  const before = fs.readFileSync(file);
  const directoryBefore = fs.readdirSync(fixture.options.configDir).sort();
  assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options, target }), 'request_invalid');
  assertReaderError(() => snapshotReader.excludeCommit({
    ...fixture.options, target, token: '0'.repeat(64)
  }), 'request_invalid');
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(fixture.options.configDir).sort(), directoryBefore);
}

function assertLegacyCwdConfigRejected(fixture, prefixes) {
  const config = fixture.config();
  config.exclude.cwd_prefixes = prefixes;
  fixture.save(config);
  const file = path.join(fixture.options.configDir, 'observe.json');
  const before = fs.readFileSync(file);
  let returnedSnapshots = 0;
  assertReaderError(() => {
    snapshotReader.runSnapshot(fixture.options);
    returnedSnapshots++;
  }, 'request_invalid');
  assert.equal(returnedSnapshots, 0);
  assertReaderError(() => snapshotReader.loadConfig(fixture.options), 'request_invalid');
  const target = { kind: 'session', provider: 'claude', sessionId: 's' };
  assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options, target }), 'request_invalid');
  assertReaderError(() => snapshotReader.excludeCommit({
    ...fixture.options, target, token: '0'.repeat(64)
  }), 'request_invalid');
  assert.deepEqual(fs.readFileSync(file), before);
}

function registerInstructionExclusion(testFixture, instruction) {
  const excludeTarget = instructionTarget(instruction);
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: excludeTarget
  });
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  }).counts.registered, 1);
  return preview;
}
function orcaRunner(worktrees, terminals) {
  return args => JSON.stringify(args[0] === 'worktree' ? worktrees : terminals);
}
function orcaWorktree(prompt, pane = 'p', extra = {}) {
  return {
    worktreeId: 'w',
    path: '/sensitive/repo',
    branch: 'main',
    status: 'active',
    lastActivityAt: RECORD_TIMESTAMP,
    liveTerminals: 1,
    agents: [{
      paneKey: pane,
      prompt,
      state: 'running',
      agentType: 'claude',
      stateStartedAt: RECORD_TIMESTAMP,
      updatedAt: RECORD_TIMESTAMP,
      ...extra
    }]
  };
}
function orcaTerminal(extra = {}) {
  return {
    handle: 'h',
    worktreeId: 'w',
    paneKey: 'p',
    agentIdentity: 'claude',
    title: 'safe terminal title',
    lastOutputAt: RECORD_TIMESTAMP,
    connected: true,
    ...extra
  };
}
function assertTerminalTitleAbsent(snapshot, terminalIndex) {
  assert.equal(Object.hasOwn(snapshot.orca.terminals[terminalIndex], 'title'), false);
  for (const sentinel of [
    'safe terminal title', 'excluded old text', 'A original title', 'B original title',
    'safe preserved title', 'WITHHELD_TEXT', 'safe title before withholding'
  ]) {
    assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  }
}

function codexMetaWithoutCwd(extra = {}) {
  const record = codexSessionMeta(extra);
  delete record.payload.cwd;
  return record;
}

function installUnknownCwdTitleFixture(testFixture) {
  testFixture.file('claude', 'safe', [claudeUserRecord('abcdefgh', { sessionId: 'T' })]);
  testFixture.options.runOrca = orcaRunner([
    { ...orcaWorktree('WITHHELD_TEXT'), worktreeId: 'unknown', path: '/repo' },
    orcaWorktree('abcdefgh', 'safe-pane')
  ], [
    orcaTerminal({ worktreeId: 'unknown', handle: 'unknown', title: 'WITHHELD_TEXT' }),
    orcaTerminal({ paneKey: 'safe-pane', title: 'safe title before withholding' })
  ]);
}

test('Claude ordered decision table explicitly protects rows 4,6,7, queue and title', testContext => {
  const testFixture = createFixture(testContext);
  const cases = [claudeUserRecord('normal', {
    uuid: 'one'
  }), claudeUserRecord('all tools', {
    uuid: 'tools',
    message: {
      content: [{
        type: 'tool_result'
      }]
    }
  }), claudeUserRecord('meta', {
    uuid: 'meta',
    isMeta: true
  }), claudeUserRecord('<bash-stdout>' + SECRET_SENTINEL, {
    uuid: 'output',
    turnOrigin: 'human'
  }), claudeUserRecord('scheduled', {
    uuid: 'scheduled',
    turnOrigin: 'scheduled'
  }), claudeUserRecord('<command-name>/bad</command-name>', {
    uuid: 'conflict',
    origin: {
      kind: 'agent'
    }
  }), claudeUserRecord('<command-name>/good</command-name><command-args>arg</command-args>', {
    uuid: 'slash',
    origin: undefined
  }), claudeUserRecord('<command-name>/not-absent</command-name>', {
    uuid: 'originHuman'
  }), claudeUserRecord('<bash-input>echo safe</bash-input>', {
    uuid: 'shell'
  }), claudeUserRecord('<pasted>pasted safe</pasted>', {
    uuid: 'paste'
  }), claudeUserRecord('queued safe', {
    uuid: 'queued',
    origin: undefined,
    promptSource: 'queued'
  }), claudeUserRecord('unknown', {
    uuid: 'unknown',
    origin: undefined
  }), claudeUserRecord('', {
    uuid: 'image',
    message: {
      content: [{
        type: 'image'
      }]
    }
  }), {
    type: 'assistant',
    timestamp: RECORD_TIMESTAMP,
    message: {
      content: SECRET_SENTINEL
    }
  }, {
    type: 'queue-operation',
    timestamp: RECORD_TIMESTAMP,
    operation: 'enqueued'
  }, {
    type: 'queue-operation',
    timestamp: RECORD_TIMESTAMP,
    operation: 'dequeued'
  }, {
    type: 'queue-operation',
    timestamp: RECORD_TIMESTAMP,
    operation: 'removed'
  }, {
    type: 'ai-title',
    timestamp: RECORD_TIMESTAMP,
    aiTitle: SECRET_SENTINEL
  }];
  testFixture.file('claude', 'rows', cases);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 7);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), [
    'normal', '/good arg', '<command-name>/not-absent</command-name>',
    'echo safe', 'pasted safe', 'queued safe', ''
  ]);
  assert.equal(snapshot.instructions[2].kind, 'human');
  assert.equal(snapshot.instructions[6].attachments, 1);
  assert.equal(snapshot.instructions[6].text_missing, true);
  assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
  assert.equal(snapshot.coverage.claude.records_unknown, 2);
  assert.equal(snapshot.coverage.claude.queued_removed, 1);
  assert.equal(snapshot.coverage.claude.queued_enqueued, 1);
  assert.equal(snapshot.sessions[0].format_unverified, true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  assert.equal(JSON.stringify(snapshot).includes('/sensitive/repo'), false);
});
test('Codex blocks, source mode, id identity, replacement ignore and event unverified', testContext => {
  const testFixture = createFixture(testContext);
  const blocks = [{
    type: 'input_text',
    text: '<environment_context>' + SECRET_SENTINEL
  }, {
    type: 'input_text',
    text: '# AGENTS.md instructions ' + SECRET_SENTINEL
  }, {
    type: 'input_text',
    text: '<codex_internal_context>' + SECRET_SENTINEL
  }, {
    type: 'input_text',
    text: 'first'
  }, {
    type: 'input_text',
    text: '<unknown>' + SECRET_SENTINEL
  }, {
    type: 'input_text',
    text: '<send_user_message_question_reply>reply'
  }, {
    type: 'input_text',
    text: 'last'
  }, {
    type: 'input_image'
  }];
  testFixture.file('codex', 'interactive', [codexSessionMeta({
    originator: 'codex_exec'
  }), codexMessage('', {
    id: 'id1',
    content: blocks
  }), codexMessage('same'), codexMessage('same'), codexMessage('', {
    content: [{
      type: 'input_image'
    }]
  }), codexMessage('', {
    content: [{
      type: 'input_text',
      text: '<onlyunknown>' + SECRET_SENTINEL
    }]
  }), codexMessage('', {
    content: [{
      type: 'input_text',
      text: '<environment_context>' + SECRET_SENTINEL
    }]
  }), {
    type: 'compacted',
    timestamp: RECORD_TIMESTAMP,
    payload: {
      replacement_history: [codexMessage('duplicate', {
        id: 'id1'
      }).payload]
    }
  }, {
    type: 'event_msg',
    timestamp: RECORD_TIMESTAMP,
    payload: {
      type: 'user_message',
      message: SECRET_SENTINEL
    }
  }]);
  testFixture.file('codex', 'exec', [codexSessionMeta({
    id: 'exec',
    source: 'exec',
    originator: 'Codex Desktop'
  }), codexMessage('exec safe', {
    id: 'e'
  })]);
  testFixture.file('codex', 'sub', [codexSessionMeta({
    id: 'sub',
    source: {
      subagent: 'guardian_review'
    },
    thread_source: 'guardian_review'
  }), codexMessage(SECRET_SENTINEL)]);
  testFixture.file('codex', 'unsupported', [codexSessionMeta({
    id: 'voice',
    source: 'voice_chat'
  }), codexMessage(SECRET_SENTINEL)]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 4);
  assert.equal(snapshot.instructions[0].id, 'codex:s:iid1');
  assert.equal(snapshot.instructions[0].kind, 'reply');
  assert.equal(snapshot.instructions[0].text, 'first\n\n<send_user_message_question_reply>reply\n\nlast');
  assert.equal(snapshot.instructions[0].unknown_blocks, 1);
  assert.deepEqual(snapshot.instructions.slice(1).map(instruction => instruction.text), ['same', 'same', '']);
  assert.equal(snapshot.instructions[3].text_missing, true);
  assert.equal(snapshot.coverage.codex.exec_sessions_excluded, 1);
  assert.equal(snapshot.coverage.codex.subagent_excluded, 1);
  assert.equal(snapshot.coverage.codex.unsupported_sessions, 1);
  assert.equal(snapshot.coverage.codex.records_unknown, 2);
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  const included = snapshotReader.runSnapshot({
    ...testFixture.options,
    includeExec: true
  });
  assert.equal(included.instructions.length, 5);
  assert.equal(included.sessions.find(snapshot => snapshot.session_id === 'exec').run_mode, 'exec');
});
test('14 day selection reads whole file and first-instruction three states', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'old-first', [{
    type: 'last-prompt',
    timestamp: '2026-09-01T00:00:00.000Z'
  }, claudeUserRecord('old instruction', {
    timestamp: '2026-09-01T01:00:00.000Z'
  }), {
    type: 'assistant',
    timestamp: RECORD_TIMESTAMP
  }]);
  testFixture.file('claude', 'missing-parent', [claudeUserRecord('orphan', {
    sessionId: 'orphan',
    parentUuid: 'missing'
  })]);
  testFixture.file('claude', 'unknown', [claudeUserRecord('uncertain', {
    sessionId: 'uncertain',
    parentUuid: undefined
  })]);
  testFixture.file('claude', 'compact', [{
    type: 'user',
    isCompactSummary: true,
    timestamp: '2026-10-08T01:00:00.000Z'
  }, claudeUserRecord('after compact', {
    sessionId: 'compact'
  })]);
  testFixture.file('claude', 'resolved', [{
    type: 'assistant',
    uuid: 'parent',
    parentUuid: null,
    timestamp: '2026-10-08T01:00:00.000Z'
  }, claudeUserRecord('resolved chain', {
    sessionId: 'resolved',
    parentUuid: 'parent'
  })]);
  testFixture.file('claude', 'outside', [claudeUserRecord('too old', {
    sessionId: 'old',
    timestamp: '2026-09-01T00:00:00.000Z'
  })]);
  testFixture.file('codex', 'compact-only', [codexSessionMeta({
    id: 'co'
  }), {
    type: 'compacted',
    timestamp: RECORD_TIMESTAMP,
    payload: {
      replacement_history: [codexMessage(SECRET_SENTINEL).payload]
    }
  }]);
  testFixture.file('codex', 'compact-first', [codexSessionMeta({
    id: 'cf'
  }), {
    type: 'compacted',
    timestamp: RECORD_TIMESTAMP
  }, codexMessage('later safe')]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 6);
  assert.equal(snapshot.sessions.length, 7);
  assert.equal(snapshot.instructions[0].text, 'after compact');
  const states = Object.fromEntries(snapshot.sessions.map(candidate => [candidate.session_id, candidate
    .first_instruction]));
  assert.equal(states.s, 'recoverable');
  assert.equal(states.orphan, 'unrecoverable');
  assert.equal(states.uncertain, 'unknown');
  assert.equal(states.compact, 'unrecoverable');
  assert.equal(states.resolved, 'recoverable');
  assert.equal(states.cf, 'unrecoverable');
  assert.equal(states.co, 'unknown');
  assert.equal(snapshot.sessions.find(candidate => candidate.session_id === 'co').compact_only_history, true);
  assert.equal(snapshot.instructions.some(instruction => instruction.text === 'too old'), false);
});
test('recursive allowlist and every exported string slot is sanitized', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'secret', [claudeUserRecord('preserved safe ' + SECRET_SENTINEL, {
    gitBranch: SECRET_SENTINEL,
    cwd: '/private/' + SECRET_SENTINEL
  }), {
    type: 'ai-title',
    timestamp: RECORD_TIMESTAMP,
    aiTitle: SECRET_SENTINEL
  }]);
  testFixture.options.runOrca = args => JSON.stringify(args[0] === 'worktree' ? [{
    worktreeId: 'w::/private/' + SECRET_SENTINEL,
    path: '/private/' + SECRET_SENTINEL,
    repoLabel: SECRET_SENTINEL,
    branch: SECRET_SENTINEL,
    status: 'active',
    lastActivityAt: RECORD_TIMESTAMP,
    liveTerminals: 1,
    agents: [{
      paneKey: 'p',
      state: 'running',
      agentType: 'claude',
      stateStartedAt: RECORD_TIMESTAMP,
      updatedAt: RECORD_TIMESTAMP,
      prompt: 'preserved safe ' + SECRET_SENTINEL,
      displayName: SECRET_SENTINEL,
      toolInput: SECRET_SENTINEL
    }]
  }] : [{
    handle: 'h',
    worktreeId: 'w::/private/' + SECRET_SENTINEL,
    paneKey: 'p',
    agentIdentity: 'claude',
    title: SECRET_SENTINEL,
    lastOutputAt: RECORD_TIMESTAMP,
    connected: true,
    preview: SECRET_SENTINEL
  }]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.orca.worktrees.length, 1);
  assert.equal(snapshot.orca.terminals.length, 1);
  assert.deepEqual(snapshotPolicy.validateSnapshot(snapshot), {
    ok: true
  });
  assert.equal(snapshot.instructions[0].text, 'preserved safe [REDACTED]');
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  assert.equal(JSON.stringify(snapshot).includes('/private/'), false);
  const paths = [['machine'], ['coverage', 'orca'], ['sessions', 0], ['instructions', 0], ['orca', 'worktrees',
    0], ['orca', 'worktrees', 0, 'agents', 0], ['orca', 'terminals', 0]];
  for (const keys of paths) {
    const candidate = JSON.parse(JSON.stringify(snapshot));
    let slotValue = candidate;
    for (const key of keys) {
      slotValue = slotValue[key];
    }
    slotValue.prompt = SECRET_SENTINEL;
    assert.equal(snapshotPolicy.validateSnapshot(candidate).ok, false);
  }
  for (const [field, value] of [['id', 'bad/path'], ['ref', 'A'.repeat(16)], ['text', SECRET_SENTINEL],
    ['attachments', -1]]) {
    const candidate = JSON.parse(JSON.stringify(snapshot));
    candidate.instructions[0][field] = value;
    assert.equal(snapshotPolicy.validateSnapshot(candidate).ok, false);
  }
  const candidate = JSON.parse(JSON.stringify(snapshot));
  candidate.sessions = Array(301).fill(snapshot.sessions[0]);
  assert.equal(snapshotPolicy.validateSnapshot(candidate).ok, false);
});
for (const [name, initial, del, rewrite, want] of [['R4', ['A', 'B', 'B'], 1, ['B', 'B'], []], ['R5', ['A',
  'B1', 'B2', 'B3'], 2, ['A', 'B2', 'B3'], ['A', 'B3']]]) {
  test('content deletion rewrite counterexample ' + name, testContext => {
    const testFixture = createFixture(testContext);
    let file = testFixture.file('codex', 'original', [codexSessionMeta(), ...initial.map(candidate =>
      codexMessage(candidate))]);
    const snapshot = snapshotReader.runSnapshot(testFixture.options);
    assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), initial);
    registerInstructionExclusion(testFixture, snapshot.instructions[del]);
    const snapshotAfterDeletion = snapshotReader.runSnapshot(testFixture.options);
    assert.deepEqual(snapshotAfterDeletion.instructions.map(instruction => instruction.text), initial.filter(
      candidate => candidate !== initial[del]));
    fs.renameSync(file, file + '.moved');
    testFixture.file('codex', 'renamed', [codexSessionMeta(), ...rewrite.map(candidate => codexMessage(candidate))]);
    let config = testFixture.config();
    config.path_salt = 'rotated';
    config.path_gen++;
    testFixture.save(config);
    assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
      .text), want);
    assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
      .text), want);
  });
}
test('normalization preserves internal spaces; equivalent attachment-only messages all deleted', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'spaces', [codexSessionMeta(), codexMessage('a  b'), codexMessage('a b'),
    codexMessage(' e\u0301 '), codexMessage('é'), codexMessage('', {
    content: [{
      type: 'input_image',
      image_url: 'one'
    }]
  }), codexMessage('', {
    content: [{
      type: 'input_image',
      image_url: 'different'
    }]
  })]);
  let snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 6);
  registerInstructionExclusion(testFixture, snapshot.instructions[0]);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['a b', ' e\u0301 ', 'é', '', '']);
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: instructionTarget(snapshot.instructions[2])
  });
  assert.equal(preview.equiv_count, 2);
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: instructionTarget(snapshot.instructions[2]),
    token: preview.token
  }).counts.registered, 1);
  const imagePreview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: instructionTarget(snapshot.instructions[4])
  });
  assert.equal(imagePreview.equiv_count, 2);
  snapshotReader.excludeCommit({
    ...testFixture.options,
    target: instructionTarget(snapshot.instructions[4]),
    token: imagePreview.token
  });
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['a b']);
});
test("query writes zero, old board n2 ref detects rewrite before query, confirmat"
  + "ion rechecks all bindings", testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'a', [codexSessionMeta(), codexMessage('A'), codexMessage('B'), codexMessage('C')]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['A', 'B', 'C']);
  const before = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  const excludeTarget = instructionTarget(snapshot.instructions[1]);
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: excludeTarget
  });
  assert.equal(preview.preview, 'B');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), before);
  testFixture.file('codex', 'a', [codexSessionMeta(), codexMessage('A'), codexMessage('C')]);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['A', 'C']);
  assertReaderError(() => snapshotReader.excludeQuery({
    ...testFixture.options,
    target: excludeTarget
  }), 'target_changed');
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  }).code, 'confirm_mismatch');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), before);
  testFixture.file('codex', 'a', [codexSessionMeta(), codexMessage('A'), codexMessage('B'), codexMessage('C')]);
  for (const extras of [{
    readerBuild: 'f'.repeat(16)
  }, {
    target: instructionTarget(snapshot.instructions[0])
  }]) {
    assert.equal(snapshotReader.excludeCommit({
      ...testFixture.options,
      target: excludeTarget,
      token: preview.token,
      ...extras
    }).code, 'confirm_mismatch');
    assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), before);
  }
  const config = testFixture.config();
  config.local_key = 'a'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  testFixture.save(config);
  const newBytes = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  }).code, 'confirm_mismatch');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), newBytes);
  fs.writeFileSync(path.join(testFixture.options.configDir, 'observe.json'), before);
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  }).counts.registered, 1);
  const registered = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  }).counts.registered, 0);
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), registered);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['A', 'C']);
});
test('O_EXCL lock contention, latest union A+B, permissions and key missing generates zero', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('A', {
    uuid: 'a'
  }), claudeUserRecord('B', {
    uuid: 'b'
  })]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['A', 'B']);
  assert.equal(fs.statSync(path.join(testFixture.options.configDir, 'observe.json')).mode & 0o777, 0o600);
  const finalized = instructionTarget(snapshot.instructions[0]);
  const secondTarget = instructionTarget(snapshot.instructions[1]);
  const firstPreview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: finalized
  });
  const secondPreview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: secondTarget
  });
  fs.writeFileSync(path.join(testFixture.options.configDir, 'observe.json.lock'), '');
  const before = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  assertReaderError(() => snapshotReader.excludeCommit({
    ...testFixture.options,
    target: finalized,
    token: firstPreview.token
  }), 'config_busy');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), before);
  fs.unlinkSync(path.join(testFixture.options.configDir, 'observe.json.lock'));
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: finalized,
    token: firstPreview.token
  }).counts.registered, 1);
  assert.equal(snapshotReader.excludeCommit({
    ...testFixture.options,
    target: secondTarget,
    token: secondPreview.token
  }).counts.registered, 1);
  assert.equal(testFixture.config().exclude.instructions.length, 2);
  const config = testFixture.config();
  delete config.local_key;
  testFixture.save(config);
  const broken = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  assertReaderError(() => snapshotReader.excludeQuery({
    ...testFixture.options,
    target: finalized
  }), 'key_unavailable');
  assertReaderError(() => snapshotReader.excludeCommit({
    ...testFixture.options,
    target: finalized,
    token: firstPreview.token
  }), 'key_unavailable');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), broken);
  assert.equal(Object.hasOwn(testFixture.config(), 'local_key'), false);
});
test('content-rule key mismatch/missing withholds affected session and preserves valid others', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'a', [codexSessionMeta(), codexMessage('A'), codexMessage('B')]);
  testFixture.file('codex', 'b', [codexSessionMeta({
    id: 'other'
  }), codexMessage('other preserved', {
    id: 'id'
  })]);
  let snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 3);
  registerInstructionExclusion(testFixture, snapshot.instructions.find(instruction => instruction.text === 'B'));
  const config = testFixture.config();
  config.exclude.instructions[0].key_fingerprint = '0'.repeat(64);
  testFixture.save(config);
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['other preserved']);
  assert.equal(snapshot.coverage.codex.withheld_sessions, 1);
  delete config.local_key;
  testFixture.save(config);
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.coverage.codex.withheld_sessions, 2);
  assert.equal(snapshot.instructions.length, 0);
});
test('stable Claude/Codex ids, session and cwd exclusion preserve exact other counts', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('claude kept', {
    uuid: 'a'
  }), claudeUserRecord('claude deleted', {
    uuid: 'b'
  })]);
  testFixture.file('codex', 'b', [codexSessionMeta({
    id: 'c',
    cwd: '/other/repo'
  }), codexMessage('codex kept', {
    id: 'a'
  }), codexMessage('codex deleted', {
    id: 'b'
  })]);
  let snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 4);
  registerInstructionExclusion(testFixture, snapshot.instructions.find(instruction => instruction.text ===
    'claude deleted'));
  registerInstructionExclusion(testFixture, snapshot.instructions.find(instruction => instruction.text ===
    'codex deleted'));
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['claude kept', 'codex kept']);
  const config = testFixture.config();
  config.path_gen++;
  config.path_salt = 'different';
  testFixture.save(config);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['claude kept', 'codex kept']);
  const instructionTarget = {
    kind: 'session',
    provider: 'claude',
    sessionId: 's'
  };
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: instructionTarget
  });
  assert.equal(preview.equiv_count, 2);
  snapshotReader.excludeCommit({
    ...testFixture.options,
    target: instructionTarget,
    token: preview.token
  });
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['codex kept']);
  const cwd = {
    kind: 'cwd',
    prefix: '/other'
  };
  const remaining = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(remaining.instructions.length, 1);
  assert.equal(remaining.instructions[0].text, 'codex kept');
  assertCwdTargetRejected(testFixture, cwd);
  assertLegacyCwdConfigRejected(testFixture, [cwd.prefix]);
});
test('Orca exact 8/prefix 24 boundaries, normalization, time window and both directions uniqueness', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('abcdefgh')]);
  testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh')], [orcaTerminal()]);
  let snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'abcdefgh');
  assert.equal(snapshot.orca.terminals.length, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
  for (const [text, prompt, evidence, confirmed] of [['abcdefg', 'abcdefg', 'cwd_only', false],
    ['abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx tail', 'prompt_prefix', false],
    ['abcdefghijklmnopqrstuvw', 'abcdefghijklmnopqrstuvw tail', 'cwd_only', false], ['abcdefgh', '',
    'cwd_only', false], ['one  two three', 'one two three', 'prompt_exact', true]]) {
    testFixture.file('claude', 'a', [claudeUserRecord(text)]);
    testFixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], [orcaTerminal()]);
    snapshot = snapshotReader.runSnapshot(testFixture.options);
    assert.equal(snapshot.instructions[0].text, text);
    assert.equal(snapshot.sessions[0].orca_link.evidence, evidence);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, confirmed);
  }
  testFixture.file('claude', 'a', [claudeUserRecord('abcdefgh')]);
  for (const [when, want] of [['2026-10-08T02:10:00.000Z', true], ['2026-10-08T02:10:00.001Z', false],
    ['2026-10-08T01:59:59.999Z', false]]) {
    testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh', 'p', {
      stateStartedAt: when
    })], [orcaTerminal()]);
    assert.equal(snapshotReader.runSnapshot(testFixture.options).sessions[0].orca_link.confirmed, want);
  }
  testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh')], [orcaTerminal()]);
  testFixture.file('claude', 'b', [claudeUserRecord('abcdefgh', {
    sessionId: 'two'
  })]);
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 2);
  assert.deepEqual(snapshot.sessions.map(snapshot => snapshot.orca_link.evidence), ['ambiguous', 'ambiguous']);
  fs.unlinkSync(path.join(testFixture.options.homeDir, '.claude/projects/b.jsonl'));
  const worktree = orcaWorktree('abcdefgh');
  worktree.agents.push({
    ...worktree.agents[0],
    paneKey: 'second'
  });
  testFixture.options.runOrca = orcaRunner([worktree], [orcaTerminal()]);
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  for (const run of [() => null, () => {
    throw Error(SECRET_SENTINEL);
  }, () => '{invalid', () => JSON.stringify({
    prompt: SECRET_SENTINEL
  })]) {
    snapshot = snapshotReader.runSnapshot({
      ...testFixture.options,
      runOrca: run
    });
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.coverage.orca.state, 'unavailable');
    assert.equal(snapshot.coverage.orca.code, 'orca_unavailable');
    assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  }
});
test("Orca title omission follows instruction/session deletion and cwd exclusi" + "on is rejected",
  testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('abcdefgh')]);
  testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh')], [orcaTerminal()]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.orca.terminals.length, 1);
  assertTerminalTitleAbsent(snapshot, 0);
  registerInstructionExclusion(testFixture, snapshot.instructions[0]);
  const deleted = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(deleted.orca.terminals.length, 1);
  assertTerminalTitleAbsent(deleted, 0);
  const excludeTarget = {
    kind: 'session',
    provider: 'claude',
    sessionId: 's'
  };
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: excludeTarget
  });
  snapshotReader.excludeCommit({
    ...testFixture.options,
    target: excludeTarget,
    token: preview.token
  });
  const sessionExcluded = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(sessionExcluded.orca.terminals.length, 1);
  assertTerminalTitleAbsent(sessionExcluded, 0);
  const cwd = {
    kind: 'cwd',
    prefix: '/sensitive'
  };
  assert.equal(sessionExcluded.orca.worktrees.length, 1);
  assertCwdTargetRejected(testFixture, cwd);
  const unchanged = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(unchanged.orca.worktrees.length, 1);
  assert.equal(unchanged.orca.terminals.length, 1);
  assertLegacyCwdConfigRejected(testFixture, [cwd.prefix]);
});
test('path boundary, symlink files/directories/ancestors, file byte/count bounds retain safe fixture', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'safe', [claudeUserRecord('safe retained')]);
  const external = path.join(testFixture.root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'hidden.jsonl'), JSON.stringify(claudeUserRecord(SECRET_SENTINEL, {
    sessionId: 'hidden'
  })));
  const dir = path.join(testFixture.options.homeDir, '.claude/projects');
  fs.symlinkSync(path.join(external, 'hidden.jsonl'), path.join(dir, 'linked.jsonl'));
  fs.symlinkSync(external, path.join(dir, 'linked-dir'));
  const large = path.join(dir, 'large.jsonl');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, snapshotReader.MAX_FILE_BYTES + 1);
  fs.mkdirSync(path.join(testFixture.options.homeDir, 'other'));
  fs.writeFileSync(path.join(testFixture.options.homeDir, 'other', 'outside.jsonl'), JSON.stringify(
    claudeUserRecord(SECRET_SENTINEL)));
  let snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['safe retained']);
  assert.equal(snapshot.coverage.claude.files_failed, 1);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  assertReaderError(() => snapshotReader.runSnapshot({
    ...testFixture.options,
    claudeDir: external
  }), 'request_invalid');
  fs.symlinkSync(external, path.join(testFixture.options.homeDir, '.codex'));
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['safe retained']);
  for (let iteration = 0; iteration < snapshotReader.MAX_FILES + 1; iteration++) {
    fs.writeFileSync(path.join(dir, `z-${String(iteration).padStart(5, '0')}.jsonl`), '');
  }
  snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['safe retained']);
  assert.ok(snapshot.coverage.claude.files_failed >= 2);
});
test('Claude every output wrapper outranks human, all meta flags and explicit nonhuman origin', testContext => {
  const testFixture = createFixture(testContext);
  const rows = [claudeUserRecord('same', {
    uuid: 'a'
  }), claudeUserRecord('same', {
    uuid: 'b'
  }), ...['task-notification', 'local-command-stdout', 'local-command-caveat', 'bash-stdout', 'bash-stderr']
    .map((tag, instruction) => claudeUserRecord(`<${tag}>${SECRET_SENTINEL}`, {
    uuid: 'out' + instruction,
    turnOrigin: 'human'
  })), ...['isMeta', 'isCompactSummary', 'isSidechain'].map((flag, instruction) => claudeUserRecord(SECRET_SENTINEL, {
    uuid: 'meta' + instruction,
    [flag]: true
  })), claudeUserRecord(SECRET_SENTINEL, {
    uuid: 'system',
    promptSource: 'system'
  }), claudeUserRecord(SECRET_SENTINEL, {
    uuid: 'nonhuman',
    origin: {
      kind: 'system'
    }
  }), claudeUserRecord('<bash-input>' + SECRET_SENTINEL + '</bash-input>', {
    uuid: 'conflict',
    origin: {
      kind: 'system'
    }
  })];
  testFixture.file('claude', 'a', rows);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['same', 'same']);
  assert.equal(snapshot.instructions.length, 2);
  assert.equal(snapshot.coverage.claude.records_unknown, 1);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
});
test('Codex vscode source and no meta produce recoverable/unknown; replacement does not increment n', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'vscode', [codexSessionMeta({
    source: 'vscode'
  }), codexMessage('first'), {
    type: 'compacted',
    timestamp: RECORD_TIMESTAMP,
    payload: {
      replacement_history: [codexMessage('first').payload]
    }
  }, codexMessage('second')]);
  testFixture.file('codex', 'unknown-first', [codexMessage('before meta'), codexSessionMeta({
    id: 'unknown'
  })]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 3);
  assert.deepEqual(snapshot.instructions.filter(instruction => instruction.id.startsWith('codex:s:')).map(
    instruction => instruction.id), ['codex:s:n1', 'codex:s:n2']);
  assert.equal(snapshot.sessions.find(candidate => candidate.session_id === 's').first_instruction, 'recoverable');
  assert.equal(snapshot.sessions.find(candidate => candidate.session_id === 'unknown').first_instruction, 'unknown');
});
test("query before first config exists creates nothing; first initialization lock"
  + " and explicit load key validation", testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('safe')]);
  assert.equal(fs.existsSync(testFixture.options.configDir), false);
  assertReaderError(() => snapshotReader.excludeQuery({
    ...testFixture.options,
    target: {
      kind: 'cwd',
      prefix: '/sensitive'
    }
  }), 'request_invalid');
  assert.equal(fs.existsSync(testFixture.options.configDir), false);
  fs.mkdirSync(testFixture.options.configDir);
  fs.writeFileSync(path.join(testFixture.options.configDir, 'observe.json.lock'), '');
  assertReaderError(() => snapshotReader.loadConfig(testFixture.options), 'config_busy');
  assert.equal(fs.existsSync(path.join(testFixture.options.configDir, 'observe.json')), false);
  fs.unlinkSync(path.join(testFixture.options.configDir, 'observe.json.lock'));
  assert.equal(snapshotReader.runSnapshot(testFixture.options).instructions[0].text, 'safe');
  const config = testFixture.config();
  config.key_fingerprint = 'bad';
  testFixture.save(config);
  const before = fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json'));
  assertReaderError(() => snapshotReader.loadConfig(testFixture.options), 'key_unavailable');
  assert.deepEqual(fs.readFileSync(path.join(testFixture.options.configDir, 'observe.json')), before);
});
test('structural string sentinels are rejected rather than exported or text-redacted', testContext => {
  const testFixture = createFixture(testContext);
  const secretId = 'ghp_' + 'Z'.repeat(36);
  testFixture.file('claude', 'safe', [claudeUserRecord('safe retained')]);
  testFixture.file('claude', 'bad-id', [claudeUserRecord('not exported', {
    sessionId: secretId
  })]);
  testFixture.file('codex', 'bad-id', [codexSessionMeta({
    id: 'cx'
  }), codexMessage('not exported', {
    id: secretId
  })]);
  testFixture.options.runOrca = orcaRunner([{
    ...orcaWorktree('abcdefgh'),
    worktreeId: secretId
  }], []);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'safe retained');
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(JSON.stringify(snapshot).includes(secretId), false);
  assert.equal(snapshot.orca.worktrees.length, 0);
});
test("reader uses exactly the two injected Orca calls, performs no process spawn "
  + "and query has zero writes", testContext => {
  const testFixture = createFixture(testContext);
  const calls = [];
  testFixture.file('claude', 'a', [claudeUserRecord('abcdefgh')]);
  testFixture.options.runOrca = args => {
    calls.push(args);
    return JSON.stringify(args[0] === 'worktree' ? [orcaWorktree('abcdefgh')] : [orcaTerminal()]);
  };
  const child = require('node:child_process');
  const saved = {};
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    saved[key] = child[key];
    child[key] = () => assert.fail('process spawn forbidden');
  }
  try {
    const snapshot = snapshotReader.runSnapshot(testFixture.options);
    assert.equal(snapshot.instructions[0].text, 'abcdefgh');
    assert.equal(snapshot.orca.terminals.length, 1);
    assert.deepEqual(calls, [['worktree', 'ps', '--json'], ['terminal', 'list', '--json']]);
    let writes = 0;
    const original = {};
    for (const key of ['writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'openSync']) {
      original[key] = fs[key];
      fs[key] = (...args) => {
        if (key !== 'openSync' || typeof args[1] === 'number' && args[1] & (fs.constants.O_WRONLY | fs.constants
          .O_RDWR | fs.constants.O_CREAT)) {
          writes++;
        }
        return original[key](...args);
      };
    }
    try {
      const preview = snapshotReader.excludeQuery({
        ...testFixture.options,
        target: instructionTarget(snapshot.instructions[0])
      });
      assert.equal(preview.preview, 'abcdefgh');
      assert.equal(preview.equiv_count, 1);
      assert.equal(writes, 0);
    } finally {
      Object.assign(fs, original);
    }
  } finally {
    Object.assign(child, saved);
  }
});
test("R5 identical B1/B2/B3 deletion survives B1 removal with different A/C prese"
  + "rved; key rotation withholds", testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'a', [codexSessionMeta(), ...['A', 'B', 'B', 'B', 'C'].map(candidate =>
    codexMessage(candidate))]);
  testFixture.file('codex', 'other', [codexSessionMeta({
    id: 'other'
  }), codexMessage('other safe', {
    id: 'id'
  })]);
  const initial = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(initial.instructions.map(instruction => instruction.text), ['A', 'B', 'B', 'B', 'C', 'other safe']);
  const preview = registerInstructionExclusion(testFixture, initial.instructions[2]);
  assert.equal(preview.equiv_count, 3);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['A', 'C', 'other safe']);
  testFixture.file('codex', 'a', [codexSessionMeta(), ...['A', 'B', 'B', 'C'].map(candidate => codexMessage(
    candidate))]);
  assert.deepEqual(snapshotReader.runSnapshot(testFixture.options).instructions.map(instruction => instruction
    .text), ['A', 'C', 'other safe']);
  const config = testFixture.config();
  config.local_key = 'b'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  testFixture.save(config);
  const rotated = snapshotReader.runSnapshot(testFixture.options);
  assert.deepEqual(rotated.instructions.map(instruction => instruction.text), ['other safe']);
  assert.equal(rotated.coverage.codex.withheld_sessions, 1);
});
test('R4 n3 deletion excludes both B copies after A removal and preserves other fingerprints', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('codex', 'rewrite', [codexSessionMeta(), codexMessage('A'), codexMessage('B'), codexMessage('B')]);
  testFixture.file('codex', 'preserved', [codexSessionMeta({
    id: 'preserved'
  }), codexMessage('different fingerprint', {
    id: 'preserved-message'
  })]);
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 4);
  assert.deepEqual(before.instructions.map(instruction => instruction.text), ['different fingerprint', 'A', 'B', 'B']);
  const secondB = before.instructions.find(instruction => instruction.id === 'codex:s:n3');
  assert.equal(secondB.text, 'B');
  const preview = registerInstructionExclusion(testFixture, secondB);
  assert.equal(preview.equiv_count, 2);
  testFixture.file('codex', 'rewrite', [codexSessionMeta(), codexMessage('B'), codexMessage('B')]);
  const after = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(after.instructions.length, 1);
  assert.deepEqual(after.instructions.map(instruction => instruction.text), ['different fingerprint']);
  assert.equal(after.sessions.find(session => session.session_id === 's').instruction_count, 0);
  assert.equal(after.coverage.codex.content_rule_excluded, 2);
  assert.equal(after.instructions.some(instruction => instruction.text === 'B'), false);
});
test("overlapping config updates reject the second writer, then retry unions both"
  + " without losing existing rules", testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'concurrent', [claudeUserRecord('existing', {
    uuid: 'existing'
  }), claudeUserRecord('A', {
    uuid: 'first'
  }), claudeUserRecord('B', {
    uuid: 'second'
  }), claudeUserRecord('preserved', {
    uuid: 'preserved'
  })]);
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 4);
  assert.deepEqual(before.instructions.map(instruction => instruction.text), ['existing', 'A', 'B', 'preserved']);
  registerInstructionExclusion(testFixture, before.instructions[0]);
  const existingRules = testFixture.config().exclude.instructions;
  assert.equal(existingRules.length, 1);
  assert.equal(existingRules[0].id, 'claude:s:uexisting');
  const firstTarget = instructionTarget(before.instructions[1]);
  const secondTarget = instructionTarget(before.instructions[2]);
  const firstPreview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: firstTarget
  });
  const secondPreview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: secondTarget
  });
  const secondRequest = {
    ...testFixture.options,
    target: secondTarget,
    token: secondPreview.token
  };
  const lockPath = path.join(testFixture.options.configDir, 'observe.json.lock');
  const configFile = path.join(testFixture.options.configDir, 'observe.json');
  const existingBytes = fs.readFileSync(configFile);
  const originalOpen = fs.openSync;
  let overlappingAttempts = 0;

  // Enter the second real update after the first O_EXCL open succeeds, before its callback runs (§2).
  fs.openSync = function openWithOverlappingUpdate(filePath, flags, ...remainingArguments) {
    const descriptor = originalOpen.call(fs, filePath, flags, ...remainingArguments);
    if (filePath === lockPath && flags & fs.constants.O_EXCL && overlappingAttempts === 0) {
      overlappingAttempts++;
      assert.equal(fs.existsSync(lockPath), true);
      assertReaderError(() => snapshotReader.excludeCommit(secondRequest), 'config_busy');
      assert.deepEqual(fs.readFileSync(configFile), existingBytes);
    }
    return descriptor;
  };
  let firstResult;
  try {
    firstResult = snapshotReader.excludeCommit({
      ...testFixture.options,
      target: firstTarget,
      token: firstPreview.token
    });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(firstResult.code, 'ok');
  assert.equal(firstResult.counts.registered, 1);
  assert.equal(overlappingAttempts, 1);
  assert.deepEqual(testFixture.config().exclude.instructions.map(rule => rule.id), ['claude:s:uexisting',
    'claude:s:ufirst']);
  assert.equal(fs.existsSync(lockPath), false);
  const retry = snapshotReader.excludeCommit(secondRequest);
  assert.equal(retry.code, 'ok');
  assert.equal(retry.counts.registered, 1);
  const finalRules = testFixture.config().exclude.instructions;
  assert.equal(finalRules.length, 3);
  assert.deepEqual(finalRules.map(rule => rule.id), ['claude:s:uexisting', 'claude:s:ufirst', 'claude:s:usecond']);
  assert.deepEqual(finalRules[0], existingRules[0]);
  const after = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(after.instructions.length, 1);
  assert.deepEqual(after.instructions.map(instruction => instruction.text), ['preserved']);
});

test('review 1 preview sanitizes complete multiline quoted secrets before choosing its first line', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'preview', [
    claudeUserRecord('safe preserved', { uuid: 'safe' }),
    claudeUserRecord('password="TOP_SECRET\nsecond line"', { uuid: 'secret' })
  ]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 2);
  assert.equal(snapshot.instructions[0].text, 'safe preserved');
  assert.equal(snapshot.instructions[1].text, '[REDACTED]');
  const preview = snapshotReader.excludeQuery({
    ...testFixture.options,
    target: instructionTarget(snapshot.instructions[1])
  });
  assert.equal(preview.equiv_count, 1);
  assert.equal(preview.preview, '[REDACTED]');
  assert.equal(JSON.stringify(preview).includes('TOP_SECRET'), false);
  assert.equal(JSON.stringify(preview).includes('second line'), false);
});

test('review 2 excluded old and missing transcripts cannot reexport Orca terminal titles', testContext => {
  const testFixture = createFixture(testContext);
  const oldFile = testFixture.file('claude', 'old', [
    claudeUserRecord('excluded old text', {
      sessionId: 'old',
      cwd: '/old/repo',
      timestamp: '2026-09-23T02:00:00.000Z'
    })
  ]);
  testFixture.file('claude', 'current', [claudeUserRecord('abcdefgh')]);
  const oldWorktree = {
    ...orcaWorktree('excluded old text'),
    worktreeId: 'old-worktree',
    path: '/old/repo'
  };
  oldWorktree.agents[0].paneKey = 'old-pane';
  testFixture.options.runOrca = orcaRunner(
    [orcaWorktree('abcdefgh'), oldWorktree],
    [orcaTerminal(), orcaTerminal({
      handle: 'old-terminal',
      worktreeId: 'old-worktree',
      paneKey: 'old-pane',
      title: 'excluded old text'
    })]
  );
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 1);
  assert.equal(before.instructions[0].text, 'abcdefgh');
  assert.equal(before.orca.terminals.length, 2);
  assertTerminalTitleAbsent(before, 0);
  const config = testFixture.config();
  config.exclude.sessions.push('claude:old');
  testFixture.save(config);
  const excluded = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(excluded.instructions.length, 1);
  assert.equal(excluded.orca.terminals.length, 2);
  assertTerminalTitleAbsent(excluded, 0);
  assertTerminalTitleAbsent(excluded, 1);
  fs.unlinkSync(oldFile);
  const missing = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(missing.instructions.length, 1);
  assert.equal(missing.orca.terminals.length, 2);
  assertTerminalTitleAbsent(missing, 0);
  assertTerminalTitleAbsent(missing, 1);
});

test('review 3 human-origin command wrapper falls through to human while absent origin remains slash', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'origin', [
    claudeUserRecord('safe preserved', { uuid: 'safe' }),
    claudeUserRecord('<command-name>/help</command-name>', { uuid: 'human' }),
    claudeUserRecord('<command-name>/help</command-name>', { uuid: 'slash', origin: undefined }),
    claudeUserRecord('<command-name>/help</command-name>', { uuid: 'system', origin: { kind: 'system' } })
  ]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions[0].text, 'safe preserved');
  assert.equal(snapshot.instructions.length, 3);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.kind), ['human', 'human', 'slash']);
  assert.equal(snapshot.instructions[1].text, '<command-name>/help</command-name>');
  assert.equal(snapshot.coverage.claude.records_unknown, 1);
});

test('review 4 multi-file sessions are withheld while single-file sessions remain intact', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('A', { uuid: 'a' })]);
  testFixture.file('claude', 'b', [claudeUserRecord('B', { uuid: 'b' })]);
  testFixture.file('claude', 'c', [claudeUserRecord('B', { uuid: 'c' })]);
  testFixture.file('codex', 'a', [codexSessionMeta(), codexMessage('C')]);
  testFixture.file('codex', 'b', [codexSessionMeta(), codexMessage('D')]);
  testFixture.file('claude', 'single', [claudeUserRecord('safe Claude', { sessionId: 'T' })]);
  testFixture.file('codex', 'single', [codexSessionMeta({ id: 'T' }), codexMessage('safe Codex')]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions[0].text, 'safe Claude');
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.instructions.length, 2);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['safe Claude', 'safe Codex']);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.id), ['claude:T:uu', 'codex:T:n1']);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.coverage.codex.multi_file_withheld, 1);
});

test('review 5 unsupported JSON values and null blocks preserve valid records and other files', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'invalid', [
    claudeUserRecord('A', { uuid: 'a' }), null, [], 42, 'unsupported',
    claudeUserRecord('B', { uuid: 'b', message: { content: [null, { type: 'text', text: 'B' }] } })
  ]);
  testFixture.file('claude', 'other', [claudeUserRecord('C', { sessionId: 'other' })]);
  testFixture.file('codex', 'null-block', [
    codexSessionMeta(),
    codexMessage('', { content: [null, { type: 'input_text', text: 'D' }] })
  ]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 4);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['A', 'B', 'C', 'D']);
  assert.equal(snapshot.coverage.claude.records_unverified, 5);
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshot.instructions[3].unknown_blocks, 1);
});

test('review 6 Codex original positions determine identity and recovery before display timestamp sorting',
  testContext => {
  const testFixture = createFixture(testContext);
  const first = codexMessage('A');
  first.timestamp = '2026-10-08T01:59:00.000Z';
  const second = codexMessage('B');
  second.timestamp = '2026-10-08T01:58:00.000Z';
  testFixture.file('codex', 'order', [codexSessionMeta(), first, second]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 2);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['B', 'A']);
  assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
  assert.equal(snapshot.instructions.find(instruction => instruction.text === 'A').id, 'codex:s:n1');
  assert.equal(snapshot.instructions.find(instruction => instruction.text === 'B').id, 'codex:s:n2');
  const instruction = snapshot.instructions.find(instruction => instruction.text === 'A');
  const preview = snapshotReader.excludeQuery({ ...testFixture.options, target: instructionTarget(instruction) });
  assert.equal(preview.preview, 'A');
});

test('review 7 cwd boundary fixtures reject cwd targets and fail closed on legacy rules', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'private', [claudeUserRecord('private', { cwd: '/work/private' })]);
  testFixture.file('claude', 'child', [
    claudeUserRecord('child', { sessionId: 'child', cwd: '/work/private/child' })
  ]);
  testFixture.file('claude', 'public', [
    claudeUserRecord('public', { sessionId: 'public', cwd: '/work/private-public' })
  ]);
  testFixture.options.runOrca = orcaRunner([
    { ...orcaWorktree('private'), path: '/work/private', worktreeId: 'private' },
    { ...orcaWorktree('public'), path: '/work/private-public', worktreeId: 'public' }
  ], [orcaTerminal({ worktreeId: 'private' }), orcaTerminal({ handle: 'public', worktreeId: 'public' })]);
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 3);
  assert.equal(before.orca.worktrees.length, 2);
  assert.equal(before.orca.terminals.length, 2);
  assert.deepEqual(before.instructions.map(instruction => instruction.text).sort(), ['child', 'private', 'public']);
  for (const prefix of ['/work/private', '/work/private/', '/']) {
    assertCwdTargetRejected(testFixture, { kind: 'cwd', prefix });
  }
  assertLegacyCwdConfigRejected(testFixture, ['/work/private/']);
});

test('review 9 commit unions a registration completed after initial read but before lock acquisition', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'latest', [
    claudeUserRecord('A', { uuid: 'a' }), claudeUserRecord('B', { uuid: 'b' }),
    claudeUserRecord('preserved', { uuid: 'preserved' })
  ]);
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 3);
  assert.deepEqual(before.instructions.map(instruction => instruction.text), ['A', 'B', 'preserved']);
  const firstTarget = instructionTarget(before.instructions[0]);
  const secondTarget = instructionTarget(before.instructions[1]);
  const firstPreview = snapshotReader.excludeQuery({ ...testFixture.options, target: firstTarget });
  const secondPreview = snapshotReader.excludeQuery({ ...testFixture.options, target: secondTarget });
  const lockPath = path.join(testFixture.options.configDir, 'observe.json.lock');
  const originalOpen = fs.openSync;
  let interveningCommits = 0;
  fs.openSync = function openAfterInterveningCommit(filePath, flags, ...remainingArguments) {
    if (filePath === lockPath && (flags & fs.constants.O_EXCL) && interveningCommits === 0) {
      interveningCommits++;
      const secondResult = snapshotReader.excludeCommit({
        ...testFixture.options, target: secondTarget, token: secondPreview.token
      });
      assert.equal(secondResult.counts.registered, 1);
      assert.deepEqual(testFixture.config().exclude.instructions.map(rule => rule.id), ['claude:s:ub']);
    }
    return originalOpen.call(fs, filePath, flags, ...remainingArguments);
  };
  let firstResult;
  try {
    firstResult = snapshotReader.excludeCommit({
      ...testFixture.options, target: firstTarget, token: firstPreview.token
    });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(firstResult.counts.registered, 1);
  assert.equal(interveningCommits, 1);
  assert.deepEqual(testFixture.config().exclude.instructions.map(rule => rule.id), ['claude:s:ub', 'claude:s:ua']);
  const after = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(after.instructions.length, 1);
  assert.equal(after.instructions[0].text, 'preserved');
});

test('review 2 unresolved exclusions omit titles even on a confirmed current terminal link', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'current', [claudeUserRecord('abcdefgh')]);
  testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh')], [orcaTerminal()]);
  const before = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(before.instructions.length, 1);
  assert.equal(before.instructions[0].text, 'abcdefgh');
  assert.equal(before.sessions[0].orca_link.confirmed, true);
  assert.equal(before.orca.terminals.length, 1);
  assertTerminalTitleAbsent(before, 0);
  const config = testFixture.config();
  config.exclude.sessions.push('claude:missing-original');
  testFixture.save(config);
  const after = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(after.instructions.length, 1);
  assert.equal(after.instructions[0].text, 'abcdefgh');
  assert.equal(after.orca.terminals.length, 1);
  assertTerminalTitleAbsent(after, 0);
});

test('R2 1 multi-file cwd conflicts withhold sessions and reject nonempty legacy cwd exclusions', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('A', { cwd: '/work/public', uuid: 'a' })]);
  testFixture.file('claude', 'b', [claudeUserRecord('B', { cwd: '/work/private', uuid: 'b' })]);
  testFixture.file('claude', 'single', [
    claudeUserRecord('T preserved', { sessionId: 'T', uuid: 't', cwd: '/work/other' })
  ]);
  snapshotReader.loadConfig(testFixture.options);
  for (const prefixes of [[], ['/work/private']]) {
    const config = testFixture.config();
    if (prefixes.length) {
      assertLegacyCwdConfigRejected(testFixture, prefixes);
      continue;
    }
    config.exclude.cwd_prefixes = prefixes;
    testFixture.save(config);
    const snapshot = snapshotReader.runSnapshot(testFixture.options);
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.instructions[0].text, 'T preserved');
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].session_id, 'T');
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
    assert.deepEqual(snapshotPolicy.validateSnapshot(snapshot), { ok: true });
    assert.equal(snapshot.instructions.some(instruction => instruction.id.startsWith('claude:s:')), false);
    assertReaderError(() => snapshotReader.excludeQuery({
      ...testFixture.options,
      target: { kind: 'instruction', instrId: 'claude:s:ua', ref: '0'.repeat(16) }
    }), 'target_not_found');
  }
});

test('R2 2 duplicate stable identities withhold only their own session without aborting collection', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'duplicates', [
    claudeUserRecord('A', { uuid: 'same' }), claudeUserRecord('B', { uuid: 'same' })
  ]);
  testFixture.file('codex', 'duplicates', [
    codexSessionMeta(), codexMessage('C', { id: 'same' }), codexMessage('D', { id: 'same' })
  ]);
  testFixture.file('claude', 'single', [claudeUserRecord('T preserved', { sessionId: 'T' })]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'T preserved');
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].session_id, 'T');
  assert.deepEqual(snapshotPolicy.validateSnapshot(snapshot), { ok: true });
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
  assert.equal(snapshot.coverage.codex.multi_file_withheld, 0);
});

test('R2 3 Codex files never share metadata recovery evidence or original message numbering', testContext => {
  const testFixture = createFixture(testContext);
  const metadataFile = testFixture.file('codex', 'a', [codexSessionMeta()]);
  testFixture.file('codex', 'b', [codexMessage('A'), codexSessionMeta()]);
  testFixture.file('codex', 'single', [
    codexSessionMeta({ id: 'T' }), codexMessage('T preserved')
  ]);
  const withheld = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(withheld.instructions.length, 1);
  assert.equal(withheld.instructions[0].text, 'T preserved');
  assert.equal(withheld.sessions.length, 1);
  assert.equal(withheld.coverage.codex.multi_file_withheld, 1);
  fs.unlinkSync(metadataFile);
  const singleFile = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(singleFile.instructions.length, 2);
  assert.deepEqual(singleFile.instructions.map(instruction => instruction.text), ['A', 'T preserved']);
  assert.equal(singleFile.sessions.find(session => session.session_id === 's').first_instruction, 'unknown');
  assert.equal(singleFile.instructions[0].id, 'codex:s:n1');
  assert.equal(singleFile.coverage.codex.multi_file_withheld, 0);
});

test('R2 4 withheld multi-file sessions omit terminal titles at every file cwd', testContext => {
  const testFixture = createFixture(testContext);
  testFixture.file('claude', 'a', [claudeUserRecord('A', { cwd: '/work/public', uuid: 'a' })]);
  testFixture.file('claude', 'b', [claudeUserRecord('B', { cwd: '/work/private', uuid: 'b' })]);
  testFixture.file('claude', 'single', [claudeUserRecord('abcdefgh', { sessionId: 'T' })]);
  testFixture.options.runOrca = orcaRunner([
    { ...orcaWorktree('A'), worktreeId: 'public', path: '/work/public' },
    { ...orcaWorktree('B'), worktreeId: 'private', path: '/work/private' },
    orcaWorktree('abcdefgh', 'safe-pane')
  ], [
    orcaTerminal({ worktreeId: 'public', handle: 'public', title: 'A original title' }),
    orcaTerminal({ worktreeId: 'private', handle: 'private', title: 'B original title' }),
    orcaTerminal({ paneKey: 'safe-pane', title: 'safe preserved title' })
  ]);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'abcdefgh');
  assert.equal(snapshot.orca.terminals.length, 3);
  assertTerminalTitleAbsent(snapshot, 2);
  assertTerminalTitleAbsent(snapshot, 0);
  assertTerminalTitleAbsent(snapshot, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
});

for (const reason of ['multi-file', 'duplicate-id', 'key-mismatch']) {
  test(`R3 unknown cwd ${reason} withholding omits all terminal titles`, testContext => {
    const testFixture = createFixture(testContext);
    installUnknownCwdTitleFixture(testFixture);
    const before = snapshotReader.runSnapshot(testFixture.options);
    assert.equal(before.instructions.length, 1);
    assert.equal(before.instructions[0].text, 'abcdefgh');
    assert.equal(before.orca.terminals.length, 2);
    assertTerminalTitleAbsent(before, 0);
    assertTerminalTitleAbsent(before, 1);
    if (reason === 'multi-file') {
      testFixture.file('codex', 'a', [codexMetaWithoutCwd(), codexMessage('A')]);
      testFixture.file('codex', 'b', [codexMetaWithoutCwd(), codexMessage('WITHHELD_TEXT')]);
    } else if (reason === 'duplicate-id') {
      testFixture.file('codex', 'a', [
        codexMetaWithoutCwd(),
        codexMessage('A', { id: 'same' }),
        codexMessage('WITHHELD_TEXT', { id: 'same' })
      ]);
    } else {
      testFixture.file('codex', 'a', [codexMetaWithoutCwd(), codexMessage('WITHHELD_TEXT')]);
      const original = snapshotReader.runSnapshot(testFixture.options);
      assert.equal(original.instructions.length, 2);
      registerInstructionExclusion(testFixture, original.instructions.find(instruction =>
        instruction.id === 'codex:s:n1'));
      const config = testFixture.config();
      config.exclude.instructions[0].key_fingerprint = '0'.repeat(64);
      testFixture.save(config);
    }
    const withheld = snapshotReader.runSnapshot(testFixture.options);
    assert.equal(withheld.instructions.length, 1);
    assert.equal(withheld.instructions[0].text, 'abcdefgh');
    assert.equal(withheld.sessions.length, 1);
    assert.equal(withheld.sessions[0].session_id, 'T');
    assert.equal(withheld.orca.terminals.length, 2);
    const coverageKey = reason === 'multi-file' ? 'multi_file_withheld'
      : reason === 'duplicate-id' ? 'records_unverified' : 'withheld_sessions';
    assert.equal(withheld.coverage.codex[coverageKey], 1);
    assertTerminalTitleAbsent(withheld, 0);
    assertTerminalTitleAbsent(withheld, 1);
    assert.equal(JSON.stringify(withheld).includes('WITHHELD_TEXT'), false);
  });
}

test('R3 independent file coverage equals the sum without cross-file identity or compact evidence', testContext => {
  const firstFixture = createFixture(testContext);
  const secondFixture = createFixture(testContext);
  const combinedFixture = createFixture(testContext);
  const firstRecords = [codexSessionMeta(), null, codexMessage('A', { id: 'shared' })];
  const secondRecords = [
    { type: 'compacted', timestamp: RECORD_TIMESTAMP, payload: { replacement_history: [] } },
    codexMessage('B', { id: 'shared' }),
    codexSessionMeta(),
    codexMessage('', { content: [{ type: 'input_text', text: '<unknown>local coverage' }] })
  ];
  firstFixture.file('codex', 'a', firstRecords);
  secondFixture.file('codex', 'b', secondRecords);
  combinedFixture.file('codex', 'a', firstRecords);
  combinedFixture.file('codex', 'b', secondRecords);
  combinedFixture.file('codex', 'safe', [codexSessionMeta({ id: 'T' }), codexMessage('T preserved')]);
  const first = snapshotReader.runSnapshot(firstFixture.options);
  const second = snapshotReader.runSnapshot(secondFixture.options);
  assert.equal(first.instructions.length, 1);
  assert.equal(first.instructions[0].text, 'A');
  assert.equal(first.sessions[0].first_instruction, 'recoverable');
  assert.equal(first.coverage.codex.records_unverified, 1);
  assert.equal(second.instructions.length, 1);
  assert.equal(second.instructions[0].text, 'B');
  assert.equal(second.sessions[0].first_instruction, 'unrecoverable');
  assert.equal(second.coverage.codex.records_unknown, 1);
  assert.equal(second.coverage.codex.records_unverified, 0);
  const combined = snapshotReader.runSnapshot(combinedFixture.options);
  assert.equal(combined.instructions.length, 1);
  assert.equal(combined.instructions[0].text, 'T preserved');
  assert.equal(combined.coverage.codex.multi_file_withheld, 1);
  for (const key of ['records_unverified', 'records_unknown', 'files_failed']) {
    assert.equal(combined.coverage.codex[key], first.coverage.codex[key] + second.coverage.codex[key]);
  }
  assert.equal(combined.coverage.codex.records_unverified, 1);
  assert.equal(combined.coverage.codex.records_unknown, 1);
});

test('R4 terminal titles are absent and rejected by the shared policy', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'safe', [claudeUserRecord('preserved instruction')]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('preserved instruction')], [
    orcaTerminal({ title: 'R4_PRIVATE_TITLE' })
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'preserved instruction');
  assert.equal(snapshot.orca.terminals.length, 1);
  assert.equal(snapshot.orca.terminals[0].handle, 'h');
  assert.deepEqual(snapshot.orca.terminals[0], {
    handle: 'h',
    worktree_id: 'w',
    agent_identity: 'claude',
    last_output_at: RECORD_TIMESTAMP,
    connected: true
  });
  const withTitle = structuredClone(snapshot);
  withTitle.orca.terminals[0].title = 'R4_PRIVATE_TITLE';
  assert.equal(snapshotPolicy.validateSnapshot(withTitle).ok, false);
  assert.equal(Object.hasOwn(snapshot.orca.terminals[0], 'title'), false);
  assert.equal(JSON.stringify(snapshot).includes('R4_PRIVATE_TITLE'), false);
});

for (const direction of ['real-prefix', 'alias-prefix']) {
  test(`R4 ${direction} alias fixture rejects cwd targets and legacy rules`, testContext => {
    const fixture = createFixture(testContext);
    const real = path.join(fixture.root, 'private', 'repo');
    const alias = path.join(fixture.root, 'alias', 'repo');
    fs.mkdirSync(path.join(real, 'child'), { recursive: true });
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(real, alias, 'dir');
    const prefix = direction === 'real-prefix' ? real : alias;
    const targetCwd = direction === 'real-prefix' ? alias : real;
    const boundaryCwd = real + '-public';
    fixture.file('claude', 'excluded', [claudeUserRecord('excluded', { cwd: targetCwd })]);
    fixture.file('claude', 'child', [claudeUserRecord('child', {
      cwd: path.join(targetCwd, 'child'), sessionId: 'child', uuid: 'child'
    })]);
    fixture.file('claude', 'safe', [claudeUserRecord('preserved', {
      cwd: boundaryCwd, sessionId: 'safe', uuid: 'safe'
    })]);
    fixture.options.runOrca = orcaRunner([
      { ...orcaWorktree('excluded'), path: targetCwd },
      { ...orcaWorktree('preserved', 'safe-pane'), worktreeId: 'safe-tree', path: boundaryCwd }
    ], [orcaTerminal(), orcaTerminal({ handle: 'safe-handle', worktreeId: 'safe-tree' })]);
    const before = snapshotReader.runSnapshot(fixture.options);
    assert.equal(before.instructions.length, 3);
    assert.deepEqual(before.instructions.map(instruction => instruction.text).sort(), [
      'child', 'excluded', 'preserved'
    ]);
    assert.equal(before.orca.worktrees.length, 2);
    assert.equal(before.orca.terminals.length, 2);
    const target = { kind: 'cwd', prefix: prefix + path.sep };
    assertCwdTargetRejected(fixture, target);
    assertLegacyCwdConfigRejected(fixture, [target.prefix]);
  });
}

test('R5 1 symlink parent traversal fixture rejects cwd targets and legacy rules', testContext => {
  const fixture = createFixture(testContext);
  const sensitive = path.join(fixture.root, 'sensitive');
  const base = path.join(fixture.root, 'base');
  fs.mkdirSync(path.join(sensitive, 'child'), { recursive: true });
  fs.mkdirSync(path.join(sensitive, 'repo'));
  fs.mkdirSync(base);
  fs.symlinkSync(path.join(sensitive, 'child'), path.join(base, 'link'), 'dir');
  const rawCwd = base + '/link/../repo';
  fixture.file('claude', 'excluded', [claudeUserRecord('PRIVATE_TEXT', { cwd: rawCwd })]);
  fixture.file('claude', 'safe', [claudeUserRecord('preserved', {
    sessionId: 'safe', cwd: base, uuid: 'safe'
  })]);
  fixture.options.runOrca = orcaRunner([
    { ...orcaWorktree('PRIVATE_TEXT'), path: rawCwd },
    { ...orcaWorktree('preserved'), path: base, worktreeId: 'safe-tree' }
  ], [orcaTerminal(), orcaTerminal({ handle: 'safe', worktreeId: 'safe-tree' })]);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 2);
  assert.deepEqual(before.instructions.map(instruction => instruction.text).sort(), ['PRIVATE_TEXT', 'preserved']);
  assert.equal(before.orca.worktrees.length, 2);
  assert.equal(before.orca.terminals.length, 2);
  assert.equal(fs.realpathSync.native(rawCwd), fs.realpathSync.native(path.join(sensitive, 'repo')));
  const target = { kind: 'cwd', prefix: sensitive };
  assertCwdTargetRejected(fixture, target);
  assertLegacyCwdConfigRejected(fixture, [sensitive]);
});

for (const provider of ['claude', 'codex']) {
  test(`R5 2 ${provider} mixed explicit session identities withhold one file without losing safe sessions`,
    testContext => {
    const fixture = createFixture(testContext);
    const mixedRecords = provider === 'claude' ? [
      claudeUserRecord('public text', { sessionId: 'public', uuid: 'a' }),
      claudeUserRecord('PRIVATE_TEXT', { sessionId: 'private', uuid: 'b' })
    ] : [
      codexSessionMeta({ id: 'public' }), codexMessage('public text', { id: 'a' }),
      codexSessionMeta({ id: 'private' }), codexMessage('PRIVATE_TEXT', { id: 'b' })
    ];
    fixture.file(provider, 'mixed', mixedRecords);
    fixture.file(provider, 'safe', provider === 'claude'
      ? [claudeUserRecord('preserved', { sessionId: 'safe', uuid: 'safe' })]
      : [codexSessionMeta({ id: 'safe' }), codexMessage('preserved')]);
    snapshotReader.loadConfig(fixture.options);
    const config = fixture.config();
    config.exclude.sessions.push(`${provider}:private`);
    fixture.save(config);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    const preserved = snapshot.instructions.filter(instruction => instruction.text === 'preserved');
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].id, provider === 'claude' ? 'claude:safe:usafe' : 'codex:safe:n1');
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].session_id, 'safe');
    assert.equal(snapshot.coverage[provider].mixed_session_withheld, 1);
    assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
    assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TEXT'), false);
  });
}

for (const invalidField of ['missing-fingerprint', 'invalid-fingerprint', 'missing-key', 'invalid-key']) {
  test(`R5 3 ${invalidField} content deletion rule withholds only its Codex session`, testContext => {
    const fixture = createFixture(testContext);
    fixture.file('codex', 'deleted', [codexSessionMeta(), codexMessage('A'), codexMessage('B')]);
    fixture.file('codex', 'safe', [codexSessionMeta({ id: 'safe' }), codexMessage('preserved')]);
    const before = snapshotReader.runSnapshot(fixture.options);
    assert.equal(before.instructions.length, 3);
    assert.deepEqual(before.instructions.map(instruction => instruction.text).sort(), ['A', 'B', 'preserved']);
    registerInstructionExclusion(fixture, before.instructions.find(instruction => instruction.text === 'B'));
    const deleted = snapshotReader.runSnapshot(fixture.options);
    assert.equal(deleted.instructions.length, 2);
    assert.deepEqual(deleted.instructions.map(instruction => instruction.text).sort(), ['A', 'preserved']);
    const config = fixture.config();
    const field = invalidField.endsWith('fingerprint') ? 'fingerprint' : 'key_fingerprint';
    if (invalidField.startsWith('missing')) {
      delete config.exclude.instructions[0][field];
    } else {
      config.exclude.instructions[0][field] = 'INVALID';
    }
    fixture.save(config);
    const withheld = snapshotReader.runSnapshot(fixture.options);
    const preserved = withheld.instructions.filter(instruction => instruction.text === 'preserved');
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].id, 'codex:safe:n1');
    assert.equal(withheld.instructions.length, 1);
    assert.equal(withheld.sessions.length, 1);
    assert.equal(withheld.coverage.codex.withheld_sessions, 1);
    assert.equal(snapshotPolicy.validateSnapshot(withheld).ok, true);
    assert.equal(withheld.instructions.some(instruction => instruction.text === 'B'), false);
  });
}

for (const scenario of ['content-deletion', 'key-mismatch']) {
  test(`R6 Codex ${scenario} is scoped by provider and preserves Claude with the same sid`, testContext => {
    const fixture = createFixture(testContext);
    fixture.file('claude', 'claude', [claudeUserRecord('B', { uuid: 'a' })]);
    fixture.file('codex', 'codex', [codexSessionMeta(), codexMessage('B')]);
    const before = snapshotReader.runSnapshot(fixture.options);
    assert.equal(before.instructions.length, 2);
    assert.deepEqual(before.instructions.map(instruction => instruction.id).sort(), ['claude:s:ua', 'codex:s:n1']);
    registerInstructionExclusion(fixture, before.instructions.find(instruction => instruction.id === 'codex:s:n1'));
    if (scenario === 'key-mismatch') {
      const config = fixture.config();
      config.exclude.instructions[0].key_fingerprint = '0'.repeat(64);
      fixture.save(config);
    }
    const after = snapshotReader.runSnapshot(fixture.options);
    assert.equal(after.instructions.length, 1);
    assert.equal(after.instructions[0].id, 'claude:s:ua');
    assert.equal(after.instructions[0].text, 'B');
    assert.equal(after.sessions.filter(session => session.provider === 'claude').length, 1);
    assert.equal(after.coverage.claude.excluded_sessions, 0);
    assert.equal(after.coverage.claude.deleted_instructions, 0);
    assert.equal(after.coverage.codex[scenario === 'key-mismatch' ? 'withheld_sessions' : 'deleted_instructions'], 1);
  });
}


test('R6 changing record cwd preserves sessions while cwd requests and legacy rules are rejected', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'changing', [
    claudeUserRecord('public instruction', { cwd: '/work/public', uuid: 'public' }),
    claudeUserRecord('PRIVATE_TEXT', { cwd: '/work/private', uuid: 'private' })
  ]);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 2);
  assert.deepEqual(before.instructions.map(instruction => instruction.text), ['public instruction', 'PRIVATE_TEXT']);
  assert.equal(before.sessions.length, 1);
  assert.equal(before.sessions[0].session_id, 's');
  assert.equal(Object.hasOwn(fixture.config().exclude, 'cwd_prefixes'), false);
  assertCwdTargetRejected(fixture, { kind: 'cwd', prefix: '/work/private' });
  const legacy = fixture.config();
  legacy.exclude.cwd_prefixes = [];
  fixture.save(legacy);
  const compatible = snapshotReader.runSnapshot(fixture.options);
  assert.equal(compatible.instructions.length, 2);
  assert.deepEqual(compatible.instructions.map(instruction => instruction.text), [
    'public instruction', 'PRIVATE_TEXT'
  ]);
  assertLegacyCwdConfigRejected(fixture, ['/work/private']);
});

test('R7 Orca INT overflow rejects only that worktree and reports partial coverage', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'safe', [claudeUserRecord('preserved')]);
  fixture.options.runOrca = orcaRunner([
    { ...orcaWorktree('preserved'), worktreeId: 'safe' },
    { ...orcaWorktree('bad'), worktreeId: 'bad', liveTerminals: 1000000001 }
  ], [orcaTerminal({ worktreeId: 'safe' }), orcaTerminal({ handle: 'bad', worktreeId: 'bad' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'preserved');
  assert.equal(snapshot.orca.worktrees.length, 1);
  assert.equal(snapshot.orca.worktrees[0].worktree_id, 'safe');
  assert.equal(snapshot.orca.terminals.length, 1);
  assert.equal(snapshot.coverage.orca.state, 'partial');
  assert.equal(snapshot.coverage.orca.code, 'orca_unavailable');
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});

test('R7 extended-year records withhold their file and preserve a separate normal session', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'safe', [
    { type: 'assistant', timestamp: '-000001-01-01T00:00:00.000Z' },
    claudeUserRecord('ignored', { timestamp: '+010000-01-01T00:00:00.000Z', uuid: 'bad' }),
    claudeUserRecord('preserved')
  ]);
  fixture.file('claude', 'normal', [claudeUserRecord('normal preserved', { sessionId: 'normal' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'normal preserved');
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].first_record_at, RECORD_TIMESTAMP);
  assert.equal(snapshot.sessions[0].last_record_at, RECORD_TIMESTAMP);
  assert.equal(snapshot.coverage.claude.records_unverified, 2);
  assert.equal(snapshot.coverage.claude.invalid_time_withheld, 1);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});

function createSlotNoisePrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

test('R7 seeded 200 mixed transcript and Orca inputs preserve all four normal instructions', testContext => {
  const nextRandom = createSlotNoisePrng(0x71a5c0de);
  const noiseValues = [1000000001, -1, Number.MAX_SAFE_INTEGER, null, false, {}, [], 'x'.repeat(4000),
    '-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z'];
  for (let iteration = 0; iteration < 200; iteration++) {
    const fixture = createFixture(testContext);
    const randomValue = () => noiseValues[nextRandom() % noiseValues.length];
    const invalidTime = iteration % 2 ? '-000001-01-01T00:00:00.000Z' : '+010000-01-01T00:00:00.000Z';
    const claudeRecords = [
      claudeUserRecord('A', { uuid: 'a' }),
      claudeUserRecord('CLAUDE_NOISE', { uuid: 'noise', timestamp: invalidTime }),
      randomValue(),
      { type: 'assistant', timestamp: randomValue(), gitBranch: randomValue(), cwd: randomValue() },
      claudeUserRecord('C', { uuid: 'c' })
    ];
    fixture.file('claude', 'affected', claudeRecords);
    fixture.file('claude', 'normal', [
      claudeUserRecord('A', { sessionId: 'normalclaude', uuid: 'a' }),
      claudeUserRecord('C', { sessionId: 'normalclaude', uuid: 'c' })
    ]);
    const codexRecords = [
      { ...codexSessionMeta(), timestamp: invalidTime },
      codexSessionMeta(),
      { ...codexMessage('CODEX_NOISE'), timestamp: invalidTime },
      codexMessage('D'),
      { type: 'assistant', timestamp: randomValue(), payload: randomValue() },
      codexMessage('F')
    ];
    fixture.file('codex', 'affected', codexRecords);
    fixture.file('codex', 'normal', [codexSessionMeta({ id: 'normalcodex' }), codexMessage('D'), codexMessage('F')]);
    const badWorktree = { ...orcaWorktree('bad'), worktreeId: 'bad' };
    const worktreeField = ['liveTerminals', 'lastActivityAt', 'worktreeId', 'path'][nextRandom() % 4];
    badWorktree[worktreeField] = randomValue();
    const badAgent = { ...orcaWorktree('bad').agents[0], paneKey: randomValue(), updatedAt: randomValue() };
    badWorktree.agents.push(badAgent);
    const badTerminal = orcaTerminal({ handle: 'bad', worktreeId: 'bad' });
    const terminalField = ['handle', 'lastOutputAt', 'worktreeId'][nextRandom() % 3];
    badTerminal[terminalField] = randomValue();
    fixture.options.runOrca = orcaRunner([orcaWorktree('C'), badWorktree], [orcaTerminal(), badTerminal]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.instructions.length, 4, `iteration ${iteration}`);
    assert.deepEqual(snapshot.instructions.map(instruction => instruction.text).sort(), ['A', 'C', 'D', 'F']);
    assert.equal(snapshot.sessions.length, 2);
    assert.equal(snapshot.orca.worktrees.filter(worktree => worktree.worktree_id === 'w').length, 1);
    assert.equal(snapshot.orca.terminals.filter(terminal => terminal.handle === 'h').length, 1);
    assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
    assert.equal(snapshot.instructions.find(instruction => instruction.text === 'D').id, 'codex:normalcodex:n1');
    assert.equal(snapshot.instructions.find(instruction => instruction.text === 'F').id, 'codex:normalcodex:n2');
    assert.equal(snapshot.coverage.claude.invalid_time_withheld, 1);
    assert.equal(snapshot.coverage.codex.invalid_time_withheld, 1);
    for (const [provider, records] of [['claude', claudeRecords], ['codex', codexRecords]]) {
      const normalizedRecords = structuredClone(records);
      for (const record of normalizedRecords) {
        if (record && typeof record === 'object' && Object.hasOwn(record, 'timestamp')
          && !snapshotPolicy.isSafeTimestamp(record.timestamp)) {
          record.timestamp = RECORD_TIMESTAMP;
        }
      }
      fixture.file(provider, 'affected', normalizedRecords);
    }
    const normalized = snapshotReader.runSnapshot(fixture.options);
    assert.equal(normalized.instructions.length, 10);
    for (const instruction of snapshot.instructions) {
      const matching = normalized.instructions.filter(candidate => candidate.id === instruction.id);
      assert.equal(matching.length, 1);
      assert.equal(matching[0].id, instruction.id);
      assert.equal(matching[0].ref, instruction.ref);
    }
    assert.equal(snapshotPolicy.validateSnapshot(normalized).ok, true);
  }
});

test('R7 session cardinality overflow omits excess candidates without aborting collection', testContext => {
  const fixture = createFixture(testContext);
  for (let index = 0; index < 301; index++) {
    fixture.file('claude', String(index).padStart(3, '0'), [claudeUserRecord('preserved', {
      sessionId: `session${index}`, uuid: `record${index}`
    })]);
  }
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 300);
  assert.equal(snapshot.sessions.length, 300);
  assert.equal(snapshot.instructions.filter(instruction => instruction.text === 'preserved').length, 300);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});

test('R7 invalid TIME retains mixed-session evidence while withholding that file only', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('codex', 'mixed', [
    { ...codexSessionMeta({ id: 'wrong' }), timestamp: '-000001-01-01T00:00:00.000Z' },
    { type: 'compacted', timestamp: '+010000-01-01T00:00:00.000Z', payload: {} },
    codexSessionMeta(), codexMessage('withheld')
  ]);
  fixture.file('codex', 'safe', [codexSessionMeta({ id: 'safe' }), codexMessage('preserved')]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'preserved');
  assert.equal(snapshot.instructions[0].id, 'codex:safe:n1');
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
  assert.equal(snapshot.coverage.codex.records_unverified, 2);
  assert.equal(snapshot.coverage.codex.mixed_session_withheld, 1);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});

test('R8 invalid TIME metadata still triggers mixed-session withholding before exclusions', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('codex', 'mixed', [
    { ...codexSessionMeta({ id: 'private' }), timestamp: '-000001-01-01T00:00:00.000Z' },
    codexMessage('PRIVATE_TEXT'),
    { ...codexSessionMeta({ id: 'public' }), timestamp: '2026-10-08T02:01:00.000Z' }
  ]);
  fixture.file('codex', 'safe', [codexSessionMeta({ id: 'safe' }), codexMessage('preserved')]);
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config();
  config.exclude.sessions.push('codex:private');
  fixture.save(config);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  const preserved = snapshot.instructions.filter(instruction => instruction.text === 'preserved');
  assert.equal(preserved.length, 1);
  assert.equal(preserved[0].id, 'codex:safe:n1');
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.coverage.codex.mixed_session_withheld, 1);
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_TEXT'), false);
});

test('R8 invalid TIME user withholds the file until normalization and preserves other session refs', testContext => {
  const fixture = createFixture(testContext);
  const original = [codexSessionMeta(),
    { ...codexMessage('A'), timestamp: '+010000-01-01T00:00:00.000Z' }, codexMessage('B')];
  fixture.file('codex', 'affected', original);
  fixture.file('claude', 'normal', [claudeUserRecord('normal preserved', { sessionId: 'normal' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'normal preserved');
  assert.equal(snapshot.instructions[0].id, 'claude:normal:uu');
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshot.coverage.codex.invalid_time_withheld, 1);
  original[1].timestamp = RECORD_TIMESTAMP;
  fixture.file('codex', 'affected', original);
  const normalized = snapshotReader.runSnapshot(fixture.options);
  assert.equal(normalized.instructions.length, 3);
  assert.deepEqual(normalized.instructions.map(instruction => instruction.text).sort(), ['A', 'B', 'normal preserved']);
  const normalizedB = normalized.instructions.find(instruction => instruction.text === 'B');
  assert.equal(normalizedB.id, 'codex:s:n2');
  const preserved = normalized.instructions.find(instruction => instruction.text === 'normal preserved');
  assert.equal(preserved.id, snapshot.instructions[0].id);
  assert.equal(preserved.ref, snapshot.instructions[0].ref);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target: instructionTarget(normalizedB) });
  assert.equal(preview.preview, 'B');
  original[1].timestamp = '+010000-01-01T00:00:00.000Z';
  fixture.file('codex', 'affected', original);
  assertReaderError(() => snapshotReader.excludeQuery({
    ...fixture.options, target: instructionTarget(normalizedB)
  }), 'target_not_found');
});

test('R8 invalid TIME ancestor withholds its file and preserves a normal Claude session',
  testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'safe', [
    { type: 'assistant', sessionId: 's', uuid: 'ancestor', parentUuid: null,
      timestamp: '-000001-01-01T00:00:00.000Z', cwd: '/invalid/metadata' },
    claudeUserRecord('preserved', { parentUuid: 'ancestor' })
  ]);
  fixture.file('claude', 'normal', [claudeUserRecord('normal preserved', { sessionId: 'normal' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'normal preserved');
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
  assert.equal(snapshot.sessions[0].repo_label, 'repo');
  assert.equal(snapshot.sessions[0].first_record_at, RECORD_TIMESTAMP);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.coverage.claude.invalid_time_withheld, 1);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});

for (const compact of [false, true]) {
  test(`R8 invalid TIME meta and compact=${compact} withhold the file and preserve a normal session`, testContext => {
    const fixture = createFixture(testContext);
    const records = [{ ...codexSessionMeta(), timestamp: '-000001-01-01T00:00:00.000Z' }];
    if (compact) {
      records.push({ type: 'compacted', timestamp: '+010000-01-01T00:00:00.000Z', payload: {} });
    }
    records.push({ ...codexMessage('omitted'), timestamp: '+010000-01-01T00:00:00.000Z' });
    records.push(codexMessage('preserved'));
    fixture.file('codex', 'safe', records);
    fixture.file('claude', 'normal', [claudeUserRecord('normal preserved', { sessionId: 'normal' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.instructions[0].text, 'normal preserved');
    assert.equal(snapshot.instructions[0].id, 'claude:normal:uu');
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].first_instruction, 'recoverable');
    assert.equal(snapshot.sessions[0].repo_label, 'repo');
    assert.equal(snapshot.sessions[0].first_record_at, RECORD_TIMESTAMP);
    assert.equal(snapshot.sessions[0].last_record_at, RECORD_TIMESTAMP);
    assert.equal(snapshot.coverage.codex.records_unverified, compact ? 3 : 2);
    assert.equal(snapshot.coverage.codex.invalid_time_withheld, 1);
    assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
  });
}

for (const scenario of ['orca-link', 'deletion-equivalence']) {
  test(`R9 invalid TIME ${scenario} withholds its session and preserves the normal session`, testContext => {
    const fixture = createFixture(testContext);
    const firstText = scenario === 'orca-link' ? 'abcdefgh' : 'B';
    fixture.file('codex', 'affected', [codexSessionMeta(), codexMessage(firstText), {
      ...codexMessage(scenario === 'orca-link' ? 'different instruction' : 'B'),
      timestamp: '+010000-01-01T00:00:00.000Z'
    }]);
    fixture.file('claude', 'safe', [claudeUserRecord('preserved', { sessionId: 'safe', cwd: '/safe' })]);
    fixture.options.runOrca = orcaRunner([orcaWorktree(firstText)], [orcaTerminal()]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    const preserved = snapshot.instructions.filter(instruction => instruction.text === 'preserved');
    assert.equal(preserved.length, 1);
    assert.equal(preserved[0].id, 'claude:safe:uu');
    assert.equal(snapshot.orca.worktrees.length, 1);
    assert.equal(snapshot.orca.terminals.length, 1);
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
    assert.equal(snapshot.sessions[0].orca_link.evidence, 'none');
    assert.equal(snapshot.coverage.codex.invalid_time_withheld, 1);
    assert.equal(snapshot.coverage.codex.records_unverified, 1);
    assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
    assertReaderError(() => snapshotReader.excludeQuery({
      ...fixture.options, target: { kind: 'instruction', instrId: 'codex:s:n1', ref: '0'.repeat(16) }
    }), 'target_not_found');
    assertReaderError(() => snapshotReader.excludeQuery({
      ...fixture.options, target: { kind: 'session', provider: 'codex', sessionId: 's' }
    }), 'target_not_found');
  });
}

for (const provider of ['claude', 'codex']) {
  test(`R9 ${provider} missing timestamp differs from explicit invalid TIME`, testContext => {
    const fixture = createFixture(testContext);
    const withoutTime = provider === 'claude' ? claudeUserRecord('omitted', { uuid: 'missing' })
      : codexMessage('omitted');
    delete withoutTime.timestamp;
    const records = provider === 'claude' ? [
      { type: 'assistant' }, withoutTime, claudeUserRecord('preserved')
    ] : [codexSessionMeta(), { type: 'assistant' }, withoutTime, codexMessage('preserved')];
    fixture.file(provider, 'safe', records);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.instructions[0].text, 'preserved');
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.coverage[provider].records_unverified, 1);
    assert.equal(snapshot.coverage[provider].invalid_time_withheld, 0);
    assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
    const explicitInvalid = structuredClone(records);
    explicitInvalid[provider === 'claude' ? 1 : 2].timestamp = null;
    fixture.file(provider, 'safe', explicitInvalid);
    fixture.file(provider, 'normal', provider === 'claude'
      ? [claudeUserRecord('normal preserved', { sessionId: 'normal' })]
      : [codexSessionMeta({ id: 'normal' }), codexMessage('normal preserved')]);
    const withheld = snapshotReader.runSnapshot(fixture.options);
    assert.equal(withheld.instructions.length, 1);
    assert.equal(withheld.instructions[0].text, 'normal preserved');
    assert.equal(withheld.sessions.length, 1);
    assert.equal(withheld.coverage[provider].records_unverified, 1);
    assert.equal(withheld.coverage[provider].invalid_time_withheld, 1);
    assert.equal(snapshotPolicy.validateSnapshot(withheld).ok, true);
  });
}

test('R9 files with only absent timestamps count user candidates without TIME withholding', testContext => {
  const fixture = createFixture(testContext);
  const claudeCandidate = claudeUserRecord('omitted', { sessionId: 'missing' });
  delete claudeCandidate.timestamp;
  const codexMeta = codexSessionMeta({ id: 'missing' });
  const codexCandidate = codexMessage('omitted');
  delete codexMeta.timestamp;
  delete codexCandidate.timestamp;
  fixture.file('claude', 'missing', [{ type: 'assistant' }, claudeCandidate]);
  fixture.file('codex', 'missing', [codexMeta, { type: 'assistant' }, codexCandidate]);
  fixture.file('claude', 'normal', [claudeUserRecord('normal preserved', { sessionId: 'normal' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'normal preserved');
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.coverage.codex.records_unverified, 1);
  assert.equal(snapshot.coverage.claude.invalid_time_withheld, 0);
  assert.equal(snapshot.coverage.codex.invalid_time_withheld, 0);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
});
