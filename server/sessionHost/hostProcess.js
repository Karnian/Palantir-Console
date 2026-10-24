'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes, randomUUID } = require('node:crypto');
const { acquireLock } = require('./lock');
const { createHostCore } = require('./core');
const { createProtocol } = require('./protocol');

async function startHost({ runtimeDir, adapter, identityProbe, clock = Date.now, idleMs = 60000, faults, log = () => {} }) {
  if (process.env.PALANTIR_LEGACY_CLAUDE_CREDENTIAL_ACCESS === '1') {
    throw Object.assign(new Error('legacy_credential_mode'), { code: 'legacy_credential_mode' });
  }
  const lock = acquireLock(runtimeDir);
  const address = path.join(runtimeDir, 'host.sock');
  const hostBootId = randomUUID();
  const capability = randomBytes(32).toString('hex');
  const now = typeof clock === 'function' ? clock : () => clock.now();
  let core;
  let timer;
  let stopped = false;
  let draining = false;
  let idleSince = null;
  const connections = new Map();
  const server = net.createServer(socket => {
    if (draining) return socket.destroy();
    const protocol = createProtocol({ stream: socket,
      core: adapter.unavailable ? { ...core, submit: core.submitUnavailable } : core,
      capability, hostBootId, sdkVersion: adapter.sdkVersion ?? adapter.sdk_version ?? null, onActivity: () => { idleSince = null; } });
    connections.set(socket, protocol);
    socket.on('close', () => connections.delete(socket));
  });
  const unlink = () => { try { fs.unlinkSync(address); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.removeListener('error', reject);
      fs.chmodSync(address, 0o600);
      resolve();
    });
  });
  const active = () => core.activity().activeSessions > 0;
  async function stop() {
    if (stopped) return true;
    if (active()) { log('active_sessions_preserved'); return false; }
    stopped = true;
    clearInterval(timer);
    process.off('SIGTERM', signal);
    process.off('SIGINT', signal);
    process.off('SIGHUP', hup);
    for (const protocol of connections.values()) protocol.drain();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    unlink();
    try { core.close(); } finally { lock.release(); }
    return true;
  }
  function signal() { void stop().catch(() => log('shutdown_failed')); }
  function hup() { log('hangup_ignored'); }
  async function checkIdle() {
    if (stopped || draining) return;
    core.tick();
    const status = core.activity();
    const pending = [...connections.values()].some(protocol => protocol.pendingCount);
    if (status.activeSessions || status.pendingCommands || pending) { idleSince = null; return; }
    if (idleSince === null) idleSince = now();
    if (now() - idleSince < idleMs) return;
    draining = true;
    const closed = new Promise(resolve => server.close(resolve));
    for (const protocol of connections.values()) protocol.beginDrain();
    await faults?.hit?.('before_idle_drain');
    for (const protocol of connections.values()) protocol.drain();
    await closed;
    const final = core.activity();
    if (final.activeSessions || final.pendingCommands) {
      idleSince = null;
      await listen();
      draining = false;
    } else await stop();
  }
  try {
    core = createHostCore({ dbPath: path.join(runtimeDir, 'host.db'), adapter, identityProbe, clock, hostBootId, faults });
    core.recover();
    unlink();
    await listen();
    const temporary = path.join(runtimeDir, `.capability-${hostBootId}`);
    fs.writeFileSync(temporary, capability, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, path.join(runtimeDir, 'capability'));
    process.on('SIGTERM', signal);
    process.on('SIGINT', signal);
    process.on('SIGHUP', hup);
    timer = setInterval(() => { void checkIdle().catch(() => log('idle_check_failed')); }, Math.max(5, Math.min(100, idleMs / 4)));
    timer.unref();
    return { stop, address, hostBootId };
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    try { core?.close(); } finally { lock.release(); }
    throw error;
  }
}
module.exports = { startHost };
