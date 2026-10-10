import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildBundle, runExecutor, receiveEnvelope, writeSnapshotAtomic } from './lib/sessionSnapshotBundle.mjs';
const require = createRequire(import.meta.url);
const { assertSpawnAllowed, isSpawnGuardActive } = require('../server/utils/spawnGuard.js');
function invalidInput() { throw new Error('request_invalid'); }
function parseArguments(argv, env) {
  const args = [...argv];
  const remote = args[0] === 'remote';
  if (remote) args.shift();
  const values = {};
  let operation;
  while (args.length) {
    const item = args.shift();
    if (item === 'snapshot' || item === 'exclude') {
      if (operation) invalidInput();
      operation = item;
    } else if (item === '--include-exec') {
      if (values[item]) invalidInput();
      values[item] = true;
    } else if (['--host', '--remote-node', '--now', '--out-dir', '--orca-bin',
      '--instruction', '--session'].includes(item)) {
      if (Object.hasOwn(values, item) || !args.length) invalidInput();
      values[item] = args.shift();
    } else invalidInput();
  }
  if (!operation || !remote && (values['--host'] !== undefined || values['--remote-node'] !== undefined)) {
    invalidInput();
  }
  const host = values['--host'];
  if (remote && (typeof host !== 'string' || !/^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/.test(host)
    || host.startsWith('-'))) invalidInput();
  const remoteNode = values['--remote-node'];
  if (remoteNode !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(remoteNode)) invalidInput();
  const sshBin = env.PALANTIR_OBSERVE_SSH_BIN || 'ssh';
  if (sshBin !== 'ssh' && !/^\/[A-Za-z0-9._/-]+$/.test(sshBin)) invalidInput();
  if (values['--now'] !== undefined && !/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(values['--now'])) invalidInput();
  const now = values['--now'] === undefined ? new Date() : new Date(values['--now']);
  if (!Number.isFinite(+now) || !/^\d{4}-/.test(now.toISOString())) invalidInput();
  const request = { schema: 'palantir.snapshot-request/1', op: 'snapshot', now: now.toISOString(),
    include_exec: values['--include-exec'] === true, orca_bin: values['--orca-bin'] ?? 'orca' };
  const outDir = values['--out-dir'] || env.PALANTIR_OBSERVE_SNAPSHOT_DIR;
  if (operation === 'snapshot') {
    if (!outDir || values['--instruction'] !== undefined || values['--session'] !== undefined) invalidInput();
  } else {
    if (values['--out-dir'] !== undefined || values['--include-exec']) invalidInput();
    const instruction = values['--instruction'];
    const session = values['--session'];
    if ((instruction === undefined) === (session === undefined)) invalidInput();
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
    if (isSpawnGuardActive()) {
      assertSpawnAllowed({ command: options.request.orca_bin, source: 'session-snapshot:orca_bin' });
    }
  } catch (error) { stderr.write((error.code || 'request_invalid') + '\n'); return 2; }
  async function execute(request, expectedKinds) {
    const bundle = buildBundle({ request });
    const result = await runExecutor({ ...options, bundle, env, spawnImpl, timeoutMs });
    return receiveEnvelope(result, { expectedKinds, expectedReaderBuild: bundle.readerBuild });
  }
  try {
    const expected = options.request.op === 'snapshot' ? ['snapshot', 'status'] : ['preview', 'status'];
    const response = await execute(options.request, expected);
    if (!response.ok) { stderr.write(response.reason + '\n'); return 1; }
    const envelope = response.envelope;
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
