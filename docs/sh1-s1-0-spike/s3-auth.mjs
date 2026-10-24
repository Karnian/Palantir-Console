// Spike ② ③ ④: auth values at init, no prompt sent. Usage: node s3-auth.mjs <variant>
import { query } from '@anthropic-ai/claude-agent-sdk';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log, psInfo } from './lib.mjs';

const variant = process.argv[2] || 'sub';
const overrides = {
  sub: {},
  apikey: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKE' },
  bearer: { ANTHROPIC_AUTH_TOKEN: 'fake-bearer-token' },
  oauthenv: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKEFAKEFAKE' },
  helper: {},
  bedrock: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
}[variant];

let childPid = null;
const input = inputQueue();
const t0 = Date.now();
const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: BUNDLED,
    cwd: WORKDIR,
    permissionMode: 'default',
    ...(variant === 'helper' ? { settings: { apiKeyHelper: 'echo sk-ant-api03-FAKEHELPER' } } : {}),
    spawnClaudeCodeProcess: makeSpawner({
      envOverride: overrides,
      marker: `inc_spike_${variant}`,
      onChild: (c, opts, env) => {
        childPid = c.pid;
        log('spawn', { pid: c.pid, command: opts.command, argv: opts.args, envKeys: Object.keys(env).sort() });
      },
    }),
  },
});

(async () => {
  for await (const m of q) {
    log('msg', m.type, m.subtype || '', JSON.stringify(m).slice(0, 300));
  }
  log('stream ended');
})().catch((e) => log('stream error', e.message));

try {
  const init = await q.initializationResult();
  log('init after ms', Date.now() - t0);
  log('init.account', JSON.stringify(init.account));
  log('init.claude_code_version', init.claude_code_version, 'fast', init.fast_mode_state);
  const acct = await q.accountInfo();
  log('accountInfo()', JSON.stringify(acct));
  log('ps', JSON.stringify(psInfo(childPid)));
} catch (e) {
  log('init error', e.message);
}
input.end();
q.close?.();
setTimeout(() => process.exit(0), 1500);
