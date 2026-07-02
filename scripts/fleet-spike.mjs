#!/usr/bin/env node

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const defaultDbPath = () => process.env.PALANTIR_DB || path.join(repoRoot, 'server', 'palantir.db');

function parseArgs(args) {
  const parsed = {
    nodeId: null,
    dbPath: defaultDbPath(),
    withWorktree: false,
    jsonOut: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--db') {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--db requires a path value');
      parsed.dbPath = value;
      i += 1;
    } else if (arg === '--with-worktree') {
      parsed.withWorktree = true;
    } else if (arg === '--json') {
      parsed.jsonOut = true;
    } else if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.nodeId) {
      parsed.nodeId = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }
  return parsed;
}

let parsedArgs;
let parseError = null;
try {
  parsedArgs = parseArgs(argv);
} catch (err) {
  parseError = err;
  parsedArgs = {
    nodeId: null,
    dbPath: defaultDbPath(),
    withWorktree: false,
    jsonOut: argv.includes('--json'),
    help: false,
  };
}

const { nodeId, dbPath, withWorktree, jsonOut } = parsedArgs;

const useColor = !jsonOut && process.stdout.isTTY;
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

function printHelp() {
  process.stdout.write(`\
Usage: fleet-spike <node-id> [options]

Runs a live SSH-node smoke test. This tool intentionally performs real ssh.

Options:
  --db <path>        Override palantir.db (default: ./server/palantir.db, or $PALANTIR_DB)
  --with-worktree    Also git-init a temporary repo and round-trip worktreeService
  --json             Emit machine-readable JSON
  -h, --help         Show this help
`);
}

function hintFor(err) {
  if (err && err.code === 'SSH_TRANSPORT') {
    return 'ssh exited 255. Check key auth, ssh_user/ssh_host, BatchMode access, host key acceptance, and pod network reachability.';
  }
  if (err && err.code === 'EXPOSED_ROOTS') {
    return 'exposed_roots guard rejected the path. Check the node exposed_roots JSON and remote realpath results.';
  }
  return err && err.message ? err.message : String(err);
}

async function main() {
  if (parseError) {
    if (!jsonOut) {
      process.stderr.write(`${c.red('error:')} ${parseError.message}\n`);
      printHelp();
    }
    process.exitCode = 1;
    return;
  }
  if (parsedArgs.help || !nodeId) {
    printHelp();
    process.exitCode = parsedArgs.help ? 0 : 1;
    return;
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`palantir.db not found at ${dbPath}. Start the server once to migrate, or pass --db.`);
  }

  const { createDatabase } = require(path.join(repoRoot, 'server/db/database.js'));
  const { createRemoteSshNodeExecutor } = require(path.join(repoRoot, 'server/services/remoteSshExecutor.js'));
  const { createWorktreeService } = require(path.join(repoRoot, 'server/services/worktreeService.js'));

  const opened = createDatabase(dbPath);
  const db = opened.db;
  const close = opened.close;
  const steps = [];
  let remote;
  let root;

  async function step(name, fn) {
    const started = process.hrtime.bigint();
    try {
      const detail = await fn();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      steps.push({ name, ok: true, ms, detail });
      if (!jsonOut) process.stdout.write(`${c.green('PASS')} ${name} ${c.dim(`${ms.toFixed(0)}ms`)}${detail ? ` - ${detail}` : ''}\n`);
    } catch (err) {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      steps.push({ name, ok: false, ms, error: err.message, code: err.code || null, hint: hintFor(err) });
      if (!jsonOut) {
        process.stderr.write(`${c.red('FAIL')} ${name} ${c.dim(`${ms.toFixed(0)}ms`)} - ${err.message}\n`);
        process.stderr.write(`  ${c.yellow('hint:')} ${hintFor(err)}\n`);
      }
      throw err;
    }
  }

  try {
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    if (node.kind !== 'ssh') throw new Error(`Node ${nodeId} is kind=${node.kind}; expected ssh`);
    const roots = JSON.parse(node.exposed_roots || '[]');
    if (!Array.isArray(roots) || roots.length === 0) throw new Error(`Node ${nodeId} has no exposed_roots`);
    root = roots[0].replace(/\/+$/, '') || '/';
    remote = createRemoteSshNodeExecutor(node, { commandAllowlist: ['git', 'echo', 'pwd', 'mktemp', 'sh'] });

    if (!jsonOut) {
      process.stdout.write(c.bold('Fleet SSH spike') + '\n');
      process.stdout.write(`  node: ${node.id} (${node.ssh_user}@${node.ssh_host})\n`);
      process.stdout.write(`  db: ${dbPath}\n`);
      process.stdout.write(`  root: ${root}\n\n`);
    }

    await step('exec echo', async () => {
      const res = await remote.exec('echo', ['fleet-spike-ok']);
      if (res.code !== 0 || res.stdout.trim() !== 'fleet-spike-ok') throw new Error(`unexpected echo result code=${res.code} stdout=${JSON.stringify(res.stdout)}`);
      return res.stdout.trim();
    });

    await step('git --version', async () => {
      const res = await remote.exec('git', ['--version']);
      if (res.code !== 0) throw new Error(res.stderr || `git --version exited ${res.code}`);
      return res.stdout.trim();
    });

    await step('exposed root exists and realpath', async () => {
      const exists = await remote.fileExists(root);
      if (!exists) throw new Error(`${root} does not exist on remote node`);
      return await remote.realpath(root);
    });

    await step('exposed_roots guard rejects /etc cwd', async () => {
      try {
        await remote.exec('pwd', [], { cwd: '/etc' });
      } catch (err) {
        if (err.code === 'EXPOSED_ROOTS') return 'EXPOSED_ROOTS';
        throw err;
      }
      throw new Error('expected EXPOSED_ROOTS rejection for /etc cwd');
    });

    await step('LC_ALL classify non-git directory', async () => {
      const mk = await remote.exec('mktemp', ['-d', `${root}/fleet-spike-nongit.XXXXXX`]);
      if (mk.code !== 0) throw new Error(mk.stderr || `mktemp exited ${mk.code}`);
      const dir = mk.stdout.trim();
      const worktrees = createWorktreeService({ nodeExecutor: remote });
      try {
        const classification = await worktrees.classifyProjectDir(dir);
        if (classification !== 'non_git') throw new Error(`expected non_git, got ${classification}`);
        return classification;
      } finally {
        await remote.rmrf(dir);
      }
    });

    if (withWorktree) {
      await step('worktreeService remote round trip', async () => {
        const mk = await remote.exec('mktemp', ['-d', `${root}/fleet-spike-repo.XXXXXX`]);
        if (mk.code !== 0) throw new Error(mk.stderr || `mktemp exited ${mk.code}`);
        const repo = mk.stdout.trim();
        const branch = `fleet-spike-${Date.now()}`;
        const worktrees = createWorktreeService({ nodeExecutor: remote });
        let created = null;
        try {
          for (const args of [
            ['init'],
            ['config', 'user.name', 'Fleet Spike'],
            ['config', 'user.email', 'fleet-spike@example.invalid'],
          ]) {
            const res = await remote.exec('git', args, { cwd: repo });
            if (res.code !== 0) throw new Error(res.stderr || `git ${args.join(' ')} exited ${res.code}`);
          }
          const seed = await remote.exec('sh', ['-c', 'printf "%s\\n" fleet-spike > README.md && git add README.md && git commit -m init'], { cwd: repo });
          if (seed.code !== 0) throw new Error(seed.stderr || `seed commit exited ${seed.code}`);
          const classification = await worktrees.classifyProjectDir(repo);
          if (classification !== 'git') throw new Error(`expected git, got ${classification}`);
          created = await worktrees.createWorktree(repo, branch);
          await worktrees.removeWorktree(repo, created.path, branch, { autosave: false });
          return created.path;
        } finally {
          await remote.rmrf(repo);
        }
      });
    }

    if (jsonOut) process.stdout.write(JSON.stringify({ ok: true, node: nodeId, dbPath, steps }, null, 2) + '\n');
  } catch (err) {
    if (jsonOut) process.stdout.write(JSON.stringify({ ok: false, node: nodeId, dbPath, steps, error: err.message, code: err.code || null, hint: hintFor(err) }, null, 2) + '\n');
    process.exitCode = 1;
  } finally {
    try { close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ ok: false, error: err.message, code: err.code || null, hint: hintFor(err) }, null, 2) + '\n');
  } else {
    process.stderr.write(`${c.red('error:')} ${err.message}\n`);
    process.stderr.write(`  ${c.yellow('hint:')} ${hintFor(err)}\n`);
  }
  process.exitCode = 1;
});
