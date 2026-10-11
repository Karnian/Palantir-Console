#!/usr/bin/env node
// Manual only: PALANTIR_ALLOW_REAL_SPAWN=1 node scripts/session-hub-smoke.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSessionHubService, TOOL_NAMES } = require('../server/services/sessionHubService.js');
const { resolveClaudeBinary } = require('../server/services/streamJsonEngine.js');
const { assertSpawnAllowed } = require('../server/utils/spawnGuard.js');
const { createSessionHubBroker } = require('../server/services/sessionHubBroker.js');
const { sealObserveState } = require('../server/services/observeSnapshotStore.js');
const exec = promisify(execFile);
const result = { ok: false, checks: {}, diagnostics: {}, errors: [] };
let service;
let server;
let markerFile;
let original;
let planted;
let originalMode;
let temporary;
let backupFile;
const abort = new AbortController();
const interrupt = () => {
  abort.abort();
  if (service) void service.shutdown().catch(() => {});
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function waitFor(check, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (abort.signal.aborted) throw new Error('smoke_interrupted');
    if (Date.now() >= deadline) throw new Error('smoke_timeout');
    if (service.state().error) throw new Error(service.state().error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function missing(filename) {
  try { await fs.lstat(filename); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
async function allFiles(directory) {
  if (await missing(directory)) return [];
  const files = [];
  for (const name of await fs.readdir(directory)) {
    const filename = path.join(directory, name);
    const stat = await fs.lstat(filename);
    if (stat.isDirectory() && !stat.isSymbolicLink()) files.push(...await allFiles(filename));
    else files.push(filename);
  }
  return files;
}

try {
  if (process.env.PALANTIR_ALLOW_REAL_SPAWN !== '1') throw new Error('PALANTIR_ALLOW_REAL_SPAWN=1_required');
  const binary = resolveClaudeBinary();
  if (!binary.executable) throw new Error('claude_unavailable');
  // Only this manual script opts into the existing guard's explicit real-spawn policy.
  assertSpawnAllowed({ command: binary.path, source: 'session-hub-smoke-help' });
  const help = await exec(binary.path, ['--help'], { timeout: 10000, signal: abort.signal });
  result.checks.includeHookEventsSupported = help.stdout.includes('--include-hook-events');
  result.diagnostics.binary = binary.path;
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-smoke-'));
  await fs.chmod(temporary, 0o700);
  const root = process.env.PALANTIR_SESSION_HUB_DIR || path.join(temporary, 'session-hub');
  const home = process.env.HOME || os.homedir();
  // Add an unpredictable marker to user instructions and restore exact prior bytes in finally.
  markerFile = path.join(home, '.claude/CLAUDE.md');
  await fs.mkdir(path.dirname(markerFile), { recursive: true });
  if (!await missing(markerFile)) {
    const info = await fs.lstat(markerFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_user_claude_md');
    original = await fs.readFile(markerFile);
    originalMode = info.mode & 0o777;
    backupFile = path.join(temporary, 'claude-md.original');
    await fs.writeFile(backupFile, original, { mode: 0o600 });
    result.diagnostics.userInstructionsBackup = backupFile;
  }
  if (abort.signal.aborted) throw new Error('smoke_interrupted');
  const sentinel = `HUB_SENTINEL_${crypto.randomBytes(16).toString('hex')}`;
  planted = Buffer.concat([original || Buffer.alloc(0), Buffer.from(`\nStartup smoke marker: ${sentinel}\n`)]);
  await fs.writeFile(markerFile, planted, { mode: originalMode || 0o600 });
  let broker;
  if (process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR) {
    const state = sealObserveState({ dir: process.env.PALANTIR_OBSERVE_SNAPSHOT_DIR, authToken: 'smoke-only' });
    if (!state.on) throw new Error('observe_snapshot_off');
    broker = createSessionHubBroker({ state });
  }
  let calls = 0;
  let successfulCalls = 0;
  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== `Bearer ${service?.current()}` || !service?.current()) {
      res.writeHead(403); res.end('{"error":"forbidden"}'); return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/api/session-hub/sessions') {
      res.writeHead(404); res.end('{"error":"not_found"}'); return;
    }
    calls++;
    try {
      const value = broker ? await broker.list(Object.fromEntries(url.searchParams))
        : { sessions: [], total: 0, next: null, clipped: false,
          meta: { rev: '0000000000000000', machines: [], unreadable: 0, machines_clipped: false } };
      successfulCalls++;
      res.end(JSON.stringify(value));
    } catch (error) { res.writeHead(503); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const raw = [];
  const mcpProcesses = [];
  service = createSessionHubService({ root, home, resolveBinary: () => binary,
    baseUrl: `http://127.0.0.1:${server.address().port}`, onProtocolEvent: event => raw.push(event),
    onMcpProcess: info => mcpProcesses.push(info),
  });
  await service.start();
  const leader = service.diagnostics().pgid;
  service.message('list_sessions를 limit 1로 정확히 한 번 호출해 결과를 짧게 말해라. ' +
    '파일이나 검색 도구는 사용하지 마라. 시작 지침에서 ' +
    'HUB_SENTINEL_로 시작하는 문자열을 ' +
    '기억하면 전체를 답하고, 없으면 "센티넬 없음"이라고 답해라.');
  await waitFor(() => raw.some(event => event.type === 'result'));
  await waitFor(() => mcpProcesses.some(info => info.kind === 'mcp'), 10000);
  const init = raw.find(event => event.type === 'system' && event.subtype === 'init');
  if (!init) throw new Error('init_missing');
  const tools = init.tools || [];
  const expected = TOOL_NAMES.map(name => `mcp__session_hub__${name}`);
  const harmless = ['AskUserQuestion'];
  result.diagnostics.harmlessTools = tools.filter(name => harmless.includes(name));
  result.checks.onlyThreeMcpTools = JSON.stringify(tools.filter(name => name.startsWith('mcp__')).sort())
    === JSON.stringify([...expected].sort());
  result.checks.noExecutionTools = tools.every(name => expected.includes(name) || harmless.includes(name));
  result.checks.onlySessionHubServer = init.mcp_servers?.length === 1
    && init.mcp_servers[0].name === 'session_hub' && init.mcp_servers[0].status === 'connected';
  result.checks.noSlashCommands = Array.isArray(init.slash_commands) && init.slash_commands.length === 0;
  result.checks.noSkills = Array.isArray(init.skills) && init.skills.length === 0;
  const answer = service.state().messages.filter(row => row.role === 'assistant').map(row => row.text).join('\n');
  result.checks.userInstructionsNotInjected = !answer.includes(sentinel) && answer.includes('센티넬 없음');
  result.checks.mcpSharesProcessGroup = mcpProcesses.every(info => info.pgid === leader);
  result.diagnostics.mcpProcesses = mcpProcesses;
  const { cwd, transcriptDir } = service.diagnostics();
  result.checks.expectedMemoryPath = init.memory_paths?.auto === `${transcriptDir}/memory/`;
  const hooks = raw.filter(event => event.type === 'system' && String(event.subtype).toLowerCase().includes('hook'));
  result.checks.noHooks = hooks.length === 0;
  result.diagnostics.hookSubtypes = hooks.map(event => event.subtype);
  result.checks.noAutoMemory = (await allFiles(path.join(transcriptDir, 'memory'))).length === 0;
  await service.stop();
  const transcripts = (await allFiles(transcriptDir)).filter(filename => filename.endsWith('.jsonl'));
  const records = [];
  for (const filename of transcripts) {
    for (const line of (await fs.readFile(filename, 'utf8')).split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  const withCwd = records.filter(record => Object.hasOwn(record, 'cwd'));
  result.checks.transcriptCwd = withCwd.length > 0 && withCwd.every(record => record.cwd === cwd);
  result.checks.oneSuccessfulToolCall = calls === 1 && successfulCalls === 1;
  result.diagnostics.brokerCalls = calls;
  result.diagnostics.brokerSource = broker ? 'observe-snapshots' : 'empty-smoke-fixture';
  result.diagnostics.init = init;
  const cleared = await service.clear();
  result.checks.clearComplete = cleared.result === 'complete' && cleared.remaining === 0;
  result.ok = Object.values(result.checks).every(Boolean);
} catch (error) {
  result.errors.push(error.message);
} finally {
  if (service) {
    try { await service.shutdown(); } catch (error) { result.errors.push(error.message); result.ok = false; }
  }
  if (server) await new Promise(resolve => server.close(resolve));
  if (planted) {
    try {
      const current = await fs.readFile(markerFile);
      if (current.equals(planted)) {
        if (original) await fs.writeFile(markerFile, original, { mode: originalMode });
        else await fs.unlink(markerFile);
      } else if (!original || !current.equals(original)) {
        throw new Error('user_claude_md_changed_restore_manually');
      }
      if (backupFile) await fs.unlink(backupFile);
      delete result.diagnostics.userInstructionsBackup;
    } catch (error) { result.errors.push(error.message); result.ok = false; }
  }
  // Preserve artifacts on failed reaping or incomplete clear for inspection/retry.
  if (temporary && result.checks.clearComplete && result.errors.length === 0) {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  else if (temporary) result.diagnostics.retainedRoot = temporary;
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
