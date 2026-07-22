'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { promisify } = require('node:util');

function loadAuthResolverWithExecFile(responder) {
  const modulePath = require.resolve('../services/authResolver');
  const cachedModule = require.cache[modulePath];
  const originalExecFile = childProcess.execFile;
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
  let authResolver;
  try {
    authResolver = require(modulePath);
  } finally {
    childProcess.execFile = originalExecFile;
  }

  return {
    authResolver,
    calls,
    restore() {
      delete require.cache[modulePath];
      if (cachedModule) require.cache[modulePath] = cachedModule;
      childProcess.execFile = originalExecFile;
    },
  };
}

async function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

test('readClaudeKeychainToken uses async execFile without blocking the event loop', async (t) => {
  let finishExec;
  const harness = loadAuthResolverWithExecFile(() => new Promise((resolve) => {
    finishExec = () => resolve({
      stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-token' } }),
      stderr: '',
    });
  }));
  t.after(harness.restore);

  await withPlatform('darwin', async () => {
    const tokenPromise = harness.authResolver.readClaudeKeychainToken();
    let settled = false;
    tokenPromise.finally(() => { settled = true; });

    assert.equal(harness.calls.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'event loop advanced while security remained pending');

    finishExec();
    assert.equal(await tokenPromise, 'keychain-token');
  });

  assert.deepEqual(harness.calls[0], {
    command: 'security',
    args: ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    options: { stdio: 'pipe', timeout: 3000, encoding: 'utf8' },
  });
});

test('readClaudeKeychainToken preserves expiry, legacy-string, and failure handling', async (t) => {
  const responses = [
    { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: Date.now() - 1000 } }), stderr: '' },
    { stdout: ' opaque+legacy/token= \n', stderr: '' },
    new Error('keychain denied'),
  ];
  const harness = loadAuthResolverWithExecFile(() => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  t.after(harness.restore);

  await withPlatform('darwin', async () => {
    assert.equal(await harness.authResolver.readClaudeKeychainToken(), null);
    assert.equal(await harness.authResolver.readClaudeKeychainToken(), 'opaque+legacy/token=');
    assert.equal(await harness.authResolver.readClaudeKeychainToken(), null);
  });
});
