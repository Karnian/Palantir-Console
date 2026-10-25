import { useState, useEffect, useRef } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../../lib/api.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedApiPath, ownedRequestKey } from './client.js';
import { ownedLabel } from './format.js';
import {
  loadOwnedPending, saveOwnedPending, clearOwnedPending, subscribeOwnedPending,
  clearOwnedPendingTarget, ownedRequestTarget
} from './pending.js';
import {
  getOwnedIncarnation, ownedInteraction, canControlOwnedSession, canResumeOwnedSession,
  canSubmitOwnedPrompt, canInterruptOwnedSession, mergeOwnedEvents
} from './state.js';

export function useOwnedSessions(sessionId, { timers = globalThis, retryMs = 1000 } = {}) {
  const target = sessionId || 'start';
  const [snapshot, setSnapshot] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [host, setHost] = useState('loading');
  const [asOf, setAsOf] = useState(null);
  const [notice, setNotice] = useState('');
  const [nextPage, setNextPage] = useState(null);
  const [pending, setPending] = useState(() => loadOwnedPending(target).request);
  const [otherPending, setOtherPending] = useState(() => loadOwnedPending(target).others[0] || null);
  const [manualAction, setManualAction] = useState('');
  const [syncError, setSyncError] = useState(null);
  const [storageWarning, setStorageWarning] = useState(() => loadOwnedPending().warning);
  const [busy, setBusy] = useState(false);
  const [unaccepted, setUnaccepted] = useState(null);
  const lookupLock = useRef(false);
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;
  const routeEpoch = useRef(0);
  const submitLock = useRef(false);
  const sequence = useRef(0);
  const lastDraw = useRef(null);
  const reload = useRef(() => {});
  const recoverHttp = useRef(() => {});
  const latestSnapshot = useRef(null);
  const dataGeneration = useRef(0);
  const deleted = useRef(false);
  const deletedLookups = useRef(new Set());
  const definitiveSyncError = useRef(false);
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
    const stored = loadOwnedPending(target);
    setPending(stored.request);
    setOtherPending(stored.others[0] || null);
    setStorageWarning(stored.warning);
  }), [target]);

  useEffect(() => {
    const epoch = ++routeEpoch.current;
    const requestedId = sessionId;
    let source;
    let timer;
    let retryTimer;
    let syncRequest = 0;
    let disposed = false;
    let reading = false;
    let queued = false;
    let queuedResubscribe = false;
    const current = () => !disposed && activeSessionId.current === requestedId && routeEpoch.current === epoch;
    const markLost = () => {
      if (!current()) return;
      timers.clearTimeout(timer);
      timers.clearTimeout(retryTimer);
      syncRequest++;
      invalidateConnection();
    };
    const forgetDeletedRequest = deletedId => {
      const request = loadOwnedPending(deletedId).request;
      if (request && !deletedLookups.current.has(request.body.request_key)) {
        deletedLookups.current.add(request.body.request_key);
        // Read-only lookup is allowed while commands are locked. Scrub even if it never answers.
        try {
          void apiFetch(`${ownedApiPath()}/requests/${encodeURIComponent(request.body.request_key)}`).catch(() => {});
        } catch { /* The deletion still takes precedence over browser retention. */ }
      }
      clearOwnedPendingTarget(deletedId);
    };
    const reconcilePendingTargets = async (list, valid) => {
      const targets = loadOwnedPending().others.map(request => request.session_id).filter(id => id !== 'start');
      if (!targets.length) return;
      let inventory = list;
      if (!inventory) {
        inventory = await apiFetch(ownedApiPath());
        if (!valid()) return;
      }
      if (inventory.host !== 'running' || !Array.isArray(inventory.sessions)) return;
      for (const session of inventory.sessions) {
        if (['deleting', 'deleted'].includes(session.state)) forgetDeletedRequest(session.id);
      }
      const visible = new Set(inventory.sessions.map(session => session.id));
      for (const id of targets) {
        if (!valid()) return;
        if (visible.has(id)) continue;
        try {
          const detail = await apiFetch(ownedApiPath(id));
          if (!valid()) return;
          if (detail.host === 'running' && detail.state && (!detail.state.session
            || ['deleting', 'deleted'].includes(detail.state.session.state))) forgetDeletedRequest(id);
        } catch (error) {
          if (!valid()) return;
          if (error.status === 404) forgetDeletedRequest(id);
          // A transient failure is not evidence of deletion. Keep the request for the next synchronization.
        }
      }
    };
    const purge = (state = 'deleted') => {
      dataGeneration.current++;
      deleted.current = true;
      if (requestedId) forgetDeletedRequest(requestedId);
      const tombstone = { session: { id: requestedId, state }, current_incarnation_id: null,
        incarnations: [], deliveries: [], tool_requests: [], controls: [] };
      latestSnapshot.current = tombstone;
      setSnapshot(tombstone);
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
        if (connection.current.lost && !definitiveSyncError.current) setNotice(OWNED_COPY.reconnect);
        void refresh(false);
      });
      const resynchronize = () => {
        if (!activeStream()) return;
        markLost();
        // These frames prove that the transport is open, but its snapshot is still invalid.
        connection.current.open = true;
        if (!definitiveSyncError.current) setNotice(OWNED_COPY.reconnect);
        void refresh(true);
      };
      stream.addEventListener('reconnected', resynchronize);
      stream.addEventListener('resync', resynchronize);
      stream.addEventListener('event', frame => {
        if (!activeStream() || !connection.current.open) return;
        let event;
        try { event = JSON.parse(frame.data); } catch { return; }
        sequence.current = Math.max(sequence.current, event.seq || 0);
        const deletion = event.json?.table === 'owned_sessions' && ['deleting', 'deleted'].includes(event.json.state);
        if (deletion) {
          if (event.session_id === requestedId) purge(event.json.state);
          else if (event.session_id) forgetDeletedRequest(event.session_id);
        }
        if (!deleted.current && event.type === 'sdk_message' && event.session_id === requestedId) {
          setEvents(previous => mergeOwnedEvents(previous, [event]));
        }
        timers.clearTimeout(timer);
        timer = timers.setTimeout(() => { void refresh(false); }, 100);
      });
    };
    const refresh = async (resubscribe = false, manual = false) => {
      if (manual) {
        definitiveSyncError.current = false;
        setSyncError(null);
        setNotice(OWNED_COPY.loading);
      }
      if (definitiveSyncError.current) return;
      if (reading) {
        queued = true;
        queuedResubscribe ||= resubscribe;
        return;
      }
      if (source && !connection.current.open) return;
      reading = true;
      timers.clearTimeout(retryTimer);
      const requestId = ++syncRequest;
      const generation = connection.current.generation;
      const dataEpoch = dataGeneration.current;
      const valid = () => current() && requestId === syncRequest
        && generation === connection.current.generation && dataEpoch === dataGeneration.current;
      const synchronizationFailed = () => {
        if (!valid()) return;
        connection.current.snapshotGeneration = -1;
        connection.current.host = 'sync_failed';
        setHost('sync_failed');
        setNotice(OWNED_COPY.syncRetrying);
        retryTimer = timers.setTimeout(() => { void refresh(resubscribe); }, retryMs);
      };
      try {
        const result = await apiFetch(ownedApiPath(requestedId));
        if (!valid()) return;
        if (result.host !== 'running') {
          if (result.host === 'not_running' && !source && !connection.current.lost) {
            connection.current.host = 'not_running';
            setHost('not_running');
          } else {
            synchronizationFailed();
          }
          return;
        }
        const isDeleted = ['deleting', 'deleted'].includes(result.state?.session?.state);
        if (deleted.current && !isDeleted) return;
        if (requestedId) {
          if (isDeleted) purge(result.state.session.state);
          else {
            latestSnapshot.current = result.state;
            setSnapshot(result.state);
          }
        } else {
          setSessions(result.sessions || []);
          for (const session of result.sessions || []) {
            if (['deleting', 'deleted'].includes(session.state)) forgetDeletedRequest(session.id);
          }
        }
        await reconcilePendingTargets(requestedId ? null : result, valid);
        if (!valid()) return;
        lastDraw.current = Date.now();
        setAsOf(lastDraw.current);
        sequence.current = result.seq_high || 0;
        if (requestedId && !isDeleted && (!source || resubscribe)) {
          const page = await apiFetch(`${ownedApiPath(requestedId)}/transcript?limit=50`);
          if (!valid() || deleted.current) return;
          if (page.host !== 'running') { synchronizationFailed(); return; }
          setEvents(previous => mergeOwnedEvents(previous, page.events || []));
          setNextPage(page.next_before_seq);
        }
        if (!source || resubscribe) {
          connect();
        } else if (connection.current.open && generation === connection.current.generation) {
          connection.current.snapshotGeneration = generation;
          connection.current.host = 'running';
          setHost('running');
          setNotice(previous => [OWNED_COPY.syncRetrying, OWNED_COPY.loading].includes(previous) ? '' : previous);
        }
      } catch (error) {
        if (valid()) {
          const permanent = error.status >= 400 && error.status < 500
            || error.reason === 'snapshot_too_large' || error.message === 'snapshot_too_large';
          if (permanent) {
            definitiveSyncError.current = true;
            timers.clearTimeout(retryTimer);
            queued = false;
            queuedResubscribe = false;
            connection.current.snapshotGeneration = -1;
            connection.current.host = 'sync_failed';
            setHost('sync_failed');
            const errorCode = error.reason || error.message;
            setSyncError(errorCode);
            const message = typeof OWNED_COPY[errorCode] === 'string' ? OWNED_COPY[errorCode]
              : `${OWNED_COPY.error} (${errorCode})`;
            setNotice(message);
          } else {
            synchronizationFailed();
          }
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
    recoverHttp.current = () => {
      if (!current() || definitiveSyncError.current) return;
      connection.current.snapshotGeneration = -1;
      connection.current.host = 'sync_failed';
      setHost('sync_failed');
      setNotice(OWNED_COPY.syncRetrying);
      timers.clearTimeout(retryTimer);
      retryTimer = timers.setTimeout(() => { void refresh(false); }, retryMs);
    };
    reload.current = manual => refresh(false, manual === true);
    void refresh();
    return () => {
      disposed = true;
      routeEpoch.current++;
      connection.current.open = false;
      connection.current.generation++;
      source?.close();
      timers.clearTimeout(timer);
      timers.clearTimeout(retryTimer);
    };
  }, [sessionId, timers, retryMs]);

  const incarnation = getOwnedIncarnation(snapshot);
  const interaction = ownedInteraction(snapshot);
  const controllable = ready() && canControlOwnedSession(host, snapshot);
  const disabled = !ready() || busy || !!pending;
  const resumeReady = canResumeOwnedSession(snapshot);
  const canStart = !busy && !pending && (ready() || connection.current.host === 'not_running');
  const receipt = request => clearOwnedPending(request.body.request_key);
  const execute = async (path, body, method = 'POST', requestKey, expectedGeneration, allowQueue = false, recovery = false) => {
    const transport = connection.current;
    const sendingGeneration = transport.generation;
    if (submitLock.current || (lookupLock.current && !recovery) || !ready()) return;
    if (expectedGeneration !== undefined && transport.generation !== expectedGeneration) return;
    const requestTarget = ownedRequestTarget(path);
    if (requestTarget !== target) return;
    const existing = loadOwnedPending(requestTarget).request;
    if (existing && existing.body.request_key !== requestKey) return;
    const recovering = recovery && existing?.body.request_key === requestKey
      && existing.path === path && existing.method === method;
    if (recovery && !recovering) return;
    if (!recovering && path.endsWith('/interrupt') && !canInterruptOwnedSession(latestSnapshot.current, ready())) return;
    if (!recovering && path.endsWith('/prompt') && !canSubmitOwnedPrompt(latestSnapshot.current, ready(), allowQueue)) return;
    const request = recovering ? existing : {
      path, method, allowQueue, session_id: requestTarget, body: { ...body, request_key: requestKey || ownedRequestKey() }
    };
    setUnaccepted(null);
    submitLock.current = true;
    setBusy(true);
    setStorageWarning(saveOwnedPending(request));
    setPending(request);
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
      if (error.status >= 500 && sendingGeneration === connection.current.generation) recoverHttp.current();
      setNotice(definitive ? ownedLabel(error.reason || error.message) : OWNED_COPY.acceptanceUnknown);
    } finally {
      if (current()) setBusy(false);
      submitLock.current = false;
    }
  };
  const submit = (action, body = {}) => {
    if (disabled || !ready() || submitLock.current || lookupLock.current) return;
    if (['interrupt', 'interrupt-send'].includes(action) && !canInterruptOwnedSession(latestSnapshot.current, ready())) return;
    const allowQueue = action === 'queue-prompt';
    if (allowQueue) action = 'prompt';
    if (action === 'prompt' && !canSubmitOwnedPrompt(latestSnapshot.current, ready(), allowQueue)) return;
    const key = ownedRequestKey();
    if (action === 'interrupt-send') {
      setManualAction('interrupt');
      action = 'interrupt';
      body = {};
    }
    if (action === 'restart') {
      setManualAction('stop');
      action = 'stop';
      body = {};
    }
    if (action === 'prompt' || action === 'resume') setManualAction('');
    return execute(`${ownedApiPath(sessionId)}/${action}`, { ...body, incarnation_id: snapshot.current_incarnation_id }, 'POST', key, undefined, allowQueue);
  };
  const lookupPending = async (checkOnly) => {
    const saved = loadOwnedPending(target).request;
    if (!saved) { setPending(null); return; }
    if (!ready() || busy || lookupLock.current || submitLock.current) return;
    lookupLock.current = true;
    setBusy(true);
    setUnaccepted(null);
    const epoch = routeEpoch.current;
    const generation = connection.current.generation;
    const current = () => routeEpoch.current === epoch && ready() && connection.current.generation === generation;
    try {
      const lookup = await apiFetch(`${ownedApiPath()}/requests/${encodeURIComponent(saved.body.request_key)}`);
      if (!current()) return;
      if (lookup.host !== 'running') { recoverHttp.current(); return; }
      const result = lookup.result;
      if (result && result.found !== false && (result.state || result.session_id || result.session_deleted)) {
        receipt(saved, result);
        setPending(null);
        setNotice(ownedLabel(result.reason || result.state));
        if (saved.path.endsWith('/start') && result.session_id) location.hash = `owned/${result.session_id}`;
        else await reload.current();
      } else if (result?.found === false) {
        if (checkOnly) {
          setUnaccepted({ key: saved.body.request_key, generation });
          setNotice(OWNED_COPY.requestNotAccepted);
        } else await execute(saved.path, saved.body, saved.method, saved.body.request_key, generation, saved.allowQueue === true, true);
      } else {
        setNotice(OWNED_COPY.acceptanceUnknown);
      }
    } catch {
      if (current()) setNotice(OWNED_COPY.acceptanceUnknown);
    } finally {
      lookupLock.current = false;
      if (routeEpoch.current === epoch) setBusy(false);
    }
  };
  const retry = () => lookupPending(false);
  const checkPending = () => lookupPending(true);
  const hasUnacceptedRequest = !!pending && unaccepted?.key === pending.body.request_key;
  const canDiscardPending = ready() && !busy && !lookupLock.current && !submitLock.current
    && hasUnacceptedRequest && unaccepted.generation === connection.current.generation;
  const discardPending = async () => {
    if (!canDiscardPending || !ready() || lookupLock.current || submitLock.current) return;
    if (unaccepted.generation !== connection.current.generation) return;
    const saved = loadOwnedPending(target).request;
    if (!saved || saved.body.request_key !== unaccepted.key) return;
    const epoch = routeEpoch.current;
    const generation = connection.current.generation;
    const current = () => routeEpoch.current === epoch && ready() && connection.current.generation === generation;
    lookupLock.current = true;
    setBusy(true);
    setUnaccepted(null);
    try {
      const result = await apiFetch(`${ownedApiPath()}/requests/${encodeURIComponent(saved.body.request_key)}/abandon`, {
        method: 'POST', body: '{}'
      });
      if (result.host !== 'running' || (result.abandoned !== true && !(result.abandoned === false && result.existing))) {
        throw new Error('host_unreachable');
      }
      // Only a durable host fence or a confirmed existing request can release browser retention.
      clearOwnedPending(saved.body.request_key);
      if (!current()) return;
      setPending(null);
      setNotice(result.abandoned ? OWNED_COPY.requestDiscarded : OWNED_COPY.requestAlreadyAccepted);
      if (!result.abandoned && saved.path.endsWith('/start') && result.existing.session_id) {
        location.hash = `owned/${result.existing.session_id}`;
      } else if (!result.abandoned) await reload.current();
    } catch {
      if (current()) setNotice(OWNED_COPY.abandonUnknown);
    } finally {
      lookupLock.current = false;
      if (routeEpoch.current === epoch) setBusy(false);
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
      if (page.host !== 'running') { recoverHttp.current(); return; }
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
    return reload.current(true);
  };
  return {
    snapshot, sessions, events, host, asOf, notice, nextPage, pending, otherPending, busy, storageWarning, canStart, synchronize,
    syncError, hasUnacceptedRequest, canDiscardPending, checkPending, discardPending,
    interruptNotice: manualAction === 'interrupt' ? OWNED_COPY.interruptManual : '',
    restartNotice: manualAction === 'stop' ? OWNED_COPY.restartManual : '',
    incarnation, interaction, controllable, disabled, resumeReady, execute, submit, retry, history
  };
}
