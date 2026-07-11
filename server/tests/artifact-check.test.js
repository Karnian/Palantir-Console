// G2 — artifactCheck evaluator: declarative file/report checks, path safety,
// symlink refusal. Pure(ish) — reads a temp workspace only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { evaluateArtifactCheck, globToRegExp } = require('../services/artifactCheck');

function ws(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-artcheck-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('globToRegExp: *, **, ? semantics', () => {
  assert.ok(globToRegExp('*.js').test('a.js'));
  assert.ok(!globToRegExp('*.js').test('sub/a.js'));
  assert.ok(globToRegExp('**/*.js').test('sub/deep/a.js'));
  assert.ok(globToRegExp('dist/*.js').test('dist/a.js'));
  assert.ok(globToRegExp('a?.txt').test('ab.txt'));
  assert.ok(!globToRegExp('a?.txt').test('abc.txt'));
});

test('files rule: must_exist + min_bytes', (t) => {
  const root = ws(t, { 'dist/app.js': 'x'.repeat(50), 'README.md': 'hi' });
  const pass = evaluateArtifactCheck({ files: [{ glob: 'dist/*.js', must_exist: true, min_bytes: 10 }] }, { workspaceRoot: root });
  assert.equal(pass.passed, true);
  const failMissing = evaluateArtifactCheck({ files: [{ glob: 'dist/*.ts', must_exist: true }] }, { workspaceRoot: root });
  assert.equal(failMissing.passed, false);
  const failSize = evaluateArtifactCheck({ files: [{ glob: 'README.md', min_bytes: 1000 }] }, { workspaceRoot: root });
  assert.equal(failSize.passed, false);
});

test('report rule: min_chars, must_contain, json format', (t) => {
  const root = ws(t, {});
  const okReport = evaluateArtifactCheck(
    { report: { min_chars: 3, must_contain: ['DONE'], format: 'text' } },
    { workspaceRoot: root, reportText: 'all DONE here' });
  assert.equal(okReport.passed, true);
  const missing = evaluateArtifactCheck(
    { report: { must_contain: ['SHIPPED'] } },
    { workspaceRoot: root, reportText: 'nope' });
  assert.equal(missing.passed, false);
  const badJson = evaluateArtifactCheck({ report: { format: 'json' } }, { workspaceRoot: root, reportText: 'not json' });
  assert.equal(badJson.passed, false);
  const goodJson = evaluateArtifactCheck({ report: { format: 'json' } }, { workspaceRoot: root, reportText: '{"a":1}' });
  assert.equal(goodJson.passed, true);
});

test('report.path reads from workspace within root', (t) => {
  const root = ws(t, { '_report.md': '# Result\nSHIPPED it' });
  const r = evaluateArtifactCheck({ report: { path: '_report.md', must_contain: ['SHIPPED'] } }, { workspaceRoot: root });
  assert.equal(r.passed, true);
});

test('symlinks are NOT followed (no escape via link)', (t) => {
  const root = ws(t, { 'real.txt': 'in-root' });
  // a symlink pointing outside the workspace must be ignored by the walk
  const secret = path.join(os.tmpdir(), `secret-${Date.now()}.txt`);
  fs.writeFileSync(secret, 'SENSITIVE');
  t.after(() => { try { fs.unlinkSync(secret); } catch {} });
  try { fs.symlinkSync(secret, path.join(root, 'link.txt')); } catch { return; /* symlink perms — skip */ }
  const r = evaluateArtifactCheck({ files: [{ glob: 'link.txt', must_exist: true }] }, { workspaceRoot: root });
  assert.equal(r.passed, false, 'symlinked file is not counted (not followed)');
});

test('no rules → not passed (fail-closed)', (t) => {
  const root = ws(t, { 'a.txt': 'x' });
  const r = evaluateArtifactCheck({ files: [] }, { workspaceRoot: root });
  assert.equal(r.passed, false);
  const noWs = evaluateArtifactCheck({ report: { min_chars: 1 } }, {});
  assert.equal(noWs.passed, false);
  assert.equal(noWs.reason, 'no_workspace');
});
