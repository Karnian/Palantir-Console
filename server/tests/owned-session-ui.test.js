'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { TextEncoder } = require('node:util');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');
function setup(t) {
  const e = createPreactEnv(); t.after(e.cleanup);
  e.context.TextEncoder = TextEncoder;
  vm.runInContext('var C = OWNED_COPY;', e.context);
  e.context.Modal = ({ children, open }) => open ? children : null;
  e.context.DirectoryPicker = ({ onSelect }) => e.h('button', { onClick: () => onSelect('/safe') }, 'pick');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app/lib/markdown.js'), 'utf8').replace(/^export /gm, ''), e.context);
  e.context.EventSource = class {
    addEventListener(name, callback) { if (name === 'open') setTimeout(callback, 0); }
    close() {}
  };
  for (const moduleName of [
    'format', 'state', 'client', 'pending', 'OwnedDeliveryBadge', 'OwnedPrompt', 'OwnedMessage',
    'OwnedQuestion', 'OwnedApproval', 'OwnedComposer', 'OwnedStart', 'OwnedSessionList',
    'OwnedSessionHeader', 'OwnedConversation', 'useOwnedSessions', 'OwnedSession'
  ]) {
    e.loadComponent(`owned/${moduleName}`);
  }
  e.loadComponent('OwnedSessionsView');
  e.mount = (name, props) => e.render(e.h(e.context[name], props), e.document.getElementById('root'));
  return e;
}
const state = (extra = {}) => ({ current_incarnation_id: 'inc', session: { state: 'active', cwd: '/safe' },
  incarnations: [{ id: 'inc', state: 'alive', control_available: true, ...extra }], deliveries: [], tool_requests: [], controls: [] });

test('handoff confirmation, completion-only command and clipboard failure fallback', async t => {
  const e = setup(t); let calls = 0;
  const s = state();
  const props = { state: s, incarnation: s.incarnations[0], host: 'running', handoffDisabled: false, onHandoff: () => calls++ };
  e.mount('OwnedSessionHeader', props);
  assert.equal(e.document.querySelector('.owned-handoff-command'), null);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '터미널로 넘기기').click();
  await flushEffects(20);
  assert.match(e.document.body.textContent, /인증 게이트도 없다/);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '확인하고 넘기기').click();
  assert.equal(calls, 1);
  s.session.state = 'handed_off'; s.handoff_command = "cd '/safe' && env --resume";
  e.mount('OwnedSessionHeader', props); await flushEffects(20);
  assert.match(e.document.body.textContent, /읽기 전용/);
  const command = e.document.querySelector('.owned-handoff-command');
  assert.equal(command.value, s.handoff_command);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '명령 복사').click();
  await flushEffects(20);
  assert.match(e.document.body.textContent, /직접 복사/);
  assert.equal(command.selectionEnd, command.value.length);
});

test('handed off session disables mutations and keeps deletion available', t => {
  const e = setup(t), s = state({ state: 'exited', control_available: false });
  s.session.state = 'handed_off';
  e.mount('OwnedSession', { sessionId: 's', controller: { snapshot: s, incarnation: s.incarnations[0],
    host: 'running', disabled: false, controllable: false, events: [], submit() {} }, onRemove() {} });
  for (const button of e.document.querySelectorAll('.owned-actions button')) {
    assert.equal(button.disabled, button.textContent !== e.context.C.remove);
  }
  assert.equal(e.document.querySelector('textarea').disabled, true);
});
test('delivery unknown is emphasized and outcome is separate', t => {
  const e = setup(t); e.mount('OwnedDeliveryBadge', { delivery: { state: 'provider_observed', outcome: 'outcome_unknown' } });
  assert.equal(e.document.querySelector('.owned-delivery-badge').textContent, '받음 · 결과 불명'); assert.ok(e.document.querySelector('.owned-unknown'));
  e.mount('OwnedDeliveryBadge', { delivery: { state: 'unknown' } }); assert.match(e.document.body.textContent, /원본이 실행됐을/);
});
test('one prompt per turn: idle sends, running queues or interrupts, uncertain locks', t => {
  const e = setup(t);
  assert.equal(e.context.ownedInteraction(state()), 'idle');
  const running = state(); running.deliveries.push({ incarnation_id: 'inc', kind: 'prompt', state: 'written' });
  assert.equal(e.context.ownedInteraction(running), 'running');
  e.mount('OwnedComposer', { interaction: 'idle' }); assert.match(e.document.body.textContent, /보내기/);
  e.mount('OwnedComposer', { interaction: 'running' }); assert.match(e.document.body.textContent, /중단하고 보내기/); assert.match(e.document.body.textContent, /대기열/);
  e.mount('OwnedComposer', { interaction: 'unknown', uncertain: true }); assert.equal(e.document.querySelector('textarea').disabled, true);
});
test('approval loads full truncated input before enabling decisions and escapes tool text', async t => {
  const e = setup(t), calls = [];
  e.context.apiFetch = async url => { calls.push(url); return { host: 'running', found: true, data: '<img onerror="throw 1">full', done: true }; };
  e.mount('OwnedApproval', { card: { id: 'card', input: 'preview', input_truncated: true, state: 'pending', tool_name: 'Bash' }, sessionId: 's' });
  assert.ok([...e.document.querySelectorAll('button')].every(x => x.disabled));
  await flushEffects(); await flushEffects();
  assert.match(calls[0], /chunks\?source=tool_input&ref=card/);
  assert.match(e.document.querySelector('pre').textContent, /full/); assert.equal(e.document.querySelector('img'), null);
  assert.ok([...e.document.querySelectorAll('button')].every(x => !x.disabled));
});
test('question answer uses question text dictionary including multiselect', async t => {
  const e = setup(t); let answer;
  e.mount('OwnedQuestion', { input: { questions: [{ question: '어느 것?', multiSelect: true, options: [{ label: '가' }, { label: '나' }] }] }, onAnswer: x => { answer = x; } });
  e.document.querySelectorAll('input')[0].click(); await flushEffects(20);
  e.document.querySelectorAll('input')[1].click(); await flushEffects(20);
  e.document.querySelector('button').click(); assert.equal(answer['어느 것?'], '가, 나');
});
test('start requires explicit confirmation and shows PermissionRequest warning', async t => {
  const e = setup(t); let starts = 0;
  e.context.apiFetch = async () => ({ ok: true, hooks: [{ event: 'PermissionRequest', paths: ['/safe/.claude/settings.json'] }], warnings: ['permission_request_hook'] });
  e.mount('OwnedStart', { open: true, onStart: () => starts++ });
  e.document.querySelector('button').click(); await flushEffects(20);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '설정 미리보기').click(); await flushEffects(80);
  const start = [...e.document.querySelectorAll('button')].find(x => x.textContent === '세션 시작');
  assert.equal(start.disabled, true); start.click(); assert.equal(starts, 0);
  assert.match(e.document.body.textContent, /승인 카드보다 먼저/);
  e.document.querySelector('input[type=checkbox]').click(); await flushEffects(20); start.click(); assert.equal(starts, 1);
});
test('unreachable retains last rendered conversation and disables every action', async t => {
  const e = setup(t), listeners = {};
  e.context.EventSource = class { addEventListener(name, fn) { listeners[name] = fn; if (name === 'open') setTimeout(fn, 0); } close() {} };
  e.context.apiFetch = async url => url.includes('transcript') ? { host: 'running', events: [] } : { host: 'running', state: state(), seq_high: 0 };
  e.mount('OwnedSessionsView', { sessionId: 's' }); await flushEffects(); await flushEffects();
  listeners.host_unreachable(); await flushEffects(30);
  assert.match(e.document.body.textContent, /호스트 응답 없음.*기준, 현재 상태 불명/);
  assert.match(e.document.body.textContent, /\/safe/);
  assert.ok([...e.document.querySelectorAll('button')].every(x => x.disabled));
});
test('acceptance_unknown retries same key after lookup', async t => {
  const e = setup(t), posted = [];
  e.context.apiFetch = async (url, opts) => {
    if (opts?.method === 'POST') { posted.push(JSON.parse(opts.body)); return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: state(), seq_high: 0 };
  };
  e.mount('OwnedSessionsView', { sessionId: 's' }); await flushEffects(); await flushEffects();
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '세션 끝내기').click(); await flushEffects(30);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '같은 키로 다시 시도').click(); await flushEffects(30);
  assert.equal(posted.length, 2); assert.equal(posted[0].request_key, posted[1].request_key);
  assert.match(posted[0].request_key, /^rk_\d+_[a-f0-9]{32}$/); assert.equal(posted[0].incarnation_id, 'inc');
});
test('assistant text is sent through safe markdown renderer', t => {
  const e = setup(t); e.mount('OwnedMessage', { event: { seq: 1, json: { message: { type: 'assistant', message: { content: [{ type: 'text', text: '<img onerror="throw 1">' }] } } } } });
  assert.equal(e.document.querySelector('img'), null); assert.match(e.document.body.textContent, /<img/);
});

test('pure selectors require server control evidence and confirmed stop before resume', t => {
  const e = setup(t);
  const { canControlOwnedSession, canResumeOwnedSession, ownedInteraction } = e.context;
  const current = state();
  assert.equal(canControlOwnedSession('running', current), true);
  assert.equal(canControlOwnedSession('unreachable', current), false);
  current.incarnations[0].control_available = false;
  assert.equal(canControlOwnedSession('running', current), false);
  current.incarnations[0].control_available = true;
  current.controls.push({ state: 'accepted' });
  assert.equal(canControlOwnedSession('running', current), false);
  current.controls = [];
  assert.equal(canResumeOwnedSession(current), false);
  current.incarnations[0].state = 'exited';
  assert.equal(canResumeOwnedSession(current), false);
  current.controls.push({ incarnation_id: 'inc', kind: 'stop', state: 'blocked' });
  assert.equal(canResumeOwnedSession(current), false);
  current.controls[0].state = 'done';
  assert.equal(canResumeOwnedSession(current), true);
  current.session.state = 'closed';
  assert.equal(canResumeOwnedSession(current), false);
  assert.equal(ownedInteraction(state({ attribution_uncertain: 1 })), 'unknown');
  assert.equal(ownedInteraction(state({ interrupt_unknown: 1 })), 'unknown');
  const permission = state();
  permission.tool_requests.push({ incarnation_id: 'inc', state: 'pending', tool_name: 'Bash' });
  assert.equal(ownedInteraction(permission), 'awaiting_permission');
  permission.tool_requests[0].tool_name = 'AskUserQuestion';
  assert.equal(ownedInteraction(permission), 'awaiting_user');
});

test('capability evaluator is pure and sdkAdapter re-exports the same function', () => {
  const fs = require('node:fs');
  const corePath = path.join(__dirname, '../sessionHost/core.js');
  const capability = require('../sessionHost/capability');
  const adapter = require('../sessionHost/sdkAdapter');
  assert.equal(adapter.capabilityVerdict, capability.capabilityVerdict);
  assert.doesNotMatch(fs.readFileSync(corePath, 'utf8'), /require\(['"]\.\/sdkAdapter['"]\)/);
});


test('R3 header separates unknown current facts from timestamped last-known facts', t => {
  const environment = setup(t);
  const snapshot = state();
  snapshot.tool_requests.push({ incarnation_id: 'inc', state: 'pending', tool_name: 'AskUserQuestion' });
  const selectHeader = environment.context.getOwnedHeaderState;
  const connected = selectHeader('running', snapshot);
  assert.equal(connected.current.execution, 'executionAlive');
  assert.equal(connected.current.control, 'controlPossible');
  assert.equal(connected.current.interaction, 'awaiting_user');
  assert.equal(connected.lastKnown, null);
  const lost = selectHeader('unreachable', snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(lost.current)), {
    execution: 'unknown', control: 'unknown', interaction: 'unknown', session: 'unknown'
  });
  assert.equal(lost.lastKnown.execution, 'executionAlive');
  assert.equal(lost.lastKnown.control, 'controlPossible');
  assert.equal(lost.lastKnown.interaction, 'awaiting_user');
  const asOf = 1800000000000;
  environment.mount('OwnedSessionHeader', {
    state: snapshot, incarnation: snapshot.incarnations[0], host: 'unreachable', asOf
  });
  const fields = [...environment.document.querySelectorAll('.owned-header-field')];
  const timestamp = environment.context.formatOwnedTime(asOf);
  for (const field of fields) {
    const text = field.textContent.replace(/\s+/g, ' ');
    assert.match(text, /: 불명/);
    assert.ok(text.includes(timestamp + ' 기준 마지막:'));
  }
  assert.match(fields[0].textContent, /기준 마지막: 생존/);
  assert.match(fields[1].textContent, /기준 마지막: 가능/);
  assert.match(fields[2].textContent, /기준 마지막: 질문 대기/);
  environment.mount('OwnedSessionHeader', {
    state: snapshot, incarnation: snapshot.incarnations[0], host: 'running', asOf
  });
  const text = environment.document.body.textContent.replace(/\s+/g, ' ');
  assert.match(text, /호스트: 연결됨/);
  assert.match(text, /실행: 생존/);
  assert.match(text, /제어: 가능/);
  assert.match(text, /상호작용: 질문 대기/);
  assert.match(text, /세션: 열림/);
  assert.equal(environment.document.querySelector('.owned-last-known'), null);
});

test('R3 prompt body precedes a separate nonduplicated delivery badge row', t => {
  const environment = setup(t);
  environment.mount('OwnedPrompt', {
    row: { id: 'prompt', body: JSON.stringify('첫 줄\n둘째 줄'), state: 'provider_observed', outcome: 'outcome_unknown' },
    sessionId: 'session'
  });
  const body = environment.document.querySelector('.owned-prompt-body');
  const status = environment.document.querySelector('.owned-prompt-status');
  assert.equal(body.textContent, '첫 줄\n둘째 줄');
  assert.equal(body.nextElementSibling, status);
  assert.equal(status.textContent, '받음 · 결과 불명');
  assert.equal((status.textContent.match(/받음/g) || []).length, 1);
  assert.ok(status.querySelector('.owned-unknown'));
});

test('R3 long approval keeps decisions first and expands the complete chunked input', async t => {
  const environment = setup(t);
  const fullInput = Array.from({ length: 30 }, (_, index) => '입력 ' + index).join('\n') + '\n전문 마지막 표지';
  environment.context.apiFetch = async () => ({ host: 'running', found: true, data: fullInput, done: true });
  environment.mount('OwnedApproval', {
    card: { id: 'long', state: 'pending', tool_name: 'Bash', input: 'preview', input_truncated: true },
    sessionId: 'session'
  });
  await flushEffects();
  await flushEffects();
  const actions = environment.document.querySelector('.owned-approval-actions');
  const details = environment.document.querySelector('.owned-tool-input');
  const preview = environment.document.querySelector('.owned-tool-preview');
  assert.ok(actions.compareDocumentPosition(preview) & environment.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(actions.compareDocumentPosition(details) & environment.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(actions.querySelector('input'));
  assert.ok(actions.querySelector('.btn-primary'));
  assert.ok(actions.querySelector('.btn-danger'));
  assert.equal(details.open, false);
  assert.equal(details.querySelector('summary').textContent, '전문 펼치기');
  assert.equal(preview.textContent.split('\n').length, 12);
  assert.ok(!preview.textContent.includes('전문 마지막 표지'));
  details.querySelector('summary').click();
  assert.equal(details.open, true);
  assert.equal(details.querySelector('.owned-tool-full').textContent, fullInput);
  assert.match(details.querySelector('.owned-tool-full').textContent, /전문 마지막 표지$/);
});

test('R3 short approval input remains expanded', t => {
  const environment = setup(t);
  environment.mount('OwnedApproval', {
    card: { id: 'short', state: 'pending', tool_name: 'Bash', input: 'short input' }, sessionId: 'session'
  });
  assert.equal(environment.document.querySelector('.owned-tool-input').open, true);
  assert.equal(environment.document.querySelector('.owned-tool-preview'), null);
});

test('R6 interrupt leaves the draft intact and enables only the later human send', async t => {
  const environment = setup(t);
  let settled = false;
  const posts = [];
  environment.context.apiFetch = async (url, options) => {
    if (options?.method) {
      posts.push(url);
      settled = true;
      return { acceptance: 'accepted', result: { id: 'interrupt', state: 'completed' } };
    }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const current = state();
    if (!settled) current.deliveries.push({ kind: 'prompt', incarnation_id: 'inc', state: 'written', outcome: null });
    else current.deliveries.push({ id: 'interrupt', kind: 'interrupt', incarnation_id: 'inc', state: 'completed' });
    return { host: 'running', seq_high: 1, state: current };
  };
  environment.mount('OwnedSessionsView', { sessionId: 's' });
  await flushEffects();
  await flushEffects();
  const textarea = environment.document.querySelector('textarea');
  textarea.value = '첫 줄\n남길 초안';
  textarea.dispatchEvent(new environment.window.Event('input', { bubbles: true }));
  await flushEffects(20);
  const interrupt = [...environment.document.querySelectorAll('button')].find(button => button.textContent === '중단하고 보내기');
  interrupt.click();
  await flushEffects(100);
  assert.equal(environment.document.querySelector('textarea').value, '첫 줄\n남길 초안');
  assert.equal(posts.filter(url => url.endsWith('/prompt')).length, 0);
  assert.match(environment.document.body.textContent, /중단 요청함 — 턴이 끝나면 보내기를 누르세요/);
  const send = [...environment.document.querySelectorAll('button')].find(button => button.textContent.trim() === '보내기');
  assert.equal(send.disabled, false);
  send.click();
  await flushEffects(30);
  assert.equal(posts.filter(url => url.endsWith('/prompt')).length, 1);
});

test('R6 stop enables the resume button but never invokes it for the user', async t => {
  const environment = setup(t);
  let stopped = false, stopKey;
  const posts = [];
  environment.context.apiFetch = async (url, options) => {
    if (options?.method) {
      posts.push(url);
      if (url.endsWith('/stop')) {
        stopped = true;
        stopKey = JSON.parse(options.body).request_key;
      }
      return { acceptance: 'accepted', result: { state: 'done' } };
    }
    if (url.includes('transcript')) return { host: 'running', events: [] };
    const current = state();
    if (stopped) {
      current.incarnations[0].state = 'exited';
      current.controls.push({ kind: 'stop', state: 'done', request_key: stopKey, incarnation_id: 'inc' });
    }
    return { host: 'running', seq_high: 1, state: current };
  };
  environment.mount('OwnedSessionsView', { sessionId: 's' });
  await flushEffects();
  await flushEffects();
  [...environment.document.querySelectorAll('button')].find(button => button.textContent === '실행 끝내고 이어서 시작').click();
  await flushEffects(100);
  assert.equal(posts.filter(url => url.endsWith('/resume')).length, 0);
  assert.match(environment.document.body.textContent, /실행을 끝내는 중 — 끝나면 이어서 시작을 누르세요/);
  const resume = [...environment.document.querySelectorAll('button')].find(button => button.textContent === '이어서 시작');
  assert.equal(resume.disabled, false);
  resume.click();
  await flushEffects(30);
  assert.equal(posts.filter(url => url.endsWith('/resume')).length, 1);
});

test('R7 idle disables the visible interrupt button and running enables it', t => {
  const environment = setup(t);
  const current = state();
  const controller = { snapshot: current, incarnation: current.incarnations[0], host: 'running',
    disabled: false, controllable: true, interaction: 'idle', events: [], submit() {} };
  environment.mount('OwnedSession', { sessionId: 's', controller });
  const interruptButton = () => [...environment.document.querySelectorAll('button')]
    .find(button => button.textContent === '인터럽트');
  assert.equal(interruptButton().disabled, true);
  current.deliveries.push({ kind: 'prompt', incarnation_id: 'inc', state: 'written' });
  controller.interaction = 'running';
  environment.mount('OwnedSession', { sessionId: 's', controller });
  assert.equal(interruptButton().disabled, false);
});

test('R9 discard button appears after read-only miss and remains disabled during connection loss', async t => {
  const environment = setup(t);
  const listeners = {};
  let posts = 0;
  environment.context.EventSource = class {
    addEventListener(name, callback) {
      listeners[name] = callback;
      if (name === 'open') setTimeout(callback, 0);
    }
    close() {}
  };
  environment.context.apiFetch = async (url, options) => {
    if (options?.method) { posts++; return { acceptance: 'acceptance_unknown' }; }
    if (url.includes('/requests/')) return { host: 'running', result: { found: false } };
    if (url.includes('transcript')) return { host: 'running', events: [] };
    return { host: 'running', state: state() };
  };
  environment.mount('OwnedSessionsView', { sessionId: 's' });
  await flushEffects();
  await flushEffects();
  const button = label => [...environment.document.querySelectorAll('button')].find(row => row.textContent === label);
  button('세션 끝내기').click();
  await flushEffects(30);
  assert.equal(button('요청 버리기'), undefined);
  button('접수 확인').click();
  await flushEffects(30);
  assert.equal(posts, 1);
  assert.equal(button('요청 버리기').disabled, false);
  assert.equal(button('세션 끝내기').disabled, true);
  listeners.error();
  await flushEffects(30);
  assert.equal(button('요청 버리기').disabled, true);
  assert.equal(button('같은 키로 다시 시도').disabled, true);
  assert.equal(button('접수 확인').disabled, true);
});

for (const execution of ['alive', 'orphaned', 'exited', 'never_started']) {
  test(`R1 handoff button supports ${execution} active conversation and rejects missing conversation`, t => {
    const e = setup(t), s = state({ state: execution, control_available: execution === 'alive' });
    s.session.claude_session_id = '12345678-1234-4234-8234-123456789abc';
    const props = { sessionId: 's', controller: { snapshot: s, incarnation: s.incarnations[0],
      host: 'running', disabled: false, controllable: execution === 'alive', events: [], submit() {} } };
    e.mount('OwnedSession', props);
    const button = () => [...e.document.querySelectorAll('button')].find(item => item.textContent === '터미널로 넘기기');
    assert.equal(button().disabled, false);
    s.session.claude_session_id = null; e.mount('OwnedSession', props);
    assert.equal(button().disabled, true);
  });
}
