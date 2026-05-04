#!/usr/bin/env node
// Diagnose MCP alias conflicts between Palantir presets and the user's
// Codex CLI registrations at ~/.codex/config.toml.
//
// Codex CLI merges `-c mcp_servers.<alias>.<key>=` overrides at the leaf
// level, so a preset that declares e.g. `ctx7.command="npx"` will fuse
// with the user's existing `ctx7.args` / `ctx7.env` at spawn. At runtime
// M2 emits `mcp:legacy_alias_conflict` run events whenever that happens.
// This tool gives operators a way to answer "which of my presets will
// trigger that event?" without actually spawning anything.
//
// Output:
//   - user config path + alias list
//   - per-preset report: conflict aliases highlighted, clean aliases
//     dimmed, preset-level verdict
//   - summary: total presets, total conflicting presets, aggregated
//     conflicting aliases
//
// Exit codes:
//   0 — diagnostic ran successfully (conflicts may or may not exist)
//   1 — fatal: cannot open DB or read user config
//   2 — strict mode (--fail-on-conflict) + at least one conflict found
//
// Usage:
//   npm run diagnose:mcp
//   node scripts/diagnose-mcp-conflicts.mjs [--db <path>] [--config <path>] [--fail-on-conflict] [--json]

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const hasFlag = (name) => argv.includes(name);

// Default DB path mirrors `server/app.js:81` exactly so the diagnostic
// reads the SAME database the running server writes to. Without this
// alignment a fresh-cloned repo with stale `<root>/palantir.db` (left
// over from old dev cycles) shadowed the real `server/palantir.db`,
// producing "schema_version 19 / no transport column" false negatives.
// `__dirname` of `server/app.js` is `<repoRoot>/server`, so the
// default lives at `<repoRoot>/server/palantir.db`. Operator overrides
// (`--db <path>` or `PALANTIR_DB` env) still win, in that order.
const dbPath = flagValue('--db')
  || process.env.PALANTIR_DB
  || path.join(repoRoot, 'server', 'palantir.db');
const configPathOverride = flagValue('--config');
const jsonOut = hasFlag('--json');
const failOnConflict = hasFlag('--fail-on-conflict');

// ANSI helpers — suppressed in --json mode and when stdout isn't a TTY.
const useColor = !jsonOut && process.stdout.isTTY;
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function die(msg, code = 1) {
  // die() is only called on fatal paths where no subsequent output is
  // intended, so synchronous write + immediate exit is fine. Normal
  // successful paths use process.exitCode + natural termination instead.
  process.stderr.write(`${c.red('error:')} ${msg}\n`);
  process.exit(code);
}

// Branch on --help first so the heavy DB/util deps stay out of that path.
// Using a named-function split (printHelp / runDiagnose) instead of an
// early process.exit(0) keeps every normal-exit path on process.exitCode
// — matches the pattern at end-of-file and lets piped output drain.
function printHelp() {
  process.stdout.write(`\
Usage: diagnose-mcp-conflicts [options]

Reports which Palantir presets will trigger mcp:legacy_alias_conflict
events against the Codex user config.

Options:
  --db <path>             Override palantir.db location (default: ./server/palantir.db, or $PALANTIR_DB)
  --config <path>         Override ~/.codex/config.toml location
  --fail-on-conflict      Exit 2 when at least one preset conflicts
  --json                  Emit machine-readable JSON, no colors
  -h, --help              Show this help
`);
}

if (hasFlag('--help') || hasFlag('-h')) {
  printHelp();
} else {
  runDiagnose();
}

function runDiagnose() {
if (!fs.existsSync(dbPath)) {
  die(`palantir.db not found at ${dbPath}. Start the server once to migrate the schema, or pass --db.`);
}

const { createDatabase } = require(path.join(repoRoot, 'server/db/database.js'));
const {
  scanCodexUserConfigAliases,
  resolveCodexUserConfigPath,
} = require(path.join(repoRoot, 'server/services/managerAdapters/codexUserConfigScan.js'));

let resolvedConfigPath, userAliases;
try {
  resolvedConfigPath = configPathOverride || resolveCodexUserConfigPath();
  userAliases = scanCodexUserConfigAliases(configPathOverride);
} catch (err) {
  die(`cannot read Codex user config: ${err.message}`);
}

let db, close;
try {
  const opened = createDatabase(dbPath);
  db = opened.db;
  close = opened.close;
  // Do NOT run migrate() here — this diagnostic is read-only. A missing
  // required table is surfaced as a fatal error by assertTable() below;
  // it is NOT silently equated with "no presets yet".
} catch (err) {
  die(`cannot open ${dbPath}: ${err.message}`);
}

// Strict table probes — previous `safeAll` fallback swallowed schema drift
// and made "DB has no tables" indistinguishable from "DB has no presets",
// which is the exact false negative an ops diagnostic tool must NOT have.
function assertTable(name) {
  try {
    db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).all();
  } catch (err) {
    die(
      `required table "${name}" missing or unreadable in ${dbPath}: ${err.message}\n       ` +
      `Start the server once to apply migrations, or pass --db to the correct file.`,
    );
  }
}
assertTable('mcp_server_templates');
assertTable('worker_presets');

// M4-a: include transport / url / bearer_token_env_var so http aliases are
// visible in the diagnostic. The bearer env *name* is shown verbatim (it
// IS the publicly-known runtime knob); the env *value* is never read here.
const templates = db.prepare(`
  SELECT id, alias, transport, command, url, bearer_token_env_var
  FROM mcp_server_templates
`).all();
const templateAliasById = new Map(templates.map((t) => [t.id, t.alias]));
const templateById = new Map(templates.map((t) => [t.id, t]));

const presets = db.prepare(`SELECT id, name, mcp_server_ids FROM worker_presets`).all();

const userAliasSet = new Set(userAliases);

const report = presets.map((preset) => {
  let ids;
  try { ids = JSON.parse(preset.mcp_server_ids || '[]'); } catch { ids = []; }
  const aliasRows = ids
    .map((id) => templateById.get(id))
    .filter((t) => t);
  const presetAliases = aliasRows.map((t) => t.alias);
  const conflicts = presetAliases.filter((a) => userAliasSet.has(a));
  const clean = presetAliases.filter((a) => !userAliasSet.has(a));
  // M4-a: per-alias details for verbose / json output. URL is shown as-is
  // (never a secret); bearer_token_env_var name visible, value masked.
  const details = aliasRows.map((t) => ({
    alias: t.alias,
    transport: t.transport || 'stdio',
    ...(t.transport === 'http'
      ? { url: t.url, bearer_token_env_var: t.bearer_token_env_var || null,
          bearer_token_value: t.bearer_token_env_var ? '***' : null }
      : { command: t.command || null }),
  }));
  return { id: preset.id, name: preset.name, conflicts, clean, details };
});

const conflictingPresets = report.filter((r) => r.conflicts.length > 0);
const aggregatedConflictAliases = [
  ...new Set(conflictingPresets.flatMap((r) => r.conflicts)),
];

if (jsonOut) {
  process.stdout.write(JSON.stringify({
    userConfig: { path: resolvedConfigPath, aliases: userAliases },
    presets: report,
    summary: {
      totalPresets: presets.length,
      totalTemplates: templates.length,
      conflictingPresets: conflictingPresets.length,
      aggregatedConflictAliases,
    },
  }, null, 2) + '\n');
} else {
  // Plain-text human output.
  const lines = [];
  lines.push(c.bold('User config'));
  lines.push(`  path: ${resolvedConfigPath}`);
  lines.push(`  aliases: ${userAliases.length === 0 ? c.dim('(empty)') : userAliases.map(c.cyan).join(', ')}`);
  lines.push('');
  lines.push(c.bold(`Presets (${presets.length})`));
  if (presets.length === 0) {
    lines.push(c.dim('  (no worker presets in DB — nothing to diagnose.)'));
  } else {
    for (const r of report) {
      const marker = r.conflicts.length > 0 ? c.red('●') : c.green('●');
      const verdict = r.conflicts.length > 0
        ? c.red(`${r.conflicts.length} conflict${r.conflicts.length === 1 ? '' : 's'}`)
        : c.green('clean');
      lines.push(`  ${marker} ${c.bold(r.name)} ${c.dim(`[${r.id}]`)} — ${verdict}`);
      if (r.conflicts.length > 0) {
        lines.push(`      conflicts with user config: ${r.conflicts.map(c.red).join(', ')}`);
      }
      if (r.clean.length > 0) {
        lines.push(`      ${c.dim(`clean aliases: ${r.clean.join(', ')}`)}`);
      }
      // M4-a: per-alias transport / url / bearer-env summary.
      if (r.details && r.details.length > 0) {
        for (const d of r.details) {
          if (d.transport === 'http') {
            const bearer = d.bearer_token_env_var
              ? ` ${c.dim(`(bearer env: ${d.bearer_token_env_var}=${c.yellow('***')})`)}`
              : '';
            lines.push(`      ${c.dim(`${d.alias}: http ${d.url}${bearer}`)}`);
          } else {
            lines.push(`      ${c.dim(`${d.alias}: stdio ${d.command || '(no command)'}`)}`);
          }
        }
      }
    }
  }
  lines.push('');
  lines.push(c.bold('Summary'));
  lines.push(`  total presets:        ${presets.length}`);
  lines.push(`  conflicting presets:  ${conflictingPresets.length}`);
  lines.push(`  user-config aliases:  ${userAliases.length}`);
  if (aggregatedConflictAliases.length > 0) {
    lines.push(`  conflict aliases:     ${aggregatedConflictAliases.map(c.red).join(', ')}`);
  }
  lines.push('');
  if (conflictingPresets.length > 0) {
    lines.push(c.yellow(
      'Note: at runtime these presets will emit mcp:legacy_alias_conflict events.',
    ));
    lines.push(c.dim(
      '      Codex CLI will still spawn (annotate-only) and leaf-merge the configs.',
    ));
    lines.push(c.dim(
      '      See docs/specs/worker-preset-and-plugin-injection.md §13 for M3 plans.',
    ));
  } else {
    lines.push(c.green('No conflicts. All presets are independent of the user config.'));
  }
  process.stdout.write(lines.join('\n') + '\n');
}

try { close(); } catch { /* ignore */ }

// Use process.exitCode + natural termination so piped output (CI capture,
// tee, logging) isn't truncated by an abrupt process.exit().
if (failOnConflict && conflictingPresets.length > 0) process.exitCode = 2;
} // runDiagnose
