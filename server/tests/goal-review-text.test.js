// G2 §5h — Gate 1 acceptance surfaces in the Operator (PM) review text.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatHarvestSummary, buildGoalReviewText } = require('../app');

test('formatHarvestSummary: renders Gate 1 acceptance (gate); the pre-G3 not-yet-enforcing caveat is gone', () => {
  const lines = formatHarvestSummary({ harvested: true, files: 0, commits: 0, acceptance: { passed: true, gate: true, kind: 'artifact', status: 'ran' } }).join('\n');
  assert.match(lines, /\[gate1\] acceptance: PASS — artifact check \(gate\)/);
  // G4a: G3 landed — the verdict now drives the transition, so the "not yet
  // enforcing (G3 예정)" caveat is removed (the full Gate 2 block is buildGoalReviewText).
  assert.ok(!lines.includes('아직 task 전이를 강제하지 않습니다'), 'stale G3-pending caveat removed');
});

test('formatHarvestSummary: advisory + FAIL + SKIPPED render distinctly', () => {
  const fail = formatHarvestSummary({ harvested: true, acceptance: { passed: false, gate: false, kind: 'command', status: 'ran' } }).join('\n');
  assert.match(fail, /acceptance: FAIL — command check \(advisory\)/);
  const skip = formatHarvestSummary({ harvested: true, acceptance: { status: 'skipped', reason: 'runner_unavailable', kind: 'command', gate: true } }).join('\n');
  assert.match(skip, /acceptance: SKIPPED \(runner_unavailable\)/);
});

test('formatHarvestSummary: no acceptance block when absent (non-goal unchanged)', () => {
  const lines = formatHarvestSummary({ harvested: true, files: 1, commits: 0 }).join('\n');
  assert.ok(!lines.includes('[gate1]'), 'no Gate 1 line for a non-goal harvest');
});

// G4a §5h — buildGoalReviewText structured Gate 2 block.
const TASK = { id: 't1', goal_max_attempts: 3, acceptance_criteria: '- 빌드가 통과한다' };

test('buildGoalReviewText: gate2 verdict — verdict/attempt/acceptance/criteria/report + Gate 2 guidance', () => {
  const run = {
    id: 'r1', task_id: 't1', goal_verdict: 'gate2', goal_verdict_reason: null, retry_count: 0,
    acceptance_json: JSON.stringify({ name: 'unit', kind: 'command', gate: true, status: 'ran', passed: true }),
    goal_report: JSON.stringify({ goal_status: 'done', summary: '기능 구현 완료', blockers: [] }),
  };
  const text = buildGoalReviewText({ run, task: TASK });
  assert.match(text, /verdict: GATE2/);
  assert.match(text, /attempt: 1\/3/);
  assert.match(text, /gate1 acceptance: PASS — command check \[unit\] \(gate\)/);
  assert.match(text, /acceptance criteria:/);
  assert.match(text, /빌드가 통과한다/);
  assert.match(text, /worker report:/);
  assert.match(text, /기능 구현 완료/);
  assert.match(text, /의미 판단\(Gate 2\)/);
  assert.match(text, /"done"/);
});

test('buildGoalReviewText: exhausted verdict → budget line + escalation', () => {
  const run = { id: 'r2', task_id: 't1', goal_verdict: 'exhausted', goal_verdict_reason: 'exhausted', retry_count: 2, acceptance_json: null, goal_report: null };
  const text = buildGoalReviewText({ run, task: TASK });
  assert.match(text, /verdict: EXHAUSTED/);
  assert.match(text, /attempt: 3\/3/);
  assert.match(text, /예산 소진/);
  assert.match(text, /에스컬레이션/);
  assert.match(text, /NOT DEFINED/, 'no acceptance → NOT DEFINED');
});

test('buildGoalReviewText: error verdict → no-retry infra note; FAIL acceptance shows output tail', () => {
  const run = {
    id: 'r3', task_id: 't1', goal_verdict: 'error', goal_verdict_reason: 'source_changed', retry_count: 0,
    acceptance_json: JSON.stringify({ name: 'lint', kind: 'command', gate: true, status: 'ran', passed: false, output_tail: 'error TS2304: cannot find name' }),
    goal_report: null,
  };
  const text = buildGoalReviewText({ run, task: TASK });
  assert.match(text, /verdict: ERROR \(source_changed\)/);
  assert.match(text, /인프라\/소스 이상/);
  assert.match(text, /gate1 acceptance: FAIL/);
  assert.match(text, /gate1 output:/);
  assert.match(text, /TS2304/);
});

test('buildGoalReviewText: skipped acceptance surfaces the runner reason (fail-open, not silent pass)', () => {
  const run = {
    id: 'r4', task_id: 't1', goal_verdict: 'gate2', retry_count: 0,
    acceptance_json: JSON.stringify({ name: 'e2e', kind: 'command', gate: true, status: 'skipped', reason: 'runner_unavailable' }),
    goal_report: null,
  };
  const text = buildGoalReviewText({ run, task: TASK });
  assert.match(text, /gate1 acceptance: SKIPPED \(runner_unavailable\)/);
});
