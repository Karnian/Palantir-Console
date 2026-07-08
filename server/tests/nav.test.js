'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadNavModule() {
  const root = path.join(__dirname, '..', 'public', 'app', 'lib');
  const context = vm.createContext({});
  const copySrc = fs.readFileSync(path.join(root, 'copy.js'), 'utf8')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ');
  vm.runInContext(copySrc + '\nthis.NAV_LABELS = NAV_LABELS;', context);

  const navSrc = fs.readFileSync(path.join(root, 'nav.js'), 'utf8')
    .replace(/^import\s+\{[^}]+\}\s+from\s+['"]\.\/copy\.js['"];?\s*$/gm, '')
    .replace(/^export\s+const\s+/gm, 'const ');
  vm.runInContext(navSrc + '\nthis.NAV_ITEMS = NAV_ITEMS; this.NAV_SUB_ITEMS = NAV_SUB_ITEMS;', context);
  return context;
}

test('NAV_SUB_ITEMS exposes operator roster without changing top-level nav', () => {
  const { NAV_ITEMS, NAV_SUB_ITEMS } = loadNavModule();
  assert.equal(NAV_ITEMS.length, 7);
  assert.ok(NAV_ITEMS.some((item) => item.hash === 'operator'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'operator/roster'));

  const operatorSubItems = Array.from(NAV_SUB_ITEMS)
    .filter((item) => item.hash.startsWith('operator/'))
    .map((item) => item.hash);
  assert.deepEqual(operatorSubItems, [
    'operator/roster',
    'operator/profiles',
    'operator/specialist',
  ]);
});
