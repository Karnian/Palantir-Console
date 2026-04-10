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
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
  assert.ok(body, 'DriftDrawer function not found in app.js');
  assert.match(body, /role="dialog"/, 'role=dialog missing');
  assert.match(body, /aria-modal="true"/, 'aria-modal missing');
  assert.match(body, /aria-labelledby="drift-drawer-title"/, 'aria-labelledby missing');
  assert.match(body, /id="drift-drawer-title"/, 'labelled element id missing');
});

test('P1-11 DriftDrawer installs focus trap + auto-focus via useEffect', async () => {
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
  // Must reference drawerRef + a keydown listener (the focus trap handler).
  assert.match(body, /drawerRef/, 'drawerRef missing');
  assert.match(body, /addEventListener\('keydown'/, 'keydown handler missing (no focus trap)');
  assert.match(body, /\.focus\(\)/, 'autofocus call missing');
  // Must handle Shift+Tab path (reverse cycle).
  assert.match(body, /shiftKey/, 'Shift+Tab reverse cycle missing');
});

test('P1-11 DriftDrawer Close button has aria-label', async () => {
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
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
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
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
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
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
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
  assert.match(
    body,
    /document\.activeElement\s*===\s*lastEl[\s\S]{0,200}?firstEl\.focus\(\)/,
    'forward Tab cycle (lastEl → firstEl) path missing',
  );
});

test('P2-6 DriftDrawer Tab cycle — reverse (firstEl → lastEl) branch present', async () => {
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
  assert.match(
    body,
    /document\.activeElement\s*===\s*firstEl[\s\S]{0,200}?lastEl\.focus\(\)/,
    'reverse Shift+Tab cycle (firstEl → lastEl) path missing',
  );
});

test('P2-6 DriftDrawer focusables selector covers the WAI-ARIA focusable superset', async () => {
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
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
  const src = await loadAppJs();
  const body = sliceFunction(src, 'function DriftDrawer');
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
  const src = await loadAppJs();
  const badgeStart = src.indexOf('PM hallucination / staleness incidents');
  assert.ok(badgeStart > 0, 'drift badge region not located');
  const region = src.slice(badgeStart, badgeStart + 600);
  assert.match(
    region,
    /aria-label=\$\{`Drift warnings: \$\{driftAudit\.totalCount\}/,
    'drift badge must have an aria-label that announces the count to screen readers',
  );
});

// ---- P2-9: Stop/Reset label clarity + PM selector Dropdown swap ----

test('P2-9 Reset PM button has explicit aria-label and scope-clarifying title', async () => {
  const src = await loadAppJs();
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
  const src = await loadAppJs();
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
  const src = await loadAppJs();
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
  const src = await loadAppJs();
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
