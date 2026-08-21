'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_WALK_ENTRIES,
  MAX_DEPTH,
  MAX_REPORT_READ_BYTES,
  evaluateArtifactSpec,
  evaluateArtifactCheck,
} = require('./artifactCheck');
const { canonicalSpecHash } = require('./verifyCheckService');

const MAX_DETAIL_BYTES = 2 * 1024;

function parseRemoteRecord(record) {
  if (typeof record === 'string') {
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) return null;
    return {
      type: record.slice(0, first),
      size: Number(record.slice(first + 1, second)),
      rel: record.slice(second + 1),
    };
  }
  if (!record || typeof record !== 'object') return null;
  return {
    // Fail CLOSED: a record that does not say what it is never counts as a
    // regular file. Defaulting to 'f' here would silently admit directories and
    // symlinks from any transport that omits the field.
    type: record.type || record.kind || 'unknown',
    size: Number(record.size),
    rel: record.rel ?? record.relPath ?? record.path,
  };
}

function remoteRecords(listing) {
  if (Array.isArray(listing)) return listing;
  if (Array.isArray(listing?.records)) return listing.records;
  if (Array.isArray(listing?.files)) return listing.files;
  if (typeof listing === 'string' || Buffer.isBuffer(listing)) {
    return String(listing).split(listing.includes?.('\0') ? '\0' : /\r?\n/).filter(Boolean);
  }
  return [];
}

function normalizeRemoteFiles(listing) {
  const files = [];
  for (const raw of remoteRecords(listing).slice(0, MAX_WALK_ENTRIES)) {
    const record = parseRemoteRecord(raw);
    if (!record || record.type !== 'f') continue;
    if (!Number.isFinite(record.size) || record.size < 0) continue;
    if (typeof record.rel !== 'string' || !record.rel || record.rel.startsWith('/')) continue;
    const segments = record.rel.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) continue;
    // The local walker calls a root-level file depth 0, so N path segments are
    // at depth N-1. Keep that exact boundary even though remote find has no
    // maxdepth option.
    if (segments.length - 1 > MAX_DEPTH) continue;
    files.push({ rel: record.rel, size: record.size });
  }
  return files;
}

function resultReasonCode(result) {
  if (result.ok) return 'matched';
  if (result.type === 'file') {
    if (result.match_count === 0) return 'no_match';
    return 'min_bytes_not_met';
  }
  const reasons = result.reasons || [];
  if (reasons.includes('report not found')) return 'report_not_found';
  if (reasons.includes('report is not valid JSON')) return 'invalid_json';
  if (reasons.some((reason) => reason.startsWith('report < '))) return 'min_chars_not_met';
  if (reasons.some((reason) => reason.startsWith('missing "'))) return 'required_text_missing';
  return 'condition_not_met';
}

function boundedDetail({ checkId, specHash, evaluator, nodeId, durationMs, evaluation }) {
  const detail = {
    check_id: checkId,
    spec_hash: specHash,
    kind: 'artifact',
    evaluator,
    node_id: nodeId,
    duration_ms: Math.max(0, Math.round(Number(durationMs) || 0)),
    reason_code: evaluation.passed ? 'passed' : 'condition_not_met',
    // Paths, report text, must_contain values, and raw executor output are
    // intentionally absent. `matched` is a count, never a filename list.
    results: evaluation.results.slice(0, 20).map((result) => ({
      glob: result.type === 'file' ? result.glob : null,
      matched: result.type === 'file' ? Number(result.match_count || 0) : Boolean(result.ok),
      reason: resultReasonCode(result),
    })),
  };
  while (detail.results.length && Buffer.byteLength(JSON.stringify(detail), 'utf8') > MAX_DETAIL_BYTES) {
    detail.results.pop();
  }
  if (Buffer.byteLength(JSON.stringify(detail), 'utf8') > MAX_DETAIL_BYTES) {
    // Fixed-size fields are already tightly bounded by their source schemas;
    // this remains a fail-closed guard if those schemas change later.
    detail.spec_hash = String(specHash || '').slice(0, 64);
    detail.node_id = String(nodeId || '').slice(0, 120);
    detail.results = [];
  }
  return detail;
}

async function evaluateArtifactPrecheck({
  checkId,
  spec,
  nodeId = 'local',
  workspaceGeneration = null,
  workspaceRoot,
  executor = null,
  remote = false,
  reportText = null,
  nowMs = () => Date.now(),
} = {}) {
  const startedAt = nowMs();
  const evaluatedSpecHash = canonicalSpecHash(spec);
  let evaluation;
  let evaluator;

  if (remote) {
    evaluator = 'executor';
    let files = [];
    if (Array.isArray(spec.files) && spec.files.length) {
      if (!executor || typeof executor.listFilesWithSizes !== 'function') {
        throw new Error('precheck executor does not implement listFilesWithSizes');
      }
      const listing = await executor.listFilesWithSizes(workspaceRoot, {
        maxEntries: MAX_WALK_ENTRIES,
      });
      files = normalizeRemoteFiles(listing);
    }
    let resolvedReportText = reportText;
    if (spec.report?.path) {
      if (!executor || typeof executor.readFileCapped !== 'function') {
        throw new Error('precheck executor does not implement readFileCapped');
      }
      const reportPath = spec.report.path;
      const reportSegments = typeof reportPath === 'string' ? reportPath.split('/') : [];
      if (!reportSegments.length
        || path.posix.isAbsolute(reportPath)
        || reportSegments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw new Error('precheck report path is not a safe relative path');
      }
      const absoluteReportPath = path.posix.join(workspaceRoot, reportPath);
      const raw = await executor.readFileCapped(absoluteReportPath, MAX_REPORT_READ_BYTES);
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      resolvedReportText = buffer.subarray(0, MAX_REPORT_READ_BYTES).toString('utf8');
    }
    evaluation = evaluateArtifactSpec(spec, { files, reportText: resolvedReportText });
  } else {
    evaluator = 'local';
    // A missing/unreadable ROOT is infrastructure, not a failed condition. The
    // walker swallows readdir errors and returns [], so without this probe an
    // unmounted or not-yet-materialized directory reads as "no file matched"
    // and terminalizes the occurrence instead of retrying — and the same state
    // is retried on the remote path, so the two would classify differently.
    // readdir, not stat: stat only answers "is it a directory", so a root that
    // exists but is unreadable (permissions, I/O error) would still fall through
    // to the walker, get swallowed, and terminalize as "no file matched" — while
    // the remote path throws and retries. Probing the actual traversal is what
    // makes the two classifications identical.
    let probe = null;
    try {
      // Bounded: open the directory and read ONE entry. `readdirSync` would load
      // every name in the root into memory before the walker's MAX_WALK_ENTRIES
      // budget ever applies — the same unbounded-enumerate trap G2 closed with
      // opendirSync streaming. One entry is enough to prove traversability.
      probe = fs.opendirSync(workspaceRoot);
      probe.readSync();
    } catch (err) {
      throw new Error(`precheck workspace root is not traversable: ${err.code || err.message}`);
    } finally {
      if (probe) { try { probe.closeSync(); } catch { /* best effort */ } }
    }
    evaluation = evaluateArtifactCheck(spec, { workspaceRoot, reportText });
  }

  const durationMs = nowMs() - startedAt;
  return {
    passed: evaluation.passed,
    detail: boundedDetail({
      checkId,
      specHash: evaluatedSpecHash,
      evaluator,
      nodeId,
      durationMs,
      evaluation,
    }),
    evaluated: {
      evaluatedSpecHash,
      evaluatedNodeId: nodeId,
      evaluatedWorkspaceGeneration: workspaceGeneration == null
        ? null
        : String(workspaceGeneration),
    },
  };
}

module.exports = {
  MAX_DETAIL_BYTES,
  normalizeRemoteFiles,
  evaluateArtifactPrecheck,
};
