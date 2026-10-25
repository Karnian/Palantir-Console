import { useState, useEffect, useRef } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../../lib/api.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedApiPath, ownedRequestKey } from './client.js';
import { ownedLabel } from './format.js';
import { loadOwnedPending, saveOwnedPending, clearOwnedPending, subscribeOwnedPending } from './pending.js';
import {
  getOwnedIncarnation, ownedInteraction, canControlOwnedSession, canResumeOwnedSession,
  canSubmitOwnedPrompt, mergeOwnedEvents
} from './state.js';

export function useOwnedSessions(sessionId) {
  const [snapshot, setSnapshot] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [host, setHost] = useState('loading');
  const [asOf, setAsOf] = useState(null);
  const [notice, setNotice] = useState('');
  const [nextPage, setNextPage] = useState(null);
  const [pending, setPending] = useState(() => loadOwnedPending().request);
  const [storageWarning, setStorageWarning] = useState(() => loadOwnedPending().warning);
  const [busy, setBusy] = useState(false);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  const routeEpoch = useRef(0);
  const submitLock = useRef(false);
  const sequence = useRef(0);
  const lastDraw = useRef(null);
  const followUp = useRef(null);
  const reload = useRef(() => {});
  const latestSnapshot = useRef(null);
  const dataGeneration = useRef(0);
  const deleted = useRef(false);
  const connection = useRef({ open: false, generation: 0, snapshotGeneration: -1, host: 'loading', lost: false });
  const ready = () => {
    const current = connection.current;
    return !deleted.current && current.open && current.host === 'running' && current.snapshotGeneration === current.generation;
  };

  const invalidateConnection = () => {
    connection.current.generation++;
    connection.current.open = false;
    connection.current.snapshotGeneration = -1;
    connection.current.host = 'unreachable';
    connection.current.lost = true;
    setHost('unreachable');
    setAsOf(lastDraw.current);
  };

  useEffect(() => subscribeOwnedPending(() => {
    const stored = loadOwnedPending();
    setPending(stored.request);
    setStorageWarning(stored.warning);
  }), []);

  useEffect(() => {
    const epoch = ++routeEpoch.current;
    const requestedId = sessionId;
    let source;
    let timer;
    let disposed = false;
    let reading = false;
    let queued = false;
    let queuedResubscribe = false;
    const current = () => !disposed && activeSessionId.current === requestedId && routeEpoch.current === epoch;
    const markLost = () => {
      if (!current()) return;
      clearTimeout(timer);
      invalidateConnection();
    };
    const purge = () => {
      dataGeneration.current++;
      deleted.current = true;
      setEvents([]);
      setNextPage(null);
    };
    const connect = () => {
      source?.close();
      connection.current.open = false;
      connection.current.snapshotGeneration = -1;
      const stream = new EventSource(`${ownedApiPath()}/stream?since=${sequence.current}`);
      source = stream;
      const activeStream = () => current() && source === stream;
      stream.addEventListener('error', () => { if (activeStream()) markLost(); });
      stream.addEventListener('host_unreachable', () => { if (activeStream()) markLost(); });
      stream.addEventListener('open', () => {
        if (!activeStream()) return;
        connection.current.open = true;
        connection.current.generation++;
        connection.current.snapshotGeneration = -1;
        if (connection.current.lost) setNotice(OWNED_COPY.reconnect);
        void refresh(false);
      });
      const resynchronize = () => {
        if (!activeStream()) return;
        markLost();
        // These frames prove that the transport is open, but its snapshot is still invalid.
        connection.current.open = true;
        setNotice(OWNED_COPY.reconnect);
        void refresh(true);
      };
      stream.addEventListener('reconnected', resynchronize);
      stream.addEventListener('resync', resynchronize);
      stream.addEventListener('event', frame => {
        if (!activeStream() || !connection.current.open) return;
        let event;
        try { event = JSON.parse(frame.data); } catch { return; }
        sequence.current = Math.max(sequence.current, event.seq || 0);
        const deletion = event.session_id === requestedId && event.json?.table === 'owned_sessions'
          && ['deleting', 'deleted'].includes(event.json.state);
        if (deletion) purge();
        if (!deleted.current && event.type === 'sdk_message' && event.session_id === requestedId) {
          setEvents(previous => mergeOwnedEvents(previous, [event]));
        }
        clearTimeout(timer);
        timer = setTimeout(() => { void refresh(false); }, 100);
      });
    };
    const refresh = async (resubscribe = false) => {
      if (reading) {
        queued = true;
        queuedResubscribe ||= resubscribe;
        return;
      }
      if (source && !connection.current.open) return;
      reading = true;
      const generation = connection.current.generation;
      const dataEpoch = dataGeneration.current;
      const valid = () => current() && generation === connection.current.generation && dataEpoch === dataGeneration.current;
      try {
        const result = await apiFetch(ownedApiPath(requestedId));
        if (!valid()) return;
        if (result.host !== 'running') {
          if (result.host === 'not_running' && !source && !connection.current.lost) {
            connection.current.host = 'not_running';
            setHost('not_running');
          } else {
            markLost();
          }
          return;
        }
        const isDeleted = ['deleting', 'deleted'].includes(result.state?.session?.state);
        if (deleted.current && !isDeleted) return;
        if (requestedId) {
          latestSnapshot.current = result.state;
          setSnapshot(result.state);
          if (isDeleted && !deleted.current) purge();
        } else {
          setSessions(result.sessions || []);
        }
        lastDraw.current = Date.now();
        setAsOf(lastDraw.current);
        sequence.current = result.seq_high || 0;
        if (requestedId && !isDeleted && (!source || resubscribe)) {
          const page = await apiFetch(`${ownedApiPath(requestedId)}/transcript?limit=50`);
          if (!valid() || deleted.current) return;
          if (page.host !== 'running') { markLost(); return; }
          setEvents(previous => mergeOwnedEvents(previous, page.events || []));
          setNextPage(page.next_before_seq);
        }
        if (!source || resubscribe) {
          connect();
        } else if (connection.current.open && generation === connection.current.generation) {
          connection.current.snapshotGeneration = generation;
          connection.current.host = 'running';
          setHost('running');
        }
      } catch (error) {
        if (current()) {
          setNotice(ownedLabel(error.reason || error.message));
          markLost();
        }
      } finally {
        reading = false;
        if (queued && current()) {
          const replaceStream = queuedResubscribe;
          queued = false;
          queuedResubscribe = false;
          void refresh(replaceStream);
        }
      }
    };
    reload.current = () => refresh(false);
    void refresh();
    return () => {
      disposed = true;
      routeEpoch.current++;
      connection.current.open = false;
      connection.current.generation++;
      source?.close();
      clearTimeout(timer);
    };
  }, [sessionId]);

  const incarnation = getOwnedIncarnation(snapshot);
  const interaction = ownedInteraction(snapshot);
  const controllable = ready() && canControlOwnedSession(host, snapshot);
  const disabled = !ready() || busy || !!pending;
  const resumeReady = canResumeOwnedSession(snapshot);
  const canStart = !busy && !pending && (ready() || connection.current.host === 'not_running');
  const receipt = (request, result) => {
    clearOwnedPending(request.body.request_key);
    const waiting = followUp.current;
    if (waiting?.key === request.body.request_key && result?.id) waiting.deliveryId = result.id;
  };
  const execute = async (path, body, method = 'POST', requestKey, expectedGeneration, allowQueue = false) => {
    const transport = connection.current;
    const sendingGeneration = transport.generation;
    if (submitLock.current || !ready()) return;
    if (expectedGeneration !== undefined && transport.generation !== expectedGeneration) return;
    const existing = loadOwnedPending().request;
    if (existing && existing.body.request_key !== requestKey) return;
    if (path.endsWith('/prompt') && !canSubmitOwnedPrompt(latestSnapshot.current, ready(), allowQueue)) return;
    const request = { path, method, allowQueue, body: { ...body, request_key: requestKey || ownedRequestKey() } };
    setStorageWarning(saveOwnedPending(request));
    setPending(request);
    submitLock.current = true;
    setBusy(true);
    const epoch = routeEpoch.current;
    const requestedId = sessionId;
    const current = () => activeSessionId.current === requestedId && routeEpoch.current === epoch;
    try {
      // No await separates the latest transport check and the POST.
      if (!ready() || sendingGeneration !== connection.current.generation) return;
      const response = await apiFetch(path, { method, body: JSON.stringify(request.body) });
      if (response.acceptance !== 'acceptance_unknown') receipt(request, response.result);
      if (!current()) return;
      if (response.acceptance === 'acceptance_unknown') {
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
      const definitive = error.status && error.status < 500;
      if (definitive) clearOwnedPending(request.body.request_key);
      if (!current()) return;
      if (definitive) setPending(null);
      if (error.status >= 500) invalidateConnection();
      setNotice(definitive ? ownedLabel(error.reason || error.message) : OWNED_COPY.acceptanceUnknown);
    } finally {
      if (current()) setBusy(false);
      submitLock.current = false;
    }
  };
  const submit = (action, body = {}) => {
    if (disabled || !ready()) return;
    if (action === 'interrupt-send' && !canSubmitOwnedPrompt(latestSnapshot.current, ready(), true)) return;
    const allowQueue = action === 'queue-prompt';
    if (allowQueue) action = 'prompt';
    if (action === 'prompt' && !canSubmitOwnedPrompt(latestSnapshot.current, ready(), allowQueue)) return;
    const key = ownedRequestKey();
    if (action === 'interrupt-send') {
      followUp.current = { kind: 'prompt', body, incarnation: incarnation?.id, key };
      action = 'interrupt';
    }
    if (action === 'restart') {
      followUp.current = { kind: 'resume', incarnation: incarnation?.id, key };
      action = 'stop';
    }
    return execute(`${ownedApiPath(sessionId)}/${action}`, { ...body, incarnation_id: snapshot.current_incarnation_id }, 'POST', key, undefined, allowQueue);
  };
  useEffect(() => {
    const waiting = followUp.current;
    if (!waiting || disabled || waiting.incarnation !== incarnation?.id) return;
    if (waiting.kind === 'prompt') {
      const completed = (snapshot.deliveries || []).some(delivery => (
        (waiting.deliveryId ? delivery.id === waiting.deliveryId : delivery.request_key === waiting.key)
        && delivery.kind === 'interrupt' && delivery.incarnation_id === incarnation.id && delivery.state === 'completed'
      ));
      if (completed && canSubmitOwnedPrompt(snapshot, ready())) {
        followUp.current = null;
        submit('prompt', waiting.body);
      }
    } else if ((snapshot.controls || []).some(control => (
      control.request_key === waiting.key && control.kind === 'stop'
      && control.incarnation_id === incarnation.id && control.state === 'done'
    ))) {
      followUp.current = null;
      submit('resume');
    }
  }, [snapshot, disabled]);

  const retry = async () => {
    const saved = loadOwnedPending().request;
    if (!saved) { setPending(null); return; }
    if (!ready() || busy) return;
    const epoch = routeEpoch.current;
    const generation = connection.current.generation;
    const current = () => routeEpoch.current === epoch && ready() && connection.current.generation === generation;
    try {
      const lookup = await apiFetch(`${ownedApiPath()}/requests/${encodeURIComponent(saved.body.request_key)}`);
      if (!current()) return;
      if (lookup.host !== 'running') { invalidateConnection(); return; }
      const result = lookup.result;
      if (result && result.found !== false && (result.state || result.session_id || result.session_deleted)) {
        receipt(saved, result);
        setPending(null);
        setNotice(ownedLabel(result.reason || result.state));
        if (saved.path.endsWith('/start') && result.session_id) location.hash = `owned/${result.session_id}`;
        else await reload.current();
      } else {
        await execute(saved.path, saved.body, saved.method, saved.body.request_key, generation, saved.allowQueue === true);
      }
    } catch {
      if (current()) setNotice(OWNED_COPY.acceptanceUnknown);
    }
  };
  const history = async () => {
    if (!ready() || deleted.current) return;
    const epoch = routeEpoch.current;
    const generation = connection.current.generation;
    const dataEpoch = dataGeneration.current;
    const valid = () => routeEpoch.current === epoch && ready() && generation === connection.current.generation
      && dataEpoch === dataGeneration.current && !deleted.current;
    setBusy(true);
    try {
      const page = await apiFetch(`${ownedApiPath(sessionId)}/transcript?before_seq=${nextPage}&limit=50`);
      if (!valid()) return;
      if (page.host !== 'running') { invalidateConnection(); return; }
      setEvents(previous => mergeOwnedEvents(page.events || [], previous));
      setNextPage(page.next_before_seq);
    } catch {
      if (valid()) setNotice(OWNED_COPY.error);
    } finally {
      if (routeEpoch.current === epoch) setBusy(false);
    }
  };
  const synchronize = () => {
    if (connection.current.host === 'not_running') {
      connection.current.host = 'loading';
      setHost('loading');
    }
    return reload.current();
  };
  return {
    snapshot, sessions, events, host, asOf, notice, nextPage, pending, busy, storageWarning, canStart, synchronize,
    incarnation, interaction, controllable, disabled, resumeReady, execute, submit, retry, history
  };
}
