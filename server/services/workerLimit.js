'use strict';

const { classifyCodexErrorKind } = require('./managerAdapters/codexAdapter');

function classifyClaudeRateLimitEvent(event) {
  if (
    !event
    || event.type !== 'rate_limit_event'
    || event.rate_limit_info?.status !== 'rejected'
  ) {
    return null;
  }

  const info = event.rate_limit_info;
  return {
    provider: 'claude',
    kind: 'rate_limit',
    rate_limit_type: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    resets_at: Number.isFinite(info.resetsAt) ? info.resetsAt : null,
  };
}

function classifyClaudeRateLimitEvents(events) {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const classification = classifyClaudeRateLimitEvent(events[index]);
    if (classification) return classification;
  }
  return null;
}

function classifyCodexWorkerOutput(output) {
  if (typeof output !== 'string' || !output.trim()) return null;
  // classifyCodexErrorKind expects one vendor error item. A worker capture is
  // the entire output tail and can contain successful task prose mentioning
  // "rate limit" before an unrelated terminal assertion. The tmux wrapper
  // appends an exit marker and then returns to an interactive shell, so use the
  // final worker line before that marker. Captures without a marker retain the
  // legacy final-non-empty-line behavior.
  const lines = output.trim().split(/\r?\n/);
  let workerEnd = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^___EXIT_CODE_\d+___$/.test(lines[index].trim())) {
      workerEnd = index;
      break;
    }
  }
  let terminalMessage = '';
  for (let index = workerEnd - 1; index >= 0; index -= 1) {
    terminalMessage = lines[index].trim();
    if (terminalMessage) break;
  }
  if (!terminalMessage) return null;
  if (classifyCodexErrorKind({ message: terminalMessage }) !== 'rate_limit') return null;
  return {
    provider: 'codex',
    kind: 'rate_limit',
    rate_limit_type: null,
    resets_at: null,
  };
}

function markWorkerLimitFailure(runService, runId, classification) {
  if (!classification || !runService || !runId) return false;
  runService.markRunNonRetryable(runId);
  runService.addRunEvent(
    runId,
    'worker:limit_rejected',
    JSON.stringify(classification),
  );
  return true;
}

module.exports = {
  classifyClaudeRateLimitEvent,
  classifyClaudeRateLimitEvents,
  classifyCodexWorkerOutput,
  markWorkerLimitFailure,
};
