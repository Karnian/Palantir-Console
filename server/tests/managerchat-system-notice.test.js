'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv } = require('./helpers/jsdom-preact');

function loadDisplayHelper(t) {
  const env = createPreactEnv();
  t.after(env.cleanup);
  env.loadComponent('ManagerChat');
  assert.equal(typeof env.context.managerUserInputDisplayText, 'function');
  return env.context.managerUserInputDisplayText;
}

test('ManagerChat prefers display_text over model-facing injected text', (t) => {
  const displayText = loadDisplayHelper(t);
  assert.equal(displayText({
    text: '[system notice]\ninternal context\n\n---\n\n사용자 질문',
    display_text: '사용자 질문',
  }), '사용자 질문');
});

test('ManagerChat hides parent notice from legacy user_input events', (t) => {
  const displayText = loadDisplayHelper(t);
  const legacyText = [
    '## Learned Memory',
    '- internal memory',
    '',
    '---',
    '',
    '[system notice]',
    '사용자가 operator:alpha (run=run_pm)에 직접 메시지를 보냈습니다:',
    '  "방향을 바꿔 주세요"',
    '상태가 stale 되었을 수 있으니 해당 워커의 최신 상태를 다시 조회한 뒤 현재 계획을 갱신하세요.',
    '',
    '---',
    '',
    '현재 계획 알려줘',
  ].join('\n');

  assert.equal(displayText({ text: legacyText }), '현재 계획 알려줘');
});

test('ManagerChat leaves ordinary user text containing a separator untouched', (t) => {
  const displayText = loadDisplayHelper(t);
  const ordinary = '첫 문단\n\n---\n\n두 번째 문단';
  assert.equal(displayText({ text: ordinary }), ordinary);
});
