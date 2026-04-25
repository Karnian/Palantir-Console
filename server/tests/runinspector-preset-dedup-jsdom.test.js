// D3-1 — RunInspector preset tab in-flight dedup (jsdom + Preact)
//
// 전략 (Codex Round 1 설계 권고안 적용):
//   - jsdom+Preact UMD 인프라 사용 (helpers/jsdom-preact.js)
//   - vm context 에 apiFetch / timeAgo / addToast 를 사전 주입 (stripped import 대체)
//   - apiFetch stub 은 URL-based routing: /preset-snapshot 요청만 카운트
//   - 첫 번째 /preset-snapshot 응답을 deferred promise 로 지연 → in-flight 상태에서 두 번째 클릭
//   - terminal 상태 run (status='completed', preset_id 포함) → polling loop 조기 종료
//   - after resolve: 탭 재클릭 → /preset-snapshot 두 번째 호출 발생 (재시도 가능)
//
// 검증 항목:
//   (a) 첫 번째 preset 탭 클릭 → /preset-snapshot 1회 호출 시작
//   (b) in-flight 중 두 번째 클릭 → 추가 호출 없음 (dedup)
//   (c) 응답 완료 후 세 번째 클릭 → /preset-snapshot 2번째 호출 가능 (재시도)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

// Deferred promise helper: lets the test control when the promise resolves.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Build a jsdom+Preact environment with RunInspector loaded.
 *
 * - apiFetch is injected with URL-based dispatch; only /preset-snapshot counts
 *   toward presetSnapshotCallCount.
 * - Polling effect routes (/output, /events, /api/runs/:id) return minimal
 *   terminal responses so the loop exits quickly.
 * - timeAgo and addToast stubs prevent undefined-call errors.
 */
function createEnv() {
  const env = createPreactEnv();

  // Counter for /preset-snapshot calls specifically
  let presetSnapshotCallCount = 0;
  // Deferred list — each entry controls one /preset-snapshot response
  const presetDeferreds = [];

  // apiFetch stub: URL routing
  env.context.apiFetch = async function (url, _opts) {
    if (url.includes('/preset-snapshot')) {
      presetSnapshotCallCount++;
      // Pop from deferred queue; if empty return immediately (for re-try)
      if (presetDeferreds.length > 0) {
        return presetDeferreds.shift().promise;
      }
      // Default: resolve immediately with minimal preset data
      return { snapshot: { preset_id: 'wp_test', preset_snapshot_hash: 'abc', applied_at: 'now', core: {} }, drift: null, current_preset: {} };
    }
    if (url.includes('/output')) return { output: '' };
    if (url.includes('/events')) return { events: [] };
    // /api/runs/:id — return terminal run so poll loop exits
    return { run: { id: 'run_test', status: 'completed', preset_id: 'wp_test', task_title: 'Test', agent_name: 'test', created_at: new Date().toISOString() } };
  };

  // Inject stripped-import stubs
  env.context.timeAgo = () => '5m ago';
  env.context.addToast = () => {};
  // Phase F: RunInspector now joins the shared `useEscape` stack so its
  // ESC handler races on the same LIFO as Modal / DriftDrawer / palette.
  // The jsdom-preact loader strips `import ... from '../lib/...'`, so we
  // provide a no-op stub. The preset-dedup tests don't exercise ESC, so
  // a stub is sufficient.
  env.context.useEscape = () => {};

  // Load RunInspector (strips apiFetch/addToast/timeAgo imports, replaces vendor imports)
  env.loadComponent('RunInspector');

  return {
    env,
    getPresetSnapshotCallCount: () => presetSnapshotCallCount,
    pushPresetDeferred: () => {
      const d = deferred();
      presetDeferreds.push(d);
      return d;
    },
    cleanup: env.cleanup,
  };
}

/**
 * Render a RunInspector with a terminal run that has preset_id set,
 * which causes the Preset tab to render.
 */
function renderRunInspector(env, runOverrides = {}) {
  const { render, h } = env.env.context.preact;
  const root = env.env.document.getElementById('root');

  const run = {
    id: 'run_test',
    status: 'completed',
    preset_id: 'wp_test',
    task_title: 'Test Task',
    agent_name: 'test-agent',
    created_at: new Date().toISOString(),
    parent_run_id: null,
    result_summary: null,
    ...runOverrides,
  };

  render(
    h(env.env.context.RunInspector, { run, onClose: () => {} }),
    root,
  );
  return root;
}

/**
 * Find the Preset tab button (text starts with 'Preset' — may also include drift indicator).
 */
function findPresetTab(root) {
  const buttons = Array.from(root.querySelectorAll('.run-inspector-tab'));
  return buttons.find(b => b.textContent.trim().startsWith('Preset'));
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

test('RunInspector preset tab: first click → /preset-snapshot called once', async (t) => {
  const ctx = createEnv();
  t.after(ctx.cleanup);

  const root = renderRunInspector(ctx);
  // Let mount effects settle (polling starts, then exits quickly on terminal run)
  await flushEffects(50);

  const tab = findPresetTab(root);
  assert.ok(tab, 'Preset tab button should render (run has preset_id)');

  // Zero-call baseline: no /preset-snapshot before any tab click
  assert.equal(ctx.getPresetSnapshotCallCount(), 0,
    'zero /preset-snapshot calls before first preset tab click (baseline)');

  // Click once
  tab.click();
  await flushEffects(50);

  assert.equal(ctx.getPresetSnapshotCallCount(), 1, 'first click triggers exactly 1 /preset-snapshot call');
});

test('RunInspector preset tab: in-flight click → dedup (no second fetch)', async (t) => {
  const ctx = createEnv();
  t.after(ctx.cleanup);

  // Register a deferred response for the first /preset-snapshot call.
  // This keeps presetFetchRef.current === true until we resolve.
  const first = ctx.pushPresetDeferred();

  const root = renderRunInspector(ctx);
  await flushEffects(50);

  const tab = findPresetTab(root);
  assert.ok(tab, 'Preset tab button should render');

  // First click — starts fetch, presetFetchRef.current = true
  tab.click();
  await flushEffects(10); // enough for the async click handler to start

  assert.equal(ctx.getPresetSnapshotCallCount(), 1, 'first click: 1 /preset-snapshot call started');

  // Second click while still in-flight → dedup guard should fire (return early)
  tab.click();
  await flushEffects(10);

  assert.equal(ctx.getPresetSnapshotCallCount(), 1, 'second click while in-flight: still 1 call (dedup)');

  // Resolve the first deferred
  first.resolve({ snapshot: { preset_id: 'wp_test', preset_snapshot_hash: 'abc', applied_at: 'now', core: {} }, drift: null, current_preset: {} });
  await flushEffects(50);

  // Call count still 1 — no extra fetch from the dedup'd click
  assert.equal(ctx.getPresetSnapshotCallCount(), 1, 'after resolve: still 1 call (dedup was effective)');
});

test('RunInspector preset tab: after completion → re-click triggers new fetch', async (t) => {
  const ctx = createEnv();
  t.after(ctx.cleanup);

  const first = ctx.pushPresetDeferred();

  const root = renderRunInspector(ctx);
  await flushEffects(50);

  const tab = findPresetTab(root);
  assert.ok(tab, 'Preset tab button should render');

  // First click — starts fetch
  tab.click();
  await flushEffects(10);
  assert.equal(ctx.getPresetSnapshotCallCount(), 1, 'first click: 1 call');

  // Resolve first fetch → presetFetchRef.current resets to false
  first.resolve({ snapshot: { preset_id: 'wp_test', preset_snapshot_hash: 'abc', applied_at: 'now', core: {} }, drift: null, current_preset: {} });
  await flushEffects(50);

  // Re-click after completion → new fetch should fire
  tab.click();
  await flushEffects(50);

  assert.equal(ctx.getPresetSnapshotCallCount(), 2, 'third click after completion: 2 total /preset-snapshot calls');
});

test('RunInspector preset tab: run with null preset_id → preset tab button absent on initial render', async (t) => {
  // Note: this test only checks the _initial_ render, before any poll cycle updates
  // currentRun from apiFetch. The component conditionally renders the tab based on
  // currentRun?.preset_id — passing null means it should be absent at mount time.
  const ctx = createEnv();
  t.after(ctx.cleanup);

  const { render, h } = ctx.env.context.preact;
  const root = ctx.env.document.getElementById('root');

  const run = {
    id: 'run_no_preset',
    status: 'completed',
    preset_id: null,   // no preset
    task_title: 'No Preset Task',
    agent_name: 'test-agent',
    created_at: new Date().toISOString(),
    parent_run_id: null,
    result_summary: null,
  };

  // Render synchronously — check before any flushEffects so poll hasn't run
  render(h(ctx.env.context.RunInspector, { run, onClose: () => {} }), root);

  // Check immediately after synchronous render (before effects flush)
  const tabsBeforeEffects = Array.from(root.querySelectorAll('.run-inspector-tab'));
  const presetTabBeforeEffects = tabsBeforeEffects.find(b => b.textContent.trim().startsWith('Preset'));
  assert.equal(presetTabBeforeEffects, undefined,
    'Preset tab should not render on initial sync render when run.preset_id is null');
});
