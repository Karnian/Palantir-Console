#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
if (args.length !== 7 || args[0] !== '-o' || args[1] !== 'BatchMode=yes' || args[2] !== '--'
  || !args[3] || !args[4] || args[5] !== '--no-warnings' || args[6] !== '-') process.exit(255);
if (process.env.FAKE_SSH_ARGV_LOG) fs.writeFileSync(process.env.FAKE_SSH_ARGV_LOG, JSON.stringify(args));
if (process.env.FAKE_SSH_STDERR) process.stderr.write(process.env.FAKE_SSH_STDERR);
const mode = process.env.FAKE_SSH_MODE;
if (mode === 'hang') { process.stdin.resume(); setInterval(function hang() {}, 1000); }
else if (mode === 'hang_descendant') {
  process.stdin.resume();
  const source = "require('node:fs').writeFileSync(process.env.FAKE_SSH_DESCENDANT_PID, String(process.pid));" +
    'setInterval(function hang() {}, 1000);';
  spawn(process.execPath, ['-e', source], { stdio: 'inherit', env: process.env });
  setInterval(function hang() {}, 1000);
}
else if (mode === 'flood') {
  process.stdin.resume();
  const chunk = Buffer.alloc(65536, 120);
  function flood() { if (process.stdout.write(chunk)) setImmediate(flood); else process.stdout.once('drain', flood); }
  flood();
} else if (mode === 'exit3') { process.stdin.resume(); process.exitCode = 3; }
else if (mode === 'garbage' || mode === 'two_envelopes') {
  process.stdin.resume(); process.stdout.write(mode === 'garbage' ? '{broken' : '{}\n{}\n');
} else {
  const nodeArgs = process.env.FAKE_SSH_PRELOAD ? ['-r', process.env.FAKE_SSH_PRELOAD] : [];
  const env = { ...process.env, HOME: process.env.FAKE_SSH_HOME || process.env.HOME };
  const child = spawn(process.execPath, [...nodeArgs, '--no-warnings', '-'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', function ignorePipe() {});
  if (['unsanitized', 'build_mismatch', 'status_bad_code', 'status_bad_counts'].includes(mode)) {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stdout.on('end', function alterEnvelope() {
      const envelope = JSON.parse(output);
      if (mode === 'build_mismatch') envelope.reader_build = '0000000000000000';
      else if (mode === 'unsanitized') envelope.instructions[0].text = 'sk-ant-api03-' + 'Q'.repeat(80);
      if (mode.startsWith('status_bad')) {
        process.stdout.write(JSON.stringify({ schema: 'palantir.snapshot-status/1',
          machine_id: envelope.machine.id, reader_build: envelope.reader_build,
          code: mode === 'status_bad_code' ? 'UNTRUSTED_SENTINEL' : 'ok',
          counts: mode === 'status_bad_counts' ? { UNTRUSTED_SENTINEL: 1 } : {} }) + '\n');
      } else process.stdout.write(JSON.stringify(envelope) + '\n');
    });
  } else child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('close', code => { process.exitCode = mode === 'envelope_then_exit3' ? 3 : code; });
}
