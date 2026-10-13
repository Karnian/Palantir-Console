'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setup, cases, TS, user } = require('./fixtures/session-snapshot/a1a.cjs');
const script = path.resolve(__dirname, '../../scripts/answer-audit.mjs');
function run(f, input, stdin = false) {
  const result = spawnSync(process.execPath, stdin ? ['-'] : [script], { env: { ...f.env,
    ANSWER_AUDIT_INPUT: JSON.stringify({ homeDir: f.home, ...input }) }, encoding: 'utf8',
    input: stdin ? fs.readFileSync(script, 'utf8') : undefined });
  assert.equal(result.stderr, ''); assert.equal(result.stdout.includes('ANSWER_BODY_SENTINEL'), false);
  return JSON.parse(result.stdout);
}
for (const provider of ['claude', 'codex']) test(`independent ${provider} correct, forged and stdin diag`, t => {
  const f = setup(t, cases[provider]);
  const stats = fs.statSync(f.files[0], { bigint: true });
  const fp = crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16);
  const input = { provider, instrId: provider + ':s:' + (provider === 'claude' ? 'uu' : 'n1'), file_fp: fp,
    evidence_ids: [provider === 'claude' ? 'a' : 't'], segment: { start_id: provider === 'claude' ? 'u' : 't', end_id: provider === 'claude' ? 'a' : 't' } };
  assert.equal(run(f, input).ok, true); assert.equal(run(f, input, true).ok, true);
  assert.equal(run(f, { ...input, evidence_ids: ['outside'] }).ok, false);
  assert.equal(run(f, { ...input, segment: { ...input.segment, start_id: 'other-turn' } }).ok, false);
  if (provider === 'claude') {
    fs.appendFileSync(f.files[0], JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'resume', parentUuid: 'a', timestamp: TS,
      message: { stop_reason: 'tool_use' } }) + '\n');
    assert.equal(run(f, input).ok, false);
    assert.equal(run(f, { ...input, evidence_ids: ['resume'], segment: { start_id: 'u', end_id: 'resume' } }).ok, false);
  } else {
    fs.appendFileSync(f.files[0], JSON.stringify({ type: 'event_msg', timestamp: TS, payload: { type: 'turn_aborted', turn_id: 't' } }) + '\n');
    assert.equal(run(f, input).ok, false);
  }
});
test('audit source has no answer/core dependency and no body output', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /sessionAnswerReader|sessionTranscriptCore/);
  assert.doesNotMatch(source, /last_agent_message|console\.log/);
});
test('audit detects competing branches, next instruction outside evidence, and unfinished JSON remains harmless', t => {
  const f = setup(t);
  const stats = fs.statSync(f.files[0], { bigint: true });
  const input = { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } };
  fs.appendFileSync(f.files[0], '{"type":'); assert.equal(run(f, input).ok, true);
  fs.writeFileSync(f.files[0], cases.claude[0][2].map(JSON.stringify).join('\n') + '\n');
  fs.appendFileSync(f.files[0], JSON.stringify(user('next', { uuid: 'next', parentUuid: 'a' })) + '\n');
  assert.equal(run(f, input).ok, true);
  assert.equal(run(f, { ...input, evidence_ids: ['next'] }).ok, false);
  fs.appendFileSync(f.files[0], JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'branch', parentUuid: 'u', timestamp: TS,
    message: { stop_reason: 'tool_use' } }) + '\n');
  assert.equal(run(f, input).ok, false);
});
test('next execution competing at the same parent is a branch conflict', t => {
  const f = setup(t); const stats = fs.statSync(f.files[0], { bigint: true });
  const input = { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'a' } };
  fs.appendFileSync(f.files[0], JSON.stringify(user('Next competing start', { uuid: 'next', parentUuid: 'u' })) + '\n');
  assert.equal(run(f, input).ok, false);
});
for (const provider of ['claude', 'codex']) test(`actual ${provider} answer-reader diag passes standalone audit`, t => {
  const f = setup(t, cases[provider]);
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
  const target = { instrId: snapshot.instructions[0].id, ref: snapshot.instructions[0].ref, file_fp: snapshot.sessions[0].file_fp };
  const result = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options, ...target, diag: true });
  assert.equal(result.status, 'final');
  assert.equal(run(f, { provider, instrId: target.instrId, file_fp: target.file_fp, ...result.diag }).ok, true);
});
for (const c of require('./fixtures/session-snapshot/answer-chain.cjs').cases) test(`corrected independent audit ${c.name}`, t => {
  const f = setup(t, [['claude', 's', c.records]]); const stats = fs.statSync(f.files[0], { bigint: true });
  const input = { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: c.evidence_ids, segment: { start_id: 'u', end_id: c.end_id } };
  const a = run(f, input); assert.equal(a.ok, c.audit, JSON.stringify(a.checks));
});
test('C queued and resumed pending diagnostics have no terminal claim; forged final still fails', t => {
  const f = setup(t, cases.queued_resume);
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
  const reader = require('../../scripts/lib/sessionAnswerReader.cjs');
  const fp = snapshot.sessions[0].file_fp;
  for (const id of ['claude:s:uu', 'claude:s:uq']) {
    const instruction = snapshot.instructions.find(i => i.id === id);
    const answer = reader.readAnswer({ ...f.options, instrId: id, ref: instruction.ref, file_fp: fp, diag: true });
    assert.equal(answer.status, id.endsWith('uq') ? 'queued_joined' : 'pending');
    const input = { provider: 'claude', instrId: id, file_fp: fp, ...answer.diag };
    const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
    assert.equal(run(f, input, true).ok, true);
  }
  const forged = run(f, { provider: 'claude', instrId: 'claude:s:uu', file_fp: fp,
    evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'b' } });
  assert.equal(forged.ok, false); assert.equal(forged.checks.find(c => c.name === 'no_resume').ok, false);
});
for (const c of require('./fixtures/session-snapshot/answer-parallel-tools.cjs').cases) test(`parallel tools audit ${c.name}`, t => {
  const f = setup(t, [['claude', 's', c.records]]); const stats = fs.statSync(f.files[0], { bigint: true });
  const input = { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: c.evidence_ids, segment: { start_id: 'u', end_id: c.end_id } };
  const a = run(f, input); assert.equal(a.ok, c.audit, JSON.stringify(a.checks));
  assert.equal(a.checks.find(check => check.name === 'chain_and_branches').ok, c.audit);
});
test('audit bounds parallel tool identifier metadata without retaining bodies', t => {
  const f = setup(t); const stats = fs.statSync(f.files[0], { bigint: true });
  fs.appendFileSync(f.files[0], JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'tool', parentUuid: 'a', timestamp: TS,
    message: { id: 'parallel-message', stop_reason: 'tool_use', content: Array.from({ length: 100000 }, () => ({ type: 'tool_use', id: 'call' })) } }) + '\n');
  const a = run(f, { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: ['a'], segment: { start_id: 'u', end_id: 'tool' } });
  assert.equal(a.ok, false); assert.equal(a.checks.find(c => c.name === 'audit_complete').ok, false);
});
test('v6 R1 B2 audit accepts new interval after abandoned first interval', t => {
  const { meta, message } = require('./fixtures/session-snapshot/a1a.cjs');
  const event = (type, turn_id) => ({ type: 'event_msg', timestamp: TS, payload: { type, turn_id } });
  const f = setup(t, [['codex', 's', [meta(), event('task_started', 'T1'), message(), event('task_started', 'T2'), message(), event('task_complete', 'T2')]]]);
  const stats = fs.statSync(f.files[0], { bigint: true });
  assert.equal(run(f, { provider: 'codex', instrId: 'codex:s:n2', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: ['T2'], segment: { start_id: 'T2', end_id: 'T2' } }).ok, true);
});
for (const c of require('./fixtures/session-snapshot/answer-codex-v6.cjs').cases) test(`R2 Codex v6 audit ${c.name}`, t => {
  const f = setup(t, [['codex', 's', c.records]]); const stats = fs.statSync(f.files[0], { bigint: true });
  const a = run(f, { provider: 'codex', instrId: c.id, file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    expected_status: c.status, expected_reason: c.status === 'unbound' ? 'segment_conflict' : null,
    evidence_ids: c.status === 'unbound' ? [] : [c.turn], segment: { start_id: c.turn, end_id: c.status === 'unbound' ? null : c.turn } });
  assert.equal(a.ok, true, JSON.stringify(a.checks));
});
for (const valid of [true, false]) test(`R2 unbound Claude audit verifies reason valid=${valid}`, t => {
  const c = require('./fixtures/session-snapshot/answer-parallel-tools.cjs').cases.find(c => c.name.includes('R1 B1'));
  const f = setup(t, valid ? [['claude', 's', c.records]] : cases.claude); const stats = fs.statSync(f.files[0], { bigint: true });
  const a = run(f, { provider: 'claude', instrId: 'claude:s:uu', file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    expected_status: 'unbound', expected_reason: 'branch_conflict', evidence_ids: [], segment: { start_id: 'u', end_id: null } });
  assert.equal(a.ok, valid, JSON.stringify(a.checks));
});
const inspectCases = [
  { name: 'ordinary Claude instruction', provider: 'claude', transcripts: cases.claude, suffix: 'uu', flags: [false, false, false] },
  { name: 'ordinary Codex instruction', provider: 'codex', transcripts: cases.codex, suffix: 'n1', flags: [false, false, false] },
  { name: 'queued instruction', provider: 'claude', transcripts: cases.queued_resume, suffix: 'uq', flags: [true, false, false] },
  { name: 'end_turn resumes', provider: 'claude', transcripts: cases.queued_resume, suffix: 'uu', flags: [false, true, false] },
  { name: 'interrupted Claude instruction', provider: 'claude', suffix: 'uu', flags: [false, false, true], transcripts: [['claude', 's',
    [user('Synthetic instruction A'), user('[Request interrupted by user]', { uuid: 'interrupted', parentUuid: 'u' })]]] },
  { name: 'interrupted Codex instruction', provider: 'codex', suffix: 'n1', flags: [false, false, true], transcripts: [['codex', 's',
    [...cases.codex[0][2].slice(0, -1), { type: 'event_msg', timestamp: TS, payload: { type: 'turn_aborted', turn_id: 't' } }]]] },
  { name: 'fork is classifiable without claiming resume across siblings', provider: 'claude', suffix: 'uu', flags: [false, false, false],
    transcripts: [['claude', 's', [...cases.claude[0][2], { type: 'assistant', sessionId: 's', uuid: 'fork', parentUuid: 'u', timestamp: TS,
      message: { stop_reason: 'tool_use' } }]]] },
  { name: 'missing ancestry is classifiable without finality proof', provider: 'claude', suffix: 'uu', flags: [false, false, false],
    transcripts: [['claude', 's', [user('Synthetic instruction A'), { type: 'assistant', sessionId: 's', uuid: 'lost', parentUuid: 'missing', timestamp: TS,
      message: { stop_reason: 'tool_use' } }]]] }
];
for (const c of inspectCases) test(`inspect classification ${c.name}`, t => {
  const f = setup(t, c.transcripts); const stats = fs.statSync(f.files[0], { bigint: true });
  const result = run(f, { provider: c.provider, instrId: `${c.provider}:s:${c.suffix}`, inspect: true,
    file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: [], segment: { start_id: null, end_id: null } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'features', 'ok']);
  assert.deepEqual(result.features, Object.fromEntries(['queued', 'end_turn_resumed', 'interrupted'].map((name, i) => [name, c.flags[i]])));
  assert.ok(result.checks.every(check => check.ok === true));
  assert.ok(result.checks.every(check => !['queued', 'end_turn_resumed', 'interrupted'].includes(check.name)));
});
for (const failure of ['missing-file', 'identity', 'parse']) test(`inspect classification rejects actual read failure ${failure}`, t => {
  const f = setup(t); const stats = fs.statSync(f.files[0], { bigint: true });
  if (failure === 'parse') fs.appendFileSync(f.files[0], '{bad json}\n');
  const result = run(f, { provider: 'claude', instrId: failure === 'identity' ? 'claude:other:uu' : 'claude:s:uu', inspect: true,
    file_fp: failure === 'missing-file' ? '0'.repeat(16) : crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: [], segment: { start_id: null, end_id: null } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.features, { queued: false, end_turn_resumed: false, interrupted: false });
});
test('inspect classification nonstarter snapshot record is classifiable with no own execution', t => {
  const c = inspectCases.find(c => c.name === 'interrupted Claude instruction');
  const f = setup(t, c.transcripts); const stats = fs.statSync(f.files[0], { bigint: true });
  const result = run(f, { provider: 'claude', instrId: 'claude:s:uinterrupted', inspect: true,
    file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
    evidence_ids: [], segment: { start_id: null, end_id: null } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.features, { queued: false, end_turn_resumed: false, interrupted: false });
});
const interruptionPhrases = ['[Request interrupted by user]', '[Request interrupted by user for tool use]'];
for (const phrase of interruptionPhrases) for (const shape of ['string', 'string-prefix', 'array', 'array-prefix', 'array-empty-tail', 'array-split']) {
  test(`interruption representation ${shape} ${phrase} preserves execution boundary`, t => {
    const content = shape === 'string' ? phrase : shape === 'string-prefix' ? phrase + '\nSTRUCTURAL_DETAIL'
      : shape === 'array' ? [{ type: 'text', text: phrase }]
        : shape === 'array-prefix' ? [{ type: 'text', text: phrase + '\nSTRUCTURAL_DETAIL' }]
          : shape === 'array-empty-tail' ? [{ type: 'text', text: phrase }, { type: 'text', text: '' }]
            : [{ type: 'text', text: phrase.slice(0, -1) }, { type: 'text', text: ']' }];
    const records = [user('Synthetic instruction A'),
      { type: 'assistant', sessionId: 's', uuid: 'working', parentUuid: 'u', timestamp: TS,
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call' }] } },
      user('', { uuid: 'interrupted', parentUuid: 'working', message: { content } }),
      user('Next human instruction', { uuid: 'next', parentUuid: 'interrupted' }),
      { type: 'assistant', sessionId: 's', uuid: 'next-answer', parentUuid: 'next', timestamp: TS,
        message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } }];
    const f = setup(t, [['claude', 's', records]]); const stats = fs.statSync(f.files[0], { bigint: true });
    const input = { provider: 'claude', instrId: 'claude:s:uu', expected_status: 'interrupted',
      file_fp: crypto.createHash('sha256').update(`palantir-file/1:${stats.dev}:${stats.ino}`).digest('hex').slice(0, 16),
      evidence_ids: ['interrupted'], segment: { start_id: 'u', end_id: 'interrupted' } };
    if (shape.endsWith('prefix')) {
      // R3: trailing text makes this a new instruction, not an interruption marker.
      assert.equal(run(f, input).ok, false);
      const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
      const instruction = snapshot.instructions.find(row => row.id === 'claude:s:uinterrupted');
      const answer = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
        instrId: instruction.id, ref: instruction.ref, file_fp: input.file_fp, diag: true });
      assert.equal(answer.status, 'pending');
      const correct = { provider: 'claude', instrId: instruction.id, file_fp: input.file_fp,
        expected_status: answer.status, ...answer.diag };
      assert.equal(run(f, correct).ok, true);
      for (const instrId of [input.instrId, instruction.id]) {
        const inspect = run(f, { ...input, instrId, inspect: true });
        assert.equal(inspect.ok, true); assert.equal(inspect.features.interrupted, false);
      }
      return;
    }
    {
      const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
      const instruction = snapshot.instructions.find(row => row.id === input.instrId);
      const answer = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
        instrId: instruction.id, ref: instruction.ref, file_fp: input.file_fp, diag: true });
      assert.equal(answer.status, 'interrupted');
      assert.deepEqual(answer.diag, { evidence_ids: input.evidence_ids, segment: input.segment });
    }
    const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
    assert.equal(audit.checks.find(check => check.name === 'segment_end').ok, true);
    assert.equal(audit.checks.find(check => check.name === 'no_resume').ok, true);
    assert.equal(run(f, input, true).ok, true);
    assert.equal(run(f, { ...input, evidence_ids: ['next-answer'], segment: { start_id: 'u', end_id: 'next-answer' } }).ok, false);
    const inspect = run(f, { ...input, inspect: true });
    assert.equal(inspect.ok, true); assert.equal(inspect.features.interrupted, true);
    const next = run(f, { ...input, instrId: 'claude:s:unext', inspect: true });
    assert.equal(next.ok, true); assert.equal(next.features.interrupted, false);
  });
}
test('interruption phrase set equals the core source constant without importing it', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/sessionTranscriptCore.cjs'), 'utf8');
  const body = /function claudeInterrupted\(record\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
  const corePattern = /return \/([^\n]+)\/\.test\(text\);/.exec(body)?.[1];
  const auditPattern = /const INTERRUPTION_MARKER = \/([^\n]+)\/;/.exec(fs.readFileSync(script, 'utf8'))?.[1];
  assert.ok(corePattern); assert.ok(auditPattern);
  // Compare only source strings; no core function is loaded or evaluated.
  assert.equal(auditPattern, corePattern);
});
function quotedInterruptionFixture(t) {
  const records = [user('Synthetic instruction A'),
    { type: 'assistant', sessionId: 's', uuid: 'working', parentUuid: 'u', timestamp: TS,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call' }] } },
    user('', { uuid: 'new-request', parentUuid: 'working', message: { content: [
      { type: 'text', text: '새 요청입니다. 이 표식을 설명하세요: ' },
      { type: 'text', text: '[Request interrupted by user]' }
    ] } }),
    { type: 'assistant', sessionId: 's', uuid: 'final', parentUuid: 'new-request', timestamp: TS,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } }];
  const f = setup(t, [['claude', 's', records]]);
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
  const file_fp = snapshot.sessions[0].file_fp;
  const query = id => {
    const instruction = snapshot.instructions.find(row => row.id === id);
    return require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
      instrId: id, ref: instruction.ref, file_fp, diag: true });
  };
  assert.equal(query('claude:s:uu').status, 'pending');
  const answer = query('claude:s:unew-request'); assert.equal(answer.status, 'final');
  assert.equal(answer.text, 'ANSWER_BODY_SENTINEL');
  return { f, file_fp, answer };
}
test('R3 quoted interruption rejects F as evidence for S', t => {
  const { f, file_fp } = quotedInterruptionFixture(t);
  const a = run(f, { provider: 'claude', instrId: 'claude:s:uu', file_fp, expected_status: 'final',
    evidence_ids: ['final'], segment: { start_id: 'u', end_id: 'final' } });
  assert.equal(a.ok, false, JSON.stringify(a.checks));
});
test('R3 quoted interruption accepts F as evidence for U', t => {
  const { f, file_fp, answer } = quotedInterruptionFixture(t);
  const input = { provider: 'claude', instrId: 'claude:s:unew-request', file_fp, expected_status: 'final', ...answer.diag };
  const a = run(f, input); assert.equal(a.ok, true, JSON.stringify(a.checks));
  assert.equal(run(f, input, true).ok, true);
});
test('R3 quoted interruption inspect does not mark S or U interrupted', t => {
  const { f, file_fp } = quotedInterruptionFixture(t);
  for (const instrId of ['claude:s:uu', 'claude:s:unew-request']) {
    const a = run(f, { provider: 'claude', instrId, file_fp, inspect: true, evidence_ids: [], segment: { start_id: null, end_id: null } });
    assert.equal(a.ok, true); assert.equal(a.features.interrupted, false);
  }
});
for (const c of require('./fixtures/session-snapshot/answer-send-now.cjs').cases) test(`send-now independent audit ${c.name}`, t => {
  const records = require('./fixtures/session-snapshot/answer-send-now.cjs').records(c.options);
  const f = setup(t, [['claude', 's', records]]);
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
  const file_fp = snapshot.sessions[0].file_fp;
  for (const instrId of ['claude:s:u234', 'claude:s:u242']) {
    const instruction = snapshot.instructions.find(row => row.id === instrId);
    const answer = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
      instrId, ref: instruction.ref, file_fp, diag: true });
    const input = { provider: 'claude', instrId, file_fp, expected_status: answer.status, ...answer.diag };
    const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
    assert.equal(audit.checks.find(check => check.name === 'segment_end').ok, true);
    assert.equal(audit.checks.find(check => check.name === 'no_resume').ok, true);
    assert.equal(run(f, input, true).ok, true);
    const inspected = run(f, { ...input, inspect: true });
    assert.equal(inspected.ok, true); assert.equal(inspected.features.queued, false);
    assert.equal(inspected.features.interrupted, instrId === 'claude:s:u234');
  }
  assert.equal(run(f, { provider: 'claude', instrId: 'claude:s:u242', file_fp, expected_status: 'interrupted',
    evidence_ids: ['241'], segment: { start_id: '242', end_id: '241' } }).ok, false);
  if (c.options.followingAnswer) assert.equal(run(f, { provider: 'claude', instrId: 'claude:s:u234', file_fp, expected_status: 'final',
    evidence_ids: ['243'], segment: { start_id: '234', end_id: '243' } }).ok, false);
});
for (const provider of ['claude', 'codex']) for (const c of require('./fixtures/session-snapshot/answer-instruction-kinds.cjs')[provider]) {
  test(`instruction decision table ${provider} ${c.name}`, t => {
    const table = require('./fixtures/session-snapshot/answer-instruction-kinds.cjs');
    const f = setup(t, [[provider, 's', table[provider + 'Records'](c)]]);
    const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
    const file_fp = snapshot.sessions[0].file_fp, instrId = provider === 'claude' ? 'claude:s:u242' : 'codex:s:n2';
    const instruction = snapshot.instructions.find(row => row.id === instrId);
    assert.equal(instruction?.kind ?? null, c.kind);
    const input = { provider, instrId, file_fp, expected_status: 'final',
      evidence_ids: [provider === 'claude' ? '243' : 'T1'],
      segment: provider === 'claude' ? { start_id: '242', end_id: '244' } : { start_id: 'T1', end_id: 'T1' } };
    assert.equal(run(f, input).ok, c.kind !== null);
    const previousId = provider === 'claude' ? 'claude:s:u234' : 'codex:s:n1';
    const previousInstruction = snapshot.instructions.find(row => row.id === previousId);
    const previous = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
      instrId: previousId, ref: previousInstruction.ref, file_fp, diag: true });
    assert.equal(previous.status, provider === 'codex' || c.kind !== null ? 'interrupted' : 'final');
    const audit = run(f, { provider, instrId: previousId, file_fp, expected_status: previous.status, ...previous.diag });
    assert.equal(audit.ok, true, JSON.stringify(audit.checks));
    if (instruction) {
      const answer = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
        instrId, ref: instruction.ref, file_fp, diag: true });
      assert.equal(answer.status, 'final'); assert.equal(answer.text, 'ANSWER_BODY_SENTINEL');
      assert.equal(run(f, { provider, instrId, file_fp, expected_status: answer.status, ...answer.diag }, true).ok, true);
    }
  });
}
test('instruction decision table source constants match core and i0a without importing either classifier', () => {
  const core = fs.readFileSync(path.resolve(__dirname, '../../scripts/lib/sessionTranscriptCore.cjs'), 'utf8');
  const audit = fs.readFileSync(script, 'utf8');
  const brief = fs.readFileSync(path.resolve(__dirname, '../../docs/specs/i0a-session-snapshot-board-brief.md'), 'utf8');
  const claudeSource = /function classifyClaudeRecord\(record\) \{([\s\S]*?)\n\}/.exec(core)?.[1];
  assert.ok(claudeSource);
  for (const name of ['CLAUDE_OUTPUT_PREFIX', 'SLASH_INPUT_PREFIX', 'CODEX_INJECTED_PREFIX', 'UNKNOWN_TAG_PREFIX']) {
    const pattern = new RegExp('const ' + name + ' = /([^\\n]+)/;').exec(audit)?.[1];
    assert.ok(pattern, name); assert.ok(core.includes('/' + pattern + '/'), name);
  }
  for (const name of ['SHELL_INPUT_PREFIX', 'REPLY_INPUT_PREFIX']) {
    const prefix = new RegExp("const " + name + " = '([^']+)';").exec(audit)?.[1];
    assert.ok(prefix, name); assert.ok(core.includes("text.startsWith('" + prefix + "')"), name); assert.ok(brief.includes(prefix), name);
  }
  const literals = source => [...source.matchAll(/'([^']+)'/g)].map(match => match[1]);
  for (const [name, field] of [['NON_USER_ORIGINS', 'turnOrigin'], ['HUMAN_PROMPT_SOURCES', 'promptSource']]) {
    const expected = new RegExp('\\[([^\\]]*)\\]\\.includes\\(record\\.' + field + '\\)').exec(claudeSource)?.[1];
    const actual = new RegExp('const ' + name + ' = \\[([^\\]]*)\\];').exec(audit)?.[1];
    assert.ok(expected); assert.ok(actual); assert.deepEqual(literals(actual), literals(expected));
    for (const value of literals(actual)) assert.ok(brief.includes(value), value);
  }
  for (const kind of ['human', 'slash', 'shell', 'reply']) assert.ok(audit.includes("'" + kind + "'") && brief.includes(kind));
  assert.doesNotMatch(audit, /sessionAnswerReader|sessionTranscriptCore/);
});
function localStdoutFixture(t, { format, finalBefore = false, command = true }) {
  const start = user(command ? '<command-name>/synthetic</command-name>' : 'Synthetic instruction A');
  const stdout = '<local-command-stdout>PRIVATE_LOCAL_OUTPUT</local-command-stdout>';
  const parentUuid = finalBefore ? 'a' : 'u';
  const output = format.startsWith('system-')
    ? { type: 'system', sessionId: 's', uuid: 'out', parentUuid, timestamp: TS,
      subtype: format === 'system-other-subtype' ? 'turn_duration' : 'local_command',
      content: format === 'system-array' ? [{ type: 'text', text: stdout }] : stdout }
    : user('', { uuid: 'out', parentUuid, message: { content: format === 'user-array' ? [{ type: 'text', text: stdout }] : stdout } });
  const records = [start, ...(finalBefore ? [{ type: 'assistant', sessionId: 's', uuid: 'a', parentUuid: 'u', timestamp: TS,
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ANSWER_BODY_SENTINEL' }] } }] : []), output];
  const f = setup(t, [['claude', 's', records]]);
  const snapshot = require('../../scripts/lib/sessionSnapshotReader.cjs').runSnapshot(f.options);
  const instruction = snapshot.instructions.find(row => row.id === 'claude:s:uu');
  const file_fp = snapshot.sessions[0].file_fp;
  const answer = require('../../scripts/lib/sessionAnswerReader.cjs').readAnswer({ ...f.options,
    instrId: instruction.id, ref: instruction.ref, file_fp, diag: true });
  return { f, answer, input: { provider: 'claude', instrId: instruction.id, file_fp, expected_status: answer.status, ...answer.diag } };
}
test('R4 system string local stdout accepts local_command and rejects pending', t => {
  const { f, answer, input } = localStdoutFixture(t, { format: 'system-string' });
  assert.equal(answer.status, 'local_command');
  assert.deepEqual(answer.diag, { evidence_ids: [], segment: { start_id: 'u', end_id: 'out' } });
  const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
  assert.equal(run(f, { ...input, expected_status: 'pending' }).ok, false);
  assert.equal(run(f, input, true).ok, true);
});
test('R4 user text array stdout shape remains pending and rejects local_command', t => {
  const { f, answer, input } = localStdoutFixture(t, { format: 'user-array' });
  assert.equal(answer.status, 'pending');
  const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
  assert.equal(run(f, { ...input, expected_status: 'local_command' }).ok, false);
});
test('R4 local stdout after end_turn rejects obsolete final evidence', t => {
  const { f, answer, input } = localStdoutFixture(t, { format: 'user-string', finalBefore: true });
  assert.equal(answer.status, 'local_command'); assert.equal(run(f, input).ok, true);
  const forged = run(f, { ...input, expected_status: 'final', evidence_ids: ['a'] });
  assert.equal(forged.ok, false, JSON.stringify(forged.checks));
  assert.equal(forged.checks.find(check => check.name === 'no_resume').ok, false);
});
for (const c of [
  { name: 'system string after end_turn changes termination', format: 'system-string', finalBefore: true, command: true, status: 'local_command' },
  { name: 'user array after end_turn leaves final intact', format: 'user-array', finalBefore: true, command: true, status: 'final' },
  { name: 'stdout after ordinary human final is not a command transition', format: 'user-string', finalBefore: true, command: false, status: 'final' },
  { name: 'system array is not local stdout', format: 'system-array', status: 'pending' },
  { name: 'other system subtype is not local stdout', format: 'system-other-subtype', status: 'pending' },
  { name: 'user string is local stdout', format: 'user-string', status: 'local_command' }
]) test(`R4 local stdout format boundary ${c.name}`, t => {
  const { f, answer, input } = localStdoutFixture(t, c); assert.equal(answer.status, c.status);
  const audit = run(f, input); assert.equal(audit.ok, true, JSON.stringify(audit.checks));
  if (c.status === 'pending') assert.equal(run(f, { ...input, expected_status: 'local_command' }).ok, false);
  if (c.status === 'local_command' && c.finalBefore) {
    const forged = run(f, { ...input, expected_status: 'final', evidence_ids: ['a'] });
    assert.equal(forged.ok, false); assert.equal(forged.checks.find(check => check.name === 'no_resume').ok, false);
  }
});
