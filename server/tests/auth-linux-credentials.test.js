// Follow-up to PR #374 (Linux Claude Code CLI credential file recognition).
// Codex adversarial re-review of the merged commit found the shipped tests
// only exercised the negative path (hasCredentialsFile: () => false) — there
// was no positive-path coverage for the new source at all. This file closes
// that gap:
//   - resolveClaudeAuth / resolveClaudeAuthForIsolated: Linux file alone
//     flips canAuth=true; existence-only for the normal path (no token
//     materialized into env), token-materializing for the isolated path.
//     Source priority is UNCHANGED from PR #374 / the normative order in
//     docs/specs/worker-preset-and-plugin-injection.md §6.9
//     (env → .claude-auth.json → keychain → Linux file for isolated;
//     env → .claude-auth.json → keychain/Linux-existence for normal) — an
//     earlier round of this same review tried reordering native stores
//     ahead of the cached file to fix a theoretical "stale cache shadows a
//     fresh login" edge case, but that reordering itself produced three
//     rounds of new regressions (breaking process.env.ANTHROPIC_API_KEY for
//     other app features that read it directly, trusting existence-only
//     probes as if they proved usability, and contradicting the documented
//     spec order) and was reverted. That edge case remains open as a
//     separate, not-yet-designed problem.
//   - hasClaudeLinuxCredentials / readClaudeLinuxCredentialsToken (the real
//     functions, not the DI stub): malformed JSON, missing/empty token,
//     expired accessToken, and the process.platform gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const authResolverModule = require('../services/authResolver');
const {
  resolveClaudeAuth,
  resolveClaudeAuthForIsolated,
  hasClaudeLinuxCredentials,
  readClaudeLinuxCredentialsToken,
  CLAUDE_AUTH_FILE,
  CLAUDE_LINUX_CREDENTIALS_FILE,
} = authResolverModule;

async function withNoClaudeEnv(fn) {
  const saved = {};
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] != null) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
}

// Monkeypatches fs.existsSync/fs.readFileSync so reads of CLAUDE_AUTH_FILE
// see `auth` (or "missing", if auth is null) without ever touching the real
// .claude-auth.json on disk. Deliberately NOT real file I/O: this path is
// also read/written by manager.test.js's ".claude-auth.json on demand"
// tests, and `npm test` runs files concurrently — real read/write/restore
// here could race with that file's own save/remove/restore and either
// leave a stray test token behind or clobber a developer's real cached
// credentials (Codex adversarial re-review of PR #374, P1).
async function withFakeClaudeAuthFile(auth, fn) {
  const origExists = fs.existsSync;
  const origRead = fs.readFileSync;
  fs.existsSync = function (p, ...rest) {
    if (p === CLAUDE_AUTH_FILE) return auth != null;
    return origExists.call(fs, p, ...rest);
  };
  fs.readFileSync = function (p, ...rest) {
    if (p === CLAUDE_AUTH_FILE) {
      if (auth == null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.stringify(auth);
    }
    return origRead.call(fs, p, ...rest);
  };
  try { return await fn(); } finally {
    fs.existsSync = origExists;
    fs.readFileSync = origRead;
  }
}

// Monkeypatches the sync/async fs reader used by each real credentials helper
// so tests never touch ~/.claude/.credentials.json on this dev box.
function withFakeLinuxCredsFile(content, fn) {
  const orig = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (p === CLAUDE_LINUX_CREDENTIALS_FILE) {
      if (content == null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }
    return orig.call(fs, p, ...rest);
  };
  try { return fn(); } finally { fs.readFileSync = orig; }
}

async function withFakeLinuxCredsFileAsync(content, fn) {
  const orig = fsp.readFile;
  fsp.readFile = async function (p, ...rest) {
    if (p === CLAUDE_LINUX_CREDENTIALS_FILE) {
      if (content == null) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    }
    return orig.call(fsp, p, ...rest);
  };
  try { return await fn(); } finally { fsp.readFile = orig; }
}

function withPlatform(value, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

async function withPlatformAsync(value, fn) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try { return await fn(); } finally {
    Object.defineProperty(process, 'platform', orig);
  }
}

// --------------------------------------------------------------------------
// resolveClaudeAuth — positive path + priority
// --------------------------------------------------------------------------

test('resolveClaudeAuth: Linux credentials file alone flips canAuth=true, existence-only', async () => {
  await withNoClaudeEnv(async () => {
    await withFakeClaudeAuthFile(null, () => {
      const r = resolveClaudeAuth({ hasKeychain: () => false, hasCredentialsFile: () => true });
      assert.equal(r.canAuth, true);
      assert.ok(r.sources.includes('file:~/.claude/.credentials.json'));
      // Existence-only: no token value should be forwarded to the child env.
      assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(r.env.ANTHROPIC_API_KEY, undefined);
    });
  });
});

test('resolveClaudeAuth: .claude-auth.json token is forwarded regardless of native store presence', async () => {
  // Source priority is additive, not competitive: the cached file's token
  // is always merged into env (tier 2, unchanged from PR #374); a native
  // store existing alongside it (tier 3/4) doesn't suppress it.
  for (const hasNative of [true, false]) {
    await withNoClaudeEnv(async () => {
      await withFakeClaudeAuthFile({ CLAUDE_CODE_OAUTH_TOKEN: 'cached-token' }, () => {
        const r = resolveClaudeAuth({ hasKeychain: () => false, hasCredentialsFile: () => hasNative });
        assert.equal(r.canAuth, true);
        assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'cached-token');
        if (hasNative) assert.ok(r.sources.includes('file:~/.claude/.credentials.json'));
      });
    });
  }
});

test('resolveClaudeAuth: ANTHROPIC_BASE_URL and its paired token both forward from the file', async () => {
  await withNoClaudeEnv(async () => {
    await withFakeClaudeAuthFile(
      { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid', ANTHROPIC_API_KEY: 'proxy-scoped-key' },
      () => {
        const r = resolveClaudeAuth({ hasKeychain: () => false, hasCredentialsFile: () => true });
        assert.equal(r.canAuth, true);
        assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://proxy.example.invalid');
        assert.equal(r.env.ANTHROPIC_API_KEY, 'proxy-scoped-key', 'the key paired with the custom endpoint must travel with it');
      },
    );
  });
});

// --------------------------------------------------------------------------
// resolveClaudeAuthForIsolated — positive path + priority
// --------------------------------------------------------------------------

test('resolveClaudeAuthForIsolated: Linux credentials file alone materializes via apiKeyHelper', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p10d-linux-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  await withNoClaudeEnv(async () => {
    await withFakeClaudeAuthFile(null, async () => {
      const r = await resolveClaudeAuthForIsolated({
        tmpRoot,
        hasKeychain: () => false,
        readKeychainToken: () => null,
        hasCredentialsFile: () => true,
        readCredentialsFileToken: () => 'linux-file-token-xyz',
      });
      assert.equal(r.canAuth, true);
      assert.ok(r.sources.includes('file:~/.claude/.credentials.json:claudeAiOauth.accessToken'));
      const helperContent = fs.readFileSync(r.apiKeyHelperSettings.helperPath, 'utf8');
      assert.ok(helperContent.includes('linux-file-token-xyz'));
      r.apiKeyHelperSettings.cleanup();
    });
  });
});

test('resolveClaudeAuthForIsolated: .claude-auth.json cache wins over a native store (normative §6.9 order)', async (t) => {
  // env → .claude-auth.json → keychain → Linux file, per
  // docs/specs/worker-preset-and-plugin-injection.md §6.9. The cached file
  // is checked BEFORE native stores for the isolated path.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p10d-linux-priority-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  await withNoClaudeEnv(async () => {
    await withFakeClaudeAuthFile({ CLAUDE_CODE_OAUTH_TOKEN: 'cached-token' }, async () => {
      const r = await resolveClaudeAuthForIsolated({
        tmpRoot,
        hasKeychain: () => false,
        readKeychainToken: () => null,
        hasCredentialsFile: () => true,
        readCredentialsFileToken: () => 'native-token',
      });
      assert.equal(r.canAuth, true);
      const helperContent = fs.readFileSync(r.apiKeyHelperSettings.helperPath, 'utf8');
      assert.ok(helperContent.includes('cached-token'), 'cached file token must win per the documented priority');
      assert.ok(!helperContent.includes('native-token'), 'native store must not be reached before the file tier');
      r.apiKeyHelperSettings.cleanup();
    });
  });
});

test('resolveClaudeAuthForIsolated: Linux native store is the last-resort fallback (no env, no file)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p10d-linux-fallback-'));
  t.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
  await withNoClaudeEnv(async () => {
    await withFakeClaudeAuthFile(null, async () => {
      const r = await resolveClaudeAuthForIsolated({
        tmpRoot,
        hasKeychain: () => false,
        readKeychainToken: () => null,
        hasCredentialsFile: () => true,
        readCredentialsFileToken: () => 'native-only-token',
      });
      assert.equal(r.canAuth, true);
      const helperContent = fs.readFileSync(r.apiKeyHelperSettings.helperPath, 'utf8');
      assert.ok(helperContent.includes('native-only-token'));
      r.apiKeyHelperSettings.cleanup();
    });
  });
});

// --------------------------------------------------------------------------
// hasClaudeLinuxCredentials / readClaudeLinuxCredentialsToken — real impls
// --------------------------------------------------------------------------

// These exercise the real platform-gated functions (not the DI stub), so
// every case that expects a non-false/non-null result MUST run under a
// forced 'linux' platform — otherwise it fails deterministically on a
// macOS/Windows CI runner since the gate short-circuits first (Codex
// adversarial re-review of PR #374, P1). The false/null-expecting cases are
// wrapped too, for test-intent correctness: without the wrap they'd still
// happen to pass on non-linux, but for the wrong reason (the platform gate,
// not the assertion actually under test).

test('hasClaudeLinuxCredentials: true for a valid non-empty accessToken', () => {
  withPlatform('linux', () => {
    withFakeLinuxCredsFile(JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } }), () => {
      assert.equal(hasClaudeLinuxCredentials(), true);
    });
  });
});

test('hasClaudeLinuxCredentials: false on malformed JSON', () => {
  withPlatform('linux', () => {
    withFakeLinuxCredsFile('{not valid json', () => {
      assert.equal(hasClaudeLinuxCredentials(), false);
    });
  });
});

test('hasClaudeLinuxCredentials: false when accessToken missing or empty', () => {
  withPlatform('linux', () => {
    withFakeLinuxCredsFile(JSON.stringify({ claudeAiOauth: { accessToken: '' } }), () => {
      assert.equal(hasClaudeLinuxCredentials(), false);
    });
    withFakeLinuxCredsFile(JSON.stringify({ other: 'shape' }), () => {
      assert.equal(hasClaudeLinuxCredentials(), false);
    });
  });
});

test('hasClaudeLinuxCredentials: false when file does not exist (ENOENT)', () => {
  withPlatform('linux', () => {
    withFakeLinuxCredsFile(null, () => {
      assert.equal(hasClaudeLinuxCredentials(), false);
    });
  });
});

test('hasClaudeLinuxCredentials: gated to non-macOS platforms (covers Windows too, round-4 fix)', () => {
  withFakeLinuxCredsFile(JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } }), () => {
    withPlatform('darwin', () => {
      assert.equal(hasClaudeLinuxCredentials(), false, 'darwin is covered by hasClaudeKeychainCredentials instead');
    });
    withPlatform('linux', () => {
      assert.equal(hasClaudeLinuxCredentials(), true);
    });
    withPlatform('win32', () => {
      // Codex adversarial re-review of PR #374 follow-up, round 4: an
      // earlier Linux-only allowlist gate silently broke standard
      // `claude login` auth on Windows, which has no keychain integration
      // here either and uses the same file.
      assert.equal(hasClaudeLinuxCredentials(), true, 'Windows has no keychain check here and must not be excluded');
    });
  });
});

test('readClaudeLinuxCredentialsToken: returns the token when not expired', async () => {
  const future = Date.now() + 60 * 60 * 1000;
  await withPlatformAsync('linux', async () => {
    await withFakeLinuxCredsFileAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'fresh-tok', expiresAt: future } }), async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), 'fresh-tok');
    });
  });
});

test('readClaudeLinuxCredentialsToken: returns null when accessToken is already expired', async () => {
  const past = Date.now() - 60 * 60 * 1000;
  await withPlatformAsync('linux', async () => {
    await withFakeLinuxCredsFileAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'expired-tok', expiresAt: past } }), async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), null);
    });
  });
});

test('readClaudeLinuxCredentialsToken: returns the token when expiresAt is absent (no expiry info doesn\'t block)', async () => {
  await withPlatformAsync('linux', async () => {
    await withFakeLinuxCredsFileAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'no-expiry-tok' } }), async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), 'no-expiry-tok');
    });
  });
});

test('readClaudeLinuxCredentialsToken: null on malformed JSON / missing file / macOS platform', async () => {
  await withPlatformAsync('linux', async () => {
    await withFakeLinuxCredsFileAsync('{broken', async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), null);
    });
    await withFakeLinuxCredsFileAsync(null, async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), null);
    });
  });
  await withFakeLinuxCredsFileAsync(JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }), async () => {
    await withPlatformAsync('darwin', async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), null, 'darwin is covered by readClaudeKeychainToken instead');
    });
    await withPlatformAsync('win32', async () => {
      assert.equal(await readClaudeLinuxCredentialsToken(), 'tok', 'Windows has no keychain path here and must not be excluded');
    });
  });
});
