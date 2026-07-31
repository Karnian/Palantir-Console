#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const readline = require('node:readline');

const args = process.argv.slice(2);
const envFile = process.env.CLAUDE_ENV_FILE;
if (envFile) {
  try {
    fs.writeFileSync(envFile, JSON.stringify({
      PALANTIR_WORKER_TOKEN: process.env.PALANTIR_WORKER_TOKEN,
      PALANTIR_API_BASE: process.env.PALANTIR_API_BASE,
    }));
  } catch { /* ignore */ }
}
const argsFile = process.env.CLAUDE_ARGS_FILE;
if (argsFile) {
  try { fs.writeFileSync(argsFile, JSON.stringify(args)); } catch { /* ignore */ }
}
const authContractFile = process.env.CLAUDE_AUTH_CONTRACT_FILE;
if (authContractFile) {
  try {
    fs.writeFileSync(authContractFile, JSON.stringify({
      bare: args.includes('--bare'),
      hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    }));
  } catch { /* ignore */ }
}
if (
  process.env.CLAUDE_REQUIRE_BARE_API_KEY === '1'
  && args.includes('--bare')
  && !process.env.ANTHROPIC_API_KEY
) {
  process.stderr.write('Not logged in · Please run /login\n');
  process.exit(1);
}

const isManager = args.includes('--input-format');

const init = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'fake-sess',
  model: 'fake',
  tools: [],
  cwd: process.cwd(),
});
process.stdout.write(init + '\n');

if (!isManager) {
  const pIdx = args.indexOf('-p');
  const promptText = pIdx >= 0 ? args[pIdx + 1] : '';
  const astEvt = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'worker-echo:' + promptText }],
    },
  });
  process.stdout.write(astEvt + '\n');
  const result = JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'done',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  process.stdout.write(result + '\n');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const evt = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'echo:' + line }],
    },
  });
  process.stdout.write(evt + '\n');
  const result = JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'turn-done',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  process.stdout.write(result + '\n');
});
rl.on('close', () => {
  process.exit(0);
});
