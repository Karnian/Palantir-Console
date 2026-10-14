import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildBundle, runExecutor, receiveEnvelope, writeSnapshotAtomic } from './lib/sessionSnapshotBundle.mjs';
const require = createRequire(import.meta.url);
const { assertSpawnAllowed, isSpawnGuardActive } = require('../server/utils/spawnGuard.js');
const policy = require('../server/services/observeSnapshotPolicy.js');
const INPUT_HINTS = Object.freeze({
  usage: '사용법: session-snapshot.mjs [remote --host <user@host>] snapshot|exclude ...',
  answer_target: 'answer 에는 --instruction <instrId#ref> 와 --file-fp <hex16> 이 필요합니다',
  out_dir_missing: 'snapshot 에는 --out-dir 또는 PALANTIR_OBSERVE_SNAPSHOT_DIR 이 필요합니다',
  host_invalid: '--host 에는 유효한 호스트 이름 또는 user@host 가 필요합니다',
  now_invalid: '--now 에는 유효한 YYYY-MM-DD 날짜 또는 ISO 날짜/시간이 필요합니다',
  label_invalid: '--label 은 영문, 숫자, 점, 밑줄, 하이픈으로 된 1~32자이며 하이픈으로 시작할 수 없습니다',
  exclude_target: 'exclude 에는 --instruction 또는 --session 중 정확히 하나가 필요합니다',
});
function invalidInput(reason = 'usage') {
  throw Object.assign(new Error('request_invalid'), { hint: INPUT_HINTS[reason] });
}
function assertPrivateOutput(outDir) {
  const publicRoot = fs.realpathSync(fileURLToPath(new URL('../server/public', import.meta.url)));
  let ancestor = path.resolve(outDir);
  const suffix = [];
  let resolved;
  while (resolved === undefined) {
    try {
      resolved = path.join(fs.realpathSync(ancestor), ...suffix);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const relative = path.relative(publicRoot, resolved);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith('..' + path.sep))) {
    throw Object.assign(new Error('out_dir_public'), { code: 'out_dir_public' });
  }
}
function parseArguments(argv, env) {
  const args = [...argv];
  const remote = args[0] === 'remote';
  if (remote) args.shift();
  const values = {};
  let operation;
  while (args.length) {
    const item = args.shift();
    if (item === 'snapshot' || item === 'exclude' || item === 'answer') {
      if (operation) invalidInput();
      operation = item;
    } else if (item === '--include-exec' || item === '--diag' || item === '--emit-envelope') {
      if (values[item]) invalidInput();
      values[item] = true;
    } else if (['--host', '--remote-node', '--now', '--out-dir', '--orca-bin',
      '--instruction', '--session', '--label', '--file-fp'].includes(item)) {
      if (Object.hasOwn(values, item) || !args.length) invalidInput();
      values[item] = args.shift();
    } else invalidInput();
  }
  if (!operation || !remote && (values['--host'] !== undefined || values['--remote-node'] !== undefined)) {
    invalidInput();
  }
  const host = values['--host'];
  if (remote && (typeof host !== 'string' || !/^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(host)
    || host.startsWith('-'))) invalidInput('host_invalid');
  const remoteNode = values['--remote-node'];
  if (remoteNode !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(remoteNode)) invalidInput();
  const sshBin = env.PALANTIR_OBSERVE_SSH_BIN || 'ssh';
  if (sshBin !== 'ssh' && !/^\/[A-Za-z0-9._/-]+$/.test(sshBin)) invalidInput();
  if (values['--now'] !== undefined && !/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(values['--now'])) invalidInput('now_invalid');
  const now = values['--now'] === undefined ? new Date() : new Date(values['--now']);
  if (!Number.isFinite(+now) || !/^\d{4}-/.test(now.toISOString())) invalidInput('now_invalid');
  const label = values['--label'];
  if (label !== undefined && (!/^[A-Za-z0-9._-]{1,32}$/.test(label) || label.startsWith('-'))) invalidInput('label_invalid');
  const request = { schema: 'palantir.snapshot-request/1', op: 'snapshot', now: now.toISOString(),
    include_exec: values['--include-exec'] === true, orca_bin: values['--orca-bin'] ?? 'orca' };
  const outDir = values['--out-dir'] || env.PALANTIR_OBSERVE_SNAPSHOT_DIR;
  if (operation !== 'answer' && ['--diag', '--emit-envelope', '--file-fp'].some(key => values[key] !== undefined)) invalidInput();
  if (operation === 'answer') {
    if (values['--emit-envelope'] && values['--diag']) invalidInput();
    if (['--session', '--out-dir', '--include-exec', '--label', '--orca-bin'].some(key => values[key] !== undefined)) invalidInput();
    const instruction = values['--instruction'];
    const separator = typeof instruction === 'string' ? instruction.lastIndexOf('#') : -1;
    const instrId = separator > 0 ? instruction.slice(0, separator) : '';
    const ref = separator > 0 ? instruction.slice(separator + 1) : '';
    if (!policy.isSafeInstructionId(instrId) || !/^[0-9a-f]{16}$/.test(ref)
      || typeof values['--file-fp'] !== 'string' || !/^[0-9a-f]{16}$/.test(values['--file-fp'])) invalidInput('answer_target');
    return { request: { schema: 'palantir.answer-request/1', op: 'answer_query', now: now.toISOString(),
      target: { kind: 'instruction', instrId, ref, file_fp: values['--file-fp'] },
      ...(values['--diag'] ? { diag: true } : {}) }, sshBin, emitEnvelope: values['--emit-envelope'] === true,
      target: remote ? { kind: 'remote', host, remoteNode } : { kind: 'local' } };
  }
  if (operation === 'snapshot') {
    if (!outDir) invalidInput('out_dir_missing');
    if (values['--instruction'] !== undefined || values['--session'] !== undefined) invalidInput();
    if (label !== undefined) request.machine_label = label;
  } else {
    if (values['--out-dir'] !== undefined || values['--include-exec'] || label !== undefined) invalidInput();
    const instruction = values['--instruction'];
    const session = values['--session'];
    if ((instruction === undefined) === (session === undefined)) invalidInput('exclude_target');
    request.op = 'exclude_query';
    if (instruction !== undefined) {
      const separator = instruction.lastIndexOf('#');
      if (separator < 1) invalidInput();
      request.target = { kind: 'instruction', instrId: instruction.slice(0, separator),
        ref: instruction.slice(separator + 1) };
    } else {
      const separator = session.indexOf(':');
      if (separator < 1) invalidInput();
      request.target = { kind: 'session', provider: session.slice(0, separator),
        sessionId: session.slice(separator + 1) };
    }
  }
  return { request, outDir, sshBin, target: remote ? { kind: 'remote', host, remoteNode } : { kind: 'local' } };
}
export function escapeTerminal(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, function escapeControl(character) {
    return '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
  });
}
async function readAnswer(stdin) {
  let line = '';
  for await (const chunk of stdin) {
    line += chunk.toString();
    const end = line.indexOf('\n');
    if (end !== -1) return line.slice(0, end).trim();
  }
  return '';
}
export async function main(argv, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  env = process.env, spawnImpl, timeoutMs = 120000 } = {}) {
  let options;
  try {
    options = parseArguments(argv, env);
    if (options.request.op === 'snapshot') assertPrivateOutput(options.outDir);
    if (isSpawnGuardActive() && options.request.op !== 'answer_query') {
      assertSpawnAllowed({ command: options.request.orca_bin, source: 'session-snapshot:orca_bin' });
    }
  } catch (error) {
    const code = error.code || 'request_invalid';
    stderr.write(code + '\n');
    if (code === 'request_invalid' && error.hint) stderr.write('hint: ' + error.hint + '\n');
    return 2;
  }
  async function execute(request, expectedKinds) {
    const bundle = buildBundle({ request });
    const result = await runExecutor({ ...options, bundle, env, spawnImpl,
      timeoutMs: request.op === 'answer_query' ? Math.min(timeoutMs, 30000) : timeoutMs,
      ...(request.op === 'answer_query' ? { maxStdoutBytes: 64 * 1024 } : {}) });
    return receiveEnvelope(result, { expectedKinds, expectedReaderBuild: bundle.readerBuild,
      expectedTarget: request.op === 'answer_query' ? request.target : undefined, allowDiag: request.diag === true });
  }
  try {
    const expected = options.request.op === 'answer_query' ? ['answer', 'status']
      : options.request.op === 'snapshot' ? ['snapshot', 'status'] : ['preview', 'status'];
    const response = await execute(options.request, expected);
    if (!response.ok) { stderr.write(response.reason + '\n'); return 1; }
    const envelope = response.envelope;
    if (response.kind === 'answer') {
      if (options.emitEnvelope) { stdout.write(JSON.stringify(envelope) + '\n'); return 0; }
      const { text, ...safeEnvelope } = envelope;
      stdout.write(JSON.stringify({ ...safeEnvelope, text_chars: text === null ? 0 : text.length }) + '\n');
      return 0;
    }
    if (response.kind === 'status') {
      stdout.write(envelope.code + ' ' + JSON.stringify(envelope.counts) + '\n');
      return 1;
    }
    if (options.request.op === 'snapshot') {
      if (response.kind !== 'snapshot') return 1;
      const destination = writeSnapshotAtomic(options.outDir, envelope);
      const counts = ` sessions=${envelope.sessions.length} instructions=${envelope.instructions.length}`;
      stdout.write(destination + counts + '\n');
      return 0;
    }
    if (response.kind !== 'preview') return 1;
    for (const key of ['op', 'target', 'ts', 'preview', 'equiv_count']) {
      stdout.write(key + ': ' + escapeTerminal(envelope[key]) + '\n');
    }
    stdout.write('등록할까요? [y/N] ');
    if (!/^(y|yes)$/i.test(await readAnswer(stdin))) return 1;
    const committed = await execute({ ...options.request, op: 'exclude_commit', token: envelope.token }, ['status']);
    if (!committed.ok) { stderr.write(committed.reason + '\n'); return 1; }
    stdout.write(committed.envelope.code + ' ' + JSON.stringify(committed.envelope.counts) + '\n');
    if (committed.envelope.code !== 'ok') return 1;
    stdout.write('스냅샷을 다시 생성하세요\n');
    return 0;
  } catch (error) { stderr.write((error.code || 'executor_failed') + '\n'); return 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
