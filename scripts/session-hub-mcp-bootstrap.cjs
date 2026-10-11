'use strict';

// The config contains a socket path, never credentials. This wrapper and its
// stdio MCP child inherit Claude's group. Only the two broker keys reach MCP.
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const pgid = pid => Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
const socket = net.connect(process.argv[2]);
let buffer = '';
let started = false;
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify({ pid: process.pid, pgid: pgid(process.pid) })}\n`));
socket.on('error', () => process.exit(1));
socket.on('data', chunk => {
  if (started) return;
  buffer += chunk;
  if (buffer.length > 4096) return process.exit(1);
  if (!buffer.includes('\n')) return;
  started = true;
  socket.end();
  let credentials;
  try { credentials = JSON.parse(buffer.split('\n')[0]); } catch { return process.exit(1); }
  const env = { PALANTIR_SESSION_HUB_TOKEN: credentials.PALANTIR_SESSION_HUB_TOKEN,
    PALANTIR_SESSION_HUB_BASE_URL: credentials.PALANTIR_SESSION_HUB_BASE_URL };
  if (Object.values(env).some(value => typeof value !== 'string' || !value)) return process.exit(1);
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
