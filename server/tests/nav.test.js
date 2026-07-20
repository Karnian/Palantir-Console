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

test('NAV_ITEMS swaps dashboard for manager as the top-nav slot', () => {
  // #376/#385/#386/#387 arc, final step: manager gets manager's own
  // persistent top-nav tab, taking the slot dashboard used to occupy.
  // Dashboard didn't lose reachability — it's still DEFAULT_ROUTE and one
  // click away via the sidebar brand logo (PR #387) — it just moved down
  // into NAV_SUB_ITEMS (Cmd+K-searchable) like manager was before it.
  const { NAV_ITEMS, NAV_SUB_ITEMS } = loadNavModule();
  assert.equal(NAV_ITEMS.length, 5);
  assert.deepEqual(Array.from(NAV_ITEMS, (item) => item.hash), [
    'manager',
    'operator',
    'board',
    'resources',
    'memory',
  ]);
  assert.ok(NAV_ITEMS.some((item) => item.hash === 'manager'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'dashboard'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'operator/roster'));
  assert.ok(!NAV_ITEMS.some((item) => item.hash === 'projects'));

  const dashboard = NAV_SUB_ITEMS.find((item) => item.hash === 'dashboard');
  assert.ok(dashboard, 'dashboard must be searchable via CommandPalette now that it left NAV_ITEMS');
  assert.ok(!NAV_SUB_ITEMS.some((item) => item.hash === 'manager'), 'manager left NAV_SUB_ITEMS for a real NAV_ITEMS slot');

  const operatorSubItems = Array.from(NAV_SUB_ITEMS)
    .filter((item) => item.hash.startsWith('operator/'))
    .map((item) => [item.hash, item.label]);
  assert.deepEqual(operatorSubItems, [
    ['operator/roster', '오퍼레이터 로스터'],
    ['operator/codebases', '프로젝트 폴더'],
    ['operator/profiles', '오퍼레이터 프로필'],
    ['operator/specialist', '스페셜리스트'],
  ]);
});

test('empty hash defaults to dashboard while #manager route stays deep-linkable', () => {
  // User decision, superseding PR #338's operator-centric default: a
  // control hub's landing screen should answer "does anything need me"
  // (dashboard/triage) before "what's actively running" (operator roster).
  const routingSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'lib', 'hooks', 'routing.js'), 'utf8');
  assert.match(routingSrc, /const DEFAULT_ROUTE = 'dashboard';/);
  assert.doesNotMatch(routingSrc, /const DEFAULT_ROUTE = 'operator';/);
  assert.doesNotMatch(routingSrc, /const DEFAULT_ROUTE = 'manager';/);

  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(appSrc, /import \{ operatorConversationId \} from '\.\/app\/lib\/conversationId\.js';/);
  assert.match(appSrc, /if \(routeBase === 'manager'\) \{/);
  assert.match(appSrc, /routeParts\[1\] === 'operator'/);
  assert.match(appSrc, /managerInitialTarget = operatorConversationId\(projectId\);/);
  assert.match(appSrc, /<\$\{ManagerView\}[\s\S]*initialTarget=\$\{managerInitialTarget\}/);
});

test('sidebar brand icon is a home (dashboard) shortcut, not a manager one', () => {
  // Follow-up to the #376 nav-brand experiment (PR #386): logo-click is a
  // "go home" convention, and home is now the dashboard — repurposing the
  // logo for manager access would conflict with that once dashboard became
  // DEFAULT_ROUTE. Manager stays reachable via CommandPalette (#385) and
  // the Operator roster Master card CTA (#380).
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  // Bounded to the nav-brand div's own element (opening tag through its
  // closing </div>, lazy match) so this doesn't accidentally match some
  // LATER unrelated navigate('manager') call elsewhere in the file (e.g.
  // the attention badge's onClick) — a `[^>]*` bound would break here since
  // the arrow function `() =>` itself contains a `>` character.
  const navBrandMatch = appSrc.match(/<div\s+class="nav-brand[\s\S]*?<\/div>/);
  assert.ok(navBrandMatch, 'nav-brand div must exist');
  assert.match(navBrandMatch[0], /clickableProps\(\(\) => navigate\('dashboard'\)\)/);
  assert.doesNotMatch(navBrandMatch[0], /navigate\('manager'\)/);
});

test('nav-brand carries dashboard current-page state now that dashboard left NAV_ITEMS', () => {
  // Codex review of the manager top-nav swap: once dashboard left NAV_ITEMS,
  // no .nav-item can ever show .active/aria-current while on #dashboard, and
  // smoke.spec.js's dashboard-route assertion would silently stop checking
  // anything real. The brand icon (the only remaining dashboard control on
  // desktop) must carry that current-page state itself.
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const navBrandMatch = appSrc.match(/<div\s+class="nav-brand[\s\S]*?<\/div>/);
  assert.ok(navBrandMatch, 'nav-brand div must exist');
  assert.match(navBrandMatch[0], /class="nav-brand \$\{route\.split\('\/'\)\[0\] === 'dashboard' \? 'active' : ''\}"/);
  assert.match(navBrandMatch[0], /aria-current=\$\{route\.split\('\/'\)\[0\] === 'dashboard' \? 'page' : undefined\}/);
});

test('app shell nests ProjectsView under operator codebases and aliases #projects', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /if \(base === 'projects'\) \{/);
  assert.match(src, /window\.location\.replace\('#operator\/codebases' \+ projectSuffix\)/);
  assert.match(src, /\{ key: 'codebases',\s+label: NAV_LABELS\['operator-codebases'\],[\s\S]*<\$\{ProjectsView\}[\s\S]*highlightProjectId=\$\{highlightProjectId\}/);
  assert.match(src, /const rawProjectId = sub === 'codebases' \? \(routeParts\.slice\(2\)\.join\('\/'\) \|\| null\) : null;/);
  assert.doesNotMatch(src, /if \(routeBase === 'projects'\) \{[\s\S]*return html`<\$\{ProjectsView\}/);
});
