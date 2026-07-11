'use strict';

// G1 — goal prompt compiler (spec §5b).
//
// When a goal-enabled task is dispatched, spawnQueuedRun replaces the worker's
// run.prompt with a DETERMINISTIC template so the worker knows (a) the goal,
// (b) the acceptance criteria it must satisfy, and (c) to end with a machine-
// readable completion report the goalReport parser (§5c) can read.
//
// The compiler is a pure function — same input → same output, no I/O. The
// verify-check clause and the per-attempt feedback block are forward-compat
// hooks: their backing data (verify_checks table, retry loop) arrives in
// G2/G3, so in G1 the caller passes null and those blocks are simply omitted.
//
// The template is APPEND-safe for the caller's own prompt: the /execute body
// prompt is preserved verbatim under [ADDITIONAL INSTRUCTIONS] so goal mode
// never drops a dispatcher's extra guidance.

const MAX_FEEDBACK_LEN = 4000;
const MAX_CRITERIA_LEN = 8000;

function clampText(value, cap) {
  if (typeof value !== 'string') return '';
  const t = value.trim();
  return t.length > cap ? `${t.slice(0, cap)}\n…(truncated)` : t;
}

const REPORT_INSTRUCTION = [
  '[COMPLETION REPORT — required]',
  'End your FINAL message with a fenced block reporting your outcome:',
  '```palantir-goal-report',
  '{ "goal_status": "done" | "blocked" | "partial", "summary": "<what you did>", "blockers": ["<unresolved issue>", "..."] }',
  '```',
  'Use "done" only if you believe every acceptance criterion is satisfied. If you were blocked, use "blocked"/"partial" and list the blockers.',
].join('\n');

/**
 * Compile the deterministic goal prompt.
 *
 * @param {object}   opts
 * @param {object}   opts.task            - task row (title, description, acceptance_criteria)
 * @param {number}   [opts.attemptNumber] - 1-based attempt index (G1 always 1)
 * @param {number}   [opts.maxAttempts]   - budget (task.goal_max_attempts)
 * @param {string}   [opts.callerPrompt]  - the /execute body prompt (preserved)
 * @param {string}   [opts.verifyCheckName] - G2+: named server-side check, else null
 * @param {string}   [opts.attemptFeedback] - G3+: prior-attempt feedback, else null
 * @returns {string}
 */
function compileGoalPrompt({
  task,
  attemptNumber = 1,
  maxAttempts,
  callerPrompt = '',
  verifyCheckName = null,
  attemptFeedback = null,
} = {}) {
  const t = task || {};
  const title = typeof t.title === 'string' ? t.title.trim() : '';
  const description = typeof t.description === 'string' ? t.description.trim() : '';
  const criteria = clampText(t.acceptance_criteria, MAX_CRITERIA_LEN);
  const max = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : (Number(t.goal_max_attempts) || 3);
  const attempt = Number.isFinite(attemptNumber) && attemptNumber > 0 ? attemptNumber : 1;

  const blocks = [];

  const goalBody = [title, description].filter(Boolean).join('\n');
  blocks.push(`[GOAL]\n${goalBody || '(no title)'}`);

  blocks.push(
    criteria
      ? `[ACCEPTANCE CRITERIA — 전부 충족해야 완료]\n${criteria}`
      : '[ACCEPTANCE CRITERIA — 전부 충족해야 완료]\n(명시된 수락 기준 없음 — 목표를 합리적으로 완수하라)'
  );

  // Forward-compat (G2): server-side verify check announcement.
  const checkName = typeof verifyCheckName === 'string' ? verifyCheckName.trim() : '';
  if (checkName) {
    blocks.push(`[VERIFY]\n서버가 종료 후 검증 '${checkName}' 을 실행한다. 통과해야 완료로 인정된다.`);
  }

  // Forward-compat (G3): per-attempt feedback from prior attempts.
  const feedback = clampText(attemptFeedback, MAX_FEEDBACK_LEN);
  let attemptLine = `[ATTEMPT ${attempt}/${max}]`;
  if (attempt > 1 && feedback) attemptLine += `\n이전 시도 피드백:\n${feedback}`;
  blocks.push(attemptLine);

  // Preserve the caller's /execute prompt VERBATIM (append channel, §5b) —
  // presence is tested with a trim, but the original string is appended unchanged.
  const hasCaller = typeof callerPrompt === 'string' && callerPrompt.trim().length > 0;
  if (hasCaller) blocks.push(`[ADDITIONAL INSTRUCTIONS]\n${callerPrompt}`);

  blocks.push(REPORT_INSTRUCTION);

  return blocks.join('\n\n');
}

module.exports = { compileGoalPrompt };
