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
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
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

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '프로젝트').click();
  await flushEffects(120);
  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '후보').click();
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
  assert.match(root.textContent, /대기 후보가 없습니다/);
});

test('MemoryView keeps superseded memory available as read-only audit history', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const calls = [];

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    calls.push(url);
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
    if (url === '/api/master-memory?scope=user&status=all') {
      return {
        memory: [{
          id: 'memory_superseded',
          kind: 'fact',
          content: 'The previous canonical tool value.',
          origin: 'human',
          status: 'superseded',
        }],
      };
    }
    if (url === '/api/master-memory/memory_superseded/provenance') {
      return { id: 'memory_superseded', origin: 'human', evidence: { superseded_by: 'memory_new' } };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  const historyTab = Array.from(root.querySelectorAll('[role="tab"]'))
    .find((button) => button.textContent.trim() === '전체 이력');
  assert.ok(historyTab);
  historyTab.click();
  await flushEffects(180);

  assert.ok(calls.includes('/api/master-memory?scope=user&status=all'));
  assert.match(root.textContent, /The previous canonical tool value/);
  assert.match(root.textContent, /대체됨/);
  const actions = Array.from(root.querySelectorAll('.memory-card-actions button'))
    .map((button) => button.textContent.trim());
  assert.deepEqual(actions, ['출처']);

  root.querySelector('.memory-card-actions button').click();
  await flushEffects(100);
  assert.match(root.textContent, /memory_new/);
});

test('MemoryView maps an L1 cross-project candidate to pattern during edited approval', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let candidateVisible = true;
  let approval = null;

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: candidateVisible ? 1 : 0, cross_project_pending: candidateVisible ? 1 : 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
    if (url === '/api/master-memory/candidates?scope=cross_project&status=pending&limit=50') {
      return {
        candidates: candidateVisible ? [{
          id: 'cross_1',
          rule: 'XPROJECT',
          kind: 'pitfall',
          preview: 'Rebuild native modules after changing Node versions.',
          importance: 8,
          approval_mode: 'review',
          can_promote: false,
        }] : [],
        next_cursor: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async (url, options) => {
    approval = { url, body: JSON.parse(options.body) };
    candidateVisible = false;
    return { candidate: { id: 'cross_1', status: 'promoted' } };
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '공통 후보').click();
  await flushEffects(180);
  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '수정 후 승인').click();
  await flushEffects(40);

  const kindSelect = root.querySelector('.memory-form select');
  assert.equal(kindSelect.value, 'pattern');
  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '수정 내용 승인').click();
  await flushEffects(180);

  assert.deepEqual(approval, {
    url: '/api/master-memory/candidates/cross_1/promote?scope=cross_project',
    body: {
      kind: 'pattern',
      content: 'Rebuild native modules after changing Node versions.',
      importance: 8,
    },
  });
});

test('MemoryView refreshes a candidate inbox after a terminal promotion error', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let candidateVisible = true;
  let candidateLoads = 0;

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: candidateVisible ? 1 : 0, user_pending: candidateVisible ? 1 : 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
    if (url === '/api/master-memory/candidates?scope=user&status=pending&limit=50') {
      candidateLoads += 1;
      return {
        candidates: candidateVisible ? [{
          id: 'terminal_reject',
          rule: 'R4',
          kind: 'preference',
          preview: 'Candidate that collides with an active fact.',
          approval_mode: 'deterministic',
          can_promote: true,
        }] : [],
        next_cursor: null,
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async () => {
    candidateVisible = false;
    throw new Error('fact_not_allowed');
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '후보').click();
  await flushEffects(180);
  assert.match(root.textContent, /Candidate that collides/);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '승인').click();
  await flushEffects(180);

  assert.ok(candidateLoads >= 2, 'failed promotion must reload pending candidates');
  assert.match(root.textContent, /대기 후보가 없습니다/);
});

test('MemoryView does not reload a stale owner after an in-flight review', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  const candidateGets = [];
  let finishReview;
  const reviewPending = new Promise((resolve) => { finishReview = resolve; });

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
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
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
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

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '프로젝트').click();
  await flushEffects(120);
  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '후보').click();
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

  await pickDropdownOption(env, projectTrigger, 'p1');
  await flushEffects(120);
  const p1Approve = Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '승인');
  assert.ok(p1Approve);
  assert.equal(p1Approve.disabled, false, 'completed stale-owner review must release its candidate busy state');
});

test('MemoryView refreshes the selected status after an in-flight archive completes', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let archived = false;
  let finishArchive;
  const archivePending = new Promise((resolve) => { finishArchive = resolve; });

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') {
      return {
        memory: archived ? [] : [{
          id: 'memory_one',
          kind: 'preference',
          content: 'Keep archive transitions visible.',
          origin: 'human',
          status: 'active',
        }],
      };
    }
    if (url === '/api/master-memory?scope=user&status=archived') {
      return {
        memory: archived ? [{
          id: 'memory_one',
          kind: 'preference',
          content: 'Keep archive transitions visible.',
          origin: 'human',
          status: 'archived',
        }] : [],
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async (url) => {
    assert.equal(url, '/api/master-memory/memory_one');
    await archivePending;
    archived = true;
    return { memory: { id: 'memory_one', status: 'archived' } };
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  const archiveAction = Array.from(root.querySelectorAll('.memory-card-actions button'))
    .find((button) => button.textContent.trim() === '보관');
  assert.ok(archiveAction);
  archiveAction.click();
  await flushEffects(20);

  const archivedTab = Array.from(root.querySelectorAll('[role="tab"]'))
    .find((button) => button.textContent.trim() === '보관');
  archivedTab.click();
  await flushEffects(100);
  assert.match(root.textContent, /보관된 메모리가 없습니다/);

  finishArchive();
  await flushEffects(220);
  assert.match(root.textContent, /Keep archive transitions visible/);
  assert.doesNotMatch(root.textContent, /보관된 메모리가 없습니다/);
});

test('MemoryView clears loading when a scope becomes unready during a request', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let finishProjectLoad;
  let projectRequested = false;
  const projectLoad = new Promise((resolve) => { finishProjectLoad = resolve; });

  env.context.addToast = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 0, workspace_pending: 0, profile_pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
    if (url === '/api/projects/p1/memory?status=active') {
      projectRequested = true;
      return projectLoad;
    }
    throw new Error(`unexpected URL: ${url}`);
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

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '프로젝트').click();
  for (let i = 0; i < 10 && !projectRequested; i += 1) {
    await flushEffects(20);
  }
  assert.equal(projectRequested, true);
  await flushEffects(20);
  assert.match(root.textContent, /불러오는 중/);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === 'Operator').click();
  await flushEffects(80);
  assert.doesNotMatch(root.textContent, /불러오는 중/);

  finishProjectLoad({ memory: [] });
});

test('MemoryView refreshes the active list after a direct human memory write', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);
  let saved = false;
  let activeLoads = 0;

  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 0, workspace_pending: 0, profile_pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') {
      activeLoads += 1;
      return {
        memory: saved ? [{
          id: 'master_1',
          kind: 'preference',
          origin: 'human',
          content: 'Keep the active list fresh.',
          importance: 7,
          status: 'active',
        }] : [],
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  env.context.apiFetchWithToast = async (url, options) => {
    assert.equal(url, '/api/master-memory/remember');
    assert.equal(options.method, 'POST');
    saved = true;
    return { memory: { id: 'master_1' } };
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '기억 추가').click();
  await flushEffects(40);
  const textarea = root.querySelector('textarea');
  textarea.value = 'Keep the active list fresh.';
  textarea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
  await flushEffects(20);
  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '저장').click();
  await flushEffects(180);

  assert.ok(activeLoads >= 2, 'active memory must reload even when the active tab does not change');
  assert.match(root.textContent, /Keep the active list fresh/);
});

test('MemoryView hides unsupported review action for archived master memory', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  env.context.addToast = () => {};
  env.context.sseBroker = { subscribe: () => () => {} };
  env.context.apiFetch = async (url) => {
    if (url === '/api/operator/profiles') return { profiles: [] };
    if (url === '/api/memory/status') {
      return {
        distiller: { state: 'disabled' },
        queue: { pending: 0, workspace_pending: 0, profile_pending: 0 },
        approval: { actor: 'cookie', can_review: true },
      };
    }
    if (url === '/api/master-memory?scope=user&status=active') return { memory: [] };
    if (url === '/api/master-memory?scope=user&status=archived') {
      return {
        memory: [{
          id: 'master_archived',
          kind: 'preference',
          origin: 'human',
          content: 'Archived master memory',
          importance: 5,
          status: 'archived',
        }],
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  env.loadComponent('Dropdown');
  env.loadComponent('EmptyState');
  env.loadComponent('Modal');
  env.loadComponent('MemoryView');
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.MemoryView, { projects: [] }), root);
  await flushEffects(180);

  Array.from(root.querySelectorAll('button'))
    .find((button) => button.textContent.trim() === '보관').click();
  await flushEffects(180);

  const actionLabels = Array.from(root.querySelectorAll('.memory-card-actions button'))
    .map((button) => button.textContent.trim());
  assert.ok(actionLabels.includes('복원'));
  assert.equal(actionLabels.includes('검토'), false);
});
