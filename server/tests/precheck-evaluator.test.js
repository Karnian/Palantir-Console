'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MAX_WALK_ENTRIES,
  MAX_DEPTH,
  MAX_REPORT_READ_BYTES,
  evaluateArtifactSpec,
  evaluateArtifactCheck,
} = require('../services/artifactCheck');
const {
  MAX_DETAIL_BYTES,
  evaluateArtifactPrecheck,
} = require('../services/precheckEvaluator');

function tempDir(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('artifactCheck wrapper delegates to the pure core without changing the legacy result shape', (t) => {
  const root = tempDir(t, 'artifact-pure-core-');
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(root, 'report.md'), 'SHIPPED\n');
  const spec = {
    files: [{ glob: 'dist/*.js', must_exist: true, min_bytes: 10 }],
    report: { path: 'report.md', must_contain: ['SHIPPED'] },
  };

  const legacy = evaluateArtifactCheck(spec, { workspaceRoot: root });
  const pure = evaluateArtifactSpec(spec, {
    files: [{ rel: 'dist/app.js', size: 16 }],
    reportText: 'SHIPPED\n',
  });
  const golden = {
    passed: true,
    results: [
      {
        type: 'file', glob: 'dist/*.js', matched: ['dist/app.js'],
        match_count: 1, ok: true, reasons: [],
      },
      { type: 'report', ok: true, reasons: [] },
    ],
    reason: null,
  };
  assert.deepEqual(legacy, golden);
  assert.deepEqual(pure, golden);
});

test('§7 #21c remote executor evaluates artifact pass and fail without accepting dirs or symlinks', async () => {
  const calls = [];
  const executor = {
    async listFilesWithSizes(root, options) {
      calls.push(['list', root, options]);
      return {
        records: [
          'd\t0\tdist',
          'l\t99\tdist/leak.js',
          'f\t32\tdist/app.js',
        ],
      };
    },
    async readFileCapped(file, cap) {
      calls.push(['read', file, cap]);
      return Buffer.from('READY secret-value-never-persists');
    },
  };
  const passSpec = {
    files: [{ glob: 'dist/*.js', must_exist: true, min_bytes: 16 }],
    report: { path: 'report.md', must_contain: ['READY'] },
  };
  const passed = await evaluateArtifactPrecheck({
    checkId: 7,
    spec: passSpec,
    nodeId: 'node-a',
    workspaceRoot: '/srv/project',
    executor,
    remote: true,
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.detail.results[0].matched, 1);
  assert.equal(JSON.stringify(passed.detail).includes('dist/app.js'), false);
  assert.equal(JSON.stringify(passed.detail).includes('secret-value'), false);

  const failed = await evaluateArtifactPrecheck({
    checkId: 8,
    spec: { files: [{ glob: 'dist/*.js', min_bytes: 64 }], report: null },
    nodeId: 'node-a',
    workspaceRoot: '/srv/project',
    executor,
    remote: true,
  });
  assert.equal(failed.passed, false);
  assert.equal(failed.detail.results[0].reason, 'min_bytes_not_met');
  assert.deepEqual(calls, [
    ['list', '/srv/project', { maxEntries: MAX_WALK_ENTRIES }],
    ['read', '/srv/project/report.md', MAX_REPORT_READ_BYTES],
    ['list', '/srv/project', { maxEntries: MAX_WALK_ENTRIES }],
  ]);
  assert.ok(Buffer.byteLength(JSON.stringify(passed.detail), 'utf8') <= MAX_DETAIL_BYTES);
});

test('§7 #21d local and remote evaluators enforce identical walk entry and depth boundaries', async (t) => {
  const entriesRoot = tempDir(t, 'artifact-entry-cap-');
  for (let i = 0; i < MAX_WALK_ENTRIES + 1; i += 1) {
    fs.writeFileSync(path.join(entriesRoot, `f${String(i).padStart(5, '0')}.txt`), 'x');
  }
  const filesSpec = { files: [{ glob: '*.txt' }], report: null };
  const localEntries = evaluateArtifactCheck(filesSpec, { workspaceRoot: entriesRoot });
  const remoteEntries = await evaluateArtifactPrecheck({
    checkId: 1,
    spec: filesSpec,
    nodeId: 'node-a',
    workspaceRoot: '/srv/project',
    remote: true,
    executor: {
      async listFilesWithSizes(_root, { maxEntries }) {
        assert.equal(maxEntries, MAX_WALK_ENTRIES);
        return Array.from(
          { length: MAX_WALK_ENTRIES + 1 },
          (_, i) => `f\t1\tf${String(i).padStart(5, '0')}.txt`,
        );
      },
    },
  });
  assert.equal(localEntries.results[0].match_count, MAX_WALK_ENTRIES);
  assert.equal(remoteEntries.detail.results[0].matched, MAX_WALK_ENTRIES);

  const depthRoot = tempDir(t, 'artifact-depth-cap-');
  let cursor = depthRoot;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    cursor = path.join(cursor, `d${i}`);
    fs.mkdirSync(cursor);
  }
  fs.writeFileSync(path.join(cursor, 'inside.txt'), 'x');
  const tooDeepDir = path.join(cursor, 'too-deep');
  fs.mkdirSync(tooDeepDir);
  fs.writeFileSync(path.join(tooDeepDir, 'outside.txt'), 'x');
  const deepSpec = { files: [{ glob: '**/*.txt' }], report: null };
  const localDepth = evaluateArtifactCheck(deepSpec, { workspaceRoot: depthRoot });
  const allowed = [...Array(MAX_DEPTH).keys()].map((i) => `d${i}`).join('/');
  const remoteDepth = await evaluateArtifactPrecheck({
    checkId: 2,
    spec: deepSpec,
    nodeId: 'node-a',
    workspaceRoot: '/srv/project',
    remote: true,
    executor: {
      async listFilesWithSizes() {
        return { records: [
          `f\t1\t${allowed}/inside.txt`,
          `f\t1\t${allowed}/too-deep/outside.txt`,
        ] };
      },
    },
  });
  assert.equal(localDepth.results[0].match_count, 1);
  assert.equal(remoteDepth.detail.results[0].matched, 1);
});

test('§7 #21d local and remote report reads share the exact byte cap', async (t) => {
  const root = tempDir(t, 'artifact-report-cap-');
  const hidden = 'AFTER_THE_CAP';
  fs.writeFileSync(path.join(root, 'report.txt'), `${'a'.repeat(MAX_REPORT_READ_BYTES)}${hidden}`);
  const spec = { files: [], report: { path: 'report.txt', must_contain: [hidden] } };
  const local = evaluateArtifactCheck(spec, { workspaceRoot: root });
  let requestedCap = null;
  const remote = await evaluateArtifactPrecheck({
    checkId: 3,
    spec,
    nodeId: 'node-a',
    workspaceRoot: '/srv/project',
    remote: true,
    executor: {
      async readFileCapped(_file, cap) {
        requestedCap = cap;
        return Buffer.from(`${'a'.repeat(cap)}${hidden}`);
      },
    },
  });
  assert.equal(requestedCap, MAX_REPORT_READ_BYTES);
  assert.equal(local.passed, false);
  assert.equal(remote.passed, false);
  assert.equal(JSON.stringify(remote.detail).includes(hidden), false);
});

test('an unreadable local root is a retryable error, not a failed condition', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-unreadable-'));
  const root = path.join(dir, 'locked');
  fs.mkdirSync(root);
  fs.chmodSync(root, 0o000);
  t.after(() => {
    try { fs.chmodSync(root, 0o755); } catch { /* already restored */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (process.getuid && process.getuid() === 0) return; // root ignores the mode bits

  // stat() would say "yes, a directory" and let the walker swallow the EACCES,
  // turning an infrastructure fault into a terminal "no file matched" — while
  // the remote path throws and retries. Both must classify the same way.
  await assert.rejects(
    () => evaluateArtifactPrecheck({
      checkId: 1,
      spec: { files: [{ glob: 'ready.txt', must_exist: true }], report: null },
      workspaceRoot: root,
    }),
    /not traversable/,
  );
});
