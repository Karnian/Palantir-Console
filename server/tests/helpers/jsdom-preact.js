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

// Read UMD sources once — they are reused across every createPreactEnv call.
const preactSrc = fs.readFileSync(path.join(VENDOR_DIR, 'preact.umd.js'), 'utf8');
const hooksSrc = fs.readFileSync(path.join(VENDOR_DIR, 'hooks.umd.js'), 'utf8');
const htmSrc = fs.readFileSync(path.join(VENDOR_DIR, 'htm.umd.js'), 'utf8');

/**
 * Load an ES-module component file into a vm context by stripping `export`
 * keywords.  The `const { ... } = window.xxx` lines are kept because the
 * vm context IS the jsdom window — `window.preact`, `window.preactHooks`,
 * and `window.htm` are already available.
 *
 * @param {string} componentName  e.g. 'Dropdown', 'MentionInput'
 * @param {object} context        vm context to evaluate in
 */
function loadComponent(componentName, context) {
  const filePath = path.join(COMPONENTS_DIR, `${componentName}.js`);
  const raw = fs.readFileSync(filePath, 'utf8');

  // Strip leading `export` from `export function Foo` declarations.
  const transformed = raw
    .replace(/^export\s+function\s+/m, 'function ')
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
  };
}

/**
 * Wait for Preact's useEffect queue (scheduled via setTimeout) to flush.
 */
function flushEffects(ms = 100) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { createPreactEnv, flushEffects, loadComponent, VENDOR_DIR, COMPONENTS_DIR };
