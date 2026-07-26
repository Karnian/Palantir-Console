'use strict';

// Preload with:
//   node --require ./server/tests/helpers/credential-probe-counter.js --test …
//
// This deliberately watches only the developer-machine credential locations.
// Tests remain free to exercise positive discovery against explicit temp-file
// seams without incrementing these counters.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const targets = new Map([
  [
    path.resolve(__dirname, '..', '..', '..', '.claude-auth.json'),
    { exists: 'repoAuthExists', read: 'repoAuthRead' },
  ],
  [
    path.resolve(os.homedir(), '.claude', '.credentials.json'),
    { exists: 'homeCredsExists', read: 'homeCredsRead' },
  ],
  [
    path.resolve(os.homedir(), '.codex', 'auth.json'),
    { exists: 'codexAuthExists', read: 'codexAuthRead' },
  ],
]);

const counts = {
  repoAuthExists: 0,
  repoAuthRead: 0,
  homeCredsExists: 0,
  homeCredsRead: 0,
  codexAuthExists: 0,
  codexAuthRead: 0,
  securityProbe: 0,
};

function targetFor(value) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value) && !(value instanceof URL)) {
    return null;
  }
  try {
    return targets.get(path.resolve(String(value))) || null;
  } catch {
    return null;
  }
}

const originalExistsSync = fs.existsSync;
fs.existsSync = function credentialProbeExistsSync(target, ...args) {
  const match = targetFor(target);
  if (match) counts[match.exists] += 1;
  return originalExistsSync.call(this, target, ...args);
};

const originalReadFileSync = fs.readFileSync;
fs.readFileSync = function credentialProbeReadFileSync(target, ...args) {
  const match = targetFor(target);
  if (match) counts[match.read] += 1;
  return originalReadFileSync.call(this, target, ...args);
};

function isSecurityCommand(file) {
  return typeof file === 'string' && path.basename(file) === 'security';
}

for (const method of ['execFile', 'execFileSync', 'spawn', 'spawnSync']) {
  const original = childProcess[method];
  childProcess[method] = function credentialProbeChildProcess(file, ...args) {
    if (isSecurityCommand(file)) counts.securityProbe += 1;
    return original.call(this, file, ...args);
  };
}

// `node --test` loads preloads in both the coordinator and each test child.
// Only children execute test code; suppress the coordinator's trailing all-zero
// line so `tail -1` cannot hide a probe observed in the child.
if (process.env.NODE_TEST_CONTEXT) {
  process.on('exit', () => {
    process.stderr.write(`PROBE_COUNTS ${JSON.stringify(counts)}\n`);
  });
}
