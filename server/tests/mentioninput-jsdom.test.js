// P4-4: MentionInput jsdom tests
//
// Covers:
//   (a) Shows dropdown when `@` is typed
//   (b) Filters projects by typed text after `@`
//   (c) Arrow keys navigate the suggestion list
//   (d) Enter selects a project and inserts `@projectName ` into the input
//   (e) Esc closes the suggestion dropdown

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreactEnv, flushEffects } = require('./helpers/jsdom-preact');

const PROJECTS = [
  { id: 'p1', name: 'Frontend' },
  { id: 'p2', name: 'Backend' },
  { id: 'p3', name: 'FrontPorch' },
];

function createEnv() {
  const env = createPreactEnv();
  env.loadComponent('MentionInput');
  return env;
}

/** Simulate typing a value into the textarea by setting value + dispatching input event. */
function typeInto(env, textarea, text) {
  textarea.value = text;
  textarea.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

test('MentionInput jsdom: shows dropdown when @ is typed', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  let inputValue = '';
  render(
    h(env.context.MentionInput, {
      value: inputValue,
      projects: PROJECTS,
      onInput: (e) => { inputValue = e.target.value; },
    }),
    root,
  );

  const textarea = root.querySelector('textarea');
  assert.ok(textarea, 'textarea should render');

  // No popup initially
  assert.equal(root.querySelector('.mention-popup'), null, 'no popup before typing @');

  // Type @ — simulate by setting value and dispatching input
  typeInto(env, textarea, '@');
  await flushEffects();

  // Re-render with new value (parent would do this via state)
  render(
    h(env.context.MentionInput, {
      value: '@',
      projects: PROJECTS,
      onInput: (e) => { inputValue = e.target.value; },
    }),
    root,
  );
  await flushEffects();

  const popup = root.querySelector('.mention-popup');
  assert.ok(popup, 'popup should appear when @ is typed');

  const items = popup.querySelectorAll('.mention-item');
  assert.equal(items.length, 3, 'all projects should show when just @ is typed');
});

test('MentionInput jsdom: filters projects by text after @', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  // Render with @Front already typed
  render(
    h(env.context.MentionInput, {
      value: '@Front',
      projects: PROJECTS,
      onInput: () => {},
    }),
    root,
  );
  await flushEffects();

  const popup = root.querySelector('.mention-popup');
  assert.ok(popup, 'popup should appear for @Front');

  const items = popup.querySelectorAll('.mention-item');
  assert.equal(items.length, 2, 'should match Frontend and FrontPorch');

  const names = Array.from(items).map(el => el.textContent.replace('@', '').trim());
  assert.ok(names.includes('Frontend'), 'should include Frontend');
  assert.ok(names.includes('FrontPorch'), 'should include FrontPorch');
});

test('MentionInput jsdom: arrow keys navigate suggestions', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h(env.context.MentionInput, {
      value: '@',
      projects: PROJECTS,
      onInput: () => {},
    }),
    root,
  );
  await flushEffects();

  const textarea = root.querySelector('textarea');
  const popup = root.querySelector('.mention-popup');
  assert.ok(popup, 'popup should be visible');

  // Initial state: first item is active
  let activeItems = root.querySelectorAll('.mention-item-active');
  assert.equal(activeItems.length, 1, 'exactly one active item');

  // ArrowDown — move to second item
  textarea.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  const items = root.querySelectorAll('.mention-item');
  assert.ok(items[1].classList.contains('mention-item-active'),
    'ArrowDown should highlight second item');

  // ArrowUp — back to first
  textarea.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowUp', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  const itemsAfter = root.querySelectorAll('.mention-item');
  assert.ok(itemsAfter[0].classList.contains('mention-item-active'),
    'ArrowUp should highlight first item');
});

test('MentionInput jsdom: Enter selects project and inserts @name ', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  let capturedValue = '';
  render(
    h(env.context.MentionInput, {
      value: '@',
      projects: PROJECTS,
      onInput: (e) => { capturedValue = e.target.value; },
    }),
    root,
  );
  await flushEffects();

  const textarea = root.querySelector('textarea');

  // Move to second item (Backend)
  textarea.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'ArrowDown', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  // Press Enter to select
  textarea.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Enter', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  // applyMention dispatches a synthetic input event with the new value.
  // In a real app the parent would re-render with the new value; here we
  // verify the onInput callback received the correct value.
  assert.equal(capturedValue, '@Backend ', 'onInput should have fired with @Backend ');
});

// ---- P8-6: inputRef prop tests (P7 hotfix ref→inputRef) ----

test('MentionInput jsdom: inputRef receives the textarea DOM element', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  const inputRef = env.context.preact.createRef();

  render(
    h(env.context.MentionInput, {
      value: '',
      projects: PROJECTS,
      onInput: () => {},
      inputRef,
    }),
    root,
  );
  await flushEffects();

  assert.ok(inputRef.current, 'inputRef.current should be assigned after render');
  assert.equal(inputRef.current.tagName, 'TEXTAREA', 'inputRef.current should be the textarea element');
});

test('MentionInput jsdom: inputRef.current.style.height is accessible', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  const inputRef = env.context.preact.createRef();

  render(
    h(env.context.MentionInput, {
      value: '',
      projects: PROJECTS,
      onInput: () => {},
      inputRef,
    }),
    root,
  );
  await flushEffects();

  assert.ok(inputRef.current.style, 'inputRef.current.style should be accessible');
  // Verify height can be read (empty string initially) and written without error
  const originalHeight = inputRef.current.style.height;
  inputRef.current.style.height = '100px';
  assert.equal(inputRef.current.style.height, '100px', 'style.height should be writable');
  inputRef.current.style.height = originalHeight;
});

test('MentionInput jsdom: inputRef.current.focus() works without throwing', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  const inputRef = env.context.preact.createRef();

  render(
    h(env.context.MentionInput, {
      value: '',
      projects: PROJECTS,
      onInput: () => {},
      inputRef,
    }),
    root,
  );
  await flushEffects();

  // focus() must not throw — callers rely on this for auto-focus patterns
  assert.doesNotThrow(() => inputRef.current.focus(), 'focus() should not throw');
});

test('MentionInput jsdom: falls back to internal ref when inputRef not provided', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  // Render WITHOUT inputRef
  render(
    h(env.context.MentionInput, {
      value: '@',
      projects: PROJECTS,
      onInput: () => {},
    }),
    root,
  );
  await flushEffects();

  const textarea = root.querySelector('textarea');
  assert.ok(textarea, 'textarea should render even without inputRef');

  // Popup should still appear (internal ref is used for measurements)
  const popup = root.querySelector('.mention-popup');
  assert.ok(popup, 'popup should appear when @ is typed without inputRef');
});

test('MentionInput jsdom: Esc closes the suggestion dropdown', async (t) => {
  const env = createEnv();
  t.after(env.cleanup);
  const { render, h } = env.context.preact;
  const root = env.document.getElementById('root');

  render(
    h(env.context.MentionInput, {
      value: '@',
      projects: PROJECTS,
      onInput: () => {},
    }),
    root,
  );
  await flushEffects();

  assert.ok(root.querySelector('.mention-popup'), 'popup should be visible');

  const textarea = root.querySelector('textarea');
  textarea.dispatchEvent(new env.window.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }));
  await flushEffects();

  assert.equal(root.querySelector('.mention-popup'), null, 'Esc should close popup');
});
