// Spike ⑤: what happens to the claude child and its Bash tree when the host goes away.
// Usage: node s5-hostexit.mjs <sigkill-host|sigterm-child|stdin-close>
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log, userMsg } from './lib.mjs';

const mode = process.argv[2] || 'sigkill-host';
const pidFile = path.join(WORKDIR, `s5-${mode}.json`);
const input = inputQueue();
let child = null;
let toolStarted;
const started = new Promise((r) => { toolStarted = r; });

const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: BUNDLED,
    cwd: WORKDIR,
    model: 'haiku',
    permissionMode: 'default',
    spawnClaudeCodeProcess: makeSpawner({ envOverride: {}, marker: `inc_s5_${mode}`, onChild: (c) => { child = c; log('child pid', c.pid); c.on('exit', (code, sig) => log('child exit', code, sig)); } }),
    canUseTool: async (toolName, toolInput) => {
      log('canUseTool', toolName, JSON.stringify(toolInput).slice(0, 120));
      if (mode === 'sigkill-pending') { setTimeout(() => toolStarted(), 3000); return new Promise(() => {}); }
      setTimeout(() => toolStarted(), 5000);
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});

(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') log('session', m.session_id);
    if (m.type === 'result') log('RESULT', m.subtype, String(m.result || '').slice(0, 80));
  }
  log('stream ended');
})().catch((e) => log('stream error', e.message));

input.push(userMsg(`Use the Bash tool to run exactly this command: (sleep 300; echo late >> late-${mode}.txt) & python3 -c \"import time; time.sleep(90)\"; echo fg >> fg-${mode}.txt  Then reply done.`, randomUUID()));
await started;

function tree(pid) {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
  const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([p, pp, pg, ...c]) => ({ pid: +p, ppid: +pp, pgid: +pg, cmd: c.join(' ').slice(0, 100) }));
  const desc = [];
  const walk = (p) => rows.filter((r) => r.ppid === p).forEach((r) => { desc.push(r); walk(r.pid); });
  walk(pid);
  return desc;
}
const snapshot = { mode, host: process.pid, child: child.pid, childPgid: null, descendants: tree(child.pid) };
try { snapshot.childPgid = +execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim(); } catch {}
fs.writeFileSync(pidFile, JSON.stringify(snapshot, null, 2));
log('snapshot', JSON.stringify(snapshot));

if (mode === 'sigkill-host') {
  log('SIGKILL self');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'sigterm-child') {
  log('SIGTERM child');
  child.kill('SIGTERM');
  setTimeout(() => { log('host exiting after 10s'); process.exit(0); }, 10000);
} else if (mode === 'sigkill-pending') {
  log('SIGKILL self while permission pending');
  process.kill(process.pid, 'SIGKILL');
} else if (mode === 'stdin-close-long') {
  log('closing child stdin only, staying alive 60s');
  child.stdin.end();
  setTimeout(() => { log('host exiting after 60s'); process.exit(0); }, 60000);
} else if (mode === 'stdin-close') {
  log('closing child stdin only');
  child.stdin.end();
  setTimeout(() => { log('host exiting after 15s'); process.exit(0); }, 15000);
}
