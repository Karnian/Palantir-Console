#!/usr/bin/env node
// scripts/migration-audit.mjs
//
// READ-ONLY migration reconciliation report. Modifies NOTHING — no DB write, no
// migration file change, no runner behavior change. This is the safe first step
// of migration hardening: it establishes whether the applied-migration set that
// `schema_version` already records (one row per applied version, with
// applied_at) matches the migration files on disk, and flags the three hazards
// the current runner cannot see:
//
//   * RETROACTIVE  — a migration FILE whose version is below the applied head but
//                    is NOT in schema_version. The runner's `version <= MAX`
//                    skip (server/db/database.js) silently drops it: it never
//                    runs and is never recorded. This is the #479 / #475 / #478
//                    collision class (a boot-time `no such table` on existing
//                    deployments; invisible to the test suite, which uses a
//                    fresh DB).
//   * DUPLICATE    — two files sharing one numeric prefix.
//   * ORPHAN       — a version recorded as applied with no corresponding file
//                    (DB ahead of the binary / rewritten history / downgrade).
//
// Numeric GAPS (a number with neither a file nor an applied row) are harmless
// and reported as info only.
//
// Because `schema_version` already records the applied set per-version, NO
// lossless-cutover / baseline-backfill is needed to reconcile a live DB — the
// applied set is authoritative. This tool just reads it.
//
// Usage:
//   node scripts/migration-audit.mjs [--db <path>] [--json] [--emit-manifest]
//   npm run diagnose:migrations -- --db /path/to/palantir.db
//
// Exit code: 0 = clean, 1 = at least one RETROACTIVE / DUPLICATE / ORPHAN, or the
// DB could not be read. Safe to run in CI as a gate; safe to run against a live
// (read-only) DB copy.

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'server', 'db', 'migrations');

const args = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const dbPath = getOpt('--db', join(__dirname, '..', 'palantir.db'));
const asJson = args.includes('--json');
const emitManifest = args.includes('--emit-manifest');

// --- file manifest: {version, filename, sha256} -----------------------------
const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const manifest = [];
const byVersion = new Map();
for (const f of files) {
  const version = parseInt(f.split('_')[0], 10);
  if (Number.isNaN(version)) continue;
  const sha256 = createHash('sha256')
    .update(readFileSync(join(migrationsDir, f)))
    .digest('hex');
  manifest.push({ version, filename: f, sha256 });
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(f);
}
const duplicates = [...byVersion.entries()]
  .filter(([, fs]) => fs.length > 1)
  .map(([version, fs]) => ({ version, files: fs }));

// --- applied set from schema_version (READ-ONLY) ----------------------------
let applied = null;
let appliedErr = null;
try {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  applied = hasTable
    ? db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all()
    : [];
  db.close();
} catch (e) {
  appliedErr = e.message;
}

// --- reconcile ---------------------------------------------------------------
const report = {
  dbPath,
  fileCount: manifest.length,
  duplicates,
  appliedErr,
};

let hasFinding = duplicates.length > 0 || Boolean(appliedErr);

if (applied) {
  const appliedSet = new Set(applied.map((r) => r.version));
  const fileVersions = new Set(manifest.map((m) => m.version));
  const maxApplied = applied.length ? Math.max(...applied.map((r) => r.version)) : 0;

  const retroactive = manifest.filter(
    (m) => !appliedSet.has(m.version) && m.version < maxApplied,
  );
  const atHeadUnapplied = manifest.filter(
    (m) => !appliedSet.has(m.version) && m.version === maxApplied,
  );
  const pendingForward = manifest.filter(
    (m) => !appliedSet.has(m.version) && m.version > maxApplied,
  );
  const orphanApplied = applied.filter((r) => !fileVersions.has(r.version));

  Object.assign(report, {
    appliedCount: applied.length,
    maxApplied,
    retroactive,
    atHeadUnapplied,
    pendingForward,
    orphanApplied,
  });
  hasFinding =
    hasFinding ||
    retroactive.length > 0 ||
    atHeadUnapplied.length > 0 ||
    orphanApplied.length > 0;
}

// --- output ------------------------------------------------------------------
if (asJson) {
  console.log(JSON.stringify({ ...report, ok: !hasFinding }, null, 2));
} else if (emitManifest) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  const line = (s = '') => console.log(s);
  line(`Migration reconciliation — ${dbPath}`);
  line(`  files: ${report.fileCount}`);
  if (appliedErr) {
    line(`  ✗ could not read schema_version: ${appliedErr}`);
  } else {
    line(`  applied rows: ${report.appliedCount}  (head = ${report.maxApplied})`);
  }
  const list = (label, rows, fmt) => {
    if (!rows || rows.length === 0) return;
    line(`  ${label} (${rows.length}):`);
    for (const r of rows) line(`      ${fmt(r)}`);
  };
  if (duplicates.length) {
    line('  🔴 DUPLICATE numeric prefixes:');
    for (const d of duplicates) line(`      ${d.version}: ${d.files.join(', ')}`);
  }
  if (applied) {
    list('🔴 RETROACTIVE (below head, unrecorded — the runner would SILENTLY SKIP these)',
      report.retroactive, (m) => `${m.filename}  (v${m.version} < head ${report.maxApplied})`);
    list('🔴 AT-HEAD but unapplied', report.atHeadUnapplied, (m) => m.filename);
    list('🔴 ORPHAN applied (recorded, no file — DB ahead of binary / rewritten history)',
      report.orphanApplied, (r) => `v${r.version} applied_at ${r.applied_at}`);
    list('•  pending forward (above head — will apply normally on next boot)',
      report.pendingForward, (m) => m.filename);
  }
  line();
  line(hasFinding ? '  RESULT: findings present (exit 1)' : '  RESULT: clean (exit 0)');
}

process.exit(hasFinding ? 1 : 0);
