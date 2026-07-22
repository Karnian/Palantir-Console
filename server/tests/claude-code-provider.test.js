'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

function loadProviderWithExecFile(responder, authReaders = {}) {
  const modulePath = require.resolve('../services/providers/claude-code');
  const originalExecFile = childProcess.execFile;
  const authResolver = require('../services/authResolver');
  const originalAuthReaders = {
    readClaudeKeychainToken: authResolver.readClaudeKeychainToken,
    readClaudeLinuxCredentialsToken: authResolver.readClaudeLinuxCredentialsToken,
  };
  const calls = [];

  function fakeExecFile() {
    throw new Error('fake execFile should only be called through promisify');
  }
  fakeExecFile[promisify.custom] = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return responder(call);
  };

  delete require.cache[modulePath];
  childProcess.execFile = fakeExecFile;
  Object.assign(authResolver, authReaders);
  let provider;
  try {
    provider = require(modulePath);
  } finally {
    childProcess.execFile = originalExecFile;
    Object.assign(authResolver, originalAuthReaders);
  }

  return {
    ...provider,
    calls,
    restore() {
      delete require.cache[modulePath];
      childProcess.execFile = originalExecFile;
    },
  };
}

function withoutClaudeTokens(t) {
  const original = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function withClaudeToken(t, value = 'test-oauth-token') {
  const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = value;
  t.after(() => {
    if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
  });
}

test('fetchClaudeCodeUsage asynchronously reads account info and OAuth usage with execFile argv', async (t) => {
  withClaudeToken(t);
  const harness = loadProviderWithExecFile(({ command }) => {
    if (command === 'claude') {
      return {
        stdout: '  {"loggedIn":true,"email":"dev@example.com","authMethod":"oauth","subscriptionType":"pro","orgName":"Acme"}\n',
        stderr: '',
      };
    }
    return {
      stdout: JSON.stringify({ five_hour: { utilization: 25, resets_at: '2026-07-05T05:00:00Z' } }),
      stderr: '',
    };
  });
  t.after(harness.restore);

  const result = await harness.fetchClaudeCodeUsage();

  assert.deepEqual(result.account, {
    email: 'dev@example.com',
    type: 'oauth',
    planType: 'pro',
    orgName: 'Acme',
  });
  assert.equal(result.limits[0].label, '5h limit');
  assert.equal(result.limits[0].remainingPct, 75);
  assert.deepEqual(harness.calls, [
    {
      command: 'claude',
      args: ['auth', 'status'],
      options: { encoding: 'utf-8', timeout: 5000 },
    },
    {
      command: 'curl',
      args: [
        '-s',
        '-H',
        'Authorization: Bearer test-oauth-token',
        '-H',
        'anthropic-beta: oauth-2025-04-20',
        '-H',
        'Accept: application/json',
        'https://api.anthropic.com/api/oauth/usage',
      ],
      options: { encoding: 'utf-8', timeout: 10000 },
    },
  ]);
});

test('fetchClaudeCodeUsage silently ignores an account-info failure', async (t) => {
  withClaudeToken(t);
  const harness = loadProviderWithExecFile(({ command }) => {
    if (command === 'claude') throw new Error('claude unavailable');
    return { stdout: JSON.stringify({ seven_day: { utilization: 40 } }), stderr: '' };
  });
  t.after(harness.restore);

  const result = await harness.fetchClaudeCodeUsage();

  assert.equal(result.account, null);
  assert.equal(result.limits[0].label, 'weekly limit');
  assert.equal(result.limits[0].remainingPct, 60);
  assert.deepEqual(harness.calls.map(call => call.command), ['claude', 'curl']);
});

test('fetchClaudeCodeUsage awaits the async native credential fallback when env tokens are absent', async (t) => {
  withoutClaudeTokens(t);
  const authCalls = [];
  const harness = loadProviderWithExecFile(({ command }) => {
    if (command === 'claude') throw new Error('claude unavailable');
    return { stdout: JSON.stringify({ seven_day: { utilization: 10 } }), stderr: '' };
  }, {
    async readClaudeKeychainToken() {
      authCalls.push('keychain:start');
      await new Promise(resolve => setImmediate(resolve));
      authCalls.push('keychain:done');
      return 'async-keychain-token';
    },
    async readClaudeLinuxCredentialsToken() {
      authCalls.push('credentials-file');
      return 'unexpected-token';
    },
  });
  t.after(harness.restore);

  const result = await harness.fetchClaudeCodeUsage();

  assert.equal(result.limits[0].remainingPct, 90);
  assert.deepEqual(authCalls, ['keychain:start', 'keychain:done']);
  const curlCall = harness.calls.find(call => call.command === 'curl');
  assert.ok(curlCall.args.includes('Authorization: Bearer async-keychain-token'));
});

test('fetchClaudeCodeUsage returns the existing fallback envelope when curl fails', async (t) => {
  withClaudeToken(t);
  const harness = loadProviderWithExecFile(({ command }) => {
    if (command === 'claude') return { stdout: 'not json', stderr: '' };
    throw new Error('curl failed');
  });
  t.after(harness.restore);

  const result = await harness.fetchClaudeCodeUsage();

  assert.equal(result.account, null);
  assert.deepEqual(result.limits, [{
    label: 'usage',
    remainingPct: null,
    resetAt: null,
    errorMessage: 'curl failed',
  }]);
  assert.deepEqual(harness.calls.map(call => call.command), ['claude', 'curl']);
});
