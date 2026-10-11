'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSnapshots } = require('../../helpers/work-board-fixture.cjs');
const REV = '0123456789abcdef';
const HASH = 'a'.repeat(64);

async function mockSessionHub(page, { observe = true, clock = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-hub-e2e-'));
  let alpha, beta;
  try { ({ alpha, beta } = createSnapshots(root)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  const key = alpha.sessions[0].key;
  let state = { state: 'running', generation: 1, turnInProgress: false, messages: [
    { role: 'user', text: '지금 각 세션 뭐 하고 있어?' },
    { role: 'assistant', text: `Mac에서 인증 흐름을 검토했습니다. [[session:${key}@${REV}]]` },
  ] };
  if (clock) await page.clock.install({ time: new Date('2026-10-10T03:10:00.000Z') });
  await page.route('**/api/health', route => route.fulfill({ json: { sessionHubActive: true } }));
  if (observe) await page.route('**/api/observe/snapshots**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/snapshots')) return route.fulfill({ json: { rev: REV, snapshots: [
      { machine_id: 'alpha', machine_label: 'Mac', generated_at: alpha.generated_at, sha256: HASH },
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
    return route.fulfill({ json: state });
  });
}
module.exports = { mockSessionHub };
