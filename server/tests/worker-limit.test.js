'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyClaudeRateLimitEvent,
  classifyCodexWorkerOutput,
} = require('../services/workerLimit');

test('worker limit: Claude only classifies a structured rejected status', () => {
  assert.equal(classifyClaudeRateLimitEvent({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning' },
  }), null);
  assert.deepEqual(classifyClaudeRateLimitEvent({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt: 1785312000000,
    },
  }), {
    provider: 'claude',
    kind: 'rate_limit',
    rate_limit_type: 'seven_day',
    resets_at: 1785312000000,
  });
});

test('worker limit: Codex reuses the existing rate-limit classifier', () => {
  assert.deepEqual(classifyCodexWorkerOutput([
    'Rate limit exceeded',
    '___EXIT_CODE_1___',
    'runner@host project %',
  ].join('\n')), {
    provider: 'codex',
    kind: 'rate_limit',
    rate_limit_type: null,
    resets_at: null,
  });
  assert.equal(classifyCodexWorkerOutput('Connection timeout'), null);
});

test('worker limit: Codex classifies the subscription usage-limit message', () => {
  assert.deepEqual(classifyCodexWorkerOutput([
    "You've hit your usage limit. Upgrade to Pro or try again in 2 hours.",
    '___EXIT_CODE_1___',
  ].join('\n')), {
    provider: 'codex',
    kind: 'rate_limit',
    rate_limit_type: null,
    resets_at: null,
  });
});

test('worker limit: Codex does not classify task prose in a failed output tail', () => {
  assert.equal(classifyCodexWorkerOutput([
    'Implemented the API rate limit middleware.',
    'AssertionError: expected 200, got 500',
    '___EXIT_CODE_1___',
  ].join('\n')), null);
});

test('worker limit: Codex does not classify an assertion about a usage-limit feature', () => {
  assert.equal(classifyCodexWorkerOutput([
    'AssertionError: expected usage limit reached banner, got success',
    '___EXIT_CODE_1___',
  ].join('\n')), null);
});
