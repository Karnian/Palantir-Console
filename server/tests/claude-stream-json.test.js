const test = require('node:test');
const assert = require('node:assert/strict');

const { parseClaudeStreamJsonOutput } = require('../services/claudeStreamJson');
const { parseGoalReport } = require('../services/goalReport');

test('detached Claude NDJSON restores text, usage, tools, and goal report content', () => {
  const goalReport = [
    'done',
    '```palantir-goal-report',
    '{"goal_status":"achieved","summary":"complete","blockers":[]}',
    '```',
  ].join('\n');
  const raw = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: goalReport },
          { type: 'tool_use', name: 'Bash', id: 'tool-1' },
        ],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }),
    JSON.stringify({
      type: 'result',
      is_error: false,
      stop_reason: 'end_turn',
      result: goalReport,
      usage: { input_tokens: 5, output_tokens: 6 },
      total_cost_usd: 0.25,
    }),
  ].join('\n');

  const parsed = parseClaudeStreamJsonOutput(raw);

  assert.equal(parsed.recognized, true);
  assert.equal(parsed.result.stop_reason, 'end_turn');
  assert.deepEqual(parsed.usage, { inputTokens: 5, outputTokens: 6, costUsd: 0.25 });
  assert.deepEqual(parseGoalReport(parsed.text), {
    goal_status: 'achieved',
    summary: 'complete',
    blockers: [],
  });
  assert.equal(parsed.events[0].message.content[1].name, 'Bash');
});

test('non-NDJSON worker output remains unrecognized for normal CLI fallback', () => {
  const parsed = parseClaudeStreamJsonOutput('ordinary command output\n');
  assert.equal(parsed.recognized, false);
  assert.equal(parsed.result, null);
  assert.equal(parsed.text, '');
});
