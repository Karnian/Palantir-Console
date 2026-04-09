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
