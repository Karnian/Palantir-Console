'use strict';
// Measurement helpers for S1-e2. Not product code.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const HERE = __dirname;
const STATE = path.join(HERE, 'state.json');
const LOG = path.join(HERE, 'measure.log');
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}
if (!state.runtimeDir) {
  // Unix socket paths are limited to ~104 bytes on macOS, so keep the runtime dir short.
  state.runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh1e2-'));
  state.work = path.join(HERE, 'work dir');
  fs.mkdirSync(state.work, { recursive: true });
  save();
}
const key = () => `rk_${Date.now()}_${randomBytes(8).toString('hex')}`;
let bridge, origin;
function startBridge() {
  return new Promise((resolve, reject) => {
    bridge = spawn(process.execPath, [path.join(HERE, 'bridge.cjs'), state.runtimeDir, '0'],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    bridge.once('message', message => { origin = `http://127.0.0.1:${message.port}`; resolve(bridge); });
    bridge.once('exit', code => reject(new Error(`bridge exited ${code}`)));
  });
}
async function stopBridge(signal = 'SIGKILL') {
  if (!bridge || bridge.exitCode !== null || bridge.signalCode !== null) return;
  const exited = new Promise(resolve => bridge.once('exit', resolve));
  bridge.kill(signal);
  await exited;
}
async function call(route, method = 'GET', body) {
  const response = await fetch(origin + '/api/owned-sessions' + route, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, body: json };
}
async function until(check, label, timeout = 120000, interval = 500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`timeout: ${label} last=${JSON.stringify(last)?.slice(0, 400)}`);
}
const snap = async id => (await call('/' + id)).body;
const counter = () => {
  const file = path.join(state.work, 'counter.txt');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
};
function summarize(snapshot) {
  const s = snapshot.state || {};
  return {
    host: snapshot.host, session: s.session?.state, current: s.current_incarnation_id,
    incarnations: (s.incarnations || []).map(i => `${i.id.slice(0, 8)}:${i.state}:${i.end_reason || ''}:au${i.attribution_uncertain}:iu${i.interrupt_unknown}`),
    deliveries: (s.deliveries || []).map(d => `${d.kind}:${d.state}:${d.outcome || ''}:${d.reason || ''}`),
    cards: (s.tool_requests || []).map(t => `${t.tool_name}:${t.state}`),
    controls: (s.controls || []).map(c => `${c.kind}:${c.stage}:${c.state}:${c.reason || ''}`)
  };
}
// Independent evidence: the CLI's own transcript for this session.
function cliTranscriptUsers(claudeSessionId) {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  for (const project of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, project, `${claudeSessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const prompts = rows.filter(r => r.type === 'user' && typeof r.message?.content === 'string');
    return { file, prompts: prompts.length, uuids: prompts.map(r => r.uuid) };
  }
  return null;
}
module.exports = { state, save, log, key, startBridge, stopBridge, call, until, snap, counter, summarize, cliTranscriptUsers };
