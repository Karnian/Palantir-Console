// hooks/conversation.js — useConversation (v3 Phase 1.5).
//
// Conversation identity is the 1st-class surface. A conversation id
// is one of: 'top' | 'pm:<projectId>' (Phase 3a) | 'worker:<runId>'.
// useConversation() polls /api/conversations/:id/events with an
// incremental cursor, and exposes a sendMessage() that hits
// /api/conversations/:id/message.
//
// P8-3: the old useManager() hook was removed. App.js now composes
// useManagerLifecycle() (start/stop/status) + useConversation('top')
// (events/sendMessage) into a compat manager object.

import { apiFetch } from '../api.js';
import { addToast } from '../toast.js';
import { sseBroker } from './sse.js';

import { useState, useEffect, useCallback, useRef } from '../../../vendor/hooks.module.js';

export function useConversation(conversationId, { poll = true, pollMs = 10000 } = {}) {
  // P2-8: pollMs default relaxed from 2000 → 10000 now that run:event
  // SSE frames drive live refresh. Poll is kept as a cheap safety net
  // in case the SSE stream drops silently (EventSource reconnects are
  // transparent but the useSSE server_session id check mitigates the
  // replay-cursor hole). With both paths active the user sees chat
  // updates within ~1 event-loop tick on the happy path, and within
  // 10s on a full SSE outage.
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);
  const lastEventIdRef = useRef(0);
  const activeIdRef = useRef(conversationId);
  activeIdRef.current = conversationId;
  // Track the current backing run id so the SSE subscription can filter
  // `run:event` frames to "this conversation's run". We keep it in a
  // ref (not state) because the SSE callback captures closure state at
  // subscription time — a ref lets us read the latest id without
  // re-subscribing on every resolve() completion.
  const runIdRef = useRef(null);
  // P2-8 R2 fix (Codex R1 blocker): an unmount-only tombstone separate
  // from activeIdRef. The existing activeIdRef fence catches id
  // CHANGES mid-await (the next render re-seats activeIdRef to the new
  // id so the post-await compare fails). But it does NOT catch UNMOUNT
  // — on unmount the component is gone, no re-render happens, and the
  // last committed value of activeIdRef remains equal to the captured
  // myId. A late resolve()/loadEvents() post-await fence then passes
  // and calls setRun / setEvents on an unmounted component.
  //
  // mountedRef solves this with a one-shot cleanup that fires ONLY on
  // final unmount (empty dep effect). Every post-await state write is
  // additionally gated on mountedRef.current. We cannot tombstone
  // activeIdRef in the main effect's cleanup because that cleanup also
  // fires on every id CHANGE — and by that point the render phase has
  // already reseated activeIdRef to the new id, so clobbering to null
  // would poison the newly-mounted conversation.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const resolve = useCallback(async () => {
    if (!conversationId) return;
    // v3 Phase 6 R2 fix — fence late responses. Capture the id that
    // this fetch targets BEFORE awaiting, then only commit the state
    // update if `activeIdRef.current` still matches. Without this,
    // a slow response for PM A can land after the user switched to
    // PM B and overwrite B's state (A→B race) — which would briefly
    // flash the Reset PM button and stale Active badge back onto B
    // even though Phase 6's synchronous clear already wiped it.
    const myId = conversationId;
    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(myId)}`);
      // P2-8 R2: mountedRef gates the unmount race in addition to the
      // activeIdRef gate that catches id switches.
      if (!mountedRef.current) return;
      if (activeIdRef.current !== myId) return; // user already moved
      const nextRun = data.conversation?.run || null;
      setRun(nextRun);
      // P2-8: keep runIdRef in sync so the SSE subscription filter can
      // tell which `run:event` frames belong to this conversation.
      runIdRef.current = nextRun ? nextRun.id : null;
    } catch { /* 4xx — leave run null */ }
  }, [conversationId]);

  const loadEvents = useCallback(async (opts = {}) => {
    if (!conversationId) return;
    const myId = conversationId;
    try {
      if (opts.reset) {
        lastEventIdRef.current = 0;
        setEvents([]);
      }
      const after = lastEventIdRef.current;
      const base = `/api/conversations/${encodeURIComponent(myId)}/events`;
      const url = after > 0 ? `${base}?after=${after}` : base;
      const data = await apiFetch(url);
      // v3 Phase 6 R2 fix — same fence as resolve(). Late events
      // batches from a previous id must not leak into the current
      // conversation's render state. P2-8 R2: mountedRef additionally
      // gates the unmount race.
      if (!mountedRef.current) return;
      if (activeIdRef.current !== myId) return;
      const incoming = Array.isArray(data.events) ? data.events : [];
      if (incoming.length === 0) return;
      let maxId = lastEventIdRef.current;
      for (const ev of incoming) {
        if (typeof ev.id === 'number' && ev.id > maxId) maxId = ev.id;
      }
      lastEventIdRef.current = maxId;
      setEvents(prev => {
        if (prev.length === 0) return incoming;
        const seen = new Set(prev.map(e => e.id));
        const merged = prev.slice();
        for (const ev of incoming) {
          if (!seen.has(ev.id)) merged.push(ev);
        }
        return merged;
      });
    } catch { /* ignore */ }
  }, [conversationId]);

  const sendMessage = useCallback(async (text, images) => {
    if (!conversationId) return;
    // v3 Phase 6 R3 fix — fence loading writes on the conversation id
    // captured at call time so a late resolve/finally from a previous
    // conversation (A.sendMessage in flight, user switched to B) cannot
    // stomp on B's loading state. Same class of race as resolve()/
    // loadEvents() above.
    const myId = conversationId;
    setLoading(true);
    try {
      const body = { text };
      if (images && images.length > 0) body.images = images;
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(myId)}/message`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return data;
    } catch (err) {
      addToast('Failed to send: ' + err.message, 'error');
      throw err;
    } finally {
      // P2-8 R2: same unmount fence as resolve/loadEvents.
      if (mountedRef.current && activeIdRef.current === myId) {
        setLoading(false);
      }
    }
  }, [conversationId]);

  useEffect(() => {
    // v3 Phase 6 R1 fix — clear stale run/events SYNCHRONOUSLY on
    // every id change so consumers that derive UI affordances from
    // `run` (e.g., Phase 6 "Reset PM" button + active badge) never
    // see the previous PM's state while the async resolve() for the
    // new id is in flight. Without this, switching from an active
    // PM A to an idle PM B would briefly render B as active and
    // expose a Reset that then operates on B based on A's stale
    // state. resolve() will repopulate run/events asynchronously.
    //
    // R4 fix — also reset `loading` here. sendMessage() now fences its
    // `finally` by id (R3), which means a mid-flight A send whose
    // finally is skipped would otherwise leave B stuck at loading=true
    // forever. Clearing on id switch is correct because loading is a
    // per-conversation concept tied to "am I waiting for my own
    // response", not a global app state.
    setRun(null);
    setEvents([]);
    setLoading(false);
    lastEventIdRef.current = 0;
    runIdRef.current = null;

    resolve();
    loadEvents({ reset: true });

    // P2-8: subscribe to run:event SSE frames on the module broker and
    // filter to this conversation's current backing run id. Handler
    // captures conversationId in closure so the id-change effect
    // teardown unsubscribes cleanly. On match, just call loadEvents()
    // — the incremental cursor (`after=`) prevents duplicate rows even
    // if the poll tick arrives first, and the fetch is cheap because
    // 99% of ticks return zero new events.
    const unsubscribe = sseBroker.subscribe('run:event', (data) => {
      if (!data || typeof data !== 'object') return;
      const eventRunId = data.runId || data.run_id || null;
      if (!eventRunId) return;
      // Fence: this conversation must still be the active one AND the
      // runIdRef must match (populated by resolve() after mount).
      if (activeIdRef.current !== conversationId) return;
      if (!runIdRef.current || runIdRef.current !== eventRunId) return;
      loadEvents();
    });

    if (!poll) {
      return () => {
        unsubscribe();
        if (pollRef.current) clearInterval(pollRef.current);
        lastEventIdRef.current = 0;
        runIdRef.current = null;
      };
    }
    pollRef.current = setInterval(() => {
      if (activeIdRef.current !== conversationId) return;
      resolve();
      loadEvents();
    }, pollMs);
    return () => {
      unsubscribe();
      if (pollRef.current) clearInterval(pollRef.current);
      lastEventIdRef.current = 0;
      runIdRef.current = null;
    };
  }, [conversationId, poll, pollMs, resolve, loadEvents]);

  return { run, events, loading, sendMessage, reload: () => loadEvents({ reset: true }) };
}
