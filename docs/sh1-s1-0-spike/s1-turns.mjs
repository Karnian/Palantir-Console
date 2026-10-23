// Spike ① ⑥ ⑦: uuid echo per turn, long canUseTool wait, interrupt receipt.
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log, userMsg } from './lib.mjs';

const WAIT_MS = Number(process.env.WAIT_MS || 300000);
const counter = path.join(WORKDIR, 'counter.txt');
fs.rmSync(counter, { force: true });

const input = inputQueue();
const ids = { A: randomUUID(), B: randomUUID(), C: randomUUID(), D: randomUUID() };
log('uuids', JSON.stringify(ids));

let results = 0;
let resultWaiters = [];
function nextResult() { return new Promise((r) => resultWaiters.push(r)); }
let toolStarted = null;
let sessionId = null;

const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: BUNDLED,
    cwd: WORKDIR,
    model: 'haiku',
    permissionMode: 'default',
    spawnClaudeCodeProcess: makeSpawner({ envOverride: {}, marker: 'inc_spike_turns', onChild: (c) => log('child pid', c.pid) }),
    canUseTool: async (toolName, toolInput, opts) => {
      const cmd = String(toolInput?.command || '');
      log('canUseTool', toolName, JSON.stringify(toolInput).slice(0, 120), 'toolUseID', opts.toolUseID, 'requestId', opts.requestId);
      opts.signal.addEventListener('abort', () => log('canUseTool signal aborted', opts.toolUseID));
      if (cmd.includes('echo B')) {
        const t = Date.now();
        log(`holding permission for ${WAIT_MS}ms`);
        await new Promise((r) => setTimeout(r, WAIT_MS));
        log('releasing permission after', Date.now() - t, 'ms, aborted=', opts.signal.aborted);
      }
      if (cmd.includes('time.sleep')) toolStarted?.();
      return { behavior: 'allow', updatedInput: toolInput };
    },
  },
});

(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id;
      log('INIT capabilities', JSON.stringify(m.capabilities), 'apiKeySource', m.apiKeySource, 'session', m.session_id);
      continue;
    }
    if (m.type === 'system' && (m.subtype === 'hook_started' || m.subtype === 'hook_response')) continue;
    if (m.type === 'user') {
      log('USER frame', 'uuid', m.uuid, 'isReplay', m.isReplay, 'synthetic', m.isSynthetic, JSON.stringify(m.message?.content).slice(0, 100));
      continue;
    }
    if (m.type === 'assistant') {
      const c = m.message?.content?.map((b) => b.type === 'text' ? `text:${b.text.slice(0, 60)}` : b.type).join('|');
      log('ASSISTANT', 'umu', m.user_message_uuid, 'umus', JSON.stringify(m.user_message_uuids), 'aborted', m.aborted, c);
      continue;
    }
    if (m.type === 'result') {
      results += 1;
      log('RESULT', m.subtype, 'is_error', m.is_error, 'umu', m.user_message_uuid, 'umus', JSON.stringify(m.user_message_uuids), 'cost', m.total_cost_usd, 'text', String(m.result || '').slice(0, 80));
      resultWaiters.splice(0).forEach((r) => r(m));
      continue;
    }
    log('OTHER', m.type, m.subtype || '', JSON.stringify(m).slice(0, 200));
  }
  log('stream ended');
})().catch((e) => log('stream error', e.message));

const readCounter = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean) : []);

// Phase 1: plain turn, uuid echo.
log('PHASE1 send A');
let r = nextResult();
input.push(userMsg('Reply with exactly the word: alpha', ids.A));
await r;

// Phase 2: long permission hold.
if (WAIT_MS > 0) {
log('PHASE2 send B');
r = nextResult();
input.push(userMsg('Use the Bash tool to run exactly this command: echo B >> counter.txt  Then reply with the word done.', ids.B));
await r;
log('counter after B', JSON.stringify(readCounter()));
}

// Phase 3: interrupt with a queued message.
log('PHASE3 send C');
const started = new Promise((res) => { toolStarted = res; });
r = nextResult();
input.push(userMsg('Use the Bash tool to run exactly this command: python3 -c \"import time; time.sleep(40)\" && echo C >> counter.txt  Then reply with the word done.', ids.C));
await started;
await new Promise((res) => setTimeout(res, 4000));
log('PHASE3 push D while C running');
{ const { execFileSync } = await import('node:child_process'); const out = execFileSync('sh', ['-c', 'for p in $(pgrep -f "time.sleep"); do echo "$p $(ps -E -ww -o command= -p $p | grep -o "PALANTIR_OWNED_INCARNATION=[a-z_]*")"; done'], { encoding: 'utf8' }); log('marker on python descendants:', JSON.stringify(out)); }
input.push(userMsg('Reply with exactly the word: delta', ids.D));
await new Promise((res) => setTimeout(res, 1500));
log('PHASE3 interrupt()');
const receipt = await q.interrupt();
log('INTERRUPT receipt', JSON.stringify(receipt));
await r;
log('PHASE3 waiting for possible D turn (20s)');
await new Promise((res) => setTimeout(res, 20000));
log('counter final', JSON.stringify(readCounter()), 'results seen', results);
log('SESSION', sessionId);
input.end();
q.close?.();
setTimeout(() => process.exit(0), 2000);
