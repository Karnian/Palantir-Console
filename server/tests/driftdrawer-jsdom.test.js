// P3-3: DriftDrawer jsdom a11y tests
//
// 테스트 전략:
//   - jsdom 환경에서 Preact UMD 번들을 vm.createContext 로 로드
//   - DriftDrawer.js ES module 구문을 vm 평가용으로 최소 변환 (export 제거)
//   - useEffect 는 Preact 내부에서 setTimeout 으로 예약됨 → await flush 필요
//   - 이벤트는 버블링되므로 button 에서 dispatch → drawerRef 의 keydown 핸들러에 도달
//
// 커버 항목:
//   (a) Tab 순환 — 마지막 focusable 에서 Tab → 첫 번째 focusable 로
//   (b) Shift+Tab 역순환 — 첫 번째 focusable 에서 Shift+Tab → 마지막 focusable 로
//   (c) open=true 시 Close 버튼 자동 포커스
//   (d) Esc 는 drawer 핸들러가 처리하지 않음 (onClose 를 호출하지 않음)
//   (e) open=false 일 때 null 반환 (DOM 에 drawer 없음)

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// ---- helpers ----

const VENDOR_DIR = path.join(__dirname, '..', 'public', 'vendor');
const DRIFT_DRAWER_PATH = path.join(__dirname, '..', 'public', 'app', 'components', 'DriftDrawer.js');

const preactSrc = fs.readFileSync(path.join(VENDOR_DIR, 'preact.umd.js'), 'utf8');
const hooksSrc = fs.readFileSync(path.join(VENDOR_DIR, 'hooks.umd.js'), 'utf8');
const htmSrc = fs.readFileSync(path.join(VENDOR_DIR, 'htm.umd.js'), 'utf8');

// DriftDrawer.js uses ES module syntax — strip `export` keyword so
// vm.runInContext can evaluate it. The function name stays the same
// so this.DriftDrawer assignment (appended below) captures it.
const rawDriftSrc = fs.readFileSync(DRIFT_DRAWER_PATH, 'utf8');
const driftDrawerSrc =
  rawDriftSrc.replace(/^export\s+function\s+DriftDrawer\b/m, 'function DriftDrawer') +
  '\nthis.DriftDrawer = DriftDrawer;';

/**
 * 독립된 jsdom 인스턴스 + vm context 를 생성하고,
 * Preact / hooks / htm UMD 를 로드한 뒤 DriftDrawer 를 평가해서 돌려준다.
 */
function createEnv() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost', pretendToBeVisual: true },
  );
  const { window } = dom;
  const context = vm.createContext(window);

  // hooks UMD 는 CJS 환경에서 require('preact') 를 호출하므로 패치
  context.require = (m) => {
    if (m === 'preact') return context.preact;
    return require(m);
  };

  vm.runInContext(preactSrc, context);
  vm.runInContext(hooksSrc, context);
  vm.runInContext(htmSrc, context);

  // DriftDrawer 의 row 렌더에서 window.timeAgo 를 호출
  context.timeAgo = () => '1m ago';

  vm.runInContext(driftDrawerSrc, context);

  return { window, context };
}

/** Preact useEffect 가 setTimeout 큐에서 실행될 때까지 대기 */
function flushEffects(ms = 100) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 샘플 driftAudit 오브젝트 (버튼이 여러 개 생성되도록 row 포함) */
function makeFakeAudit() {
  return {
    rows: [
      {
        id: 1,
        incoherence_kind: 'pm_hallucination',
        project_id: 'proj-1',
        created_at: new Date().toISOString(),
        pm_claim: '{}',
        db_truth: '{}',
        pm_run_id: 'run-1',
        rationale: null,
      },
    ],
    dismissedCount: 0,
    dismiss: () => {},
    clearDismissed: () => {},
  };
}

/** role="dialog" 안의 focusable 요소 목록 */
function getFocusables(drawerEl) {
  return Array.from(
    drawerEl.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

// ---- tests ----

test('DriftDrawer jsdom: open=false 시 DOM 에 drawer 없음', () => {
  const { window, context } = createEnv();
  const { render, h } = context.preact;
  const root = window.document.getElementById('root');

  render(
    h(context.DriftDrawer, { open: false, onClose: () => {}, driftAudit: null, projects: [] }),
    root,
  );

  const drawerEl = root.querySelector('[role="dialog"]');
  assert.equal(drawerEl, null, 'open=false 면 role=dialog 엘리먼트가 DOM 에 없어야 함');
});

test('DriftDrawer jsdom: open=true 시 Close 버튼 자동 포커스', async () => {
  const { window, context } = createEnv();
  const { render, h } = context.preact;
  const root = window.document.getElementById('root');

  render(
    h(context.DriftDrawer, {
      open: true,
      onClose: () => {},
      driftAudit: makeFakeAudit(),
      projects: [],
    }),
    root,
  );

  await flushEffects();

  const drawerEl = root.querySelector('[role="dialog"]');
  assert.ok(drawerEl, 'drawer 가 렌더되어야 함');

  const active = window.document.activeElement;
  assert.equal(active.tagName, 'BUTTON', '포커스가 버튼에 있어야 함');
  assert.equal(
    active.getAttribute('aria-label'),
    'Close drift drawer',
    'Close 버튼이 자동 포커스 대상이어야 함',
  );
});

test('DriftDrawer jsdom: Tab 순환 — 마지막 focusable 에서 Tab → 첫 번째', async () => {
  const { window, context } = createEnv();
  const { render, h } = context.preact;
  const root = window.document.getElementById('root');

  render(
    h(context.DriftDrawer, {
      open: true,
      onClose: () => {},
      driftAudit: makeFakeAudit(),
      projects: [],
    }),
    root,
  );

  await flushEffects();

  const drawerEl = root.querySelector('[role="dialog"]');
  const focusables = getFocusables(drawerEl);
  assert.ok(focusables.length >= 2, '포커스 가능 요소가 2개 이상이어야 순환 테스트 가능');

  const last = focusables[focusables.length - 1];
  last.focus();
  assert.equal(window.document.activeElement, last, '마지막 요소에 포커스 설정 확인');

  // Tab 이벤트는 버블링으로 drawerRef 의 keydown 핸들러에 도달
  const tabEvent = new window.KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
  });
  last.dispatchEvent(tabEvent);

  assert.equal(
    window.document.activeElement,
    focusables[0],
    'Tab 순환: 마지막 → 첫 번째 focusable 로 이동해야 함',
  );
});

test('DriftDrawer jsdom: Shift+Tab 역순환 — 첫 번째 focusable 에서 Shift+Tab → 마지막', async () => {
  const { window, context } = createEnv();
  const { render, h } = context.preact;
  const root = window.document.getElementById('root');

  render(
    h(context.DriftDrawer, {
      open: true,
      onClose: () => {},
      driftAudit: makeFakeAudit(),
      projects: [],
    }),
    root,
  );

  await flushEffects();

  const drawerEl = root.querySelector('[role="dialog"]');
  const focusables = getFocusables(drawerEl);
  assert.ok(focusables.length >= 2, '포커스 가능 요소가 2개 이상이어야 역순환 테스트 가능');

  const first = focusables[0];
  first.focus();
  assert.equal(window.document.activeElement, first, '첫 번째 요소에 포커스 설정 확인');

  const shiftTabEvent = new window.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  first.dispatchEvent(shiftTabEvent);

  assert.equal(
    window.document.activeElement,
    focusables[focusables.length - 1],
    'Shift+Tab 역순환: 첫 번째 → 마지막 focusable 로 이동해야 함',
  );
});

test('DriftDrawer jsdom: Esc 는 drawer 의 keydown 핸들러에서 onClose 를 호출하지 않음', async () => {
  const { window, context } = createEnv();
  const { render, h } = context.preact;
  const root = window.document.getElementById('root');

  let closeCalled = false;
  render(
    h(context.DriftDrawer, {
      open: true,
      onClose: () => { closeCalled = true; },
      driftAudit: null,
      projects: [],
    }),
    root,
  );

  await flushEffects();

  const drawerEl = root.querySelector('[role="dialog"]');
  // Esc 이벤트를 drawer 에 직접 dispatch
  const escEvent = new window.KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  drawerEl.dispatchEvent(escEvent);

  assert.equal(
    closeCalled,
    false,
    'DriftDrawer 자체 keydown 핸들러는 Esc 를 처리하지 않으므로 onClose 가 호출되지 않아야 함',
  );
});
