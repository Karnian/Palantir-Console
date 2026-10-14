'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
const specifier = args[args.indexOf('--instruction') + 1];
const [instrId, ref] = specifier.split('#');
const file_fp = args[args.indexOf('--file-fp') + 1];
if (env.FAKE_ANSWER_LOG) fs.appendFileSync(env.FAKE_ANSWER_LOG, JSON.stringify({ args, pid: process.pid,
  executorGroup: env.PALANTIR_SNAPSHOT_EXECUTOR_GROUP, blocked: env.PALANTIR_BLOCK_REAL_SPAWN }) + '\n');
const mode = env.FAKE_ANSWER_MODE || 'ok';
if (mode === 'hang') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else setTimeout(() => {
  const answer = { schema: 'palantir.answer/1', kind: 'answer', machine_id: env.FAKE_ANSWER_MACHINE || 'alpha',
    reader_build: 'a'.repeat(16), target: { instrId, ref, file_fp }, status: 'final', reason: null,
    text: 'ANSWER_SERVER_BODY_SENTINEL', truncated: false, redacted: false, shared_turn: false,
    answer_at: '2026-10-14T00:00:00.000Z', observed_at: '2026-10-14T01:00:00.000Z' };
  if (mode === 'failed') process.exit(7);
  if (mode === 'target') answer.target.ref = '0'.repeat(16);
  if (mode === 'fp') answer.target.file_fp = '0'.repeat(16);
  if (mode === 'instruction') answer.target.instrId = 'claude:other:uother';
  if (mode === 'machine') answer.machine_id = 'other';
  if (mode === 'diag') answer.diag = { evidence_ids: [], segment: { start_id: null, end_id: null } };
  if (mode === 'invariant') answer.answer_at = null;
  if (mode === 'large') answer.text = 'x'.repeat(65536);
  if (mode === 'flood') answer.text = 'x'.repeat(200000);
  if (mode === 'status') { process.stdout.write('{"kind":"status","code":"request_invalid"}\n'); return; }
  if (mode === 'invalid_json') { process.stdout.write('{broken\n'); return; }
  if (mode === 'stderr') process.stderr.write('PRIVATE_STDERR_SENTINEL'.repeat(10000));
  process.stdout.write(JSON.stringify(answer) + '\n');
  if (mode === 'two_lines') process.stdout.write(JSON.stringify(answer) + '\n');
}, Number(env.FAKE_ANSWER_DELAY || 0));
