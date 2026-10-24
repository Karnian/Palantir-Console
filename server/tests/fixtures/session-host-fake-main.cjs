'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFakeAdapter } = require('../../sessionHost/fakeAdapter');
const { createFakeIdentityProbe } = require('../../sessionHost/identity');
const { startHost } = require('../../sessionHost/hostProcess');
const index = process.argv.indexOf('--runtime-dir');
const runtimeDir = process.argv[index + 1];
const probe = createFakeIdentityProbe();
const adapter = createFakeAdapter({ identityProbe: probe });
for (const name of ['start', 'send', 'decide', 'interrupt', 'close']) {
  const original = adapter[name];
  adapter[name] = (...args) => {
    fs.appendFileSync(path.join(runtimeDir, 'effects'), name + '\n');
    return original(...args);
  };
}
const faults = { hit(point) {
  if (point === 'before_idle_drain' && process.env.SH_IDLE_GATE === '1' &&
      !fs.existsSync(path.join(runtimeDir, 'idle-release'))) {
    fs.writeFileSync(path.join(runtimeDir, 'idle-draining'), 'ready');
    return new Promise(resolve => {
      const deadline = Date.now() + 2000;
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(runtimeDir, 'idle-release')) || Date.now() > deadline) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
  }
  if (point !== process.env.SH_FAULT) return;
  const marker = path.join(runtimeDir, 'fault-fired');
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, point);
  process.kill(process.pid, 'SIGKILL');
} };
startHost({ runtimeDir, adapter, identityProbe: probe, faults, idleMs: Number(process.env.SH_IDLE_MS || 60000) })
  .then(host => {
    fs.writeFileSync(path.join(runtimeDir, 'host-info'), JSON.stringify({ pid: process.pid, boot: host.hostBootId,
      tokenPresent: Object.hasOwn(process.env, 'PALANTIR_TOKEN'),
      oauthPresent: Object.hasOwn(process.env, 'CLAUDE_CODE_OAUTH_TOKEN') ||
        (process.env.ANTHROPIC_API_KEY || '').startsWith('sk-ant-oat') }));
    if (process.env.SH_LONG_CHILD === '1') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)'],
        { detached: true, stdio: 'ignore', env: { ...process.env, SH_LOCK_CHILD: host.hostBootId } });
      child.unref();
      fs.writeFileSync(path.join(runtimeDir, 'child-pid'), String(child.pid));
    }
  }).catch(error => {
    process.stderr.write((error.code || error.message) + '\n');
    process.exitCode = 1;
  });
