'use strict';
const { EventEmitter } = require('node:events');
const { startHost } = require('./hostProcess');
function unavailableAdapter() {
  const unavailable = () => { throw new Error('adapter_unavailable'); };
  return { unavailable: true, events: new EventEmitter(), settingsCheck: () => true, authCheck: () => false,
    start: unavailable, send: unavailable, decide: unavailable, interrupt: unavailable, close: unavailable, signal: unavailable };
}
async function main() {
  if (process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS === '1') throw new Error('legacy_credential_mode');
  const index = process.argv.indexOf('--runtime-dir');
  if (index === -1 || !process.argv[index + 1]) throw new Error('runtime_dir_required');
  await startHost({ runtimeDir: process.argv[index + 1], adapter: unavailableAdapter(),
    identityProbe: { findMarked: () => ({ status: 'query_failed' }), check: () => 'query_failed' } });
}
if (require.main === module) main().catch(error => {
  process.stderr.write((['legacy_credential_mode', 'host_locked'].includes(error.message) ? error.message : 'host_start_failed') + '\n');
  process.exitCode = 1;
});
module.exports = { unavailableAdapter };
