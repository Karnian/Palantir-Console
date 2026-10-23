require('./helpers/host-credential-discovery').enableLegacyClaudeCredentialAccessForFile();
'use strict';

// #423: this file exists to verify that host credential discovery HAPPENS —
// that the keychain is probed and the provider shells out. `npm test` pins the
// skip flag on by default, which would turn these into assertions that nothing
// occurs, so this file opts back in for its own scope.
require('./helpers/host-credential-discovery').enableHostCredentialDiscoveryForFile();

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

function loadProviderWithExecFile(responder, authReaders = {}) {
  const modulePath = require.resolve('../services/providers/claude-code');
  const originalExecFile = childProcess.execFile;
  const originalSpawn = childProcess.spawn;
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
  childProcess.spawn = (command, args, options) => {
    const { EventEmitter } = require('node:events');
    const { PassThrough, Writable } = require('node:stream');
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, encoding, cb) {
      const call = { command, args, options, header: chunk.toString() };
      calls.push(call);
      Promise.resolve().then(() => responder(call)).then(result => {
        child.stdout.end(result.stdout); child.emit('close', 0);
      }, error => child.emit('error', error));
      cb();
    } });
    return child;
  };
  Object.assign(authResolver, authReaders);
  let provider;
  try {
    provider = require(modulePath);
  } finally {
    childProcess.execFile = originalExecFile;
    childProcess.spawn = originalSpawn;
    Object.assign(authResolver, originalAuthReaders);
  }

  return {
    ...provider,
    calls,
    restore() {
      delete require.cache[modulePath];
      childProcess.execFile = originalExecFile;
    childProcess.spawn = originalSpawn;
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
  assert.deepEqual(harness.calls.map(call => call.command), ['claude', 'curl']);
  const curl = harness.calls[1];
  assert.equal(curl.args[0], '-q');
  assert.ok(curl.args.includes('@-'));
  assert.ok(!curl.args.join(' ').includes('test-oauth-token'));
  assert.equal(curl.header, 'Authorization: Bearer test-oauth-token\n');
  assert.equal(curl.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
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
  assert.equal(curlCall.header, 'Authorization: Bearer async-keychain-token\n');
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

test('fetchClaudeCodeUsage redacts the OAuth token from curl failure messages', async (t) => {
  const token = '+/=oauth.literal-secret$characters';
  withClaudeToken(t, token);
  const harness = loadProviderWithExecFile(({ command, args }) => {
    if (command === 'claude') return { stdout: 'not json', stderr: '' };
    throw new Error(`Command failed: ${command} ${args.join(' ')}\nTLS handshake failed`);
  });
  t.after(harness.restore);

  const result = await harness.fetchClaudeCodeUsage();
  const { errorMessage } = result.limits[0];

  assert.equal(errorMessage.includes(token), false);
  assert.equal(errorMessage.includes('literal-secret$characters'), false);
  assert.match(errorMessage, /TLS handshake failed/);
});
