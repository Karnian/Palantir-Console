// Regression tests for `transformComponentSource` (helpers/jsdom-preact.js).
//
// Phase Post-K Cleanup (2026-04-28): adds a Codex K-1b r1 NIT — pin the
// import-strip behavior so a future regex tweak can't silently bridge
// two adjacent imports or misroute vendor imports. These run without
// jsdom; they assert source-level rewrites.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transformComponentSource } = require('./helpers/jsdom-preact');

test('transform: export function → function', () => {
  const src = `export function Foo() { return 1; }\nexport function Bar() { return 2; }`;
  const out = transformComponentSource(src);
  assert.match(out, /^function Foo\(\)/m);
  assert.match(out, /^function Bar\(\)/m);
  assert.doesNotMatch(out, /^export\s+function/m);
});

test('transform: vendor preact import → window.preact destructure', () => {
  const src = `import { h, Component } from '../../vendor/preact.module.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /var \{ h, Component \} = window\.preact;/);
});

test('transform: vendor hooks import → window.preactHooks destructure', () => {
  const src = `import { useState, useEffect } from '../../vendor/hooks.module.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /var \{ useState, useEffect \} = window\.preactHooks;/);
});

test('transform: top-level const/let → var (multi-load: sibling components share one vm context)', () => {
  const src = [
    "const html = htm.bind(h);",
    "let counter = 0;",
    "function Foo() { const local = 1; return local; }",
  ].join('\n');
  const out = transformComponentSource(src);
  // Top-level (column-0) const/let become var so a second component loaded
  // into the same context doesn't throw "Identifier already declared".
  assert.match(out, /^var html = htm\.bind\(h\);/m);
  assert.match(out, /^var counter = 0;/m);
  // Block-scoped (indented) declarations are untouched.
  assert.match(out, /const local = 1;/);
});

test('transform: vendor htm default import → window.htm', () => {
  const src = `import htm from '../../vendor/htm.module.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /var htm = window\.htm;/);
});

test('transform: relative named import → stripped marker', () => {
  const src = `import { foo } from '../lib/foo.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /\/\/ \[stripped import\]/);
  assert.doesNotMatch(out, /^import\s+\{ foo \}/m);
});

test('transform: multi-line named import → stripped (matches across lines)', () => {
  const src = [
    "import {",
    "  COMMON_ACTIONS,",
    "  TASK_STATUS_LABELS,",
    "  statusLabel,",
    "} from '../lib/copy.js';",
  ].join('\n');
  const out = transformComponentSource(src);
  assert.match(out, /\/\/ \[stripped import\]/);
  assert.doesNotMatch(out, /COMMON_ACTIONS,/);
});

test('transform: default-only relative import → stripped', () => {
  const src = `import EmptyState from '../components/EmptyState.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /\/\/ \[stripped import\]/);
});

test('transform: default+named relative import → stripped', () => {
  const src = `import EmptyState, { TYPES } from '../components/EmptyState.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /\/\/ \[stripped import\]/);
});

test('transform: side-effect-only relative import → stripped (separate marker)', () => {
  const src = `import './polyfills.js';`;
  const out = transformComponentSource(src);
  assert.match(out, /\/\/ \[stripped side-effect import\]/);
});

test('transform: side-effect-only relative import + adjacent named import → both stripped independently', () => {
  // Codex K-1b r1 NIT regression: the multi-line `[\s\S]*?` named-import
  // regex used to greedily bridge a side-effect line and the following
  // named import into one match, leaving the file half-stripped. The
  // fix orders the two regexes so side-effect runs first and the named
  // regex's alternation refuses bare quoted strings.
  const src = [
    `import './side-effect.js';`,
    `import { foo } from '../lib/foo.js';`,
  ].join('\n');
  const out = transformComponentSource(src);
  // Both lines stripped, with their own markers.
  assert.match(out, /\/\/ \[stripped side-effect import\]/);
  assert.match(out, /\/\/ \[stripped import\]/);
  // No partial residue.
  assert.doesNotMatch(out, /import\s+['"]\.\/side-effect\.js['"]/);
  assert.doesNotMatch(out, /import\s+\{\s*foo\s*\}/);
});

test('transform: non-relative bare imports (e.g. preact, react) are NOT stripped', () => {
  // These shouldn't appear in repo source after vendor rewrites, but
  // verify the regex doesn't accidentally strip non-relative imports.
  const src = `import { something } from 'preact';`;
  const out = transformComponentSource(src);
  assert.match(out, /^import\s+\{ something \}\s+from\s+['"]preact['"]/m);
  assert.doesNotMatch(out, /\/\/ \[stripped import\]/);
});

test('transform: idempotent — running twice is a no-op', () => {
  const src = `import { COMMON_ACTIONS } from '../lib/copy.js';\nexport function Foo() {}`;
  const once = transformComponentSource(src);
  const twice = transformComponentSource(once);
  assert.equal(once, twice, 'transform should be idempotent on already-transformed source');
});
