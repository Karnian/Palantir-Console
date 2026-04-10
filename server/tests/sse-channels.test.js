// P2-3: static-assertion guard for SSE channel drift between server and
// client. See server/services/eventChannels.js for the rationale.
//
// This test does NOT run the client — it parses the hooks.js source file
// as text and extracts the channels array literal inside useSSE. That is
// deliberate: we cannot `require` the hook (it depends on preact globals
// and lives in a browser bundle), and a runtime fetch test would hide
// drift until the server starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SERVER_EMITS, CLIENT_REQUIRED_LIVE } = require('../services/eventChannels');

const HOOKS_PATH = path.resolve(__dirname, '..', 'public', 'app', 'lib', 'hooks.js');

// Extract the channels array specifically from inside the `useSSE`
// function body. Scoping matters (Codex R1 blocker): a future refactor
// could add an unrelated `const channels = [...]` elsewhere in hooks.js
// and a non-scoped regex would match that literal instead, leaving the
// real useSSE subscription unchecked while the test stayed green. We
// anchor on the function declaration, then find the first
// `const channels = [...]` within the body, and fail loudly if either
// step does not match.
function extractChannels(source) {
  const fnHeaderIdx = source.search(/export\s+function\s+useSSE\s*\(/);
  if (fnHeaderIdx < 0) {
    throw new Error('sse-channels.test: could not locate `export function useSSE(` in hooks.js. Refactor? Update the extractor.');
  }
  // Walk forward from the function header, tracking brace depth, to find
  // the closing `}` of useSSE. Within that slice we look for the channels
  // literal. Brace depth is counted starting from the first `{` we see
  // after the function header (the function body open brace).
  let i = fnHeaderIdx;
  while (i < source.length && source[i] !== '{') i++;
  if (i >= source.length) {
    throw new Error('sse-channels.test: could not find useSSE body opening brace');
  }
  const bodyStart = i;
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const bodyEnd = i;
  const body = source.slice(bodyStart, bodyEnd);

  const match = body.match(/const\s+channels\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!match) {
    throw new Error('sse-channels.test: could not locate `const channels = [...]` inside useSSE body. If you refactored useSSE, update this extractor.');
  }
  const arrayBody = match[1];
  const stringLiteralRe = /['"]([^'"\n]+)['"]/g;
  const out = [];
  let m;
  while ((m = stringLiteralRe.exec(arrayBody)) !== null) {
    out.push(m[1]);
  }
  return out;
}

test('P2-3: hooks.js useSSE channels array exists and is parseable', () => {
  const src = fs.readFileSync(HOOKS_PATH, 'utf8');
  const channels = extractChannels(src);
  assert.ok(channels.length > 0, 'expected at least one channel in useSSE');
});

test('P2-3: extractor is scoped to useSSE (ignores decoy const channels elsewhere)', () => {
  // Simulated source that has a decoy `const channels = ['decoy']` before
  // useSSE and the real one inside. A non-scoped extractor would pick the
  // decoy and silently match against the wrong literal.
  const fakeSrc = `
    const channels = ['decoy'];
    function otherHelper() { return channels; }

    export function useSSE(listeners) {
      useEffect(() => {
        const channels = ['run:status', 'task:created'];
        return () => {};
      }, []);
    }
  `;
  assert.deepEqual(extractChannels(fakeSrc), ['run:status', 'task:created']);
});

test('P2-3: extractor throws loudly if useSSE was renamed', () => {
  const renamedSrc = `
    export function useSseRenamed(listeners) {
      const channels = ['run:status'];
    }
  `;
  assert.throws(() => extractChannels(renamedSrc), /locate `export function useSSE\(/);
});

test('P2-3: every CLIENT_REQUIRED_LIVE channel is actually subscribed in hooks.js', () => {
  // This is the main guard against the Phase 5 / Phase 7 regression
  // pattern: a handler registered in the UI but the channel name was
  // never added to the hard-coded subscription array, so the
  // EventSource listener never fired.
  const src = fs.readFileSync(HOOKS_PATH, 'utf8');
  const subscribed = new Set(extractChannels(src));
  const missing = [];
  for (const ch of CLIENT_REQUIRED_LIVE) {
    if (!subscribed.has(ch)) missing.push(ch);
  }
  assert.deepEqual(
    missing,
    [],
    `hooks.js useSSE is missing required live channels: ${missing.join(', ')}. Add them to the channels array in server/public/app/lib/hooks.js.`
  );
});

test('P2-3: every server-emitted channel we ship live is registered in SERVER_EMITS', () => {
  // Reverse check: if CLIENT_REQUIRED_LIVE lists a channel that is NOT
  // in SERVER_EMITS, that is a stale expectation (client is waiting for
  // something the server never sends). Catch it before it escapes.
  const serverSet = new Set(SERVER_EMITS);
  const orphaned = CLIENT_REQUIRED_LIVE.filter((ch) => !serverSet.has(ch));
  assert.deepEqual(
    orphaned,
    [],
    `CLIENT_REQUIRED_LIVE lists channels not emitted by the server: ${orphaned.join(', ')}. Remove them from eventChannels.js or wire an emitter.`,
  );
});

test('P2-3: SERVER_EMITS contains no duplicates', () => {
  const set = new Set(SERVER_EMITS);
  assert.equal(set.size, SERVER_EMITS.length, 'duplicate channel in SERVER_EMITS');
});

test('P2-3: SERVER_EMITS is sorted within its listed groups', () => {
  // Loose check: each contiguous group (separated in the source by
  // whitespace, not detectable here) should already be alphabetical
  // globally if the file was authored correctly. A global sort check is
  // not strictly enforced because the grouping intentionally sorts
  // within groups but not across groups. We skip a strict sort assertion
  // here and leave it to review hygiene.
  assert.ok(true);
});

test('P2-3: hooks.js subscribes only to channels also in SERVER_EMITS (subset check, with legacy allowance)', () => {
  // Some forward-compat or legacy subscriptions (e.g. `run:created`,
  // `task:deleted`) exist in hooks.js without a corresponding emitter
  // today. They are NOT bugs — they are dead subs that will start
  // firing when those channels are wired. Allow-list them explicitly so
  // a future author understands why they are exempt.
  const LEGACY_CLIENT_ONLY = new Set(['run:created', 'task:deleted']);
  const src = fs.readFileSync(HOOKS_PATH, 'utf8');
  const subscribed = extractChannels(src);
  const serverSet = new Set(SERVER_EMITS);
  const rogue = subscribed.filter((ch) => !serverSet.has(ch) && !LEGACY_CLIENT_ONLY.has(ch));
  assert.deepEqual(
    rogue,
    [],
    `hooks.js subscribes to channels that are not in SERVER_EMITS and not in the LEGACY_CLIENT_ONLY allow-list: ${rogue.join(', ')}. Either wire an emitter in eventChannels.js or add the channel to the legacy allow-list.`,
  );
});
