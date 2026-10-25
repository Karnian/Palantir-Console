import { useState, useEffect, useRef } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../../lib/api.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedApiPath, ownedRequestKey } from './client.js';
import { ownedLabel } from './format.js';
import { getOwnedIncarnation, ownedInteraction, canControlOwnedSession, canResumeOwnedSession, mergeOwnedEvents } from './state.js';

// Owns the dedicated SSE subscription and request identity fences for this route.
export function useOwnedSessions(sessionId) {
  const [snapshot, setSnapshot] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [host, setHost] = useState('loading');
  const [asOf, setAsOf] = useState(null);
  const [notice, setNotice] = useState('');
  const [nextPage, setNextPage] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  const routeEpoch = useRef(0);
  const submitLock = useRef(false);
  const sequence = useRef(0);
  const lastDraw = useRef(null);
  const followUp = useRef(null);
  const reload = useRef(() => {});

  useEffect(() => {
    const requestEpoch = ++routeEpoch.current;
    const requestedSessionId = sessionId;
    let source;
    let debounceTimer;
    let disposed = false;
    let reading = false;
    let refreshQueued = false;
    let lossGeneration = 0;
    let networkLost = false;
    const isCurrent = () => (
      !disposed && activeSessionId.current === requestedSessionId && routeEpoch.current === requestEpoch
    );
    const mergeEvents = incoming => setEvents(previous => mergeOwnedEvents(previous, incoming));
    const connect = () => {
      source?.close();
      source = new EventSource(`${ownedApiPath()}/stream?since=${sequence.current}`);
      const markLost = () => {
        if (!isCurrent()) return;
        lossGeneration++;
        setHost('unreachable');
        setAsOf(lastDraw.current);
      };
      source.addEventListener('host_unreachable', markLost);
      source.addEventListener('error', () => {
        networkLost = true;
        markLost();
      });
      source.addEventListener('open', () => {
        if (!isCurrent() || !networkLost) return;
        networkLost = false;
        setNotice(OWNED_COPY.reconnect);
        void refresh(true);
      });
      source.addEventListener('reconnected', () => {
        if (!isCurrent()) return;
        setNotice(OWNED_COPY.reconnect);
        void refresh(true);
      });
      source.addEventListener('resync', () => {
        if (isCurrent()) void refresh(true);
      });
      source.addEventListener('event', frame => {
        if (!isCurrent()) return;
        let event;
        try {
          event = JSON.parse(frame.data);
        } catch {
          return;
        }
        sequence.current = Math.max(sequence.current, event.seq || 0);
        if (event.type === 'sdk_message' && event.session_id === requestedSessionId) mergeEvents([event]);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void refresh(false);
        }, 100);
      });
    };
    const refresh = async (resubscribe = false) => {
      if (reading) {
        refreshQueued = true;
        return;
      }
      reading = true;
      const generation = lossGeneration;
      try {
        const result = await apiFetch(ownedApiPath(requestedSessionId));
        if (!isCurrent() || generation !== lossGeneration) return;
        if (result.host !== 'running') {
          setHost(result.host);
          if (result.host === 'unreachable') setAsOf(lastDraw.current);
          return;
        }
        if (requestedSessionId) {
          setSnapshot(result.state);
          if (['deleting', 'deleted'].includes(result.state?.session?.state)) {
            setEvents([]);
            setNextPage(null);
          }
        } else {
          setSessions(result.sessions || []);
        }
        setHost('running');
        lastDraw.current = Date.now();
        setAsOf(lastDraw.current);
        sequence.current = result.seq_high || 0;
        if (requestedSessionId && (!source || resubscribe)) {
          const page = await apiFetch(`${ownedApiPath(requestedSessionId)}/transcript?limit=50`);
          if (!isCurrent() || generation !== lossGeneration) return;
          if (page.host === 'unreachable') {
            setHost('unreachable');
            return;
          }
          mergeEvents(page.events || []);
          setNextPage(page.next_before_seq);
        }
        if (!source || resubscribe) connect();
      } catch (error) {
        if (isCurrent()) {
          setNotice(ownedLabel(error.reason || error.message));
          setHost('unreachable');
          setAsOf(lastDraw.current);
        }
      } finally {
        reading = false;
        if (refreshQueued && isCurrent()) {
          refreshQueued = false;
          void refresh(true);
        }
      }
    };
    reload.current = () => refresh(false);
    void refresh();
    return () => {
      disposed = true;
      routeEpoch.current++;
      source?.close();
      clearTimeout(debounceTimer);
    };
  }, [sessionId]);

  const incarnation = getOwnedIncarnation(snapshot);
  const interaction = ownedInteraction(snapshot);
  const controllable = canControlOwnedSession(host, snapshot);
  const disabled = host !== 'running' || busy || !!pending;
  const resumeReady = canResumeOwnedSession(snapshot);

  const execute = async (path, body, method = 'POST', requestKey) => {
    if (submitLock.current || host === 'unreachable') return;
    submitLock.current = true;
    setBusy(true);
    const requestedSessionId = sessionId;
    const requestEpoch = routeEpoch.current;
    const isCurrent = () => activeSessionId.current === requestedSessionId && routeEpoch.current === requestEpoch;
    const request = { path, method, body: { ...body, request_key: requestKey || ownedRequestKey() } };
    try {
      const response = await apiFetch(path, { method, body: JSON.stringify(request.body) });
      if (!isCurrent()) return;
      if (response.acceptance === 'acceptance_unknown') {
        setPending(request);
        setNotice(OWNED_COPY.acceptanceUnknown);
      } else {
        setPending(null);
        const result = response.result || {};
        setNotice(ownedLabel(response.code || result.reason || result.stage || result.state));
        if (path === `${ownedApiPath()}/start` && result.session_id) {
          location.hash = `owned/${result.session_id}`;
          return;
        }
        await reload.current();
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (!error.status) {
        setPending(request);
        setNotice(OWNED_COPY.acceptanceUnknown);
      } else {
        setNotice(ownedLabel(error.reason || error.message));
      }
    } finally {
      if (isCurrent()) setBusy(false);
      submitLock.current = false;
    }
  };
  const submit = (action, body = {}) => {
    if (disabled) return;
    const requestKey = ownedRequestKey();
    if (action === 'interrupt-send') {
      followUp.current = { kind: 'prompt', body, incarnation: incarnation?.id, key: requestKey };
      action = 'interrupt';
    }
    if (action === 'restart') {
      followUp.current = { kind: 'resume', incarnation: incarnation?.id, key: requestKey };
      action = 'stop';
    }
    const request = { ...body, incarnation_id: snapshot.current_incarnation_id };
    return execute(`${ownedApiPath(sessionId)}/${action}`, request, 'POST', requestKey);
  };
  useEffect(() => {
    const waiting = followUp.current;
    if (!waiting || disabled || waiting.incarnation !== incarnation?.id) return;
    if (waiting.kind === 'prompt') {
      const interruptDone = (snapshot.deliveries || []).some(delivery => (
        delivery.request_key === waiting.key && delivery.kind === 'interrupt'
        && delivery.incarnation_id === incarnation.id && delivery.state === 'completed'
      ));
      if (interruptDone && interaction === 'idle' && !incarnation.attribution_uncertain) {
        followUp.current = null;
        submit('prompt', waiting.body);
      }
    } else {
      const stopDone = (snapshot.controls || []).some(control => (
        control.request_key === waiting.key && control.kind === 'stop'
        && control.incarnation_id === incarnation.id && control.state === 'done'
      ));
      if (stopDone) {
        followUp.current = null;
        submit('resume');
      }
    }
  }, [snapshot, disabled]);

  const retry = async () => {
    if (!pending || host !== 'running' || busy) return;
    const savedRequest = pending;
    const requestedSessionId = sessionId;
    const requestEpoch = routeEpoch.current;
    const isCurrent = () => activeSessionId.current === requestedSessionId && routeEpoch.current === requestEpoch;
    try {
      const lookup = await apiFetch(`${ownedApiPath()}/requests/${encodeURIComponent(savedRequest.body.request_key)}`);
      if (!isCurrent()) return;
      if (lookup.host !== 'running') {
        setHost('unreachable');
        return;
      }
      // Lookup is informational; identical replay is safe even when the receipt exists.
      await execute(savedRequest.path, savedRequest.body, savedRequest.method, savedRequest.body.request_key);
    } catch {
      if (isCurrent()) setNotice(OWNED_COPY.acceptanceUnknown);
    }
  };
  const history = async () => {
    const requestedSessionId = sessionId;
    const requestEpoch = routeEpoch.current;
    const isCurrent = () => activeSessionId.current === requestedSessionId && routeEpoch.current === requestEpoch;
    setBusy(true);
    try {
      const page = await apiFetch(`${ownedApiPath(requestedSessionId)}/transcript?before_seq=${nextPage}&limit=50`);
      if (!isCurrent()) return;
      if (page.host !== 'running') {
        setHost('unreachable');
        return;
      }
      setEvents(previous => mergeOwnedEvents(page.events || [], previous));
      setNextPage(page.next_before_seq);
    } catch {
      if (isCurrent()) setNotice(OWNED_COPY.error);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return {
    snapshot, sessions, events, host, asOf, notice, nextPage, pending, busy,
    incarnation, interaction, controllable, disabled, resumeReady, execute, submit, retry, history
  };
}
