#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4177';
const token = process.env.PALANTIR_TOKEN || '';
let jsonMode = process.argv.slice(2).includes('--json');
let interrupted = false;
let followErrorCollector = null;

process.once('SIGINT', () => {
  interrupted = true;
  process.exit(130);
});

function handleBrokenPipe(error) {
  if (followErrorCollector) {
    followErrorCollector(error);
    return;
  }
  // EPIPE = 소비자가 먼저 닫음 → 우리 실패가 아니다(§7 우선순위).
  if (error?.code === 'EPIPE') process.exit(interrupted ? 130 : 0);
  // 그 외 쓰기 오류(ENOSPC/EIO…)는 출력이 온전히 전달됐는지 확인할 수 없다는 뜻이므로
  // 코드 5 다. throw 하면 미처리 예외 스택이 stderr 에 찍히고 코드 1 로 끝나 계약이 깨진다.
  try { process.stderr.write(`palantir: output write failed (${error?.code || 'unknown'})\n`); } catch { /* 이미 못 쓴다 */ }
  process.exit(interrupted ? 130 : 5);
}

process.stdout.on('error', handleBrokenPipe);
process.stderr.on('error', handleBrokenPipe);

// 서버 문자열이 CR/LF·ANSI escape 를 담고 있으면 "결과 한 줄" 성질과 stdout
// 청결성이 깨진다. JSON mode 는 JSON.stringify 가 막지만 human mode 는 아니다.
function singleLine(value) {
  if (typeof value !== 'string') return value;
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
}

function redact(value) {
  if (!token || typeof value !== 'string') return value;
  return value.split(token).join('[redacted]');
}

function writeJson(value) {
  const safeValue = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, redact(entry)]),
  );
  process.stdout.write(`${JSON.stringify(safeValue)}\n`);
}

const USAGE = 'Usage: palantir spawn <task_id> [--agent <profile_id>] [--json]\n'
  + '       palantir input <run_id> <text...> [--json]\n'
  + '       palantir cancel <run_id> [--json]\n'
  + '       palantir follow <run_id>\n'
  + '\nConcurrent follow processes for the same run_id are unsupported (last-writer-wins).\n';

function usageError() {
  if (jsonMode) writeJson({ type: 'error', kind: 'usage' });
  else process.stderr.write(USAGE);
  return 1;
}

// `--help` 는 사용자가 **의도한 성공**이지 오류가 아니다. 코드 1 로 끝내면
// `palantir --help` 로 설치 여부를 확인하는 스크립트가 실패로 읽는다.
// 도움말은 요청된 출력이므로 stdout, 종료 코드 0.
function showHelp() {
  process.stdout.write(USAGE);
  return 0;
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        agent: { type: 'string' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return null;
  }

  jsonMode = parsed.values.json === true;
  const [command, ...args] = parsed.positionals;
  const agent = parsed.values.agent;

  if (command === 'spawn') {
    if (args.length !== 1 || !args[0] || (agent !== undefined && agent.length === 0)) return null;
    return { command, id: args[0], agent };
  }
  if (command === 'input') {
    if (agent !== undefined || args.length < 2 || !args[0]) return null;
    const text = args.slice(1).join(' ');
    if (!text) return null;
    return { command, id: args[0], text };
  }
  if (command === 'cancel') {
    if (agent !== undefined || args.length !== 1 || !args[0]) return null;
    return { command, id: args[0] };
  }
  if (command === 'follow') {
    if (agent !== undefined || parsed.values.json !== undefined || args.length !== 1 || !args[0]) return null;
    return { command, id: args[0] };
  }
  return null;
}

function parseBaseUrl(raw) {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:')
      || !url.hostname
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function headers() {
  const result = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

const REMOTE_LOOKUP_TIMEOUT_MS = 3000;
// 모든 요청에 기본 시한을 건다. 헤더만 보내고 본문을 끝내지 않는 서버에서는
// `response.json()` 이 영원히 대기해 "2xx 는 성공" 계약이 무의미해진다.
// AbortSignal 은 본문 스트림까지 끊으므로 이 한 줄이 그 경로를 막는다.
// 단발 명령은 오래 살 이유가 없다.
const DEFAULT_TIMEOUT_MS = 30000;

async function request(baseUrl, pathname, { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const options = { method, headers: headers(), redirect: 'manual' };
  if (body !== undefined) options.body = JSON.stringify(body);
  if (timeoutMs) options.signal = AbortSignal.timeout(timeoutMs);
  return fetch(`${baseUrl}${pathname}`, options);
}

function exitCodeForStatus(status) {
  if (status === 401) return 2;
  if (status === 404) return 3;
  if (status >= 400 && status < 500) return 4;
  return 5;
}

function reportHttpError(status, kind = status >= 500 ? 'server_error' : 'request_rejected') {
  if (jsonMode) {
    writeJson({ type: 'error', kind, status });
  } else {
    process.stderr.write(`palantir: server returned HTTP ${status}\n`);
  }
}

function reportTransportError() {
  if (jsonMode) {
    writeJson({ type: 'error', kind: 'transport_error' });
  } else {
    process.stderr.write('palantir: could not reach the server\n');
  }
}

function reportInvalidResponse() {
  if (jsonMode) {
    writeJson({ type: 'error', kind: 'invalid_server_response' });
  } else {
    process.stderr.write('palantir: server returned an invalid response\n');
  }
}

async function parseResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function isRemoteRun(baseUrl, runId) {
  try {
    // 이 조회는 **진단 보강용 best-effort** 다. 이미 확정된 502 와 코드 5 를
    // 보조 요청이 무한정 가로막으면 안 되므로 반드시 시한을 건다 —
    // 응답을 끝내지 않는 서버에서 오류 메시지가 영영 안 나오던 경로를 막는다.
    const response = await request(baseUrl, `/api/runs/${encodeURIComponent(runId)}`, {
      timeoutMs: REMOTE_LOOKUP_TIMEOUT_MS,
    });
    if (!response.ok) return false;
    const payload = await parseResponse(response);
    const nodeId = payload?.run?.node_id;
    return typeof nodeId === 'string' && nodeId.length > 0 && nodeId !== 'local';
  } catch {
    return false;
  }
}

const FOLLOW_POLL_MS = 1000;
const FOLLOW_DRAIN_MS = 5000;
const FOLLOW_RETRY_BUDGET_MS = 30000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'stopped']);

function warnFollow(message) {
  process.stderr.write(`palantir: ${message}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkpointPaths(runId) {
  const safeId = encodeURIComponent(runId);
  const dir = path.join(os.homedir(), '.palantir', 'follow');
  return { dir, file: path.join(dir, `${safeId}.json`) };
}

async function prepareCheckpoint(runId) {
  const paths = checkpointPaths(runId);
  try {
    await fs.mkdir(paths.dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(paths.dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe checkpoint directory');
    if ((stat.mode & 0o077) !== 0) await fs.chmod(paths.dir, 0o700);
    return { ...paths, enabled: true };
  } catch (error) {
    warnFollow(`checkpoint disabled (${error?.code || error?.message || 'unknown error'})`);
    return { ...paths, enabled: false };
  }
}

async function readCheckpoint(state, runId) {
  if (!state.enabled) return null;
  let handle;
  try {
    handle = await fs.open(state.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a regular file');
    const raw = await handle.readFile({ encoding: 'utf8' });
    const value = JSON.parse(raw);
    if (value?.v !== 1 || value.run_id !== runId || typeof value.source_id !== 'string'
      || !['text', 'claude_ndjson'].includes(value.format)
      || !Number.isSafeInteger(value.committed_offset) || value.committed_offset < 0) {
      throw new Error('invalid checkpoint');
    }
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') warnFollow(`checkpoint ignored (${error?.code || error?.message || 'invalid'})`);
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function saveCheckpoint(state, value) {
  if (!state.enabled) return;
  let handle;
  let opened = false;
  let tmp;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      tmp = `${state.file}.tmp.${randomBytes(6).toString('hex')}`;
      try {
        handle = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        opened = true;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 1) throw error;
      }
    }
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, state.file);
  } catch (error) {
    warnFollow(`checkpoint update failed (${error?.code || 'unknown'})`);
    await handle?.close().catch(() => {});
    if (opened) await fs.unlink(tmp).catch(() => {});
  }
}

function renderClaudeLine(line) {
  try {
    const value = JSON.parse(line);
    if (typeof value?.result === 'string') return value.result;
    if (typeof value?.delta?.text === 'string') return value.delta.text;
    if (typeof value?.event?.delta?.text === 'string') return value.event.delta.text;
    const content = value?.message?.content ?? value?.content;
    if (Array.isArray(content)) {
      const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text).join('');
      if (text) return text;
    }
    return line;
  } catch {
    return line;
  }
}

function isCompleteJson(line) {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

const DEADLINE_EXCEEDED = Symbol('follow deadline exceeded');

async function withinDeadline(promise, deadline) {
  if (deadline === null) return promise;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return DEADLINE_EXCEEDED;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, remaining, DEADLINE_EXCEEDED); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function delayWithin(ms, deadline) {
  if (deadline === null) {
    await delay(ms);
    return undefined;
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) return DEADLINE_EXCEEDED;
  await delay(Math.min(ms, remaining));
  return Date.now() >= deadline ? DEADLINE_EXCEEDED : undefined;
}

function writeFollowChunk(chunk, errors) {
  return new Promise((resolve) => {
    process.stdout.write(chunk, (error) => {
      if (error) errors.push(error);
      resolve(error);
    });
  });
}

async function finishFollowOutput(errors, deadline) {
  return withinDeadline(new Promise((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      followErrorCollector = null;
      resolve();
    };
    followErrorCollector = (error) => {
      errors.push(error);
      close();
    };
    process.stdout.end((error) => {
      if (error) errors.push(error);
      close();
    });
  }), deadline);
}

async function follow(command, baseUrl) {
  const checkpointState = await prepareCheckpoint(command.id);
  let checkpoint = await readCheckpoint(checkpointState, command.id);
  let committedOffset = checkpoint?.committed_offset ?? 0;
  let fetchedOffset = committedOffset;
  let sourceId = checkpoint?.source_id ?? null;
  let format = checkpoint?.format ?? null;
  let decoder = new StringDecoder('utf8');
  let lineBuffer = '';
  let rawSinceCommit = Buffer.alloc(0);
  let stickyLoss = false;
  let sealed = false;
  let drainDeadline = null;
  let retryStarted = null;
  let retryDelay = 250;
  const outputErrors = [];
  let drainWarningShown = false;
  followErrorCollector = (error) => outputErrors.push(error);

  const resetAtZero = () => {
    committedOffset = 0;
    fetchedOffset = 0;
    decoder = new StringDecoder('utf8');
    lineBuffer = '';
    rawSinceCommit = Buffer.alloc(0);
  };

  const commitOutput = async (text, boundary) => {
    const error = await withinDeadline(writeFollowChunk(text, outputErrors), drainDeadline);
    if (error === DEADLINE_EXCEEDED) return DEADLINE_EXCEEDED;
    if (error) return false;
    committedOffset = boundary;
    if (sourceId !== null) {
      const saved = await withinDeadline(saveCheckpoint(checkpointState, {
        v: 1, run_id: command.id, source_id: sourceId, format, committed_offset: committedOffset,
      }), drainDeadline);
      if (saved === DEADLINE_EXCEEDED) return DEADLINE_EXCEEDED;
    }
    return true;
  };

  const markDrainExceeded = () => {
    if (!drainWarningShown) warnFollow('output drain deadline exceeded before finalization');
    drainWarningShown = true;
    stickyLoss = true;
    process.stdout.destroy();
  };

  let exitCode = 5;
  while (true) {
    if (outputErrors.length) break;
    if (drainDeadline !== null && Date.now() >= drainDeadline) {
      markDrainExceeded();
      break;
    }

    let response;
    try {
      const remaining = drainDeadline === null ? DEFAULT_TIMEOUT_MS : Math.max(1, drainDeadline - Date.now());
      response = await request(baseUrl,
        `/api/runs/${encodeURIComponent(command.id)}/output?after=${fetchedOffset}`,
        { timeoutMs: remaining });
    } catch {
      const now = Date.now();
      retryStarted ??= now;
      if (now - retryStarted >= FOLLOW_RETRY_BUDGET_MS) {
        reportTransportError();
        break;
      }
      const waited = await delayWithin(
        Math.min(retryDelay, FOLLOW_RETRY_BUDGET_MS - (now - retryStarted)), drainDeadline,
      );
      if (waited === DEADLINE_EXCEEDED) { markDrainExceeded(); break; }
      retryDelay = Math.min(retryDelay * 2, 5000);
      continue;
    }

    if (response.status >= 500) {
      const now = Date.now();
      retryStarted ??= now;
      if (now - retryStarted >= FOLLOW_RETRY_BUDGET_MS) {
        reportHttpError(response.status);
        break;
      }
      const waited = await delayWithin(
        Math.min(retryDelay, FOLLOW_RETRY_BUDGET_MS - (now - retryStarted)), drainDeadline,
      );
      if (waited === DEADLINE_EXCEEDED) { markDrainExceeded(); break; }
      retryDelay = Math.min(retryDelay * 2, 5000);
      continue;
    }
    retryStarted = null;
    retryDelay = 250;

    if (!response.ok) {
      if (response.status === 410) {
        if (!sealed) {
          warnFollow('output expired; some output may be unavailable');
          stickyLoss = true;
        }
        exitCode = stickyLoss ? 5 : 0;
      } else {
        const errorPayload = response.status === 409 ? await parseResponse(response) : null;
        if (response.status === 409 && errorPayload?.reason === 'incremental_unsupported') {
          warnFollow('incremental_unsupported: 이 run 은 follow 할 수 없다 (원격 run 만 지원)');
        } else reportHttpError(response.status);
        exitCode = exitCodeForStatus(response.status);
      }
      break;
    }

    const payload = await parseResponse(response);
    if (!payload || typeof payload.data_base64 !== 'string'
      || !Number.isSafeInteger(payload.next_offset) || payload.next_offset < fetchedOffset
      || typeof payload.has_more !== 'boolean' || typeof payload.finalized !== 'boolean'
      || !['text', 'claude_ndjson'].includes(payload.format)
      || (payload.source_id !== null && typeof payload.source_id !== 'string')) {
      reportInvalidResponse();
      break;
    }

    // §3.0.12 D6 / §3.0.13 E5: a null source_id means the log does not exist
    // yet, so the response must make no progress. Consuming bytes we cannot
    // attribute to a generation would write output to stdout that no checkpoint
    // can ever describe.
    if (payload.source_id === null
      && (payload.next_offset !== fetchedOffset || payload.data_base64 !== '' || payload.finalized)) {
      reportInvalidResponse();
      break;
    }

    // §3.1: has_more must make progress. Without this the client re-requests the
    // same offset forever -- a server that always answers "more, but none yet"
    // would hang follow with no output and no exit. This is independent of the
    // null-source guard below: either can produce a stalled cursor.
    if (payload.has_more && payload.next_offset === fetchedOffset) {
      reportInvalidResponse();
      break;
    }

    // A sealed response must carry the terminal status it sealed at (§3.0.4);
    // finalized + a live run_status is a contradiction, not something to act on.
    if (payload.finalized && !['completed', 'failed', 'cancelled', 'stopped'].includes(payload.run_status)) {
      reportInvalidResponse();
      break;
    }

    if (checkpoint && format !== payload.format) {
      warnFollow('checkpoint format changed; restarting from offset 0');
      checkpoint = null;
      format = payload.format;
      sourceId = payload.source_id;
      resetAtZero();
      continue;
    }
    if (payload.source_id !== null && sourceId !== null && sourceId !== payload.source_id) {
      warnFollow('output source changed; restarting from offset 0');
      stickyLoss = true;
      sourceId = payload.source_id;
      format = payload.format;
      checkpoint = null;
      resetAtZero();
      continue;
    }
    if (payload.source_id !== null) sourceId = payload.source_id;
    format = payload.format;
    checkpoint = null;

    if (payload.truncated) {
      warnFollow('output was truncated; restarting from offset 0');
      stickyLoss = true;
      resetAtZero();
      continue;
    }

    if (TERMINAL_STATUSES.has(payload.run_status) && drainDeadline === null && !sealed) {
      drainDeadline = Date.now() + FOLLOW_DRAIN_MS;
    }
    if (payload.finalized) {
      sealed = true;
      drainDeadline = null;
    }

    const bytes = Buffer.from(payload.data_base64, 'base64');
    rawSinceCommit = Buffer.concat([rawSinceCommit, bytes]);
    lineBuffer += decoder.write(bytes);
    fetchedOffset = payload.next_offset;

    let newline;
    while ((newline = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, newline);
      lineBuffer = lineBuffer.slice(newline + 1);
      const rawNewline = rawSinceCommit.indexOf(0x0a);
      const boundary = committedOffset + rawNewline + 1;
      rawSinceCommit = rawSinceCommit.subarray(rawNewline + 1);
      const rendered = format === 'claude_ndjson' ? renderClaudeLine(line) : line;
      const committed = await commitOutput(`${rendered}\n`, boundary);
      if (committed === DEADLINE_EXCEEDED) { markDrainExceeded(); break; }
      if (!committed) break;
    }
    if (outputErrors.length) break;

    if (payload.finalized && !payload.has_more) {
      lineBuffer += decoder.end();
      if (lineBuffer || rawSinceCommit.length) {
        const completeJson = format !== 'claude_ndjson' || isCompleteJson(lineBuffer);
        const rendered = format === 'claude_ndjson' && completeJson ? renderClaudeLine(lineBuffer) : lineBuffer;
        if (format === 'claude_ndjson' && !completeJson) {
          warnFollow('incomplete claude_ndjson JSON at finalized EOF; emitting raw tail');
        }
        if (!await commitOutput(rendered, fetchedOffset)) break;
        lineBuffer = '';
        rawSinceCommit = Buffer.alloc(0);
      }
      exitCode = stickyLoss ? 5 : (payload.run_status === 'completed' ? 0 : 6);
      break;
    }
    if (!payload.has_more) {
      const waited = await delayWithin(FOLLOW_POLL_MS, drainDeadline);
      if (waited === DEADLINE_EXCEEDED) { markDrainExceeded(); break; }
    }
  }

  const finished = await finishFollowOutput(outputErrors, drainDeadline);
  if (finished === DEADLINE_EXCEEDED) markDrainExceeded();
  if (interrupted) return 130;
  const epipe = outputErrors.some((error) => error?.code === 'EPIPE');
  if (epipe) return 0;
  if (outputErrors.length) return 5;
  return stickyLoss ? 5 : exitCode;
}

async function execute(command, baseUrl) {
  if (command.command === 'follow') return follow(command, baseUrl);
  const id = encodeURIComponent(command.id);
  let pathname;
  let body;

  if (command.command === 'spawn') {
    pathname = `/api/tasks/${id}/execute`;
    body = command.agent === undefined ? {} : { agent_profile_id: command.agent };
  } else if (command.command === 'input') {
    pathname = `/api/runs/${id}/input`;
    body = { text: command.text };
  } else {
    pathname = `/api/runs/${id}/cancel`;
    body = {};
  }

  let response;
  try {
    response = await request(baseUrl, pathname, { method: 'POST', body });
  } catch {
    reportTransportError();
    return 5;
  }

  if (!response.ok) {
    if (command.command === 'input' && response.status === 502 && await isRemoteRun(baseUrl, command.id)) {
      if (jsonMode) {
        writeJson({ type: 'error', kind: 'remote_input_unsupported' });
      } else {
        reportHttpError(502);
        process.stderr.write('이 노드는 대화형 입력을 지원하지 않는다\n');
      }
      return 5;
    }
    reportHttpError(response.status);
    return exitCodeForStatus(response.status);
  }

  // 2xx 는 성공이다. 본문은 **기회적으로만** 읽는다 — 정본에 성공 응답 스키마가
  // 없으므로 CLI 가 발명하면 안 된다. 실제로 `POST /tasks/:id/execute` 는
  // lifecycle 미설정 시 200 + {status:'not_implemented'} 를 주고(routes/tasks.js:208),
  // 204/빈 본문도 합법적인 성공이다. 이들을 코드 5 로 뒤집던 것을 고친다.
  const payload = await parseResponse(response);

  if (command.command === 'spawn') {
    const runId = payload?.run?.id;
    if (typeof runId === 'string' && runId) {
      if (jsonMode) writeJson({ run_id: runId });
      else process.stdout.write(`${singleLine(redact(runId))}\n`);
      return 0;
    }
    // run 이 안 떴지만 서버는 성공이라고 답했다. 그 사실을 그대로 전달한다.
    const status = typeof payload?.status === 'string' ? payload.status : 'ok';
    if (jsonMode) writeJson({ status });
    else process.stdout.write(`${singleLine(redact(status))}\n`);
    return 0;
  }

  const status = typeof payload?.status === 'string' && payload.status ? payload.status : 'ok';
  if (jsonMode) writeJson({ status });
  else process.stdout.write(`${singleLine(redact(status))}\n`);
  return 0;
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  process.exitCode = showHelp();
} else {
const command = parseCli(rawArgs);
if (!command) {
  process.exitCode = usageError();
} else {
  const baseUrl = parseBaseUrl(process.env.PALANTIR_BASE_URL || DEFAULT_BASE_URL);
  if (!baseUrl) {
    process.exitCode = usageError();
  } else {
    process.exitCode = await execute(command, baseUrl);
  }
}
}
