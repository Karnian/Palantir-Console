#!/usr/bin/env node
// pretest hook: rebuilds the better-sqlite3 native binding only when it's
// actually missing/broken. An unconditional `npm rebuild` can tear down a
// working build/ output and fail to replace it (offline env, no compiler
// toolchain) — turning a healthy install into a guaranteed-broken one. Node
// (not a shell one-liner) so this also runs unmodified on Windows, where
// `2>/dev/null` and `|| true` aren't valid cmd.exe syntax.

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

try {
  // require() alone only loads the JS wrapper — the native addon is loaded
  // lazily inside `new Database(...)`, so that's what actually needs to
  // succeed to prove the binding is usable.
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  process.exit(0);
} catch {
  try {
    execSync('npm rebuild better-sqlite3 --silent', { stdio: 'ignore' });
  } catch {
    // best-effort — let the actual test run surface the real error
  }
}
