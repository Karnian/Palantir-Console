'use strict';

// The config contains a socket path, never credentials. This wrapper and its
// stdio MCP child inherit Claude's group. Only the two broker keys reach MCP.
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const pgid = pid => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
const socket = net.connect(process.argv[2]);
let buffer = '';
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify({ pid: process.pid, pgid: pgid(process.pid) })}\n`));
socket.on('error', () => process.exit(1));
socket.on('data', chunk => {
  buffer += chunk;
  if (!buffer.includes('\n')) return;
  socket.end();
  const env = JSON.parse(buffer.split('\n')[0]);
  const child = spawn(process.execPath, [path.join(__dirname, 'session-hub-mcp.cjs')], { env, stdio: 'inherit' });
  const report = net.connect(process.argv[2]);
  report.on('error', () => process.exit(1));
  report.on('data', () => {});
  report.on('connect', () => report.end(`${JSON.stringify({
    pid: child.pid, pgid: pgid(child.pid), kind: 'mcp',
  })}\n`));
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
});
