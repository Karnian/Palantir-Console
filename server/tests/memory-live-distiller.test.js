// ML PR3b — live batch-LLM distiller (unit). The model call is injected so
// these run with zero network/LLM. All safety lives in the writer
// (promoteCandidatesBatchTx); the distiller only generates content and the
// parser only filters obviously-bad items.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLiveDistiller, parseProposals, buildUserMessage } = require('../services/distillers/liveDistiller');

test('createLiveDistiller: requires apiKey or callModel', () => {
  assert.throws(() => createLiveDistiller({}), /apiKey or an injected callModel/);
  assert.doesNotThrow(() => createLiveDistiller({ apiKey: 'sk-test-xxxxxxxxxxxxxxxxxxxx' }));
  assert.doesNotThrow(() => createLiveDistiller({ callModel: async () => '[]' }));
});

test('liveDistiller: injected callModel -> parses proposals for known candidates', async () => {
  const candidates = [
    { id: 'c1', rule: 'R1b', raw_json: JSON.stringify({ rule: 'R1b', task_id: 't1', fix_run: { diff_stat: '1 file changed' } }) },
    { id: 'c2', rule: 'R3', raw_json: JSON.stringify({ rule: 'R3', task_id: 't2', rationale: 'the tests pass and feature verified' }) },
  ];
  let capturedUser = '';
  let capturedSystem = '';
  const callModel = async ({ system, user }) => {
    capturedSystem = system;
    capturedUser = user;
    return JSON.stringify([
      { candidateId: 'c1', kind: 'pitfall', content: 'Rebuild the native module after a node switch.', confidence: 0.6, importance: 6 },
      { candidateId: 'c2', kind: 'heuristic', content: 'This kind of task is done when tests pass.', confidence: 0.5, importance: 5 },
    ]);
  };
  const d = createLiveDistiller({ callModel });
  const props = await d.distill({ projectId: 'p1', candidates });
  assert.equal(props.length, 2);
  assert.equal(props[0].candidateId, 'c1');
  assert.equal(props[0].kind, 'pitfall');
  // prompt carries the structured summary, not raw dumps
  assert.match(capturedUser, /candidateId=c1/);
  assert.match(capturedUser, /1 file changed/);   // R1b diff_stat summarized
  assert.match(capturedUser, /the tests pass/);    // R3 rationale summarized
  assert.match(capturedSystem, /Never include secrets/);
});

test('liveDistiller: empty candidates -> [] without calling the model', async () => {
  let called = false;
  const d = createLiveDistiller({ callModel: async () => { called = true; return '[]'; } });
  assert.deepEqual(await d.distill({ candidates: [] }), []);
  assert.deepEqual(await d.distill({}), []);
  assert.equal(called, false);
});

test('liveDistiller: callModel throw propagates (runOnce treats as transient retry)', async () => {
  const d = createLiveDistiller({ callModel: async () => { throw new Error('LLM 503'); } });
  await assert.rejects(
    () => d.distill({ candidates: [{ id: 'c1', rule: 'R1b', raw_json: '{}' }] }),
    /LLM 503/,
  );
});

test('parseProposals: extracts array from fenced/prose output, filters unknown id / bad kind / empty content', () => {
  const text = [
    'Sure, here are the lessons:',
    '```json',
    '[',
    '  {"candidateId":"c1","kind":"pitfall","content":"a real lesson","confidence":0.5,"importance":5},',
    '  {"candidateId":"ghost","kind":"pitfall","content":"references a candidate not in the batch"},',
    '  {"candidateId":"c1","kind":"not-a-kind","content":"bad kind"},',
    '  {"candidateId":"c1","kind":"heuristic","content":"   "}',
    ']',
    '```',
  ].join('\n');
  const out = parseProposals(text, ['c1']);
  assert.equal(out.length, 1);
  assert.equal(out[0].candidateId, 'c1');
  assert.equal(out[0].kind, 'pitfall');
});

test('parseProposals: missing numeric fields default sensibly', () => {
  const out = parseProposals('[{"candidateId":"c1","kind":"convention","content":"x lesson"}]', ['c1']);
  assert.equal(out[0].confidence, 0.5);
  assert.equal(out[0].importance, 5);
});

test('parseProposals: no JSON array -> throws (transient; runOnce will retry)', () => {
  assert.throws(() => parseProposals('sorry, I cannot help with that', ['c1']), /no JSON array/);
});

test('parseProposals: extracts FIRST balanced array, ignores trailing junk (Codex follow-up NIT 1)', () => {
  const valid = '[{"candidateId":"c1","kind":"pitfall","content":"a real lesson here"}]';
  const out = parseProposals(valid + 'x'.repeat(500000), ['c1']);
  assert.equal(out.length, 1, 'first balanced array parsed, megabytes of trailing junk ignored');
  assert.equal(out[0].candidateId, 'c1');
});

test('parseProposals: a "]" inside a string value does not truncate the array', () => {
  const text = '[{"candidateId":"c1","kind":"pitfall","content":"watch the array[0] index"}]';
  const out = parseProposals(text, ['c1']);
  assert.equal(out.length, 1);
  assert.match(out[0].content, /array\[0\] index/);
});

test('createLiveDistiller: non-array data.content does not crash — distill throws no-array (Codex follow-up NIT 2)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: 'oops, a string not an array' }) });
  const d = createLiveDistiller({ apiKey: 'sk-test-xxxxxxxxxxxxxxxxxxxx', fetchImpl });
  await assert.rejects(
    () => d.distill({ candidates: [{ id: 'c1', rule: 'R1b', raw_json: '{}' }] }),
    /no JSON array/, // NOT "map is not a function"
  );
});

test('parseProposals: non-array JSON -> throws', () => {
  assert.throws(() => parseProposals('{"candidateId":"c1"}', ['c1']), /not a JSON array|no JSON array/);
});

test('buildUserMessage: summarizes R1b/R3 structured fields only (no raw dump of huge text)', () => {
  const huge = 'x'.repeat(5000);
  const candidates = [
    { id: 'c1', rule: 'R1b', raw_json: JSON.stringify({ rule: 'R1b', fix_run: { diff_stat: huge } }) },
  ];
  const msg = buildUserMessage(candidates);
  assert.match(msg, /candidateId=c1/);
  // diff_stat is capped at 200 chars in the summary
  assert.ok(msg.length < huge.length, 'huge raw field must be truncated in the prompt');
});
