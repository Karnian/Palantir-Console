#!/usr/bin/env node
// Test entry point. Pins the environment inputs that would otherwise let a
// developer's machine change the result, then hands off to `node --test`.
//
// Why a Node script rather than `VAR=1 node --test` in package.json: the same
// reason scripts/ensure-sqlite-binding.mjs is one — a `VAR=value command`
// prefix is not valid cmd.exe syntax, so the shell form silently fails to set
// anything on Windows and the suite runs unpinned there.
//
// PALANTIR_SKIP_HOST_CREDENTIALS makes ambient host credential discovery inert
// (repo .claude-auth.json, macOS keychain, the CLI credential store), so
// resolver results come from the test's own inputs rather than from whether the
// person running it happens to be logged in. Tests that specifically assert
// discovery DOES happen re-enable it in their own scope.
//
// PALANTIR_SKIP_DOTENV keeps a developer .env (PALANTIR_TOKEN, a non-default
// PORT) from leaking into the suite.
//
// Both are only defaults here: an explicit value in the environment wins, so a
// single run can still be pointed at something else.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULTS = {
  PALANTIR_SKIP_HOST_CREDENTIALS: '1',
  PALANTIR_SKIP_DOTENV: '1',
};

const env = { ...process.env };
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (env[key] === undefined) env[key] = value;
}

// Bound the runner's parallelism. `node --test` defaults to one worker per CPU
// (18 on the dev machine), and at that level the suite fails 1-3 DIFFERENT
// tests per run -- every one of them passing when its file runs alone. Those
// were being triaged by hand as "known flakes", which is how a real regression
// (a canonical `runs` column list that migration 092 invalidated) hid among
// them for a whole session.
//
// Measured on the dev machine: default (18) fails 2/2/0 across three runs;
// concurrency 4 is green 2/2 and costs ~12s (~20%). Determinism is worth more
// than that, and a CI gate is meaningless without it.
//
// An explicit --test-concurrency on the command line still wins.
const passthrough = process.argv.slice(2);
const hasExplicitConcurrency = passthrough.some(
  (arg) => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='),
);
const concurrencyArgs = hasExplicitConcurrency ? [] : ['--test-concurrency=4'];

// Pin hostless ephemeral binds to loopback. See scripts/loopback-bind-preload.cjs
// for the failure this prevents (supertest requests silently reaching Tailscale
// or another local process instead of the app under test). Passed as a runner
// flag rather than via NODE_OPTIONS, which would be inherited by every node
// process the suite starts. As a runner flag it reaches the per-file test
// processes but is not inserted into the argv of a plain
// spawn(process.execPath, [cli, ...]) — the shape the CLI tests use. A child
// started with fork(), or one that deliberately replays process.execArgv, would
// still inherit it.
const preload = fileURLToPath(new URL('./loopback-bind-preload.cjs', import.meta.url));

const child = spawn(
  process.execPath,
  ['--require', preload, '--test', ...concurrencyArgs, ...passthrough],
  { stdio: 'inherit', env },
);

child.on('error', (err) => {
  console.error(`[run-tests] failed to start the test runner: ${err.message}`);
  process.exit(1);
});

// Preserve the runner's exit signal/code so CI and `npm test` see the real
// result rather than a flattened one.
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
