// Spike: deny-with-nonce visibility in tool_result.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log, userMsg } from './lib.mjs';
const input = inputQueue();
const nonce = 'pln_' + randomUUID().slice(0, 8);
let done; const finished = new Promise((r) => { done = r; });
const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: BUNDLED, cwd: WORKDIR, model: 'haiku', permissionMode: 'default',
  spawnClaudeCodeProcess: makeSpawner({ envOverride: {}, marker: 'inc_s7' }),
  canUseTool: async (name, inp, opts) => { log('canUseTool', name, opts.toolUseID); return { behavior: 'deny', message: `Denied by Palantir user. request=${nonce}` }; } } });
(async () => { for await (const m of q) {
  if (m.type === 'user') for (const b of (Array.isArray(m.message?.content) ? m.message.content : [])) if (b.type === 'tool_result') log('TOOL_RESULT', b.tool_use_id, 'is_error', b.is_error, JSON.stringify(b.content).slice(0, 200));
  if (m.type === 'result') { log('RESULT', m.subtype, String(m.result).slice(0, 80)); done(); }
} })();
input.push(userMsg('Use the Bash tool to run exactly: echo X >> deny.txt  then reply with one word.', randomUUID()));
await finished; log('nonce', nonce); input.end(); q.close?.(); setTimeout(() => process.exit(0), 1500);
