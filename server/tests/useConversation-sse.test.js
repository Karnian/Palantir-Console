// P2-8: structural guards for the useConversation SSE subscription +
// poll relaxation. We cannot run the hook in Node (it pulls in preact
// globals and browser EventSource), so we assert the source-level
// shape is intact:
//
//   1. A module-level sseBroker exists with subscribe/publish.
//   2. useSSE publishes every received channel frame to the broker.
//   3. useConversation default `pollMs` is 10000, not 2000.
//   4. useConversation subscribes to `run:event` via the broker.
//   5. The SSE handler fences on activeIdRef + runIdRef before acting.
//   6. The cleanup function unsubscribes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_PATH = path.resolve(__dirname, '..', 'public', 'app', 'lib', 'hooks.js');
const src = fs.readFileSync(HOOKS_PATH, 'utf8');

function sliceFn(name) {
  const headerRe = new RegExp(`export function ${name}\\s*\\(`);
  const headerMatch = src.match(headerRe);
  if (!headerMatch) return null;
  const start = headerMatch.index;
  // Skip the argument list by tracking parenthesis depth from the `(`.
  // Argument defaults can contain `{}` (e.g. `{ poll = true } = {}`),
  // so we cannot just search for the first `{` — that would trip on
  // the destructuring default's `{`.
  let i = headerMatch.index + headerMatch[0].length - 1; // on the `(`
  let parenDepth = 1;
  i++;
  while (i < src.length && parenDepth > 0) {
    const ch = src[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    i++;
  }
  // i is now just past the closing `)`. Skip whitespace to the `{`
  // that opens the body.
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;
  // Brace-count the body.
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

test('P2-8: module-level sseBroker is defined with subscribe and publish', () => {
  assert.match(src, /const\s+sseBroker\s*=\s*\(\(\)\s*=>\s*\{/, 'sseBroker IIFE missing');
  assert.match(src, /subscribe\s*\(\s*channel\s*,\s*cb\s*\)/, 'sseBroker.subscribe(channel, cb) signature missing');
  assert.match(src, /publish\s*\(\s*channel\s*,\s*data\s*\)/, 'sseBroker.publish(channel, data) signature missing');
});

test('P2-8: sseBroker.publish is called inside useSSE for every channel frame', () => {
  const body = sliceFn('useSSE');
  assert.ok(body, 'useSSE function not found');
  assert.match(body, /sseBroker\.publish\s*\(\s*ch\s*,\s*data\s*\)/,
    'useSSE must invoke sseBroker.publish(ch, data) for each incoming frame');
});

test('P2-8: useConversation default pollMs is 10000 (relaxed from 2000)', () => {
  // The default object literal must set pollMs: 10000. Allow a comment
  // or trailing whitespace.
  const header = src.match(/export function useConversation\(conversationId,\s*\{([^}]+)\}\s*=\s*\{\}\)/);
  assert.ok(header, 'useConversation signature not found');
  assert.match(header[1], /pollMs\s*=\s*10000/,
    'useConversation default pollMs must be 10000 (P2-8 relaxed from 2000)');
  assert.doesNotMatch(header[1], /pollMs\s*=\s*2000/,
    'old pollMs=2000 default must not linger');
});

test('P2-8: useConversation subscribes to run:event via sseBroker and returns an unsubscribe', () => {
  const body = sliceFn('useConversation');
  assert.ok(body, 'useConversation function not found');
  // The broker subscription call.
  assert.match(body, /sseBroker\.subscribe\(\s*['"]run:event['"]/,
    'useConversation must call sseBroker.subscribe("run:event", ...)');
  // The cleanup function must invoke unsubscribe.
  assert.match(body, /unsubscribe\(\)/,
    'useConversation cleanup must invoke the unsubscribe handle returned by broker.subscribe');
});

test('P2-8: useConversation SSE handler fences on activeIdRef and runIdRef before dispatching', () => {
  const body = sliceFn('useConversation');
  // The handler body must reference both fences before calling
  // loadEvents so a late frame for another conversation cannot
  // reload this one's events.
  assert.match(body, /activeIdRef\.current\s*!==\s*conversationId/,
    'SSE handler must fence on activeIdRef !== conversationId');
  assert.match(body, /runIdRef\.current[\s\S]{0,120}?eventRunId/,
    'SSE handler must compare the frame run id against runIdRef.current');
});

test('P2-8: runIdRef is populated by resolve() after mount', () => {
  const body = sliceFn('useConversation');
  assert.match(body, /runIdRef\.current\s*=\s*nextRun\s*\?\s*nextRun\.id\s*:\s*null/,
    'resolve() must keep runIdRef in sync with the backing run id');
});

// ---- P2-8 R2 blocker: unmount race ----

test('P2-8 R2: useConversation declares a mountedRef with a one-shot unmount effect', () => {
  const body = sliceFn('useConversation');
  assert.match(body, /const\s+mountedRef\s*=\s*useRef\(true\)/,
    'mountedRef must be declared as useRef(true)');
  // One-shot unmount effect: useEffect with `[]` deps that sets
  // mountedRef.current = false in its cleanup. This is separate from
  // the main conversation-id effect because the main effect's cleanup
  // fires on every id change too, which would clobber a freshly-
  // mounted value.
  assert.match(
    body,
    /useEffect\(\(\)\s*=>\s*\{\s*mountedRef\.current\s*=\s*true;?\s*return\s*\(\)\s*=>\s*\{\s*mountedRef\.current\s*=\s*false;?\s*\};?\s*\},\s*\[\]\)/,
    'unmount-only effect on mountedRef must exist with empty dep array',
  );
});

test('P2-8 R2: resolve/loadEvents/sendMessage all fence on mountedRef after their awaits', () => {
  const body = sliceFn('useConversation');
  // Each async consumer reads mountedRef.current in a guard before
  // calling setRun / setEvents / setLoading.
  const guards = body.match(/if\s*\(\s*!mountedRef\.current\s*\)/g) || [];
  assert.ok(guards.length >= 2,
    `expected at least 2 '!mountedRef.current' guards (resolve + loadEvents), found ${guards.length}`);
  // sendMessage's finally uses a compound check
  assert.match(
    body,
    /mountedRef\.current\s*&&\s*activeIdRef\.current\s*===\s*myId/,
    'sendMessage finally must fence on mountedRef && activeIdRef',
  );
});
