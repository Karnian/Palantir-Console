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
  let proposals = [{ id: 'proposal-1', operation: 'add', kind: 'preference', content: '한국어로 간단히 답변',
    reason: '사용자 요청', revision: 1, content_hash: HASH, source_content: '한국어로 간단히 답해 줘',
    source_thread_id: 'thread-1', source_message_id: 'user-1', status: 'pending' }];
  let state = { thread_id: 'thread-1', epoch: 'visual-boot', version: 1, state: 'running', generation: 1,
    memory: { pending_count: 1, revision: 0 }, turnInProgress: false, messages: [
      { id: 'user-1', seq: 1, turn_id: 'turn-1', role: 'user', content: '지금 각 세션 뭐 하고 있어?' },
      { id: 'answer-1', seq: 2, turn_id: 'turn-1', role: 'assistant', status: 'complete',
        content: '## 검토 결과\n\n- Mac에서 인증 흐름을 검토했습니다. ' + `[[session:${key}@${REV}]]`
          + (longText ? `\n\n${'긴답변'.repeat(20)}\n\n\`\`\`\n${'long-code-'.repeat(100)}\n\`\`\`` : '') },
      { id: 'tool-1', seq: 3, turn_id: 'turn-1', role: 'tool_note', content: '검색: 인증' },
      { id: 'tool-2', seq: 4, turn_id: 'turn-1', role: 'tool_note', content: '세션 열기: 인증 검토',
        memory_proposal_id: 'proposal-1' },
    ] };
  let threads = [{ id: 'thread-1', title: '현재 대화' }, { id: 'thread-old', title: '이전 검토' }];
  if (clock) await page.clock.install({ time: new Date('2026-10-10T03:10:00.000Z') });
  await page.route('**/api/health', route => route.fulfill({ json: { sessionHubActive: true } }));
  if (observe) await page.route('**/api/observe/snapshots**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/snapshots')) return route.fulfill({ json: { rev: REV, snapshots: [
      { machine_id: 'alpha', machine_label: alpha.machine.label, generated_at: alpha.generated_at, sha256: HASH },
      { machine_id: 'beta', machine_label: 'codev2', generated_at: beta.generated_at, sha256: HASH },
      { name_id: 'unreadable', error_code: 'parse_error' },
    ] } });
    return route.fulfill({ json: url.pathname.endsWith('/alpha') ? alpha : beta });
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
  for (const selector of ['.session-hub-chat', '.all-sessions-panel', '.work-search', '.session-row']) {
    for (const element of await page.locator(selector).all()) {
      if (!await element.isVisible()) continue;
      const box = await element.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(clientWidth + 1);
    }
  }
}
async function expectAssistantLayout(page) {
  const { expect } = require('@playwright/test');
  await expectNoHorizontalOverflow(page);
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
module.exports = { mockSessionHub, expectNoHorizontalOverflow, expectAssistantLayout };
