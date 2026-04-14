#!/usr/bin/env node
/**
 * Phase 10A Spike — Claude CLI `--bare` auth compatibility PoC.
 *
 * Spec: docs/specs/worker-preset-and-plugin-injection.md §6.9 / §11
 *
 * Question: Can an isolated worker authenticate under `--bare` using:
 *   (a) CLAUDE_CODE_OAUTH_TOKEN env     (spec assumption)
 *   (b) ANTHROPIC_API_KEY env          (CLI help says "strictly")
 *
 * The CLI `--help` text reads:
 *   "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
 *    --settings (OAuth and keychain are never read)."
 *
 * If (a) fails, the §6.9 auth flow needs revision (e.g. materialize via
 * apiKeyHelper + --settings, or require users to supply ANTHROPIC_API_KEY).
 *
 * The PoC spawns `claude --bare --print "Say hello"` with different env
 * matrices and reports exit code + stderr signature for each.
 *
 * Usage:
 *   node scripts/spike-bare-auth.mjs [--verbose]
 *
 * Exits 0 if at least one variant that the spec relies on works.
 * Prints a markdown-ready summary block for pasting into §11 Review Log.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const VERBOSE = process.argv.includes('--verbose');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function readKeychainToken() {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
      encoding: 'utf-8',
    });
    const parsed = JSON.parse(out);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function makeIsolatedHome() {
  const dir = mkdtempSync(path.join(tmpdir(), 'palantir-spike-'));
  // Empty .claude/ so bare mode has nothing to inherit even if bare is buggy
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeApiKeyHelperSettings(homeDir, token) {
  const helperPath = path.join(homeDir, 'apikey-helper.sh');
  writeFileSync(helperPath, `#!/bin/sh\nprintf '%s' '${token.replace(/'/g, "'\\''")}'\n`, { mode: 0o700 });
  chmodSync(helperPath, 0o700);
  const settingsPath = path.join(homeDir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ apiKeyHelper: helperPath }, null, 2));
  return settingsPath;
}

function runClaudeBare({ label, env, extraArgs = [] }) {
  const args = ['--bare', '--print', 'Say the single word HELLO and stop.', ...extraArgs];
  const start = Date.now();
  const res = spawnSync('claude', args, {
    env,
    timeout: 60_000,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const durMs = Date.now() - start;
  return {
    label,
    args,
    code: res.status,
    signal: res.signal,
    durMs,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? `${res.error.code || 'ERR'}: ${res.error.message}` : null,
  };
}

function summarize(r) {
  const pass = r.code === 0 && !!r.stdout && /hello/i.test(r.stdout);
  const stderrHead = r.stderr.split('\n').slice(0, 3).join(' | ').slice(0, 240);
  const stdoutHead = r.stdout.split('\n').slice(0, 2).join(' | ').slice(0, 120);
  return {
    pass,
    line: `${pass ? 'PASS' : 'FAIL'} | ${r.label} | code=${r.code} sig=${r.signal || '-'} ${r.durMs}ms | stdout="${stdoutHead}" | stderr="${stderrHead}"`,
    raw: r,
  };
}

function buildBaseEnv(homeOverride) {
  const stripped = { ...process.env };
  delete stripped.CLAUDE_CODE_OAUTH_TOKEN;
  delete stripped.ANTHROPIC_API_KEY;
  delete stripped.ANTHROPIC_BASE_URL;
  if (homeOverride) stripped.HOME = homeOverride;
  return stripped;
}

async function main() {
  const token = readKeychainToken();
  if (!token) {
    console.error('[spike] ABORT — no keychain token available; spike requires a real OAuth token to exercise --bare env injection.');
    process.exit(2);
  }
  console.log(`[spike] keychain token shape: ${token.slice(0, 16)}... (len=${token.length})`);

  const homeA = makeIsolatedHome();
  const homeB = makeIsolatedHome();
  const homeC = makeIsolatedHome();
  const homeD = makeIsolatedHome();

  const variants = [];

  variants.push(runClaudeBare({
    label: 'A) --bare + CLAUDE_CODE_OAUTH_TOKEN env (spec §6.9 primary)',
    env: { ...buildBaseEnv(homeA), CLAUDE_CODE_OAUTH_TOKEN: token },
  }));

  variants.push(runClaudeBare({
    label: 'B) --bare + ANTHROPIC_API_KEY=<oauth-token> env',
    env: { ...buildBaseEnv(homeB), ANTHROPIC_API_KEY: token },
  }));

  const settingsPath = writeApiKeyHelperSettings(homeC, token);
  variants.push(runClaudeBare({
    label: 'C) --bare + apiKeyHelper via --settings',
    env: buildBaseEnv(homeC),
    extraArgs: ['--settings', settingsPath],
  }));

  variants.push(runClaudeBare({
    label: 'D) --bare + NO auth (negative control)',
    env: buildBaseEnv(homeD),
  }));

  const results = variants.map(summarize);
  console.log('\n=== Phase 10A Spike Results ===');
  for (const r of results) console.log(r.line);

  if (VERBOSE) {
    console.log('\n=== Full stderr (truncated) ===');
    for (const r of results) {
      console.log(`\n--- ${r.raw.label} ---\n${r.raw.stderr.slice(0, 1500)}`);
    }
  }

  console.log('\n=== Markdown summary for Review Log §11 ===\n');
  console.log('| # | Variant | Result | Notes |');
  console.log('|---|---------|--------|-------|');
  for (const r of results) {
    const notes = r.raw.stderr.split('\n')[0]?.slice(0, 120) || (r.pass ? 'ok' : '-');
    console.log(`| ${r.raw.label.split(')')[0]} | ${r.raw.label.split(') ')[1] || r.raw.label} | ${r.pass ? 'PASS' : 'FAIL'} | ${notes.replace(/\|/g, '\\|')} |`);
  }

  for (const d of [homeA, homeB, homeC, homeD]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const primaryPass = results[0].pass;
  const fallbackPass = results.slice(1, 3).some(r => r.pass);
  const negPass = results[3].pass;

  console.log(`\n[spike] primary (A: CLAUDE_CODE_OAUTH_TOKEN env): ${primaryPass ? 'PASS' : 'FAIL'}`);
  console.log(`[spike] fallback (B or C): ${fallbackPass ? 'PASS' : 'FAIL'}`);
  console.log(`[spike] negative control (D must FAIL): ${negPass ? 'UNEXPECTED PASS — isolation leak!' : 'FAIL (expected)'}`);

  if (primaryPass) {
    console.log('\n[spike] VERDICT: PASS — spec §6.9 auth flow viable as written.');
    process.exit(0);
  }
  if (fallbackPass && !negPass) {
    console.log('\n[spike] VERDICT: CONDITIONAL — primary variant failed but a fallback works. Spec §6.9 must be amended to use the fallback path.');
    process.exit(0);
  }
  console.log('\n[spike] VERDICT: FAIL — no viable auth path found under --bare. Phase 10 must be held.');
  process.exit(1);
}

main().catch(e => {
  console.error('[spike] unexpected error:', e);
  process.exit(3);
});
