// Shared jsdom + Preact/HTM test helper.
//
// Creates an isolated jsdom instance with Preact UMD bundles loaded into a
// vm.createContext sandbox.  Each call to createPreactEnv() returns a fresh
// environment so tests never leak state to each other.

'use strict';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const VENDOR_DIR = path.join(__dirname, '..', '..', 'public', 'vendor');
const COMPONENTS_DIR = path.join(__dirname, '..', '..', 'public', 'app', 'components');
const APP_LIB_DIR = path.join(__dirname, '..', '..', 'public', 'app', 'lib');

// Read UMD sources once — they are reused across every createPreactEnv call.
const preactSrc = fs.readFileSync(path.join(VENDOR_DIR, 'preact.umd.js'), 'utf8');
const hooksSrc = fs.readFileSync(path.join(VENDOR_DIR, 'hooks.umd.js'), 'utf8');
const htmSrc = fs.readFileSync(path.join(VENDOR_DIR, 'htm.umd.js'), 'utf8');

// Phase K-1b: components increasingly read user-facing copy from
// app/lib/copy.js (semantic key lookup pattern enforced K-1a onwards).
// loadComponent() strips relative imports, so the named exports would
// land as `undefined` inside the vm sandbox and components throw at
// render time when reading e.g. `DRIFT_LABELS.title`. We pre-load the
// copy module's named exports into every createPreactEnv() context so
// any component using copy keys works in jsdom without per-test stubs.
const copySrc = fs.readFileSync(path.join(APP_LIB_DIR, 'copy.js'), 'utf8');

/**
 * Load an ES-module component file into a vm context by stripping `export`
 * keywords and `import` statements.  Vendor imports (preact, hooks, htm)
 * are replaced with equivalent destructuring from `window.*` globals that
 * are already available in the vm context (set by the UMD bundles).
 * Local relative imports are stripped entirely (the caller must pre-load
 * any dependencies into the context manually).
 *
 * @param {string} componentName  e.g. 'Dropdown', 'MentionInput'
 * @param {object} context        vm context to evaluate in
 */
function loadComponent(componentName, context) {
  const filePath = path.join(COMPONENTS_DIR, `${componentName}.js`);
  const raw = fs.readFileSync(filePath, 'utf8');

  const transformed = raw
    // Strip leading `export` from `export function Foo` declarations.
    // The `g` flag handles files with multiple exported functions.
    .replace(/^export\s+function\s+/gm, 'function ')
    // Replace `import { h, ... } from '../../vendor/preact.module.js';`
    // with `const { h, ... } = window.preact;`
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]*preact\.module\.js['"];?\s*$/gm,
      (_, names) => `const {${names}} = window.preact;`)
    // Replace `import { useState, ... } from '../../vendor/hooks.module.js';`
    // with `const { useState, ... } = window.preactHooks;`
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]*hooks\.module\.js['"];?\s*$/gm,
      (_, names) => `const {${names}} = window.preactHooks;`)
    // Replace `import htm from '../../vendor/htm.module.js';`
    // with `var htm = window.htm;`
    .replace(/^import\s+htm\s+from\s+['"][^'"]*htm\.module\.js['"];?\s*$/gm,
      'var htm = window.htm;')
    // Strip side-effect-only relative imports first
    // (`import './foo.js';` / `import "../bar.js";`). Doing this before
    // the named-import multi-line strip prevents the next regex from
    // greedily swallowing a side-effect line plus the following named
    // import as one match (which would leave the file syntactically
    // broken — Codex K-1b review NIT).
    .replace(/^import\s+['"]\.\.?\/[^'"]+['"];?\s*$/gm, '// [stripped side-effect import]')
    // Strip remaining local relative named imports (e.g. from '../lib/...').
    // The named-import body may span multiple lines
    // (`import {\n  foo,\n  bar,\n} from '../lib/foo.js';`). The
    // alternation `(?:\{[\s\S]*?\}|\w[\w$]*(?:\s*,\s*\{[\s\S]*?\})?)`
    // restricts the match to one of:
    //   1. brace-only:    `import { a, b } from '...';`
    //   2. default-only:  `import foo from '...';`
    //   3. default+named: `import foo, { bar } from '...';`
    // and refuses bare side-effect imports (already handled above), so
    // we never accidentally bridge two import statements.
    .replace(/^import\s+(?:\{[\s\S]*?\}|\w[\w$]*(?:\s*,\s*\{[\s\S]*?\})?)\s+from\s+['"]\.\.?\/[^'"]+['"];?\s*$/gm, '// [stripped import]')
    + `\nthis.${componentName} = ${componentName};`;

  vm.runInContext(transformed, context);
}

/**
 * Create a fresh jsdom + Preact environment.
 *
 * @returns {{ window, document, context, h, html, render, loadComponent: (name: string) => void }}
 */
function createPreactEnv() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost', pretendToBeVisual: true },
  );
  const { window } = dom;
  const context = vm.createContext(window);

  // hooks UMD expects require('preact') in CJS environments
  context.require = (m) => {
    if (m === 'preact') return context.preact;
    return require(m);
  };

  vm.runInContext(preactSrc, context);
  vm.runInContext(hooksSrc, context);
  vm.runInContext(htmSrc, context);

  // The vm context IS the jsdom window object, so `window.preact` and
  // `window.preactHooks` are already accessible (set by the UMD bundles).
  // htm UMD sets `self.htm` — ensure it's also reachable as `this.htm`.
  vm.runInContext('this.htm = htm;', context);

  // Mount copy.js named exports as bare globals so loadComponent()'s
  // import-stripping doesn't leave components with undefined references.
  // We strip `export` from `export const FOO = …` declarations and
  // `export function …` so each top-level binding becomes a plain
  // sandbox global. Any future copy.js export shape is supported as
  // long as it's `export const` or `export function`.
  const copyTransformed = copySrc
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  vm.runInContext(copyTransformed, context);

  const { h, render } = context.preact;
  const html = context.htm.bind(h);

  return {
    window,
    document: window.document,
    context,
    h,
    html,
    render,
    /** Load a component from server/public/app/components/<name>.js */
    loadComponent: (name) => loadComponent(name, context),
    /** Tear down the jsdom instance — call in after() to prevent resource leaks. */
    cleanup: () => dom.window.close(),
  };
}

/**
 * Wait for Preact's useEffect queue (scheduled via setTimeout) to flush.
 */
function flushEffects(ms = 100) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createPreactEnv, flushEffects, loadComponent, VENDOR_DIR, COMPONENTS_DIR };
