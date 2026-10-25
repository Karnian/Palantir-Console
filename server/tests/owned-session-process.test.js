'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createClient } = require('../sessionHost/launcher');
const { createOwnedSessionService } = require('../services/ownedSessionService');
const { poll, key } = require('./helpers/session-host-process');
function processFixture(t, crash = false) {
  const runtimeDir = fs.mkdtempSync(path.join('/private/tmp', 'owned-'));
  const children = [], services = [];
  const entry = path.join(__dirname, 'helpers/owned-session-host-main.cjs');
  function launch() {
    const child = spawn(process.execPath, [entry, '--runtime-dir', runtimeDir], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, SH_OWNED_CRASH: crash ? '1' : '0' }
    });
    children.push(child);
    child.errors = ''; child.stderr.on('data', chunk => { child.errors += chunk; });
    return child;
  }
  async function ready(child) {
    return poll(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error(child.errors || 'host_exited');
      const client = createClient({ runtimeDir, timeoutMs: 100 });
      try { await client.connect(); client.close(); return true; } catch { client.close(); return false; }
    }, 1500);
  }
  function bridge() {
    const service = createOwnedSessionService({ runtimeDir, diagnose: () => ({ held: true }),
      createClient: options => createClient({ ...options, timeoutMs: 300 }) });
    services.push(service); return service;
  }
  t.after(async () => {
    for (const service of services) await service.shutdown();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve));
      }
    }
    fs.rmSync(runtimeDir, { force: true, recursive: true });
  });
  return { launch, ready, bridge, runtimeDir };
}
test('process bridge replacement preserves pending approval; shutdown leaves fake host alive and decision effect once', async t => {
  const f = processFixture(t); const child = f.launch(); await f.ready(child);
  let service = f.bridge();
  const start = await service.submit({ kind: 'start', cwd: process.cwd(), confirmed_settings: true, request_key: key() });
  const id = start.result.session_id;
  await service.submit({ kind: 'prompt', incarnation_id: start.result.incarnation_id, session_id: id, body: 'tool', request_key: key() });
  await poll(async () => (await service.snapshot(id)).state?.tool_requests?.some(row => row.state === 'pending'));
  await service.shutdown(); assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  service = f.bridge();
  assert.equal((await service.snapshot(id)).state.tool_requests[0].state, 'pending');
  const decision = { kind: 'tool_decision', incarnation_id: start.result.incarnation_id, session_id: id, request_key: key(), target_tool_use_id: 'tool', body: { behavior: 'allow' } };
  await service.submit(decision); await service.submit(decision);
  const effects = fs.readFileSync(path.join(f.runtimeDir, 'effects'), 'utf8').trim().split('\n');
  assert.equal(effects.filter(name => name === 'decide').length, 1);
  assert.equal(effects.filter(name => name === 'close').length, 0);
});
test('process accepted-before-reply crash remains unknown; boot change lookup and same key retry cause one start effect', async t => {
  const f = processFixture(t, true); const child = f.launch(); await f.ready(child);
  const service = f.bridge();
  const req = { kind: 'start', cwd: process.cwd(), confirmed_settings: true, request_key: key() };
  assert.equal((await service.submit(req)).acceptance, 'acceptance_unknown');
  await poll(() => child.signalCode !== null);
  const next = f.launch(); await f.ready(next);
  const lookup = await service.lookup(req.request_key);
  assert.ok(lookup.result.session_id);
  const retry = await service.submit(req);
  assert.equal(retry.acceptance, 'accepted'); assert.equal(retry.result.session_id, lookup.result.session_id);
  assert.equal(fs.readFileSync(path.join(f.runtimeDir, 'effects'), 'utf8').split('\n').filter(name => name === 'start').length, 1);
});

test('process broken socket exposes stale snapshot and lock pid only; all valid changes fail closed', async t => {
  const f = processFixture(t); const child = f.launch(); await f.ready(child);
  let client;
  const service = createOwnedSessionService({ runtimeDir: f.runtimeDir,
    createClient(options) { client = createClient({ ...options, timeoutMs: 100 }); return client; } });
  t.after(() => service.shutdown());
  const known = await service.list(); assert.equal(known.host, 'running');
  client.close(); await new Promise(resolve => setImmediate(resolve));
  fs.unlinkSync(path.join(f.runtimeDir, 'host.sock'));
  const unavailable = await service.list();
  assert.equal(unavailable.host, 'unreachable'); assert.equal(unavailable.current_state_known, false);
  assert.equal(typeof unavailable.as_of, 'number'); assert.deepEqual(unavailable.last_known.sessions, known.sessions);
  assert.equal(unavailable.diagnostics.pid, child.pid);
  for (const kind of ['start', 'prompt', 'tool_decision', 'question_answer', 'interrupt', 'stop', 'resume', 'close', 'delete']) {
    await assert.rejects(service.submit({ kind, request_key: key(), cwd: process.cwd(), confirmed_settings: true, incarnation_id: '12345678-1234-1234-1234-123456789abc' }),
      { code: 'host_unreachable', status: 503 });
  }
});
