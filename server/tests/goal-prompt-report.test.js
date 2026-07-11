// G1 — unit tests for the deterministic goal prompt compiler (§5b) and the
// goalReport fenced-block parser (§5c). Both are pure modules with no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileGoalPrompt } = require('../services/goalPrompt');
const { parseGoalReport } = require('../services/goalReport');

// --------------------------------------------------------------------------
// compileGoalPrompt
// --------------------------------------------------------------------------

const TASK = {
  title: 'Ship the widget',
  description: 'Build and wire the widget end to end.',
  acceptance_criteria: '- renders\n- tests pass',
  goal_max_attempts: 3,
};

test('compileGoalPrompt: deterministic — same input → identical output', () => {
  const a = compileGoalPrompt({ task: TASK, maxAttempts: 3, callerPrompt: 'go' });
  const b = compileGoalPrompt({ task: TASK, maxAttempts: 3, callerPrompt: 'go' });
  assert.equal(a, b);
});

test('compileGoalPrompt: contains goal, criteria, attempt, report blocks in order', () => {
  const out = compileGoalPrompt({ task: TASK, maxAttempts: 3, callerPrompt: 'extra guidance' });
  const iGoal = out.indexOf('[GOAL]');
  const iCriteria = out.indexOf('[ACCEPTANCE CRITERIA');
  const iAttempt = out.indexOf('[ATTEMPT 1/3]');
  const iCaller = out.indexOf('[ADDITIONAL INSTRUCTIONS]');
  const iReport = out.indexOf('[COMPLETION REPORT');
  assert.ok(iGoal >= 0 && iCriteria > iGoal && iAttempt > iCriteria && iCaller > iAttempt && iReport > iCaller,
    'blocks appear in the documented order');
  assert.match(out, /Ship the widget/);
  assert.match(out, /renders/);
  assert.match(out, /extra guidance/, 'caller prompt preserved (append channel)');
  assert.match(out, /```palantir-goal-report/, 'requests the completion report fence');
});

test('compileGoalPrompt: attempt feedback only shown when attempt > 1', () => {
  const first = compileGoalPrompt({ task: TASK, attemptNumber: 1, maxAttempts: 3, attemptFeedback: 'prior failure X' });
  assert.ok(!first.includes('prior failure X'), 'no feedback on attempt 1');
  const retry = compileGoalPrompt({ task: TASK, attemptNumber: 2, maxAttempts: 3, attemptFeedback: 'prior failure X' });
  assert.match(retry, /\[ATTEMPT 2\/3\]/);
  assert.match(retry, /prior failure X/, 'feedback surfaced on retry');
});

test('compileGoalPrompt: preserves the caller prompt VERBATIM (no trim of content)', () => {
  const caller = '  keep\tmy   spacing\n  and lines  ';
  const out = compileGoalPrompt({ task: TASK, maxAttempts: 3, callerPrompt: caller });
  assert.ok(out.includes(`[ADDITIONAL INSTRUCTIONS]\n${caller}`), 'caller prompt appended byte-for-byte');
  // whitespace-only caller prompt is treated as absent (no empty block)
  const blank = compileGoalPrompt({ task: TASK, maxAttempts: 3, callerPrompt: '   \n  ' });
  assert.ok(!blank.includes('[ADDITIONAL INSTRUCTIONS]'), 'blank caller prompt omitted');
});

test('compileGoalPrompt: verify check clause is forward-compat (omitted when null)', () => {
  const without = compileGoalPrompt({ task: TASK, maxAttempts: 3 });
  assert.ok(!without.includes('[VERIFY]'));
  const withCheck = compileGoalPrompt({ task: TASK, maxAttempts: 3, verifyCheckName: 'npm-test' });
  assert.match(withCheck, /\[VERIFY\][\s\S]*npm-test/);
});

test('compileGoalPrompt: tolerates missing fields without throwing', () => {
  const out = compileGoalPrompt({ task: { title: '' }, maxAttempts: undefined });
  assert.equal(typeof out, 'string');
  assert.match(out, /\[GOAL\]/);
  assert.match(out, /\[ATTEMPT 1\/3\]/, 'falls back to default max attempts');
});

// --------------------------------------------------------------------------
// parseGoalReport
// --------------------------------------------------------------------------

test('parseGoalReport: parses a well-formed fenced block', () => {
  const text = 'blah blah\n```palantir-goal-report\n{"goal_status":"done","summary":"did it","blockers":[]}\n```\ntrailing';
  const r = parseGoalReport(text);
  assert.deepEqual(r, { goal_status: 'done', summary: 'did it', blockers: [] });
});

test('parseGoalReport: last block wins on multiple', () => {
  const text = '```palantir-goal-report\n{"goal_status":"partial","summary":"first"}\n```\n'
    + '```palantir-goal-report\n{"goal_status":"done","summary":"final","blockers":["x"]}\n```';
  const r = parseGoalReport(text);
  assert.equal(r.goal_status, 'done');
  assert.equal(r.summary, 'final');
  assert.deepEqual(r.blockers, ['x']);
});

test('parseGoalReport: absence → null', () => {
  assert.equal(parseGoalReport('no report here at all'), null);
  assert.equal(parseGoalReport(''), null);
  assert.equal(parseGoalReport(null), null);
  assert.equal(parseGoalReport(undefined), null);
});

test('parseGoalReport: malformed JSON → null (never throws)', () => {
  const text = '```palantir-goal-report\n{not valid json,,,}\n```';
  assert.equal(parseGoalReport(text), null);
});

test('parseGoalReport: non-object payload → null; normalizes/caps fields', () => {
  assert.equal(parseGoalReport('```palantir-goal-report\n"just a string"\n```'), null);
  assert.equal(parseGoalReport('```palantir-goal-report\n[1,2,3]\n```'), null);
  const big = 'x'.repeat(9000);
  const r = parseGoalReport(`\`\`\`palantir-goal-report\n{"goal_status":"done","summary":"${big}","blockers":["a","","  ",42]}\n\`\`\``);
  assert.ok(r.summary.length <= 4000, 'summary capped');
  assert.deepEqual(r.blockers, ['a'], 'blank/non-string blockers dropped');
});
