'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { createHostCore } = require('../../sessionHost/core');
const { createFakeIdentityProbe } = require('../../sessionHost/identity');
const { createSdkAdapter } = require('../../sessionHost/sdkAdapter');
const executablePath = path.resolve(__dirname, '../fixtures/bin/fake-claude-sdk.cjs');
const executableSha256 = createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex');
async function until(predicate, label = 'condition', timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw Error(`Timed out: ${label}`);
}
async function fixture(t, sdk, config = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1-sdk-'));
  fs.writeFileSync(path.join(dir, 'fake-claude.json'), JSON.stringify(config));
  const probe = options.identityProbe || createFakeIdentityProbe();
  const processes = [], events = [], spawns = [];
  let time = 1800000000000, count = 0;
  const adapter = createSdkAdapter({ sdk, executablePath, executableSha256, identityProbe: probe,
    baseEnv: { HOME: process.env.HOME, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') },
    ...options,
    spawn(command, args, opts) {
      spawns.push({ command, args, opts });
      const child = spawn(command, args, opts);
      processes.push(child);
      return child;
    }
  });
  adapter.events.on('event', event => events.push(event));
  const core = createHostCore({ dbPath: path.join(dir, 'host.sqlite'), adapter, identityProbe: probe,
    clock: () => time, hostBootId: 'sdk-boot' });
  const f = {
    dir, adapter, core, probe, processes, spawns, events,
    advance(ms) { time += ms; core.tick(); },
    key() { return `rk_${time}_${(++count).toString(16).padStart(16, '0')}`; },
    req(kind, extra = {}) { return { kind, request_key: f.key(), session_id: f.sid, incarnation_id: f.iid, ...extra }; },
    async start() {
      const accepted = core.submit({ kind: 'start', request_key: f.key(), cwd: dir });
      f.sid = accepted.session_id;
      f.iid = accepted.incarnation_id;
      return f.control(accepted);
    },
    control(accepted) {
      return until(() => {
        const row = core.lookup(accepted.request_key);
        return row.state !== 'accepted' && row;
      }, 'control completion');
    },
    state() { return core.snapshot(f.sid).state; },
    d(delivery) { return f.state().deliveries.find(row => row.id === delivery.id); },
    log() {
      try { return fs.readFileSync(path.join(dir, 'fake-claude.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    prompt(body = 'hello') { return core.submit(f.req('prompt', { body })); },
    async completed(delivery) { return until(() => f.d(delivery)?.state === 'completed' && f.d(delivery), 'prompt completed'); },
    async pendingTool() { return until(() => f.state().tool_requests.find(row => row.state === 'pending'), 'tool request'); },
    async exit() {
      adapter.signal(f.iid, 'SIGKILL');
      await until(() => adapter.facts(f.iid).exited, 'child exit');
    }
  };
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGKILL');
      await until(() => child.exitCode !== null || child.signalCode !== null, 'cleanup exit');
    }
    for (const record of f.log().filter(row => row.type === 'grandchild')) {
      await until(() => {
        try { process.kill(record.pid, 0); return false; }
        catch (error) { if (error.code === 'ESRCH') return true; throw error; }
      }, 'grandchild exit');
    }
    await delay(10);
    core.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
module.exports = { fixture, until, executablePath, executableSha256 };
