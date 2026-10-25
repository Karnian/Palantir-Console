'use strict';
const { EventEmitter } = require('node:events');
const { startHost } = require('./hostProcess');
const { loadSdkAdapter, bundledExecutable } = require('./sdkAdapter');
const { createPsIdentityProbe } = require('./psIdentity');
function unavailableAdapter() {
  const unavailable = () => { throw new Error('adapter_unavailable'); };
  return { unavailable: true, events: new EventEmitter(), checkSettings: () => Promise.reject(new Error('adapter_unavailable')),
    accountInfo: () => Promise.reject(new Error('adapter_unavailable')),
    facts: () => ({ exited: true, aborted: false }),
    start: unavailable, send: unavailable, decide: unavailable, interrupt: unavailable, close: unavailable, signal: unavailable };
}
async function main() {
  if (process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS === '1') throw new Error('legacy_credential_mode');
  const index = process.argv.indexOf('--runtime-dir');
  if (index === -1 || !process.argv[index + 1]) throw new Error('runtime_dir_required');
  let adapter = unavailableAdapter();
  let identityProbe = { findMarked: () => ({ status: 'query_failed' }), check: () => 'query_failed' };
  try {
    const executablePath = bundledExecutable();
    identityProbe = createPsIdentityProbe({ pinnedPath: executablePath });
    adapter = await loadSdkAdapter({ executablePath, identityProbe });
  } catch { /* Missing SDK or bundled executable keeps the host available for diagnostics. */ }
  await startHost({ runtimeDir: process.argv[index + 1], adapter, identityProbe });
}
if (require.main === module) main().catch(error => {
  process.stderr.write((['legacy_credential_mode', 'host_locked'].includes(error.message) ? error.message : 'host_start_failed') + '\n');
  process.exitCode = 1;
});
module.exports = { unavailableAdapter };
