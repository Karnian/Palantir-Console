'use strict';

// G2 — artifact verify check evaluator (spec §5k-3). A DECLARATIVE, no-execution
// Gate 1 check: the server reads files under a workspace root and evaluates a
// static spec as a pure function. There is NO shell surface, so an Operator can
// author an artifact check safely (§6) — the worst it can express is "wrong file
// criteria", never arbitrary execution.
//
// Safety invariants:
//   - all file access is confined to workspaceRoot (isWithinRoot);
//   - symlinks are NOT followed (lstat, skip symlink entries) — a prefix guard
//     alone is insufficient (Codex R5 MINOR);
//   - the walk is bounded (max entries / depth / per-file byte read) so a
//     pathological tree cannot hang or OOM the harvest.

const fs = require('node:fs');
const path = require('node:path');
const { isWithinRoot } = require('../utils/pathGuard');

const MAX_WALK_ENTRIES = 5000;
const MAX_DEPTH = 12;
const MAX_REPORT_READ_BYTES = 256 * 1024;

// Minimal glob → RegExp. Supports `**` (any dirs), `*` (within a segment),
// `?` (one char). Everything else is literal. Anchored to the full relative path.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// Symlink-safe, bounded recursive walk. Returns relative POSIX paths of regular
// files under root. Skips symlinks and anything escaping root.
function walkFiles(root) {
  const out = [];
  let count = 0;
  const rootResolved = path.resolve(root);
  const stack = [{ dir: rootResolved, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (count >= MAX_WALK_ENTRIES) return out;
      count++;
      const abs = path.join(dir, ent.name);
      if (!isWithinRoot(rootResolved, abs)) continue;
      // Never follow symlinks — lstat classification only.
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) { stack.push({ dir: abs, depth: depth + 1 }); continue; }
      if (ent.isFile()) {
        out.push(path.relative(rootResolved, abs).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

function fileSize(root, rel) {
  try {
    const abs = path.join(root, rel);
    if (!isWithinRoot(root, abs)) return null;
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return st.size;
  } catch { return null; }
}

function evalFileRule(rule, allFiles, root) {
  const re = globToRegExp(rule.glob);
  const matched = allFiles.filter((f) => re.test(f));
  const mustExist = rule.must_exist !== false; // default true
  const minBytes = Number.isFinite(rule.min_bytes) ? rule.min_bytes : 0;
  let ok = true;
  const reasons = [];
  if (mustExist && matched.length === 0) { ok = false; reasons.push('no file matched'); }
  if (minBytes > 0) {
    const bigEnough = matched.filter((f) => (fileSize(root, f) || 0) >= minBytes);
    if (matched.length > 0 && bigEnough.length === 0) { ok = false; reasons.push(`no match >= ${minBytes} bytes`); }
    if (mustExist && bigEnough.length === 0) ok = false;
  }
  return { type: 'file', glob: rule.glob, matched: matched.slice(0, 20), match_count: matched.length, ok, reasons };
}

// Resolve the report text: an explicit report.path is read from the workspace;
// otherwise the caller-provided reportText (e.g. runs.final_output / _report.md)
// is used. Reads are bounded + within-root + non-symlink.
function resolveReportText(report, root, fallbackText) {
  if (report.path) {
    try {
      const abs = path.join(root, report.path);
      if (!isWithinRoot(root, abs)) return null;
      const st = fs.lstatSync(abs);
      if (!st.isFile()) return null;
      const fd = fs.openSync(abs, 'r');
      try {
        const len = Math.min(st.size, MAX_REPORT_READ_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, 0);
        return buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }
  return typeof fallbackText === 'string' ? fallbackText : null;
}

function evalReportRule(report, root, fallbackText) {
  const text = resolveReportText(report, root, fallbackText);
  const reasons = [];
  let ok = true;
  if (text == null) { return { type: 'report', ok: false, reasons: ['report not found'] }; }
  if (Number.isFinite(report.min_chars) && text.length < report.min_chars) {
    ok = false; reasons.push(`report < ${report.min_chars} chars`);
  }
  if (Array.isArray(report.must_contain)) {
    for (const needle of report.must_contain) {
      if (!text.includes(needle)) { ok = false; reasons.push(`missing "${String(needle).slice(0, 40)}"`); }
    }
  }
  if (report.format === 'json') {
    try { JSON.parse(text); } catch { ok = false; reasons.push('report is not valid JSON'); }
  }
  return { type: 'report', ok, reasons };
}

/**
 * Evaluate a normalized artifact spec against a workspace.
 * @param {object} spec        - normalized { files?, report? } (verifyCheckService.validateSpec output)
 * @param {object} ctx
 * @param {string} ctx.workspaceRoot - absolute dir the check reads from
 * @param {string} [ctx.reportText]  - fallback report content when report.path is absent
 * @returns {{ passed: boolean, results: object[], reason: string|null }}
 */
function evaluateArtifactCheck(spec, { workspaceRoot, reportText = null } = {}) {
  const results = [];
  if (!workspaceRoot || typeof workspaceRoot !== 'string') {
    return { passed: false, results, reason: 'no_workspace' };
  }
  const root = path.resolve(workspaceRoot);
  let allFiles = [];
  if (Array.isArray(spec.files) && spec.files.length) allFiles = walkFiles(root);

  if (Array.isArray(spec.files)) {
    for (const rule of spec.files) results.push(evalFileRule(rule, allFiles, root));
  }
  if (spec.report) results.push(evalReportRule(spec.report, root, reportText));

  const passed = results.length > 0 && results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const reason = passed ? null : (failed.flatMap((r) => r.reasons || []).join('; ') || 'no rules evaluated');
  return { passed, results, reason };
}

module.exports = { evaluateArtifactCheck, globToRegExp };
