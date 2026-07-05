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
const nodeUiSrc = fs.readFileSync(path.join(APP_LIB_DIR, 'nodeUi.js'), 'utf8');
// N1-C: data hooks (useNodeSummary et al.) are referenced by DashboardView /
// ManagerView as stripped-import free variables. Preload the module so the
// real hook implementations exist as sandbox globals; they resolve
// `apiFetch` / `sseBroker` at call time, so per-test stubs keep working.
const dataHooksSrc = fs.readFileSync(path.join(APP_LIB_DIR, 'hooks', 'data.js'), 'utf8');

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
/**
 * Pure transform of a component source for vm evaluation. Exported so
 * regression tests can pin the import-strip behavior without spinning
 * up a jsdom sandbox (Phase Post-K Cleanup, 2026-04-28).
 *
 *   - `export function Foo` → `function Foo`
 *   - `import {…} from '…/preact.module.js'` → `const {…} = window.preact;`
 *   - `import {…} from '…/hooks.module.js'` → `const {…} = window.preactHooks;`
 *   - `import htm from '…/htm.module.js'` → `var htm = window.htm;`
 *   - Side-effect-only relative imports (`import './foo.js';`) →
 *     stripped first so the next regex never bridges two adjacent
 *     imports.
 *   - Named / default / default+named relative imports → stripped.
 *
 * Caller appends the `this.<componentName> = <componentName>;` tail
 * before passing to `vm.runInContext`; this helper returns just the
 * source-level transform.
 */
function transformComponentSource(raw) {
  return raw
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]*preact\.module\.js['"];?\s*$/gm,
      (_, names) => `const {${names}} = window.preact;`)
    .replace(/^import\s+\{([^}]+)\}\s+from\s+['"][^'"]*hooks\.module\.js['"];?\s*$/gm,
      (_, names) => `const {${names}} = window.preactHooks;`)
    .replace(/^import\s+htm\s+from\s+['"][^'"]*htm\.module\.js['"];?\s*$/gm,
      'var htm = window.htm;')
    // Side-effect-only relative imports first — must precede the
    // named-import strip so a side-effect line followed by a named
    // import doesn't get merged into a single greedy match (Codex
    // K-1b r1 NIT).
    .replace(/^import\s+['"]\.\.?\/[^'"]+['"];?\s*$/gm, '// [stripped side-effect import]')
    // Named / default / default+named relative imports. Multi-line
    // brace bodies are handled via `[\s\S]*?`. The alternation rules
    // out bare side-effect imports (already handled above).
    .replace(/^import\s+(?:\{[\s\S]*?\}|\w[\w$]*(?:\s*,\s*\{[\s\S]*?\})?)\s+from\s+['"]\.\.?\/[^'"]+['"];?\s*$/gm,
      '// [stripped import]');
}

function loadComponent(componentName, context) {
  const filePath = path.join(COMPONENTS_DIR, `${componentName}.js`);
  const raw = fs.readFileSync(filePath, 'utf8');
  const transformed = transformComponentSource(raw)
    + `\nif (typeof ${componentName} !== 'undefined') this.${componentName} = ${componentName};`;
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
  const nodeUiTransformed = nodeUiSrc
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  vm.runInContext(nodeUiTransformed, context);
  // Data hooks preload — full component transform (vendor hooks import →
  // window.preactHooks, relative lib imports stripped). Wrapped in an IIFE:
  // top-level `const` in a vm script lands in the context's shared global
  // lexical scope, so an unwrapped preload would collide with the identical
  // `const { useState … }` declaration of the component loaded next. Only
  // useNodeSummary is exported; its `apiFetch`/`sseBroker` references stay
  // free variables resolved from the sandbox at call time (per-test stubs).
  vm.runInContext(
    '(function () {\n'
    + transformComponentSource(dataHooksSrc)
    + '\nthis.useNodeSummary = useNodeSummary;\n}).call(this);',
    context,
  );

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

module.exports = { createPreactEnv, flushEffects, loadComponent, transformComponentSource, VENDOR_DIR, COMPONENTS_DIR };
