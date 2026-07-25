'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects, pickDropdownOption } = require('./helpers/jsdom-preact');

test('MemoryView renders distiller diagnostics and a deterministic candidate inbox', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const subscriptions = [];
  const reviewCalls = [];
  let candidateVisible = true;

  env.context.addToast = () => {};
  env.context.sseBroker = {
    subscribe(channel) {
      subscriptions.push(channel);
      return () => {};
    },
  };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [{ id: 'op_1', name: 'Reviewer' }] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'missing_credential', enabled: true },
        queue: { pending: candidateVisible ? 1 : 0, workspace_pending: candidateVisible ? 1 : 0, profile_pending: 0 },
        approval: { actor: 'cookie', can_review: true, requires_cookie: true },
      };
    }
    if (url === '/api/projects/p1/memory?status=active') return { memory: [] };
    if (url === '/api/projects/p1/memory/candidates?status=pending&limit=50') {
      return {
        candidates: candidateVisible ? [{
          id: 'cand_1',
          rule: 'R4',
          kind: 'heuristic',
          preview: 'Prefer focused tests before the full suite.',
          approval_mode: 'deterministic',
          can_promote: true,
          created_at: '2026-07-26 12:00:00',
        }] : [],
        next_cursor: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async (url, options) => {
    reviewCalls.push({ url, options });
    candidateVisible = false;
    return { candidate: { id: 'cand_1', status: 'promoted' } };
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, {
    projects: [{ id: 'p1', name: 'Project One' }],
  }), root);
  await flushEffects(180);

  assert.match(root.textContent, /자격 증명 없음/);
  assert.match(root.textContent, /Prefer focused tests before the full suite/);
  assert.match(root.textContent, /즉시 승인 가능/);
  assert.ok(subscriptions.includes('memory:candidate_created'));
  assert.ok(subscriptions.includes('memory:promoted'));

  const approve = Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '승인');
  assert.ok(approve, 'deterministic R4 candidate has an approval button');
  approve.click();
  await flushEffects(180);
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0].url, '/api/projects/p1/memory/candidates/cand_1/promote');
  assert.equal(reviewCalls[0].options.method, 'POST');
  assert.match(root.textContent, /대기 중인 후보가 없습니다/);
});

test('MemoryView does not reload a stale owner after an in-flight review', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const candidateGets = [];
  let finishReview;
  const reviewPending = new Promise((resolve) => { finishReview = resolve; });

  env.context.addToast = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 2, workspace_pending: 2, profile_pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (/\/api\/projects\/p[12]\/memory\?status=active/.test(url)) return { memory: [] };
    if (/\/api\/projects\/p[12]\/memory\/candidates/.test(url)) {
      candidateGets.push(url);
      const projectId = url.includes('/p2/') ? 'p2' : 'p1';
      return {
        candidates: [{
          id: `cand-${projectId}`,
          rule: 'R4',
          kind: 'heuristic',
          preview: `${projectId.toUpperCase()} candidate`,
          approval_mode: 'deterministic',
          can_promote: true,
        }],
        next_cursor: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async () => reviewPending;

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, {
    projects: [
      { id: 'p1', name: 'Project One' },
      { id: 'p2', name: 'Project Two' },
    ],
  }), root);
  await flushEffects(180);

  const approve = Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '승인');
  approve.click();
  await flushEffects(20);

  const projectTrigger = root.querySelector('button[aria-label^="프로젝트 폴더 선택"]');
  await pickDropdownOption(env, projectTrigger, 'p2');
  await flushEffects(120);
  assert.match(root.textContent, /P2 candidate/);
  const p1GetsBeforeReviewFinishes = candidateGets.filter((url) => url.includes('/p1/')).length;

  finishReview({ candidate: { id: 'cand-p1', status: 'promoted' } });
  await flushEffects(180);
  assert.match(root.textContent, /P2 candidate/);
  assert.equal(
    candidateGets.filter((url) => url.includes('/p1/')).length,
    p1GetsBeforeReviewFinishes,
    'completed p1 review must not trigger an old-owner reload after selection moved to p2',
  );
});
