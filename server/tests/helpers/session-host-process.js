'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createClient } = require('../../sessionHost/launcher');
const entry = path.resolve(__dirname, '../fixtures/session-host-fake-main.cjs');
async function poll(check, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw last || new Error('condition_timeout');
}
function birth(pid) {
  return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
}
function alive(pid, identity) {
  try { process.kill(pid, 0); return birth(pid) === identity; } catch { return false; }
}
function setup(t) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const tracked = new Map();
  const children = [];
  const clients = [];
  function track(pid) { const identity = birth(pid); assert.ok(identity); tracked.set(pid, identity); return identity; }
  t.after(async () => {
    for (const name of ['host-info', 'child-pid']) {
      try {
        const value = fs.readFileSync(path.join(runtimeDir, name), 'utf8');
        const pid = name === 'host-info' ? JSON.parse(value).pid : Number(value);
        if (!tracked.has(pid)) track(pid);
      } catch {}
    }
    for (const client of clients) client.close();
    for (const [pid, identity] of tracked) {
      if (alive(pid, identity)) process.kill(pid, 'SIGKILL');
    }
    for (const child of children) {
      // An unreaped direct ChildProcess handle cannot refer to a reused PID.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(runtimeDir, { force: true, recursive: true });
  });
  function launch(env = {}) {
    const child = spawn(process.execPath, [entry, '--runtime-dir', runtimeDir],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } });
    child.errors = '';
    child.stderr.on('data', chunk => { child.errors += chunk; });
    children.push(child);
    track(child.pid);
    return child;
  }
  async function ready(child) {
    return poll(async () => {
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error('host exited: ' + child.errors);
      const client = createClient({ runtimeDir, timeoutMs: 100 });
      try { await client.connect(); clients.push(client); return client; } catch { client.close(); return false; }
    }, 15000);
  }
  return { runtimeDir, launch, ready, track, tracked, clients, children };
}
const key = () => `rk_${Date.now()}_${require('node:crypto').randomBytes(8).toString('hex')}`;
module.exports = { entry, setup, poll, birth, alive, key };
