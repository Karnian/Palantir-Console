// G2 §5h — Gate 1 acceptance surfaces in the Operator (PM) review text.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatHarvestSummary } = require('../app');

test('formatHarvestSummary: renders Gate 1 acceptance (gate) + the not-yet-enforcing caveat', () => {
  const lines = formatHarvestSummary({ harvested: true, files: 0, commits: 0, acceptance: { passed: true, gate: true, kind: 'artifact', status: 'ran' } }).join('\n');
  assert.match(lines, /\[gate1\] acceptance: PASS — artifact check \(gate\)/);
  assert.match(lines, /Gate 1 은 아직 task 전이를 강제하지 않습니다/);
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
