// G3c §5k-4 — Gate 1.5 judge service: verdict mapping, hard-deadline timeout,
// schema-strict parse, injection-defended bounded/redacted inputs. Zero LLM
// calls (callModel injected). Plus decideGoalVerdict's judge branch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoalJudge, buildUserMessage, parseJudge, SYSTEM_PROMPT } = require('../services/goalJudgeService');
const { decideGoalVerdict } = require('../services/goalVerdict');

test('runJudge: pass verdict from a well-formed model reply', async () => {
  const judge = createGoalJudge({ callModel: async () => '{"pass": true, "reasons": ["meets rubric"]}' });
  const r = await judge.runJudge({ criteria: 'works', finalOutput: 'done' });
  assert.equal(r.status, 'pass');
  assert.ok(r.input_fp);
});

test('runJudge: fail verdict + reasons (clean JSON-only reply)', async () => {
  const judge = createGoalJudge({ callModel: async () => '{"pass": false, "reasons": ["missing X", "wrong Y"]}' });
  const r = await judge.runJudge({ criteria: 'works', finalOutput: 'half' });
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.reasons, ['missing X', 'wrong Y']);
});

test('runJudge: prose AROUND the JSON is rejected (strict) → error (fail-open)', async () => {
  const judge = createGoalJudge({ callModel: async () => 'thinking...\n{"pass": false, "reasons": ["x"]}\ntrailing' });
  assert.equal((await judge.runJudge({ criteria: 'w', finalOutput: 'h' })).status, 'error');
  // extra top-level key also rejected
  const j2 = createGoalJudge({ callModel: async () => '{"pass": true, "reasons": [], "confidence": 0.9}' });
  assert.equal((await j2.runJudge({ criteria: 'w', finalOutput: 'h' })).status, 'error');
});

test('runJudge: schema mismatch / non-JSON → error (fail-open)', async () => {
  const judge = createGoalJudge({ callModel: async () => 'I think it is fine, yes.' });
  assert.equal((await judge.runJudge({ criteria: 'x', finalOutput: 'y' })).status, 'error');
  const j2 = createGoalJudge({ callModel: async () => '{"verdict":"pass"}' }); // wrong shape
  assert.equal((await j2.runJudge({ criteria: 'x', finalOutput: 'y' })).status, 'error');
});

test('runJudge: a never-resolving model call hits the HARD DEADLINE → error (never blocks)', async () => {
  const judge = createGoalJudge({ callModel: () => new Promise(() => {}), deadlineMs: 40 });
  const started = Date.now();
  const r = await judge.runJudge({ criteria: 'x', finalOutput: 'y' });
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - started < 2000, 'returned promptly at the deadline');
});

test('runJudge: a synchronous throw in the model call normalizes to error', async () => {
  const judge = createGoalJudge({ callModel: () => { throw new Error('boom'); } });
  assert.equal((await judge.runJudge({ criteria: 'x', finalOutput: 'y' })).status, 'error');
});

test('runJudge: inputs are bounded + secret-redacted before the model sees them', async () => {
  let seenUser = '';
  const judge = createGoalJudge({ callModel: async ({ system, user }) => { seenUser = user; assert.equal(system, SYSTEM_PROMPT); return '{"pass":true,"reasons":[]}'; } });
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const huge = 'x'.repeat(500000);
  await judge.runJudge({ criteria: `crit ${secret} ${huge}`, finalOutput: `out ${secret} ${huge}` });
  assert.ok(seenUser.length < 60000, 'user message is bounded');
  assert.ok(!seenUser.includes(secret), 'secret redacted from the judge input');
});

test('runJudge: same input → same input_fp (deterministic, model-prose-independent)', async () => {
  const a = createGoalJudge({ callModel: async () => '{"pass":false,"reasons":["a"]}' });
  const b = createGoalJudge({ callModel: async () => '{"pass":false,"reasons":["totally different words"]}' });
  const r1 = await a.runJudge({ criteria: 'c', finalOutput: 'o' });
  const r2 = await b.runJudge({ criteria: 'c', finalOutput: 'o' });
  assert.equal(r1.input_fp, r2.input_fp, 'fingerprint is over the INPUT, not the reasons prose');
});

test('parseJudge: extracts first balanced JSON, rejects non-boolean pass', () => {
  assert.deepEqual(parseJudge('{"pass":true,"reasons":["ok"]}'), { pass: true, reasons: ['ok'] });
  assert.equal(parseJudge('{"pass":"yes"}'), null);
  assert.equal(parseJudge('no json here'), null);
});

// --- decideGoalVerdict judge branch (§5k-4) ---
const GATE_PASS = { gate: true, kind: 'command', status: 'ran', passed: true };

test('decideGoalVerdict: Gate 1 pass + judge FAIL + budget → retry(judge_fail)', () => {
  const v = decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: { status: 'fail' }, attemptsUsed: 1, budget: 3 });
  assert.deepEqual(v, { verdict: 'retry', reason: 'judge_fail' });
});

test('decideGoalVerdict: judge FAIL + fingerprint repeat → gate2(no_progress)', () => {
  const v = decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: { status: 'fail' }, fingerprintRepeat: true, attemptsUsed: 2, budget: 3 });
  assert.deepEqual(v, { verdict: 'gate2', reason: 'no_progress' });
});

test('decideGoalVerdict: judge FAIL at budget → exhausted', () => {
  const v = decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: { status: 'fail' }, attemptsUsed: 3, budget: 3 });
  assert.equal(v.verdict, 'exhausted');
});

test('decideGoalVerdict: judge error/pass/absent → gate2 (fail-open, judge never blocks/loops)', () => {
  assert.equal(decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: { status: 'error' } }).verdict, 'gate2');
  assert.equal(decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: { status: 'pass' } }).verdict, 'gate2');
  assert.equal(decideGoalVerdict({ status: 'completed', acceptance: GATE_PASS, judge: null }).verdict, 'gate2');
});

test('decideGoalVerdict: Gate 1 FAIL takes precedence — reason is not judge_fail', () => {
  const v = decideGoalVerdict({ status: 'completed', acceptance: { gate: true, status: 'ran', passed: false }, judge: { status: 'fail' }, attemptsUsed: 1, budget: 3 });
  assert.deepEqual(v, { verdict: 'retry', reason: null });
});
