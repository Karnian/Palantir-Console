#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const NOW = '2026-10-08T03:00:00.000Z';
const BIN = path.resolve(__dirname, '../bin');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const transcript = path.join(home, '.claude/projects/s.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  function write(text = 'Synthetic instruction A') {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: 's', uuid: 'u',
      parentUuid: null, timestamp: '2026-10-08T02:00:00.000Z', cwd: '/synthetic/repo',
      message: { content: text }, origin: { kind: 'human' } }) + '\n');
  }
  write();
  const config = path.join(home, '.config/palantir/observe.json');
  const env = { ...process.env, HOME: home, FAKE_SSH_HOME: home, PALANTIR_BLOCK_REAL_SPAWN: '1',
    PALANTIR_ALLOW_REAL_SPAWN: '0', PALANTIR_OBSERVE_SSH_BIN: path.join(BIN, 'fake-ssh.js'),
    FAKE_ORCA_SPAWN_LOG: path.join(root, 'orca.log'), FAKE_SSH_ARGV_LOG: path.join(root, 'argv.json') };
  const request = { schema: 'palantir.snapshot-request/1', op: 'snapshot', now: NOW,
    include_exec: false, orca_bin: path.join(BIN, 'fake-orca.js') };
  return { root, home, config, env, request, write, out: path.join(root, 'out'),
    target: { kind: 'remote', host: 'synthetic@host', remoteNode: '/synthetic/node' } };
}
function capture(input = '', executorSpawn = spawn) {
  let output = '';
  let errors = '';
  let spawns = 0;
  return { stdin: Readable.from([input]), stdout: { write(text) { output += text; } },
    stderr: { write(text) { errors += text; } },
    spawnImpl(...args) { spawns++; return executorSpawn(...args); },
    output: () => output, errors: () => errors, spawns: () => spawns };
}
function recordingSpawn(t) {
  const calls = [];
  function spawnImpl(command, args, options) {
    calls.push({ command, args, options });
    t.diagnostic(JSON.stringify({ stubCommand: command, args, realSpawns: 0 }));
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.resume();
    child.kill = () => false;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 1, null);
    });
    return child;
  }
  return { calls, spawnImpl };
}
function descendantProbe(t, root) {
  const pidFile = path.join(root, 'descendant.pid');
  let pid;
  t.after(() => {
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  });
  async function waitUntil(check) {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (t.signal.aborted) throw t.signal.reason;
      if (Date.now() >= deadline) throw new Error('descendant_probe_timeout');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function readPid() {
    await waitUntil(() => fs.existsSync(pidFile));
    pid = Number(fs.readFileSync(pidFile, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 1) throw new Error('invalid_descendant_pid');
    t.diagnostic(JSON.stringify({ descendantPid: pid }));
    return pid;
  }
  async function waitForExit() {
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') throw error; return true; }
    });
  }
  return { pidFile, readPid, waitForExit };
}
module.exports = { fixture, capture, recordingSpawn, descendantProbe, NOW, BIN };
