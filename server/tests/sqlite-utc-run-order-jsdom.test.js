'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

// Keep the same cross-timezone contract as sqlite-utc-stuck-sweeps.test.js.
// UTC alone cannot distinguish a bare SQLite UTC string from a local timestamp,
// and America/Los_Angeles exercises the DST spring-forward inversion below.
const TIMEZONES = ['Asia/Seoul', 'UTC', 'America/Los_Angeles'];

async function withTimezone(tz, fn) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function createEnv() {
  const env = createPreactEnv();
  env.context.apiFetch = async (url) => {
    if (url === '/api/nodes/summary') return { nodes: [], queued: [] };
    return {};
  };
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.timeAgo = () => '';
  env.context.formatTime = () => '';
  env.context.dueDateMeta = () => null;
  env.context.Dropdown = () => null;
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };
  env.loadComponent('TaskModals');
  return env;
}

const task = {
  id: 'task-dst',
  title: 'DST ordering',
  status: 'in_progress',
  priority: 'medium',
  created_at: '2026-03-08 02:00:00',
  updated_at: '2026-03-08 03:00:00',
};
const older = {
  id: 'run-older',
  task_id: task.id,
  status: 'running',
  node_id: 'remote-old',
  agent_name: 'Older run',
  created_at: '2026-03-08 02:30:00',
};
const newer = {
  id: 'run-newer',
  task_id: task.id,
  status: 'needs_input',
  node_id: 'remote-new',
  agent_name: 'Newer run',
  created_at: '2026-03-08 03:00:00',
};

for (const tz of TIMEZONES) {
  test(`[TZ=${tz}] latestRunForTask keeps SQLite UTC order across DST spring-forward`, async (t) => {
    const env = createEnv();
    t.after(env.cleanup);

    await withTimezone(tz, () => {
      // BoardView and SessionGrid both consume latestRunForTask().
      assert.equal(env.context.latestRunForTask([older, newer], task.id).id, newer.id);
    });
  });

  test(`[TZ=${tz}] TaskDetailPanel keeps SQLite UTC order across DST spring-forward`, async (t) => {
    const env = createEnv();
    t.after(env.cleanup);

    await withTimezone(tz, async () => {
      let openedRun = null;
      const root = env.document.getElementById('root');
      env.render(env.h(env.context.TaskDetailPanel, {
        task,
        onClose: () => {},
        projects: [],
        agents: [],
        runs: [older, newer],
        onOpenRun: (run) => { openedRun = run; },
        onExecute: () => {},
        reloadTasks: () => {},
      }), root);
      await flushEffects();

      const runRows = root.querySelectorAll('.task-detail-runs-list .task-detail-run-item');
      assert.equal(runRows.length, 2);
      assert.match(runRows[0].textContent, /Newer run/);

      const viewRun = root.querySelector('.modal-footer button.primary');
      assert.ok(viewRun);
      viewRun.click();
      assert.equal(openedRun?.id, newer.id);
    });
  });
}
