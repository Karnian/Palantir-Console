// P4-4: Dropdown jsdom tests
//
// Covers:
//   (a) Opens dropdown on trigger click, closes on second click
//   (b) Keyboard navigation: ArrowDown/ArrowUp moves selection, Enter selects, Esc closes
//   (c) Outside click closes the dropdown
//   (d) Renders items with labels correctly
//   (e) Handles empty items array gracefully

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

const SAMPLE_OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function createEnv() {
  const env = createPreactEnv();

  // Dropdown uses getBoundingClientRect — jsdom returns zeros by default
  // which is fine for the tests. Stub window.innerHeight for flip-up calc.
  env.context.window.innerHeight = 800;

  env.loadComponent('Dropdown');
  return env;
}

/** Open the dropdown and wait for both the render and the useEffect that sets hoverIdx. */
async function openDropdown(env, root) {
  const btn = root.querySelector('.dropdown-button');
  btn.click();
  // Two flushes: first for the click → open re-render, second for the
  // useEffect that focuses the menu and sets hoverIdx.
  await flushEffects();
  await flushEffects();
  return root.querySelector('[role="listbox"]');
}

test('Dropdown jsdom: opens on trigger click, closes on second click', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  let selected = 'a';
  render(
    h(env.context.Dropdown, {
      value: selected,
      onChange: (v) => { selected = v; },
      options: SAMPLE_OPTIONS,
    }),
    root,
  );

  const btn = root.querySelector('.dropdown-button');
  assert.ok(btn, 'trigger button should render');

  // Click to open
  const menu = await openDropdown(env, root);
  assert.ok(menu, 'menu should appear after click');

  // Click trigger again to close
  btn.click();
  await flushEffects();

  assert.equal(root.querySelector('[role="listbox"]'), null, 'menu should close on second click');
});

test('Dropdown jsdom: keyboard nav — ArrowDown/ArrowUp moves, Enter selects, Esc closes', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  let selected = 'a';
  const rerender = () => {
    render(
      h(env.context.Dropdown, {
        value: selected,
        onChange: (v) => { selected = v; },
        options: SAMPLE_OPTIONS,
      }),
      root,
    );
  };
  rerender();

  // Open dropdown and wait for hoverIdx to settle
  const menu = await openDropdown(env, root);
  assert.ok(menu, 'menu should be open');

  // ArrowDown to activate hover navigation (moves hoverIdx from -1 to 0)
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  let items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[0].classList.contains('hover'), 'first ArrowDown should highlight first item');

  // ArrowDown again to second item
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[1].classList.contains('hover'), 'second ArrowDown should move hover to second item');

  // ArrowUp to move back to first
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowUp', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[0].classList.contains('hover'), 'ArrowUp should move hover back to first item');

  // ArrowDown twice to reach second item, then Enter to select
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  assert.equal(selected, 'b', 'Enter should select the hovered item (Beta)');

  // Re-render with new value, open again to test Esc
  rerender();
  const menu2 = await openDropdown(env, root);
  assert.ok(menu2, 'menu should re-open');

  menu2.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  assert.equal(root.querySelector('[role="listbox"]'), null, 'Esc should close the menu');
});

test('Dropdown jsdom: outside click closes the dropdown', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h(env.context.Dropdown, {
      value: 'a',
      onChange: () => {},
      options: SAMPLE_OPTIONS,
    }),
    root,
  );

  // Open
  const menu = await openDropdown(env, root);
  assert.ok(menu, 'menu should be open');

  // Click outside (on body)
  env.document.body.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
  await flushEffects();

  assert.equal(root.querySelector('[role="listbox"]'), null, 'outside click should close menu');
});

test('Dropdown jsdom: renders items with correct labels', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h(env.context.Dropdown, {
      value: 'b',
      onChange: () => {},
      options: SAMPLE_OPTIONS,
    }),
    root,
  );

  // Trigger label should show selected option
  const triggerLabel = root.querySelector('.dropdown-label');
  assert.equal(triggerLabel.textContent, 'Beta', 'trigger should show label of selected value');

  // Open and check all items
  const menu = await openDropdown(env, root);
  assert.ok(menu, 'menu should open');

  const labels = Array.from(root.querySelectorAll('.dropdown-item-label'));
  assert.equal(labels.length, 3, 'should render 3 items');
  assert.deepEqual(
    labels.map(l => l.textContent),
    ['Alpha', 'Beta', 'Gamma'],
    'item labels should match options',
  );

  // Selected item should have aria-selected=true
  const selectedItem = root.querySelector('[aria-selected="true"]');
  assert.ok(selectedItem, 'selected item should have aria-selected');
  assert.ok(selectedItem.querySelector('.dropdown-item-check').textContent.includes('\u2713'),
    'selected item should show checkmark');
});

test('Dropdown jsdom: handles empty options array gracefully', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h(env.context.Dropdown, {
      value: null,
      onChange: () => {},
      options: [],
    }),
    root,
  );

  const btn = root.querySelector('.dropdown-button');
  assert.ok(btn, 'button should still render with empty options');

  // Trigger label should be empty
  const triggerLabel = root.querySelector('.dropdown-label');
  assert.equal(triggerLabel.textContent, '', 'label should be empty when no options');

  // Open — menu should render but be empty
  btn.click();
  await flushEffects();

  const items = root.querySelectorAll('.dropdown-item');
  assert.equal(items.length, 0, 'no items when options is empty');
});
