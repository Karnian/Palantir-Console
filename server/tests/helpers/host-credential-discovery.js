'use strict';

// `npm test` pins PALANTIR_SKIP_HOST_CREDENTIALS=1 so resolver results come
// from a test's own inputs rather than from whether the machine running it
// happens to be logged in.
//
// A few suites assert the opposite: that discovery DOES happen — that the
// keychain gets probed, that the CLI credential store is read, that the usage
// provider shells out. Those must opt back in for their own scope, or the
// global default turns them into assertions that nothing happens, which is
// exactly the failure this seam is meant to prevent elsewhere.
//
// Restores the previous value rather than deleting, so a run that set the flag
// explicitly still gets it back.

function withHostCredentialDiscovery(fn) {
  const saved = process.env.PALANTIR_SKIP_HOST_CREDENTIALS;
  delete process.env.PALANTIR_SKIP_HOST_CREDENTIALS;
  const restore = () => {
    if (saved === undefined) delete process.env.PALANTIR_SKIP_HOST_CREDENTIALS;
    else process.env.PALANTIR_SKIP_HOST_CREDENTIALS = saved;
  };
  let result;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // Support async bodies without forcing every caller to await.
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { restore(); return value; },
      (err) => { restore(); throw err; },
    );
  }
  restore();
  return result;
}

/**
 * File-scope form: enable discovery for an entire test file. Use when the file
 * exists to exercise discovery itself, rather than having one test that does.
 */
function enableHostCredentialDiscoveryForFile() {
  delete process.env.PALANTIR_SKIP_HOST_CREDENTIALS;
}

function withLegacyClaudeCredentialAccess(fn) {
  const saved = process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS;
  process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
  const restore = () => {
    if (saved === undefined) delete process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS;
    else process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = saved;
  };
  try {
    const result = withHostCredentialDiscovery(fn);
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) { restore(); throw error; }
}
function enableLegacyClaudeCredentialAccessForFile() {
  const savedLegacy = process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS;
  const savedSkip = process.env.PALANTIR_SKIP_HOST_CREDENTIALS;
  enableHostCredentialDiscoveryForFile();
  process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS = '1';
  require('node:test').after(() => {
    for (const [key, value] of [['PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS', savedLegacy], ['PALANTIR_SKIP_HOST_CREDENTIALS', savedSkip]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

module.exports = { withLegacyClaudeCredentialAccess, enableLegacyClaudeCredentialAccessForFile, withHostCredentialDiscovery, enableHostCredentialDiscoveryForFile };
