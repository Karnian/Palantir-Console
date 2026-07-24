'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects, pickDropdownOption } = require('./helpers/jsdom-preact');

function createEnv() {
  const env = createPreactEnv();
  const posts = [];

  env.context.apiFetch = async (url, opts = {}) => {
    posts.push({ url, body: JSON.parse(opts.body || '{}') });
    return { task: { id: 'task_created', title: 'New task' } };
  };
  env.context.addToast = () => {};
  env.context.useEscape = () => {};
  env.context.Modal = function Modal({ open, children }) {
    return open ? env.context.preact.h('div', { class: 'modal-stub' }, children) : null;
  };

  env.loadComponent('Dropdown');
  env.loadComponent('TaskModals');

  return { env, posts, cleanup: env.cleanup };
}

test('NewTaskModal submits suggested_agent_profile_id for the selected agent', async (t) => {
  const ctx = createEnv();
  t.after(ctx.cleanup);

  const { h, render } = ctx.env.context.preact;
  const root = ctx.env.document.getElementById('root');
  const created = [];

  render(
    h(ctx.env.context.NewTaskModal, {
      open: true,
      onClose: () => {},
      projects: [],
      agents: [{ id: 'agent_alpha', name: 'Agent Alpha' }],
      onCreated: (task) => created.push(task),
    }),
    root,
  );
  await flushEffects();

  const title = root.querySelector('#new-task-title-input');
  title.value = 'New task';
  title.dispatchEvent(new ctx.env.window.Event('input', { bubbles: true }));

  // Dropdown unification (2026-07-23): the agent picker is a shared
  // `Dropdown` — open the menu and click the option.
  await pickDropdownOption(ctx.env, root.querySelector('#new-task-agent'), 'agent_alpha');
  await flushEffects();

  const createButton = root.querySelector('button.primary');
  assert.ok(createButton, 'create button exists');
  createButton.click();
  await flushEffects();

  assert.equal(ctx.posts.length, 1);
  assert.equal(ctx.posts[0].url, '/api/tasks');
  assert.equal(ctx.posts[0].body.suggested_agent_profile_id, 'agent_alpha');
  assert.equal(ctx.posts[0].body.agent_profile_id, undefined);
  assert.equal(created.length, 1);
});
