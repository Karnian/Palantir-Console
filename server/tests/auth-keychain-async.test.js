'use strict';

// #423: this file exists to verify that host credential discovery HAPPENS —
// that the keychain is probed and the provider shells out. `npm test` pins the
// skip flag on by default, which would turn these into assertions that nothing
// occurs, so this file opts back in for its own scope.
require('./helpers/host-credential-discovery').enableHostCredentialDiscoveryForFile();

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const os = require('node:os');
const { promisify } = require('node:util');

function loadAuthResolverWithExecFile(responder) {
  const modulePath = require.resolve('../services/authResolver');
  const cachedModule = require.cache[modulePath];
  const originalExecFile = childProcess.execFile;
  const originalExecFileSync = childProcess.execFileSync;
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
  childProcess.execFileSync = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return responder(call).stdout;
  };
  let authResolver;
  try {
    authResolver = require(modulePath);
  } finally {
    childProcess.execFile = originalExecFile;
    childProcess.execFileSync = originalExecFileSync;
  }

  return {
    authResolver,
    calls,
    restore() {
      delete require.cache[modulePath];
      if (cachedModule) require.cache[modulePath] = cachedModule;
      childProcess.execFile = originalExecFile;
      childProcess.execFileSync = originalExecFileSync;
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

const accountArgs = ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'fixture-account'];
const serviceArgs = ['find-generic-password', '-s', 'Claude Code-credentials'];
function oauthPayload(accessToken, expiresAt = Date.now() + 60000) {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
}

for (const reader of ['hasClaudeKeychainCredentials', 'readClaudeKeychainTokenSync', 'readClaudeKeychainToken']) {
  for (const [shape, properties] of [
    ['killed', { killed: true }],
    ['signal', { signal: 'SIGTERM' }],
    ['ETIMEDOUT', { code: 'ETIMEDOUT' }],
  ]) {
    test(`${reader}: timeout stops fallback (${shape})`, async t => {
      t.mock.method(os, 'userInfo', () => ({ username: 'fixture-account' }));
      const harness = loadAuthResolverWithExecFile(({ args }) => {
        if (args.includes('-a')) throw Object.assign(new Error('keychain timeout'), properties);
        return { stdout: oauthPayload('service-token'), stderr: '' };
      });
      t.after(harness.restore);
      let result;
      await withPlatform('darwin', async () => {
        result = await harness.authResolver[reader]();
      });
      assert.equal(harness.calls.length, 1, 'timeout must stop further keychain lookups');
      const existenceOnly = reader === 'hasClaudeKeychainCredentials';
      assert.equal(result, existenceOnly ? false : null);
      assert.deepEqual(harness.calls[0], {
        command: 'security',
        args: [...accountArgs, ...(existenceOnly ? [] : ['-w'])],
        options: { stdio: 'pipe', timeout: 3000, ...(existenceOnly ? {} : { encoding: 'utf8' }) },
      });
    });
  }
}

for (const reader of ['readClaudeKeychainTokenSync', 'readClaudeKeychainToken']) {
  for (const [scenario, accountResponse, serviceResponse, expected, lookups] of [
    ['valid account precedes stale service', () => oauthPayload('account-token'),
      () => oauthPayload('stale', 0), 'account-token', 1],
    ['missing account falls back', () => { throw new Error('item missing'); },
      () => oauthPayload('service-token'), 'service-token', 2],
    ['empty account falls back', () => oauthPayload(''),
      () => oauthPayload('service-token'), 'service-token', 2],
    ['expired account falls back', () => oauthPayload('expired', 0),
      () => oauthPayload('service-token'), 'service-token', 2],
    ['both items unusable', () => oauthPayload(''),
      () => oauthPayload('expired', 0), null, 2],
    ['legacy account string is preserved', () => ' opaque+legacy/token= \n',
      () => oauthPayload('service-token'), 'opaque+legacy/token=', 1],
    ['blank account payload falls back', () => ' \n',
      () => oauthPayload('service-token'), 'service-token', 2],
  ]) {
    test(`${reader}: account-scoped lookup ${scenario}`, async t => {
      t.mock.method(os, 'userInfo', () => ({ username: 'fixture-account' }));
      const harness = loadAuthResolverWithExecFile(({ args }) => ({
        stdout: (args.includes('-a') ? accountResponse : serviceResponse)(), stderr: '',
      }));
      t.after(harness.restore);
      await withPlatform('darwin', async () => {
        assert.equal(await harness.authResolver[reader](), expected);
      });
      assert.deepEqual(harness.calls, [accountArgs, ...(lookups === 2 ? [serviceArgs] : [])]
        .map(args => ({ command: 'security', args: [...args, '-w'],
          options: { stdio: 'pipe', timeout: 3000, encoding: 'utf8' } })));
    });
  }

  for (const scenario of ['empty username', 'unavailable user info']) {
    test(`${reader}: ${scenario} uses the service-only lookup`, async t => {
      t.mock.method(os, 'userInfo', () => {
        if (scenario === 'unavailable user info') throw new Error('unavailable');
        return { username: '' };
      });
      const harness = loadAuthResolverWithExecFile(() => ({ stdout: oauthPayload('service-token') }));
      t.after(harness.restore);
      await withPlatform('darwin', async () => {
        assert.equal(await harness.authResolver[reader](), 'service-token');
      });
      assert.equal(harness.calls.length, 1);
      assert.deepEqual(harness.calls[0].args, [...serviceArgs, '-w']);
    });
  }
}

for (const successes of [[true], [false, true], [false, false]]) {
  test(`hasClaudeKeychainCredentials tries account then service: ${successes}`, async t => {
    t.mock.method(os, 'userInfo', () => ({ username: 'fixture-account' }));
    let index = 0;
    const harness = loadAuthResolverWithExecFile(() => {
      if (!successes[index++]) throw new Error('item missing');
      return { stdout: '' };
    });
    t.after(harness.restore);
    await withPlatform('darwin', async () => {
      assert.equal(harness.authResolver.hasClaudeKeychainCredentials(), successes.includes(true));
    });
    assert.deepEqual(harness.calls, [accountArgs, serviceArgs].slice(0, successes.length)
      .map(args => ({ command: 'security', args, options: { stdio: 'pipe', timeout: 3000 } })));
  });
}

test('readClaudeKeychainToken uses async execFile without blocking the event loop', async (t) => {
  t.mock.method(os, 'userInfo', () => ({ username: 'fixture-account' }));
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
    args: ['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'fixture-account', '-w'],
    options: { stdio: 'pipe', timeout: 3000, encoding: 'utf8' },
  });
});

test('readClaudeKeychainToken preserves expiry, legacy-string, and failure handling', async (t) => {
  const responses = [
    { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: Date.now() - 1000 } }), stderr: '' },
    { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'expired', expiresAt: Date.now() - 1000 } }), stderr: '' },
    { stdout: ' opaque+legacy/token= \n', stderr: '' },
    new Error('keychain denied'),
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
