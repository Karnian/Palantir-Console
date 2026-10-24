'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { ensureHost, hostEnvironment } = require('../sessionHost/launcher');
const { entry, setup, poll, alive, key } = require('./helpers/session-host-process');
const options = { timeout: 9500 };
const info = h => JSON.parse(fs.readFileSync(path.join(h.runtimeDir, 'host-info'), 'utf8'));
const waitExit = child => poll(() => child.exitCode !== null || child.signalCode !== null);

test('X simultaneous hosts preserve winner socket inode and capability', options, async t => {
  const h = setup(t);
  const first = h.launch();
  const second = h.launch();
  const client = await h.ready();
  const winner = await poll(() => { try { return info(h); } catch { return false; } });
  const inode = fs.statSync(path.join(h.runtimeDir, 'host.sock')).ino;
  const capability = fs.readFileSync(path.join(h.runtimeDir, 'capability'), 'utf8');
  const loser = first.pid === winner.pid ? second : first;
  await waitExit(loser);
  assert.equal(loser.exitCode, 1);
  assert.match(loser.errors, /host_locked/);
  assert.ok(alive(winner.pid, h.tracked.get(winner.pid)));
  assert.equal(fs.statSync(path.join(h.runtimeDir, 'host.sock')).ino, inode);
  assert.equal(fs.readFileSync(path.join(h.runtimeDir, 'capability'), 'utf8'), capability);
  assert.deepEqual((await client.snapshot('missing')).state.session, null);
});

test('X lock does not survive in a live inherited-environment child', options, async t => {
  const h = setup(t);
  const first = h.launch({ SH_LONG_CHILD: '1' });
  await h.ready(first);
  const childPid = await poll(() => {
    try { return Number(fs.readFileSync(path.join(h.runtimeDir, 'child-pid'), 'utf8')); } catch { return false; }
  });
  const childBirth = h.track(childPid);
  // Negative control: while the owner is alive, a replacement MUST lose the same lock.
  const blocked = h.launch();
  await waitExit(blocked);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.errors, /host_locked/);
  process.kill(first.pid, 'SIGKILL');
  await waitExit(first);
  assert.ok(alive(childPid, childBirth));
  const replacement = h.launch();
  await h.ready(replacement);
  assert.equal(info(h).pid, replacement.pid);
  assert.ok(alive(childPid, childBirth));
  // A mutation that lets the child retain the exclusion would fail replacement readiness above.
});

for (const signal of ['SIGKILL', 'SIGTERM', 'SIGHUP']) {
  test('X detached host survives launcher parent ' + signal, options, async t => {
    const h = setup(t);
    const script = `const fs=require('node:fs');
      require(${JSON.stringify(path.resolve(__dirname, '../sessionHost/launcher'))})
      .ensureHost({runtimeDir:process.argv[1],entry:process.argv[2]}).then(async c=>{
        const r=await c.submit({kind:'start',cwd:'/tmp',request_key:process.argv[3]});
        fs.writeFileSync(process.argv[1]+'/parent-ready',JSON.stringify({sid:r.session_id,snapshot:await c.snapshot(r.session_id)}));
        setInterval(()=>{},1000);
      }).catch(()=>process.exit(2));`;
    const parent = spawn(process.execPath, ['-e', script, h.runtimeDir, entry, key()],
      { detached: true, stdio: 'ignore', env: hostEnvironment() });
    h.children.push(parent);
    h.track(parent.pid);
    const recorded = await poll(() => {
      try { return JSON.parse(fs.readFileSync(path.join(h.runtimeDir, 'parent-ready'), 'utf8')); } catch { return false; }
    });
    const host = info(h);
    const identity = h.track(host.pid);
    assert.ok(alive(parent.pid, h.tracked.get(parent.pid)));
    assert.ok(alive(host.pid, identity));
    process.kill(signal === 'SIGHUP' ? -parent.pid : parent.pid, signal);
    await waitExit(parent);
    // Checking the original birth identity rejects a host that was killed and silently relaunched.
    assert.ok(alive(host.pid, identity));
    const client = await h.ready();
    assert.equal(client.hostBootId, host.boot);
    assert.deepEqual(await client.snapshot(recorded.sid), recorded.snapshot);
  });
}

test('X before accepted crash is reconciled by lookup after boot change, effect occurs once', options, async t => {
  const h = setup(t);
  const first = h.launch({ SH_FAULT: 'before_accepted_reply' });
  const client = await h.ready(first);
  const originalBoot = client.hostBootId;
  const request = { kind: 'start', cwd: '/tmp', request_key: key() };
  await assert.rejects(client.submit(request), /acceptance_unknown/);
  await waitExit(first);
  const fresh = await ensureHost({ runtimeDir: h.runtimeDir, entry, timeoutMs: 2500 });
  h.clients.push(fresh);
  h.track(info(h).pid);
  assert.notEqual(fresh.hostBootId, originalBoot);
  const results = await client.reconcile();
  assert.equal(client.hostBootChanged, true);
  assert.notEqual(client.hostBootId, originalBoot);
  const found = results.get(request.request_key);
  assert.ok(found.session_id);
  assert.notEqual(found.found, false);
  assert.deepEqual(await fresh.lookup(request.request_key), found);
  assert.deepEqual(await fresh.submit(request), found);
  assert.deepEqual(fs.readFileSync(path.join(h.runtimeDir, 'effects'), 'utf8').trim().split('\n'), ['start']);
});

test('X idle drain refuses arrival with not_accepted, new host retries exactly once', options, async t => {
  const h = setup(t);
  const first = h.launch({ SH_IDLE_MS: '150', SH_IDLE_GATE: '1' });
  const client = await h.ready(first);
  await poll(() => fs.existsSync(path.join(h.runtimeDir, 'idle-draining')));
  const request = { kind: 'start', cwd: '/tmp', request_key: key() };
  await assert.rejects(client.submit(request), /not_accepted/);
  fs.writeFileSync(path.join(h.runtimeDir, 'idle-release'), 'go');
  await waitExit(first);
  assert.equal(fs.existsSync(path.join(h.runtimeDir, 'effects')), false);
  const fresh = await ensureHost({ runtimeDir: h.runtimeDir, entry, timeoutMs: 2500 });
  h.clients.push(fresh);
  h.track(info(h).pid);
  const result = await fresh.submit(request);
  assert.equal(result.state, 'done');
  assert.deepEqual(fs.readFileSync(path.join(h.runtimeDir, 'effects'), 'utf8').trim().split('\n'), ['start']);
});

test('X active ownership prevents idle and SIGTERM exit; zero ownership releases socket and lock', options, async t => {
  const h = setup(t);
  const child = h.launch({ SH_IDLE_MS: '120' });
  const client = await h.ready(child);
  const result = await client.submit({ kind: 'start', cwd: '/tmp', request_key: key() });
  process.kill(child.pid, 'SIGTERM');
  await poll(async () => {
    assert.ok(alive(child.pid, h.tracked.get(child.pid)));
    return Date.now() - Number(result.created_at) > 240;
  });
  assert.equal((await client.snapshot(result.session_id)).state.session.state, 'active');
  const closed = await client.submit({ kind: 'close', session_id: result.session_id, request_key: key() });
  assert.equal(closed.state, 'done');
  await waitExit(child);
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(path.join(h.runtimeDir, 'host.sock')), false);
  const replacement = h.launch();
  await h.ready(replacement);
});

test('X private file modes, capability absent from argv and env, launcher sanitizes env', options, async t => {
  const h = setup(t);
  const previous = { ...process.env };
  let client;
  try {
    process.env.PALANTIR_TOKEN = 'private-palantir-value';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-private';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-private';
    client = await ensureHost({ runtimeDir: h.runtimeDir, entry, timeoutMs: 2500 });
  } finally {
    for (const name of ['PALANTIR_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
  h.clients.push(client);
  const host = await poll(() => { try { return info(h); } catch { return false; } });
  h.track(host.pid);
  assert.equal(host.tokenPresent, false);
  assert.equal(host.oauthPresent, false);
  for (const [name, mode] of [['', 0o700], ['host.sock', 0o600], ['capability', 0o600]]) {
    assert.equal(fs.statSync(path.join(h.runtimeDir, name)).mode & 0o777, mode);
  }
  const capability = fs.readFileSync(path.join(h.runtimeDir, 'capability'), 'utf8');
  assert.match(capability, /^[a-f0-9]{64}$/);
  // Failure of ps is a test failure, never a skipped security assertion.
  const command = execFileSync('/bin/ps', ['-E', '-ww', '-o', 'command=', '-p', String(host.pid)], { encoding: 'utf8' });
  assert.ok(command.includes('session-host-fake-main.cjs'));
  for (const secret of [capability, 'private-palantir-value', 'sk-ant-oat-private']) assert.equal(command.includes(secret), false);
});
test('X SIGTERM with zero ownership exits cleanly and releases exclusion', options, async t => {
  const h = setup(t);
  const child = h.launch();
  await h.ready(child);
  process.kill(child.pid, 'SIGTERM');
  await waitExit(child);
  assert.equal(child.exitCode, 0);
  assert.equal(fs.existsSync(path.join(h.runtimeDir, 'host.sock')), false);
  const replacement = h.launch();
  await h.ready(replacement);
});
