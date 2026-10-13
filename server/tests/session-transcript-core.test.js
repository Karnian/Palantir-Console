'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('../../scripts/lib/sessionSnapshotReader.cjs');
const core = require('../../scripts/lib/sessionTranscriptCore.cjs');
const { setup, cases, user, meta } = require('./fixtures/session-snapshot/a1a.cjs');
test('shared transcript core exports identity, parsing, instruction, withholding and transition rules', () => {
  for (const name of ['selectFirstTranscriptIdentity', 'transcriptSessionId', 'representativeTranscriptCwd',
    'parseTranscriptRecord', 'transcriptSource', 'statusRecord', 'classifyClaudeRecord', 'isQueuedInstruction',
    'claudeInterrupted', 'claudeLocalCommandStdout', 'classifyCodexMessage', 'codexIdentitySuffix',
    'computeInstructionFingerprint', 'computeInstructionRef', 'parseIndependentTranscript',
    'snapshotSessionExclusion', 'isInstructionExcluded', 'hasSessionInstructionDeletionRule',
    'claudeStatus', 'codexStatus', 'transcriptStatus', 'statusAt', 'orderedStatusRecords']) assert.equal(typeof core[name], 'function', name);
  assert.equal(core.transcriptSessionId('claude', [{ sessionId: 'invalid/' }, user('first'), user('later', { sessionId: 'later' })]), 's');
  assert.equal(core.transcriptSessionId('codex', [meta({ id: 'invalid/' }), meta({ id: 'later' })]), 'invalid/');
  const config = { exclude: { instructions: [{ id: 'codex:s:n1' }] } };
  assert.equal(core.hasSessionInstructionDeletionRule(config, { provider: 'codex', sid: 's' }), true);
  assert.equal(core.hasSessionInstructionDeletionRule(config, { provider: 'claude', sid: 's' }), false);
  assert.equal(core.hasSessionInstructionDeletionRule(config, { provider: 'codex', sid: 's1' }), false);
});
for (const [name, rows] of Object.entries(cases)) {
  test(`runSnapshot bytes match saved pre-extraction ${name} fixture`, t => {
    const f = setup(t, rows);
    const snapshot = reader.runSnapshot(f.options);
    // file_fp is the deliberate schema addition. All pre-existing bytes, including key order, stay fixed.
    for (const session of snapshot.sessions) delete session.file_fp;
    const expected = fs.readFileSync(path.join(__dirname, `fixtures/session-snapshot/a1a-${name}.json`), 'utf8').trimEnd();
    assert.equal(JSON.stringify(snapshot), expected);
    assert.equal(JSON.stringify(snapshot).includes('ANSWER_BODY_SENTINEL'), false);
  });
}
