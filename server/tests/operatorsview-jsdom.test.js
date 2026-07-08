'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (err) {
      lastErr = err;
      await flushEffects(20);
    }
  }
  throw lastErr;
}

function installRosterStubs(env, { managerStatus, profiles }) {
  const calls = [];
  env.context.apiFetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url === '/api/manager/status') return managerStatus;
    if (url === '/api/operator/profiles') return { profiles };
    throw new Error(`unexpected url ${url}`);
  };
  env.context.addToast = () => {};
  env.context.parseProjectConversationId = (id) => {
    if (typeof id !== 'string') return null;
    const prefix = 'operator:';
    return id.startsWith(prefix) && id.length > prefix.length
      ? { projectId: id.slice(prefix.length) }
      : null;
  };
  env.context.EmptyState = function EmptyState({ text, sub }) {
    return env.context.preact.h('div', { class: 'empty-state' }, `${text} ${sub || ''}`);
  };
  return calls;
}

function renderOperatorsView(env, props = {}) {
  const root = env.document.getElementById('root');
  env.render(env.h(env.context.OperatorsView, {
    runs: [],
    projects: [],
    tasks: [],
    ...props,
  }), root);
  return root;
}

test('OperatorsView renders Master, Live Operators, and Available Operators as separate sections', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  const apiCalls = installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [{
        conversationId: 'operator:proj_alpha',
        run: {
          id: 'run_mgr_alpha',
          status: 'running',
          manager_adapter: 'codex',
          conversation_id: 'operator:proj_alpha',
          node_id: 'node-a',
        },
      }],
    },
    profiles: [{
      id: 'op_review',
      name: 'Review analyst',
      persona: 'Checks diffs and verifies test evidence.',
      capabilities: ['registry_metadata_search'],
    }],
  });
  env.loadComponent('OperatorsView');

  const root = renderOperatorsView(env, {
    projects: [{ id: 'proj_alpha', name: 'Alpha Console' }],
    runs: [
      { id: 'worker-1', is_manager: 0, status: 'running', project_id: 'proj_alpha' },
      { id: 'worker-2', is_manager: 0, status: 'needs_input', project_id: 'proj_alpha' },
      { id: 'worker-3', is_manager: 0, status: 'queued', project_id: 'proj_alpha' },
      { id: 'manager-shadow', is_manager: 1, status: 'running', project_id: 'proj_alpha' },
      { id: 'worker-other', is_manager: 0, status: 'running', project_id: 'proj_beta' },
    ],
  });

  const master = await waitFor(() => {
    const el = root.querySelector('[data-role="operator-roster-master-card"]');
    assert.ok(el);
    return el;
  });
  assert.equal(master.getAttribute('href'), '#manager');
  assert.match(master.textContent, /Top/);
  assert.match(master.textContent, /claude-code/);

  const live = await waitFor(() => {
    const el = root.querySelector('[data-role="operator-roster-live-card"]');
    assert.ok(el);
    return el;
  });
  assert.equal(live.tagName, 'ARTICLE');
  assert.equal(live.getAttribute('href'), null);
  assert.equal(live.querySelector('a a'), null);
  const liveLinks = Array.from(live.querySelectorAll('a'));
  assert.equal(liveLinks.length, 2);
  assert.equal(live.querySelector('[data-role="operator-roster-live-primary-link"]').getAttribute('href'), '#manager/operator/proj_alpha');
  assert.equal(live.querySelector('[data-role="operator-roster-live-project-link"]').getAttribute('href'), '#operator/codebases/proj_alpha');
  assert.match(live.textContent, /Alpha Console/);
  assert.match(live.textContent, /코드베이스 바인딩/);
  assert.match(live.textContent, /Dispatcher/);
  assert.match(live.textContent, /Long-running/);
  assert.match(live.textContent, /codex/);
  assert.match(live.textContent, /node-a/);
  assert.equal(root.querySelector('[data-role="operator-roster-worker-count"]').textContent.trim(), '1');

  const availableSection = root.querySelector('[data-role="operator-roster-available-section"]');
  const available = availableSection.querySelector('[data-role="operator-roster-available-card"]');
  assert.ok(available);
  assert.equal(available.tagName, 'ARTICLE');
  assert.equal(available.getAttribute('href'), null);
  assert.equal(available.querySelector('a a'), null);
  const availableLinks = Array.from(available.querySelectorAll('a'));
  assert.equal(availableLinks.length, 2);
  assert.equal(
    available.querySelector('[data-role="operator-roster-available-invoke-link"]').getAttribute('href'),
    '#operator/specialist/op_review',
  );
  assert.equal(
    available.querySelector('[data-role="operator-roster-available-profile-link"]').getAttribute('href'),
    '#operator/profiles',
  );
  assert.match(available.textContent, /Review analyst/);
  assert.match(available.textContent, /Folder-less/);
  assert.match(available.textContent, /Doer/);
  assert.match(available.textContent, /On-demand \/ Stateless/);
  assert.match(available.textContent, /Ready to invoke/);
  assert.match(available.textContent, /호출/);
  assert.match(available.textContent, /프로필 보기/);
  assert.match(available.textContent, /registry_metadata_search/);
  assert.doesNotMatch(availableSection.textContent, /Running|Online|Live|Session|Idle/);
  available.querySelector('[data-role="operator-roster-available-invoke-link"]').click();
  await flushEffects(20);
  assert.equal(apiCalls.some((call) => call.url === '/api/operator/specialist'), false);
});

test('OperatorsView renders scoped empty states for no live project operators and no available profiles', async (t) => {
  const env = createPreactEnv();
  t.after(env.cleanup);

  installRosterStubs(env, {
    managerStatus: {
      active: true,
      top: {
        conversationId: 'top',
        run: { id: 'run_mgr_top', status: 'running', manager_adapter: 'claude-code' },
      },
      pms: [],
    },
    profiles: [],
  });
  env.loadComponent('OperatorsView');

  const root = renderOperatorsView(env);
  const liveSection = root.querySelector('[data-role="operator-roster-live-section"]');
  await waitFor(() => assert.match(liveSection.textContent, /코드베이스 바인딩 오퍼레이터가 없습니다/));

  const availableSection = root.querySelector('[data-role="operator-roster-available-section"]');
  await waitFor(() => assert.match(availableSection.textContent, /폴더 없는 프로필이 없습니다/));
  assert.doesNotMatch(availableSection.textContent, /Running|Online|Live|Session|Idle/);
});
