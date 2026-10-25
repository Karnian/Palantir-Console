// Phase K-4 (2026-04-29): WCAG 2.1 AA a11y automation.
//
// Spec lock-in: docs/specs/k4-wcag-a11y-automation-brief.md
//
// Matrix: 14 hash routes × 2 themes (dark/light) × 2 viewports (1280×800 desktop,
// 375×667 mobile) = 56 scenarios. Tagged @a11y so `npm run test:a11y` can grep.
//
// Gate policy (L3):
//   - critical / serious / moderate axe violation → fail
//     (moderate promoted from report-only 2026-07-13, user lock-in — the K-4
//      baseline reached zero moderate violations so the gate tightened with no
//      fix debt; future moderate regressions now fail fix-or-waive)
//   - minor → report-only (logged, no assert)
//
// Waiver policy (L4/L5 r2 transitional baseline):
//   - file: server/tests/e2e/a11y-waivers.json (single file)
//   - schema: { route, theme, viewport, ruleId, selector, reason, expiresAt,
//               ownerSurface?, followupRef?, approvedBy?, kind? }
//   - color-contrast → only `kind: "transitional"` baseline waivers, ≤14 days,
//     full provenance (ownerSurface/followupRef/approvedBy). Non-baseline new
//     contrast violations cannot be waived.
//   - all other rules → ≤30 day expiresAt
//   - expiresAt past today → fail anyway
//   - waiver defined but no matching violation → unused waiver → fail
//   - selector substring matching is intentional baseline compression debt:
//     a broad waiver like `.primary` will absorb future violations on the same
//     route+rule. K-4-followup PRs must narrow these as surfaces are fixed.
//
// Failure output (L6): each violation logs route / theme / viewport / ruleId /
// selector / failureSummary so the maintainer can fix it without re-running.

const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const fs = require('fs');
const path = require('path');

const ROUTES = [
  'dashboard',
  // Manager is intentionally absent from top-level nav but remains routable
  // from the Master card and operator conversation deep links.
  'manager',
  'board',
  'operator/codebases',
  'agents',
  'resources/skills',
  'resources/presets',
  'resources/mcp-servers',
  'resources/models',
  'resources/nodes',
  // U-2: node detail not-found state — deterministic (no probe, no data)
  'resources/nodes/ghost-e2e',
  'memory',
  'actions',
  'operator/roster',
  'operator/specialist',
  'operator/profiles',
];
const THEMES = ['dark', 'light'];

for (const theme of ['dark', 'light']) {
  for (const route of ['owned', 'owned/owned-a11y']) {
    test(`@a11y ${route} ${theme} minimum owned session screen`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await page.addInitScript(value => localStorage.setItem('palantir.theme', value), theme);
      await page.route('**/api/owned-sessions**', async requestRoute => {
        const url = new URL(requestRoute.request().url());
        if (url.pathname.endsWith('/stream')) return requestRoute.fulfill({ contentType: 'text/event-stream', body: ': mock\n\n' });
        const session = { id: 'owned-a11y', cwd: '/safe/project', state: 'active', pending_approvals: 0, last_activity_seq: 1,
          incarnation: { id: 'inc', state: 'alive' } };
        const body = url.pathname.endsWith('/transcript') ? { host: 'running', events: [], next_before_seq: null } :
          url.pathname.endsWith('/owned-a11y') ? { host: 'running', seq_high: 1, state: { session, current_incarnation_id: 'inc',
            incarnations: [{ id: 'inc', state: 'alive', control_available: true }], deliveries: [], controls: [], tool_requests: [] } } :
            { host: 'running', seq_high: 1, sessions: [session] };
        return requestRoute.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(`/#${route}`);
      await expect(page.getByRole('heading', { name: '내 세션', exact: true })).toBeVisible();
      await expect(page.getByText('/safe/project', { exact: route === 'owned' })).toBeVisible();
      const result = await new AxeBuilder({ page }).include('.owned-view').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(result.violations.filter(item => ['critical', 'serious', 'moderate'].includes(item.impact))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

// Owned-session state coverage uses HTTP fixtures and a route-local SSE test double.
// Other application EventSource channels retain their native implementation.
async function installOwnedStateFixture(page, theme, scenario) {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(value => {
    localStorage.setItem('palantir.theme', value);
    const NativeEventSource = window.EventSource;
    window.EventSource = function (url, options) {
      if (!String(url).startsWith('/api/owned-sessions/stream')) {
        return new NativeEventSource(url, options);
      }
      const stream = new EventTarget();
      stream.close = () => {};
      window.ownedA11yStream = stream;
      queueMicrotask(() => stream.dispatchEvent(new Event('open')));
      return stream;
    };
  }, theme);
  const session = {
    id: 'owned-a11y', cwd: '/safe/project', state: 'active', pending_approvals: 2,
    last_activity_seq: 15, incarnation: { id: 'inc', state: 'alive' }
  };
  const incarnation = {
    id: 'inc', state: 'alive', control_available: true, cli_version: '2.1.308',
    account_snapshot: JSON.stringify({ subscriptionType: 'team' }),
    attribution_uncertain: scenario === 'conversation' ? 1 : 0
  };
  const longInput = JSON.stringify({ command: `echo ${'긴도구입력'.repeat(1800)}`, marker: '전문 마지막 표지' });
  const questionInput = {
    questions: [{ question: '어떤 검증을 진행할까요?', multiSelect: true,
      options: [{ label: '단위 검사', description: '빠른 검증' }, { label: '회귀 검사', description: '전체 검증' }] }]
  };
  const toolRequests = ['permissions', 'unreachable'].includes(scenario) ? [
    { id: 'tool-card', incarnation_id: 'inc', tool_use_id: 'tool-use', tool_name: 'Bash',
      state: 'pending', input: longInput.slice(0, 128), input_truncated: true, created_at: 1800000000000 },
    { id: 'question-card', incarnation_id: 'inc', tool_use_id: 'question-use', tool_name: 'AskUserQuestion',
      state: 'pending', input: JSON.stringify(questionInput), created_at: 1800000000001 }
  ] : [];
  const deliveries = scenario === 'conversation' ? [
    { id: 'unknown-prompt', incarnation_id: 'inc', kind: 'prompt', body: JSON.stringify('실행됐을 수 있는 지시'),
      state: 'unknown', created_at: 1800000000000, seq: 1 },
    { id: 'unknown-outcome', incarnation_id: 'inc', kind: 'prompt', body: JSON.stringify('결과를 확인하지 못한 지시'),
      state: 'provider_observed', outcome: 'outcome_unknown', created_at: 1800000000001, seq: 2 }
  ] : [];
  const transcript = scenario === 'conversation' ? [
    { seq: 3, session_id: session.id, incarnation_id: 'inc', type: 'sdk_message', created_at: 1800000000002,
      json: { message: { type: 'assistant', message: { content: [{ type: 'text', text: '검사 **응답**입니다.' }] } } } },
    { seq: 4, session_id: session.id, incarnation_id: 'inc', type: 'sdk_message', created_at: 1800000000003,
      json: { message: { type: 'result', result: '귀속을 확인할 수 없는 결과', total_cost_usd: 0 } } }
  ] : [];
  let previewCount = 0;
  await page.route('**/api/fs?**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ path: session.cwd, root: session.cwd, roots: [session.cwd], directories: [] })
  }));
  await page.route('**/api/owned-sessions**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname.endsWith('/settings-preview')) {
      previewCount++;
      body = {
        ok: previewCount === 1,
        hooks: [{ event: 'PermissionRequest', paths: ['/safe/project/.claude/settings.json'] }],
        mcp_servers: [{ name: 'local-mcp', paths: ['/safe/project/.mcp.json'] }],
        source_paths: ['/safe/project/.claude/settings.json', '/safe/project/.mcp.json'],
        warnings: ['permission_request_hook'],
        ...(previewCount > 1 ? { reason: 'settings_auth_override', detail: '/safe/project/.claude/settings.json' } : {})
      };
    } else if (url.pathname.endsWith('/chunks')) {
      body = { host: 'running', found: true, offset: 0, data: longInput,
        total_bytes: Buffer.byteLength(longInput), done: true };
    } else if (url.pathname.endsWith('/transcript')) {
      body = { host: 'running', events: transcript, next_before_seq: null };
    } else if (url.pathname.endsWith('/owned-a11y')) {
      body = { host: 'running', seq_high: 15, state: { session, current_incarnation_id: 'inc',
        incarnations: [incarnation], deliveries, controls: [], tool_requests: toolRequests } };
    } else {
      body = { host: 'running', seq_high: 15, sessions: [session] };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function checkOwnedStateAccessibility(page) {
  const result = await new AxeBuilder({ page }).include('.owned-view')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.filter(violation => ['critical', 'serious', 'moderate'].includes(violation.impact))).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

for (const theme of ['dark', 'light']) {
  for (const scenario of ['permissions', 'conversation', 'unreachable', 'start']) {
    test(`@a11y owned ${theme} ${scenario} state at 360px`, async ({ page }) => {
      await installOwnedStateFixture(page, theme, scenario);
      const route = scenario === 'start' ? 'owned' : 'owned/owned-a11y';
      await page.goto(`/#${route}`);
      await expect(page.getByRole('heading', { name: '내 세션', exact: true })).toBeVisible();
      if (scenario === 'permissions' || scenario === 'unreachable') {
        const approval = page.locator('.owned-card').filter({ has: page.getByRole('heading', { name: 'Bash', exact: true }) });
        await expect(approval.locator('.owned-tool-full')).toContainText('전문 마지막 표지');
        await expect(page.getByRole('button', { name: '허용', exact: true })).toBeEnabled();
        await expect(page.getByText('어떤 검증을 진행할까요?', { exact: true })).toBeVisible();
        const fullInput = approval.locator('.owned-tool-input');
        await expect(fullInput).not.toHaveAttribute('open');
        if (scenario === 'permissions') {
          await approval.getByText('전문 펼치기', { exact: true }).click();
          await expect(approval.locator('.owned-tool-full')).toBeVisible();
          await page.getByRole('checkbox', { name: /단위 검사/ }).check();
          await expect(page.getByRole('button', { name: '답변 보내기', exact: true })).toBeEnabled();
        } else {
          await page.evaluate(() => window.ownedA11yStream.dispatchEvent(new MessageEvent('host_unreachable', {
            data: JSON.stringify({ seq: 15, current_state_known: false })
          })));
          await expect(page.getByText(/호스트 응답 없음.*기준, 현재 상태 불명/)).toBeVisible();
          for (const field of ['실행', '제어', '상호작용']) {
            await expect(page.locator('.owned-header-field').filter({ hasText: field + ':' })).toContainText(field + ': 불명');
          }
          await expect(page.locator('.owned-last-known').first()).toContainText(/기준 마지막: 생존/);
          const buttons = page.locator('.owned-view button');
          expect(await buttons.count()).toBeGreaterThan(0);
          for (const button of await buttons.all()) await expect(button).toBeDisabled();
          await expect(approval.locator('.owned-tool-full')).toContainText('전문 마지막 표지');
        }
      } else if (scenario === 'conversation') {
        await expect(page.getByText('받음 · 결과 불명', { exact: true })).toBeVisible();
        await expect(page.locator('.owned-unknown').filter({ hasText: '전달 불명' }).first()).toBeVisible();
        await expect(page.getByText('귀속 불명 결과', { exact: true })).toBeVisible();
        await expect(page.locator('.owned-view textarea')).toBeDisabled();
      } else {
        await page.getByRole('button', { name: '새 세션', exact: true }).click();
        const startDialog = page.getByRole('dialog', { name: '새 세션', exact: true });
        await startDialog.getByRole('button', { name: '찾아보기', exact: true }).click();
        const picker = page.getByRole('dialog', { name: '디렉터리 선택', exact: true });
        await expect(picker.locator('.directory-path')).toHaveText('/safe/project');
        await picker.getByRole('button', { name: '선택', exact: true }).click();
        const previewButton = startDialog.getByRole('button', { name: '설정 미리보기', exact: true });
        await previewButton.click();
        await expect(startDialog.getByText(/승인 카드보다 먼저/)).toBeVisible();
        await expect(startDialog.getByText('local-mcp', { exact: false })).toBeVisible();
        await expect(startDialog.getByRole('button', { name: '세션 시작', exact: true })).toBeDisabled();
        await startDialog.getByRole('checkbox').check();
        await expect(startDialog.getByRole('button', { name: '세션 시작', exact: true })).toBeEnabled();
        await checkOwnedStateAccessibility(page);
        await previewButton.click();
        await expect(startDialog.getByText(/설정에 구독 인증을 덮어쓰는/)).toBeVisible();
        await expect(startDialog.getByRole('checkbox')).toBeDisabled();
        await expect(startDialog.getByRole('button', { name: '세션 시작', exact: true })).toBeDisabled();
      }
      await checkOwnedStateAccessibility(page);
    });
  }
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 375, height: 667 },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
// K-4-followup (2026-07-13): moderate promoted from report-only to a hard gate
// (user lock-in). The K-4 baseline reached zero moderate violations across all
// 56 scenarios, so this tightens the gate with no fix debt; future moderate
// regressions now fail (fix-or-waive) instead of only logging. Only `minor`
// stays report-only. Brief: docs/specs/k4-wcag-a11y-automation-brief.md §L3.
const FAIL_IMPACTS = new Set(['critical', 'serious', 'moderate']);
const WAIVERS_PATH = path.join(__dirname, 'a11y-waivers.json');

// L1 scan context: each route exposes [data-view="<key>"] root, so axe
// scope follows that selector. Sidebar/header common chrome still gets
// scanned via the dashboard scenario (where it sits inside the same
// document but outside [data-view]) — to keep noise low we scope to
// [data-view] for non-dashboard routes and also include nav.nav-sidebar
// once on dashboard.
//
// For consolidated sub-routes (e.g. 'resources/skills') the data-view
// attribute is set by the *leaf view* component, which still uses the
// original short key ('skills', 'presets', etc.). We extract the last
// path segment to resolve the correct data-view selector.
//
// scanContextSelector vs viewKey separation (MEDIUM fix):
//   viewKey  — resolves the LEAF data-view for the waitForSelector wait.
//              Must match what the leaf component renders (e.g. 'skills').
//   scanContextSelector — selects the AXE SCOPE root, which for sub-routes
//              is the TabGroupView wrapper (data-view="resources" /
//              data-view="operator"). This widens the scan to include the
//              .sub-tabs chrome (role="group" buttons) that sits OUTSIDE the
//              leaf [data-view] element but INSIDE the group wrapper.
function viewKey(route) {
  // 'operator/profiles' → 'operator-profiles' (legacy data-view kept in component)
  // 'resources/mcp-servers' → 'mcp-servers', 'resources/skills' → 'skills', etc.
  const seg = route.split('/');
  if (seg.length === 1) return route;
  const sub = seg[seg.length - 1];
  if (seg[0] === 'operator' && sub === 'roster') return 'operator-roster';
  if (seg[0] === 'operator' && seg[1] === 'codebases') return 'projects';
  // operator/profiles maps to the component's data-view="operator-profiles"
  if (seg[0] === 'operator' && sub === 'profiles') return 'operator-profiles';
  if (seg[0] === 'resources' && seg[1] === 'nodes' && seg.length === 3) return 'nodes';
  if (seg[0] === 'resources' && sub === 'models') return 'model-policies';
  return sub;
}
function scanContextSelector(route) {
  // For sub-routes, scope to the TabGroupView wrapper (data-view=<group>)
  // so the .sub-tabs chrome is included in the axe scan alongside the
  // active leaf panel. Wait still uses viewKey (leaf) — no conflict.
  const seg = route.split('/');
  if (seg.length > 1) {
    // 'resources/*' → [data-view="resources"], 'operator/*' → [data-view="operator"]
    return `[data-view="${seg[0]}"]`;
  }
  // Single-selector scope per route. Sidebar gets covered transitively in
  // the dashboard scan via include-list (added below).
  return `[data-view="${viewKey(route)}"]`;
}

function loadWaivers() {
  if (!fs.existsSync(WAIVERS_PATH)) return [];
  const text = fs.readFileSync(WAIVERS_PATH, 'utf8').trim();
  if (!text) return [];
  let waivers;
  try {
    waivers = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `a11y-waivers.json is not valid JSON: ${err.message}. ` +
      `Either fix the file or remove it (a missing file = no waivers).`
    );
  }
  if (!Array.isArray(waivers)) {
    throw new Error(`a11y-waivers.json must be an array (got ${typeof waivers}).`);
  }
  // Schema + L4/L5 enforcement at load time so a malformed waiver fails
  // every scenario fast, not silently. `today` is computed in LOCAL time
  // (not UTC) to match how the maintainer reads the date — otherwise a
  // KST-evening run with UTC still on the previous day would push the
  // 14-day transitional window one day short and false-fail the load.
  const _now = new Date();
  const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
  for (const w of waivers) {
    for (const k of ['route', 'theme', 'viewport', 'ruleId', 'selector', 'reason', 'expiresAt']) {
      if (typeof w[k] !== 'string' || !w[k]) {
        throw new Error(
          `a11y-waivers.json entry missing required field "${k}": ${JSON.stringify(w)}`
        );
      }
    }
    if (w.expiresAt < today) {
      throw new Error(
        `a11y-waivers.json entry expired on ${w.expiresAt} (today=${today}): ` +
        `route=${w.route} theme=${w.theme} viewport=${w.viewport} rule=${w.ruleId}. ` +
        `Either renew with a fresh expiresAt + Codex review, or remove it (the underlying issue must be fixed).`
      );
    }
    // K-4 r2 transitional waiver rule (spec L4/L5):
    // color-contrast may only be waived as a "transitional" baseline entry
    // with full provenance metadata + ≤14d expiresAt. All other rules can
    // use the simpler base schema.
    if (w.ruleId === 'color-contrast') {
      if (w.kind !== 'transitional') {
        throw new Error(
          `a11y-waivers.json color-contrast waiver must have kind="transitional" ` +
          `(selector="${w.selector}"). New contrast violations cannot be waived — fix or restructure.`
        );
      }
      for (const k of ['ownerSurface', 'followupRef', 'approvedBy']) {
        if (typeof w[k] !== 'string' || !w[k]) {
          throw new Error(
            `a11y-waivers.json transitional color-contrast waiver missing "${k}" ` +
            `(selector="${w.selector}"). All transitional waivers require route/theme/viewport/selector/ownerSurface/followupRef/approvedBy/expiresAt.`
          );
        }
      }
      // expiresAt ≤ today + 14 days
      const expiresMs = Date.parse(w.expiresAt + 'T00:00:00Z');
      const todayMs = Date.parse(today + 'T00:00:00Z');
      if (Number.isNaN(expiresMs) || expiresMs - todayMs > 14 * 24 * 60 * 60 * 1000) {
        throw new Error(
          `a11y-waivers.json transitional color-contrast waiver expiresAt must be ≤14 days from today. ` +
          `Got ${w.expiresAt} (today=${today}, selector="${w.selector}").`
        );
      }
    } else {
      // Non-contrast waivers default to ≤30 day window (spec L5).
      // Past-expiry already failed above, so we only check the upper bound here.
      const expiresMs = Date.parse(w.expiresAt + 'T00:00:00Z');
      const todayMs = Date.parse(today + 'T00:00:00Z');
      if (Number.isNaN(expiresMs) || expiresMs - todayMs > 30 * 24 * 60 * 60 * 1000) {
        throw new Error(
          `a11y-waivers.json waiver expiresAt must be ≤30 days from today (got ${w.expiresAt}, ` +
          `today=${today}, rule=${w.ruleId}, selector="${w.selector}"). ` +
          `Renew with a fresh expiresAt or shorten the window.`
        );
      }
    }
  }
  return waivers;
}

function matchesWaiver(waivers, ctx, violation, node) {
  // node.target is an array of selector parts. Match if any part contains
  // the waiver selector OR the waiver selector matches the joined target.
  // Wildcard "*" allowed for theme / viewport so a single transitional
  // baseline waiver can cover the same surface across both themes and
  // both viewports — without it we would need 4 rows per surface
  // (2 themes × 2 viewports) and the file becomes unmaintainable.
  // `route` and `ruleId` must always match exactly.
  const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
  const matchField = (waiverVal, ctxVal) => waiverVal === '*' || waiverVal === ctxVal;
  return waivers.find(w =>
    w.route === ctx.route &&
    matchField(w.theme, ctx.theme) &&
    matchField(w.viewport, ctx.viewport) &&
    w.ruleId === violation.id &&
    (target === w.selector || target.includes(w.selector))
  );
}

// Force the theme by writing to localStorage BEFORE first paint, then
// reload so theme-init.js (head-loaded synchronous script) reads it
// during the next document load. The subsequent `page.goto('/#<route>')`
// is a hash navigation that does NOT re-run head scripts, so the reload
// here is the only way to make the theme take effect for the scan.
async function setTheme(page, theme) {
  await page.goto('/'); // any same-origin page so localStorage is reachable
  await page.evaluate((t) => {
    try {
      window.localStorage.setItem('palantir.theme', t);
    } catch {
      /* ignore */
    }
  }, theme);
  await page.reload(); // re-run theme-init.js with the new localStorage value
}

// Track which waivers are touched so we can fail on unused ones at the
// end of the suite (L5: unused waiver → fail).
const _touchedWaivers = new Set();
function waiverKey(w) {
  return `${w.route}|${w.theme}|${w.viewport}|${w.ruleId}|${w.selector}`;
}

const _allWaivers = loadWaivers();

for (const route of ROUTES) {
  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      test(`@a11y a11y: ${route} [${theme}/${vp.name}]`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await setTheme(page, theme);

        await page.goto(`/#${route}`);
        // Wait for the route root to render. K-4 baseline (L1) — we scan
        // the empty / EmptyState fallback for state-bearing routes.
        // Sub-routes (e.g. 'resources/skills') resolve via the leaf view's
        // data-view attribute (viewKey extracts the correct key).
        await page.waitForSelector(`[data-view="${viewKey(route)}"]`, { timeout: 10000 });

        const builder = new AxeBuilder({ page })
          .withTags(WCAG_TAGS)
          .include(scanContextSelector(route));

        const results = await builder.analyze();

        const ctx = { route, theme, viewport: vp.name };
        const blocking = [];
        const reportOnly = [];

        for (const violation of results.violations) {
          for (const node of violation.nodes) {
            const matched = matchesWaiver(_allWaivers, ctx, violation, node);
            if (matched) {
              _touchedWaivers.add(waiverKey(matched));
              continue;
            }
            // Default to 'unknown' (NOT 'minor') so a null/absent impact fails
            // CLOSED below rather than silently slipping into report-only (codex
            // re-review). axe normally sets one of critical/serious/moderate/minor.
            const impact = node.impact || violation.impact || 'unknown';
            const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
            const entry = {
              route,
              theme,
              viewport: vp.name,
              ruleId: violation.id,
              impact,
              selector: target,
              failureSummary: node.failureSummary || violation.help || '',
            };
            if (FAIL_IMPACTS.has(impact)) {
              blocking.push(entry); // critical / serious / moderate → gate
            } else if (impact === 'minor') {
              reportOnly.push(entry); // minor → logged, non-blocking (ONLY minor)
            } else {
              // any unknown/null impact is fail-CLOSED (a violation must never
              // slip past on a missing impact) — codex re-review of the gate.
              blocking.push(entry);
            }
          }
        }

        // L6 output: every blocking violation gets one human-readable line.
        if (blocking.length > 0) {
          const lines = blocking.map(b =>
            `  [${b.impact}] route=${b.route} theme=${b.theme} viewport=${b.viewport} ` +
            `rule=${b.ruleId} selector="${b.selector}"\n      → ${b.failureSummary.replace(/\n/g, '\n        ')}`
          );
          throw new Error(
            `${blocking.length} blocking a11y violation(s) at ${route} [${theme}/${vp.name}]:\n` +
            lines.join('\n') +
            `\n\nFix the surface OR add a waiver to a11y-waivers.json. ` +
            `color-contrast waivers must be kind="transitional" with ≤14d expiresAt + ownerSurface + followupRef + approvedBy.`
          );
        }

        // minor → report-only summary line (separate section so it doesn't
        // drown the gate output). moderate is now a blocking impact (above).
        if (reportOnly.length > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[a11y report-only] ${route} [${theme}/${vp.name}] — ` +
            `${reportOnly.length} minor violation(s): ` +
            reportOnly.map(m => `${m.ruleId}@${m.selector}`).join(', ')
          );
        }
      });
    }
  }
}

// L5 unused-waiver gate: runs once after every scenario finishes. A waiver
// that never matched any actual violation means the underlying issue was
// already fixed — drop the waiver to keep the file honest.
test.afterAll(() => {
  if (_allWaivers.length === 0) return;
  const unused = _allWaivers.filter(w => !_touchedWaivers.has(waiverKey(w)));
  if (unused.length > 0) {
    const lines = unused.map(w =>
      `  route=${w.route} theme=${w.theme} viewport=${w.viewport} rule=${w.ruleId} selector="${w.selector}" (reason: ${w.reason})`
    );
    throw new Error(
      `${unused.length} unused waiver(s) in a11y-waivers.json — ` +
      `the underlying issue was likely fixed; remove the entry to keep the file honest:\n` +
      lines.join('\n')
    );
  }
});

// C1: populated session assistant, compact panel, and evidence timeline in both themes and sizes.
for (const theme of THEMES) {
  for (const vp of [...VIEWPORTS, { name: 'drawer', width: 1100, height: 900 }]) {
    test(`@a11y session-hub manager [${theme}/${vp.name}]`, async ({ page }) => {
      const { mockSessionHub, expectAssistantLayout, openSnapshotAnswer } = require('./helpers/session-hub');
      await mockSessionHub(page, { longText: true });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await setTheme(page, theme);
      await page.goto('/#manager');
      await expect(page.locator('button.session-evidence')).toBeVisible();
      await expect(page.locator('.manager-msg-row-user .manager-msg-content'))
        .toHaveText('지금 각 세션 뭐 하고 있어?');
      await expect(page.locator('.manager-msg-assistant .markdown-body h2')).toHaveText('검토 결과');
      await expect(page.locator('.session-hub-tools summary')).toContainText('도구 2회 사용');
      await expect(page.locator('.session-hub-manager')).toHaveAttribute('data-right', 'closed');
      const check = async () => {
        await expectAssistantLayout(page);
        const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS)
          .include('[data-view="manager"]').analyze();
        expect(result.violations.filter(item => item.impact !== 'minor')).toEqual([]);
      };
      await check();
      await page.locator('button.session-evidence').click();
      await expect(page.locator('.work-event').first()).toBeVisible();
      await expect(page.locator('.session-hub-detail-header')).toBeFocused();
      await check();
      await openSnapshotAnswer(page);
      await check();
      await page.getByRole('button', { name: '오른쪽 칸 닫기', exact: true }).click();
      await expect(page.locator('.session-hub-manager')).toHaveAttribute('data-right', 'closed');
      await expect(page.getByRole('textbox', { name: '세션 비서에게 질문', exact: true })).toBeFocused();
      if (vp.width < 900) await page.getByRole('button', { name: '목록', exact: true }).click();
      await expect(page.locator('button.session-row')).toHaveCount(3);
      await expect(page.locator('#hub-query')).toBeVisible();
      await expect(page.locator('.session-rows .work-label, .session-rows .work-card-footer')).toHaveCount(0);
      await check();
    });
  }
}
