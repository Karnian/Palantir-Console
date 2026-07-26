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

process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';

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
  // resolveCodexAuth reads these straight from the environment, so leaving
  // them set makes the Codex cases assert against the developer's own shell:
  // `CODEX_API_KEY=… node --test <this file>` fails without them here.
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
];

// os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so a fixture
// that sets only HOME leaves a Windows run resolving at the real profile —
// reading the developer's actual ~/.claude and ~/.codex stores.
function redirectHome(t, dir) {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// Separator-correct fragments — a hardcoded '/' misses Windows' '\'.
const CLAUDE_CLI_CREDENTIALS = path.join('.claude', '.credentials.json');
const CODEX_AUTH_RELPATH = path.join('.codex', 'auth.json');

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

// Record the underlying syscalls the native readers make.
//
// All FOUR channels matter, and an earlier version of this helper watched only
// the two async ones. That left the sync probes unobserved, so deleting
// hasClaudeLinuxCredentials()'s or hasClaudeKeychainCredentials()'s guard still
// passed here. authResolver destructures execFile/execFileSync at module load
// and promisify() captures execFile there too, so the spies must be installed
// BEFORE the require — every caller pairs this with loadResolver().
function spyOnNativeProbes(t) {
  const childProcess = require('node:child_process');
  const fsPromises = require('node:fs/promises');
  const fsSync = require('node:fs');
  const original = {
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    readFile: fsPromises.readFile,
    readFileSync: fsSync.readFileSync,
    existsSync: fsSync.existsSync,
  };
  const calls = { exec: [], read: [], exists: [] };
  const argvOf = (file, args) => [file, ...(Array.isArray(args) ? args : [])].join(' ');

  // Record and STUB the credential probes — never let them reach the host.
  // The positive controls deliberately run the unisolated path, and delegating
  // there would execute `security find-generic-password -w`, materializing the
  // developer's real Claude OAuth token (and risking a keychain ACL prompt).
  // Every assertion here counts calls rather than inspecting results, so a
  // stubbed failure preserves mutation detection exactly. Non-credential
  // commands still pass through so nothing else in the process is disturbed.
  const CREDENTIAL_COMMANDS = new Set(['security', 'claude']);
  const blocked = (file, args) => {
    const err = new Error(`[test] blocked host credential probe: ${argvOf(file, args)}`);
    err.code = 'ENOENT';
    return err;
  };

  childProcess.execFile = function spy(file, args, ...rest) {
    if (!CREDENTIAL_COMMANDS.has(file)) return original.execFile.call(this, file, args, ...rest);
    calls.exec.push(argvOf(file, args));
    const callback = rest[rest.length - 1];
    if (typeof callback === 'function') {
      process.nextTick(() => callback(blocked(file, args)));
      return undefined;
    }
    throw blocked(file, args);
  };
  childProcess.execFileSync = function spy(file, args, ...rest) {
    if (!CREDENTIAL_COMMANDS.has(file)) return original.execFileSync.call(this, file, args, ...rest);
    calls.exec.push(argvOf(file, args));
    throw blocked(file, args);
  };
  fsPromises.readFile = function spy(target, ...rest) {
    calls.read.push(String(target));
    return original.readFile.call(this, target, ...rest);
  };
  fsSync.readFileSync = function spy(target, ...rest) {
    calls.read.push(String(target));
    return original.readFileSync.call(this, target, ...rest);
  };
  // Several guards only prevent an existence PROBE, never a read, so watching
  // reads alone leaves them mutation-invisible.
  fsSync.existsSync = function spy(target, ...rest) {
    calls.exists.push(String(target));
    return original.existsSync.call(this, target, ...rest);
  };

  t.after(() => {
    childProcess.execFile = original.execFile;
    childProcess.execFileSync = original.execFileSync;
    fsPromises.readFile = original.readFile;
    fsSync.readFileSync = original.readFileSync;
    fsSync.existsSync = original.existsSync;
  });

  return {
    securityCalls: () => calls.exec.filter((c) => c.startsWith('security ')),
    claudeCliCalls: () => calls.exec.filter((c) => c.startsWith('claude auth status')),
    credentialFileReads: () => calls.read.filter((p) => p.includes(CLAUDE_CLI_CREDENTIALS)),
    // Any access at all — read or probe — of a path containing `needle`.
    touches: (needle) => [...calls.read, ...calls.exists].filter((p) => p.includes(needle)),
  };
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
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  // Every entry point, sync and async — the existence probes and the token
  // extractors are separate guards and each one has to hold.
  assert.equal(resolver.hasClaudeKeychainCredentials(), false);
  assert.equal(resolver.hasClaudeLinuxCredentials(), false);
  assert.equal(await resolver.readClaudeKeychainToken(), null);
  assert.equal(await resolver.readClaudeLinuxCredentialsToken(), null);
  resolver.resolveClaudeAuth();

  // The point of the switch: no `security` invocation and no read of the CLI
  // credential store. Asserting only on the null returns would still pass with
  // the guards removed on a machine that happens to have no credentials.
  assert.deepEqual(probes.securityCalls(), []);
  assert.deepEqual(probes.credentialFileReads(), []);
});

// The keychain entry points are the mirror image of the CLI-store ones: they
// return early unless process.platform is 'darwin', so on Linux their isolation
// guards are dead code and deleting one changes nothing observable. Testing
// them on the real platform therefore only verifies whichever half of the pair
// matches the host. Fake the platform for both directions instead, so the whole
// matrix holds wherever the suite runs.
function asDarwinHost(t) {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  t.after(() => { Object.defineProperty(process, 'platform', savedPlatform); });
}

test('isolation suppresses the keychain probes on a Darwin-shaped host', async (t) => {
  sandbox(t);
  asDarwinHost(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  assert.equal(resolver.hasClaudeKeychainCredentials(), false);
  assert.equal(await resolver.readClaudeKeychainToken(), null);
  assert.deepEqual(probes.securityCalls(), [], 'the keychain must not even be probed');
});

// Positive controls: without these the isolation assertions could pass simply
// because the spy is blind, and a deleted guard would go unnoticed.
test('positive control: unisolated keychain probes are observable', async (t) => {
  sandbox(t);
  asDarwinHost(t);
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  // The spy blocks these before they reach the keychain, so the return values
  // are meaningless here — reaching the probe at all is the whole assertion.
  resolver.hasClaudeKeychainCredentials();   // execFileSync
  await resolver.readClaudeKeychainToken();  // execFile (promisified)
  assert.equal(
    probes.securityCalls().length,
    2,
    'both the sync existence probe and the async token read must be observable',
  );
});

// The CLI-credential-file path is dead code on macOS: both entry points return
// early on `process.platform === 'darwin'`, so deleting their isolation guard
// changes nothing observable on a Mac and the mutation goes unnoticed. Fake the
// platform (and HOME, which is where the file path comes from) so both branches
// are exercised on whatever machine runs the suite.
function asLinuxHostWithCredentials(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-linuxcreds-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(
    path.join(dir, '.claude', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'oauth-fixture-token', expiresAt: Date.now() + 3600_000 },
    }),
  );

  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  redirectHome(t, dir);

  t.after(() => {
    Object.defineProperty(process, 'platform', savedPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// Plant a Codex credential under an isolated home and return to it.
function withCodexCredentialFixture(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), label));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(
    path.join(home, '.codex', 'auth.json'),
    JSON.stringify({ OPENAI_API_KEY: 'sk-fixture' }),
  );
  redirectHome(t, home);
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); });
}

test('isolation suppresses the CLI credential store on a Linux-shaped host', async (t) => {
  sandbox(t);
  asLinuxHostWithCredentials(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  assert.equal(resolver.hasClaudeLinuxCredentials(), false);
  assert.equal(await resolver.readClaudeLinuxCredentialsToken(), null);
  assert.deepEqual(probes.credentialFileReads(), [], 'the store must not even be read');
});

test('positive control: unisolated CLI credential reads are observable', async (t) => {
  sandbox(t);
  asLinuxHostWithCredentials(t);
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  assert.equal(resolver.hasClaudeLinuxCredentials(), true);          // readFileSync
  assert.equal(await resolver.readClaudeLinuxCredentialsToken(), 'oauth-fixture-token'); // readFile
  assert.equal(
    probes.credentialFileReads().length,
    2,
    'both the sync existence probe and the async token read must be observable',
  );
});

test('isolation stops resolveClaudeAuth probing the auth file at all', (t) => {
  // A separate guard from readClaudeAuthFile's: this one only suppresses the
  // existence probe, so a read-only spy could never see it disappear.
  const box = sandbox(t);
  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  const auth = resolver.resolveClaudeAuth();
  assert.deepEqual(probes.touches('.claude-auth.json'), []);
  assert.equal(auth.canAuth, false);
});

test('isolation stops resolveClaudeAuthForIsolated materializing a token', async (t) => {
  // The sharpest case: this entry point calls readClaudeAuthFile() directly,
  // with no outer guard to fall back on, and it MATERIALIZES a token rather
  // than just reporting availability. Losing that single guard hands a real
  // host credential to an isolated worker.
  const box = sandbox(t);
  box.plant({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-fixture-token', ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  const auth = await resolver.resolveClaudeAuthForIsolated({});
  assert.deepEqual(probes.touches('.claude-auth.json'), []);
  assert.equal(auth.canAuth, false);
  assert.ok(
    !JSON.stringify(auth).includes('fixture'),
    'no host credential may be materialized for an isolated worker',
  );
});

test('isolation stops resolveCodexAuth probing the codex auth file', (t) => {
  const box = sandbox(t);
  // CODEX_AUTH_FILE is homedir-derived and resolved at module load, so the home
  // redirect has to be in place before the require.
  withCodexCredentialFixture(t, 'palantir-codexauth-');

  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  const auth = resolver.resolveCodexAuth({});
  assert.deepEqual(probes.touches(CODEX_AUTH_RELPATH), []);
  assert.equal(auth.canAuth, false, 'a planted codex credential must not look usable');
});

test('positive control: unisolated resolvers do probe both auth files', (t) => {
  // Keeps the three assertions above honest — without this, they would also
  // pass if the resolvers simply never looked at these paths.
  const box = sandbox(t);
  withCodexCredentialFixture(t, 'palantir-codexauth-pc-');

  box.plant({ ANTHROPIC_API_KEY: 'sk-ant-fixture' });
  const probes = spyOnNativeProbes(t);
  const resolver = loadResolver();

  const claude = resolver.resolveClaudeAuth();
  const codex = resolver.resolveCodexAuth({});
  assert.ok(probes.touches('.claude-auth.json').length > 0, 'auth file is probed when not isolated');
  assert.ok(probes.touches(CODEX_AUTH_RELPATH).length > 0, 'codex auth file is probed when not isolated');
  assert.equal(claude.canAuth, true);
  assert.equal(codex.canAuth, true);
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
  const probes = spyOnNativeProbes(t);
  delete require.cache[require.resolve('../services/providers/claude-code.js')];
  loadResolver();
  const provider = require('../services/providers/claude-code.js');
  t.after(() => { delete require.cache[require.resolve('../services/providers/claude-code.js')]; });

  await provider.fetchClaudeCodeUsage().catch(() => {});
  assert.deepEqual(probes.claudeCliCalls(), [], 'the account probe must not run under isolation');
});
