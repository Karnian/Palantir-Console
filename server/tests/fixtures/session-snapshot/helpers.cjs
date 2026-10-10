#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
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
function capture(input = '') {
  let output = '';
  let errors = '';
  let spawns = 0;
  return { stdin: Readable.from([input]), stdout: { write(text) { output += text; } },
    stderr: { write(text) { errors += text; } },
    spawnImpl(...args) { spawns++; return spawn(...args); },
    output: () => output, errors: () => errors, spawns: () => spawns };
}
module.exports = { fixture, capture, NOW, BIN };
