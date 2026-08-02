#!/usr/bin/env node
// scripts/migration-audit.mjs
//
// READ-ONLY migration reconciliation report. Modifies NOTHING — no DB write, no
// migration file change, no runner behavior change. This is the safe first step
// of migration hardening: it establishes whether the applied-migration set that
// `schema_version` already records (one row per applied version, with
// applied_at) matches the migration files on disk, and flags the hazards the
// current runner cannot see:
//
//   * RETROACTIVE  — a migration FILE whose version is below the applied head but
//                    is NOT in schema_version. The runner's `version <= MAX`
//                    skip (server/db/database.js) silently drops it: it never
//                    runs and is never recorded. This is the #479 / #475 / #478
//                    collision class (a boot-time `no such table` on existing
//                    deployments; invisible to the test suite, which uses a
//                    fresh DB).
//   * DUPLICATE    — two files sharing one numeric prefix.
//   * MALFORMED    — a `.sql` file whose name is not `NNN_name.sql` with a
//                    positive integer prefix.
//   * ORPHAN       — a version recorded as applied with no corresponding file
//                    (DB ahead of the binary / rewritten history / downgrade).
//
// Numeric GAPS (a number with neither a file nor an applied row) are harmless
// and NOT reported.
//
// Because `schema_version` already records the applied set per-version, NO
// lossless-cutover / baseline-backfill is needed to reconcile a live DB — the
// applied set is authoritative. This tool just reads it. The recommended runner
// fix that this audit motivates: skip on set-membership (`appliedSet.has(v)`)
// instead of `v <= MAX`, and FAIL LOUD on a RETROACTIVE file (require a
// renumber) instead of silently skipping. A per-migration content checksum
// (to catch an already-applied migration whose file later changed) is a
// separate, optional hardening for when the runner is changed — out of scope
// for this read-only step.
//
// Usage:
//   node scripts/migration-audit.mjs [--db <path>] [--json] [--emit-manifest] [--allow-uninitialized]
//   npm run diagnose:migrations -- --db /path/to/palantir.db
//
// Auditing a LIVE production DB: do not copy the bare `.db` file (WAL contents
// may be omitted / inconsistent). Take a consistent snapshot first with
// `VACUUM INTO 'copy.db'` or `sqlite3 live.db ".backup copy.db"`, then point
// --db at the snapshot.
//
// Exit code: 0 = clean, 1 = at least one RETROACTIVE / DUPLICATE / MALFORMED /
// ORPHAN, or the DB could not be read. Safe to run in CI as a gate; safe to run
// against a read-only snapshot of a live DB.

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
const allowUninitialized = args.includes('--allow-uninitialized');

// --- file manifest: {version, filename, sha256} -----------------------------
// Strict: NNN_name.sql with a POSITIVE integer prefix. Anything else is
// MALFORMED (do not inherit parseInt's permissiveness).
const NAME_RE = /^(\d+)_.+\.sql$/;
const sqlFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
const manifest = [];
const malformed = [];
const byVersion = new Map();
for (const f of sqlFiles) {
  const m = NAME_RE.exec(f);
  const version = m ? parseInt(m[1], 10) : NaN;
  if (!m || !Number.isInteger(version) || version <= 0) {
    malformed.push(f);
    continue;
  }
  const sha256 = createHash('sha256')
    .update(readFileSync(join(migrationsDir, f))) // read each file exactly once
    .digest('hex');
  manifest.push({ version, filename: f, sha256 });
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(f);
}
manifest.sort((a, b) => a.version - b.version); // numeric, not lexical
const duplicates = [...byVersion.entries()]
  .filter(([, fs]) => fs.length > 1)
  .map(([version, fs]) => ({ version, files: fs.slice().sort() }));

// --- applied set from schema_version (READ-ONLY) ----------------------------
let applied = null;
let appliedErr = null;
try {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON'); // belt-and-suspenders: reject any write
  const hasSchemaVersion = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (hasSchemaVersion) {
    applied = db
      .prepare('SELECT version, applied_at FROM schema_version ORDER BY version')
      .all();
  } else {
    // Missing table is only safe for a genuinely uninitialized DB. An existing
    // DB that already has tables but no schema_version is a real anomaly.
    const otherTables = db
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get().n;
    if (otherTables > 0 && !allowUninitialized) {
      appliedErr = `no schema_version table but DB has ${otherTables} other table(s) — pass --allow-uninitialized to treat as empty`;
    } else {
      applied = [];
    }
  }
  db.close();
} catch (e) {
  appliedErr = e.message;
}

// --- reconcile ---------------------------------------------------------------
const report = { dbPath, fileCount: manifest.length, malformed, duplicates, appliedErr };
let hasFinding = duplicates.length > 0 || malformed.length > 0 || Boolean(appliedErr);

if (applied) {
  const appliedSet = new Set(applied.map((r) => r.version));
  const fileVersions = new Set(manifest.map((m) => m.version));
  const maxApplied = applied.length ? Math.max(...applied.map((r) => r.version)) : null;

  const retroactive =
    maxApplied === null
      ? []
      : manifest.filter((m) => !appliedSet.has(m.version) && m.version < maxApplied);
  const pendingForward =
    maxApplied === null
      ? manifest.slice()
      : manifest.filter((m) => !appliedSet.has(m.version) && m.version > maxApplied);
  const orphanApplied = applied.filter((r) => !fileVersions.has(r.version));

  Object.assign(report, {
    appliedCount: applied.length,
    maxApplied,
    retroactive,
    pendingForward,
    orphanApplied,
  });
  hasFinding = hasFinding || retroactive.length > 0 || orphanApplied.length > 0;
}

// --- output ------------------------------------------------------------------
if (emitManifest) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(hasFinding ? 1 : 0);
}
if (asJson) {
  console.log(JSON.stringify({ ...report, ok: !hasFinding }, null, 2));
  process.exit(hasFinding ? 1 : 0);
}

const line = (s = '') => console.log(s);
line(`Migration reconciliation — ${dbPath}`);
line(`  files: ${report.fileCount}`);
if (appliedErr) {
  line(`  ✗ could not read applied set: ${appliedErr}`);
} else {
  line(`  applied rows: ${report.appliedCount}  (head = ${report.maxApplied ?? 'none'})`);
}
if (malformed.length) {
  line(`  🔴 MALFORMED filenames (not NNN_name.sql):`);
  for (const f of malformed) line(`      ${f}`);
}
if (duplicates.length) {
  line('  🔴 DUPLICATE numeric prefixes:');
  for (const d of duplicates) line(`      ${d.version}: ${d.files.join(', ')}`);
}
const list = (label, rows, fmt) => {
  if (!rows || rows.length === 0) return;
  line(`  ${label} (${rows.length}):`);
  for (const r of rows) line(`      ${fmt(r)}`);
};
if (applied) {
  list(
    '🔴 RETROACTIVE (below head, unrecorded — the runner would SILENTLY SKIP these)',
    report.retroactive,
    (m) => `${m.filename}  (v${m.version} < head ${report.maxApplied})`,
  );
  list(
    '🔴 ORPHAN applied (recorded, no file — DB ahead of binary / rewritten history)',
    report.orphanApplied,
    (r) => `v${r.version} applied_at ${r.applied_at}`,
  );
  list(
    '•  pending forward (above head — will apply normally on next boot)',
    report.pendingForward,
    (m) => m.filename,
  );
}
line();
line(hasFinding ? '  RESULT: findings present (exit 1)' : '  RESULT: clean (exit 0)');
process.exit(hasFinding ? 1 : 0);
