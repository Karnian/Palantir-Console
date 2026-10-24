import { query } from '@anthropic-ai/claude-agent-sdk';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log } from './lib.mjs';
let child; const input = inputQueue();
const q = query({ prompt: input, options: { pathToClaudeCodeExecutable: BUNDLED, cwd: WORKDIR, permissionMode: 'default',
  spawnClaudeCodeProcess: makeSpawner({ envOverride: {}, marker: 'inc_s11', onChild: (c) => { child = c; } }) } });
(async () => { for await (const m of q) {} })().catch(() => {});
const init = await q.initializationResult();
const { account, commands, agents, models, ...rest } = init;
log('spawned pid', child.pid, 'init.pid', init.pid);
log('scalar fields', JSON.stringify(rest).slice(0, 900));
q.close(); setTimeout(() => process.exit(0), 1500);
