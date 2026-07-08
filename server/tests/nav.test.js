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
  assert.equal(NAV_ITEMS.length, 5);
  assert.deepEqual(Array.from(NAV_ITEMS, (item) => item.hash), [
    'dashboard',
    'operator',
    'board',
    'resources',
    'memory',
  ]);
  assert.ok(NAV_ITEMS.some((item) => item.hash === 'operator'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'manager'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'operator/roster'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'projects'));

  const operatorSubItems = Array.from(NAV_SUB_ITEMS)
    .filter((item) => item.hash.startsWith('operator/'))
    .map((item) => [item.hash, item.label]);
  assert.deepEqual(operatorSubItems, [
    ['operator/roster', '오퍼레이터 로스터'],
    ['operator/codebases', '코드베이스'],
    ['operator/profiles', '오퍼레이터 프로필'],
    ['operator/specialist', '스페셜리스트'],
  ]);
});

test('empty hash defaults to operator while #manager route stays deep-linkable', () => {
  const routingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'lib', 'hooks', 'routing.js'), 'utf8');
  assert.match(routingSrc, /const DEFAULT_ROUTE = 'operator';/);
  assert.doesNotMatch(routingSrc, /const DEFAULT_ROUTE = 'manager';/);

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSrc, /import \{ operatorConversationId \} from '\.\/app\/lib\/conversationId\.js';/);
  assert.match(appSrc, /if \(routeBase === 'manager'\) \{/);
  assert.match(appSrc, /routeParts\[1\] === 'operator'/);
  assert.match(appSrc, /managerInitialTarget = operatorConversationId\(projectId\);/);
  assert.match(appSrc, /<\$\{ManagerView\}[\s\S]*initialTarget=\$\{managerInitialTarget\}/);
});

test('app shell nests ProjectsView under operator codebases and aliases #projects', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /if \(base === 'projects'\) \{/);
  assert.match(src, /window\.location\.replace\('#operator\/codebases' \+ projectSuffix\)/);
  assert.match(src, /\{ key: 'codebases',\s+label: NAV_LABELS\['operator-codebases'\],[\s\S]*<\$\{ProjectsView\}[\s\S]*highlightProjectId=\$\{highlightProjectId\}/);
  assert.match(src, /const rawProjectId = sub === 'codebases' \? \(routeParts\.slice\(2\)\.join\('\/'\) \|\| null\) : null;/);
  assert.doesNotMatch(src, /if \(routeBase === 'projects'\) \{[\s\S]*return html`<\$\{ProjectsView\}/);
});
