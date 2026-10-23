// Shared helpers for the S1-0 spike. Not product code.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED = path.join(here, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
export const WORKDIR = path.join(here, 'work');
fs.mkdirSync(WORKDIR, { recursive: true });

export const AUTH_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE', 'ANTHROPIC_BASE_URL',
];

export function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'LOGNAME']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return { ...env, ...extra };
}

export function log(...a) {
  const t = new Date().toISOString().slice(11, 23);
  console.log(`[${t}]`, ...a);
}

export function psInfo(pid) {
  const out = {};
  try { out.lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch (e) { out.lstart = `ERR ${e.status}`; }
  try { out.ppid = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch (e) { out.ppid = `ERR ${e.status}`; }
  try {
    const envOut = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    const m = envOut.match(/PALANTIR_OWNED_INCARNATION=([A-Za-z0-9_-]+)/);
    out.marker = m ? m[1] : null;
  } catch (e) { out.marker = `ERR ${e.status}`; }
  return out;
}

// Custom spawn that records the child pid and lets the caller pick the env.
export function makeSpawner({ envOverride, marker, onChild }) {
  return (opts) => {
    // opts.env is what the SDK wanted; we replace auth with our own clean env
    // but keep the SDK-specific CLAUDE_* entrypoint vars it set.
    const sdkVars = {};
    for (const [k, v] of Object.entries(opts.env || {})) {
      if ((k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK')) && !AUTH_KEYS.includes(k)) sdkVars[k] = v;
    }
    const env = { ...cleanEnv(), ...sdkVars, ...envOverride };
    if (marker) env.PALANTIR_OWNED_INCARNATION = marker;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd, env, signal: opts.signal, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (d) => process.stderr.write(`[child-stderr] ${d}`));
    onChild?.(child, opts, env);
    return child;
  };
}

// Controllable async iterable of SDKUserMessage.
export function inputQueue() {
  const items = [];
  let wake = null;
  let done = false;
  return {
    push(msg) { items.push(msg); wake?.(); },
    end() { done = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (items.length) yield items.shift();
        if (done) return;
        await new Promise((r) => { wake = r; });
        wake = null;
      }
    },
  };
}

export function userMsg(text, uuid) {
  return { type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: text } };
}
