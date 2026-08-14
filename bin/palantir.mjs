#!/usr/bin/env node

import { parseArgs } from 'node:util';

const DEFAULT_BASE_URL = 'http://127.0.0.1:4177';
const token = process.env.PALANTIR_TOKEN || '';
let jsonMode = process.argv.slice(2).includes('--json');
let interrupted = false;

process.once('SIGINT', () => {
  interrupted = true;
  process.exit(130);
});

function handleBrokenPipe(error) {
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
  + '       palantir cancel <run_id> [--json]\n';

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

async function execute(command, baseUrl) {
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
