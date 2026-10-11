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
  const key = alpha.sessions[0].key;
  let state = { epoch: 'visual-boot', version: 1, state: 'running', generation: 1, turnInProgress: false, messages: [
    { role: 'user', text: '지금 각 세션 뭐 하고 있어?' },
    { role: 'tool', name: 'mcp__session_hub__search_instructions', text: '{"q":"인증","cursor":"next"}' },
    { role: 'tool', name: 'mcp__session_hub__get_session', text: JSON.stringify({ key }) },
    { role: 'assistant', text: '## 검토 결과\n\n- Mac에서 인증 흐름을 검토했습니다. '
      + `[[session:${key}@${REV}]]`
      + (longText ? `\n\n${'긴답변'.repeat(20)}\n\n\`\`\`\n${'long-code-'.repeat(100)}\n\`\`\`` : '') },
  ] };
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
  await page.route('**/api/session-hub/chat/*', route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (name === 'stream') return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: `event: snapshot\ndata: ${JSON.stringify(state)}\n\n` });
    if (name === 'clear') state = { ...state, messages: [], result: 'incomplete', remaining: 2 };
    if (name === 'stop') state = { ...state, state: 'idle' };
    if (name === 'start') state = { ...state, state: 'running' };
    if (name === 'message') state = { ...state, messages: [...state.messages,
      { role: 'user', text: route.request().postDataJSON().text },
      { role: 'assistant', text: `인증 세션입니다. [[session:${key}@${REV}]]` }] };
    if (route.request().method() === 'POST') state = { ...state, version: state.version + 1 };
    return route.fulfill({ json: state });
  });
}

async function expectNoHorizontalOverflow(page) {
  const { expect } = require('@playwright/test');
  await expect.poll(() => page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth <= root.clientWidth;
  })).toBe(true);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  // The app shell clips overflow; also guard against a panel extending beyond the viewport.
  for (const selector of ['.session-hub-chat', '.all-sessions-panel', '.work-search', '.session-row']) {
    for (const element of await page.locator(selector).all()) {
      if (!await element.isVisible()) continue;
      const box = await element.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(clientWidth + 1);
    }
  }
}
module.exports = { mockSessionHub, expectNoHorizontalOverflow };
