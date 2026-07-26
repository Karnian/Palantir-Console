// #416: PALANTIR_SKIP_HOST_CREDENTIALS makes AMBIENT host credential discovery
// inert, so a screenshot depends on the repo rather than on whether the person
// running it happens to be logged in.
//
// The visual server already overrides HOME, but that is not enough on its own:
// `.claude-auth.json` sits at the REPO root, which HOME cannot move, and the
// macOS keychain is not path-scoped at all. Clearing the env vars does not
// close it either — an empty value is falsy, which is exactly the condition
// that makes the resolver fall back to the file.
//
// The switch must NOT become a general "no auth" mode: credentials passed
// explicitly through the environment still have to work, or this would be a
// way to silently disable auth in a real deployment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH_RESOLVER = require.resolve('../services/authResolver');
const CLAUDE_AUTH_FILE = path.join(__dirname, '..', '..', '.claude-auth.json');

// The module reads process.env at call time, but reload anyway so each case
// starts from a known state regardless of what a sibling test file left behind.
function loadResolver() {
  delete require.cache[AUTH_RESOLVER];
  return require(AUTH_RESOLVER);
}

const SILENT = { logger: { log() {}, warn() {} } };

// Never clobber a real developer credential file: plant the fixture only when
// the path is free, and always restore the previous env.
function withPlantedAuthFile(t, contents) {
  if (fs.existsSync(CLAUDE_AUTH_FILE)) return false;
  fs.writeFileSync(CLAUDE_AUTH_FILE, JSON.stringify(contents), { mode: 0o600 });
  t.after(() => { try { fs.unlinkSync(CLAUDE_AUTH_FILE); } catch { /* ignore */ } });
  return true;
}

function withCleanEnv(t) {
  const saved = {};
  for (const key of [
    'PALANTIR_SKIP_HOST_CREDENTIALS',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[AUTH_RESOLVER];
  });
}

test('isolation switch stops .claude-auth.json from hydrating process.env', (t) => {
  withCleanEnv(t);
  if (!withPlantedAuthFile(t, { ANTHROPIC_API_KEY: 'sk-ant-fixture' })) {
    t.skip('a real .claude-auth.json is present — refusing to overwrite it');
    return;
  }

  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), false);
  assert.equal(
    process.env.ANTHROPIC_API_KEY,
    undefined,
    'the file must not reach process.env under isolation',
  );
});

test('without the switch the same file still hydrates process.env (no behaviour change)', (t) => {
  withCleanEnv(t);
  if (!withPlantedAuthFile(t, { ANTHROPIC_API_KEY: 'sk-ant-fixture' })) {
    t.skip('a real .claude-auth.json is present — refusing to overwrite it');
    return;
  }

  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), true);
  assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-fixture');
});

test('isolation switch never writes the auth file back out', (t) => {
  withCleanEnv(t);
  if (fs.existsSync(CLAUDE_AUTH_FILE)) {
    t.skip('a real .claude-auth.json is present — refusing to overwrite it');
    return;
  }
  t.after(() => { try { fs.unlinkSync(CLAUDE_AUTH_FILE); } catch { /* ignore */ } });

  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
  assert.equal(loadResolver().bootstrapClaudeAuthFromEnv(SILENT), false);
  assert.equal(
    fs.existsSync(CLAUDE_AUTH_FILE),
    false,
    'isolation must not persist credentials to the repo root',
  );
});

test('isolation switch reports no ambient credentials to the resolver', (t) => {
  withCleanEnv(t);
  if (!withPlantedAuthFile(t, { ANTHROPIC_API_KEY: 'sk-ant-fixture' })) {
    t.skip('a real .claude-auth.json is present — refusing to overwrite it');
    return;
  }

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

test('explicit env credentials still authenticate under isolation (not a kill switch)', (t) => {
  withCleanEnv(t);
  process.env.PALANTIR_SKIP_HOST_CREDENTIALS = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-explicit';

  const auth = loadResolver().resolveClaudeAuth();
  assert.equal(
    auth.canAuth,
    true,
    'isolation suppresses AMBIENT discovery only — an explicit env credential must still work',
  );
});
