// P4-4: Dropdown jsdom tests
//
// Covers:
//   (a) Opens dropdown on trigger click, closes on second click
//   (b) Focus + active option are seeded after the menu mounts
//   (c) Keyboard navigation: ArrowDown/ArrowUp moves selection, Enter selects, Esc closes
//   (d) Mouse/keyboard commits restore focus to the trigger
//   (e) Closed triggers expose both their field name and current value
//   (f) Outside click closes the dropdown
//   (g) Scroll/resize close restores menu focus without stealing outside-click focus
//   (h) Typeahead prefix matching, repeated-character cycling, and timeout reset
//   (i) Seeded and keyboard-moved active options are scrolled into view
//   (j) Closed-trigger typeahead commits matches without opening the menu
//   (k) Renders items with labels correctly
//   (l) Handles empty items array gracefully

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

test('Dropdown jsdom: mounted menu receives focus and seeds the selected option once per open', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  let options = SAMPLE_OPTIONS;
  const rerender = () => {
    render(
      h(env.context.Dropdown, {
        value: 'b',
        onChange: () => {},
        options,
      }),
      root,
    );
  };
  rerender();

  const btn = root.querySelector('.dropdown-button');
  btn.focus();
  btn.click();
  // The first effect flush computes menuPos; the second happens after the
  // listbox mount and must focus it + seed hoverIdx from value.
  await flushEffects();
  await flushEffects();

  let menu = root.querySelector('[role="listbox"]');
  let items = root.querySelectorAll('.dropdown-item');
  assert.ok(menu, 'listbox should mount after the position effect');
  assert.equal(env.document.activeElement, menu, 'mounted listbox should receive focus');
  assert.ok(items[1].classList.contains('hover'), 'selected value should seed hoverIdx');
  assert.equal(menu.getAttribute('aria-activedescendant'), items[1].id,
    'listbox should expose the seeded option as active');

  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();
  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[2].classList.contains('hover'), 'ArrowDown should move away from the seeded value');

  // Changing option count recomputes menuPos while the same menu is mounted.
  // That must not seed hoverIdx a second time and lose the user's position.
  options = [...SAMPLE_OPTIONS, { value: 'd', label: 'Delta' }];
  rerender();
  await flushEffects();
  await flushEffects();
  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[2].classList.contains('hover'),
    'repositioning an open menu should preserve the user-controlled hoverIdx');

  menu = root.querySelector('[role="listbox"]');
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await flushEffects();
  assert.equal(root.querySelector('[role="listbox"]'), null, 'Escape should close the first menu');

  const reopened = await openDropdown(env, root);
  items = root.querySelectorAll('.dropdown-item');
  assert.equal(env.document.activeElement, reopened, 'reopened listbox should receive focus again');
  assert.ok(items[1].classList.contains('hover'),
    'closing should reset seeding so the next open starts from the selected value');
});

test('Dropdown jsdom: seeded and keyboard-moved active options scroll into view', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');
  const scrollCalls = [];

  env.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    if (this.classList.contains('dropdown-item')) {
      scrollCalls.push(`${this.dataset.value}:${options?.block}`);
    }
  };

  render(
    h(env.context.Dropdown, {
      value: 'b',
      onChange: () => {},
      options: SAMPLE_OPTIONS,
    }),
    root,
  );

  const menu = await openDropdown(env, root);
  assert.deepEqual(scrollCalls, ['b:nearest'],
    'the selected option seeded after menu mount should be scrolled into view');

  const key = async (value) => {
    menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true,
    }));
    await flushEffects();
  };

  await key('ArrowDown');
  await key('ArrowUp');
  await key('Home');
  await key('End');

  assert.deepEqual(scrollCalls, ['b:nearest', 'c:nearest', 'b:nearest', 'a:nearest', 'c:nearest'],
    'ArrowDown, ArrowUp, Home, and End should scroll each newly active option into view');
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

  // The menu opens with Alpha seeded, so ArrowDown moves to Beta.
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  let items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[1].classList.contains('hover'), 'first ArrowDown should highlight second item');

  // ArrowDown again moves to the third item.
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[2].classList.contains('hover'), 'second ArrowDown should move hover to third item');

  // ArrowUp moves back to the second item.
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowUp', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  items = root.querySelectorAll('.dropdown-item');
  assert.ok(items[1].classList.contains('hover'), 'ArrowUp should move hover back to second item');

  // Move to Alpha and back to Beta, then Enter to select.
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowUp', bubbles: true, cancelable: true,
  }));
  await flushEffects();

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

test('Dropdown jsdom: mouse and Enter commits restore focus to the trigger', async (t) => {
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

  let menu = await openDropdown(env, root);
  const btn = root.querySelector('.dropdown-button');
  let items = root.querySelectorAll('.dropdown-item');
  items[2].focus();
  items[2].click();
  await flushEffects();

  assert.equal(selected, 'c', 'mouse click should commit the clicked option');
  assert.equal(env.document.activeElement, btn,
    'mouse commit should restore focus before the option unmounts');

  rerender();
  menu = await openDropdown(env, root);
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowUp', bubbles: true, cancelable: true,
  }));
  await flushEffects();
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  assert.equal(selected, 'b', 'Enter should commit the active option');
  assert.equal(env.document.activeElement, btn, 'Enter commit should restore focus to the trigger');
});

test('Dropdown jsdom: Space commits the active option, closes, and restores trigger focus', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');
  const changes = [];

  render(
    h(env.context.Dropdown, {
      value: 'a',
      onChange: (value) => { changes.push(value); },
      options: SAMPLE_OPTIONS,
    }),
    root,
  );

  const menu = await openDropdown(env, root);
  const btn = root.querySelector('.dropdown-button');
  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: ' ', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  assert.deepEqual(changes, ['b'], 'Space should commit the active option');
  assert.equal(root.querySelector('[role="listbox"]'), null, 'Space should close the menu');
  assert.equal(env.document.activeElement, btn, 'Space commit should restore focus to the trigger');
});

test('Dropdown jsdom: closed trigger accessible name includes field and displayed value', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h('div', null,
      h('label', { for: 'priority-dropdown' }, 'Priority'),
      h(env.context.Dropdown, {
        id: 'priority-dropdown',
        value: 'b',
        onChange: () => {},
        options: SAMPLE_OPTIONS,
      }),
    ),
    root,
  );
  await flushEffects();
  await flushEffects();

  let btn = root.querySelector('.dropdown-button');
  const externalLabel = root.querySelector('label');
  const labelledBy = btn.getAttribute('aria-labelledby').split(/\s+/);
  assert.ok(externalLabel.id, 'component should give an id-less external label a stable id');
  assert.deepEqual(
    labelledBy.map(labelId => env.document.getElementById(labelId)?.textContent),
    ['Priority', 'Beta'],
    'aria-labelledby should combine the external field label and selected value',
  );

  render(
    h(env.context.Dropdown, {
      ariaLabel: 'Priority',
      value: '',
      placeholder: 'Choose priority',
      onChange: () => {},
      options: SAMPLE_OPTIONS,
    }),
    root,
  );
  await flushEffects();

  btn = root.querySelector('.dropdown-button');
  assert.equal(btn.getAttribute('aria-label'), 'Priority, Choose priority',
    'ariaLabel path should include a placeholder when no value is selected');
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

test('Dropdown jsdom: scroll close restores menu focus but outside mousedown does not steal focus', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h('div', null,
      h(env.context.Dropdown, {
        value: 'a',
        onChange: () => {},
        options: SAMPLE_OPTIONS,
      }),
      h('button', { type: 'button', id: 'outside-target' }, 'Outside'),
    ),
    root,
  );

  let menu = await openDropdown(env, root);
  const btn = root.querySelector('.dropdown-button');
  const outside = root.querySelector('#outside-target');
  assert.equal(env.document.activeElement, menu, 'open menu should own focus before ancestor scroll');

  root.dispatchEvent(new env.window.Event('scroll'));
  await flushEffects();

  assert.equal(root.querySelector('[role="listbox"]'), null, 'ancestor scroll should close the menu');
  assert.equal(env.document.activeElement, btn,
    'ancestor scroll should restore focus before the focused menu unmounts');

  menu = await openDropdown(env, root);
  assert.equal(env.document.activeElement, menu, 'reopened menu should own focus before outside click');

  let triggerFocusCalls = 0;
  const originalTriggerFocus = btn.focus.bind(btn);
  btn.focus = () => {
    triggerFocusCalls += 1;
    originalTriggerFocus();
  };

  outside.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
  outside.focus();
  await flushEffects();

  assert.equal(root.querySelector('[role="listbox"]'), null, 'outside mousedown should close the menu');
  assert.equal(triggerFocusCalls, 0, 'outside mousedown must not force focus back to the trigger');
  assert.equal(env.document.activeElement, outside,
    'the outside target should retain the browser-directed focus');
});

test('Dropdown jsdom: typeahead matches prefixes, cycles repeated characters, and resets after timeout', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');
  const options = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'beta-disabled', label: 'Beta', disabled: true },
    { value: 'bravo', label: 'Bravo' },
    { value: 'brown', label: 'Brown' },
    { value: 'blue', label: 'Blue' },
    { value: 'gamut', label: 'Gamut' },
    { value: 'green', label: 'Green' },
  ];

  render(
    h(env.context.Dropdown, {
      value: 'alpha',
      onChange: () => {},
      options,
    }),
    root,
  );

  const menu = await openDropdown(env, root);
  const key = async (value) => {
    menu.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true,
    }));
    await flushEffects();
  };
  const hoveredValue = () => root.querySelector('.dropdown-item.hover')?.dataset.value;
  const scrollCalls = [];
  for (const item of root.querySelectorAll('.dropdown-item')) {
    item.scrollIntoView = () => scrollCalls.push(item.dataset.value);
  }

  await key('g');
  assert.equal(hoveredValue(), 'gamut', 'a printable character should jump to the first prefix match');
  await key('r');
  assert.equal(hoveredValue(), 'green', 'successive characters should accumulate into a prefix');

  await flushEffects(550);
  await key('b');
  assert.equal(hoveredValue(), 'bravo', 'a fresh search should skip the first disabled prefix match');
  await key('b');
  assert.equal(hoveredValue(), 'brown', 'repeating one character should cycle to the next match');

  await flushEffects(550);
  await key('b');
  assert.equal(hoveredValue(), 'bravo',
    'after the timeout, the same character should start again at the first enabled match');
  assert.deepEqual(scrollCalls, ['gamut', 'green', 'bravo', 'brown', 'bravo'],
    'each typeahead match should be scrolled into view');
});

test('Dropdown jsdom: closed-trigger typeahead commits and cycles without opening the menu', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');
  const changes = [];
  const options = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'beta-disabled', label: 'Beta', disabled: true },
    { value: 'bravo', label: 'Bravo' },
    { value: 'brown', label: 'Brown' },
    { value: 'blue', label: 'Blue' },
  ];

  render(
    h(env.context.Dropdown, {
      value: 'alpha',
      onChange: (nextValue) => { changes.push(nextValue); },
      options,
    }),
    root,
  );

  const btn = root.querySelector('.dropdown-button');
  btn.focus();
  const key = async (value) => {
    btn.dispatchEvent(new env.window.KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true,
    }));
    await flushEffects(20);
    assert.equal(root.querySelector('[role="listbox"]'), null,
      'closed-trigger typeahead must not open the menu');
  };

  await key('b');
  await key('b');

  assert.deepEqual(changes, ['bravo', 'brown'],
    'typeahead should skip disabled matches and cycle repeated characters from the last match');
  assert.equal(env.document.activeElement, btn, 'closed-trigger typeahead should preserve trigger focus');
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
