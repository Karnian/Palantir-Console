'use strict';

// Credentials arrive once. Keep the private socket open for liveness while this process runs stdio MCP.
const net = require('node:net');
const socket = net.connect(process.argv[2]);
let buffer = '';
let started = false;
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(`${JSON.stringify({ pid: process.pid })}\n`));
socket.on('error', () => process.exit(1));
socket.on('end', () => process.exit(1));
socket.on('close', () => process.exit(1));
socket.on('data', chunk => {
  if (started) return;
  buffer += chunk;
  if (buffer.length > 4096) return process.exit(1);
  if (!buffer.includes('\n')) return;
  started = true;
  let credentials;
  try { credentials = JSON.parse(buffer.split('\n')[0]); } catch { return process.exit(1); }
  const env = { PALANTIR_SESSION_HUB_TOKEN: credentials.PALANTIR_SESSION_HUB_TOKEN,
    PALANTIR_SESSION_HUB_BASE_URL: credentials.PALANTIR_SESSION_HUB_BASE_URL };
  if (Object.values(env).some(value => typeof value !== 'string' || !value)) return process.exit(1);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  const input = require('./session-hub-mcp.cjs').runStdio({ env });
  input.once('close', () => socket.end());
});
