// #416: PALANTIR_SKIP_HOST_CREDENTIALS makes AMBIENT host credential discovery
// inert, so a screenshot depends on the repo rather than on whether the person
// running it happens to be logged in.
//
// Overriding HOME is not enough on its own: `.claude-auth.json` sits at the
// REPO root, which HOME cannot move, and the macOS keychain is not path-scoped
// at all. Clearing the env vars does not close it either — an empty value is
// falsy, which is exactly the condition that makes the resolver fall back to
// the file.
//
// The switch must NOT become a general "no auth" mode: credentials passed
// explicitly through the environment still have to work, or this would be a
// way to silently disable auth in a real deployment.
//
// Two testing constraints shape this file:
//
//   * It never touches the real `.claude-auth.json`. `node --test` runs files
//     concurrently and manager.test.js stashes/restores that same path, so a
//     fixture planted there can have its teardown interleave with that restore
//     and delete a developer's real credentials. PALANTIR_CLAUDE_AUTH_FILE
//     points this file at its own temp path instead.
//   * The native-store cases assert the probe DID NOT RUN, not merely that the
//     result was null. On a machine with no keychain entry the guarded and
//     unguarded code both return null, so a result-only assertion passes even
//     if the guard is deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AUTH_RESOLVER = require.resolve('../services/authResolver');
const SILENT = { logger: { log() {}, warn() {} } };
const ENV_KEYS = [
  'PALANTIR_SKIP_HOST_CREDENTIALS',
  'PALANTIR_CLAUDE_AUTH_FILE',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
];

// CLAUDE_AUTH_FILE is resolved at module load, so the override has to be in
// place before the require — hence the cache bust on every load.
function loadResolver() {
  delete require.cache[AUTH_RESOLVER];
  return require(AUTH_RESOLVER);
}

// Redirect the auth file at a per-test temp path and clear the credential env.
function sandbox(t) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-authiso-'));
  const authFile = path.join(dir, '.claude-auth.json');
  process.env.PALANTIR_CLAUDE_AUTH_FILE = authFile;

  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[AUTH_RESOLVER];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    authFile,
    plant(contents) { fs.writeFileSync(authFile, JSON.stringify(contents), { mode: 0o600 }); },
  };
}

// Record the underlying syscalls the native readers make. promisify() captures
// execFile at module load, so the spy has to be installed before the require.
function spyOnNativeProbes(t) {
  const childProcess = require('node:child_process');
  const fsPromises = require('node:fs/promises');
  const originalExecFile = childProcess.execFile;
  const originalReadFile = fsPromises.readFile;
  const calls = { execFile: [], readFile: [] };

  childProcess.execFile = function spy(file, args, ...rest) {
    calls.execFile.push([file, ...(Array.isArray(args) ? args : [])].join(' '));
    return originalExecFile.call(this, file, args, ...rest);
  };
  fsPromises.readFile = function spy(target, ...rest) {
    calls.readFile.push(String(target));
    return originalReadFile.call(this, target, ...rest);
  };
  t.after(() => {
    childProcess.execFile = originalExecFile;
    fsPromises.readFile = originalReadFile;
  });

  return calls;
}

test('isolation stops .claude-auth.json from hydrating process.env', (t) => {
  const box = sandbox(t);
  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';

  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), false);
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
});

test('without the switch the same file still hydrates process.env (no behaviour change)', (t) => {
  const box = sandbox(t);
  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });

  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), true);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture');
});

test('isolation never writes the auth file back out', (t) => {
  const box = sandbox(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';

  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), false);
  assert.equal(fs.existsSync(box.authFile), false);
});

test('isolation reports no ambient credentials to the resolver', (t) => {
  const box = sandbox(t);
  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const resolver = loadResolver();

  // Both native stores are platform-gated; under isolation each must be false
  // on EVERY platform, so one committed baseline serves macOS and Linux alike.
  assert.equal(resolver.hasClaudeKeychainCredentials(), false);
  assert.equal(resolver.hasClaudeLinuxCredentials(), false);

  const auth = resolver.resolveClaudeAuth();
  assert.equal(auth.canAuth, false, 'a planted file must not make the manager look authenticated');
  assert.ok(
    !JSON.stringify(auth).includes('sk-ant-fixture'),
    'no fixture credential may leak into the resolver result',
  );
});

test('isolation suppresses the native probes themselves, not just their results', async (t) => {
  const box = sandbox(t);
  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const calls = spyOnNativeProbes(t);
  const resolver = loadResolver();

  assert.equal(await resolver.readClaudeKeychainToken(), null);
  assert.equal(await resolver.readClaudeLinuxCredentialsToken(), null);
  resolver.hasClaudeKeychainCredentials();

  // The point of the switch: no `security` invocation and no read of the CLI
  // credential store. Asserting only on the null return would still pass with
  // the guards removed on a machine that has no credentials.
  assert.deepEqual(calls.execFile.filter((c) => c.startsWith('security ')), []);
  assert.deepEqual(calls.readFile.filter((p) => p.includes('.credentials.json')), []);
});

test('without the switch the keychain probe does run (the spy can observe it)', async (t) => {
  // Guards the assertion above from silently becoming vacuous: if the spy could
  // never see a probe, the isolated case would prove nothing. macOS only —
  // elsewhere readClaudeKeychainToken is platform-gated before any syscall.
  if (process.platform !== 'darwin') {
    t.skip('keychain probe is macOS-only');
    return;
  }
  sandbox(t);
  const calls = spyOnNativeProbes(t);
  const resolver = loadResolver();

  await resolver.readClaudeKeychainToken();
  assert.ok(
    calls.execFile.some((c) => c.startsWith('security find-generic-password')),
    'unisolated path must still probe the keychain',
  );
});

test('explicit env credentials still authenticate under isolation (not a kill switch)', (t) => {
  sandbox(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-explicit';

  const auth = loadResolver().resolveClaudeAuth();
  assert.equal(
    auth.canAuth,
    true,
    'isolation suppresses AMBIENT discovery only — an explicit env credential must still work',
  );
});

test('the usage provider skips `claude auth status` under isolation', async (t) => {
  // The CLI does its own credential discovery, so it reports the host account
  // even with every credential env var cleared.
  sandbox(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const calls = spyOnNativeProbes(t);
  delete require.cache[require.resolve('../services/providers/claude-code.js')];
  loadResolver();
  const provider = require('../services/providers/claude-code.js');
  t.after(() => { delete require.cache[require.resolve('../services/providers/claude-code.js')]; });

  await provider.fetchClaudeCodeUsage().catch(() => {});
  assert.deepEqual(
    calls.execFile.filter((c) => c.startsWith('claude auth status')),
    [],
    'the account probe must not run under isolation',
  );
});
