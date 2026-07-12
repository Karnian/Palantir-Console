// G4c §5h — GET /api/tasks/:id/goal aggregate: attempts/verdict/acceptance/
// delivery, allowlist projection + capping/redaction, non-goal light form, auth.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGoalDetail } = require('../routes/tasks');

function goalRun(over = {}) {
  return {
    id: 'run_1', goal_active: 1, is_manager: 0, _seq: 1, status: 'completed',
    retry_count: 0, goal_verdict: 'gate2', goal_verdict_reason: null,
    acceptance_json: null, goal_report: null, created_at: '2026-07-12T00:00:00Z', ...over,
  };
}

test('buildGoalDetail: non-goal task → light { goal_enabled:false }', () => {
  assert.deepEqual(buildGoalDetail({ goal_enabled: 0 }, [], null), { goal_enabled: false });
});

test('buildGoalDetail: attempts ordered by _seq, verdict/acceptance/report projected', () => {
  const task = { goal_enabled: 1, goal_max_attempts: 3, acceptance_criteria: '- ok', goal_delivery_json: null };
  const runs = [
    goalRun({ id: 'r2', _seq: 2, retry_count: 1, goal_verdict: 'gate2',
      acceptance_json: JSON.stringify({ status: 'ran', passed: true, kind: 'command', gate: true, name: 'unit' }),
      goal_report: JSON.stringify({ goal_status: 'done', summary: 'built', blockers: [] }) }),
    goalRun({ id: 'r1', _seq: 1, retry_count: 0, goal_verdict: 'retry' }),
    { id: 'mgr', goal_active: 1, is_manager: 1, _seq: 3 }, // manager excluded
    { id: 'ng', goal_active: 0, is_manager: 0, _seq: 4 },  // non-goal excluded
  ];
  const g = buildGoalDetail(task, runs, { id: 'vc', name: 'unit', kind: 'command', created_by: 'human' });
  assert.equal(g.goal_enabled, true);
  assert.equal(g.attempts.length, 2, 'manager + non-goal runs excluded');
  assert.deepEqual(g.attempts.map((a) => a.run_id), ['r1', 'r2'], '_seq ASC = attempt order');
  assert.equal(g.attempts[0].verdict, 'retry');
  assert.equal(g.attempts[1].verdict, 'gate2');
  assert.equal(g.attempts[1].acceptance.passed, true);
  assert.equal(g.attempts[1].goal_report.summary, 'built');
  assert.equal(g.verify_check.created_by, 'human');
  assert.equal(g.tip_run_id, 'r2', 'tip = last attempt');
});

test('buildGoalDetail: delivery is allowlist-projected (no absolute paths / output_tail), bundle→count', () => {
  const task = {
    goal_enabled: 1, goal_max_attempts: 3,
    goal_delivery_json: JSON.stringify({
      mode: 'branch', state: 'delivered', run_id: 'r2', branch: 'palantir/goal/t1',
      base: 'abc123', stat: '1 file changed', delivered_at: 'x',
      secret_internal: '/abs/workspace/path', // must NOT be surfaced
    }),
  };
  const g = buildGoalDetail(task, [goalRun({ id: 'r2', _seq: 2 })], null);
  assert.equal(g.delivery.state, 'delivered');
  assert.equal(g.delivery.branch, 'palantir/goal/t1');
  assert.equal(g.delivery.stat, '1 file changed');
  assert.ok(!('secret_internal' in g.delivery), 'raw internal field stripped');

  const del = buildGoalDetail({ goal_enabled: 1, goal_delivery_json: JSON.stringify({ mode: 'deliverable', state: 'delivered', run_id: 'r', bundle: { files: [{ path: 'a' }, { path: 'b' }], truncated: true } }) }, [], null);
  assert.deepEqual(del.delivery.bundle, { files: 2, truncated: true }, 'bundle → count + truncated only');
});

test('buildGoalDetail: worker report summary is secret-redacted + capped', () => {
  const long = 'x'.repeat(5000);
  const task = { goal_enabled: 1 };
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'; // matches OpenAI sk- {20,}
  const runs = [goalRun({ goal_report: JSON.stringify({ summary: `key ${secret} ${long}`, blockers: ['b'] }) })];
  const g = buildGoalDetail(task, runs, null);
  const sum = g.attempts[0].goal_report.summary;
  assert.ok(sum.length <= 2000, 'summary capped');
  assert.ok(!sum.includes(secret), 'secret redacted');
});
