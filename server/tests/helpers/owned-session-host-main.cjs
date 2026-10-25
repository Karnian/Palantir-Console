'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { startHost } = require('../../sessionHost/hostProcess');
const { createFakeAdapter } = require('../../sessionHost/fakeAdapter');
const { createFakeIdentityProbe } = require('../../sessionHost/identity');
const runtimeDir = process.argv[process.argv.indexOf('--runtime-dir') + 1];
const identityProbe = createFakeIdentityProbe();
const adapter = createFakeAdapter({ identityProbe, manual: true });
for (const name of ['start', 'send', 'decide', 'close']) {
  const original = adapter[name];
  adapter[name] = (...args) => {
    fs.appendFileSync(path.join(runtimeDir, 'effects'), name + '\n');
    const result = original(...args);
    if (name === 'send') queueMicrotask(() => adapter.toolRequest(args[0], 'tool', 'Bash', { command: 'fake only' }));
    return result;
  };
}
const faults = { hit(point) {
  const marker = path.join(runtimeDir, 'crash-fired');
  if (process.env.SH_OWNED_CRASH === '1' && point === 'before_accepted_reply' && !fs.existsSync(marker)) {
    fs.writeFileSync(marker, '1');
    process.kill(process.pid, 'SIGKILL');
  }
} };
startHost({ runtimeDir, adapter, identityProbe, faults }).catch(error => {
  process.stderr.write(String(error.stack || error.code || error.message) + '\n'); process.exitCode = 1;
});
