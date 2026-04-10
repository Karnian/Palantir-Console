// hooks/sse.js — SSE broker + useSSE hook.
//
// P2-8: module-level broker so multiple hooks can consume the same SSE
// stream without each opening its own EventSource. `useSSE` is still
// the singleton owner of the real connection; when it receives an
// event it calls both (a) the listeners map the caller passed in (the
// legacy per-channel callback contract) AND (b) broker.publish(), which
// fan-outs to any hook that called broker.subscribe() for this channel.
// `useConversation` uses the broker to receive `run:event` frames so it
// can drop its 2s poll down to 10s without losing responsiveness.

const { useState, useEffect, useRef } = window.preactHooks;

export const sseBroker = (() => {
  const subs = new Map(); // channel -> Set<callback>
  return {
    subscribe(channel, cb) {
      if (!channel || typeof cb !== 'function') return () => {};
      let set = subs.get(channel);
      if (!set) { set = new Set(); subs.set(channel, set); }
      set.add(cb);
      return () => {
        const s = subs.get(channel);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) subs.delete(channel);
      };
    },
    publish(channel, data) {
      const s = subs.get(channel);
      if (!s || s.size === 0) return;
      // Iterate over a snapshot so a subscriber that unsubscribes
      // synchronously during dispatch (e.g. unmount side-effect) does
      // not corrupt the set mid-iteration.
      for (const cb of Array.from(s)) {
        try { cb(data); } catch { /* per-subscriber errors are isolated */ }
      }
    },
  };
})();

export function useSSE(listeners) {
  const listenersRef = useRef(listeners);
  listenersRef.current = listeners;
  const [connected, setConnected] = useState(false);
  // PR3a / ADD-3: cache the server_session_id across reconnects. On
  // silent EventSource auto-reconnect after a server restart, the new
  // process starts eventId at 0 and replayBuffer is empty — our Last-
  // Event-ID cursor becomes meaningless and any un-replayed transitions
  // are lost forever. Detect the change and do a full reload so the
  // client gets a consistent view.
  const serverSessionRef = useRef(null);

  useEffect(() => {
    let source;
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }
    source.onopen = () => setConnected(true);
    const channels = [
      'task:created', 'task:updated', 'task:deleted',
      'run:created', 'run:status', 'run:completed', 'run:event',
      'manager:started', 'manager:stopped', 'run:output', 'run:result',
      // v3 Phase 5: priority-alert channel (run:needs_input). Previously
      // omitted — Phase 5 App() registered a handler but the channel
      // subscription here was never added, so the tab-title pulse path
      // never fired. Regression discovered during Phase 7 live smoke.
      'run:needs_input',
      // v3 Phase 7: dispatch audit live push so Drift badge + drawer
      // refresh without waiting for the 15s reload timer.
      'dispatch_audit:recorded',
    ];
    channels.forEach((ch) => {
      source.addEventListener(ch, (e) => {
        try {
          const data = JSON.parse(e.data);
          // P2-8: publish every parsed event to the module broker so
          // any hook that wants the frame (e.g. useConversation for
          // `run:event`) can receive it without opening a second
          // EventSource to the same endpoint. The per-channel callback
          // map is still invoked — legacy contract preserved.
          sseBroker.publish(ch, data);
          const fn = listenersRef.current[ch];
          if (fn) fn(data);
        } catch { /* ignore parse errors */ }
      });
    });

    // PR3a / ADD-3: server_session channel — emitted as the first frame
    // on every SSE connect. If we have a cached id and the new one
    // differs, trigger a full reload.
    source.addEventListener('server_session', (e) => {
      try {
        const data = JSON.parse(e.data);
        const newId = data && data.server_session_id;
        if (!newId) return;
        const prev = serverSessionRef.current;
        if (prev && prev !== newId) {
          // Server restarted under us — the cursor is stale. Full reload
          // is the least-surprising option; a delta-replay would require
          // a server-side cursor table we don't have.
          location.reload();
          return;
        }
        serverSessionRef.current = newId;
      } catch { /* ignore */ }
    });

    source.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };
    return () => { source.close(); setConnected(false); };
  }, []);

  return { connected };
}
