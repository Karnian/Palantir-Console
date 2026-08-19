'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const CLI_PATH = path.resolve(__dirname, '../../bin/palantir.mjs');
const SECRET = 'cli-test-secret-never-print';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  const baseUrl = await listen(server);
  try {
    return await fn(baseUrl, server);
  } finally {
    await close(server);
  }
}

function runCli(args, { baseUrl, token = SECRET, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const argv = [CLI_PATH, ...args];
    const child = spawn(process.execPath, argv, {
      env: {
        ...process.env,
        PALANTIR_BASE_URL: baseUrl,
        PALANTIR_TOKEN: token,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, argv, child }));
  });
}

function outputPage(textOrBuffer, options = {}) {
  const bytes = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(textOrBuffer);
  return {
    data_base64: bytes.toString('base64'),
    next_offset: options.next_offset,
    end_offset: options.end_offset ?? options.next_offset,
    has_more: options.has_more ?? false,
    truncated: options.truncated ?? false,
    finalized: options.finalized ?? false,
    run_status: options.run_status ?? 'running',
    source_id: options.source_id ?? '2049:1234',
    format: options.format ?? 'text',
  };
}

function followHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-follow-home-'));
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return {
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization,
    contentType: req.headers['content-type'],
    body: raw ? JSON.parse(raw) : null,
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('spawn happy path maps argv to the execute request and prints only the run id', async () => {
  let request;
  await withServer(async (req, res) => {
    request = await readRequest(req);
    json(res, 201, { run: { id: 'run-spawned', status: 'running' } });
  }, async (baseUrl) => {
    const result = await runCli(['spawn', 'task/a', '--agent', 'profile-1'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, 'run-spawned\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(request, {
      method: 'POST',
      url: '/api/tasks/task%2Fa/execute',
      authorization: `Bearer ${SECRET}`,
      contentType: 'application/json',
      body: { agent_profile_id: 'profile-1' },
    });
    assert.equal(result.argv.includes(SECRET), false);
    assert.equal(result.stdout.includes(SECRET), false);
    assert.equal(result.stderr.includes(SECRET), false);
  });
});

test('spawn accepts an omitted optional agent and sends an empty request object', async () => {
  let request;
  await withServer(async (req, res) => {
    request = await readRequest(req);
    json(res, 201, { run: { id: 'run-default-agent' } });
  }, async (baseUrl) => {
    const result = await runCli(['spawn', 'task-1'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'run-default-agent\n');
    assert.deepEqual(request.body, {});
  });
});

test('input happy path joins text argv and sends it once', async () => {
  let request;
  await withServer(async (req, res) => {
    request = await readRequest(req);
    json(res, 200, { status: 'ok' });
  }, async (baseUrl) => {
    const result = await runCli(['input', 'run 1', 'hello', 'from', 'cli'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(request, {
      method: 'POST',
      url: '/api/runs/run%201/input',
      authorization: `Bearer ${SECRET}`,
      contentType: 'application/json',
      body: { text: 'hello from cli' },
    });
  });
});

test('cancel happy path sends the cancel request once', async () => {
  let request;
  await withServer(async (req, res) => {
    request = await readRequest(req);
    json(res, 200, { status: 'ok' });
  }, async (baseUrl) => {
    const result = await runCli(['cancel', 'run/cancel'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ok\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(request, {
      method: 'POST',
      url: '/api/runs/run%2Fcancel/cancel',
      authorization: `Bearer ${SECRET}`,
      contentType: 'application/json',
      body: {},
    });
  });
});

test('single-shot HTTP failures map every contracted exit code and keep diagnostics off stdout', async (t) => {
  for (const [status, expectedCode] of [[401, 2], [403, 4], [404, 3], [400, 4], [500, 5], [503, 5]]) {
    await t.test(`${status} -> ${expectedCode}`, async () => {
      let requestCount = 0;
      await withServer((_req, res) => {
        requestCount += 1;
        json(res, status, { error: `failure-${status}` });
      }, async (baseUrl) => {
        const result = await runCli(['cancel', 'run-1'], { baseUrl });
        assert.equal(result.code, expectedCode);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, new RegExp(`HTTP ${status}`));
        assert.equal(result.stderr.includes(SECRET), false);
        assert.equal(requestCount, 1, 'single-shot commands must not retry');
      });
    });
  }
});

test('connection failure maps to exit code 5 without leaking the token', async () => {
  await withServer((req) => req.socket.destroy(), async (baseUrl) => {
    const result = await runCli(['cancel', 'run-1'], { baseUrl });
    assert.equal(result.code, 5);
    assert.equal(result.stdout, '');
    assert.notEqual(result.stderr, '');
    assert.equal(result.stderr.includes(SECRET), false);
  });
});

test('a base URL containing a path is rejected before any connection attempt', async () => {
  const result = await runCli(['cancel', 'run-1'], {
    baseUrl: 'http://127.0.0.1:1/nested',
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.notEqual(result.stderr, '');
});

test('--json emits exactly one parseable result line on stdout', async () => {
  await withServer((_req, res) => json(res, 201, { run: { id: 'run-json' } }), async (baseUrl) => {
    const result = await runCli(['--json', 'spawn', 'task-1', '--agent', 'profile-1'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), { run_id: 'run-json' });
  });
});

test('input 502 on a remote run reports remote_input_unsupported and exits 5', async () => {
  const requests = [];
  await withServer(async (req, res) => {
    requests.push(await readRequest(req));
    if (req.method === 'POST') return json(res, 502, { error: 'delivery failed' });
    return json(res, 200, { run: { id: 'remote-run', node_id: 'pod-7' } });
  }, async (baseUrl) => {
    const result = await runCli(['--json', 'input', 'remote-run', 'hello'], { baseUrl });
    assert.equal(result.code, 5);
    assert.equal(result.stderr, '');
    assert.deepEqual(result.stdout.trimEnd().split('\n').map(JSON.parse), [
      { type: 'error', kind: 'remote_input_unsupported' },
    ]);
    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
      { method: 'POST', url: '/api/runs/remote-run/input' },
      { method: 'GET', url: '/api/runs/remote-run' },
    ]);
  });
});

test('input 502 on a remote run adds the human-readable limitation only to stderr', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    if (req.method === 'POST') return json(res, 502, { error: 'delivery failed' });
    return json(res, 200, { run: { id: 'remote-run', node_id: 'pod-7' } });
  }, async (baseUrl) => {
    const result = await runCli(['input', 'remote-run', 'hello'], { baseUrl });
    assert.equal(result.code, 5);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 502/);
    assert.match(result.stderr, /이 노드는 대화형 입력을 지원하지 않는다/);
  });
});

test('input 502 on a local run remains a general server error and exits 5', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    if (req.method === 'POST') return json(res, 502, { error: 'delivery failed' });
    return json(res, 200, { run: { id: 'local-run', node_id: 'local' } });
  }, async (baseUrl) => {
    const result = await runCli(['--json', 'input', 'local-run', 'hello'], { baseUrl });
    assert.equal(result.code, 5);
    assert.equal(result.stderr, '');
    const errors = result.stdout.trimEnd().split('\n').map(JSON.parse);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].type, 'error');
    assert.equal(errors[0].kind, 'server_error');
    assert.equal(errors[0].status, 502);
  });
});

test('input 502 does not guess remote support when run lookup fails', async () => {
  await withServer(async (req, res) => {
    await readRequest(req);
    if (req.method === 'POST') return json(res, 502, { error: 'delivery failed' });
    return json(res, 500, { error: 'lookup failed' });
  }, async (baseUrl) => {
    const result = await runCli(['input', 'unknown-run', 'hello'], { baseUrl });
    assert.equal(result.code, 5);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 502/);
    assert.doesNotMatch(result.stderr, /대화형 입력/);
  });
});

test('SIGINT exits with code 130', async () => {
  let markRequestSeen;
  const requestSeen = new Promise((resolve) => { markRequestSeen = resolve; });
  await withServer((_req, _res) => markRequestSeen(), async (baseUrl) => {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, 'cancel', 'run-hangs'], {
        env: { ...process.env, PALANTIR_BASE_URL: baseUrl, PALANTIR_TOKEN: SECRET },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timeout;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('spawn', () => {
        timeout = setTimeout(() => {
          child.kill();
          reject(new Error('CLI did not reach the mock server before SIGINT test timeout'));
        }, 5_000);
        requestSeen.then(() => {
          clearTimeout(timeout);
          child.kill('SIGINT');
        });
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal, stdout, stderr });
      });
    });
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(SECRET), false);
  });
});

test('EPIPE exits successfully without a stack trace', async () => {
  let child;
  await withServer((req, res) => {
    req.resume();
    child.stdout.destroy();
    json(res, 201, { run: { id: 'r'.repeat(2 * 1024 * 1024) } });
  }, async (baseUrl) => {
    const result = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, [CLI_PATH, 'spawn', 'task-1'], {
        env: { ...process.env, PALANTIR_BASE_URL: baseUrl, PALANTIR_TOKEN: SECRET },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stderr }));
    });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
  });
});

// codex 리뷰 R1: 아래 넷은 "구현이 우연히 맞다"가 아니라 계약을 실제로 증명한다.

test('packaging: bin 필드가 실행 가능한 shebang 파일을 가리키고 런타임 의존이 0 이다', async () => {
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  assert.equal(pkg.bin?.palantir, 'bin/palantir.mjs', 'bin 필드가 계약대로여야 설치된 `palantir` 가 존재한다');
  const source = fs.readFileSync(CLI_PATH, 'utf8');
  assert.match(source.split('\n')[0], /^#!/, 'shebang 이 없으면 설치 후 직접 실행이 깨진다');
  assert.ok(fs.statSync(CLI_PATH).mode & 0o111, '실행 권한이 있어야 한다');
  // 런타임 의존 0 은 **행동으로** 증명한다. 소스 정규식은 형태를 늘려가며
  // 계속 새는 군비경쟁이다(import('p',{with:…}), from /*c*/ 'p', …).
  // node_modules 가 조상 경로 어디에도 없는 임시 디렉터리에 복사해 실행하면,
  // 외부 모듈을 import 하는 순간 형태와 무관하게 ERR_MODULE_NOT_FOUND 로 죽는다.
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-cli-isolated-'));
  try {
    // 격리가 조용히 무력화되지 않게 조상 체인을 실제로 확인한다.
    // `/tmp/node_modules` 가 존재하면 외부 패키지가 해석돼 이 테스트가 무의미해진다.
    // 문자열 경로와 **실경로** 양쪽의 조상을 본다. macOS 의 /tmp -> /private/tmp
    // 처럼 심볼릭 링크가 끼면 Node 는 실경로 기준으로 해석하므로, 문자열 조상만
    // 검사하면 /private/tmp/node_modules 를 놓친다.
    for (const root of new Set([isolated, fs.realpathSync(isolated)])) {
      for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
        assert.equal(
          fs.existsSync(path.join(dir, 'node_modules')), false,
          `격리 실패: ${dir}/node_modules 가 존재해 외부 모듈이 해석될 수 있다`,
        );
        if (path.dirname(dir) === dir) break;
      }
    }
    const copied = path.join(isolated, 'palantir.mjs');
    fs.copyFileSync(CLI_PATH, copied);
    // `--help` 만 보면 서브커맨드 안의 지연 import() 를 놓친다. 세 동사를 모두 태운다.
    // 서버가 없어 전송은 실패하지만(코드 5) 우리가 보는 것은 **모듈 해석**뿐이다.
    const invocations = [
      { args: ['--help'], expectCode: 0 },
      // 접속 불가 주소이므로 전송 오류 = 코드 5 가 **정확한** 기대값이다.
      // null 로 두면 구문 오류나 인자 처리 오류로 지연 import() 전에 죽어도
      // 통과해, "세 동사를 모두 태웠다"가 증명되지 않는다.
      { args: ['spawn', 't1'], expectCode: 5 },
      { args: ['input', 'r1', 'hi'], expectCode: 5 },
      { args: ['cancel', 'r1'], expectCode: 5 },
    ];
    for (const { args, expectCode } of invocations) {
      const probe = await new Promise((resolve) => {
        const child = spawn(process.execPath, [copied, ...args], {
          cwd: isolated,
          env: { PATH: process.env.PATH, PALANTIR_BASE_URL: 'http://127.0.0.1:1' },
        });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (code) => resolve({ code, stderr }));
      });
      assert.equal(
        /ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(probe.stderr), false,
        `CLI 는 Node 내장만 쓴다 — \`${args.join(' ')}\` 격리 실행에서 모듈 해석 실패: ${probe.stderr.slice(0, 300)}`,
      );
      assert.equal(probe.code, expectCode,
        `\`${args.join(' ')}\` 가 모듈 해석 외의 이유로 실패하면 이 테스트가 무의미해진다: ${probe.stderr.slice(0, 300)}`);
    }
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
    assert.equal(pkg.engines?.node, '^22', 'engines 가 바뀌면 fetch/parseArgs 전제가 깨진다');
});

test('--token 같은 비밀 인자를 받지 않는다 (거절 + 출력에 비밀 없음)', async () => {
  await withServer((req, res) => json(res, 200, { status: 'ok' }), async (baseUrl) => {
    const result = await runCli(['cancel', 'run_x', '--token', 'SECRET-IN-ARGV'], { baseUrl });
    assert.equal(result.code, 1, '알 수 없는 옵션은 사용법 오류 — argv 로 토큰을 받는 경로 자체가 없어야 한다');
    assert.equal(result.stdout.includes('SECRET-IN-ARGV'), false);
    assert.equal(result.stderr.includes('SECRET-IN-ARGV'), false);
  });
});

test('2xx 는 성공이다 — 빈 본문·다른 스키마를 코드 5 로 뒤집지 않는다', async () => {
  // 실제 서버는 lifecycle 미설정 시 200 + {status:"not_implemented"} 를 준다(routes/tasks.js:208).
  await withServer((req, res) => json(res, 200, { status: 'not_implemented' }), async (baseUrl) => {
    const result = await runCli(['spawn', 'task_1'], { baseUrl });
    assert.equal(result.code, 0, '서버가 성공이라 했는데 CLI 가 실패로 뒤집으면 안 된다');
    assert.match(result.stdout, /not_implemented/);
  });
  await withServer((req, res) => { res.writeHead(204); res.end(); }, async (baseUrl) => {
    const result = await runCli(['cancel', 'run_x'], { baseUrl });
    assert.equal(result.code, 0, '204 No Content 도 합법적인 성공이다');
  });
});

test('human 모드 출력은 서버 문자열의 제어문자로 오염되지 않는다', async () => {
  const poisoned = 'ok\ninjected-line' + String.fromCharCode(27) + '[31m';
  await withServer((req, res) => json(res, 200, { status: poisoned }), async (baseUrl) => {
    const result = await runCli(['cancel', 'run_x'], { baseUrl });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trimEnd().split('\n').length, 1, '결과는 한 줄이어야 한다');
    assert.equal(result.stdout.includes(String.fromCharCode(27)), false, 'ANSI escape 가 그대로 나가면 안 된다');
  });
});

test('--help 는 의도한 성공이다 — stdout + 코드 0, 사용법 오류(1)와 구분된다', async () => {
  const help = await runCli(['--help'], { baseUrl: 'http://127.0.0.1:1' });
  assert.equal(help.code, 0, '`palantir --help` 로 설치 여부를 확인하는 스크립트가 실패로 읽으면 안 된다');
  assert.match(help.stdout, /Usage: palantir/);
  assert.equal(help.stderr, '', '요청된 출력이므로 stderr 가 아니다');

  const bogus = await runCli(['bogus-command'], { baseUrl: 'http://127.0.0.1:1' });
  assert.equal(bogus.code, 1);
  assert.equal(bogus.stdout, '', '오류 사용법은 stdout 을 오염시키지 않는다');
  assert.match(bogus.stderr, /Usage: palantir/);
});

test('follow streams multiple pages byte-exactly and exits 0 when completed and finalized', async () => {
  const home = followHome();
  const seen = [];
  try {
    await withServer((req, res) => {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after'));
      seen.push(after);
      if (after === 0) return json(res, 200, outputPage('alpha\n', { next_offset: 6, has_more: true }));
      json(res, 200, outputPage('beta\n', { next_offset: 11, finalized: true, run_status: 'completed' }));
    }, async (baseUrl) => {
      const result = await runCli(['follow', 'r-normal'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'alpha\nbeta\n');
      assert.equal(result.stderr, '');
      assert.deepEqual(seen, [0, 6]);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow maps a failed finalized run to code 6', async () => {
  const home = followHome();
  try {
    await withServer((_req, res) => json(res, 200, outputPage('', {
      next_offset: 0, finalized: true, run_status: 'failed',
    })), async (baseUrl) => {
      const result = await runCli(['follow', 'r-failed'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 6);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow truncation warning is stderr-only and loss code 5 remains sticky', async () => {
  const home = followHome();
  let count = 0;
  try {
    await withServer((_req, res) => {
      count += 1;
      if (count === 1) return json(res, 200, outputPage('', { next_offset: 0, truncated: true }));
      json(res, 200, outputPage('kept\n', { next_offset: 5, finalized: true, run_status: 'completed' }));
    }, async (baseUrl) => {
      const result = await runCli(['follow', 'r-truncated'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 5);
      assert.equal(result.stdout, 'kept\n');
      assert.match(result.stderr, /truncated/);
      assert.doesNotMatch(result.stdout, /truncated/);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow maps 409 to 4 and output-expired 410 to 5', async (t) => {
  for (const [status, code] of [[409, 4], [410, 5]]) {
    await t.test(String(status), async () => {
      const home = followHome();
      try {
        await withServer((_req, res) => json(res, status, { reason: status === 409 ? 'incremental_unsupported' : 'output_expired' }), async (baseUrl) => {
          const result = await runCli(['follow', `r-${status}`], { baseUrl, env: { HOME: home } });
          assert.equal(result.code, code);
          assert.equal(result.stdout, '');
        });
      } finally { fs.rmSync(home, { recursive: true, force: true }); }
    });
  }
});

test('follow preserves a Korean UTF-8 character split across response boundaries', async () => {
  const home = followHome();
  const bytes = Buffer.from('한글\n');
  try {
    await withServer((req, res) => {
      const after = Number(new URL(req.url, 'http://x').searchParams.get('after'));
      if (after === 0) return json(res, 200, outputPage(bytes.subarray(0, 2), { next_offset: 2, has_more: true }));
      json(res, 200, outputPage(bytes.subarray(2), { next_offset: bytes.length, finalized: true, run_status: 'completed' }));
    }, async (baseUrl) => {
      const result = await runCli(['follow', 'r-utf8'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, '한글\n');
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow resumes at a valid checkpoint offset', async () => {
  const home = followHome();
  const dir = path.join(home, '.palantir', 'follow');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'r-resume.json'), JSON.stringify({
    v: 1, run_id: 'r-resume', source_id: '2049:1234', format: 'text', committed_offset: 7,
  }), { mode: 0o600 });
  let seen;
  try {
    await withServer((req, res) => {
      seen = Number(new URL(req.url, 'http://x').searchParams.get('after'));
      json(res, 200, outputPage('tail\n', { next_offset: 12, finalized: true, run_status: 'completed' }));
    }, async (baseUrl) => {
      const result = await runCli(['follow', 'r-resume'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 0);
      assert.equal(seen, 7);
      assert.equal(result.stdout, 'tail\n');
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow missing checkpoint is normal and does not affect exit code', async () => {
  const home = followHome();
  try {
    await withServer((_req, res) => json(res, 200, outputPage('', {
      next_offset: 0, finalized: true, run_status: 'completed',
    })), async (baseUrl) => {
      const result = await runCli(['follow', 'r-first'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow renders Claude NDJSON and passes malformed lines through verbatim', async () => {
  const home = followHome();
  const input = '{"type":"result","result":"answer"}\nnot-json\n';
  try {
    await withServer((_req, res) => json(res, 200, outputPage(input, {
      next_offset: Buffer.byteLength(input), finalized: true, run_status: 'completed', format: 'claude_ndjson',
    })), async (baseUrl) => {
      const result = await runCli(['follow', 'r-claude'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 0);
      assert.equal(result.stdout, 'answer\nnot-json\n');
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('follow terminal status without finalization hits the drain deadline and exits 5', { timeout: 10_000 }, async () => {
  const home = followHome();
  try {
    await withServer((_req, res) => json(res, 200, outputPage('', {
      next_offset: 0, run_status: 'completed', finalized: false,
    })), async (baseUrl) => {
      const result = await runCli(['follow', 'r-drain'], { baseUrl, env: { HOME: home } });
      assert.equal(result.code, 5);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /drain deadline/);
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
