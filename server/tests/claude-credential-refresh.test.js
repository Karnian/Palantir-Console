const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  CONFIG_ENV_KEY,
  resolveClaudeRefreshConfig,
  runClaudeCredentialRefreshProbe,
} = require('../services/claudeCredentialRefresh');
const {
  CLAUDE_OAUTH_USAGE_JS,
  createRemoteSshNodeExecutor,
} = require('../services/remoteSshExecutor');

const EXPECTED_DEFAULT_PROBE_SHA256 = '820308350719054371674a32b5223987fd021e98a0b643da447fad083479a88a';

function refreshConfig() {
  return {
    enabled: true,
    endpoint: 'https://documented-endpoint.invalid/token',
    timeoutMs: 2000,
    request: {
      method: 'POST',
      encoding: 'form',
      clientId: 'configured-client-id',
      clientIdParam: 'configured_client_parameter',
      refreshTokenParam: 'configured_refresh_parameter',
      grantParams: {
        configured_grant_parameter: 'configured-grant-value',
      },
      headers: {},
    },
    response: {
      accessTokenField: 'configured_access_field',
      refreshTokenField: 'configured_refresh_field',
      refreshTokenOmission: 'required',
      accessTokenExpiresInField: 'configured_access_ttl_field',
      accessTokenExpiresUnit: 'seconds',
      refreshTokenExpiresInField: 'configured_refresh_ttl_field',
      refreshTokenExpiresUnit: 'seconds',
    },
  };
}

function refreshResponse(overrides = {}) {
  return {
    configured_access_field: 'new-access-token',
    configured_refresh_field: 'new-refresh-token',
    configured_access_ttl_field: 3600,
    configured_refresh_ttl_field: 7200,
    ...overrides,
  };
}

async function createCredentialFixture(t, document, { mode = 0o600, directoryMode = 0o750 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-claude-refresh-'));
  await fs.chmod(directory, directoryMode);
  const credentialsPath = path.join(directory, '.credentials.json');
  await fs.writeFile(credentialsPath, JSON.stringify(document), { mode });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, credentialsPath };
}

function expiredDocument(overrides = {}) {
  return {
    rootUnknown: { preserve: true },
    claudeAiOauth: {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      expiresAt: 1,
      scopes: ['scope-from-cli'],
      oauthUnknown: { preserve: true },
      ...overrides,
    },
  };
}

function successfulProbeOptions(credentialsPath, overrides = {}) {
  return {
    config: refreshConfig(),
    credentialsPath,
    platform: 'linux',
    now: () => 10_000,
    requestRefresh: async () => refreshResponse(),
    requestUsage: async ({ accessToken }) => ({
      statusCode: 200,
      body: JSON.stringify({ tokenUsed: accessToken }),
    }),
    ...overrides,
  };
}

test('refresh stays disabled and the #437 probe stays byte-identical without complete config', async (t) => {
  assert.deepEqual(
    resolveClaudeRefreshConfig({}),
    { enabled: false, reason: 'unset', config: null },
  );
  assert.deepEqual(
    resolveClaudeRefreshConfig({ [CONFIG_ENV_KEY]: JSON.stringify({ enabled: true }) }),
    { enabled: false, reason: 'invalid', config: null },
  );

  const { credentialsPath } = await createCredentialFixture(t, expiredDocument());
  let refreshCalls = 0;
  const disabled = await runClaudeCredentialRefreshProbe({
    config: { enabled: true },
    credentialsPath,
    platform: 'linux',
    requestRefresh: async () => {
      refreshCalls += 1;
      return refreshResponse();
    },
  });
  assert.equal(disabled.code, 4);
  assert.equal(refreshCalls, 0, 'invalid config must fail before credentials or transport are touched');

  assert.equal(
    crypto.createHash('sha256').update(CLAUDE_OAUTH_USAGE_JS).digest('hex'),
    EXPECTED_DEFAULT_PROBE_SHA256,
  );
});

test('refresh writeback preserves unknown root and OAuth fields', async (t) => {
  const { credentialsPath } = await createCredentialFixture(t, expiredDocument({
    anotherUnknown: ['a', 'b'],
  }));

  const result = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath),
  );
  assert.equal(result.code, 0);

  const written = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
  assert.deepEqual(written.rootUnknown, { preserve: true });
  assert.deepEqual(written.claudeAiOauth.oauthUnknown, { preserve: true });
  assert.deepEqual(written.claudeAiOauth.anotherUnknown, ['a', 'b']);
  assert.deepEqual(written.claudeAiOauth.scopes, ['scope-from-cli']);
  assert.equal(written.claudeAiOauth.accessToken, 'new-access-token');
  assert.equal(written.claudeAiOauth.refreshToken, 'new-refresh-token');
  assert.equal(written.claudeAiOauth.expiresAt, 3_610_000);
  assert.equal(written.claudeAiOauth.refreshTokenExpiresAt, 7_210_000);
});

test('refresh writeback forces 0600 while preserving owner and the existing config directory', async (t) => {
  const { directory, credentialsPath } = await createCredentialFixture(
    t,
    expiredDocument(),
    { mode: 0o640, directoryMode: 0o751 },
  );
  const directoryBefore = await fs.stat(directory);
  const credentialBefore = await fs.stat(credentialsPath);

  const result = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath),
  );
  assert.equal(result.code, 0);

  const directoryAfter = await fs.stat(directory);
  const credentialAfter = await fs.stat(credentialsPath);
  assert.equal(credentialAfter.mode & 0o777, 0o600);
  assert.equal(credentialAfter.uid, credentialBefore.uid);
  assert.equal(credentialAfter.gid, credentialBefore.gid);
  assert.equal(directoryAfter.ino, directoryBefore.ino);
  assert.equal(directoryAfter.uid, directoryBefore.uid);
  assert.equal(directoryAfter.gid, directoryBefore.gid);
  assert.equal(directoryAfter.mode & 0o777, directoryBefore.mode & 0o777);
});

test('CAS loss after refresh never overwrites a concurrent credential writer', async (t) => {
  const { credentialsPath } = await createCredentialFixture(t, expiredDocument());
  const concurrent = expiredDocument({
    accessToken: 'concurrent-access-token',
    refreshToken: 'concurrent-refresh-token',
    expiresAt: 9_999_999,
    concurrentUnknown: 'keep-me',
  });

  const result = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => {
        // This writer deliberately ignores the shared lock to exercise the
        // final CAS. A compliant Claude process would wait for the lock.
        await fs.writeFile(credentialsPath, JSON.stringify(concurrent), { mode: 0o600 });
        return refreshResponse();
      },
    }),
  );

  assert.equal(result.code, 8);
  assert.equal(result.stdout, '__CLAUDE_REFRESH_AMBIGUOUS__');
  assert.deepEqual(JSON.parse(await fs.readFile(credentialsPath, 'utf8')), concurrent);
});

test('a staged response survives a crash and is committed without a second refresh', async (t) => {
  const { directory, credentialsPath } = await createCredentialFixture(t, expiredDocument());
  const crash = new Error('simulated process crash');
  crash.code = 'SIMULATED_CRASH';
  let refreshCalls = 0;

  await assert.rejects(
    runClaudeCredentialRefreshProbe(successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => {
        refreshCalls += 1;
        return refreshResponse();
      },
      hooks: {
        afterStage: async () => {
          throw crash;
        },
      },
    })),
    /simulated process crash/,
  );

  const journalPath = path.join(directory, '.palantir-claude-refresh-transaction.json');
  assert.equal(JSON.parse(await fs.readFile(journalPath, 'utf8')).state, 'staged');
  assert.equal((await fs.stat(journalPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'old-access-token');

  const recovered = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => {
        refreshCalls += 1;
        throw new Error('recovery must not spend the refresh token again');
      },
    }),
  );
  assert.equal(recovered.code, 0);
  assert.equal(refreshCalls, 1);
  assert.equal(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'new-access-token');
  await assert.rejects(fs.stat(journalPath), { code: 'ENOENT' });
});

test('connection loss before a response is quarantined and never retried automatically', async (t) => {
  const { credentialsPath } = await createCredentialFixture(t, expiredDocument());
  let refreshCalls = 0;

  const first = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => {
        refreshCalls += 1;
        const error = new Error('connection reset before response');
        error.code = 'ECONNRESET';
        throw error;
      },
    }),
  );
  assert.equal(first.code, 8);
  assert.equal(first.stdout, '__CLAUDE_REFRESH_AMBIGUOUS__');

  const second = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => {
        refreshCalls += 1;
        return refreshResponse();
      },
    }),
  );
  assert.equal(second.code, 8);
  assert.equal(refreshCalls, 1, 'an ambiguous rotation must not retry the old refresh token');
  assert.equal(JSON.parse(await fs.readFile(credentialsPath, 'utf8')).claudeAiOauth.accessToken, 'old-access-token');
});

test('the probe waits on Claude Code-compatible .storage-write.lock contention', async (t) => {
  const { directory, credentialsPath } = await createCredentialFixture(t, expiredDocument());
  const lockPath = path.join(directory, '.storage-write.lock');
  await fs.mkdir(lockPath);
  let releaseSleep;
  let announceSleep;
  const sleeping = new Promise((resolve) => { announceSleep = resolve; });
  const released = new Promise((resolve) => { releaseSleep = resolve; });
  let refreshCalls = 0;

  const pending = runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      lockRetries: 2,
      sleep: async () => {
        announceSleep();
        await released;
      },
      requestRefresh: async () => {
        refreshCalls += 1;
        return refreshResponse();
      },
    }),
  );

  await sleeping;
  assert.equal(refreshCalls, 0, 'refresh must not start while Claude owns the storage lock');
  await fs.rmdir(lockPath);
  releaseSleep();

  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(refreshCalls, 1);
});

test('configured concurrent usage probes serialize and keep config out of SSH argv', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const inputs = [];
  const executor = createRemoteSshNodeExecutor({
    id: 'pod',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    exposed_roots: ['/srv/root'],
  }, {
    claudeRefreshConfig: refreshConfig(),
    spawnFn(command, args) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.write = (chunk, callback) => {
        inputs.push(String(chunk));
        callback?.();
        return true;
      };
      child.stdin.end = () => {};
      child.kill = () => {};
      setTimeout(() => {
        child.stdout.emit('data', '{"five_hour":{"utilization":10}}');
        active -= 1;
        child.emit('close', 0, null);
      }, 20);
      return child;
    },
  });

  const [first, second] = await Promise.all([
    executor.readClaudeOAuthUsage({ timeoutMs: 1000 }),
    executor.readClaudeOAuthUsage({ timeoutMs: 1000 }),
  ]);
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.equal(maxActive, 1);
  assert.equal(calls.length, 2);
  assert.equal(inputs.length, 2);

  const sshArgv = calls.map((call) => call.args.join(' ')).join('\n');
  assert.ok(sshArgv.includes('.storage-write.lock'));
  assert.ok(!sshArgv.includes('configured-client-id'));
  assert.ok(inputs.every((input) => input.includes('configured-client-id')));
});

test('an unreadable refresh response is journaled, not thrown away', async (t) => {
  const { credentialsPath } = await createCredentialFixture(t, expiredDocument());
  // The server answered; only our reading of it failed — the expected shape of
  // a first activation, since the response schema is still unconfirmed. If the
  // grant rotates, the old refresh token is already spent and its replacement
  // is in this payload. Losing it would leave no way back to a working login.
  const rotated = { access_token: 'server-issued-access', refresh_token: 'server-issued-refresh' };

  const result = await runClaudeCredentialRefreshProbe(
    successfulProbeOptions(credentialsPath, {
      requestRefresh: async () => rotated,
    }),
  );
  assert.equal(result.code, 8);
  assert.equal(result.stdout, '__CLAUDE_REFRESH_AMBIGUOUS__');

  const journalPath = path.join(
    path.dirname(credentialsPath),
    '.palantir-claude-refresh-transaction.json',
  );
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journal.state, 'ambiguous');
  assert.deepEqual(
    journal.unreadableResponse,
    rotated,
    'the payload must survive for manual recovery',
  );

  // The credentials file itself is still untouched — recovery stays a human act.
  assert.equal(
    JSON.parse(await fs.readFile(credentialsPath, 'utf8')).claudeAiOauth.accessToken,
    'old-access-token',
  );
});
