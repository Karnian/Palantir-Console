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
  e.context.EventSource = class { addEventListener() {} close() {} };
  e.loadComponent('OwnedSessionsView');
  e.mount = (name, props) => e.render(e.h(e.context[name], props), e.document.getElementById('root'));
  return e;
}
const state = (extra = {}) => ({ current_incarnation_id: 'inc', session: { state: 'active', cwd: '/safe' },
  incarnations: [{ id: 'inc', state: 'alive', control_available: true, ...extra }], deliveries: [], tool_requests: [], controls: [] });
test('delivery unknown is emphasized and outcome is separate', t => {
  const e = setup(t); e.mount('OwnedDeliveryBadge', { delivery: { state: 'provider_observed', outcome: 'outcome_unknown' } });
  assert.match(e.document.body.textContent, /받음·결과 불명/); assert.ok(e.document.querySelector('.owned-unknown'));
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
  e.context.EventSource = class { addEventListener(name, fn) { listeners[name] = fn; } close() {} };
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
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '인터럽트').click(); await flushEffects(30);
  [...e.document.querySelectorAll('button')].find(x => x.textContent === '같은 키로 다시 시도').click(); await flushEffects(30);
  assert.equal(posted.length, 2); assert.equal(posted[0].request_key, posted[1].request_key);
  assert.match(posted[0].request_key, /^rk_\d+_[a-f0-9]{32}$/); assert.equal(posted[0].incarnation_id, 'inc');
});
test('assistant text is sent through safe markdown renderer', t => {
  const e = setup(t); e.mount('OwnedMessage', { event: { seq: 1, json: { message: { type: 'assistant', message: { content: [{ type: 'text', text: '<img onerror="throw 1">' }] } } } } });
  assert.equal(e.document.querySelector('img'), null); assert.match(e.document.body.textContent, /<img/);
});
