'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const runtimeDir = process.argv[2];
process.env.HOME = path.join(runtimeDir, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) delete process.env[name];
const { createSdkAdapter } = require('../../sessionHost/sdkAdapter');
const { createFakeIdentityProbe } = require('../../sessionHost/identity');
const { startHost } = require('../../sessionHost/hostProcess');
(async () => {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const executablePath = path.resolve(__dirname, '../fixtures/bin/fake-claude-sdk.cjs');
  const identityProbe = createFakeIdentityProbe();
  const children = [];
  const adapter = createSdkAdapter({ sdk, executablePath,
    spawn(...args) { const child = spawn(...args); children.push(child); return child; },
    executableSha256: createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex'), identityProbe,
    baseEnv: { HOME: process.env.HOME, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH } });
  const incarnations = new Set();
  adapter.events.on('event', event => incarnations.add(event.incarnation_id));
  let failWrites = false;
  process.on('message', async message => {
    if (message === 'fail-db') { failWrites = true; process.send?.({ type: 'db-failed' }); }
    if (message === 'cleanup') {
      for (const id of incarnations) try { adapter.close(id); } catch {}
      const deadline = Date.now() + 5000;
      const timer = setInterval(() => {
        if (Date.now() > deadline) for (const child of children) {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        if (children.every(child => child.exitCode !== null || child.signalCode !== null)) {
          clearInterval(timer); process.send?.({ type: 'cleaned' });
        }
      }, 10);
    }
  });
  const host = await startHost({ runtimeDir, adapter, identityProbe, faults: { hit(point) {
    if (failWrites && point === 'db_write') throw Error('injected_db_write_failure');
  } } });
  process.send?.({ type: 'ready', pid: process.pid, boot: host.hostBootId });
})().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exit(1); });
