'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSnapshots } = require('../../helpers/work-board-fixture.cjs');
const REV = '0123456789abcdef';
const HASH = 'a'.repeat(64);

async function mockSessionHub(page, { observe = true, clock = true, longText = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-e2e-'));
  let alpha, beta;
  try { ({ alpha, beta } = createSnapshots(root)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  if (longText) {
    alpha.machine.label = `Mac-${'긴머신이름'.repeat(30)}`;
    for (const session of alpha.sessions) {
      session.ai_title = '긴 세션 제목 '.repeat(50);
      session.repo_label = 'long-repository-'.repeat(50);
    }
    for (const instruction of alpha.instructions) instruction.text += ` ${'긴지시본문'.repeat(200)}`;
  }
  alpha.sessions[0].status = { state: 'working', source: 'orca', evidence_at: alpha.generated_at, reason: null };
  alpha.sessions[1].status = { state: 'working', source: 'transcript',
    evidence_at: '2026-10-01T00:00:00Z', reason: 'turn_open' };
  beta.sessions[0].status = { state: 'ended', source: 'transcript', evidence_at: beta.generated_at, reason: null };
  const key = alpha.sessions[0].key;
  const wideTable = [
    `| ${Array.from({ length: 10 }, (_, i) => `열 ${i + 1}`).join(' | ')} |`,
    `| ${Array(10).fill('---').join(' | ')} |`,
    ...Array.from({ length: 8 }, (_, row) =>
      `| ${Array.from({ length: 10 }, (_, col) =>
        `session${row}${col}${'longcellcontent'.repeat(5)}`).join(' | ')} |`),
  ].join('\n');
  const shortTable = '| 이름 | 값 |\n| --- | --- |\n| 항목 | 내용 |';
  let proposals = [{ id: 'proposal-1', operation: 'add', kind: 'preference', content: '한국어로 간단히 답변',
    reason: '사용자 요청', revision: 1, content_hash: HASH, source_content: '한국어로 간단히 답해 줘',
    source_thread_id: 'thread-1', source_message_id: 'user-1', status: 'pending' }];
  let state = { thread_id: 'thread-1', epoch: 'visual-boot', version: 1, state: 'running', generation: 1,
    memory: { pending_count: 1, revision: 0 }, turnInProgress: false, messages: [
      { id: 'user-1', seq: 1, turn_id: 'turn-1', role: 'user', content: '지금 각 세션 뭐 하고 있어?' },
      { id: 'answer-1', seq: 2, turn_id: 'turn-1', role: 'assistant', status: 'complete',
        content: '## 검토 결과\n\n- Mac에서 인증 흐름을 검토했습니다. ' + `[[session:${key}@${REV}]]`
          + (longText ? `\n\n${'긴답변'.repeat(20)}\n\n\`\`\`\n${'long-code-'.repeat(100)}\n\`\`\`\n\n${wideTable}\n\n${shortTable}` : '') },
      { id: 'tool-1', seq: 3, turn_id: 'turn-1', role: 'tool_note',
        content: '검색: 인증' + (longText ? ` ${'long-search-query-'.repeat(80)}` : '') },
      { id: 'tool-2', seq: 4, turn_id: 'turn-1', role: 'tool_note',
        content: '세션 열기: 인증 검토' + (longText ? ` ${'긴세션도구본문'.repeat(80)}` : ''),
        memory_proposal_id: 'proposal-1' },
    ] };
  let threads = [{ id: 'thread-1', title: '현재 대화' }, { id: 'thread-old', title: '이전 검토' }];
  if (clock) await page.clock.install({ time: new Date('2026-10-10T03:10:00.000Z') });
  // route.fulfill() ends its SSE body. Keep this fixture connected after its snapshot instead of emitting EOF errors.
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    window.EventSource = class SessionHubSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      constructor(url, options = {}) {
        super();
        const resolved = new URL(url, location.href);
        if (resolved.origin !== location.origin || resolved.pathname !== '/api/session-hub/chat/stream') {
          return new NativeEventSource(url, options);
        }
        this.url = resolved.href; this.withCredentials = !!options.withCredentials;
        this.readyState = SessionHubSource.CONNECTING;
        this.controller = new AbortController();
        this.addEventListener('open', event => this.onopen?.(event));
        this.addEventListener('error', event => this.onerror?.(event));
        fetch(this.url, { signal: this.controller.signal,
          credentials: this.withCredentials ? 'include' : 'same-origin' }).then(async response => {
          if (!response.ok) throw new Error('Fixture stream failed');
          const frame = await response.text();
          if (this.readyState === SessionHubSource.CLOSED) return;
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!data) throw new Error('Fixture snapshot missing');
          this.readyState = SessionHubSource.OPEN;
          this.dispatchEvent(new Event('open'));
          if (this.readyState !== SessionHubSource.CLOSED) {
            this.dispatchEvent(new MessageEvent('snapshot', { data, origin: resolved.origin }));
          }
        }).catch(() => {
          if (this.readyState === SessionHubSource.CLOSED) return;
          this.readyState = SessionHubSource.CLOSED; this.dispatchEvent(new Event('error'));
        });
      }
      close() { this.readyState = SessionHubSource.CLOSED; this.controller.abort(); }
    };
  });
  await page.route('**/api/health', route => route.fulfill({ json: { sessionHubActive: true } }));
  if (observe) await page.route('**/api/observe/snapshots**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/snapshots')) return route.fulfill({ json: { rev: REV, answers: true, snapshots: [
      { machine_id: 'alpha', machine_label: alpha.machine.label, generated_at: alpha.generated_at, sha256: HASH },
      { machine_id: 'beta', machine_label: 'codev2', generated_at: beta.generated_at, sha256: HASH },
      { name_id: 'unreadable', error_code: 'parse_error' },
    ] } });
    return route.fulfill({ json: url.pathname.endsWith('/alpha') ? alpha : beta });
  });
  if (observe) await page.route('**/api/observe/answers**', route => {
    const request = route.request();
    if (Object.keys(request.headers()).some(name => name.toLowerCase() === 'authorization')) {
      return route.fulfill({ status: 403, json: { error: 'cookie auth required' } });
    }
    const url = new URL(request.url());
    const raw = url.search.slice(1);
    const parts = raw.split('&');
    const keys = ['machine', 'key', 'instruction', 'rev'];
    const invalid = () => route.fulfill({ status: 400, json: { error: 'invalid_query' } });
    if (request.method() !== 'GET' || Buffer.byteLength(raw, 'utf8') > 2048
      || parts.length !== keys.length) return invalid();
    const query = Object.create(null);
    for (const part of parts) {
      const pair = part.split('=');
      if (pair.length !== 2 || !keys.includes(pair[0]) || Object.hasOwn(query, pair[0])) return invalid();
      try { query[pair[0]] = decodeURIComponent(pair[1]); }
      catch { return invalid(); }
    }
    const snapshot = query.machine === 'alpha' ? alpha : query.machine === 'beta' ? beta : null;
    if (query.rev !== HASH || !snapshot?.instructions.some(instruction =>
      instruction.id === query.instruction && instruction.session_key === query.key)) return invalid();
    return route.fulfill({ json: { status: 'final', reason: null,
      text: '로그인 리다이렉트 테스트를 추가했습니다.\n**검토 결과**는 평문으로 표시합니다.\n' + 'long-answer-'.repeat(8),
      truncated: true, redacted: true, shared_turn: true,
      answer_at: '2026-10-10T03:00:00.000Z', observed_at: '2026-10-10T03:10:00.000Z' } });
  });
  await page.route('**/api/session-hub/snapshots/**', route => route.fulfill({ json: {
    enabled: true, targets: [
      { name: 'mac', running: false, last_success_at: alpha.generated_at, last_result: { code: 'ok' } },
      { name: 'codev2', running: false, last_success_at: beta.generated_at, last_result: { code: 'ok' } }],
  }, status: route.request().method() === 'POST' ? 202 : 200 }));
  await page.route('**/api/session-hub/memory**', route => {
    if (route.request().method() === 'POST') proposals = [];
    return route.fulfill({ json: { memories: [], proposals, pending_count: proposals.length, revision: 0 } });
  });
  await page.route('**/api/session-hub/chat/**', route => {
    const url = new URL(route.request().url()), name = url.pathname.split('/').at(-1);
    const method = route.request().method();
    if (name === 'stream') return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `event: snapshot\ndata: ${JSON.stringify(state)}\n\n` });
    if (name === 'threads' && method === 'GET') return route.fulfill({ json: { threads } });
    if (method === 'DELETE') {
      threads = threads.filter(thread => !url.pathname.endsWith(`/${thread.id}`));
      return route.fulfill({ json: {} });
    }
    if (name === 'messages') return route.fulfill({ json: { thread_id: 'thread-old', messages: [
      { id: 'old-answer', seq: 1, role: 'assistant', content: '이전 대화 기록입니다.', status: 'complete' },
    ] } });
    if (name === 'threads') state = { ...state, thread_id: 'thread-2', messages: [] };
    if (name === 'stop') state = { ...state, state: 'idle' };
    if (name === 'start') state = { ...state, state: 'running' };
    if (name === 'message') state = { ...state, messages: [...state.messages,
      { id: 'user-next', seq: 5, role: 'user', content: route.request().postDataJSON().text },
      { id: 'answer-next', seq: 6, role: 'assistant', content: `인증 세션입니다. [[session:${key}@${REV}]]` }] };
    if (method === 'POST') state = { ...state, version: state.version + 1 };
    return route.fulfill({ json: state });
  });
}

async function expectNoHorizontalOverflow(page) {
  const { expect } = require('@playwright/test');
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth
    <= document.documentElement.clientWidth)).toBe(true);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  for (const selector of ['.session-hub-chat', '.all-sessions-panel', '.work-search', '.session-row', '.work-answer', '.work-answer-toggle']) {
    for (const element of await page.locator(selector).all()) {
      if (!await element.isVisible()) continue;
      const box = await element.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(clientWidth + 1);
      if (selector === '.work-answer') {
        expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      }
    }
  }
}
async function expectAssistantLayout(page) {
  const { expect } = require('@playwright/test');
  await expectNoHorizontalOverflow(page);
  await expect(page.locator('.session-hub-chat .session-hub-error')).toHaveCount(0);
  const manager = page.locator('.session-hub-manager');
  const rightPanel = page.locator('.session-hub-panel-side');
  const closed = await manager.getAttribute('data-right') === 'closed';
  if (closed) {
    await expect(rightPanel).toBeHidden();
    await expect(rightPanel).toHaveAttribute('hidden', '');
    await expect(manager.locator('.session-hub-segments button').filter({ hasText: /^상세$/ })).toBeDisabled();
  } else if (page.viewportSize().width >= 900) await expect(rightPanel).toBeVisible();
  const sidebar = page.locator('.session-hub-sidebar');
  if (await sidebar.isVisible()) {
    const box = await sidebar.boundingBox(), header = await page.locator('.session-hub-sidebar-header').boundingBox();
    expect(header.x).toBeGreaterThanOrEqual(box.x);
    expect(header.x + header.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(header.height).toBeLessThan(145);
    const filters = await page.locator('.session-hub-filters .dropdown-button').all();
    const boxes = await Promise.all(filters.map(button => button.boundingBox()));
    expect(boxes).toHaveLength(3);
    for (const filter of boxes) {
      expect(Math.abs(filter.y - boxes[0].y)).toBeLessThan(2);
      expect(filter.height).toBe(28);
      expect(filter.x + filter.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
    if (page.viewportSize().width >= 900) {
      expect(box.width).toBeGreaterThanOrEqual(260); expect(box.width).toBeLessThanOrEqual(300);
      const chat = await page.locator('.session-hub-chat').boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(chat.x + 1);
      expect(header.y + header.height).toBeLessThanOrEqual(box.y + box.height);
      if (closed) {
        const layout = await manager.boundingBox();
        expect(Math.abs(chat.x + chat.width - layout.x - layout.width)).toBeLessThan(2);
      } else if (page.viewportSize().width >= 1280) {
        const right = await rightPanel.boundingBox();
        expect(chat.x + chat.width).toBeLessThanOrEqual(right.x + 1);
      }
    }
  }
  await expect(page.locator('.session-hub-chat .session-hub-snapshot-line')).toHaveCount(0);
  await expect(page.locator('.session-hub-chat .work-header')).toHaveCount(0);
}
async function expectChatColumn(page, { keyboard = false } = {}) {
  const { expect } = require('@playwright/test');
  const chat = page.locator('.session-hub-chat');
  // Mobile timeline/list panes hide the chat entirely.
  if (!await chat.isVisible()) return;
  const box = await chat.boundingBox();
  const messages = page.locator('.session-hub-messages');
  const messageBox = await messages.boundingBox();
  expect(Math.abs(messageBox.width - box.width)).toBeLessThanOrEqual(1);
  const scrollbarWidth = await messages.evaluate(node => node.offsetWidth - node.clientWidth);
  if (box.width > 900) {
    const left = box.x + (box.width - 900) / 2 + 16;
    const right = left + 900 - 32;
    for (const row of await chat.locator('.manager-msg-row').all()) {
      if (!await row.isVisible()) continue;
      const rowBox = await row.boundingBox();
      expect(rowBox.x).toBeGreaterThanOrEqual(left - 1);
      expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(right + 1);
      const isUser = await row.evaluate(node => node.classList.contains('manager-msg-row-user'));
      expect(Math.abs(isUser ? rowBox.x + rowBox.width - (right - scrollbarWidth) : rowBox.x - left))
        .toBeLessThanOrEqual(2);
    }
    const textarea = await chat.locator('.session-hub-input textarea').boundingBox();
    const send = await chat.locator('.session-hub-input button[type="submit"]').boundingBox();
    expect(Math.abs(textarea.x - left)).toBeLessThanOrEqual(2);
    expect(Math.abs(send.x + send.width - right)).toBeLessThanOrEqual(2);
    for (const row of await chat.locator('.manager-msg-row-assistant').all()) {
      if (await row.isVisible()) {
        expect(Math.abs(textarea.x - (await row.boundingBox()).x)).toBeLessThanOrEqual(2);
      }
    }
    for (const row of await chat.locator('.manager-msg-row-user').all()) {
      if (await row.isVisible()) {
        const rowBox = await row.boundingBox();
        expect(Math.abs(send.x + send.width - rowBox.x - rowBox.width - scrollbarWidth))
          .toBeLessThanOrEqual(2);
      }
    }
  } else {
    expect(await messages.evaluate(node => getComputedStyle(node).paddingLeft)).toBe('16px');
    expect(await chat.locator('.session-hub-input')
      .evaluate(node => getComputedStyle(node).paddingLeft)).toBe('12px');
  }
  const wrappers = chat.locator('.session-hub-table-scroll');
  expect(await wrappers.count()).toBeGreaterThanOrEqual(1);
  let overflowing = 0, shortTables = 0;
  for (const wrapper of await wrappers.all()) {
    await expect(wrapper).toBeVisible();
    await expect(wrapper).toHaveAttribute('tabindex', '0');
    expect(await wrapper.getAttribute('role')).toBeNull();
    expect(await wrapper.getAttribute('aria-label')).toBeNull();
    const dimensions = await wrapper.evaluate(node => {
      const wrapperBox = node.getBoundingClientRect();
      const bubbleBox = node.closest('.manager-msg').getBoundingClientRect();
      const table = node.querySelector('table');
      return { right: wrapperBox.right, bubbleRight: bubbleBox.right,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        overflowX: getComputedStyle(node).overflowX, display: getComputedStyle(table).display,
        tableWidth: table.getBoundingClientRect().width, columns: table.rows[0].cells.length };
    });
    expect(['auto', 'scroll']).toContain(dimensions.overflowX);
    expect(dimensions.display).toBe('table');
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.bubbleRight + 1);
    if (dimensions.columns > 2) {
      expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
      overflowing++;
      if (keyboard && overflowing === 1) {
        await wrapper.evaluate(node => { node.scrollLeft = 0; });
        await wrapper.focus();
        await expect(wrapper).toBeFocused();
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
        await expect.poll(() => wrapper.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
        await wrapper.evaluate(node => { node.scrollLeft = 0; node.blur(); });
      }
    } else {
      expect(dimensions.columns).toBe(2);
      expect(Math.abs(dimensions.tableWidth - dimensions.clientWidth)).toBeLessThanOrEqual(2);
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      shortTables++;
    }
  }
  expect(overflowing).toBeGreaterThanOrEqual(1);
  expect(shortTables).toBeGreaterThanOrEqual(1);
}
async function openSnapshotAnswer(page) {
  const { expect } = require('@playwright/test');
  const toggle = page.locator('.work-answer-toggle').last();
  await toggle.scrollIntoViewIfNeeded();
  const before = await toggle.evaluate(node => node.closest('.session-hub-detail, .work-board').scrollTop);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const answer = page.getByRole('region', { name: '답변', exact: true });
  await expect(answer.locator('.work-answer-text')).toContainText('로그인 리다이렉트 테스트를 추가했습니다.');
  await expect(answer.locator('.work-answer-meta')).toContainText('답변 시각');
  await expect(answer.locator('.work-answer-meta')).toContainText('조회 시각');
  await expect(answer.locator('img, script, a, strong')).toHaveCount(0);
  expect(await toggle.evaluate(node => node.closest('.session-hub-detail, .work-board').scrollTop)).toBe(before);
  await answer.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
}
module.exports = { mockSessionHub, expectNoHorizontalOverflow, expectAssistantLayout, expectChatColumn, openSnapshotAnswer };
