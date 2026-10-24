// Spike R5 follow-up (no model requests): settings-env auth variants, pre-prompt
// system/init availability, and what close() does to the child.
// Usage: node s9-gate2.mjs <variant> <close|abort>
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { BUNDLED, WORKDIR, makeSpawner, inputQueue, log } from './lib.mjs';

const variant = process.argv[2] || 'sub';
const how = process.argv[3] || 'close';
const settingsFor = {
  sub: undefined,
  'settings-apikey': { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKESETTINGS' } },
  'settings-bearer': { env: { ANTHROPIC_AUTH_TOKEN: 'fake-settings-bearer' } },
  'settings-oauth': { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKESETTINGS' } },
  'settings-bedrock': { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } },
  'settings-baseurl': { env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' } },
}[variant];

let child = null;
const ac = new AbortController();
const input = inputQueue();
const q = query({
  prompt: input,
  options: {
    pathToClaudeCodeExecutable: BUNDLED,
    cwd: WORKDIR,
    permissionMode: 'default',
    abortController: ac,
    ...(settingsFor ? { settings: settingsFor } : {}),
    spawnClaudeCodeProcess: makeSpawner({ envOverride: {}, marker: `inc_s9_${variant}`, onChild: (c) => { child = c; c.on('exit', (code, sig) => log('child exit', code, sig)); } }),
  },
});
(async () => {
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') log('PRE-PROMPT system/init!', 'apiKeySource', m.apiKeySource, 'caps', JSON.stringify(m.capabilities));
    else if (!(m.type === 'system' && m.subtype?.startsWith('hook_'))) log('msg', m.type, m.subtype || '', JSON.stringify(m).slice(0, 160));
  }
  log('stream ended');
})().catch((e) => log('stream error', e.message));

const init = await q.initializationResult();
log('account', JSON.stringify(init.account));
log('init keys', Object.keys(init).join(','));
await new Promise((r) => setTimeout(r, 5000));
const alive = (pid) => { try { execFileSync('ps', ['-p', String(pid)]); return true; } catch { return false; } };
const t = Date.now();
if (how === 'close') { log('q.close()'); q.close(); } else { log('abortController.abort()'); ac.abort(); }
for (const ms of [500, 2500, 6000]) {
  await new Promise((r) => setTimeout(r, ms - (Date.now() - t)));
  log(`+${ms}ms child alive=`, alive(child.pid));
}
process.exit(0);
