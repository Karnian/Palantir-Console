// PR3b — drift-guard tests for frontend fixes that live in server/public/
// app.js. There is no browser test harness in this repo (server/public is
// shipped as-is to the browser), so we validate the source file itself for
// the invariants each fix must keep. A future migration to ESM modules +
// jsdom would make these richer, but for now the goal is "regress-proof
// the specific text edits so they can't be rolled back silently".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

let _srcCache;
async function loadAppJs() {
  if (_srcCache) return _srcCache;
  _srcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app.js'),
    'utf8'
  );
  return _srcCache;
}

// P2-10 (ESM phase 1): DriftDrawer was extracted from app.js into
// its own ES module. The a11y / focus-trap assertions below used to
// call `sliceFunction(appSrc, 'function DriftDrawer')` — now they
// load the module file directly. The ESM file is the whole component
// body so no slicing is needed.
let _driftDrawerSrcCache;
async function loadDriftDrawerSource() {
  if (_driftDrawerSrcCache) return _driftDrawerSrcCache;
  _driftDrawerSrcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'DriftDrawer.js'),
    'utf8'
  );
  return _driftDrawerSrcCache;
}

// P6-1 (ESM phase 5a): ManagerView was extracted from app.js into
// its own ES module (app/components/ManagerView.js).
// P8-5: ManagerView was further split into ManagerChat.js + SessionGrid.js.
// loadManagerViewSource now returns ManagerChat.js since the chat-specific
// aria-labels, Dropdown, and MentionInput live there.
let _managerViewSrcCache;
async function loadManagerViewSource() {
  if (_managerViewSrcCache) return _managerViewSrcCache;
  _managerViewSrcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'ManagerChat.js'),
    'utf8'
  );
  return _managerViewSrcCache;
}

// P5-1 (ESM phase 4a): DashboardView was extracted from app.js into
// its own ES module (app/components/DashboardView.js).
let _dashboardViewSrcCache;
async function loadDashboardViewSource() {
  if (_dashboardViewSrcCache) return _dashboardViewSrcCache;
  _dashboardViewSrcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'DashboardView.js'),
    'utf8'
  );
  return _dashboardViewSrcCache;
}

// P7-1 (ESM phase 6): TaskModals — NewTaskModal, ExecuteModal, TaskDetailPanel.
let _taskModalsSrcCache;
async function loadTaskModalsSource() {
  if (_taskModalsSrcCache) return _taskModalsSrcCache;
  _taskModalsSrcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'TaskModals.js'),
    'utf8'
  );
  return _taskModalsSrcCache;
}

// P6-3 (ESM phase 5): SessionsView — Legacy sessions management view.
let _sessionsViewSrcCache;
async function loadSessionsViewSource() {
  if (_sessionsViewSrcCache) return _sessionsViewSrcCache;
  _sessionsViewSrcCache = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'SessionsView.js'),
    'utf8'
  );
  return _sessionsViewSrcCache;
}

function sliceFunction(src, header) {
  // Find the declaration, then grab a generous window afterwards. We
  // don't need to precisely delimit the function body — a brace
  // counter would have to understand string literals, template
  // literals, regex, and comments, which is way more than these tests
  // need. The next `function ` at column 0 (or EOF) is a reliable
  // upper bound for "still inside the function in question".
  const start = src.indexOf(header);
  if (start < 0) return null;
  // Look for the next top-level `function ` declaration starting at
  // column 0 after our header.
  const tail = src.slice(start + header.length);
  const nextFn = tail.search(/\n(function |class )/);
  if (nextFn < 0) return src.slice(start);
  return src.slice(start, start + header.length + nextFn);
}

// ---- P1-11: DriftDrawer WCAG a11y ----

test('P1-11 DriftDrawer has role=dialog + aria-modal + aria-labelledby', async () => {
  const body = await loadDriftDrawerSource();
  assert.ok(body && body.length > 0, 'DriftDrawer module source not found');
  assert.match(body, /role="dialog"/, 'role=dialog missing');
  assert.match(body, /aria-modal="true"/, 'aria-modal missing');
  assert.match(body, /aria-labelledby="drift-drawer-title"/, 'aria-labelledby missing');
  assert.match(body, /id="drift-drawer-title"/, 'labelled element id missing');
});

test('P1-11 DriftDrawer installs focus trap + auto-focus via useEffect', async () => {
  const body = await loadDriftDrawerSource();
  // Must reference drawerRef + a keydown listener (the focus trap handler).
  assert.match(body, /drawerRef/, 'drawerRef missing');
  assert.match(body, /addEventListener\('keydown'/, 'keydown handler missing (no focus trap)');
  assert.match(body, /\.focus\(\)/, 'autofocus call missing');
  // Must handle Shift+Tab path (reverse cycle).
  assert.match(body, /shiftKey/, 'Shift+Tab reverse cycle missing');
});

test('P1-11 DriftDrawer Close button has aria-label', async () => {
  const body = await loadDriftDrawerSource();
  assert.match(body, /aria-label="Close drift drawer"/, 'Close button aria-label missing');
});

// ---- P2-6: hardened structural/source invariants ----
//
// Scope note: these are STRUCTURAL invariants on the app.js text, not
// behavioral DOM tests. A real jsdom mount of DriftDrawer requires the
// component to be an ES module export — that is the work in PR #44
// (P2-10 ESM phase 1). Until then these assertions catch the most
// common regression shapes (missing ref binding, cleanup function drop,
// Tab / Shift+Tab branch loss, dependency-array bloat) that a simple
// useEffect edit can introduce without the existing tests noticing.
// Codex PROCEED_HARDENED consensus — see PR #41 body for context.

test('P2-6 DriftDrawer useEffect returns a cleanup function that removes the keydown listener', async () => {
  const body = await loadDriftDrawerSource();
  assert.match(
    body,
    /return\s*\(\)\s*=>\s*\{\s*node\.removeEventListener\('keydown'/,
    'DriftDrawer useEffect must return a cleanup that removes the keydown listener',
  );
});

test('P2-6 DriftDrawer outer dialog div binds drawerRef via ref attribute (attribute-scoped)', async () => {
  // Codex R1 blocker fix: the previous `role="dialog"[\s\S]{0,400}?ref=`
  // window match could pass even if ref= ended up on a descendant
  // within 400 chars. Now we slice the dialog element's opening-tag
  // attribute list (role="dialog" to the first `>` that closes it) and
  // assert ref=${drawerRef} lives in THAT window specifically.
  const body = await loadDriftDrawerSource();
  // The function comment block also contains the literal string
  // `role="dialog"` for documentation. Find the FIRST occurrence that
  // is inside an HTM template literal by searching after the return
  // keyword that opens the template literal (`return html\``).
  const returnHtmlIdx = body.indexOf('return html`');
  assert.ok(returnHtmlIdx > 0, 'return html` template not found in DriftDrawer');
  const template = body.slice(returnHtmlIdx);
  const roleIdx = template.indexOf('role="dialog"');
  assert.ok(roleIdx >= 0, 'role="dialog" not found in DriftDrawer template');
  // Walk backwards to the element's `<div` (HTM uses angle brackets
  // inside template literals) so we anchor on the tag start.
  const tagStart = template.lastIndexOf('<div', roleIdx);
  assert.ok(tagStart >= 0 && tagStart < roleIdx, 'could not find the opening <div for role="dialog"');
  // Walk forward to the first unescaped `>` that closes the opening
  // tag. Nested template expressions use `${...}` — the closing `>` of
  // the opening tag is the first `>` that is not inside a template
  // expression. Simple approach: scan char-by-char tracking brace depth
  // for `${...}` placeholders.
  let i = roleIdx;
  let depth = 0;
  let tagEnd = -1;
  while (i < template.length) {
    const ch = template[i];
    const next = template[i + 1];
    if (ch === '$' && next === '{') { depth++; i += 2; continue; }
    if (ch === '}' && depth > 0) { depth--; i++; continue; }
    if (ch === '>' && depth === 0) { tagEnd = i; break; }
    i++;
  }
  assert.ok(tagEnd > roleIdx, 'could not locate the end of the role="dialog" opening tag');
  const openingTag = template.slice(tagStart, tagEnd + 1);
  assert.match(
    openingTag,
    /ref=\$\{drawerRef\}/,
    'drawerRef must be bound to the role="dialog" element itself, not a descendant. openingTag=\n' + openingTag,
  );
});

test('P2-6 DriftDrawer Tab cycle — forward (lastEl → firstEl) branch present', async () => {
  const body = await loadDriftDrawerSource();
  assert.match(
    body,
    /document\.activeElement\s*===\s*lastEl[\s\S]{0,200}?firstEl\.focus\(\)/,
    'forward Tab cycle (lastEl → firstEl) path missing',
  );
});

test('P2-6 DriftDrawer Tab cycle — reverse (firstEl → lastEl) branch present', async () => {
  const body = await loadDriftDrawerSource();
  assert.match(
    body,
    /document\.activeElement\s*===\s*firstEl[\s\S]{0,200}?lastEl\.focus\(\)/,
    'reverse Shift+Tab cycle (firstEl → lastEl) path missing',
  );
});

test('P2-6 DriftDrawer focusables selector covers the WAI-ARIA focusable superset', async () => {
  const body = await loadDriftDrawerSource();
  // The selector string is single-quoted in app.js and INTERNALLY uses
  // double quotes (e.g. `[tabindex="-1"]`), so a naive `[^'"]+` char
  // class stops at the first inner `"`. Match on single-quote-only
  // boundaries.
  const selectorMatch = body.match(/querySelectorAll\(\s*'([^']+)'/);
  assert.ok(selectorMatch, 'focusables selector not found');
  const sel = selectorMatch[1];
  for (const needle of [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]',
  ]) {
    assert.ok(sel.includes(needle), `focusables selector missing: ${needle}`);
  }
});

test('P2-6 DriftDrawer focus-trap useEffect depends only on [open]', async () => {
  const body = await loadDriftDrawerSource();
  // A wider dep array (e.g. [open, rows]) would tear down + re-install
  // the trap on every content reload, stealing focus mid-interaction.
  assert.match(
    body,
    /\},\s*\[open\]\);/,
    'DriftDrawer focus-trap useEffect must depend only on [open]',
  );
});

// ---- P2-7: drift badge aria-label ----

test('P2-7 drift badge has aria-label announcing the count', async () => {
  // P5-1: DashboardView (including the drift badge) was extracted from app.js
  // into app/components/DashboardView.js. Search there first, fall back to
  // app.js for future migrations that might restructure further.
  const [appSrc, dashboardSrc] = await Promise.all([loadAppJs(), loadDashboardViewSource()]);
  const src = dashboardSrc.indexOf('PM hallucination / staleness incidents') >= 0
    ? dashboardSrc
    : appSrc;
  const badgeStart = src.indexOf('PM hallucination / staleness incidents');
  assert.ok(badgeStart > 0, 'drift badge region not located');
  const region = src.slice(badgeStart, badgeStart + 600);
  assert.match(
    region,
    /aria-label=\$\{`Drift warnings: \$\{driftAudit\.totalCount\}/,
    'drift badge must have an aria-label that announces the count to screen readers',
  );
});

// ---- P2-10: ESM phase 1 — DriftDrawer extraction ----

test('P2-10 DriftDrawer module exports the component as a named export', async () => {
  const body = await loadDriftDrawerSource();
  assert.match(body, /export\s+function\s+DriftDrawer\s*\(/,
    'DriftDrawer.js must provide `export function DriftDrawer(...)`');
});

test('P2-10 DriftDrawer module dereferences window.preact / preactHooks / htm at top level', async () => {
  // Mirrors the RunInspector.js convention. main.js assigns these
  // globals before dynamically importing DriftDrawer.js, so module-
  // time reads are safe.
  const body = await loadDriftDrawerSource();
  assert.match(body, /window\.preactHooks/, 'window.preactHooks reference missing');
  assert.match(body, /window\.preact/, 'window.preact reference missing');
  assert.match(body, /window\.htm\.bind\(h\)/, 'htm.bind(h) wiring missing');
});

test('P2-10 legacy app.js no longer defines `function DriftDrawer`', async () => {
  const src = await loadAppJs();
  assert.doesNotMatch(src, /function\s+DriftDrawer\s*\(/,
    'function DriftDrawer was extracted to an ES module and must not be redefined in app.js');
});

test('P2-10 main.js dynamically imports DriftDrawer and bridges it onto window', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'main.js'),
    'utf8',
  );
  assert.match(
    src,
    /import\(\s*['"]\.\/components\/DriftDrawer\.js['"]\s*\)/,
    'main.js must dynamically import ./components/DriftDrawer.js',
  );
  assert.match(
    src,
    /window\.DriftDrawer\s*=\s*DriftDrawer/,
    'main.js must assign window.DriftDrawer = DriftDrawer for the legacy app.js bridge',
  );
});

test('P2-10 app.js still references <${DriftDrawer} ... /> via global bridge', async () => {
  // Behavior contract: removing the function from app.js must not
  // break the call site that mounts the component. We grep for the
  // component tag literal.
  const src = await loadAppJs();
  assert.match(src, /<\$\{DriftDrawer\}/,
    'app.js must still render <${DriftDrawer}> — the bridge (window.DriftDrawer) makes this bare reference resolve via global scope');
});

// ---- P2-9: Stop/Reset label clarity + PM selector Dropdown swap ----

test('P2-9 Reset PM button has explicit aria-label and scope-clarifying title', async () => {
  const src = await loadManagerViewSource();
  const idx = src.indexOf('aria-label="Reset PM for this project"');
  assert.ok(idx > 0, 'Reset PM aria-label not found — P2-9 title/aria update missing');
  const region = src.slice(idx - 600, idx + 200);
  assert.match(
    region,
    /title="Reset PM: terminate this project's PM thread only/,
    'Reset PM title must clearly scope the action to the current project',
  );
});

test('P2-9 Stop Top button has explicit aria-label and scope-clarifying title', async () => {
  const src = await loadManagerViewSource();
  const idx = src.indexOf('aria-label="Stop Top manager"');
  assert.ok(idx > 0, 'Stop Top aria-label not found — P2-9 title/aria update missing');
  const region = src.slice(idx - 600, idx + 200);
  assert.match(
    region,
    /title="Stop Top manager: terminate the shared Top manager process/,
    'Stop button title must make scope explicit',
  );
});

test('P2-9 PM selector uses the Dropdown component, not native <select>', async () => {
  const src = await loadManagerViewSource();
  // Anchor on the unique className the swap kept.
  const idx = src.indexOf('className="manager-picker-select"');
  assert.ok(idx > 0, 'PM selector Dropdown className not found — swap missing');
  const region = src.slice(idx, idx + 1500);
  assert.match(
    region,
    /value=\$\{conversationTarget\}/,
    'PM selector Dropdown must bind to conversationTarget state',
  );
  assert.match(
    region,
    /onChange=\$\{\(v\)\s*=>\s*setConversationTarget\(v\)\}/,
    'PM selector Dropdown onChange must call setConversationTarget(v)',
  );
});

test('P2-9 legacy conversation-target native <select> is removed', async () => {
  // Scope note: the agent profile picker ALSO uses the
  // `manager-picker-select` class and is legitimately a native
  // <select> — we do NOT touch that picker in P2-9 (the P2-9 swap
  // specifically targets the Top-vs-PM conversation selector). The
  // check below therefore anchors on the conversation-target path
  // (value=${conversationTarget}) and confirms it is NOT wired to a
  // native <select>.
  const src = await loadManagerViewSource();
  // Find the conversationTarget binding and inspect the enclosing
  // element type. The Dropdown swap uses `<${Dropdown}` on the same
  // element; a regression to native <select> would show `<select`
  // within ~200 chars upstream.
  const idx = src.indexOf('value=${conversationTarget}');
  assert.ok(idx > 0, 'conversationTarget binding not found');
  const before = src.slice(Math.max(0, idx - 400), idx);
  assert.match(
    before,
    /<\$\{Dropdown\}/,
    'conversationTarget must be bound on the Dropdown component, not a native <select>',
  );
  assert.doesNotMatch(
    before,
    /<select\b/,
    'legacy native <select> for conversationTarget must be removed',
  );
});

// ---- X3: getRunTaskTitle envelope strict ----

test('X3 getRunTaskTitle does not fall back to data.taskId (camelCase)', async () => {
  const src = await loadAppJs();
  // Find the callback. It's inlined via useCallback so we just grep a
  // window around the helper name.
  const idx = src.indexOf('const getRunTaskTitle = useCallback(');
  assert.ok(idx >= 0, 'getRunTaskTitle not found');
  const body = src.slice(idx, idx + 800);
  assert.match(body, /data\.task_id.*\|\|.*run\.task_id/s,
    'getRunTaskTitle must read snake_case task_id off envelope or run row');
  assert.doesNotMatch(body, /data\.taskId\b/,
    'PR3b / X3: the camelCase data.taskId fallback must be removed — Phase 5+ emitters always hoist task_id (snake_case).');
});

// ---- P3-2: ESM phase 2 — Dropdown + EmptyState extraction ----

test('P3-2 Dropdown.js exports Dropdown as a named export', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'Dropdown.js'),
    'utf8',
  );
  assert.match(src, /export\s+function\s+Dropdown\s*\(/,
    'Dropdown.js must provide `export function Dropdown(...)`');
});

test('P3-2 Dropdown.js dereferences window.preact / preactHooks / htm at top level', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'Dropdown.js'),
    'utf8',
  );
  assert.match(src, /window\.preactHooks/, 'window.preactHooks reference missing');
  assert.match(src, /window\.preact/, 'window.preact reference missing');
  assert.match(src, /window\.htm\.bind\(h\)/, 'htm.bind(h) wiring missing');
});

test('P3-2 EmptyState.js exports EmptyState as a named export', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'EmptyState.js'),
    'utf8',
  );
  assert.match(src, /export\s+function\s+EmptyState\s*\(/,
    'EmptyState.js must provide `export function EmptyState(...)`');
});

test('P3-2 legacy app.js no longer defines `function Dropdown`', async () => {
  const src = await loadAppJs();
  assert.doesNotMatch(src, /function\s+Dropdown\s*\(/,
    'function Dropdown was extracted to an ES module and must not be redefined in app.js');
});

test('P3-2 legacy app.js no longer defines `function EmptyState`', async () => {
  const src = await loadAppJs();
  assert.doesNotMatch(src, /function\s+EmptyState\s*\(/,
    'function EmptyState was extracted to an ES module and must not be redefined in app.js');
});

test('P3-2 main.js dynamically imports Dropdown and EmptyState and bridges them onto window', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'main.js'),
    'utf8',
  );
  assert.match(src, /import\(\s*['"]\.\/components\/Dropdown\.js['"]\s*\)/,
    'main.js must dynamically import ./components/Dropdown.js');
  assert.match(src, /window\.Dropdown\s*=\s*Dropdown/,
    'main.js must assign window.Dropdown = Dropdown');
  assert.match(src, /import\(\s*['"]\.\/components\/EmptyState\.js['"]\s*\)/,
    'main.js must dynamically import ./components/EmptyState.js');
  assert.match(src, /window\.EmptyState\s*=\s*EmptyState/,
    'main.js must assign window.EmptyState = EmptyState');
});

// ---- P3-1: @mention autocomplete (MentionInput) ----

test('P3-1 MentionInput.js exports MentionInput as a named export', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'MentionInput.js'),
    'utf8',
  );
  assert.match(src, /export\s+function\s+MentionInput\s*\(/,
    'MentionInput.js must provide `export function MentionInput(...)`');
});

test('P3-1 MentionInput.js contains @-mention handling logic', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'MentionInput.js'),
    'utf8',
  );
  // Must handle the @ trigger character
  assert.match(src, /@/, 'MentionInput.js must reference the @ trigger character');
  // Must have keyboard navigation for the popup (ArrowDown / ArrowUp)
  assert.match(src, /ArrowDown/, 'MentionInput.js must handle ArrowDown for keyboard navigation');
  assert.match(src, /ArrowUp/, 'MentionInput.js must handle ArrowUp for keyboard navigation');
  // Must handle Escape to dismiss
  assert.match(src, /Escape/, 'MentionInput.js must handle Escape to dismiss popup');
});

test('P3-1 MentionInput.js dereferences window.preact / preactHooks / htm at top level', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'components', 'MentionInput.js'),
    'utf8',
  );
  assert.match(src, /window\.preactHooks/, 'window.preactHooks reference missing');
  assert.match(src, /window\.preact/, 'window.preact reference missing');
  assert.match(src, /window\.htm\.bind\(h\)/, 'htm.bind(h) wiring missing');
});

test('P3-1 main.js dynamically imports MentionInput and bridges it onto window', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'main.js'),
    'utf8',
  );
  assert.match(src, /import\(\s*['"]\.\/components\/MentionInput\.js['"]\s*\)/,
    'main.js must dynamically import ./components/MentionInput.js');
  assert.match(src, /window\.MentionInput\s*=\s*MentionInput/,
    'main.js must assign window.MentionInput = MentionInput');
});

test('P3-1 ManagerView uses MentionInput instead of plain textarea', async () => {
  const src = await loadManagerViewSource();
  // The MentionInput component should be used in the manager input area
  assert.match(src, /<\$\{MentionInput\}/,
    'app.js must render <${MentionInput}> in the ManagerView input area');
  // And it should pass projects prop
  assert.match(src, /projects=\$\{projects\}/,
    'MentionInput must receive the projects prop for autocomplete candidates');
});

// ---- P8-8: TaskModals (P7-1 ESM phase 6) ----

test('P8-8 TaskModals.js exports NewTaskModal, ExecuteModal, TaskDetailPanel as named exports', async () => {
  const src = await loadTaskModalsSource();
  assert.match(src, /export\s+function\s+NewTaskModal\s*\(/,
    'TaskModals.js must provide `export function NewTaskModal(...)`');
  assert.match(src, /export\s+function\s+ExecuteModal\s*\(/,
    'TaskModals.js must provide `export function ExecuteModal(...)`');
  assert.match(src, /export\s+function\s+TaskDetailPanel\s*\(/,
    'TaskModals.js must provide `export function TaskDetailPanel(...)`');
});

test('P8-8 TaskModals.js dereferences window.preact / preactHooks / htm at top level', async () => {
  const src = await loadTaskModalsSource();
  assert.match(src, /window\.preactHooks/, 'window.preactHooks reference missing');
  assert.match(src, /window\.preact/, 'window.preact reference missing');
  assert.match(src, /window\.htm\.bind\(h\)/, 'htm.bind(h) wiring missing');
});

test('P8-8 NewTaskModal has accessible close button', async () => {
  const src = await loadTaskModalsSource();
  // Locate NewTaskModal function body (up to next export function)
  const start = src.indexOf('export function NewTaskModal');
  const nextExport = src.indexOf('export function ExecuteModal');
  assert.ok(start >= 0, 'NewTaskModal not found');
  assert.ok(nextExport > start, 'ExecuteModal boundary not found');
  const body = src.slice(start, nextExport);
  // Must have a close button with onClick=${onClose}
  assert.match(body, /onClick=\$\{onClose\}/, 'NewTaskModal must have a close button bound to onClose');
  // Must have modal-header with a title
  assert.match(body, /class="modal-header"/, 'NewTaskModal must have a modal-header');
  assert.match(body, /class="modal-title"/, 'NewTaskModal must have a modal-title');
});

test('P8-8 ExecuteModal has accessible modal structure', async () => {
  const src = await loadTaskModalsSource();
  const start = src.indexOf('export function ExecuteModal');
  const nextExport = src.indexOf('export function TaskDetailPanel');
  assert.ok(start >= 0, 'ExecuteModal not found');
  assert.ok(nextExport > start, 'TaskDetailPanel boundary not found');
  const body = src.slice(start, nextExport);
  // Must have modal overlay + backdrop + panel
  assert.match(body, /class="modal-overlay"/, 'ExecuteModal must have a modal-overlay');
  assert.match(body, /class="modal-backdrop"/, 'ExecuteModal must have a modal-backdrop for click-outside close');
  assert.match(body, /class="modal-panel"/, 'ExecuteModal must have a modal-panel');
  // Must use useEscape hook for keyboard dismiss
  assert.match(body, /useEscape\(/, 'ExecuteModal must use useEscape hook for Esc dismissal');
});

test('P8-8 TaskDetailPanel has proper semantic structure', async () => {
  const src = await loadTaskModalsSource();
  const start = src.indexOf('export function TaskDetailPanel');
  assert.ok(start >= 0, 'TaskDetailPanel not found');
  const body = src.slice(start);
  // Must have inline-edit aria labels for accessibility
  assert.match(body, /aria-label="Edit title"/, 'TaskDetailPanel must have aria-label for title editing');
  assert.match(body, /aria-label="Edit description"/, 'TaskDetailPanel must have aria-label for description editing');
  // Must have status/priority Dropdown components with ariaLabel
  assert.match(body, /ariaLabel="Status"/, 'TaskDetailPanel must pass ariaLabel to Status Dropdown');
  assert.match(body, /ariaLabel="Priority"/, 'TaskDetailPanel must pass ariaLabel to Priority Dropdown');
  assert.match(body, /ariaLabel="Project"/, 'TaskDetailPanel must pass ariaLabel to Project Dropdown');
});

test('P8-8 main.js dynamically imports TaskModals and bridges all three exports onto window', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'main.js'),
    'utf8',
  );
  assert.match(src, /import\(\s*['"]\.\/components\/TaskModals\.js['"]\s*\)/,
    'main.js must dynamically import ./components/TaskModals.js');
  assert.match(src, /window\.NewTaskModal\s*=\s*NewTaskModal/,
    'main.js must assign window.NewTaskModal = NewTaskModal');
  assert.match(src, /window\.ExecuteModal\s*=\s*ExecuteModal/,
    'main.js must assign window.ExecuteModal = ExecuteModal');
  assert.match(src, /window\.TaskDetailPanel\s*=\s*TaskDetailPanel/,
    'main.js must assign window.TaskDetailPanel = TaskDetailPanel');
});

// ---- P8-8: SessionsView (P6-3 ESM phase 5) ----

test('P8-8 SessionsView.js exports SessionsView as a named export', async () => {
  const src = await loadSessionsViewSource();
  assert.match(src, /export\s+function\s+SessionsView\s*\(/,
    'SessionsView.js must provide `export function SessionsView(...)`');
});

test('P8-8 main.js dynamically imports SessionsView and bridges it onto window', async () => {
  const src = await fs.readFile(
    path.join(__dirname, '..', 'public', 'app', 'main.js'),
    'utf8',
  );
  assert.match(src, /import\(\s*['"]\.\/components\/SessionsView\.js['"]\s*\)/,
    'main.js must dynamically import ./components/SessionsView.js');
  assert.match(src, /window\.SessionsView\s*=\s*SessionsView/,
    'main.js must assign window.SessionsView = SessionsView');
});
