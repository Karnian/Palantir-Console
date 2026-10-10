#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_ORCA_SPAWN_LOG) {
  fs.appendFileSync(process.env.FAKE_ORCA_SPAWN_LOG, JSON.stringify(args) + '\n');
}
if (process.env.FAKE_ORCA_STDERR) process.stderr.write(process.env.FAKE_ORCA_STDERR);
if (!['worktree ps --json', 'terminal list --json'].includes(args.join(' '))) process.exit(2);
process.stdout.write('[]');
