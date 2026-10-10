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
function orcaResponse(collection, items, extra = {}) {
  return { id: 'synthetic-response', ok: true,
    result: { [collection]: items, totalCount: items.length, truncated: false, ...extra }, _meta: {} };
}
function orcaRunner(worktrees, terminals) {
  return args => JSON.stringify(args[0] === 'worktree'
    ? orcaResponse('worktrees', worktrees) : orcaResponse('terminals', terminals));
}
function orcaWorktree(prompt, pane = 'p:leaf', extra = {}) {
  return {
    worktreeId: 'w',
    path: '/sensitive/repo',
    branch: 'main',
    status: 'active',
    lastActivityAt: Date.parse(RECORD_TIMESTAMP),
    liveTerminalCount: 1,
    agents: [{
      paneKey: pane,
      prompt,
      state: 'running',
      agentType: 'claude',
      stateStartedAt: Date.parse(RECORD_TIMESTAMP),
      updatedAt: Date.parse(RECORD_TIMESTAMP),
      ...extra
    }]
  };
}
function orcaTerminal(extra = {}) {
  return {
    handle: 'h',
    worktreeId: 'w',
    tabId: 'p',
    leafId: 'leaf',
    agentIdentity: 'claude',
    title: 'safe terminal title',
    lastOutputAt: Date.parse(RECORD_TIMESTAMP),
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
    orcaWorktree('abcdefgh', 'safe-pane:leaf')
  ], [
    orcaTerminal({ worktreeId: 'unknown', handle: 'unknown', title: 'WITHHELD_TEXT' }),
    orcaTerminal({ tabId: 'safe-pane', title: 'safe title before withholding' })
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
    operation: 'enqueue'
  }, {
    type: 'queue-operation',
    timestamp: RECORD_TIMESTAMP,
    operation: 'dequeue'
  }, {
    type: 'queue-operation',
    timestamp: RECORD_TIMESTAMP,
    operation: 'remove'
  }, {
    type: 'ai-title',
    timestamp: RECORD_TIMESTAMP,
    aiTitle: SECRET_SENTINEL
  }];
  testFixture.file('claude', 'rows', cases);
  const snapshot = snapshotReader.runSnapshot(testFixture.options);
  assert.equal(snapshot.instructions.length, 7);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), [
    'normal', '<command-name>/good</command-name><command-args>arg</command-args>',
    '<command-name>/not-absent</command-name>',
    '<bash-input>echo safe</bash-input>', '<pasted>pasted safe</pasted>', 'queued safe', ''
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
  testFixture.options.runOrca = orcaRunner([{
    worktreeId: 'w::/private/' + SECRET_SENTINEL,
    path: '/private/' + SECRET_SENTINEL,
    repoLabel: SECRET_SENTINEL,
    branch: SECRET_SENTINEL,
    status: 'active',
    lastActivityAt: Date.parse(RECORD_TIMESTAMP),
    liveTerminalCount: 1,
    agents: [{
      paneKey: 'p:leaf',
      state: 'running',
      agentType: 'claude',
      stateStartedAt: Date.parse(RECORD_TIMESTAMP),
      updatedAt: Date.parse(RECORD_TIMESTAMP),
      prompt: 'preserved safe ' + SECRET_SENTINEL,
      displayName: SECRET_SENTINEL,
      toolInput: SECRET_SENTINEL
    }]
  }], [{
    handle: 'h',
    worktreeId: 'w::/private/' + SECRET_SENTINEL,
    tabId: 'p',
    leafId: 'leaf',
    agentIdentity: 'claude',
    title: SECRET_SENTINEL,
    lastOutputAt: Date.parse(RECORD_TIMESTAMP),
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
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'prompt_exact');
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
    'cwd_only', false], ['one  two three', 'one two three', 'cwd_only', false]]) {
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
    testFixture.options.runOrca = orcaRunner([orcaWorktree('abcdefgh', 'p:leaf', {
      stateStartedAt: Date.parse(when), updatedAt: Date.parse(when)
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
    paneKey: 'second:leaf'
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
    return orcaRunner([orcaWorktree('abcdefgh')], [orcaTerminal()])(args);
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
  oldWorktree.agents[0].paneKey = 'old-pane:leaf';
  testFixture.options.runOrca = orcaRunner(
    [orcaWorktree('abcdefgh'), oldWorktree],
    [orcaTerminal(), orcaTerminal({
      handle: 'old-terminal',
      worktreeId: 'old-worktree',
      tabId: 'old-pane',
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
    orcaWorktree('abcdefgh', 'safe-pane:leaf')
  ], [
    orcaTerminal({ worktreeId: 'public', handle: 'public', title: 'A original title' }),
    orcaTerminal({ worktreeId: 'private', handle: 'private', title: 'B original title' }),
    orcaTerminal({ tabId: 'safe-pane', title: 'safe preserved title' })
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
      { ...orcaWorktree('preserved', 'safe-pane:leaf'), worktreeId: 'safe-tree', path: boundaryCwd }
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
    { ...orcaWorktree('bad'), worktreeId: 'bad', liveTerminalCount: 1000000001 }
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
    const worktreeField = ['liveTerminalCount', 'lastActivityAt', 'worktreeId', 'path'][nextRandom() % 4];
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

const OLD_RECORD_TIMESTAMP = '2026-09-01T02:00:00.000Z';

function setTranscriptMtime(file, timestamp) {
  const time = new Date(timestamp);
  fs.utimesSync(file, time, time);
}

function installMemoryEquivalenceFixture(testContext) {
  const fixture = createFixture(testContext);
  const oldClaude = fixture.file('claude', 'a-old', [
    claudeUserRecord('old Claude', { sessionId: 'old', timestamp: OLD_RECORD_TIMESTAMP })
  ]);
  const oldClaudeMulti = fixture.file('claude', 'b-multi-old', [
    claudeUserRecord('old ambiguous Claude', { sessionId: 'multi', timestamp: OLD_RECORD_TIMESTAMP })
  ]);
  fixture.file('claude', 'c-multi-new', [claudeUserRecord('new ambiguous Claude', { sessionId: 'multi' })]);
  fixture.file('claude', 'd-keep', [
    claudeUserRecord('first Claude', { sessionId: 'keep', uuid: 'first', timestamp: OLD_RECORD_TIMESTAMP }),
    claudeUserRecord('deleted Claude', { sessionId: 'keep', uuid: 'deleted' }),
    claudeUserRecord('last Claude', { sessionId: 'keep', uuid: 'last' }),
    claudeUserRecord('unknown Claude', { sessionId: 'keep', uuid: 'unknown', origin: undefined }),
    { type: 'queue-operation', timestamp: RECORD_TIMESTAMP, operation: 'enqueue' },
    { type: 'queue-operation', timestamp: RECORD_TIMESTAMP, operation: 'dequeue' },
    { type: 'queue-operation', timestamp: RECORD_TIMESTAMP, operation: 'remove' },
    { type: 'ai-title', timestamp: RECORD_TIMESTAMP, aiTitle: 'fixture title' },
    null
  ]);
  fixture.file('claude', 'e-excluded', [claudeUserRecord('excluded Claude', { sessionId: 'excluded' })]);
  const oldCodex = fixture.file('codex', 'a-old', [
    { ...codexSessionMeta({ id: 'old' }), timestamp: OLD_RECORD_TIMESTAMP },
    { ...codexMessage('old Codex'), timestamp: OLD_RECORD_TIMESTAMP }
  ]);
  const oldCodexMulti = fixture.file('codex', 'b-multi-old', [
    { ...codexSessionMeta({ id: 'multi' }), timestamp: OLD_RECORD_TIMESTAMP },
    { ...codexMessage('old ambiguous Codex'), timestamp: OLD_RECORD_TIMESTAMP }
  ]);
  fixture.file('codex', 'c-multi-new', [codexSessionMeta({ id: 'multi' }), codexMessage('new ambiguous Codex')]);
  fixture.file('codex', 'd-keep', [
    codexSessionMeta({ id: 'keep' }),
    codexMessage('deleted Codex'),
    codexMessage('kept Codex', { id: 'kept' }),
    codexMessage('<environment_context>injected'),
    codexMessage('<unknown>unknown'),
    { type: 'compacted', timestamp: RECORD_TIMESTAMP, payload: { replacement_history: [codexMessage('copy')] } }
  ]);
  fixture.file('codex', 'e-exec', [codexSessionMeta({ id: 'exec', source: 'exec' }), codexMessage('exec')]);
  fixture.file('codex', 'f-excluded', [codexSessionMeta({ id: 'excluded' }), codexMessage('excluded Codex')]);
  for (const file of [oldClaude, oldClaudeMulti, oldCodex, oldCodexMulti]) {
    setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
  }
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config();
  config.machine_id = 'fixture-machine';
  config.path_salt = 'fixture-salt';
  config.local_key = 'a'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  config.exclude.sessions = ['claude:excluded', 'codex:excluded'];
  const structure = [['text', 'deleted Codex'], ['attachments', 0]];
  const encoded = snapshotPolicy.canonicalEncode(['palantir.instruction-fingerprint/1', structure]);
  config.exclude.instructions = [
    { id: 'claude:keep:udeleted' },
    {
      id: 'codex:keep:n1',
      fingerprint: crypto.createHmac('sha256', config.local_key).update(encoded).digest('hex'),
      key_fingerprint: config.key_fingerprint
    }
  ];
  fixture.save(config);
  return fixture;
}

test('PR1c fixed pre-change bytes preserve window, whole sessions, exclusions and coverage', testContext => {
  const fixture = installMemoryEquivalenceFixture(testContext);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(snapshot.sessions.map(session => `${session.provider}:${session.session_id}`), [
    'claude:keep', 'codex:keep'
  ]);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), [
    'first Claude', 'last Claude', 'kept Codex'
  ]);
  assert.deepEqual(snapshot.coverage, {
    claude: {
      files_scanned: 5, files_skipped: 1, files_failed: 0, records_unknown: 1, records_unverified: 1,
      excluded_sessions: 1, deleted_instructions: 1, queued_enqueued: 1, queued_dequeued: 1, queued_removed: 1,
      multi_file_withheld: 1, mixed_session_withheld: 0, invalid_time_withheld: 0,
      large_file_withheld: 0, link_blocked: 1, queued_delivered_attachment: 0, queued_duplicate_withheld: 0
    },
    codex: {
      files_scanned: 6, files_failed: 0, exec_sessions_excluded: 1, subagent_excluded: 0,
      unsupported_sessions: 0, records_unknown: 1, records_unverified: 0, withheld_sessions: 0,
      content_rule_excluded: 1, excluded_sessions: 1, deleted_instructions: 1,
      multi_file_withheld: 1, mixed_session_withheld: 0, invalid_time_withheld: 0, large_file_withheld: 0, link_blocked: 0
    },
    orca: { state: 'unavailable', code: 'orca_unavailable' }
  });
  // Spec §1.4 / §3: freeze the complete serialized pre-change output, including order and refs.
  const legacy = JSON.parse(JSON.stringify(snapshot));
  for (const session of legacy.sessions) {
    delete session.instruction_total;
    // The fixture's complete unsupported JSON value now intentionally blocks Claude links.
    if (session.provider === 'claude') {
      assert.equal(session.orca_link.evidence, 'ambiguous');
      session.orca_link = { evidence: 'none', confirmed: false, pane_key: null, terminal_handle: null };
    }
  }
  for (const provider of ['claude', 'codex']) {
    delete legacy.coverage[provider].large_file_withheld;
    delete legacy.coverage[provider].link_blocked;
    delete legacy.coverage[provider].queued_delivered_attachment;
    delete legacy.coverage[provider].queued_duplicate_withheld;
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  assert.equal(digest, 'feea4682e9e7a23f8342acdec8c1aca5979a691394d838baa14e1fbca4a6c569');
});

function trackTranscriptReads(testContext, file) {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readSync;
  const originalReadFile = fs.readFileSync;
  const descriptors = new Set();
  const totals = { bytes: 0, fullReads: 0 };
  testContext.mock.method(fs, 'openSync', function trackOpen(filePath, ...args) {
    const descriptor = originalOpen(filePath, ...args);
    if (filePath === file) {
      descriptors.add(descriptor);
    }
    return descriptor;
  });
  testContext.mock.method(fs, 'closeSync', function trackClose(descriptor) {
    descriptors.delete(descriptor);
    return originalClose(descriptor);
  });
  testContext.mock.method(fs, 'readSync', function trackRead(descriptor, ...args) {
    const count = originalRead(descriptor, ...args);
    if (descriptors.has(descriptor)) {
      totals.bytes += count;
      if (args[1] === 0 && args[3] === 0
        && (args[0].length > 64 * 1024 || args[0].length === fs.fstatSync(descriptor).size + 1)) {
        totals.fullReads++;
      }
    }
    return count;
  });
  testContext.mock.method(fs, 'readFileSync', function trackReadFile(filePath, ...args) {
    const data = originalReadFile(filePath, ...args);
    if (filePath === file || descriptors.has(filePath)) {
      totals.bytes += Buffer.byteLength(data);
      totals.fullReads++;
    }
    return data;
  });
  return totals;
}

for (const provider of ['claude', 'codex']) {
  test(`PR1c ${provider} old files read at most 128KB; recent and future mtimes read fully`, testContext => {
    const fixture = createFixture(testContext);
    const rows = provider === 'claude' ? [
      claudeUserRecord('old instruction', { timestamp: OLD_RECORD_TIMESTAMP })
    ] : [
      { ...codexSessionMeta(), timestamp: OLD_RECORD_TIMESTAMP },
      { ...codexMessage('old instruction'), timestamp: OLD_RECORD_TIMESTAMP }
    ];
    const file = fixture.file(provider, 'large', [
      ...rows,
      { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP, padding: 'x'.repeat(4 * 1024 * 1024) },
      { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP }
    ]);
    const size = fs.statSync(file).size;
    assert.ok(size > 4 * 1024 * 1024);
    const totals = trackTranscriptReads(testContext, file);
    const boundary = +SNAPSHOT_TIME - 14 * 86400000;
    setTranscriptMtime(file, new Date(boundary - 1));
    const old = snapshotReader.runSnapshot(fixture.options);
    assert.equal(old.sessions.length, 0);
    assert.ok(totals.bytes > 0);
    assert.ok(totals.bytes <= 128 * 1024);
    assert.equal(totals.fullReads, 0);
    assert.equal(old.coverage[provider].files_scanned, 1);
    if (provider === 'claude') {
      assert.equal(old.coverage.claude.files_skipped, 1);
    }
    for (const mtime of [new Date(boundary), SNAPSHOT_TIME, new Date(+SNAPSHOT_TIME + 86400000)]) {
      setTranscriptMtime(file, mtime);
      totals.bytes = 0;
      totals.fullReads = 0;
      const recent = snapshotReader.runSnapshot(fixture.options);
      assert.equal(recent.sessions.length, 0);
      assert.ok(totals.bytes >= size);
      assert.ok(totals.bytes <= size * 5 + 128 * 1024);
      assert.ok(totals.bytes > 0);
      assert.deepEqual(recent, old);
    }
  });

  test(`PR1c ${provider} old identity participates in whole-session multi-file withholding`, testContext => {
    const fixture = createFixture(testContext);
    const rows = provider === 'claude' ? [
      claudeUserRecord('old', { timestamp: OLD_RECORD_TIMESTAMP })
    ] : [
      { ...codexSessionMeta(), timestamp: OLD_RECORD_TIMESTAMP },
      { ...codexMessage('old'), timestamp: OLD_RECORD_TIMESTAMP }
    ];
    const oldFile = fixture.file(provider, 'a-old', rows);
    setTranscriptMtime(oldFile, OLD_RECORD_TIMESTAMP);
    const recentFile = fixture.file(provider, 'b-recent', provider === 'claude'
      ? [claudeUserRecord('recent')] : [codexSessionMeta(), codexMessage('recent')]);
    const withheld = snapshotReader.runSnapshot(fixture.options);
    assert.equal(withheld.coverage[provider].files_scanned, 2);
    assert.equal(withheld.coverage[provider].multi_file_withheld, 1);
    assert.equal(withheld.sessions.length, 0);
    assert.equal(withheld.instructions.length, 0);
    if (provider === 'claude') {
      assert.equal(withheld.coverage.claude.files_skipped, 0);
    }
    fs.unlinkSync(recentFile);
    const oldOnly = snapshotReader.runSnapshot(fixture.options);
    assert.equal(oldOnly.coverage[provider].multi_file_withheld, 0);
    fs.unlinkSync(oldFile);
    fixture.file(provider, 'recent-only', provider === 'claude'
      ? [claudeUserRecord('recent')] : [codexSessionMeta(), codexMessage('recent')]);
    const recentOnly = snapshotReader.runSnapshot(fixture.options);
    assert.equal(recentOnly.sessions.length, 1);
    assert.equal(recentOnly.instructions[0].text, 'recent');
  });
}

function loadReaderWithInternals(maxFiles, summaries) {
  const Module = require('node:module');
  const filename = require.resolve('../../scripts/lib/sessionSnapshotReader.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  let source = fs.readFileSync(filename, 'utf8');
  if (maxFiles !== undefined) source = source.replace('const MAX_FILES = 10000;', `const MAX_FILES = ${maxFiles};`);
  if (summaries !== undefined) source = source.replace('const LINK_LIMITS = { summaries: MAX_FILES };',
    `const LINK_LIMITS = { summaries: ${summaries} };`);
  loaded._compile(source + '\nmodule.exports.testInternals = '
    + '{ listFiles, summarizeTranscriptFile, groupTranscriptFiles, parseFile, '
    + 'computeInstructionFingerprint, computeInstructionRef, buildSnapshotInstruction, scanSessions, buildOrcaLinkCandidates, applyOrcaLinks };', filename);
  return { ...loaded.exports.testInternals, runSnapshot: loaded.exports.runSnapshot };
}

function assertNoOriginalRecords(value) {
  if (!value || typeof value !== 'object') {
    return;
  }
  if (value instanceof Map) {
    for (const entry of value.values()) {
      assertNoOriginalRecords(entry);
    }
    return;
  }
  assert.equal(Object.hasOwn(value, 'records'), false);
  for (const entry of Object.values(value)) {
    assertNoOriginalRecords(entry);
  }
}

test('PR1c metadata and grouped parse results retain no original record arrays or assistant payloads', testContext => {
  const fixture = createFixture(testContext);
  const rawSentinel = 'RAW_ASSISTANT_PAYLOAD_' + 'z'.repeat(1024 * 1024);
  for (let index = 0; index < 4; index++) {
    fixture.file('claude', `file-${index}`, [
      claudeUserRecord(`instruction ${index}`, { sessionId: `session-${index}` }),
      { type: 'assistant', timestamp: RECORD_TIMESTAMP, message: { content: rawSentinel } }
    ]);
  }
  const internals = loadReaderWithInternals();
  const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const files = internals.listFiles(path.join(fixture.options.homeDir, '.claude/projects'), coverage,
    { entries: 0, files: 0 });
  assert.equal(files.length, 4);
  assert.equal(coverage.files_scanned, 0);
  const groups = new Map();
  for (const file of files) {
    assertNoOriginalRecords(file);
    assert.equal(file.stats.isFile(), true);
    const summary = internals.summarizeTranscriptFile('claude', file, coverage,
      +SNAPSHOT_TIME - 14 * 86400000);
    assert.equal(summary.session.items.length, 1);
    internals.groupTranscriptFiles(groups, 'claude', summary);
    assertNoOriginalRecords(groups);
    for (const group of groups.values()) {
      for (const stored of group.files.values()) {
        assert.equal(JSON.stringify(stored).includes('RAW_ASSISTANT_PAYLOAD_'), false);
      }
    }
  }
  assert.equal(groups.size, 4);
  assert.equal(coverage.files_scanned, 4);
  assert.equal(coverage.records_unverified, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`PR1c ${provider} identity prefix uses complete records and the original identity precedence`, testContext => {
    const fixture = createFixture(testContext);
    const internals = loadReaderWithInternals();
    const identity = provider === 'claude'
      ? claudeUserRecord('old', { timestamp: OLD_RECORD_TIMESTAMP })
      : { ...codexSessionMeta(), timestamp: OLD_RECORD_TIMESTAMP };
    const file = fixture.file(provider, 'old', [null, { type: 'assistant' }, identity]);
    setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS[provider].map(key => [key, 0]));
    function summarizeOldFile() {
      return internals.summarizeTranscriptFile(provider, { file, stats: fs.lstatSync(file) }, coverage,
        +SNAPSHOT_TIME - 14 * 86400000);
    }
    const originalRead = fs.readSync;
    testContext.mock.method(fs, 'readSync', function readShortChunk(descriptor, buffer, offset, length, position) {
      return originalRead(descriptor, buffer, offset, Math.min(length, 17), position);
    });
    const short = summarizeOldFile();
    assert.equal(short.sessionId, 's');
    assert.equal(short.outsideWindow, true);
    assert.equal(Object.hasOwn(short, 'session'), false);
    // Spec §1.4: an unfinished prefix record needs the bounded full-file identity fallback.
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', padding: 'x'.repeat(64 * 1024) })
      + '\n' + JSON.stringify(identity));
    setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    assert.equal(summarizeOldFile().sessionId, 's');
    if (provider === 'codex') {
      fs.writeFileSync(file, [
        JSON.stringify(codexSessionMeta({ id: 'invalid/id' })), JSON.stringify(identity)
      ].join('\n'));
      setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
      assert.equal(summarizeOldFile().sessionId, 'invalid/id');
    }
    assert.equal(coverage.files_failed, 0);
    assert.equal(coverage.records_unknown, 0);
    assert.equal(coverage.records_unverified, 0);
  });
}

test('PR1c deferred reads still reject changed inodes and symlink replacements before reading', testContext => {
  const fixture = createFixture(testContext);
  const file = fixture.file('claude', 'original', [claudeUserRecord('original')]);
  const internals = loadReaderWithInternals();
  const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const metadata = internals.listFiles(path.dirname(file), coverage, { entries: 0, files: 0 });
  assert.equal(metadata.length, 1);
  const renamed = file + '.renamed';
  fs.renameSync(file, renamed);
  fs.writeFileSync(file, JSON.stringify(claudeUserRecord('replacement')));
  const totals = trackTranscriptReads(testContext, file);
  const boundary = +SNAPSHOT_TIME - 14 * 86400000;
  assert.equal(internals.summarizeTranscriptFile('claude', metadata[0], coverage, boundary), null);
  fs.unlinkSync(file);
  fs.symlinkSync(renamed, file);
  assert.equal(internals.summarizeTranscriptFile('claude', metadata[0], coverage, boundary), null);
  assert.equal(coverage.files_failed, 2);
  assert.equal(coverage.files_scanned, 0);
  assert.equal(totals.bytes, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`PR1c C ${provider} old files recover late identities without parsing content coverage`, testContext => {
    const fixture = createFixture(testContext);
    const anonymous = Array.from({ length: 1100 }, function anonymousRecord() {
      return { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP, padding: 'x'.repeat(80) };
    });
    const identity = provider === 'claude'
      ? claudeUserRecord('unknown old', { timestamp: OLD_RECORD_TIMESTAMP, origin: undefined })
      : { ...codexSessionMeta(), timestamp: OLD_RECORD_TIMESTAMP };
    const old = fixture.file(provider, 'a-old', [...anonymous, identity]);
    setTranscriptMtime(old, OLD_RECORD_TIMESTAMP);
    assert.ok(fs.statSync(old).size > 64 * 1024);
    fixture.file(provider, 'b-new', provider === 'claude'
      ? [claudeUserRecord('main')] : [codexSessionMeta(), codexMessage('main')]);
    const totals = trackTranscriptReads(testContext, old);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage[provider].multi_file_withheld, 1);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.instructions.length, 0);
    assert.ok(totals.bytes > 0);
    assert.equal(totals.bytes, 128 * 1024 + fs.statSync(old).size);
    assert.equal(snapshot.coverage[provider].records_unknown, 0);
    assert.equal(snapshot.coverage[provider].records_unverified, 0);
  });
}

test('PR1c C old unknown records do not contribute observed content coverage', testContext => {
  const fixture = createFixture(testContext);
  const old = fixture.file('claude', 'old', [
    claudeUserRecord('unknown', { timestamp: OLD_RECORD_TIMESTAMP, origin: undefined })
  ]);
  setTranscriptMtime(old, SNAPSHOT_TIME);
  assert.equal(snapshotReader.runSnapshot(fixture.options).coverage.claude.records_unknown, 1);
  setTranscriptMtime(old, OLD_RECORD_TIMESTAMP);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.files_scanned, 1);
  assert.equal(snapshot.coverage.claude.files_skipped, 1);
  assert.equal(snapshot.coverage.claude.records_unknown, 0);
});

for (const old of [false, true]) {
  test(`PR1c A pure Claude subagent files are skipped with old=${old}`, testContext => {
    const fixture = createFixture(testContext);
    fixture.file('claude', 'project/s', [claudeUserRecord('main one'), claudeUserRecord('main two', { uuid: 'v' })]);
    const timestamp = old ? OLD_RECORD_TIMESTAMP : RECORD_TIMESTAMP;
    const sidechain = fixture.file('claude', 'project/s/subagents/agent-x', [
      claudeUserRecord('subagent', { isSidechain: true, agentId: 'x', timestamp }),
      { type: 'assistant', isSidechain: true, sessionId: 's', timestamp }
    ]);
    if (old) setTranscriptMtime(sidechain, OLD_RECORD_TIMESTAMP);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.files_scanned, 2);
    assert.equal(snapshot.coverage.claude.files_skipped, 1);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.sessions[0].instruction_count, 2);
    assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['main one', 'main two']);
  });
}

for (const scenario of ['mixed', 'outside-directory', 'similar-directory', 'non-boolean']) {
  test(`PR1c A ${scenario} Claude files still participate in grouping`, testContext => {
    const fixture = createFixture(testContext);
    fixture.file('claude', 'project/s', [claudeUserRecord('main')]);
    const folder = scenario === 'outside-directory' ? 'other'
      : scenario === 'similar-directory' ? 'subagents-extra' : 'subagents';
    const rows = [claudeUserRecord('sidechain', { isSidechain: scenario === 'non-boolean' ? 'true' : true })];
    if (scenario === 'mixed') rows.push({ type: 'assistant', sessionId: 's', timestamp: RECORD_TIMESTAMP });
    fixture.file('claude', `project/s/${folder}/agent-x`, rows);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
    assert.equal(snapshot.coverage.claude.files_skipped, 0);
    assert.equal(snapshot.sessions.length, 0);
  });
}

function trackConfigMutations(testContext, configDir) {
  const totals = { operations: 0 };
  for (const name of ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'openSync']) {
    const original = fs[name];
    testContext.mock.method(fs, name, function countConfigMutation(target, ...args) {
      const writing = name !== 'openSync'
        || (args[0] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
      if (writing && typeof target === 'string' && target.startsWith(configDir)) totals.operations++;
      return original(target, ...args);
    });
  }
  return totals;
}

test('PR1c B reader labels initialize once and update only the label; no-op snapshots write zero', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'main', [claudeUserRecord('main')]);
  const options = { ...fixture.options, machineLabel: 'Mac' };
  const totals = trackConfigMutations(testContext, fixture.options.configDir);
  assert.equal(snapshotReader.runSnapshot(options).machine.label, 'Mac');
  assert.ok(totals.operations > 0);
  const before = fixture.config();
  totals.operations = 0;
  assert.equal(snapshotReader.runSnapshot({ ...options, machineLabel: 'codev2' }).machine.label, 'codev2');
  assert.ok(totals.operations > 0);
  const updated = fixture.config();
  updated.machine_label = before.machine_label;
  assert.equal(JSON.stringify(updated), JSON.stringify(before));
  for (const labelOptions of [{ ...options, machineLabel: 'codev2' }, fixture.options]) {
    totals.operations = 0;
    const bytes = fs.readFileSync(path.join(fixture.options.configDir, 'observe.json'));
    assert.equal(snapshotReader.runSnapshot(labelOptions).machine.label, 'codev2');
    assert.equal(totals.operations, 0);
    assert.deepEqual(fs.readFileSync(path.join(fixture.options.configDir, 'observe.json')), bytes);
  }
});

test('PR1c B label updates reread latest config under lock and preserve concurrent exclusion changes', testContext => {
  const fixture = createFixture(testContext);
  snapshotReader.loadConfig(fixture.options);
  const latest = fixture.config();
  latest.path_gen = 3;
  latest.exclude.sessions.push('claude:other');
  const originalOpen = fs.openSync;
  let locks = 0;
  testContext.mock.method(fs, 'openSync', function updateBeforeLock(file, ...args) {
    if (file === path.join(fixture.options.configDir, 'observe.json.lock')) {
      locks++;
      fixture.save(latest);
    }
    return originalOpen(file, ...args);
  });
  const snapshot = snapshotReader.runSnapshot({ ...fixture.options, machineLabel: 'codev2' });
  assert.equal(locks, 1);
  assert.equal(snapshot.machine.label, 'codev2');
  const updated = fixture.config();
  updated.machine_label = latest.machine_label;
  assert.equal(JSON.stringify(updated), JSON.stringify(latest));
});

test('PR1c B label updates respect busy locks and never repair unavailable keys', testContext => {
  const fixture = createFixture(testContext);
  snapshotReader.loadConfig(fixture.options);
  const options = { ...fixture.options, machineLabel: 'codev2' };
  const file = path.join(fixture.options.configDir, 'observe.json');
  fs.writeFileSync(file + '.lock', '');
  const before = fs.readFileSync(file);
  assertReaderError(() => snapshotReader.runSnapshot(options), 'config_busy');
  assert.deepEqual(fs.readFileSync(file), before);
  fs.unlinkSync(file + '.lock');
  const config = fixture.config();
  delete config.local_key;
  fixture.save(config);
  const broken = fs.readFileSync(file);
  const totals = trackConfigMutations(testContext, fixture.options.configDir);
  assertReaderError(() => snapshotReader.runSnapshot(options), 'key_unavailable');
  assert.equal(totals.operations, 0);
  assert.deepEqual(fs.readFileSync(file), broken);
});

for (const missing of ['file', 'key']) {
  test(`PR1c B label update refuses a missing ${missing} discovered after acquiring the lock`, testContext => {
    const fixture = createFixture(testContext);
    snapshotReader.loadConfig(fixture.options);
    const file = path.join(fixture.options.configDir, 'observe.json');
    const changed = fixture.config();
    delete changed.local_key;
    const originalOpen = fs.openSync;
    let locks = 0;
    testContext.mock.method(fs, 'openSync', function removeConfigBeforeLock(target, ...args) {
      if (target === file + '.lock') {
        locks++;
        if (missing === 'file') fs.unlinkSync(file);
        else fixture.save(changed);
      }
      return originalOpen(target, ...args);
    });
    assertReaderError(() => snapshotReader.runSnapshot({ ...fixture.options, machineLabel: 'codev2' }),
      'key_unavailable');
    assert.equal(locks, 1);
    assert.equal(fs.existsSync(file + '.lock'), false);
    if (missing === 'file') assert.equal(fs.existsSync(file), false);
    else assert.equal(JSON.stringify(fixture.config()), JSON.stringify(changed));
  });
}

const ORCA_TEXT_SENTINEL = 'ORCA_PRIVATE_TEXT_SENTINEL';

function installActualOrcaFixture(testContext) {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'main', [claudeUserRecord('abcdefgh')]);
  const worktree = {
    ...orcaWorktree('abcdefgh', 'synthetic-tab:synthetic-leaf'),
    worktreeId: 'synthetic-tree::/sensitive/repo', liveTerminalCount: 3,
    displayName: ORCA_TEXT_SENTINEL, comment: ORCA_TEXT_SENTINEL, preview: ORCA_TEXT_SENTINEL,
    title: ORCA_TEXT_SENTINEL, prompt: ORCA_TEXT_SENTINEL, taskTitle: ORCA_TEXT_SENTINEL
  };
  Object.assign(worktree.agents[0], {
    updatedAt: Date.parse(RECORD_TIMESTAMP) + 123,
    displayName: ORCA_TEXT_SENTINEL, taskTitle: ORCA_TEXT_SENTINEL, title: ORCA_TEXT_SENTINEL,
    preview: ORCA_TEXT_SENTINEL, lastAssistantMessage: ORCA_TEXT_SENTINEL,
    toolName: ORCA_TEXT_SENTINEL, toolInput: { content: ORCA_TEXT_SENTINEL }
  });
  const other = { ...orcaWorktree(ORCA_TEXT_SENTINEL, 'other-tab:other-leaf'),
    worktreeId: 'other-tree::/other/repo', path: '/other/repo' };
  const terminal = orcaTerminal({ worktreeId: worktree.worktreeId,
    tabId: 'synthetic-tab', leafId: 'synthetic-leaf', handle: 'term_synthetic',
    title: ORCA_TEXT_SENTINEL, preview: ORCA_TEXT_SENTINEL, displayName: ORCA_TEXT_SENTINEL,
    comment: ORCA_TEXT_SENTINEL, lastAssistantMessage: ORCA_TEXT_SENTINEL,
    prompt: ORCA_TEXT_SENTINEL, taskTitle: ORCA_TEXT_SENTINEL, toolInput: ORCA_TEXT_SENTINEL });
  const responses = {
    worktree: orcaResponse('worktrees', [worktree, other]),
    terminal: orcaResponse('terminals', [terminal, orcaTerminal({ worktreeId: other.worktreeId,
      tabId: 'other-tab', leafId: 'other-leaf', handle: 'term_other' })])
  };
  responses.worktree.result.hostScope = { private: ORCA_TEXT_SENTINEL };
  responses.terminal.result.topologyRevisions = { private: ORCA_TEXT_SENTINEL };
  responses.worktree._meta = { private: ORCA_TEXT_SENTINEL };
  fixture.options.runOrca = args => JSON.stringify(responses[args[0]]);
  return { fixture, responses };
}

function assertActualOrcaSnapshot(snapshot) {
  assert.deepEqual(snapshot.coverage.orca, { state: 'ok', code: null });
  assert.equal(snapshot.orca.worktrees.length, 2);
  assert.equal(snapshot.orca.terminals.length, 2);
  const worktree = snapshot.orca.worktrees[0];
  assert.equal(worktree.live_terminals, 3);
  assert.equal(worktree.last_activity_at, RECORD_TIMESTAMP);
  assert.equal(worktree.agents[0].state_started_at, RECORD_TIMESTAMP);
  assert.equal(worktree.agents[0].updated_at, '2026-10-08T02:00:00.123Z');
  assert.equal(snapshot.orca.terminals[0].last_output_at, RECORD_TIMESTAMP);
  assert.deepEqual(snapshot.sessions[0].orca_link, {
    evidence: 'prompt_exact', confirmed: true,
    pane_key: 'synthetic-tab:synthetic-leaf', terminal_handle: 'term_synthetic'
  });
  assert.deepEqual(Object.keys(worktree).sort(), [
    'agents', 'branch', 'last_activity_at', 'live_terminals', 'path_id', 'repo_label', 'status', 'worktree_id'
  ]);
  assert.deepEqual(Object.keys(worktree.agents[0]).sort(), [
    'agent_type', 'interrupted', 'pane_key', 'state', 'state_started_at', 'updated_at'
  ]);
  assert.deepEqual(Object.keys(snapshot.orca.terminals[0]).sort(), [
    'agent_identity', 'connected', 'handle', 'last_output_at', 'worktree_id'
  ]);
  assert.equal(JSON.stringify(snapshot).includes(ORCA_TEXT_SENTINEL), false);
}

test('PR1c D actual Orca envelopes project numeric times, counts, topology links and exact allowlists', testContext => {
  const { fixture } = installActualOrcaFixture(testContext);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assertActualOrcaSnapshot(snapshot);
  assert.equal(snapshotPolicy.validateSnapshot(snapshot).ok, true);
  assert.equal(JSON.stringify(snapshot.orca).includes('/sensitive/repo'), false);
});

test('PR1c D failed or malformed envelopes from either Orca command remain unavailable', testContext => {
  const { fixture, responses } = installActualOrcaFixture(testContext);
  assertActualOrcaSnapshot(snapshotReader.runSnapshot(fixture.options));
  for (const command of ['worktree', 'terminal']) {
    const original = responses[command];
    const collection = command === 'worktree' ? 'worktrees' : 'terminals';
    for (const invalid of [
      { ...original, ok: false }, { ...original, ok: 'true' }, { result: original.result },
      { ...original, result: null }, { ...original, result: [] },
      { ...original, result: { [collection]: {} } }, { ...original, result: {} },
      { ...original, result: { [collection]: null } }
    ]) {
      responses[command] = invalid;
      const snapshot = snapshotReader.runSnapshot(fixture.options);
      assert.deepEqual(snapshot.coverage.orca, { state: 'unavailable', code: 'orca_unavailable' });
      assert.deepEqual(snapshot.orca, { worktrees: [], terminals: [] });
      assert.equal(JSON.stringify(snapshot).includes(ORCA_TEXT_SENTINEL), false);
    }
    responses[command] = original;
  }
});

test('PR1c D truncation of either collection preserves projected items and marks partial', testContext => {
  const { fixture, responses } = installActualOrcaFixture(testContext);
  assertActualOrcaSnapshot(snapshotReader.runSnapshot(fixture.options));
  for (const command of ['worktree', 'terminal']) {
    responses[command].result.truncated = true;
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
    assert.equal(snapshot.orca.worktrees.length, 2);
    assert.equal(snapshot.orca.terminals.length, 2);
    assert.equal(snapshot.sessions[0].orca_link.terminal_handle, null);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
    assert.equal(snapshot.sessions[0].orca_link.evidence, 'prompt_exact');
    assert.equal(JSON.stringify(snapshot).includes(ORCA_TEXT_SENTINEL), false);
    responses[command].result.truncated = false;
  }
});

test('PR1c D terminal topology requires two strings and takes precedence over a legacy pane key', testContext => {
  const { fixture, responses } = installActualOrcaFixture(testContext);
  assertActualOrcaSnapshot(snapshotReader.runSnapshot(fixture.options));
  const terminal = responses.terminal.result.terminals[0];
  terminal.paneKey = 'synthetic-tab:synthetic-leaf';
  for (const [tabId, leafId] of [
    [null, 'synthetic-leaf'], ['synthetic-tab', 42], [undefined, 'synthetic-leaf'],
    ['synthetic-tab', undefined], ['another-tab', 'synthetic-leaf']
  ]) {
    terminal.tabId = tabId;
    terminal.leafId = leafId;
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.orca.state, 'ok');
    assert.equal(snapshot.sessions[0].orca_link.terminal_handle, null);
  }
  terminal.tabId = 'synthetic-tab';
  terminal.leafId = 'synthetic-leaf';
  terminal.paneKey = 'wrong:legacy';
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions[0].orca_link.terminal_handle, 'term_synthetic');
});

test('PR1c D numeric Orca TIME bounds stay enforced and numeric transcript timestamps stay invalid', testContext => {
  const { fixture, responses } = installActualOrcaFixture(testContext);
  assertActualOrcaSnapshot(snapshotReader.runSnapshot(fixture.options));
  const worktree = responses.worktree.result.worktrees[0];
  for (const invalidTime of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 253402300800000]) {
    worktree.lastActivityAt = invalidTime;
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.orca.state, 'partial');
    assert.equal(snapshot.orca.worktrees.length, 1);
    assert.equal(snapshot.orca.terminals.length, 1);
  }
  worktree.lastActivityAt = Date.parse(RECORD_TIMESTAMP);
  fixture.file('claude', 'numeric', [claudeUserRecord('NUMERIC_TRANSCRIPT_MUST_NOT_EXPORT', {
    sessionId: 'numeric', timestamp: Date.parse(RECORD_TIMESTAMP)
  })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
  assert.equal(snapshot.coverage.claude.invalid_time_withheld, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(JSON.stringify(snapshot).includes('NUMERIC_TRANSCRIPT_MUST_NOT_EXPORT'), false);
});

test('PR1c D bare arrays and legacy Orca field names retain their previous projections', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'main', [claudeUserRecord('abcdefgh')]);
  const worktree = orcaWorktree('abcdefgh', 'legacy-pane');
  delete worktree.liveTerminalCount;
  worktree.liveTerminals = 7;
  worktree.lastActivityAt = RECORD_TIMESTAMP;
  worktree.agents[0].stateStartedAt = RECORD_TIMESTAMP;
  worktree.agents[0].updatedAt = RECORD_TIMESTAMP;
  const terminal = orcaTerminal({ paneKey: 'legacy-pane', lastOutputAt: RECORD_TIMESTAMP });
  delete terminal.tabId;
  delete terminal.leafId;
  fixture.options.runOrca = args => JSON.stringify(args[0] === 'worktree' ? [worktree] : [terminal]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.orca.state, 'ok');
  assert.equal(snapshot.orca.worktrees[0].live_terminals, 7);
  assert.equal(snapshot.sessions[0].orca_link.terminal_handle, 'h');
});

// Spec §1.1: title selection follows file order, independently of instruction timestamps.
test('PR1c E timestamp-less AI titles use the last string in file order', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'titles', [
    { type: 'ai-title', aiTitle: 'earlier title', sessionId: 's' },
    claudeUserRecord('instruction'),
    { type: 'ai-title', aiTitle: 'last title', sessionId: 's' },
    { type: 'ai-title', aiTitle: 42, sessionId: 's' },
    { type: 'ai-title', aiTitle: { text: 'invalid title' }, sessionId: 's' }
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.sessions[0].ai_title, 'last title');
});

test('PR1c E timestamp-less AI titles retain the 200-character sanitized fixed point', testContext => {
  const fixture = createFixture(testContext);
  const title = `Research ${SECRET_SENTINEL} ` + 'x'.repeat(300);
  fixture.file('claude', 'secret-title', [
    claudeUserRecord('instruction'),
    { type: 'ai-title', aiTitle: title, sessionId: 's' }
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  const displayed = snapshot.sessions[0].ai_title;
  assert.equal(typeof displayed, 'string');
  assert.equal(displayed.length, 200);
  assert.equal(displayed.startsWith('Research [REDACTED] '), true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  assert.equal(snapshotPolicy.finalizeText(displayed, 200).value, displayed);
});

test('PR1c E absent or nonstring AI titles remain null', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'absent', [claudeUserRecord('no title', { sessionId: 'absent' })]);
  fixture.file('claude', 'invalid', [
    claudeUserRecord('invalid title', { sessionId: 'invalid' }),
    { type: 'ai-title', aiTitle: 42, sessionId: 'invalid' }
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 2);
  assert.deepEqual(snapshot.sessions.map(session => session.ai_title), [null, null]);
});

test('PR1c E slash display preserves sanitized raw command wrappers', testContext => {
  const fixture = createFixture(testContext);
  const cases = [
    '<command-message>deep-research</command-message>',
    '<command-name>deep-research</command-name><command-message>ignored</command-message>'
      + '<command-args></command-args>',
    '<command-message>ignored</command-message><command-args>scripts/lib</command-args>'
      + '<command-name>///review</command-name>',
    '<command-name>/review</command-name><command-args>scripts/lib</command-args>'
      + '<command-message>ignored</command-message>',
    '<command-message>review</command-message><command-args>scripts/lib</command-args>',
    `<command-message>review</command-message><command-args>${SECRET_SENTINEL}</command-args>`
  ];
  fixture.file('claude', 'slash', cases.map((text, index) => claudeUserRecord(text, {
    uuid: `slash-${index}`, origin: undefined
  })));
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.instructions.length, cases.length);
  assert.deepEqual(snapshot.instructions.map(item => item.kind), cases.map(() => 'slash'));
  assert.deepEqual(snapshot.instructions.map(item => item.text),
    cases.map(text => snapshotPolicy.finalizeText(text).value));
  assert.equal(snapshot.instructions.at(-1).redacted, true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  for (const item of snapshot.instructions) {
    assert.equal(snapshotPolicy.finalizeText(item.text).value, item.text);
  }
});

test('PR1c E already-classified slash display preserves every tag order and tagless text', () => {
  const { buildSnapshotInstruction } = loadReaderWithInternals();
  const tags = ['<command-name>/review</command-name>', '<command-message>ignored</command-message>',
    '<command-args>scripts/lib</command-args>'];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const instruction = { id: 'claude:s:uone', ts: RECORD_TIMESTAMP, kind: 'slash', attachments: 0,
    ref: '0'.repeat(16) };
  for (const order of orders) {
    const text = order.map(index => tags[index]).join('\n');
    const displayed = buildSnapshotInstruction({ ...instruction, text }, 'session-key', 0);
    assert.equal(displayed.kind, 'slash');
    assert.equal(displayed.text, text);
  }
  const text = '/legacy scripts/lib';
  assert.equal(buildSnapshotInstruction({ ...instruction, text }, 'session-key', 0).text, text);
});

// Spec §2/§3: full raw slash text defines content identity; UUID exclusions remain stable.
test('PR1c E slash raw fingerprints and refs retain UUID exclusion behavior', testContext => {
  const fixture = createFixture(testContext);
  const texts = [
    '<command-message>deep-research</command-message><command-name>/deep-research</command-name>'
      + '<command-args></command-args>',
    '<command-message>review</command-message><command-args>scripts/lib</command-args>'
      + '<command-name>///review</command-name>',
    `<command-message>review</command-message><command-args>${SECRET_SENTINEL}</command-args>`
  ];
  const records = texts.map((text, index) => claudeUserRecord(text, { uuid: `slash-${index}`, origin: undefined }));
  fixture.file('claude', 'identity', records);
  const config = snapshotReader.loadConfig(fixture.options);
  config.machine_id = 'fixture-machine';
  config.local_key = 'b'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  fixture.save(config);
  const internals = loadReaderWithInternals();
  const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const parsed = internals.parseFile('claude', records, coverage, config);
  assert.equal(parsed.items.length, 3);
  const fingerprints = [
    '94eb5f2b817a556ad742fa3d2d2b0bea12e96ac35d01ff0b2dd7d55667a37094',
    '0740567e608dcb3f9cc3eb84f04774273bb27a7ff2973537a39c491aa51286cb',
    '28a5f010bef82768ce706cc6857c5548d475b9d3c4c819d9464a1c9fed046c15'
  ];
  const refs = ['014a92d7966c8433', '228dfccb7b62036c', '2380af646df14750'];
  for (const [index, instruction] of parsed.items.entries()) {
    assert.equal(Object.hasOwn(instruction, 'structure'), false);
    assert.equal(instruction.fp, fingerprints[index]);
    assert.equal(instruction.ref, refs[index]);
  }
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 3);
  assert.deepEqual(snapshot.instructions.map(item => item.ref), refs);
  assert.deepEqual(snapshot.instructions.map(item => item.text),
    texts.map(text => snapshotPolicy.finalizeText(text).value));
  const target = { kind: 'instruction', instrId: 'claude:s:uslash-1', ref: refs[1] };
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(preview.preview, snapshotPolicy.finalizeText(texts[1], 200).value);
  const result = snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token });
  assert.equal(result.counts.registered, 1);
  const excluded = snapshotReader.runSnapshot(fixture.options);
  assert.equal(excluded.instructions.length, 2);
  assert.deepEqual(excluded.instructions.map(item => item.ref), [refs[0], refs[2]]);
});

// Spec §1.1/§2: raw display preserves human classification and content identity.
test('PR1c correction 1 human command wrappers preserve legacy fingerprint ref and deletion identity', testContext => {
  const fixture = createFixture(testContext);
  const text = ' \n<command-message>ignored</command-message><command-name>///review</command-name>'
    + '\n<command-args>scripts/lib</command-args>\t';
  const record = claudeUserRecord(text, { uuid: 'human-wrapper' });
  fixture.file('claude', 'human-wrapper', [record]);
  const config = snapshotReader.loadConfig(fixture.options);
  config.machine_id = 'fixture-machine';
  config.local_key = 'b'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  fixture.save(config);
  const internals = loadReaderWithInternals();
  const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const parsed = internals.parseFile('claude', [record], coverage, config);
  assert.equal(parsed.items.length, 1);
  const instruction = parsed.items[0];
  assert.equal(instruction.kind, 'human');
  assert.equal(instruction.text, snapshotPolicy.finalizeText(text).value);
  assert.equal(Object.hasOwn(instruction, 'structure'), false);
  assert.equal(instruction.fp, '09ba6cf30247bdc65057edb2e3df860bc83976aa2f092014760f724bf1be8f14');
  const ref = '230bb5cd26e1217d';
  assert.equal(instruction.ref, ref);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].id, 'claude:s:uhuman-wrapper');
  assert.equal(snapshot.instructions[0].kind, 'human');
  assert.equal(snapshot.instructions[0].ref, ref);
  assert.equal(snapshot.instructions[0].text, snapshotPolicy.finalizeText(text).value);
  const target = { kind: 'instruction', instrId: 'claude:s:uhuman-wrapper', ref };
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).counts.registered, 1);
  assert.equal(snapshotReader.runSnapshot(fixture.options).instructions.length, 0);
});

test('PR1c correction 1 human raw wrapper text preserves every order and sanitizes command arguments', testContext => {
  const fixture = createFixture(testContext);
  const tags = ['<command-name>/review</command-name>', '<command-message>ignored</command-message>',
    '<command-args>scripts/lib</command-args>'];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const records = orders.map((order, index) => claudeUserRecord(
    ' \n' + order.map(tagIndex => tags[tagIndex]).join('\n') + ' \t', { uuid: `human-${index}` }));
  records.push(claudeUserRecord(
    `<command-message>review</command-message><command-args>${SECRET_SENTINEL}</command-args>`,
    { uuid: 'human-secret' }));
  fixture.file('claude', 'orders', records);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 7);
  assert.deepEqual(snapshot.instructions.map(item => item.kind), records.map(() => 'human'));
  assert.deepEqual(snapshot.instructions.map(item => item.text),
    records.map(record => snapshotPolicy.finalizeText(record.message.content).value));
  assert.equal(snapshot.instructions.at(-1).redacted, true);
  assert.equal(JSON.stringify(snapshot).includes(SECRET_SENTINEL), false);
  for (const item of snapshot.instructions) {
    assert.equal(snapshotPolicy.finalizeText(item.text).value, item.text);
  }
});

test('PR1c correction 1 outside text remains in human and slash displays', testContext => {
  const fixture = createFixture(testContext);
  const wrapper = '<command-message>review</command-message><command-name>/review</command-name>'
    + '<command-args>scripts/lib</command-args>';
  const cases = [
    [wrapper + ' Please also check tests.', 'human'],
    ['Please also check tests. ' + wrapper, 'human'],
    ['<command-message>review</command-message> Please also check tests.'
      + '<command-name>/review</command-name><command-args>scripts/lib</command-args>', 'human'],
    [wrapper + '<other>extra</other>', 'human'],
    [wrapper + '<command-args>unfinished', 'human'],
    [wrapper + ' Please also check tests.', 'slash'],
    ['<command-message>review</command-message> Please also check tests.'
      + '<command-name>/review</command-name><command-args>scripts/lib</command-args>', 'slash']
  ];
  fixture.file('claude', 'outside', cases.map(([text, kind], index) => claudeUserRecord(text, {
    uuid: `outside-${index}`, origin: kind === 'human' ? { kind: 'human' } : undefined
  })));
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, cases.length);
  assert.deepEqual(snapshot.instructions.map(item => item.kind), cases.map(([, kind]) => kind));
  assert.deepEqual(snapshot.instructions.map(item => item.text),
    cases.map(([text]) => snapshotPolicy.finalizeText(text).value));
});

for (const kind of ['slash', 'human']) {
  test(`PR1c R1 raw wrappers preserve original sanitization context for ${kind}`, testContext => {
    const fixture = createFixture(testContext);
    const origin = kind === 'human' ? { kind: 'human' } : undefined;
    const normal = '<command-name>/review</command-name><command-args>scripts/lib</command-args>';
    const attack = '<command-name>/review</command-name><command-args>password="LEAK_ME</command-args>'
      + '<command-message>"</command-message>';
    fixture.file('claude', 'wrappers', [
      claudeUserRecord(normal, { uuid: 'normal', origin }),
      claudeUserRecord(attack, { uuid: 'attack', origin })
    ]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.instructions.length, 2);
    assert.equal(snapshot.instructions[0].text, normal);
    assert.equal(snapshot.instructions[0].kind, kind);
    assert.equal(snapshotPolicy.finalizeText(attack).redacted, true);
    assert.equal(JSON.stringify(snapshot).includes('LEAK_ME'), false);
    assert.equal(snapshot.instructions[1].text, snapshotPolicy.finalizeText(attack).value);
    assert.equal(snapshot.instructions[1].kind, kind);
    assert.equal(snapshot.instructions[1].redacted, true);
  });
}

test('PR1c R1 old subagent prefix cannot prove all records are sidechain', testContext => {
  const fixture = createFixture(testContext);
  const prefix = Array.from({ length: 800 }, function sidechainRecord() {
    return { type: 'assistant', sessionId: 's', isSidechain: true, timestamp: OLD_RECORD_TIMESTAMP,
      padding: 'x'.repeat(80) };
  });
  const old = fixture.file('claude', 'project/s/subagents/agent-mixed', [
    ...prefix, claudeUserRecord('old main', { timestamp: OLD_RECORD_TIMESTAMP })
  ]);
  assert.ok(Buffer.byteLength(prefix.map(record => JSON.stringify(record)).join('\n')) > 64 * 1024);
  setTranscriptMtime(old, OLD_RECORD_TIMESTAMP);
  fixture.file('claude', 'recent', [claudeUserRecord('recent main')]);
  const totals = trackTranscriptReads(testContext, old);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.files_skipped, 0);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.instructions.length, 0);
  assert.ok(totals.bytes > 0);
  assert.equal(snapshot.coverage.claude.records_unknown, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`PR1c R1 ${provider} preserved old mtime cannot change snapshot refs or exclusion tokens`, testContext => {
    const fixture = createFixture(testContext);
    const rows = provider === 'claude' ? [claudeUserRecord('recent instruction')]
      : [codexSessionMeta(), codexMessage('recent instruction')];
    const file = fixture.file(provider, 'recent', rows);
    const before = snapshotReader.runSnapshot(fixture.options);
    assert.equal(before.instructions.length, 1);
    const target = instructionTarget(before.instructions[0]);
    const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
    setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    const after = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(after, before);
    const rechecked = snapshotReader.excludeQuery({ ...fixture.options, target });
    assert.deepEqual(rechecked, preview);
    const committed = snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token });
    assert.equal(committed.code, 'ok');
    assert.equal(committed.counts.registered, 1);
    assert.equal(snapshotReader.runSnapshot(fixture.options).instructions.length, 0);
  });
}

test('PR1c R1 missing tail timestamp reads fully while old tail timestamps keep identity-only coverage',
  testContext => {
  const fixture = createFixture(testContext);
  const recent = fixture.file('claude', 'a-recent', [
    claudeUserRecord('recent instruction'),
    { type: 'assistant', padding: 'x'.repeat(128 * 1024) }
  ]);
  setTranscriptMtime(recent, OLD_RECORD_TIMESTAMP);
  const totals = trackTranscriptReads(testContext, recent);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'recent instruction');
  assert.ok(totals.bytes > 0);
  fs.unlinkSync(recent);
  const old = fixture.file('claude', 'b-old', [
    claudeUserRecord('unknown old', { origin: undefined, timestamp: OLD_RECORD_TIMESTAMP }),
    { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP, padding: 'x'.repeat(128 * 1024) },
    { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP }
  ]);
  setTranscriptMtime(old, OLD_RECORD_TIMESTAMP);
  const oldTotals = trackTranscriptReads(testContext, old);
  const outside = snapshotReader.runSnapshot(fixture.options);
  assert.equal(outside.instructions.length, 0);
  assert.equal(outside.coverage.claude.records_unknown, 0);
  assert.equal(outside.coverage.claude.records_unverified, 0);
  assert.equal(oldTotals.fullReads, 0);
  assert.equal(oldTotals.bytes, 128 * 1024);
});

function countStoredStringCharacters(value) {
  if (typeof value === 'string') {
    return value.length;
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  return Object.values(value).reduce((sum, entry) => sum + countStoredStringCharacters(entry), 0);
}

test('PR1c R1 large instructions retain bounded sanitized text and pre-change fingerprints and refs', testContext => {
  const fixture = createFixture(testContext);
  const body = 'LARGE_HUMAN_SENTINEL_' + 'x'.repeat(2 * 1024 * 1024) + '\npassword="PRIVATE_LARGE_VALUE"';
  for (const provider of ['claude', 'codex']) {
    for (let index = 0; index < 3; index++) {
      fixture.file(provider, `large-${index}`, provider === 'claude' ? [
        claudeUserRecord(body, { sessionId: `large-${index}`, uuid: 'large' })
      ] : [codexSessionMeta({ id: `large-${index}` }), codexMessage(body)]);
    }
  }
  const config = snapshotReader.loadConfig(fixture.options);
  config.machine_id = 'fixture-machine';
  config.local_key = 'b'.repeat(64);
  config.key_fingerprint = crypto.createHash('sha256').update(config.local_key).digest('hex');
  fixture.save(config);
  const { scanSessions } = loadReaderWithInternals();
  const scanned = scanSessions(fixture.options, config);
  assert.equal(scanned.all.length, 6);
  const items = scanned.all.flatMap(session => session.items);
  assert.equal(items.length, 6);
  const storedCharacters = countStoredStringCharacters(scanned);
  testContext.diagnostic(`Retained ${storedCharacters} string characters for ${items.length} instructions`);
  assert.ok(storedCharacters <= items.length * 2400 + scanned.all.length * (4096 + 64));
  for (const session of scanned.all) {
    const item = session.items[0];
    assert.equal(item.text.length, 2000);
    assert.equal(item.redacted, true);
    assert.equal(item.truncated, true);
    assert.equal(Object.hasOwn(item, 'structure'), false);
    assert.equal(Object.hasOwn(item, 'displayText'), false);
    assert.equal(snapshotPolicy.finalizeText(item.text).value, item.text);
    assert.equal(item.fp, '32292a1c53fa996395405d287acf5850e86891f52b16df37fc2675c78803a1fc');
    if (session.sid === 'large-0') {
      assert.equal(item.ref, session.provider === 'claude' ? '4fac5f99c15c819c' : '5fb366e753bb839b');
    }
  }
  assert.equal(JSON.stringify(scanned).includes('PRIVATE_LARGE_VALUE'), false);
});

test('PR1c R1 Orca evidence uses full raw instruction identity', testContext => {
  const fixture = createFixture(testContext);
  const cases = [
    ['ordinary word '.repeat(250), snapshotReader.orcaPromptForm('ordinary word '.repeat(250)).value, 'prompt_trunc'],
    ['review password="ORCA_PRIVATE_VALUE"', 'review password="ORCA_PRIVATE_VALUE"', 'prompt_exact'],
    ['review password="ORCA_PRIVATE_VALUE"', 'review [REDACTED]', 'cwd_only']
  ];
  for (const [text, prompt, evidence] of cases) {
    fixture.file('claude', 'link', [claudeUserRecord(text)]);
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], [orcaTerminal()]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.instructions.length, 1);
    assert.equal(snapshot.sessions[0].orca_link.evidence, evidence);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, ['prompt_exact', 'prompt_trunc'].includes(evidence));
    assert.equal(JSON.stringify(snapshot).includes('ORCA_PRIVATE_VALUE'), false);
  }
});

test('PR1c R3 slash outside sentences change raw display refs and confirmation tokens', testContext => {
  const fixture = createFixture(testContext);
  const wrapper = '<command-name>/review</command-name><command-args>scripts/lib</command-args>';
  fixture.file('claude', 'slash', [claudeUserRecord(wrapper + ' Outside sentence A.', { origin: undefined })]);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 1);
  assert.equal(before.instructions[0].kind, 'slash');
  assert.equal(before.instructions[0].text, wrapper + ' Outside sentence A.');
  const target = instructionTarget(before.instructions[0]);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  fixture.file('claude', 'slash', [claudeUserRecord(wrapper + ' Outside sentence B.', { origin: undefined })]);
  const after = snapshotReader.runSnapshot(fixture.options);
  assert.equal(after.instructions[0].text, wrapper + ' Outside sentence B.');
  assert.notEqual(after.instructions[0].ref, before.instructions[0].ref);
  assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options, target }), 'target_changed');
  const result = snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token });
  assert.equal(result.code, 'confirm_mismatch');
  assert.equal(result.counts.registered, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`PR1c R2 ${provider} summary bounds metadata and drops oversized cwd before projection`, testContext => {
    const fixture = createFixture(testContext);
    const branch = 'feature/' + 'branch'.repeat(1000);
    const cwd = '/' + 'directory/'.repeat(1000);
    const body = 'ordinary instruction '.repeat(200);
    const file = fixture.file(provider, 'bounds', provider === 'claude' ? [
      claudeUserRecord(body, { cwd, gitBranch: branch }),
      { type: 'ai-title', aiTitle: 'title '.repeat(100), sessionId: 's' }
    ] : [codexSessionMeta({ cwd, git: { branch } }), codexMessage(body)]);
    const config = snapshotReader.loadConfig(fixture.options);
    const { scanSessions, parseFile } = loadReaderWithInternals();
    const scanned = scanSessions(fixture.options, config);
    assert.equal(scanned.all.length, 0);
    assert.equal(scanned.coverage[provider].records_unverified, 1);
    const counters = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS[provider].map(key => [key, 0]));
    const records = fs.readFileSync(file, 'utf8').split('\n').map(line => JSON.parse(line));
    const session = parseFile(provider, records, counters, config);
    assert.equal(session.cwd, null);
    assert.equal(session.branch, snapshotPolicy.finalizeLabel(branch).value);
    assert.equal(session.branch.length, 64);
    assert.equal(session.items[0].text.length, 2000);
    if (provider === 'claude') {
      assert.equal(session.title.length, 200);
    }
    const originalOpaquePath = snapshotPolicy.opaquePath;
    testContext.mock.method(snapshotPolicy, 'opaquePath', function rejectOversizedPath(salt, generation, rawPath) {
      assert.notEqual(rawPath, cwd);
      assert.notEqual(rawPath, null);
      return originalOpaquePath(salt, generation, rawPath);
    });
    fixture.options.runOrca = orcaRunner([orcaWorktree(body)], [orcaTerminal()]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.instructions.length, 0);
    assert.equal(snapshot.coverage[provider].records_unverified, 1);
    fs.unlinkSync(file);
    fixture.file(provider, 'boundary', provider === 'claude' ? [
      claudeUserRecord('valid cwd', { cwd: '/' + 'x'.repeat(4095) })
    ] : [codexSessionMeta({ cwd: '/' + 'x'.repeat(4095) }), codexMessage('valid cwd')]);
    assert.equal(snapshotReader.runSnapshot(fixture.options).instructions.length, 1);
  });
}

function runSmallHeapSnapshot(fixture, scenario) {
  const { spawnSync } = require('node:child_process');
  const source = [
    "const assert = require('node:assert/strict');",
    'const reader = require(process.argv[1]);',
    'const options = JSON.parse(process.argv[2]);',
    'options.now = new Date(options.now);',
    'options.runOrca = function unavailableOrca() { return null; };',
    'const snapshot = reader.runSnapshot(options);',
    'const expected = process.argv[3] === "text" ? 33 : 1;',
    'assert.equal(snapshot.sessions.length, expected);',
    'assert.equal(snapshot.instructions.length, expected);',
    'assert.equal(snapshot.coverage.claude.files_scanned, 33);',
    'assert.equal(snapshot.coverage.claude.files_failed, 0);',
    'assert.equal(snapshot.coverage.claude.files_skipped, 0);',
    'assert.equal(snapshot.coverage.claude.records_unverified, expected === 1 ? 32 : 0);',
    'assert.ok(snapshot.instructions.some(item => item.text === "control survives"));',
    'process.stdout.write(JSON.stringify({sessions: expected, heap: process.memoryUsage().heapUsed}));'
  ].join('\n');
  return spawnSync(process.execPath, ['--max-old-space-size=64', '-e', source,
    require.resolve('../../scripts/lib/sessionSnapshotReader.cjs'), JSON.stringify(fixture.options), scenario], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024, cwd: fixture.root,
    env: { ...process.env, HOME: fixture.options.homeDir }
  });
}

for (const scenario of ['text', 'metadata']) {
  test(`PR1c R2 detached ${scenario} strings survive a 64MB child heap`, { timeout: 120000 }, testContext => {
    const fixture = createFixture(testContext);
    const body = 'ordinary instruction '.repeat(100000);
    const metadata = 'directory/'.repeat(220000);
    assert.ok(body.length >= 2 * 1024 * 1024);
    assert.ok(metadata.length >= 2 * 1024 * 1024);
    for (let index = 0; index < 32; index++) {
      fixture.file('claude', `large-${index}`, [claudeUserRecord(body, {
        sessionId: `large-${index}`,
        cwd: scenario === 'metadata' ? '/' + metadata : '/sensitive/repo',
        gitBranch: scenario === 'metadata' ? metadata : 'main'
      })]);
    }
    fixture.file('claude', 'control', [claudeUserRecord('control survives', { sessionId: 'control' })]);
    const child = runSmallHeapSnapshot(fixture, scenario);
    const oom = /heap out of memory|Reached heap limit|Allocation failed/.test(child.stderr || '');
    testContext.diagnostic(`${scenario} child: status=${child.status}, signal=${child.signal}, oom=${oom}`);
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr.slice(-1000));
    assert.equal(child.signal, null);
    const result = JSON.parse(child.stdout);
    assert.equal(result.sessions, scenario === 'text' ? 33 : 1);
  });
}

function writeHeapRunner(fixture) {
  const runnerPath = path.join(fixture.root, 'heap-runner.cjs');
  const source = [
    "const assert = require('node:assert/strict');",
    'const reader = require(process.argv[2]);',
    'const options = JSON.parse(process.argv[3]);',
    'options.now = new Date(options.now);',
    'options.runOrca = function unavailableOrca() { return null; };',
    'const snapshot = reader.runSnapshot(options);',
    'assert.equal(snapshot.sessions.length, 9);',
    'assert.equal(snapshot.instructions.length, 9);',
    'assert.equal(snapshot.coverage.claude.files_scanned, 33);',
    'assert.equal(snapshot.coverage.claude.files_failed, 0);',
    'assert.equal(snapshot.coverage.claude.files_skipped, 0);',
    'assert.equal(snapshot.coverage.claude.records_unverified, 24);',
    'assert.equal(snapshot.instructions.filter(item => item.text.length === 2000 && item.truncated).length, 8);',
    'assert.ok(snapshot.instructions.some(item => item.text === "control survives"));',
    'process.stdout.write(JSON.stringify({sessions: snapshot.sessions.length}) + "\\n");'
  ].join('\n');
  fs.writeFileSync(runnerPath, source);
  return runnerPath;
}

test('PR1c R2 temporary runner retains bounded strings under a 64MB heap', { timeout: 120000 }, testContext => {
  const { spawnSync } = require('node:child_process');
  const fixture = createFixture(testContext);
  const body = 'ordinary instruction '.repeat(100000);
  const metadata = 'directory/'.repeat(220000);
  assert.ok(body.length >= 2 * 1024 * 1024);
  assert.ok(metadata.length >= 2 * 1024 * 1024);
  for (let index = 0; index < 32; index++) {
    fixture.file('claude', `large-${index}`, [claudeUserRecord(body, {
      sessionId: `large-${index}`,
      cwd: index < 24 ? '/' + metadata : '/sensitive/repo',
      gitBranch: metadata
    })]);
  }
  fixture.file('claude', 'control', [claudeUserRecord('control survives', { sessionId: 'control' })]);
  const runnerPath = writeHeapRunner(fixture);
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', runnerPath,
    require.resolve('../../scripts/lib/sessionSnapshotReader.cjs'), JSON.stringify(fixture.options)], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024, cwd: fixture.root,
    env: { ...process.env, HOME: fixture.options.homeDir }
  });
  testContext.diagnostic(`file runner: status=${child.status}, signal=${child.signal}, `
    + `sessions=${child.stdout.trim()}`);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr.slice(-1000));
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), { sessions: 9 });
});

test('PR1c R2 partial Orca inventories cannot confirm links or assign terminal handles', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'main', [claudeUserRecord('abcdefgh')]);
  const worktree = orcaWorktree('abcdefgh');
  const terminal = orcaTerminal();
  const responses = { worktree: orcaResponse('worktrees', [worktree]),
    terminal: orcaResponse('terminals', [terminal]) };
  fixture.options.runOrca = args => JSON.stringify(responses[args[0]]);
  const complete = snapshotReader.runSnapshot(fixture.options);
  assert.equal(complete.coverage.orca.state, 'ok');
  assert.equal(complete.sessions[0].orca_link.confirmed, true);
  assert.equal(complete.sessions[0].orca_link.terminal_handle, 'h');
  const competing = { ...worktree.agents[0], paneKey: 'other:leaf' };
  worktree.agents.push(competing);
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions[0].orca_link.evidence, 'ambiguous');
  worktree.agents.pop();
  for (const command of ['worktree', 'terminal']) {
    responses[command].result.truncated = true;
    const partial = snapshotReader.runSnapshot(fixture.options);
    assert.equal(partial.coverage.orca.state, 'partial');
    assert.equal(partial.sessions[0].orca_link.evidence, 'prompt_exact');
    assert.equal(partial.sessions[0].orca_link.confirmed, false);
    assert.equal(partial.sessions[0].orca_link.terminal_handle, null);
    responses[command].result.truncated = false;
  }
  responses.terminal.result.terminals.push({ handle: 'invalid' });
  const latePartial = snapshotReader.runSnapshot(fixture.options);
  assert.equal(latePartial.coverage.orca.state, 'partial');
  assert.equal(latePartial.sessions[0].orca_link.confirmed, false);
  assert.equal(latePartial.sessions[0].orca_link.terminal_handle, null);
  responses.terminal.result.terminals.pop();
  responses.worktree.result.worktrees.push(...Array.from({ length: snapshotPolicy.SNAPSHOT_LIMITS.worktrees },
    function unrelatedWorktree(_, index) {
      return { ...worktree, worktreeId: `other-${index}`, path: '/other/repo', agents: [] };
    }));
  const capped = snapshotReader.runSnapshot(fixture.options);
  assert.equal(capped.coverage.orca.state, 'partial');
  assert.equal(capped.sessions[0].orca_link.confirmed, false);
  assert.equal(capped.sessions[0].orca_link.terminal_handle, null);
});

test('PR1c R3 slash raw context changes refs and invalidates exclusion confirmations', testContext => {
  const fixture = createFixture(testContext);
  const wrapper = '<command-name>/review</command-name>';
  const beforeText = wrapper + ' password="<command-args>LEAK_ME</command-args>"';
  const afterText = wrapper + ' memo="<command-args>LEAK_ME</command-args>"';
  fixture.file('claude', 'slash', [claudeUserRecord(beforeText, { origin: undefined })]);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 1);
  assert.equal(before.instructions[0].kind, 'slash');
  assert.equal(JSON.stringify(before).includes('LEAK_ME'), false);
  const target = instructionTarget(before.instructions[0]);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  fixture.file('claude', 'slash', [claudeUserRecord(afterText, { origin: undefined })]);
  const after = snapshotReader.runSnapshot(fixture.options);
  assert.equal(after.instructions.length, 1);
  assert.notEqual(after.instructions[0].ref, before.instructions[0].ref);
  assert.equal(after.instructions[0].id, before.instructions[0].id);
  assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options, target }), 'target_changed');
  const configBefore = fs.readFileSync(path.join(fixture.options.configDir, 'observe.json'));
  const committed = snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token });
  assert.equal(committed.code, 'confirm_mismatch');
  assert.equal(committed.counts.registered, 0);
  assert.deepEqual(fs.readFileSync(path.join(fixture.options.configDir, 'observe.json')), configBefore);
  assert.equal(before.instructions[0].text, snapshotPolicy.finalizeText(beforeText).value);
  assert.equal(after.instructions[0].text, snapshotPolicy.finalizeText(afterText).value);
});

test('PR1c R3 long slash arguments keep the sanitized raw prefix and report truncation', testContext => {
  const fixture = createFixture(testContext);
  const text = '<command-name>/review</command-name><command-args>LONG_ARGS_' + 'x'.repeat(2100)
    + ' password="LONG_PRIVATE_VALUE"</command-args>';
  fixture.file('claude', 'long-slash', [claudeUserRecord(text, { origin: undefined })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  const instruction = snapshot.instructions[0];
  assert.equal(instruction.kind, 'slash');
  assert.equal(instruction.text, snapshotPolicy.finalizeText(text).value);
  assert.equal(instruction.text.includes('LONG_ARGS_'), true);
  assert.equal(instruction.text.length, 2000);
  assert.equal(instruction.truncated, true);
  assert.equal(instruction.redacted, true);
  assert.equal(JSON.stringify(snapshot).includes('LONG_PRIVATE_VALUE'), false);
  assert.equal(snapshotPolicy.finalizeText(instruction.text).value, instruction.text);
});

test('PR1c R3 Orca compares the full raw instruction instead of its 2000-character display', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'long-link', [claudeUserRecord('ordinary instruction')]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('ordinary instruction')], [orcaTerminal()]);
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions[0].orca_link.confirmed, true);
  const text = 'ordinary '.repeat(300);
  fixture.file('claude', 'long-link', [claudeUserRecord(text)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(text.slice(0, 2000))], [orcaTerminal()]);
  const prefix = snapshotReader.runSnapshot(fixture.options);
  assert.equal(prefix.instructions.length, 1);
  assert.equal(prefix.sessions[0].orca_link.evidence, 'cwd_only');
  assert.equal(prefix.sessions[0].orca_link.confirmed, false);
  fixture.options.runOrca = orcaRunner([orcaWorktree(snapshotReader.orcaPromptForm(text).value)], [orcaTerminal()]);
  const exact = snapshotReader.runSnapshot(fixture.options);
  assert.equal(exact.sessions[0].orca_link.evidence, 'prompt_trunc');
  assert.equal(exact.sessions[0].orca_link.confirmed, true);
});

test('PR1c R3 raw link summaries retain only the last chronological instruction and a 4096-character prefix',
  testContext => {
  const fixture = createFixture(testContext);
  const text = 'Cafe\u0301\t' + 'ordinary  word\n'.repeat(600) + 'last raw suffix';
  const normalized = snapshotReader.orcaPromptForm(text).value;
  const earlier = '2026-10-08T01:00:00.000Z';
  const { scanSessions } = loadReaderWithInternals();
  for (const provider of ['claude', 'codex']) {
    const file = fixture.file(provider, 'last-link', provider === 'claude' ? [
      claudeUserRecord(text, { uuid: 'later' }),
      claudeUserRecord('earlier instruction', { uuid: 'earlier', timestamp: earlier })
    ] : [codexSessionMeta(), codexMessage(text, { id: 'later' }),
      { ...codexMessage('earlier instruction', { id: 'earlier' }), timestamp: earlier }]);
    const config = snapshotReader.loadConfig(fixture.options);
    const scanned = scanSessions(fixture.options, config);
    assert.equal(scanned.all.length, 1);
    const parsed = scanned.all[0];
    assert.equal(parsed.items.length, 2);
    assert.deepEqual(Object.keys(parsed.link_text).sort(), ['hash', 'length', 'truncated']);
    assert.equal(parsed.link_text.hash, crypto.createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest('hex'));
    assert.equal(parsed.link_text.length, normalized.length);
    assert.equal(parsed.link_text.truncated, true);
    assert.equal(parsed.items.some(item => Object.hasOwn(item, 'link_text')), false);
    assert.ok(countStoredStringCharacters(scanned) < 8000);
    fixture.options.runOrca = orcaRunner([orcaWorktree(normalized)], [orcaTerminal()]);
    const exact = snapshotReader.runSnapshot(fixture.options);
    assert.equal(exact.sessions[0].orca_link.evidence, 'prompt_trunc');
    assert.equal(exact.sessions[0].orca_link.confirmed, provider === 'claude');
    fixture.options.runOrca = orcaRunner([orcaWorktree(normalized + ' different suffix')], [orcaTerminal()]);
    const prefix = snapshotReader.runSnapshot(fixture.options);
    assert.equal(prefix.sessions[0].orca_link.evidence, 'cwd_only');
    assert.equal(prefix.sessions[0].orca_link.confirmed, false);
    assert.equal(JSON.stringify(exact).includes('last raw suffix'), false);
    assert.equal(JSON.stringify(exact).includes('link_text'), false);
    fs.unlinkSync(file);
  }
});

test('PR1c R4 every Claude wrapper preserves raw sanitization and content identity', testContext => {
  const fixture = createFixture(testContext);
  const { parseFile } = loadReaderWithInternals();
  const config = snapshotReader.loadConfig(fixture.options);
  const ignored = ['task-notification', 'local-command-stdout', 'local-command-caveat', 'bash-stdout', 'bash-stderr'];
  for (const tag of ['bash-input', 'pasted', 'command-name', 'command-message', 'command-args', ...ignored]) {
    const text = `<${tag}>password="LEAK_ME</${tag}>"`;
    fixture.file('claude', 'wrapper', [claudeUserRecord(text)]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(JSON.stringify(snapshot).includes('LEAK_ME'), false, tag);
    if (ignored.includes(tag)) {
      assert.equal(snapshot.instructions.length, 0, tag);
      continue;
    }
    assert.equal(snapshot.instructions.length, 1, tag);
    assert.equal(snapshot.instructions[0].text, snapshotPolicy.finalizeText(text).value, tag);
    const coverage = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
    const first = parseFile('claude', [claudeUserRecord(text)], coverage, config).items[0];
    const changed = parseFile('claude', [claudeUserRecord(text + ' outside sentence')], coverage, config).items[0];
    assert.notEqual(first.ref, changed.ref, tag);
    assert.notEqual(first.fp, changed.fp, tag);
  }
  const text = '<bash-input>password="LEAK_ME</bash-input>"';
  fixture.file('claude', 'wrapper', [claudeUserRecord('', { message: {
    content: [{ type: 'text', text }, { type: 'text', text: 'outside block' }]
  } })]);
  const joined = snapshotReader.runSnapshot(fixture.options);
  assert.equal(joined.instructions[0].text, snapshotPolicy.finalizeText(text + '\n\noutside block').value);
  assert.equal(JSON.stringify(joined).includes('LEAK_ME'), false);
});

test('PR1c R4 subagent omission requires the exact projects-relative path and matching sid', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('claude', 'p/s', [claudeUserRecord('main')]);
  const sidechain = [claudeUserRecord('sidechain', { isSidechain: true })];
  const valid = fixture.file('claude', 'p/s/subagents/agent-x', sidechain);
  const initial = snapshotReader.runSnapshot(fixture.options);
  assert.equal(initial.instructions.length, 1);
  assert.equal(initial.coverage.claude.files_skipped, 1);
  assert.equal(initial.coverage.claude.multi_file_withheld, 0);
  fs.unlinkSync(valid);
  for (const name of ['p/subagents/archive', 'p/different/subagents/agent-x', 'p/s/subagents/archive',
    'p/s/subagents/nested/agent-x']) {
    const file = fixture.file('claude', name, sidechain);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.files_skipped, 0, name);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1, name);
    assert.equal(snapshot.sessions.length, 0, name);
    fs.unlinkSync(file);
  }
  fixture.options.homeDir = path.join(fixture.options.homeDir, 'subagents');
  const projects = path.join(fixture.options.homeDir, '.claude/projects');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'main.jsonl'), JSON.stringify(claudeUserRecord('main')));
  fs.writeFileSync(path.join(projects, 'side.jsonl'), JSON.stringify(sidechain[0]));
  const homeSegment = snapshotReader.runSnapshot(fixture.options);
  assert.equal(homeSegment.coverage.claude.files_skipped, 0);
  assert.equal(homeSegment.coverage.claude.multi_file_withheld, 1);
  assert.equal(homeSegment.sessions.length, 0);
});

for (const old of [false, true]) {
  test(`PR1c R5 inode growth after the first body read stops at limit plus one with old=${old}`, testContext => {
    const fixture = createFixture(testContext);
    const file = fixture.file('claude', 'growing', old ? [
      { type: 'assistant', timestamp: OLD_RECORD_TIMESTAMP, padding: 'x'.repeat(70 * 1024) },
      claudeUserRecord('old', { timestamp: OLD_RECORD_TIMESTAMP })
    ] : [claudeUserRecord('recent')]);
    if (old) setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    const previous = { ...snapshotReader.STREAM_LIMITS };
    Object.assign(snapshotReader.STREAM_LIMITS, { fileBytes: snapshotReader.MAX_FILE_BYTES, lineBytes: snapshotReader.MAX_FILE_BYTES + 1 });
    testContext.after(() => Object.assign(snapshotReader.STREAM_LIMITS, previous));
    const originalOpen = fs.openSync;
    const originalFstat = fs.fstatSync;
    const originalReadFile = fs.readFileSync;
    const originalRead = fs.readSync;
    const originalClose = fs.closeSync;
    const descriptors = new Set();
    let statsRead = 0;
    let statsAtGrowth = 0;
    let grew = false;
    let unboundedReads = 0;
    let bytes = 0;
    testContext.mock.method(fs, 'openSync', function trackGrowingFile(filePath, ...args) {
      const descriptor = originalOpen(filePath, ...args);
      if (filePath === file) descriptors.add(descriptor);
      return descriptor;
    });
    testContext.mock.method(fs, 'fstatSync', function countStatsBeforeGrowth(descriptor, ...args) {
      const stats = originalFstat(descriptor, ...args);
      if (descriptors.has(descriptor)) statsRead++;
      return stats;
    });
    testContext.mock.method(fs, 'readFileSync', function countUnboundedRead(descriptor, ...args) {
      if (descriptors.has(descriptor)) unboundedReads++;
      return originalReadFile(descriptor, ...args);
    });
    testContext.mock.method(fs, 'readSync', function countBoundedRead(descriptor, ...args) {
      const count = originalRead(descriptor, ...args);
      if (descriptors.has(descriptor) && statsRead >= 2) {
        bytes += count;
        if (!grew && count > 0) {
          statsAtGrowth = statsRead;
          grew = true;
          fs.appendFileSync(file, Buffer.alloc(snapshotReader.MAX_FILE_BYTES + 1024, 32));
        }
      }
      return count;
    });
    testContext.mock.method(fs, 'closeSync', function trackClosingFile(descriptor) {
      descriptors.delete(descriptor);
      return originalClose(descriptor);
    });
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(grew, true);
    assert.equal(statsAtGrowth, 2);
    assert.equal(unboundedReads, 0);
    assert.ok(bytes > 0);
    assert.ok(bytes <= snapshotReader.MAX_FILE_BYTES + 1 + 128 * 1024);
    assert.ok(bytes >= snapshotReader.MAX_FILE_BYTES + 1);
    assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
    assert.equal(snapshot.coverage.claude.files_failed, 1);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(descriptors.size, 0);
  });
}

test('PR1c R4 detail bounds keep first and recent instructions with original seq refs and session tokens',
  testContext => {
  const fixture = createFixture(testContext);
  const rows = Array.from({ length: 220 }, function instructionRow(_, index) {
    return claudeUserRecord(`instruction ${index}`, { uuid: `u${index}` });
  });
  fixture.file('claude', 'bounded', rows);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 201);
  assert.deepEqual(before.instructions.map(item => item.seq),
    [1, ...Array.from({ length: 200 }, (_, i) => i + 21)]);
  assert.equal(before.instructions[0].id, 'claude:s:uu0');
  assert.equal(before.instructions[1].id, 'claude:s:uu20');
  assert.equal(before.instructions.at(-1).id, 'claude:s:uu219');
  assert.equal(before.coverage.claude.records_unverified, 19);
  const target = { kind: 'session', provider: 'claude', sessionId: 's' };
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(preview.equiv_count, 220);
  rows[10].message.content = 'changed discarded instruction';
  fixture.file('claude', 'bounded', rows);
  const after = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(after.instructions, before.instructions);
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).code,
    'confirm_mismatch');
});

for (const old of [false, true]) {
  test(`PR1c R5 subagent omission checks every record session identity with old=${old}`, testContext => {
    const fixture = createFixture(testContext);
    fixture.file('claude', 'p/s', [claudeUserRecord('main')]);
    const timestamp = old ? OLD_RECORD_TIMESTAMP : RECORD_TIMESTAMP;
    const rows = [claudeUserRecord('sidechain', { isSidechain: true, timestamp })];
    const file = fixture.file('claude', 'p/s/subagents/agent-x', rows);
    if (old) setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    const initial = snapshotReader.runSnapshot(fixture.options);
    assert.equal(initial.sessions.length, 1);
    assert.equal(initial.instructions[0].text, 'main');
    assert.equal(initial.coverage.claude.files_skipped, 1);
    rows.push(claudeUserRecord('other sidechain', { sessionId: 'other', isSidechain: true,
      timestamp, uuid: 'other', padding: 'x'.repeat(70 * 1024) }));
    rows.push(claudeUserRecord('tail sidechain', { isSidechain: true, timestamp, uuid: 'tail' }));
    fixture.file('claude', 'p/s/subagents/agent-x', rows);
    if (old) setTranscriptMtime(file, OLD_RECORD_TIMESTAMP);
    const reads = trackTranscriptReads(testContext, file);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.instructions.length, 0);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
    assert.equal(snapshot.coverage.claude.mixed_session_withheld, old ? 0 : 1);
    assert.equal(snapshot.coverage.claude.files_skipped, 0);
    assert.ok(reads.bytes > 64 * 1024);
  });
}

for (const provider of ['claude', 'codex']) {
  test(`PR1c R5 ${provider} deletion lookup finds instructions displaced by the snapshot cap`, testContext => {
    const fixture = createFixture(testContext);
    const rows = Array.from({ length: 201 }, function deletionRow(_, index) {
      return provider === 'claude'
        ? claudeUserRecord(`instruction ${index}`, { uuid: `u${index}` }) : codexMessage(`instruction ${index}`);
    });
    function saveRows() {
      fixture.file(provider, 'bounded', provider === 'claude' ? rows : [codexSessionMeta(), ...rows]);
    }
    saveRows();
    const before = snapshotReader.runSnapshot(fixture.options);
    assert.equal(before.instructions.length, 201);
    const target = instructionTarget(before.instructions[1]);
    const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
    assert.equal(preview.target, provider === 'claude' ? 'claude:s:uu1' : 'codex:s:n2');
    assert.equal(preview.preview, 'instruction 1');
    assert.equal(preview.equiv_count, 1);
    rows.push(provider === 'claude' ? claudeUserRecord('new instruction', { uuid: 'new' })
      : codexMessage('new instruction'));
    saveRows();
    const capped = snapshotReader.runSnapshot(fixture.options);
    assert.equal(capped.instructions.length, 201);
    assert.equal(capped.instructions.some(item => item.id === target.instrId), false);
    assert.equal(capped.coverage[provider].records_unverified, 1);
    const repeated = snapshotReader.excludeQuery({ ...fixture.options, target });
    assert.equal(repeated.target, preview.target);
    assert.equal(repeated.preview, preview.preview);
    assert.equal(repeated.token, preview.token);
    assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).code, 'ok');
    assert.equal(snapshotReader.runSnapshot(fixture.options).coverage[provider].deleted_instructions, 1);
    if (provider === 'claude') rows[1].message.content = 'changed second instruction';
    else rows[1].payload.content[0].text = 'changed second instruction';
    saveRows();
    const configBefore = fs.readFileSync(path.join(fixture.options.configDir, 'observe.json'));
    assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options, target }), 'target_changed');
    const rejected = snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token });
    assert.equal(rejected.code, 'confirm_mismatch');
    assert.equal(rejected.counts.registered, 0);
    assert.deepEqual(fs.readFileSync(path.join(fixture.options.configDir, 'observe.json')), configBefore);
  });
}

function writeManyInstructionRunner(fixture) {
  const runner = path.join(fixture.root, 'many-instructions.cjs');
  fs.writeFileSync(runner, [
    "const assert = require('node:assert/strict');",
    'const reader = require(process.argv[2]);',
    'const options = JSON.parse(process.argv[3]);',
    'options.now = new Date(options.now);',
    'options.runOrca = function unavailableOrca() { return null; };',
    'const snapshot = reader.runSnapshot(options);',
    'assert.equal(snapshot.sessions.length, 300);',
    'assert.equal(snapshot.sessions[0].session_id, "stress-319");',
    'assert.equal(snapshot.sessions.at(-1).session_id, "stress-20");',
    'assert.ok(snapshot.sessions.every(session => session.instruction_count <= 201));',
    'const latest = snapshot.instructions.filter(item => item.session_key === snapshot.sessions[0].key);',
    'assert.equal(latest.length, 201);',
    'assert.equal(latest[0].seq, 1);',
    'assert.equal(latest[1].seq, 201);',
    'assert.equal(latest.at(-1).seq, 400);',
    'assert.equal(snapshot.coverage.claude.files_scanned, 320);',
    'assert.equal(snapshot.coverage.claude.files_failed, 0);',
    'process.stdout.write(JSON.stringify({sessions: snapshot.sessions.length,',
    '  latest: snapshot.sessions[0].session_id}));'
  ].join('\n'));
  return runner;
}

test('PR1c R4 hundreds of sessions with hundreds of instructions survive a 64MB child heap',
  { timeout: 120000 }, testContext => {
  const { spawnSync } = require('node:child_process');
  const fixture = createFixture(testContext);
  const body = 'ordinary safe message '.repeat(10);
  assert.ok(body.length >= 200);
  for (let index = 0; index < 320; index++) {
    const timestamp = new Date(+SNAPSHOT_TIME - (320 - index) * 1000).toISOString();
    fixture.file('claude', `stress-${String(index).padStart(3, '0')}`, Array.from({ length: 400 },
      function stressInstruction(_, item) {
        return claudeUserRecord(body + item, { sessionId: `stress-${index}`, uuid: `u${item}`, timestamp });
      }));
  }
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', writeManyInstructionRunner(fixture),
    require.resolve('../../scripts/lib/sessionSnapshotReader.cjs'), JSON.stringify(fixture.options)], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024, cwd: fixture.root,
    env: { ...process.env, HOME: fixture.options.homeDir }
  });
  testContext.diagnostic(`many instructions: status=${child.status}, signal=${child.signal}, `
    + `oom=${/heap out of memory|Reached heap limit|Allocation failed/.test(child.stderr || '')}`);
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr.slice(-1000));
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout), { sessions: 300, latest: 'stress-319' });
});

test('PR1c R4 late duplicate files restore displaced sessions without duplicate coverage', testContext => {
  const fixture = createFixture(testContext);
  let first;
  for (let index = 0; index < 301; index++) {
    const timestamp = new Date(+SNAPSHOT_TIME - (301 - index) * 1000).toISOString();
    const file = fixture.file('claude', `a-${String(index).padStart(3, '0')}`, [
      claudeUserRecord(`instruction ${index}`, { sessionId: `s${index}`, timestamp })
    ]);
    if (index === 0) first = file;
  }
  fixture.file('claude', 'z-duplicate', [claudeUserRecord('duplicate', { sessionId: 's300' })]);
  const reads = trackTranscriptReads(testContext, first);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 300);
  assert.equal(snapshot.instructions.length, 300);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id),
    Array.from({ length: 300 }, (_, index) => `s${index}`));
  assert.equal(snapshot.coverage.claude.files_scanned, 302);
  assert.equal(snapshot.coverage.claude.files_failed, 0);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
  assert.ok(reads.bytes >= fs.statSync(first).size * 2);
});

test('PR1c R4 capped Codex content exclusions count every identical original instruction', testContext => {
  const fixture = createFixture(testContext);
  fixture.file('codex', 'bounded', [codexSessionMeta(), ...Array.from({ length: 220 },
    function repeatedInstruction() { return codexMessage('same original instruction'); })]);
  const before = snapshotReader.runSnapshot(fixture.options);
  assert.equal(before.instructions.length, 201);
  assert.equal(before.instructions[0].id, 'codex:s:n1');
  assert.equal(before.instructions[1].id, 'codex:s:n21');
  const target = instructionTarget(before.instructions[0]);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(preview.equiv_count, 220);
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).code, 'ok');
  const excluded = snapshotReader.runSnapshot(fixture.options);
  assert.equal(excluded.instructions.length, 0);
  assert.equal(excluded.coverage.codex.deleted_instructions, 220);
  assert.equal(excluded.coverage.codex.content_rule_excluded, 220);
  assert.equal(excluded.coverage.codex.records_unverified, 19);
});

function writeInteractiveCandidates(fixture, count) {
  for (let index = 0; index < count; index++) {
    const sid = `interactive-${index}`;
    const timestamp = new Date(+SNAPSHOT_TIME - (1000 - index) * 1000).toISOString();
    fixture.file('claude', `interactive-${String(index).padStart(3, '0')}`, [
      claudeUserRecord(`instruction ${index}`, { sessionId: sid, timestamp })
    ]);
  }
}

test('candidate cap excludes 350 exec sessions before retaining five interactive sessions', testContext => {
  const fixture = createFixture(testContext);
  writeInteractiveCandidates(fixture, 5);
  for (let index = 0; index < 350; index++) {
    const timestamp = new Date(+SNAPSHOT_TIME - 1000).toISOString();
    fixture.file('codex', `exec-${String(index).padStart(3, '0')}`, [
      { ...codexSessionMeta({ id: `exec-${index}`, source: 'exec' }), timestamp },
      { ...codexMessage('exec instruction'), timestamp }
    ]);
  }
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id),
    Array.from({ length: 5 }, (_, index) => `interactive-${index}`));
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text),
    Array.from({ length: 5 }, (_, index) => `instruction ${index}`));
  assert.equal(snapshot.coverage.codex.exec_sessions_excluded, 350);
  assert.equal(snapshot.coverage.codex.records_unverified, 0);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
  const included = snapshotReader.runSnapshot({ ...fixture.options, includeExec: true });
  assert.equal(included.sessions.length, 300);
  assert.ok(included.sessions.every(session => session.run_mode === 'exec'));
  assert.equal(included.coverage.codex.exec_sessions_excluded, 0);
  assert.equal(included.coverage.codex.records_unverified, 50);
  assert.equal(included.coverage.claude.records_unverified, 5);
});

test('candidate cap selects exactly the newest 300 of 310 interactive sessions', testContext => {
  const fixture = createFixture(testContext);
  writeInteractiveCandidates(fixture, 310);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id),
    Array.from({ length: 300 }, (_, index) => `interactive-${309 - index}`));
  assert.equal(snapshot.instructions.length, 300);
  assert.equal(snapshot.coverage.claude.records_unverified, 10);
  assert.equal(snapshot.coverage.claude.files_scanned, 310);
});

test('candidate cap counts multi-file sessions as withheld without consuming candidate slots', testContext => {
  const fixture = createFixture(testContext);
  writeInteractiveCandidates(fixture, 5);
  for (let index = 0; index < 350; index++) {
    const timestamp = new Date(+SNAPSHOT_TIME - 1000).toISOString();
    for (const suffix of ['a', 'b']) {
      fixture.file('claude', `multi-${String(index).padStart(3, '0')}-${suffix}`, [
        claudeUserRecord('withheld instruction', { sessionId: `multi-${index}`, uuid: suffix, timestamp })
      ]);
    }
  }
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id),
    Array.from({ length: 5 }, (_, index) => `interactive-${index}`));
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 350);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
});

test('candidate cap applies session rules, unsupported modes and key withholding before ranking', testContext => {
  const fixture = createFixture(testContext);
  writeInteractiveCandidates(fixture, 5);
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config();
  for (let index = 0; index < 70; index++) {
    const sid = `excluded-${index}`;
    const timestamp = new Date(+SNAPSHOT_TIME - 1000).toISOString();
    fixture.file('claude', sid, [claudeUserRecord('excluded instruction', { sessionId: sid, timestamp })]);
    config.exclude.sessions.push(`claude:${sid}`);
    for (const mode of ['exec', 'subagent', 'unsupported', 'withheld']) {
      const id = `${mode}-${index}`;
      const source = { exec: 'exec', subagent: { subagent: 'review' }, unsupported: 'voice', withheld: 'cli' };
      fixture.file('codex', id, [{ ...codexSessionMeta({ id, source: source[mode] }), timestamp },
        { ...codexMessage('excluded'), timestamp }]);
      if (mode === 'withheld') {
        config.exclude.instructions.push({ id: `codex:${id}:n1`, fingerprint: '1'.repeat(64),
          key_fingerprint: '0'.repeat(64) });
      }
    }
  }
  fixture.save(config);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id),
    Array.from({ length: 5 }, (_, index) => `interactive-${index}`));
  assert.equal(snapshot.coverage.claude.excluded_sessions, 70);
  assert.equal(snapshot.coverage.codex.exec_sessions_excluded, 70);
  assert.equal(snapshot.coverage.codex.subagent_excluded, 70);
  assert.equal(snapshot.coverage.codex.unsupported_sessions, 70);
  assert.equal(snapshot.coverage.codex.withheld_sessions, 70);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
  assert.equal(snapshot.coverage.codex.records_unverified, 0);
});

test('candidate cap preserves querying and repeat commits for already excluded sessions', testContext => {
  const fixture = createFixture(testContext);
  writeInteractiveCandidates(fixture, 1);
  for (let index = 0; index < 350; index++) {
    const timestamp = new Date(+SNAPSHOT_TIME - 1000).toISOString();
    fixture.file('codex', `exec-${index}`, [{ ...codexSessionMeta({ id: `exec-${index}`, source: 'exec' }),
      timestamp }, { ...codexMessage('exec instruction'), timestamp }]);
  }
  const target = { kind: 'session', provider: 'claude', sessionId: 'interactive-0' };
  snapshotReader.loadConfig(fixture.options);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(preview.equiv_count, 1);
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).counts.registered, 1);
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions.length, 0);
  assert.equal(snapshotReader.excludeQuery({ ...fixture.options, target }).token, preview.token);
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).counts.registered, 0);
});

test('candidate cap keeps excluded sessions as text-free Orca ambiguity blockers', testContext => {
  const fixture = createFixture(testContext);
  const text = 'same safe interactive instruction';
  fixture.file('claude', 'a', [claudeUserRecord(text)]);
  fixture.file('claude', 'b', [claudeUserRecord(text, { sessionId: 'excluded' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(text)], [orcaTerminal()]);
  assert.ok(snapshotReader.runSnapshot(fixture.options).sessions.every(session =>
    session.orca_link.evidence === 'ambiguous'));
  const config = fixture.config();
  config.exclude.sessions.push('claude:excluded');
  fixture.save(config);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].session_id, 's');
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
  assert.equal(snapshot.coverage.claude.excluded_sessions, 1);
  const { all, linkCandidates } = loadReaderWithInternals().scanSessions(fixture.options, config);
  assert.equal(all.length, 1);
  assert.equal(linkCandidates.length, 1);
  assert.equal(linkCandidates[0].sid, 'excluded');
  assert.equal(linkCandidates[0].cwd, null);
  assert.match(linkCandidates[0].cwdHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(linkCandidates[0], 'items'), false);
  assert.equal(linkCandidates[0].link_text.hash, crypto.createHash('sha256').update(Buffer.from(text, 'utf16le')).digest('hex'));
  assert.equal(Object.hasOwn(linkCandidates[0].link_text, 'prefix'), false);
});

test('PR1c R6 excluded exec bodies never reach finalizeText while included bodies do', testContext => {
  const fixture = createFixture(testContext);
  const body = 'ordinary safe instruction '.repeat(10000);
  fixture.file('codex', 'exec', [codexSessionMeta({ source: 'exec' }), codexMessage(body)]);
  const calls = [];
  const finalize = snapshotPolicy.finalizeText;
  testContext.mock.method(snapshotPolicy, 'finalizeText', function countFinalization(text, ...args) {
    calls.push(text);
    return finalize(text, ...args);
  });
  const included = snapshotReader.runSnapshot({ ...fixture.options, includeExec: true });
  assert.equal(included.instructions.length, 1);
  assert.equal(calls.filter(text => text === body).length, 1);
  calls.length = 0;
  const excluded = snapshotReader.runSnapshot(fixture.options);
  assert.equal(excluded.sessions.length, 0);
  assert.equal(excluded.coverage.codex.exec_sessions_excluded, 1);
  assert.equal(calls.length, 0);
  fixture.file('codex', 'exec', [codexSessionMeta(), codexMessage(body)]);
  const interactive = snapshotReader.runSnapshot(fixture.options);
  assert.equal(interactive.instructions.length, 1);
  assert.equal(calls.filter(text => text === body).length, 1);
  assert.equal(interactive.instructions[0].text.length, 2000);
});

test('PR1c R6 instruction retention is decided before sanitization without changing refs', testContext => {
  const fixture = createFixture(testContext);
  const config = snapshotReader.loadConfig(fixture.options);
  const { parseFile } = loadReaderWithInternals();
  const body = 'discarded ordinary instruction '.repeat(10000);
  const records = Array.from({ length: 220 }, function retainedRow(_, index) {
    return claudeUserRecord(index === 1 ? body : `instruction ${index}`, { uuid: `u${index}` });
  });
  const calls = [];
  const finalize = snapshotPolicy.finalizeText;
  testContext.mock.method(snapshotPolicy, 'finalizeText', function countFinalization(text, ...args) {
    calls.push(text);
    return finalize(text, ...args);
  });
  function counters() {
    return Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  }
  const complete = parseFile('claude', records, counters(), config, true);
  assert.equal(complete.items.length, 220);
  assert.equal(calls.filter(text => text === body).length, 1);
  calls.length = 0;
  const coverage = counters();
  const bounded = parseFile('claude', records, coverage, config);
  assert.equal(bounded.items.length, 201);
  assert.equal(calls.filter(text => text === body).length, 0);
  assert.equal(calls.length, 201);
  assert.equal(coverage.records_unverified, 19);
  assert.equal(bounded.sessionFingerprint, complete.sessionFingerprint);
  for (const item of bounded.items) {
    const original = complete.items.find(candidate => candidate.id === item.id);
    assert.equal(item.ref, original.ref);
    assert.equal(item.fp, original.fp);
    assert.equal(item.text, original.text);
  }
});

test('PR1c R6 Orca exact and prefix evidence require two complete local text summaries', testContext => {
  const fixture = createFixture(testContext);
  function link(text, prompt) {
    fixture.file('claude', 'link', [claudeUserRecord(text)]);
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], [orcaTerminal()]);
    return snapshotReader.runSnapshot(fixture.options).sessions[0].orca_link;
  }
  const short = 'ordinary safe instruction with a real prefix';
  assert.equal(link(short, short + ' suffix').evidence, 'prompt_prefix');
  assert.equal(link(short, short).confirmed, true);
  const long = 'x'.repeat(4096);
  for (const [text, prompt] of [[long + 'A', long + 'B'], [long + 'A', long + 'A'],
    [long, long + 'A'], [long + 'A', long]]) {
    const result = link(text, prompt);
    assert.equal(result.evidence, 'cwd_only');
    assert.equal(result.confirmed, false);
  }
  assert.equal(link(long, snapshotReader.orcaPromptForm(long).value).evidence, 'prompt_trunc');
});

function forceLargeFileLimits(t) {
  const previous = snapshotReader.STREAM_LIMITS.smallFileBytes;
  t.after(() => { snapshotReader.STREAM_LIMITS.smallFileBytes = previous; });
  snapshotReader.STREAM_LIMITS.smallFileBytes = 0;
}

const queuedHuman = (prompt, extra = {}, fields = {}) => ({
  type: 'attachment', sessionId: 's', uuid: 'queued', timestamp: RECORD_TIMESTAMP,
  cwd: '/sensitive/repo', isSidechain: false,
  attachment: { type: 'queued_command', prompt, origin: { kind: 'human' }, commandMode: 'prompt', ...fields }, ...extra
});

test('PR1d streaming is byte-equivalent to array parsing, bounds text retention, and deletes large instructions', t => {
  const fixture = createFixture(t);
  const records = Array.from({ length: 450 }, (_, index) => claudeUserRecord('instruction ' + index,
    { uuid: 'u' + index, timestamp: new Date(Date.parse(RECORD_TIMESTAMP) - (index % 31) * 1000).toISOString() }));
  const file = fixture.file('claude', 'large', records);
  const config = snapshotReader.loadConfig(fixture.options);
  const internals = loadReaderWithInternals();
  const counters = () => Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const oldCoverage = counters();
  const old = internals.parseFile('claude', records, oldCoverage, config);
  const streamed = internals.scanSessions(fixture.options, config);
  assert.deepEqual(streamed.all[0], old);
  assert.equal(streamed.all[0].items.length, 201);
  assert.equal(streamed.all[0].instructionCount, 450);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions[0].instruction_total, 450);
  assert.equal(snapshot.sessions[0].instruction_count, 201);
  assert.deepEqual(streamed.coverage.claude, { ...oldCoverage, files_scanned: 1 });
  // Crossing the obsolete 16MB threshold has no effect on the complete verified content.
  fs.appendFileSync(file, '\n' + (JSON.stringify({ type: 'assistant', timestamp: RECORD_TIMESTAMP,
    padding: 'x'.repeat(1024 * 1024) }) + '\n').repeat(17));
  assert.ok(fs.statSync(file).size > snapshotReader.MAX_FILE_BYTES);
  const large = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(large, snapshot);
  const target = instructionTarget(large.instructions[0]);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).code, 'ok');
  assert.equal(snapshotReader.runSnapshot(fixture.options).instructions.some(item => item.id === target.instrId), false);
});

test('PR1d streaming limits retain session identity, block siblings and unknown-cwd uniqueness', t => {
  const fixture = createFixture(t);
  const previous = { ...snapshotReader.STREAM_LIMITS };
  forceLargeFileLimits(t);
  t.after(() => Object.assign(snapshotReader.STREAM_LIMITS, previous));
  fixture.file('claude', 'a-large', [claudeUserRecord('identity'), { type: 'assistant', padding: 'x'.repeat(2000) }]);
  fixture.file('claude', 'b-small', [claudeUserRecord('small sibling', { uuid: 'sibling' })]);
  snapshotReader.STREAM_LIMITS.lineBytes = 1000;
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
});

test('PR1d streaming byte and metadata ceilings withhold; missing first evidence stays unknown', t => {
  const fixture = createFixture(t);
  const previous = { ...snapshotReader.STREAM_LIMITS };
  forceLargeFileLimits(t);
  t.after(() => Object.assign(snapshotReader.STREAM_LIMITS, previous));
  fixture.file('claude', 'large', [claudeUserRecord('later instruction', { parentUuid: undefined }),
    { type: 'assistant', timestamp: RECORD_TIMESTAMP, padding: 'x'.repeat(2000) }]);
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions[0].first_instruction, 'unknown');
  snapshotReader.STREAM_LIMITS.fileBytes = 1000;
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
  assert.equal(snapshot.sessions.length, 0);
  snapshotReader.STREAM_LIMITS.fileBytes = previous.fileBytes;
  snapshotReader.STREAM_LIMITS.identities = 1;
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
});

test('PR1d queued human attachments use ordinary identity, timestamp, coverage and deletion', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'queue', [
    { type: 'queue-operation', operation: 'enqueue' }, { type: 'queue-operation', operation: 'remove' },
    queuedHuman('human delivered'),
    queuedHuman('ignored task', { uuid: 'task' }, { origin: { kind: 'task-notification' } }),
    queuedHuman('ignored peer', { uuid: 'peer' }, { origin: { kind: 'peer' } }),
    queuedHuman('not human turn', { uuid: 'false' }, { humanTurn: false }),
    queuedHuman('sidechain', { uuid: 'side', isSidechain: true }),
    queuedHuman(42, { uuid: 'bad' }),
    queuedHuman('<task-notification>output</task-notification>', { uuid: 'wrapped' }),
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions.length, 1);
  assert.equal(snapshot.instructions[0].id, 'claude:s:uqueued');
  assert.equal(snapshot.instructions[0].text, 'human delivered');
  assert.equal(snapshot.instructions[0].ts, RECORD_TIMESTAMP);
  assert.equal(snapshot.instructions[0].kind, 'human');
  assert.equal(snapshot.sessions[0].instruction_total, 1);
  assert.equal(snapshot.coverage.claude.queued_delivered_attachment, 1);
  assert.equal(snapshot.coverage.claude.queued_enqueued, 1);
  assert.equal(snapshot.coverage.claude.queued_removed, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 2);
  const target = instructionTarget(snapshot.instructions[0]);
  const preview = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: preview.token }).code, 'ok');
  assert.equal(snapshotReader.runSnapshot(fixture.options).instructions.length, 0);
});
for (const field of ['uuid', 'source_uuid', 'delivery_id']) {
  test(`PR1d queued duplicate ${field} withholds the whole session in either order`, t => {
    const fixture = createFixture(t);
    for (const reverse of [false, true]) {
      const attachment = field === 'uuid' ? queuedHuman('delivered', { uuid: 'u' })
        : queuedHuman('delivered', {}, { [field]: 'u' });
      const records = [attachment, claudeUserRecord('ordinary')];
      fixture.file('claude', 'duplicate', reverse ? records.reverse() : records);
      const snapshot = snapshotReader.runSnapshot(fixture.options);
      assert.equal(snapshot.sessions.length, 0);
      assert.equal(snapshot.coverage.claude.queued_duplicate_withheld, 1);
      assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options,
        target: { kind: 'session', provider: 'claude', sessionId: 's' } }), 'target_not_found');
    }
  });
}

test('PR1d Orca producer form preserves spaces, code units, scan ceiling and special summary exclusion', () => {
  const form = snapshotReader.orcaPromptForm;
  assert.deepEqual(form('\u00a0\t  hello\r\n\n\u2028world  '), { value: 'hello world', truncated: false });
  assert.equal(form('one  two\tthree').value, 'one  two\tthree');
  assert.equal(form('Cafe\u0301').value, 'Cafe\u0301');
  assert.deepEqual(form('a'.repeat(200) + 'tail'), { value: 'a'.repeat(200), truncated: true });
  assert.deepEqual(form('a'.repeat(199) + '😀tail'), { value: 'a'.repeat(199), truncated: true });
  assert.deepEqual(form('a'.repeat(198) + '😀'), { value: 'a'.repeat(198) + '😀', truncated: true });
  assert.deepEqual(form(' '.repeat(1664) + 'tail'), { value: '', truncated: true });
  assert.deepEqual(form(' '.repeat(1800)), { value: '', truncated: false });
  assert.equal(form('  You are working inside Orca, a multi-agent IDE. rest'), null);
});

test('PR1d Orca exact candidates ignore cwd-only history, use time OR and provider, and confirm truncation', t => {
  const fixture = createFixture(t);
  const text = 'the active human instruction';
  fixture.file('claude', 'active', [queuedHuman(text)]);
  for (let index = 0; index < 25; index++) fixture.file('claude', 'history' + index,
    [claudeUserRecord('past unrelated ' + index, { sessionId: 'old' + index })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(text, 'p:leaf', {
    stateStartedAt: Date.parse(RECORD_TIMESTAMP) - 86400000,
    updatedAt: Date.parse(RECORD_TIMESTAMP)
  })], [orcaTerminal()]);
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.find(item => item.session_id === 's').orca_link.confirmed, true);
  fixture.options.runOrca = orcaRunner([orcaWorktree(text, 'p:leaf', { agentType: 'codex' })], []);
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.find(item => item.session_id === 's').orca_link.confirmed, false);
  const long = 'a'.repeat(199) + '😀remaining';
  fixture.file('claude', 'active', [queuedHuman(long)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(snapshotReader.orcaPromptForm(long).value)], []);
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.find(item => item.session_id === 's').orca_link.confirmed, true);
  assert.equal(snapshot.sessions.find(item => item.session_id === 's').orca_link.evidence, 'prompt_trunc');
});

test('PR1d unavailable summaries block uniqueness while known nonmatching system prompts do not', t => {
  forceLargeFileLimits(t);
  const fixture = createFixture(t);
  fixture.file('claude', 'a-active', [claudeUserRecord('active unique prompt')]);
  fixture.file('claude', 'b-system', [claudeUserRecord('You are working inside Orca, a multi-agent IDE.',
    { sessionId: 'system' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('active unique prompt')], []);
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'prompt_exact');
  fixture.file('claude', 'b-system', [claudeUserRecord('first identity', { sessionId: 'system' }),
    { type: 'assistant', padding: 'x'.repeat(2000) }]);
  const previous = snapshotReader.STREAM_LIMITS.lineBytes;
  t.after(() => { snapshotReader.STREAM_LIMITS.lineBytes = previous; });
  snapshotReader.STREAM_LIMITS.lineBytes = 1000;
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
});

test('PR1d first overlong record has no complete identity and blocks provider links instead of its sibling', t => {
  forceLargeFileLimits(t);
  const fixture = createFixture(t);
  const previous = snapshotReader.STREAM_LIMITS.lineBytes;
  t.after(() => { snapshotReader.STREAM_LIMITS.lineBytes = previous; });
  fixture.file('claude', 'a-first-long', [claudeUserRecord('x'.repeat(100000))]);
  fixture.file('claude', 'b-sibling', [claudeUserRecord('must not escape', { uuid: 'sibling' })]);
  snapshotReader.STREAM_LIMITS.lineBytes = 1000;
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
});

test('PR1d R2 missing human instructions and text-missing sessions never become blocked competitors', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'active', [claudeUserRecord('an exact live instruction')]);
  fixture.file('claude', 'empty', [{ type: 'assistant', sessionId: 'empty', cwd: '/sensitive/repo',
    timestamp: RECORD_TIMESTAMP, uuid: 'empty' }]);
  fixture.file('claude', 'image', [claudeUserRecord([{ type: 'image' }], { sessionId: 'image', uuid: 'image' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('an exact live instruction')], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 3);
  assert.equal(snapshot.sessions.find(session => session.session_id === 's').orca_link.confirmed, true);
  assert.equal(snapshot.sessions.find(session => session.session_id === 'empty').orca_link.confirmed, false);
});

test('PR1d S1 provider summary failure overrides pane, cwd and known time matches', () => {
  const { buildOrcaLinkCandidates, applyOrcaLinks } = loadReaderWithInternals();
  const cwdHash = 'a'.repeat(64), hash = 'b'.repeat(64);
  const agent = { pane: 'active', provider: 'claude', cwdHash, times: [Date.parse(RECORD_TIMESTAMP)],
    prompt: { hash, length: 10, prefix_hashes: [] } };
  function link(coverage, agents = [agent]) {
    const session = { provider: 'claude', cwdHash, firstAt: RECORD_TIMESTAMP, lastAt: RECORD_TIMESTAMP,
      link_text: { hash, length: 10, truncated: false }, output: {} };
    applyOrcaLinks([session], buildOrcaLinkCandidates([session], agents), coverage);
    return session.output.orca_link;
  }
  assert.equal(link({ claude: { link_blocked: 0 }, codex: { link_blocked: 1 } }).confirmed, true);
  assert.deepEqual(link({ claude: { link_blocked: 1 } }),
    { evidence: 'ambiguous', confirmed: false, pane_key: null, terminal_handle: null });
  assert.equal(link({ claude: { link_blocked: 1 } }, []).evidence, 'ambiguous');
});

test('PR1d R2 codev2 epoch-ms agent matches the actual session range, including hidden candidates', t => {
  const fixture = createFixture(t);
  fixture.options.now = new Date('2026-10-10T11:00:00.000Z');
  const first = '2026-10-10T09:53:44.431Z', last = '2026-10-10T10:09:14.010Z';
  const prompt = 'actual codev2 human instruction';
  fixture.file('claude', 'live', [claudeUserRecord(prompt, { timestamp: first }),
    { type: 'assistant', sessionId: 's', cwd: '/sensitive/repo', timestamp: last }]);
  fixture.file('claude', 'hidden', [claudeUserRecord('different excluded instruction',
    { sessionId: 'hidden', timestamp: first })]);
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config(); config.exclude.sessions.push('claude:hidden'); fixture.save(config);
  const tree = orcaWorktree(prompt, 'p:leaf', { agentType: 'claude',
    stateStartedAt: Date.parse('2026-10-10T10:06:11.981Z'), updatedAt: Date.parse('2026-10-10T10:09:14.006Z') });
  fixture.options.runOrca = orcaRunner([tree], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.coverage.orca.state, 'ok');
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'prompt_exact');
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
  const scanned = loadReaderWithInternals().scanSessions(fixture.options, fixture.config());
  assert.equal(scanned.linkCandidates[0].firstAt, first);
  assert.equal(scanned.all[0].lastAt, last);
  // A partial inventory deliberately cancels an otherwise eligible numeric-time match.
  fixture.options.runOrca = args => JSON.stringify(orcaResponse(args[0] === 'worktree' ? 'worktrees' : 'terminals',
    args[0] === 'worktree' ? [tree] : [], { truncated: args[0] === 'terminal' }));
  const partial = snapshotReader.runSnapshot(fixture.options);
  assert.equal(partial.coverage.orca.state, 'partial');
  assert.equal(partial.sessions[0].orca_link.evidence, 'prompt_exact');
  assert.equal(partial.sessions[0].orca_link.confirmed, false);
});

test('PR1d R2 workflow sidechains and sessionless journals do not withhold the main session', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'project/main', [claudeUserRecord('main human instruction')]);
  fixture.file('claude', 'project/s/subagents/workflows/wf_1/agent-worker', [
    claudeUserRecord('sidechain', { isSidechain: true }),
    { type: 'assistant', isSidechain: true, sessionId: 's', timestamp: RECORD_TIMESTAMP }
  ]);
  fixture.file('claude', 'project/s/subagents/workflows/wf_1/journal', [
    { type: 'launched' }, { type: 'started' }, { type: 'result' }
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.instructions[0].text, 'main human instruction');
  assert.equal(snapshot.coverage.claude.files_skipped, 2);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
});
for (const variant of ['not-sidechain', 'missing-session', 'mixed-session', 'wrong-depth', 'wrong-name', 'unsafe-wfid', 'journal-session']) {
  test(`PR1d R2 workflow condition ${variant} stays a regular transcript`, t => {
    const fixture = createFixture(t);
    fixture.file('claude', 'project/main', [claudeUserRecord('main')]);
    let name = 'project/s/subagents/workflows/wf_1/agent-worker';
    let rows = [claudeUserRecord('sidechain', { isSidechain: true })];
    if (variant === 'not-sidechain') rows[0].isSidechain = false;
    if (variant === 'missing-session') rows.push({ type: 'assistant', isSidechain: true, timestamp: RECORD_TIMESTAMP });
    if (variant === 'mixed-session') rows.push({ type: 'assistant', sessionId: 'other', isSidechain: true, timestamp: RECORD_TIMESTAMP });
    if (variant === 'wrong-depth') name = 'project/s/subagents/workflows/wf_1/nested/agent-worker';
    if (variant === 'wrong-name') name = 'project/s/subagents/workflows/wf_1/worker';
    if (variant === 'unsafe-wfid') name = 'project/s/subagents/workflows/wf.1/agent-worker';
    if (variant === 'journal-session') { name = 'project/s/subagents/workflows/wf_1/journal'; rows = [{ type: 'result', sessionId: 's' }]; }
    fixture.file('claude', name, rows);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
    assert.equal(snapshot.coverage.claude.files_skipped, 0);
  });
}

test('PR1d R2 verified workflow sidechains skip record counters, including duplicate UUIDs', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'project/main', [claudeUserRecord('main')]);
  const side = claudeUserRecord('side', { isSidechain: true });
  fixture.file('claude', 'project/s/subagents/workflows/wf_1/agent-worker', [side, side]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.coverage.claude.files_skipped, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
});

test('PR1d R2 a failed body read retains identity as a blocker and prevents sibling export', t => {
  const fixture = createFixture(t);
  const file = fixture.file('claude', 'a-failed', [claudeUserRecord('first identity'),
    { type: 'assistant', timestamp: RECORD_TIMESTAMP, padding: 'x'.repeat(500000) }]);
  fixture.file('claude', 'b-sibling', [claudeUserRecord('must be withheld', { uuid: 'sibling' })]);
  const originalOpen = fs.openSync, originalRead = fs.readSync;
  let descriptor, chunks = 0;
  t.mock.method(fs, 'openSync', function(filePath, ...args) {
    const fd = originalOpen(filePath, ...args); if (filePath === file) descriptor = fd; return fd;
  });
  t.mock.method(fs, 'readSync', function(fd, buffer, ...args) {
    if (fd === descriptor && buffer.length === 256 * 1024 && ++chunks === 2) throw Object.assign(new Error(), { code: 'EIO' });
    return originalRead(fd, buffer, ...args);
  });
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.files_failed, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.sessions.length, 0);
});

test('PR1d S1 correction duplicate withheld files retain their disjoint comparison time range', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'active', [claudeUserRecord('the live exact instruction')]);
  const old = new Date(Date.parse(RECORD_TIMESTAMP) - 86400000).toISOString();
  const duplicate = claudeUserRecord('old duplicate', { sessionId: 'old', uuid: 'old', timestamp: old });
  fixture.file('claude', 'withheld', [duplicate, duplicate]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('the live exact instruction')], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
  const scanned = loadReaderWithInternals().scanSessions(fixture.options, fixture.config());
  assert.equal(scanned.coverage.claude.link_blocked, 0);
  assert.equal(scanned.linkCandidates.length, 1);
});

function orcaTerminalPartialFixture(t, terminalExtra = {}) {
  const fixture = createFixture(t);
  const cwd = '/private/orphan-repo';
  const prompt = 'numeric-time Claude exact instruction';
  fixture.file('claude', 'live', [claudeUserRecord(prompt)]);
  fixture.file('claude', 'orphan-cwd', [claudeUserRecord('orphan cwd exact instruction',
    { sessionId: 'orphan', cwd })]);
  const worktrees = [orcaWorktree(prompt),
    { ...orcaWorktree('orphan cwd exact instruction', 'orphan:agent'), worktreeId: 'known-orphan', path: cwd }];
  const good = orcaTerminal({ worktreePath: '/sensitive/repo' });
  const bad = orcaTerminal({ handle: 'orphan-terminal', worktreeId: `repoId::${cwd}`,
    worktreePath: cwd, tabId: 'orphan', leafId: 'terminal', agentIdentity: undefined,
    orphaned: false, ...terminalExtra });
  fixture.options.runOrca = orcaRunner(worktrees, [good, bad]);
  return { fixture, worktrees, good, bad, cwd };
}

test('PR1d R3 unknown-worktree terminal scopes partial to its cwd with actual Orca fields', t => {
  const { fixture, cwd } = orcaTerminalPartialFixture(t);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
  assert.equal(snapshot.orca.terminals.length, 1);
  const live = snapshot.sessions.find(session => session.session_id === 's');
  assert.deepEqual(live.orca_link, { evidence: 'prompt_exact', confirmed: true,
    pane_key: 'p:leaf', terminal_handle: 'h' });
  const affected = snapshot.sessions.find(session => session.session_id === 'orphan');
  assert.deepEqual(affected.orca_link, { evidence: 'ambiguous', confirmed: false,
    pane_key: null, terminal_handle: null });
  assert.equal(snapshot.orca.worktrees[0].agents[0].agent_type, 'claude');
  assert.equal(snapshot.orca.worktrees[0].agents[0].state_started_at, RECORD_TIMESTAMP);
  assert.equal(JSON.stringify(snapshot).includes(cwd), false);
  assert.equal(JSON.stringify(snapshot).includes('worktreePath'), false);
});

for (const [variant, extra] of [
  ['relative path', { worktreePath: 'private/orphan-repo' }],
  ['contradictory id path', { worktreeId: 'repoId::/different/repo' }],
  ['overlapping tab/leaf pane', { tabId: 'p', leafId: 'leaf' }],
  ['overlapping legacy pane', { tabId: undefined, leafId: undefined, paneKey: 'p:leaf' }]
]) {
  test(`PR1d R3 rejected terminal ${variant} cancels confirmations globally`, t => {
    const { fixture } = orcaTerminalPartialFixture(t, extra);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
    assert.equal(snapshot.orca.terminals.length, 1);
    for (const session of snapshot.sessions) {
      assert.equal(session.orca_link.evidence, 'prompt_exact');
      assert.equal(session.orca_link.confirmed, false);
      assert.equal(session.orca_link.terminal_handle, null);
    }
  });
}

for (const [variant, extra] of [
  ['invalid handle', { handle: '' }],
  ['invalid timestamp', { lastOutputAt: 'bad-time' }]
]) {
  test(`PR1d R3 known-worktree terminal ${variant} also scopes to its trusted cwd`, t => {
    const { fixture } = orcaTerminalPartialFixture(t, { worktreeId: 'known-orphan', ...extra });
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.orca.state, 'partial');
    assert.equal(snapshot.orca.terminals.length, 1);
    assert.equal(snapshot.sessions.find(session => session.session_id === 's').orca_link.confirmed, true);
    assert.equal(snapshot.sessions.find(session => session.session_id === 'orphan').orca_link.evidence, 'ambiguous');
  });
}

test('PR1d R3 rejected terminal checks all ps panes including agents without session edges', t => {
  const { fixture, worktrees, good, bad } = orcaTerminalPartialFixture(t);
  worktrees.push({ ...orcaWorktree('no matching session', 'orphan:terminal'),
    worktreeId: 'unrelated', path: '/unrelated/repo' });
  fixture.options.runOrca = orcaRunner(worktrees, [good, bad]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.orca.state, 'partial');
  assert.equal(snapshot.sessions.every(session => !session.orca_link.confirmed), true);
});

for (const sourceAgents of [null, {}, 'invalid', 42]) {
  test(`PR1d R3 present nonarray worktree agents (${JSON.stringify(sourceAgents)}) is globally partial`, t => {
    const { fixture, worktrees, good } = orcaTerminalPartialFixture(t);
    worktrees[1].agents = sourceAgents;
    fixture.options.runOrca = orcaRunner(worktrees, [good]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
    const live = snapshot.sessions.find(session => session.session_id === 's');
    assert.equal(live.orca_link.evidence, 'prompt_exact');
    assert.equal(live.orca_link.confirmed, false);
    assert.equal(live.orca_link.terminal_handle, null);
  });
}

test('PR1d R3 absent worktree agents means zero agents without partial', t => {
  const { fixture, worktrees, good } = orcaTerminalPartialFixture(t);
  delete worktrees[1].agents;
  fixture.options.runOrca = orcaRunner(worktrees, [good]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.coverage.orca, { state: 'ok', code: null });
  assert.equal(snapshot.sessions.find(session => session.session_id === 's').orca_link.confirmed, true);
});


for (const [variant, worktreePath] of [['empty', ''], ['absent', undefined]]) {
  test(`PR1d R4 ${variant} terminal path scopes cancellation using a single absolute id suffix`, t => {
    const { fixture, cwd } = orcaTerminalPartialFixture(t, { worktreePath });
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
    assert.equal(snapshot.orca.terminals.length, 1);
    assert.deepEqual(snapshot.sessions.find(session => session.session_id === 's').orca_link,
      { evidence: 'prompt_exact', confirmed: true, pane_key: 'p:leaf', terminal_handle: 'h' });
    assert.deepEqual(snapshot.sessions.find(session => session.session_id === 'orphan').orca_link,
      { evidence: 'ambiguous', confirmed: false, pane_key: null, terminal_handle: null });
    assert.equal(JSON.stringify(snapshot).includes(cwd), false);
    assert.equal(JSON.stringify(snapshot).includes('worktreePath'), false);
  });
}

for (const [variant, extra] of [
  ['null path', { worktreePath: null }],
  ['nonstring path', { worktreePath: 42 }],
  ['two separators', { worktreePath: '', worktreeId: 'repoId::/private/orphan-repo::/nested' }],
  ['relative id suffix', { worktreePath: '', worktreeId: 'repoId::private/orphan-repo' }],
  ['empty id suffix', { worktreePath: '', worktreeId: 'repoId::' }],
  ['no separator', { worktreePath: undefined, worktreeId: '/private/orphan-repo' }],
  ['nonstring id', { worktreePath: '', worktreeId: 42 }],
  ['derived path with pane conflict', { worktreePath: '', tabId: 'p', leafId: 'leaf' }]
]) {
  test(`PR1d R4 terminal ${variant} cancels confirmations globally`, t => {
    const { fixture } = orcaTerminalPartialFixture(t, extra);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.coverage.orca, { state: 'partial', code: 'orca_unavailable' });
    assert.equal(snapshot.orca.terminals.length, 1);
    for (const session of snapshot.sessions) {
      assert.equal(session.orca_link.evidence, 'prompt_exact');
      assert.equal(session.orca_link.confirmed, false);
      assert.equal(session.orca_link.terminal_handle, null);
    }
  });
}

test('PR1d R5 complete overlong newline within one chunk withholds the session and its small sibling', t => {
  forceLargeFileLimits(t);
  const fixture = createFixture(t);
  const previous = snapshotReader.STREAM_LIMITS.lineBytes;
  t.after(() => { snapshotReader.STREAM_LIMITS.lineBytes = previous; });
  snapshotReader.STREAM_LIMITS.lineBytes = 1000;
  const file = fixture.file('claude', 'a-long', [claudeUserRecord('identity'),
    { type: 'assistant', padding: 'x'.repeat(2000) }]);
  fs.appendFileSync(file, '\n');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.length < 256 * 1024);
  assert.ok(bytes.length - 1 > snapshotReader.STREAM_LIMITS.lineBytes);
  assert.equal(bytes.at(-1), 10);
  fixture.file('claude', 'b-small', [claudeUserRecord('small sibling must stay withheld', { uuid: 'sibling' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.files_failed, 1);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.instructions.length, 0);
});

test('PR1d R5 workflow journal skips exactly once without parse failure or group membership', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'project/main', [claudeUserRecord('main instruction survives')]);
  const journal = fixture.file('claude', 'project/s/subagents/workflows/wf_1/journal', [
    { type: 'launched' }, { type: 'started' }, { type: 'result' }
  ]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.files_scanned, 2);
  assert.equal(snapshot.coverage.claude.files_skipped, 1);
  assert.equal(snapshot.coverage.claude.files_failed, 0);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['s']);
  assert.deepEqual(snapshot.instructions.map(instruction => instruction.text), ['main instruction survives']);
  const internals = loadReaderWithInternals();
  const counters = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const summary = internals.summarizeTranscriptFile('claude', { file: journal, stats: fs.lstatSync(journal),
    root: path.join(fixture.options.homeDir, '.claude/projects') }, counters,
    +SNAPSHOT_TIME - 14 * 86400000, fixture.config());
  assert.equal(summary, null, 'journal is removed before transcript grouping');
  assert.equal(counters.files_scanned, 1);
  assert.equal(counters.files_skipped, 1);
  assert.equal(counters.files_failed, 0);
});

for (const variant of ['session-id', 'other-type']) {
  test(`PR1d R5 workflow journal ${variant} is a regular transcript participating in grouping`, t => {
    const fixture = createFixture(t);
    fixture.file('claude', 'project/main', [claudeUserRecord('main instruction')]);
    const rows = variant === 'session-id'
      ? [{ type: 'result', sessionId: 's', cwd: '/sensitive/repo', timestamp: RECORD_TIMESTAMP }]
      : [{ type: 'unexpected-workflow-event' }];
    const journal = fixture.file('claude', 'project/s/subagents/workflows/wf_1/journal', rows);
    const config = snapshotReader.loadConfig(fixture.options);
    const internals = loadReaderWithInternals();
    const counters = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
    const root = path.join(fixture.options.homeDir, '.claude/projects');
    const summary = internals.summarizeTranscriptFile('claude', { file: journal, root, stats: fs.lstatSync(journal) },
      counters, +SNAPSHOT_TIME - 14 * 86400000, config);
    assert.ok(summary, 'non-journal content is not removed by the journal shortcut');
    assert.equal(counters.files_scanned, 1);
    assert.equal(counters.files_skipped, 0);
    assert.equal(counters.files_failed, 0);
    const groups = new Map();
    internals.groupTranscriptFiles(groups, 'claude', summary);
    assert.equal(groups.size, 1);
    assert.equal([...groups.values()][0].files.has(journal), true);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.files_failed, 0);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, variant === 'session-id' ? 1 : 0);
    assert.equal(snapshot.sessions.length, variant === 'session-id' ? 0 : 1);
    // A sessionless unsupported transcript can still be skipped by the later generic rule.
    assert.equal(snapshot.coverage.claude.files_skipped, variant === 'session-id' ? 0 : 1);
  });
}

test('PR1d R5 changed discarded-details reread remains a blocked competitor for the same cwd and pane', t => {
  const fixture = createFixture(t);
  const cap = snapshotPolicy.SNAPSHOT_LIMITS.sessions;
  const prompt = 'live uniquely matching instruction';
  let firstFile, originalFirst;
  for (let index = 0; index <= cap; index++) {
    const row = claudeUserRecord(index === 1 ? prompt : `different instruction ${index}`, {
      sessionId: `s${index}`, timestamp: new Date(Date.parse(RECORD_TIMESTAMP) - (cap - index) * 1000).toISOString(),
      cwd: index <= 1 ? '/sensitive/repo' : '/unrelated/repo'
    });
    const file = fixture.file('claude', `a-${String(index).padStart(3, '0')}`, [row]);
    if (index === 0) { firstFile = file; originalFirst = row; }
  }
  // Evict s0, then invalidate the newest group so final selection must restore s0.
  fixture.file('claude', 'z-duplicate', [claudeUserRecord('duplicate newest', {
    sessionId: `s${cap}`, cwd: '/unrelated/repo'
  })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const baseline = snapshotReader.runSnapshot(fixture.options);
  assert.equal(baseline.sessions.length, cap);
  assert.equal(baseline.coverage.claude.files_failed, 0);
  assert.equal(baseline.sessions.find(session => session.session_id === 's1').orca_link.confirmed, true);
  const inode = fs.statSync(firstFile).ino;
  const originalOpen = fs.openSync;
  let firstOpens = 0;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === firstFile && ++firstOpens === 2) {
      fs.writeFileSync(firstFile, JSON.stringify({ ...originalFirst,
        timestamp: new Date(Date.parse(originalFirst.timestamp) + 1000).toISOString() }));
    }
    return originalOpen(file, ...args);
  });
  const changed = snapshotReader.runSnapshot(fixture.options);
  assert.equal(firstOpens, 2, 'the discarded file is reopened exactly once after the initial pass');
  assert.equal(fs.statSync(firstFile).ino, inode, 'only content changes between passes');
  assert.equal(changed.coverage.claude.files_scanned, cap + 2);
  assert.equal(changed.coverage.claude.multi_file_withheld, 1);
  assert.equal(changed.coverage.claude.files_failed, 1);
  assert.equal(changed.sessions.length, cap - 1);
  assert.equal(changed.sessions.some(session => session.session_id === 's0'), false);
  assert.equal(changed.instructions.some(instruction => instruction.id.startsWith('claude:s0:')), false);
  assert.deepEqual(changed.sessions.find(session => session.session_id === 's1').orca_link,
    { evidence: 'ambiguous', confirmed: false, pane_key: null, terminal_handle: null });
});

function appendPastLegacyFileLimit(file) {
  const padding = JSON.stringify({ type: 'assistant', padding: 'x'.repeat(1024 * 1024) }) + '\n';
  while (fs.statSync(file).size <= snapshotReader.MAX_FILE_BYTES) fs.appendFileSync(file, '\n' + padding);
}

for (const large of [false, true]) {
  test(`PR1d R1a-1 late Codex identity blocks its small sibling (${large ? 'limited large' : 'legacy small'})`, t => {
    const fixture = createFixture(t);
    const file = fixture.file('codex', 'a', [{ type: 'assistant', padding: 'x'.repeat(70000) },
      codexSessionMeta(), { type: 'assistant', padding: 'x'.repeat(9 * 1024 * 1024) }]);
    if (large) appendPastLegacyFileLimit(file);
    fixture.file('codex', 'b', [codexSessionMeta(), codexMessage('must stay withheld')]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.codex.multi_file_withheld, 1);
    assert.equal(snapshot.coverage.codex.large_file_withheld, large ? 1 : 0);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.instructions.length, 0);
    assertReaderError(() => snapshotReader.excludeQuery({ ...fixture.options,
      target: { kind: 'session', provider: 'codex', sessionId: 's' } }), 'target_not_found');
  });

  test(`PR1d R1a-2 broken journal conditions enter ordinary identity grouping (${large ? 'limited large' : 'legacy small'})`, t => {
    const fixture = createFixture(t);
    fixture.file('claude', 'project/main', [claudeUserRecord('must stay withheld')]);
    const file = fixture.file('claude', 'project/s/subagents/workflows/wf_1/journal', [
      { type: 'result', sessionId: 's', timestamp: RECORD_TIMESTAMP },
      { type: 'assistant', padding: 'x'.repeat(9 * 1024 * 1024) }
    ]);
    if (large) appendPastLegacyFileLimit(file);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
    assert.equal(snapshot.coverage.claude.large_file_withheld, large ? 1 : 0);
    assert.equal(snapshot.coverage.claude.files_skipped, 0);
    assert.equal(snapshot.sessions.length, 0);
  });

  test(`PR1d R1b-1 late cwd participates in uniqueness (${large ? 'limited large' : 'legacy small'})`, t => {
    const fixture = createFixture(t);
    const prompt = 'shared human prompt';
    fixture.file('claude', 'a-visible', [claudeUserRecord(prompt, { sessionId: 'visible' })]);
    const file = fixture.file('claude', 'b-hidden', [
      { type: 'assistant', sessionId: 'hidden', timestamp: RECORD_TIMESTAMP, padding: 'x'.repeat(70000) },
      claudeUserRecord(prompt, { sessionId: 'hidden', uuid: 'hidden-user' }),
      { type: 'assistant', sessionId: 'hidden', timestamp: RECORD_TIMESTAMP, padding: 'x'.repeat(8 * 1024 * 1024 + 1) }
    ]);
    if (large) appendPastLegacyFileLimit(file);
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.large_file_withheld, large ? 1 : 0);
    assert.equal(snapshot.sessions.find(session => session.session_id === 'visible').orca_link.evidence, 'ambiguous');
    assert.equal(snapshot.sessions.find(session => session.session_id === 'visible').orca_link.confirmed, false);
    assert.equal(snapshot.sessions.length, large ? 1 : 2);
  });
}

test('PR1d R1a-1 large failed files retain just the first identity; later siblings export with provider links blocked', t => {
  const fixture = createFixture(t);
  const file = fixture.file('codex', 'a-mixed', [{ type: 'assistant', padding: 'x'.repeat(70000) },
    codexSessionMeta({ id: 'first' }), codexSessionMeta({ id: 'second' }),
    { type: 'assistant', padding: 'x'.repeat(9 * 1024 * 1024) }]);
  appendPastLegacyFileLimit(file);
  for (const sid of ['first', 'second']) fixture.file('codex', `b-${sid}`, [codexSessionMeta({ id: sid }), codexMessage(sid)]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.codex.large_file_withheld, 1);
  assert.equal(snapshot.coverage.codex.mixed_session_withheld, 0);
  assert.equal(snapshot.coverage.codex.multi_file_withheld, 1);
  assert.equal(snapshot.coverage.codex.link_blocked, 1);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['second']);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
});

test('PR1d R1a-3 a 9MB line inside a legacy small file preserves byte-identical output', t => {
  const fixture = createFixture(t);
  const file = fixture.file('claude', 'main', [claudeUserRecord('unchanged human instruction')]);
  const baseline = snapshotReader.runSnapshot(fixture.options);
  fs.appendFileSync(file, '\n' + JSON.stringify({ type: 'assistant', padding: 'x'.repeat(9 * 1024 * 1024) }) + '\n');
  assert.ok(fs.statSync(file).size <= snapshotReader.MAX_FILE_BYTES);
  assert.deepEqual(snapshotReader.runSnapshot(fixture.options), baseline);
});

test('PR1d R1a-3 33334 legacy small-file records match array parsing and keep first plus recent 200', t => {
  const fixture = createFixture(t);
  const rows = Array.from({ length: 33334 }, (_, index) => claudeUserRecord('ok', { uuid: `u${index}` }));
  const file = fixture.file('claude', 'main', rows);
  assert.ok(fs.statSync(file).size < snapshotReader.MAX_FILE_BYTES);
  const config = snapshotReader.loadConfig(fixture.options);
  const internals = loadReaderWithInternals();
  const counters = Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0]));
  const legacy = internals.parseFile('claude', rows, counters, config);
  const scanned = internals.scanSessions(fixture.options, config);
  assert.equal(scanned.all.length, 1);
  assert.deepEqual(scanned.all[0], legacy);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions[0].instruction_total, 33334);
  assert.equal(snapshot.sessions[0].instruction_count, 201);
  assert.equal(snapshot.coverage.claude.large_file_withheld, 0);
});

for (const [variant, record] of [
  ['peer source', queuedHuman('ignored', { uuid: 'peer' }, { origin: { kind: 'peer' }, source_uuid: 'u' })],
  ['peer same uuid', queuedHuman('ignored', { uuid: 'u' }, { origin: { kind: 'peer' } })],
  ['task source', queuedHuman('ignored', { uuid: 'task' }, { origin: { kind: 'task-notification' }, source_uuid: 'u' })],
  ['false human turn', queuedHuman('ignored', {}, { humanTurn: false, source_uuid: 'u' })],
  ['sidechain', queuedHuman('ignored', { isSidechain: true }, { source_uuid: 'u' })],
  ['system wrapper', queuedHuman('<task-notification>ignored</task-notification>', {}, { source_uuid: 'u' })],
  ['missing timestamp', queuedHuman('ignored', { timestamp: undefined }, { source_uuid: 'u' })]
]) {
  test(`PR1d R1a-4 ignored queued attachment (${variant}) cannot withhold a human session`, t => {
    const fixture = createFixture(t);
    fixture.file('claude', 'main', [claudeUserRecord('keep human'), record]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.queued_duplicate_withheld, 0);
    assert.equal(snapshot.coverage.claude.queued_delivered_attachment, 0);
    assert.equal(snapshot.sessions.length, 1);
    assert.deepEqual(snapshot.instructions.map(item => item.text), ['keep human']);
    assert.equal(snapshotReader.excludeQuery({ ...fixture.options, target: instructionTarget(snapshot.instructions[0]) }).target,
      snapshot.instructions[0].id);
  });
}

test('PR1d R1a-5 queue operation strings cannot impersonate attachment and withholding counters', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'main', [claudeUserRecord('human'),
    ...['enqueue', 'dequeue', 'remove', 'enqueued', 'dequeued', 'removed', 'delivered_attachment', 'duplicate_withheld', 'toString', '__proto__', ['enqueue'], {}, null, 42].map(operation =>
      ({ type: 'queue-operation', operation }))]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  for (const key of ['queued_enqueued', 'queued_dequeued', 'queued_removed']) assert.equal(snapshot.coverage.claude[key], 1);
  assert.equal(snapshot.coverage.claude.queued_delivered_attachment, 0);
  assert.equal(snapshot.coverage.claude.queued_duplicate_withheld, 0);
});

test('PR1d R1b-2 invalid Codex content rules keep the hidden prompt as a uniqueness competitor', t => {
  const fixture = createFixture(t);
  for (const sid of ['visible', 'hidden']) fixture.file('codex', sid, [codexSessionMeta({ id: sid }), codexMessage('shared human prompt')]);
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config();
  config.exclude.instructions.push({ id: 'codex:hidden:n1' });
  fixture.save(config);
  fixture.options.runOrca = orcaRunner([orcaWorktree('shared human prompt', 'p:leaf', { agentType: 'codex' })], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.codex.withheld_sessions, 1);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['visible']);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
});

test('PR1d R1b-3 distinct lone UTF-16 surrogates cannot collide in producer comparison', t => {
  const fixture = createFixture(t);
  const raw = 'a'.repeat(198) + '\uDC00' + 'x'.repeat(5000);
  const prompt = 'a'.repeat(198) + '\uDC01' + 'x';
  assert.notEqual(snapshotReader.orcaPromptForm(raw).value, prompt);
  fixture.file('claude', 'main', [claudeUserRecord(raw)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const different = snapshotReader.runSnapshot(fixture.options);
  assert.equal(different.sessions[0].orca_link.confirmed, false);
  assert.equal(different.sessions[0].orca_link.evidence, 'cwd_only');
  fixture.options.runOrca = orcaRunner([orcaWorktree(snapshotReader.orcaPromptForm(raw).value)], []);
  const equal = snapshotReader.runSnapshot(fixture.options);
  assert.equal(equal.sessions[0].orca_link.confirmed, true);
  assert.equal(equal.sessions[0].orca_link.evidence, 'prompt_trunc');
});

test('PR1d R2-A1 shell queued attachments participate in delivery duplicates and cannot bypass deletion', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 's', [claudeUserRecord('<bash-input>echo hi</bash-input>'),
    queuedHuman('<bash-input>echo hi</bash-input>', { uuid: 'q' }, { source_uuid: 'u' })]);
  snapshotReader.loadConfig(fixture.options);
  const config = fixture.config(); config.exclude.instructions.push({ id: 'claude:s:uu' }); fixture.save(config);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.queued_duplicate_withheld, 1);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.instructions.length, 0);
});

test('PR1d R2-A1 duplicate shell instruction IDs withhold just their session instead of failing collection', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 's', [claudeUserRecord('<bash-input>echo hi</bash-input>'),
    queuedHuman('<bash-input>echo hi</bash-input>', { uuid: 'u' })]);
  fixture.file('claude', 'other', [claudeUserRecord('other survives', { sessionId: 'other' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['other']);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
});

test('PR1d R2-A2 snapshot and exclusion use the same first identity for a mixed sibling file', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'project/a-mixed', [claudeUserRecord('first', { sessionId: 'x', uuid: 'x1' }),
    claudeUserRecord('mixed history', { uuid: 's1' })]);
  fixture.file('claude', 'project/b-small', [claudeUserRecord('must remain visible')]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['s']);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
  assert.equal(snapshot.coverage.claude.mixed_session_withheld, 1);
  const target = { kind: 'session', provider: 'claude', sessionId: 's' };
  const query = snapshotReader.excludeQuery({ ...fixture.options, target });
  assert.equal(query.equiv_count, 1);
  assert.equal(snapshotReader.excludeCommit({ ...fixture.options, target, token: query.token }).counts.registered, 1);
});

test('PR1d R2-A3 provisional duplicate-key headers cannot invent an in-window group identity', t => {
  const fixture = createFixture(t);
  const file = fixture.file('claude', 'project/a-mixed', []);
  fs.writeFileSync(file, '{"type":"assistant","sessionId":"victim","timestamp":"' + RECORD_TIMESTAMP
    + '","padding":"' + 'x'.repeat(70000) + '","sessionId":"actual"}\n'
    + JSON.stringify({ type: 'assistant', sessionId: 'other', timestamp: RECORD_TIMESTAMP }));
  fixture.file('claude', 'project/b-victim', [claudeUserRecord('must remain visible', { sessionId: 'victim' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['victim']);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 0);
});

test('PR1d R2-C1 missing time blocks the whole Claude provider while Codex still confirms', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'project/visible', [claudeUserRecord('shared human prompt', { sessionId: 'visible' })]);
  fixture.file('claude', 'different-project/hidden', [claudeUserRecord('shared human prompt',
    { sessionId: 'hidden', timestamp: undefined })]);
  fixture.file('claude', 'other-project/else', [claudeUserRecord('different live task',
    { sessionId: 'else', cwd: '/different/repo' })]);
  fixture.file('codex', 'codex', [codexSessionMeta({ id: 'codex' }), codexMessage('shared human prompt')]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('shared human prompt'),
    { ...orcaWorktree('shared human prompt', 'cx:leaf', { agentType: 'codex' }), worktreeId: 'cx' },
    { ...orcaWorktree('different live task', 'else:leaf'), worktreeId: 'else', path: '/different/repo' }], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  const claude = snapshot.sessions.find(session => session.provider === 'claude');
  assert.deepEqual(claude.orca_link, { evidence: 'ambiguous', confirmed: false, pane_key: null, terminal_handle: null });
  assert.equal(snapshot.sessions.find(session => session.provider === 'codex').orca_link.confirmed, true);
  assert.equal(snapshot.sessions.filter(session => session.provider === 'claude').length, 2);
  assert.equal(snapshot.sessions.filter(session => session.provider === 'claude').every(session =>
    session.orca_link.evidence === 'ambiguous' && !session.orca_link.confirmed && session.orca_link.pane_key === null), true);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
});

test('PR1d R2-C2 nonstring prompts and producer forms shorter than eight cannot confirm truncation', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 's', [claudeUserRecord(' '.repeat(1664) + 'different task')]);
  for (const prompt of [null, undefined, {}, '']) {
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
    assert.equal(snapshot.sessions[0].orca_link.evidence, 'cwd_only');
  }
});

test('PR1d R2-C3 reread cwd drift blocks provider confirmation without retaining new cwd competitors', t => {
  const fixture = createFixture(t);
  const cap = snapshotPolicy.SNAPSHOT_LIMITS.sessions, prompt = 'shared human prompt';
  let firstFile;
  for (let index = 0; index <= cap; index++) {
    const file = fixture.file('claude', `a-${String(index).padStart(3, '0')}`, [claudeUserRecord(index === 1 ? prompt : 'old instruction', {
      sessionId: `s${index}`, cwd: index === 0 ? '/old' : index === 1 ? '/sensitive/repo' : '/else',
      timestamp: new Date(Date.parse(RECORD_TIMESTAMP) - (cap - index) * 1000).toISOString()
    })]);
    if (index === 0) firstFile = file;
  }
  fixture.file('claude', 'z-duplicate', [claudeUserRecord('duplicate', { sessionId: `s${cap}`, cwd: '/else' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const originalOpen = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === firstFile && ++opens === 2) fs.writeFileSync(firstFile, JSON.stringify(claudeUserRecord(prompt, {
      sessionId: 's0', cwd: '/sensitive/repo',
      timestamp: new Date(Date.parse(RECORD_TIMESTAMP) - (cap - 1) * 1000).toISOString()
    })));
    return originalOpen(file, ...args);
  });
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(opens, 2);
  assert.equal(snapshot.sessions.find(session => session.session_id === 's1').orca_link.confirmed, false);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
});

test('PR1d R2-C4 an uninterpretable rejected terminal pane forces global cancellation', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 's', [claudeUserRecord('shared human prompt')]);
  fixture.options.runOrca = orcaRunner([orcaWorktree('shared human prompt')], [orcaTerminal({ handle: 'orphan',
    worktreeId: 'missing::/else', worktreePath: '/else', tabId: 'p', leafId: null })]);
  assert.equal(snapshotReader.runSnapshot(fixture.options).sessions[0].orca_link.confirmed, false);
});

test('PR1d R2-C5 varying cwd rows retain only one representative cwd and bounded per-file summary', t => {
  const fixture = createFixture(t);
  const rows = Array.from({ length: 5000 }, (_, index) => ({ type: 'assistant', sessionId: 's',
    timestamp: RECORD_TIMESTAMP, cwd: `/r/0/${index}` }));
  const file = fixture.file('claude', 's', rows);
  const config = snapshotReader.loadConfig(fixture.options);
  const summary = loadReaderWithInternals().summarizeTranscriptFile('claude', { file,
    root: path.join(fixture.options.homeDir, '.claude/projects'), stats: fs.lstatSync(file) },
    Object.fromEntries(snapshotPolicy.COVERAGE_KEYS.claude.map(key => [key, 0])), +SNAPSHOT_TIME - 14 * 86400000, config);
  assert.equal(Object.hasOwn(summary, 'cwdHashes'), false);
  assert.equal(Object.hasOwn(summary, 'sessionIds'), false);
  assert.equal(summary.session.cwd, '/r/0/0');
  assert.ok(countStoredStringCharacters(summary) < 4000);
});

test('PR1d S1 normally parsed multi-file groups compete through each file summary', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'visible', [claudeUserRecord(prompt, { sessionId: 'visible' })]);
  for (const name of ['a-duplicate', 'b-duplicate']) fixture.file('claude', name, [claudeUserRecord(prompt)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['visible']);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  for (const name of ['a-duplicate', 'b-duplicate']) fixture.file('claude', name, [claudeUserRecord('different task')]);
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
  assert.equal(snapshot.coverage.claude.multi_file_withheld, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
});

test('PR1d S1 no-human files and verified sidechain/journal skips preserve confirmation', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'project/main', [claudeUserRecord(prompt)]);
  fixture.file('claude', 'else/empty', [{ type: 'assistant', sessionId: 'empty',
    cwd: '/sensitive/repo', timestamp: RECORD_TIMESTAMP }]);
  fixture.file('claude', 'project/s/subagents/agent-side', [claudeUserRecord('side', { isSidechain: true })]);
  fixture.file('claude', 'project/s/subagents/workflows/wf/journal', [{ type: 'launched' }, { type: 'result' }]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
  assert.equal(snapshot.coverage.claude.files_skipped, 2);
  assert.equal(snapshot.sessions.find(session => session.session_id === 's').orca_link.confirmed, true);
});

test('PR1d S1 directory scan failure blocks links even when visible files parse normally', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'good/main', [claudeUserRecord(prompt)]);
  fixture.file('claude', 'bad/missing', [claudeUserRecord('unread', { sessionId: 'missing' })]);
  const bad = path.join(fixture.options.homeDir, '.claude/projects/bad'), original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', function(dir, ...args) {
    if (dir === bad) throw Object.assign(new Error(), { code: 'EACCES' });
    return original(dir, ...args);
  });
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.files_failed, 1);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
});

test('PR1d S1 exploration cap marks provider comparison incomplete', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'a-visible', [claudeUserRecord(prompt)]);
  fixture.file('claude', 'z-hidden', [claudeUserRecord(prompt, { sessionId: 'hidden' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = loadReaderWithInternals(1).runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.coverage.claude.files_failed, 1);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
});

for (const id of [undefined, 'invalid/id']) {
  test(`PR1d S2 first invalid Codex metadata (${id}) is never replaced by a later identity`, t => {
    const fixture = createFixture(t);
    fixture.file('codex', 'a-invalid', [codexSessionMeta({ id }), codexSessionMeta(), codexMessage('bad mixed history')]);
    fixture.file('codex', 'b-valid', [codexSessionMeta(), codexMessage('valid session survives')]);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['s']);
    assert.equal(snapshot.coverage.codex.multi_file_withheld, 0);
    assert.equal(snapshot.coverage.codex.link_blocked, 1);
    assert.equal(snapshotReader.excludeQuery({ ...fixture.options,
      target: { kind: 'session', provider: 'codex', sessionId: 's' } }).equiv_count, 1);
  });
}

test('PR1d S1 correction ignores complete state jsonl with no session identity or instruction candidates', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'project/main', [claudeUserRecord(prompt)]);
  fixture.file('claude', '.ao/state/ao-model-usage', [{ type: 'usage', model: 'claude', tokens: 17 }]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
  assert.equal(snapshot.coverage.claude.files_skipped, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
});

test('PR1d S1 correction duplicate Codex identities withhold output but compete by last sorted prompt', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('codex', 'visible', [codexSessionMeta({ id: 'visible' }), codexMessage(prompt)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt, 'p:leaf', { agentType: 'codex' })], []);
  const hidden = text => fixture.file('codex', 'hidden', [codexSessionMeta({ id: 'hidden' }),
    codexMessage(text, { id: 'duplicate' }), { ...codexMessage('older different prompt', { id: 'duplicate' }),
      timestamp: '2026-10-08T01:59:00.000Z' }]);
  hidden(prompt);
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.deepEqual(snapshot.sessions.map(session => session.session_id), ['visible']);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  hidden('a different human prompt');
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
});

for (const newline of [true, false]) {
  test(`PR1d S1 correction invalid final JSON line ${newline ? 'with newline blocks' : 'without newline stays pending'}`, t => {
    const fixture = createFixture(t), prompt = 'shared human prompt';
    const file = fixture.file('claude', 'main', [claudeUserRecord(prompt)]);
    fs.appendFileSync(file, '\n{"type":"user","message":' + (newline ? '\n' : ''));
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.link_blocked, newline ? 1 : 0);
    assert.equal(snapshot.coverage.claude.records_unverified, 1);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, !newline);
    if (newline) assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  });
}

test('PR1d S1 correction skipped last instruction candidates with missing time or identity block older prompt', t => {
  for (const provider of ['claude', 'codex']) for (const invalid of ['timestamp', 'identity']) {
    const fixture = createFixture(t), prompt = 'shared human prompt';
    const latest = provider === 'claude' ? claudeUserRecord('new human instruction', { uuid: 'later' })
      : codexMessage('new human instruction', { id: 'later' });
    if (invalid === 'timestamp') delete latest.timestamp;
    else if (provider === 'claude') latest.uuid = 'bad/id';
    else latest.payload.id = 'bad/id';
    fixture.file(provider, 'main', provider === 'claude' ? [claudeUserRecord(prompt), latest]
      : [codexSessionMeta(), codexMessage(prompt), latest]);
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt, 'p:leaf', { agentType: provider })], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage[provider].link_blocked, 1, `${provider}/${invalid}`);
    assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
    assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
  }
});

test('PR1d S1 correction exec-excluded Codex files keep their prompt competition', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('codex', 'visible', [codexSessionMeta({ id: 'visible' }), codexMessage(prompt)]);
  const hidden = text => fixture.file('codex', 'exec', [codexSessionMeta({ id: 'exec', source: 'exec' }), codexMessage(text)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt, 'p:leaf', { agentType: 'codex' })], []);
  hidden(prompt);
  let snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.codex.exec_sessions_excluded, 1);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
  assert.equal(snapshot.sessions[0].orca_link.evidence, 'ambiguous');
  hidden('different exec prompt');
  snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, true);
});


test('PR1d S1 correction queued candidates missing timestamp or uuid also invalidate the last prompt', t => {
  for (const field of ['timestamp', 'uuid']) {
    const fixture = createFixture(t), prompt = 'shared human prompt';
    const queued = { type: 'attachment', sessionId: 's', uuid: 'later', timestamp: RECORD_TIMESTAMP,
      attachment: { type: 'queued_command', origin: { kind: 'human' }, commandMode: 'prompt', prompt: 'new instruction' } };
    delete queued[field];
    fixture.file('claude', 'main', [claudeUserRecord(prompt), queued]);
    fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.link_blocked, 1, field);
    assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
  }
});

test('PR1d S1 correction a broken nonfinal line still blocks when the last valid record has no newline', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  const file = fixture.file('claude', 'main', []);
  fs.writeFileSync(file, '{broken JSON\n' + JSON.stringify(claudeUserRecord(prompt)));
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.sessions[0].orca_link.confirmed, false);
});

test('PR1d S1 correction reread notices newly completed broken JSON without changing session times', t => {
  const fixture = createFixture(t), cap = snapshotPolicy.SNAPSHOT_LIMITS.sessions;
  const prompt = 'shared human prompt';
  let firstFile;
  for (let index = 0; index <= cap; index++) {
    const file = fixture.file('claude', `a-${String(index).padStart(3, '0')}`, [claudeUserRecord(index === 1 ? prompt : 'older task', {
      sessionId: `s${index}`, cwd: index === 1 ? '/sensitive/repo' : '/else',
      timestamp: new Date(Date.parse(RECORD_TIMESTAMP) - (cap - index) * 1000).toISOString()
    })]);
    if (index === 0) firstFile = file;
  }
  fixture.file('claude', 'z-duplicate', [claudeUserRecord('duplicate', { sessionId: `s${cap}`, cwd: '/else' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const originalOpen = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (file === firstFile && ++opens === 2) fs.appendFileSync(firstFile, '\n{broken JSON\n');
    return originalOpen(file, ...args);
  });
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(opens, 2);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.sessions.some(session => session.session_id === 's0'), true);
  assert.equal(snapshot.sessions.find(session => session.session_id === 's1').orca_link.evidence, 'ambiguous');
});

test('PR1d R3-A1 rejected complete instruction IDs invalidate the provider comparison', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  fixture.file('claude', 'visible', [claudeUserRecord(prompt, { sessionId: 'visible' })]);
  fixture.file('claude', 'hidden', [claudeUserRecord('different human prompt', { sessionId: 'token', uuid: 'a' }),
    claudeUserRecord(prompt, { sessionId: 'token', uuid: 'tail' })]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt)], []);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.sessions.find(session => session.session_id === 'visible').orca_link.evidence, 'ambiguous');
  assert.equal(snapshot.instructions.some(instruction => instruction.id === 'claude:token:utail'), false);
});

for (const excluded of [false, true]) {
  test(`PR1d R3-${excluded ? 'C1' : 'A2'} original parse marker keys cannot erase a completed competing instruction`, t => {
    const fixture = createFixture(t), prompt = 'shared human prompt';
    fixture.file('claude', 'visible', [claudeUserRecord(prompt, { sessionId: 'visible', cwd: '/repo' })]);
    const hidden = fixture.file('claude', 'hidden', [claudeUserRecord('older different prompt',
      { sessionId: 'hidden', uuid: 'a', cwd: '/repo' }), claudeUserRecord(prompt, {
      sessionId: 'hidden', uuid: 'tail', cwd: '/repo', timestamp: '2026-10-08T02:01:00.000Z',
      __invalid: true, __pending: true, __parseFailed: true })]);
    fs.appendFileSync(hidden, '\n');
    snapshotReader.loadConfig(fixture.options);
    if (excluded) { const config = fixture.config(); config.exclude.sessions = ['claude:hidden']; fixture.save(config); }
    fixture.options.runOrca = orcaRunner([{ ...orcaWorktree(prompt, 'p:leaf', {
      updatedAt: Date.parse('2026-10-08T02:01:00.000Z'), stateStartedAt: Date.parse('2026-10-08T02:01:00.000Z') }), path: '/repo' }], []);
    const snapshot = snapshotReader.runSnapshot(fixture.options);
    assert.equal(snapshot.coverage.claude.link_blocked, 0);
    assert.equal(snapshot.sessions.find(session => session.session_id === 'visible').orca_link.evidence, 'ambiguous');
    if (!excluded) assert.equal(snapshot.instructions.some(instruction => instruction.id === 'claude:hidden:utail'), true);
  });
}

test('PR1d R3-A3 repeated queued instruction IDs count queued duplicate withholding', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'queued', [queuedHuman('first', { uuid: 'q' }), queuedHuman('second', { uuid: 'q' })]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.coverage.claude.queued_duplicate_withheld, 1);
  assert.equal(snapshot.coverage.claude.records_unverified, 1);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
});

test('PR1d R3-C2 same-cwd inventories use bounded indexed edges and stop competing agent queries at two', () => {
  const { buildOrcaLinkCandidates, applyOrcaLinks } = loadReaderWithInternals();
  const cwdHash = 'a'.repeat(64), hash = 'b'.repeat(64), count = 1000;
  let timeChecks = 0;
  const sessions = Array.from({ length: count }, (_, index) => ({ provider: 'claude', cwdHash,
    firstAt: RECORD_TIMESTAMP, lastAt: RECORD_TIMESTAMP, link_text: { hash, length: 8, truncated: false },
    ...(index === count - 1 ? { output: {} } : {}) }));
  const agents = Array.from({ length: count }, (_, index) => ({ provider: 'claude', cwdHash, pane: `p:${index}`,
    prompt: { hash, length: 8, prefix_hashes: [] }, get times() { timeChecks++; return [Date.parse(RECORD_TIMESTAMP)]; } }));
  const edges = buildOrcaLinkCandidates(sessions, agents);
  assert.ok(edges.length <= 2, `retained ${edges.length} edges for one output session`);
  assert.ok(timeChecks < count * 10, `${timeChecks} time checks exceeded bounded matching`);
  applyOrcaLinks(sessions, edges);
  assert.deepEqual(sessions.at(-1).output.orca_link,
    { evidence: 'ambiguous', confirmed: false, pane_key: null, terminal_handle: null });
});


test('PR1d R3 parse marker keys in text blocks remain ordinary source fields', t => {
  const fixture = createFixture(t);
  fixture.file('claude', 'main', [claudeUserRecord([{ type: 'text', text: 'a regular human instruction',
    __invalid: true, __pending: true, __parseFailed: true }])]);
  const snapshot = snapshotReader.runSnapshot(fixture.options);
  assert.equal(snapshot.instructions[0].text, 'a regular human instruction');
  assert.equal(snapshot.coverage.claude.records_unverified, 0);
  assert.equal(snapshot.coverage.claude.link_blocked, 0);
});

test('PR1d R3 comparison summary cap blocks only its provider and bounds retained competitors', t => {
  const fixture = createFixture(t), prompt = 'shared human prompt';
  for (let index = 0; index < 3; index++) fixture.file('claude', `file-${index}`, [claudeUserRecord(prompt,
    { sessionId: `s${index}` })]);
  fixture.file('codex', 'codex', [codexSessionMeta(), codexMessage(prompt)]);
  fixture.options.runOrca = orcaRunner([orcaWorktree(prompt),
    { ...orcaWorktree(prompt, 'cx:leaf', { agentType: 'codex' }), worktreeId: 'cx' }], []);
  const reader = loadReaderWithInternals(undefined, 2);
  const snapshot = reader.runSnapshot(fixture.options);
  assert.equal(snapshot.coverage.claude.link_blocked, 1);
  assert.equal(snapshot.coverage.codex.link_blocked, 0);
  assert.equal(snapshot.sessions.filter(session => session.provider === 'claude').every(session =>
    session.orca_link.evidence === 'ambiguous' && !session.orca_link.confirmed), true);
  assert.equal(snapshot.sessions.find(session => session.provider === 'codex').orca_link.confirmed, true);
  const { linkCandidates } = reader.scanSessions(fixture.options, fixture.config());
  assert.ok(linkCandidates.filter(session => session.provider === 'claude').length <= 2);
});

test('PR1d R3 full hidden summary and agent dimensions fit a 64MB heap without output edges', { timeout: 30000 }, () => {
  const { spawnSync } = require('node:child_process');
  const filename = require.resolve('../../scripts/lib/sessionSnapshotReader.cjs');
  const source = `
    const fs = require('node:fs'), Module = require('node:module');
    const loaded = new Module(process.argv[1], module);
    loaded.filename = process.argv[1];
    loaded._compile(fs.readFileSync(process.argv[1], 'utf8') +
      '\\nmodule.exports.testBuild = buildOrcaLinkCandidates;', process.argv[1]);
    const timestamp = '2026-10-08T02:00:00.000Z', cwdHash = 'a'.repeat(64), hash = 'b'.repeat(64);
    const sessions = Array.from({ length: 9900 }, () => ({ provider: 'claude', cwdHash,
      firstAt: timestamp, lastAt: timestamp, link_text: { hash, length: 8, truncated: false } }));
    const agents = Array.from({ length: 30000 }, (_, index) => ({ provider: 'claude', cwdHash,
      pane: 'p:' + index, prompt: { hash, length: 8 }, times: [Date.parse(timestamp)] }));
    const edges = loaded.exports.testBuild(sessions, agents);
    if (edges.length !== 0 || edges.paneMatches.size !== 30000) throw new Error('unbounded or incomplete matching');
    process.stdout.write('bounded');
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', source, filename],
    { encoding: 'utf8', timeout: 25000, env: { ...process.env, PALANTIR_BLOCK_REAL_SPAWN: '1' } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'bounded');
});
