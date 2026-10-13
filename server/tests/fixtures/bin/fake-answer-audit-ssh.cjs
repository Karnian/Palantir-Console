#!/usr/bin/env node
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length === 7 && args[5] === '--no-warnings' && args[6] === '-') require('./fake-ssh.js');
else if (args[0] === '-o' && args[1] === 'BatchMode=yes' && args[2] === '--' && args[5] === '-') {
  const decoded = args.slice(6).map(value => value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("'\\''", "'") : value);
  const child = spawn(process.execPath, ['--no-warnings', '-', ...decoded], {
    env: { ...process.env, HOME: process.env.FAKE_SSH_HOME }, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.stdin.on('error', () => {}); child.on('close', code => { process.exitCode = code; });
} else process.exitCode = 255;
