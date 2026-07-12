'use strict';

// G4c §5h — TaskDetailPanel renders the goal section (attempt timeline + verdict/
// Gate 1 badges + delivery) from the /api/tasks/:id/goal aggregate, escaped.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

function createEnv(goalPayload) {
  const env = createPreactEnv();
  env.context.apiFetch = async (url) => {
    if (url.endsWith('/goal')) return { goal: goalPayload };
    return {}; // queue-reasons + others
  };
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  // Free-var stubs for TaskDetailPanel's stripped lib imports (the harness
  // resolves these from the sandbox at call time).
  env.context.dueDateMeta = () => ({ label: '', tone: '' });
  env.context.timeAgo = () => 'now';
  env.context.formatTime = () => 'now';
  env.context.Dropdown = ({ children }) => env.context.preact.h('div', null, children);
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };
  env.loadComponent('TaskModals');
  return { env, cleanup: env.cleanup };
}

const GOAL = {
  goal_enabled: true, goal_max_attempts: 3, acceptance_criteria: '- 빌드 통과',
  verify_check: { id: 'vc', name: 'unit', kind: 'command', created_by: 'human' },
  attempts: [
    { run_id: 'r1', attempt: 1, status: 'completed', verdict: 'retry', acceptance: { status: 'ran', passed: false, kind: 'command', gate: true }, goal_report: { summary: '1차 실패' } },
    { run_id: 'r2', attempt: 2, status: 'completed', verdict: 'gate2', acceptance: { status: 'ran', passed: true, kind: 'command', gate: true }, goal_report: { summary: '<img src=x onerror=alert(1)>' } },
  ],
  delivery: { mode: 'branch', state: 'delivered', run_id: 'r2', branch: 'palantir/goal/t1', stat: '1 file changed' },
  tip_run_id: 'r2',
};

function renderDetail(ctx, task) {
  const { h, render } = ctx.env.context.preact;
  const root = ctx.env.document.getElementById('root');
  render(h(ctx.env.context.TaskDetailPanel, {
    task, onClose: () => {}, projects: [], agents: [], runs: [], onOpenRun: () => {}, onExecute: () => {}, reloadTasks: () => {},
  }), root);
  return root;
}

test('goal section renders verdict + Gate1 badges, delivery branch, and escapes worker HTML', async (t) => {
  const ctx = createEnv(GOAL);
  t.after(ctx.cleanup);
  const root = renderDetail(ctx, { id: 't1', title: 'T', status: 'done', goal_enabled: 1, updated_at: '1' });
  await flushEffects();
  await flushEffects();

  const section = root.querySelector('[data-role="goal-section"]');
  assert.ok(section, 'goal section rendered');
  const text = section.textContent;
  assert.match(text, /수락 기준/);
  assert.match(text, /빌드 통과/);
  assert.match(text, /시도 1/);
  assert.match(text, /시도 2/);
  assert.match(text, /리뷰 대기/, 'gate2 verdict badge');
  assert.match(text, /Gate1 FAIL/);
  assert.match(text, /Gate1 PASS/);
  assert.match(text, /palantir\/goal\/t1/, 'delivered branch shown');

  // XSS: the worker summary is rendered as TEXT — no <img> element injected.
  assert.equal(section.querySelector('img'), null, 'worker HTML not parsed into a node');
  assert.match(text, /onerror=alert/, 'the raw string is present as escaped text');
});

test('non-goal task renders no goal section', async (t) => {
  const ctx = createEnv({ goal_enabled: false });
  t.after(ctx.cleanup);
  const root = renderDetail(ctx, { id: 't2', title: 'T', status: 'todo', goal_enabled: 0, updated_at: '1' });
  await flushEffects();
  assert.equal(root.querySelector('[data-role="goal-section"]'), null);
});
