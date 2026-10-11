#!/usr/bin/env node
// Manual only: PALANTIR_ALLOW_REAL_SPAWN=1 node scripts/session-hub-smoke.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
let temporary;
const abort = new AbortController();
const interrupt = () => {
  abort.abort();
  if (service) void service.shutdown().catch(() => {});
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function waitFor(check, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (abort.signal.aborted) throw new Error('smoke_interrupted');
    if (service.state().error) throw new Error(service.state().error);
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('smoke_timeout');
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
  // Read existing instructions without writing, creating, backing up or restoring the user's file.
  let userInstructionLines = null;
  try {
    const instructions = await fs.readFile(path.join(home, '.claude/CLAUDE.md'), 'utf8');
    userInstructionLines = instructions.split(/\r?\n/).map(line => line.trim())
      .filter(line => [...line].length >= 20);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  result.diagnostics.userInstructionLineCount = userInstructionLines?.length ?? 0;
  if (abort.signal.aborted) throw new Error('smoke_interrupted');
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
    '파일이나 검색 도구는 사용하지 마라. ' +
    (userInstructionLines === null ? '' : '시작 지침(CLAUDE.md 등)에 있는 문장을 ' +
      '아는 대로 3개 그대로 인용하라, 없으면 "센티넬 없음"'));
  await waitFor(() => raw.some(event => event.type === 'result') && !service.state().turnInProgress);
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
  result.checks.userInstructionsNotInjected = userInstructionLines === null ? 'skipped'
    : !userInstructionLines.some(line => answer.includes(line)) && answer.includes('센티넬 없음');
  result.checks.mcpSharesProcessGroup = mcpProcesses.every(info => info.pgid === leader);
  result.diagnostics.mcpProcesses = mcpProcesses;
  const { cwd, transcriptDir } = service.diagnostics();
  if (Object.hasOwn(init, 'memory_paths')) {
    result.checks.expectedMemoryPath = init.memory_paths?.auto === `${transcriptDir}/memory/`;
    result.diagnostics.pathVerification = 'memory_paths';
  } else {
    const info = await fs.lstat(path.join(transcriptDir, `${init.session_id}.jsonl`));
    result.checks.expectedMemoryPath = service.diagnostics().transcriptVerified
      && info.isFile() && !info.isSymbolicLink();
    result.diagnostics.pathVerification = 'transcript_file';
  }
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
  result.ok = Object.values(result.checks).every(value => value === true || value === 'skipped');
} catch (error) {
  result.errors.push(error.message);
} finally {
  if (service) {
    try { await service.shutdown(); } catch (error) { result.errors.push(error.message); result.ok = false; }
  }
  if (server) await new Promise(resolve => server.close(resolve));
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
