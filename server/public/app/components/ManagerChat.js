// ManagerChat — Left chat panel of the Manager view.
// Extracted from ManagerView.js as part of P8-5.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useMemo, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { useConversation } from '../lib/hooks.js';
import { renderMarkdown } from '../lib/markdown.js';
import { timeAgo } from '../lib/format.js';
import { Dropdown } from './Dropdown.js';
import { EmptyState } from './EmptyState.js';
import {
  COMMON_ACTIONS,
  MANAGER_LABELS,
  MANAGER_STATUS_LABELS,
  MANAGER_CHAT_AUX,
  RUN_STATUS_LABELS,
  statusLabel,
} from '../lib/copy.js';
import { MentionInput } from './MentionInput.js';
import { RunInspector } from './RunInspector.js';
import { operatorConversationId, parseProjectConversationId, conversationIdMatchesProject } from '../lib/conversationId.js';

// PR5: profile types that can back a manager session. Must stay in sync
// with PROFILE_TYPE_TO_ADAPTER in server/routes/manager.js.
const MANAGER_PROFILE_TYPES = ['claude-code', 'codex'];
const MANAGER_PROFILE_PICK_KEY = 'palantir.manager.lastProfileId';

// 3-state auth classification for the manager picker.
//
// Why 3 states: the picker must distinguish "user needs to add credentials"
// from "server didn't tell us anything" — both previously rendered as
// "no credentials", which misled users into the wrong remediation after a
// server restart / version mismatch (see bugfix branch
// fix/manager-picker-undefined-auth). Non-manager profiles have auth:null
// by server contract but are filtered out of managerProfiles before this
// helper sees them, so null/undefined here always means the server did not
// attach a preflight (stale build, failed fetch, etc.).
//
//   ok      — server preflight says canAuth:true
//   missing — server preflight says canAuth:false (user must add creds)
//   unknown — server did not provide an auth field (outdated server?)
export function managerProfileAuthState(profile) {
  if (!profile) return 'none';
  if (profile.auth == null) return 'unknown';
  return profile.auth.canAuth ? 'ok' : 'missing';
}

// R2-C.2: Suggested actions icon set — reuses AttentionStrip's glyph
// vocabulary so a user seeing "⏸" in the nav badge, the AttentionStrip,
// AND the SuggestedActions row recognises the same affordance across
// all three surfaces. status/failure glyphs are fixed across the UI.
const SUGGESTED_ICON = {
  respond: '⏸', // ⏸ — needs_input
  retry:   '✗', // ✗ — failed
  summary: '◉', // ◉ — running/active idle query
  new:     '✦', // ✦ — new work
};

export function ManagerChat({ manager, projects, runs = [], tasks = [], agents = [], agentsError = null, agentsLoading = false, reloadAgents, driftAudit, onOpenDrift, conversationTarget: externalTarget, onConversationChange }) {
  const { status, events: topEvents, loading, start, sendMessage: topSendMessage, stop, checkStatus } = manager;
  const [input, setInput] = useState('');
  // R2-C.2: local RunInspector state so clicking a SuggestedActions chip
  // opens the same slide-over used by AttentionStrip / SessionGrid /
  // DashboardView. Kept local (not lifted to ManagerView) because the
  // inspector is only triggered from this panel's suggestion strip —
  // SessionGrid still owns its own inspector for the right-hand grid.
  const [inspectRun, setInspectRun] = useState(null);

  // v3 Phase 6 — conversation target selector.
  //
  // The chat panel can now point at the Top manager OR a project-scoped
  // PM conversation (`pm:<projectId>`). When lifted to ManagerView,
  // externalTarget / onConversationChange props are used. Otherwise
  // falls back to local state for backwards compat.
  const [localTarget, setLocalTarget] = useState('top');
  const conversationTarget = externalTarget !== undefined ? externalTarget : localTarget;
  const setConversationTarget = onConversationChange || setLocalTarget;
  const pmConversationId = conversationTarget !== 'top' ? conversationTarget : null;
  const pmConv = useConversation(pmConversationId); // null-safe in hook
  const isPm = conversationTarget !== 'top';
  const pmProjectId = isPm ? (parseProjectConversationId(conversationTarget)?.projectId ?? null) : null;
  const pmProject = isPm ? (projects || []).find(p => p.id === pmProjectId) || null : null;

  // Unified event source + send path + run + active flag. The PM hook
  // mirrors the Top hook's shape (events, run, sendMessage), so the
  // downstream rendering code doesn't have to branch per target beyond
  // these aliases.
  const events = isPm ? (pmConv.events || []) : topEvents;
  const sendMessage = isPm
    ? (async (text, images, opts) => pmConv.sendMessage(text, images, opts)) // A2a: forward per-turn opts (codebaseProjectId/turnMode); selector lands in A2b
    : topSendMessage;
  // A PM conversation is "active" when its backing run exists and is
  // running. The Top session uses status.active (legacy).
  const pmRunActive = isPm && pmConv.run && pmConv.run.status === 'running';
  const chatActive = isPm ? pmRunActive : status.active;
  // Badge label for the header. Phase K-1a: every PM run state walks
  // through `RUN_STATUS_LABELS` so transient states (queued /
  // needs_input / stopped / cancelled) all surface in Korean, matching
  // the SessionGrid PM row labels. The Top session uses a binary
  // active/idle from `MANAGER_STATUS_LABELS` (Phase Token-Cleanup unified).
  const chatBadge = isPm
    ? (pmConv.run
        ? statusLabel(RUN_STATUS_LABELS, pmConv.run.status)
        : MANAGER_STATUS_LABELS.idle)
    : (status.active ? MANAGER_STATUS_LABELS.active : MANAGER_STATUS_LABELS.idle);
  const chatBadgeClass = isPm
    ? (pmRunActive ? 'running' : 'idle')
    : (status.active ? 'running' : 'idle');

  // PR5: agent profile picker state. null = no selection yet; '' = nothing
  // available. We persist the last chosen id in localStorage so repeat
  // sessions don't force the user to re-pick.
  const managerProfiles = useMemo(
    () => (agents || []).filter(a => MANAGER_PROFILE_TYPES.includes(a.type)),
    [agents]
  );
  const [selectedProfileId, setSelectedProfileId] = useState(() => {
    try { return localStorage.getItem(MANAGER_PROFILE_PICK_KEY) || ''; } catch { return ''; }
  });
  // When the profile list first loads, make sure the remembered id still
  // exists; otherwise fall back to the first auth-capable profile.
  useEffect(() => {
    if (managerProfiles.length === 0) return;
    const exists = managerProfiles.some(p => p.id === selectedProfileId);
    if (exists) return;
    const firstOk = managerProfiles.find(p => managerProfileAuthState(p) === 'ok');
    const fallback = firstOk || managerProfiles[0];
    setSelectedProfileId(fallback ? fallback.id : '');
  }, [managerProfiles, selectedProfileId]);
  const [sending, setSending] = useState(false);
  // Codex R1 MINOR #3: in-flight ref for SuggestedActions rapid-click guard.
  // The useState-backed `sending` is captured per-render, so two quick
  // chip clicks inside one render cycle both see `sending === false` and
  // both schedule rAF submits. The ref flips synchronously so the second
  // click bails before even scheduling the rAF.
  const submittingRef = useRef(false);
  const [attachedImages, setAttachedImages] = useState([]);
  const messagesRef = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  // Refocus chat input when conversation target changes (e.g. PM picker)
  // and pre-warm PM session so first message doesn't pay lazy spawn cost.
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
    if (isPm && pmProjectId && status.active) {
      apiFetch(`/api/manager/pm/${encodeURIComponent(pmProjectId)}/warm`, { method: 'POST' })
        .catch(() => {}); // best-effort, no toast on failure
    }
  }, [conversationTarget]);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [events]);

  // Read file as base64
  const readFileAsBase64 = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result.split(',')[1];
        resolve({ data: base64, media_type: file.type, name: file.name, preview: reader.result });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const addImages = async (files) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;
    const newImages = await Promise.all(imageFiles.map(readFileAsBase64));
    setAttachedImages(prev => [...prev, ...newImages]);
  };

  const removeImage = (idx) => {
    setAttachedImages(prev => prev.filter((_, i) => i !== idx));
  };

  // Handle paste with images
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  };

  // Handle drag & drop
  const [dragOver, setDragOver] = useState(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files) addImages(e.dataTransfer.files);
  };

  // Parse events into displayable messages.
  // PR1c: prefer normalized adapter events (mgr.assistant_message). Each
  // normalized event is paired with the adjacent legacy assistant_text that
  // came from the same vendor turn. Pairing is 1:1 and identified by exact
  // text match within a small id-window, so a same-prefix collision in a
  // different turn never drops a real message. user_input + error are not
  // dual-emitted and pass through unchanged.
  const messages = useMemo(() => {
    const out = [];

    // Index legacy assistant_text events by their full text, in arrival order.
    // We'll pop one entry per match so each legacy row can only be paired once.
    // Note: normalized (claudeAdapter) trims whitespace while legacy
    // (streamJsonEngine) does not. Key on the trimmed form so leading/trailing
    // whitespace doesn't defeat dedupe and cause the same message to render twice.
    const legacyByText = new Map(); // trimmedText -> array of { id, idx } in event order
    events.forEach((e, idx) => {
      if (e.event_type !== 'assistant_text') return;
      let p = {};
      try { p = JSON.parse(e.payload_json || '{}'); } catch { return; }
      const text = (p.text || p.result || '').trim();
      if (!text) return;
      if (!legacyByText.has(text)) legacyByText.set(text, []);
      legacyByText.get(text).push({ id: e.id, idx });
    });

    // First pass: emit normalized assistant messages and consume one matching
    // legacy row per emission so it won't be re-emitted in the fallback pass.
    const consumedLegacyIds = new Set();
    for (const e of events) {
      if (e.event_type !== 'mgr.assistant_message') continue;
      let p = {};
      try { p = JSON.parse(e.payload_json || '{}'); } catch { continue; }
      const rawText = (p.data && p.data.text) || p.summaryText || '';
      const text = rawText.trim();
      if (!text) continue;
      // Pair with the nearest unconsumed legacy assistant_text whose full text
      // matches and whose event id is close to ours (PR1b emits both within
      // the same vendor message handler — they land adjacent).
      const candidates = legacyByText.get(text);
      if (candidates) {
        let pickedIdx = -1;
        let bestDelta = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          if (consumedLegacyIds.has(c.id)) continue;
          const delta = Math.abs(c.id - e.id);
          // 8 row window: dual emit produces ids 1-2 apart; allow slack for
          // interleaved tool_use rows.
          if (delta <= 8 && delta < bestDelta) {
            bestDelta = delta;
            pickedIdx = i;
          }
        }
        if (pickedIdx >= 0) consumedLegacyIds.add(candidates[pickedIdx].id);
      }
      out.push({
        id: e.id,
        type: 'assistant_text',
        text,
        time: e.created_at,
        source: 'normalized',
      });
    }

    // Second pass: surface non-dual events (user_input, error) and any legacy
    // assistant_text that did NOT get paired with a normalized counterpart
    // (Manager runs that started before PR1b dual-emit shipped).
    for (const e of events) {
      const t = e.event_type;
      if (t === 'assistant_text') {
        if (consumedLegacyIds.has(e.id)) continue;
        let p = {};
        try { p = JSON.parse(e.payload_json || '{}'); } catch { continue; }
        const text = p.text || p.result || '';
        if (!text) continue;
        out.push({ id: e.id, type: 'assistant_text', text, time: e.created_at, source: 'legacy' });
      } else if (t === 'user_input' || t === 'error') {
        let p = {};
        try { p = JSON.parse(e.payload_json || '{}'); } catch { continue; }
        const text = p.text || p.result || p.message || '';
        if (!text) continue;
        out.push({ id: e.id, type: t, text, time: e.created_at, source: 'legacy' });
      }
    }

    // Stable order: by event id (server-assigned monotonic).
    out.sort((a, b) => (a.id || 0) - (b.id || 0));
    return out;
  }, [events]);

  // R2-C.2: SuggestedActions — context-aware chip row above ChatInput.
  //
  // Data source: the same `runs` prop the rest of the app already polls —
  // we deliberately don't call GET /api/manager/summary here. Reasons:
  //   (a) runs already streams via SSE + is debounced-reloaded, so the
  //       chip list updates in near-real-time without adding a second
  //       fetch loop.
  //   (b) The summary endpoint is the right tool for *dashboard* widgets
  //       (fixed aggregate shape, usable by multiple consumers). This UI
  //       specifically needs the underlying run rows (run.agent_name,
  //       task title) to build the action label — the aggregate wouldn't
  //       give us that.
  //
  // Rules (spec §11.2 table):
  //   needs_input > 0  →  [Agent-X 에게 응답]   (or "N 명에게 응답")
  //   failed > 0       →  [Agent-Y 재시도]       (same count rule)
  //   both idle        →  [상태 요약] [새 작업 시작]
  //   (no runs)        →  [새 작업 시작]
  //
  // Manager runs (is_manager=1) are excluded at the source so Top/PM
  // sessions never appear as a SuggestedAction — aligned with the
  // AttentionStrip filter and GET /api/manager/summary aggregation.
  const suggestedActions = useMemo(() => {
    if (!status.active) return []; // session-idle flow owns the start button
    const workerRuns = (runs || []).filter(r => !r.is_manager);
    const needsInputRuns = workerRuns.filter(r => r.status === 'needs_input');
    const failedRuns = workerRuns.filter(r => r.status === 'failed');
    const runningCount = workerRuns.filter(r => r.status === 'running').length;
    const taskMap = new Map((tasks || []).map(t => [t.id, t]));

    // Resolve a human label for a run. Codex R2 MINOR #2: for the
    // respond/retry chips, agent identity reads more naturally than
    // task title — "Smoke Agent 에게 응답" not "Fix the widget 에게 응답".
    // Agent name first, then task title as fallback, then short run id.
    const labelFor = (run) => {
      if (run.agent_name) return run.agent_name;
      const task = run.task_id ? taskMap.get(run.task_id) : null;
      if (task && task.title) return task.title;
      return `Run ${String(run.id || '').slice(0, 6)}`;
    };

    // Codex R1 MINOR #2: multi-run label must match multi-run behavior.
    // Clicking a chip opens ONE inspector (action.runs[0]) — if we say
    // "3명에게 응답" users expect bulk handling, which we don't do. So
    // disambiguate the label: show the head name + a "(외 N명)" suffix
    // so it's visually clear this chip opens the first item first and
    // there are more queued below (visible in AttentionStrip / SessionGrid
    // for follow-up action).
    const actions = [];
    if (needsInputRuns.length > 0) {
      const head = labelFor(needsInputRuns[0]);
      const rest = needsInputRuns.length - 1;
      const label = rest === 0
        ? `${head} 에게 응답`
        : `${head} 에게 응답 (외 ${rest}명)`;
      actions.push({
        kind: 'respond',
        icon: SUGGESTED_ICON.respond,
        label,
        runs: needsInputRuns,
      });
    }
    if (failedRuns.length > 0) {
      const head = labelFor(failedRuns[0]);
      const rest = failedRuns.length - 1;
      const label = rest === 0
        ? `${head} 재시도`
        : `${head} 재시도 (외 ${rest}개)`;
      actions.push({
        kind: 'retry',
        icon: SUGGESTED_ICON.retry,
        label,
        runs: failedRuns,
      });
    }
    // Idle suggestions only when literally nothing needs attention AND
    // nothing is running (§11.2 "모두 idle" rule). A running worker isn't
    // interruptible suggestion-wise — the user should wait or open the
    // RunInspector manually.
    //
    // Codex R1 MINOR #1: distinguish "no runs yet" from "all idle". When
    // workerRuns.length === 0 the user has literally nothing to summarize,
    // so "상태 요약" is misleading — drop it and leave only "새 작업 시작".
    // The full idle pair only makes sense when prior runs exist.
    const allIdle = needsInputRuns.length === 0 && failedRuns.length === 0 && runningCount === 0;
    if (allIdle) {
      if (workerRuns.length > 0) {
        // There IS history (completed/cancelled/stopped workers) — offer
        // both the summary-of-what-happened chip AND the new-task chip.
        actions.push({
          kind: 'summary',
          icon: SUGGESTED_ICON.summary,
          label: '상태 요약',
        });
      }
      actions.push({
        kind: 'new',
        icon: SUGGESTED_ICON.new,
        label: '새 작업 시작',
      });
    }
    return actions;
    // Depending on status.active so the strip disappears when the session
    // stops. `runs` identity changes on every SSE reload — the useMemo
    // still pays for itself because the result is consumed across mount
    // + render for each chip.
  }, [status.active, runs, tasks]);

  // R2-C.2: suggestion chip click handlers.
  //   respond/retry  →  open RunInspector (user picks up the conversation
  //                     or kicks off a manual retry from inside the
  //                     inspector; no backend retry endpoint exists yet)
  //   summary        →  auto-insert "status" and submit — the Manager's
  //                     system prompt already knows how to answer that
  //   new            →  focus the input box and drop a placeholder hint
  const handleSuggestedAction = (action) => {
    if (!action) return;
    if (action.kind === 'respond' || action.kind === 'retry') {
      const target = action.runs && action.runs[0];
      if (target) setInspectRun(target);
      return;
    }
    if (action.kind === 'summary') {
      // Codex R1 MINOR #3 + R2 MINOR #1: guard against rapid double-click
      // AND cross-path duplicate submits (chip click + Enter in the same
      // frame). The ref flips synchronously to block another chip click,
      // and `setSending(true)` flips the state setter which handleSend
      // (Enter-press path) also checks via its `if (sending) return`
      // guard. Both paths read `sending` after the same setState commit.
      if (submittingRef.current || sending) return;
      submittingRef.current = true;
      setSending(true); // block Enter-path's handleSend concurrently
      setInput('status');
      // Defer submit to next frame so Preact commits the input state first
      // (handleSend reads `input` at call time).
      requestAnimationFrame(() => {
        // Use a local copy to avoid a stale closure on `input` inside
        // handleSend — it reads from state via the setState path.
        submitSuggestion('status');
      });
      return;
    }
    if (action.kind === 'new') {
      if (inputRef.current) {
        inputRef.current.focus();
        // Don't mutate input — just hint via native placeholder flicker.
        // The existing `placeholder="Message the manager..."` stays; this
        // branch only restores focus so the user can start typing.
      }
      return;
    }
  };

  // Bypass the handleSend closure-over-`input` so SuggestedActions can
  // submit an arbitrary string without racing setState. Only used for the
  // "상태 요약" chip today; factored out in case future chips want the
  // same instant-submit path.
  //
  // The caller (handleSuggestedAction) already flipped `submittingRef` +
  // `setSending(true)` so a concurrent click or Enter could not reach
  // here / handleSend twice. We reset both in finally so subsequent
  // clicks work once the send completes.
  const submitSuggestion = async (textOverride) => {
    const text = (textOverride || '').trim();
    if (!text) {
      // Roll back caller's sending-lock: nothing to send.
      submittingRef.current = false;
      setSending(false);
      return;
    }
    setInput('');
    try {
      if (conversationTarget === 'top') {
        await topSendMessage(text);
      } else {
        await apiFetch(`/api/conversations/${encodeURIComponent(conversationTarget)}/message`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
      }
    } catch (err) {
      addToast('Failed to send: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
    setSending(false);
    submittingRef.current = false;
    requestAnimationFrame(() => { if (inputRef.current) inputRef.current.focus(); });
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && attachedImages.length === 0) || sending) return;
    setSending(true);
    setInput('');
    if (inputRef.current) inputRef.current.style.height = '';
    const imagesToSend = attachedImages.map(img => ({ data: img.data, media_type: img.media_type }));
    setAttachedImages([]);

    // v3 Phase 6 — route through POST /api/router/resolve so @mention
    // rewriting and project-name matching run in exactly one place. If
    // the resolver picks a different target than the UI's current
    // selection (user typed @alpha while on Top), we honor the resolved
    // target by POSTing directly to /api/conversations/:id/message and
    // then flipping the UI selector to follow along so subsequent
    // messages stay in the same conversation.
    //
    // Codex R1 blocker #1 — fail-closed on resolver error FOR ANY
    // message that contains an explicit `@<...>` prefix. Without this
    // guard, a transient resolver failure could silently deliver
    // `@beta ...` to the currently selected `pm:alpha` → cross-project
    // misdelivery. Messages with no `@` prefix are safe to fall back
    // to the UI selection (no rewrite intent).
    const hasExplicitMention = /^\s*@\S+/.test(text || '');
    let effectiveTarget = conversationTarget;
    let effectiveText = text;
    let resolvedCodebaseProjectId = null;
    let resolvedTurnMode = null;
    let resolveFailed = false;
    try {
      if (text) {
        const resolved = await apiFetch('/api/router/resolve', {
          method: 'POST',
          body: JSON.stringify({
            text,
            currentConversationId: conversationTarget,
          }),
        });
        if (resolved && resolved.target) {
          effectiveTarget = resolved.target;
          resolvedCodebaseProjectId = resolved.codebaseProjectId || null;
          resolvedTurnMode = resolved.turnMode || null;
          if (typeof resolved.text === 'string' && resolved.text.length > 0) {
            effectiveText = resolved.text;
          }
          if (resolved.ambiguous && resolved.candidates && resolved.candidates.length > 0) {
            const names = resolved.candidates.map(c => c.name).join(', ');
            addToast(`여러 코드베이스와 매칭되어 ${effectiveTarget}로 보냅니다: ${names}`, 'info');
          }
        }
      }
    } catch (resolveErr) {
      resolveFailed = true;
      if (hasExplicitMention) {
        addToast(
          `라우터 해석 실패 — @mention이 포함된 메시지는 전송 취소됩니다: ${resolveErr && resolveErr.message ? resolveErr.message : 'unknown'}`,
          'error'
        );
        // Put the text back in the input so the user doesn't lose it.
        setInput(text);
        setAttachedImages(attachedImages);
        setSending(false);
        requestAnimationFrame(() => { if (inputRef.current) inputRef.current.focus(); });
        return;
      }
      // No @mention → safe to fall through to the UI selection.
    }

    try {
      if (effectiveTarget === 'top') {
        await topSendMessage(effectiveText, imagesToSend.length > 0 ? imagesToSend : undefined);
      } else {
        // PM path: hit the conversation endpoint directly so the
        // send works even if the UI selector is still pointing at
        // Top (router rewrote to pm:<id>).
        await apiFetch(`/api/conversations/${encodeURIComponent(effectiveTarget)}/message`, {
          method: 'POST',
          body: JSON.stringify({
            text: effectiveText,
            images: imagesToSend.length > 0 ? imagesToSend : undefined,
            ...(resolvedCodebaseProjectId ? { codebaseProjectId: resolvedCodebaseProjectId } : {}),
            ...(resolvedTurnMode ? { turnMode: resolvedTurnMode } : {}),
          }),
        });
        if (effectiveTarget !== conversationTarget) {
          setConversationTarget(effectiveTarget);
        }
      }
    } catch (err) {
      addToast('Failed to send: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
    setSending(false);
    // 전송 완료 후 입력창에 포커스 복원 — rAF 로 Preact 가 disabled 속성을
    // 제거한 뒤의 프레임을 기다림 (setTimeout(0) 은 paint 전에 실행될 수 있음)
    requestAnimationFrame(() => { if (inputRef.current) inputRef.current.focus(); });
  };

  // v3 Phase 6 — Reset Operator. Only meaningful while an Operator conversation is
  // selected. Confirms first, then hits the single-owner cleanup route
  // from Phase 3a, and flips the selector back to Top on success so the
  // next message isn't stranded against a dead slot.
  const handleResetPm = async () => {
    if (!isPm || !pmProjectId) return;
    const label = pmProject ? pmProject.name : pmProjectId;
    const ok = confirm(
      `Reset Operator for "${label}"? 이 오퍼레이터 세션은 종료되고 저장된 thread가 삭제됩니다. ` +
      `다음 메시지부터 새 thread로 시작합니다.`
    );
    if (!ok) return;
    try {
      await apiFetch(`/api/manager/pm/${encodeURIComponent(pmProjectId)}/reset`, {
        method: 'POST',
      });
      addToast(`Operator reset: ${label}`, 'success');
      setConversationTarget('top');
    } catch (err) {
      addToast('Reset failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStart = async () => {
    // PR5: send agent_profile_id so the server can pick the right adapter
    // (Claude Code or Codex). Empty string = omit, preserving the server's
    // backward-compat default of 'claude-code'.
    const opts = selectedProfileId ? { agent_profile_id: selectedProfileId } : {};
    try {
      if (selectedProfileId) {
        try { localStorage.setItem(MANAGER_PROFILE_PICK_KEY, selectedProfileId); } catch { /* ignore */ }
      }
      await start(opts);
    } catch { /* toast handled */ }
  };

  // PR5: selected profile row (may be undefined before the list loads).
  const selectedProfile = managerProfiles.find(p => p.id === selectedProfileId) || null;
  const selectedAuthState = managerProfileAuthState(selectedProfile);
  const selectedCanAuth = selectedAuthState === 'ok';
  // Start is only enabled on 'ok'. 'missing' requires user action (creds),
  // 'unknown' requires server restart/refresh — neither is a green light.
  const startDisabled = loading || managerProfiles.length === 0 || !selectedProfile || !selectedCanAuth;

  // Operator picker — build the conversation selector options shown in the header.
  // Structure: Top entry → separator → one entry per pm_enabled project.
  // Each Operator entry shows a color dot from the project's color field (if any)
  // and a green "active" dot when the Operator run is running.
  const activePms = status.pms || []; // array of { conversationId, run, usage, claudeSessionId } from /api/manager/status
  const pmEnabledProjects = useMemo(
    () => (projects || []).filter(p => p.pm_enabled),
    [projects]
  );
  const pmPickerOptions = useMemo(() => {
    const opts = [
      { value: 'top', label: 'Top Manager', dot: null },
    ];
    if (pmEnabledProjects.length > 0) {
      opts.push({ separator: true, key: '_sep' });
      for (const p of pmEnabledProjects) {
        const convId = operatorConversationId(p.id);
        const isActive = activePms.some(pm =>
          (conversationIdMatchesProject(pm.conversationId, p.id)
            || conversationIdMatchesProject(pm.legacyConversationId, p.id)) && // W-P5: snapshot id is instance-form
          pm.run &&
          pm.run.status === 'running'
        );
        // dot: project color if set, else a neutral grey; overlay active with green
        // K-3α: use --status-active-bright token so light theme maps to a darker
        // emerald that satisfies WCAG AA against the light bg.
        const dotColor = isActive ? 'var(--status-active-bright)' : (p.color || null);
        opts.push({ value: convId, label: p.name, dot: dotColor });
      }
    }
    return opts;
  }, [pmEnabledProjects, activePms]);

  // F-1: Codex Fast Mode ⚡ toggle. Only for an active CODEX Operator conversation
  // that has a resolvable instance id. Match the current conversation to its
  // status.pms snapshot entry (by live run id first, then project) so we read
  // the server-derived fastMode without an extra fetch.
  const currentPm = isPm
    ? (activePms.find(pm =>
        (pmConv.run && pm.run && pm.run.id === pmConv.run.id)
        || conversationIdMatchesProject(pm.conversationId, pmProjectId)
        || conversationIdMatchesProject(pm.legacyConversationId, pmProjectId)
      ) || null)
    : null;
  const currentPmRun = currentPm && currentPm.run;
  const isCodexOperator = !!(currentPmRun && currentPmRun.manager_adapter === 'codex');
  const fastOperatorInstanceId = currentPmRun && currentPmRun.operator_instance_id;
  const fastModeOn = !!(currentPm && Number(currentPm.fastMode) === 1);
  const showFastToggle = isPm && pmRunActive && isCodexOperator && !!fastOperatorInstanceId;
  const [fastToggling, setFastToggling] = useState(false);

  const handleToggleFast = async () => {
    if (!fastOperatorInstanceId || fastToggling) return;
    const next = fastModeOn ? 0 : 1;
    setFastToggling(true);
    try {
      await apiFetch(`/api/operator-instances/${encodeURIComponent(fastOperatorInstanceId)}/fast-mode`, {
        method: 'PATCH',
        body: JSON.stringify({ fast_mode: next }),
      });
      addToast(next ? '빠른 응답 켜짐 · 크레딧 2.5×' : '빠른 응답 꺼짐', 'info');
      if (typeof checkStatus === 'function') checkStatus();
    } catch (err) {
      addToast('빠른 응답 토글 실패: ' + (err && err.message ? err.message : 'unknown'), 'error');
    } finally {
      setFastToggling(false);
    }
  };

  return html`
    <div class="manager-chat-side">
      <div class="manager-chat-header">
        <div class="manager-panel-title">
          <span class="manager-icon">\u2726</span>
          ${status.active && pmEnabledProjects.length > 0 ? html`
            <${Dropdown}
              wide
              value=${conversationTarget}
              onChange=${setConversationTarget}
              options=${pmPickerOptions}
              ariaLabel="Switch conversation target"
              className="manager-pm-picker"
            />
          ` : html`
            <span>${isPm ? `오퍼레이터 \u00B7 ${pmProject ? pmProject.name : pmProjectId}` : MANAGER_LABELS.managerSession}</span>
          `}
          <span class="manager-status-badge ${chatBadgeClass}" data-state=${chatBadgeClass}>${chatBadge}</span>
        </div>
        <div class="manager-panel-actions">
          ${!isPm && status.active && status.usage && html`
            <span class="manager-cost">$${(status.usage.costUsd || 0).toFixed(4)}</span>
          `}
          ${showFastToggle && html`
            <button
              class="btn btn-sm manager-fast-toggle"
              type="button"
              data-action="toggle-fast"
              data-active=${fastModeOn ? 'true' : 'false'}
              aria-pressed=${fastModeOn ? 'true' : 'false'}
              disabled=${fastToggling}
              onClick=${handleToggleFast}
              title="빠른 응답 (~1.5× 속도) · 크레딧 2.5× · ChatGPT 인증 필요"
              aria-label=${`빠른 응답 ${fastModeOn ? '끄기' : '켜기'} (크레딧 2.5배)`}
            >⚡ ${fastModeOn ? 'Fast' : 'Std'}</button>
          `}
          ${isPm && pmRunActive && html`
            <button
              class="btn btn-sm btn-danger"
              data-action="reset-pm"
              onClick=${handleResetPm}
              title="오퍼레이터 리셋: 이 코드베이스의 오퍼레이터 스레드만 종료합니다."
              aria-label="이 코드베이스의 오퍼레이터 리셋"
            >${MANAGER_LABELS.resetPM}</button>
          `}
          ${!isPm && status.active && html`
            <button
              class="btn btn-sm btn-danger"
              data-action="stop-top"
              onClick=${stop}
              title="Top 매니저 중지"
              aria-label="Top 매니저 중지"
            >${COMMON_ACTIONS.stop}</button>
          `}
        </div>
      </div>

      <div class="manager-messages" ref=${messagesRef} tabindex="0" role="log" aria-label="대화 메시지">
        ${!status.active && messages.length === 0 && html`
          <div class="manager-empty">
            <div class="manager-empty-icon">\u2726</div>
            <div class="manager-empty-text">매니저 세션을 시작해 에이전트를 조율하세요</div>
            ${agentsLoading && managerProfiles.length === 0 ? html`
              <div class="manager-picker-empty">${MANAGER_CHAT_AUX.agentsLoading}</div>
            ` : agentsError ? html`
              <div class="manager-picker-empty" role="alert">
                ${MANAGER_CHAT_AUX.agentsLoadFailed}: ${agentsError}.
                <br/>
                <button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>${MANAGER_CHAT_AUX.retry}</button>
              </div>
            ` : managerProfiles.length === 0 ? html`
              <div class="manager-picker-empty">
                ${MANAGER_CHAT_AUX.noManagerAgents}<br/>
                <a href="#agents" class="manager-picker-link">${MANAGER_CHAT_AUX.goToAgentsPage}</a>${MANAGER_CHAT_AUX.toCreateOne}
              </div>
            ` : html`
              <div class="manager-picker" role="group" aria-label=${MANAGER_CHAT_AUX.pickerGroupAria}>
                <label class="manager-picker-label" for="manager-profile-select">${MANAGER_CHAT_AUX.agentLabel}</label>
                <div class="manager-picker-row">
                  <select
                    id="manager-profile-select"
                    class="manager-picker-select"
                    value=${selectedProfileId}
                    onChange=${(e) => setSelectedProfileId(e.target.value)}
                    aria-describedby="manager-picker-status"
                  >
                    ${managerProfiles.map(p => {
                      const state = managerProfileAuthState(p);
                      // A11y: <option> text is read verbatim by screen
                      // readers and glyphs CANNOT be hidden inside option
                      // labels (no aria-hidden support there), so we use
                      // plain English status text only. 3-state:
                      // authenticated / no credentials / auth status
                      // unavailable (server version mismatch).
                      const statusText = state === 'ok' ? 'authenticated'
                        : state === 'unknown' ? 'auth status unavailable'
                        : 'no credentials';
                      return html`<option key=${p.id} value=${p.id}>${p.name} (${p.type}) \u2014 ${statusText}</option>`;
                    })}
                  </select>
                  <button
                    class="manager-picker-refresh"
                    type="button"
                    title=${MANAGER_CHAT_AUX.refreshAuth}
                    aria-label=${MANAGER_CHAT_AUX.refreshAuth}
                    onClick=${() => reloadAgents && reloadAgents()}
                  >\u21BB</button>
                </div>
                ${selectedProfile && html`
                  <div id="manager-picker-status"
                    class=${"manager-picker-status " + (selectedAuthState === 'ok' ? 'ok' : selectedAuthState === 'unknown' ? 'unknown' : 'bad')}
                    role="status"
                    aria-live="polite"
                  >
                    <span class="manager-picker-dot" aria-hidden="true"></span>
                    ${selectedAuthState === 'ok'
                      ? html`<span>${MANAGER_CHAT_AUX.authStateOk}${selectedProfile.auth.sources && selectedProfile.auth.sources.length > 0 ? MANAGER_CHAT_AUX.authStateOkSourceSeparator + selectedProfile.auth.sources.join(', ') : ''}</span>`
                      : selectedAuthState === 'unknown'
                      ? html`<span>${MANAGER_CHAT_AUX.authStateUnknown}</span>`
                      : html`<span>${MANAGER_CHAT_AUX.authStateMissing}</span>`
                    }
                  </div>
                `}
                ${selectedAuthState === 'missing' && selectedProfile && selectedProfile.auth && Array.isArray(selectedProfile.auth.diagnostics) && selectedProfile.auth.diagnostics.length > 0 && html`
                  <ul class="manager-picker-diagnostics">
                    ${selectedProfile.auth.diagnostics.map((d, i) => html`<li key=${i}>${d}</li>`)}
                  </ul>
                `}
                ${selectedAuthState === 'missing' && html`
                  <div class="manager-picker-remediation">
                    ${MANAGER_CHAT_AUX.remediationFixPrefix}<a href="#agents" class="manager-picker-link">${MANAGER_CHAT_AUX.remediationFixLink}</a>${MANAGER_CHAT_AUX.remediationFixSuffix}<button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>${MANAGER_CHAT_AUX.remediationRefreshLink}</button>${MANAGER_CHAT_AUX.remediationFixEnd}
                  </div>
                `}
                ${selectedAuthState === 'unknown' && html`
                  <div class="manager-picker-remediation">
                    <button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>${MANAGER_CHAT_AUX.remediationTryRefreshLink}</button>${MANAGER_CHAT_AUX.remediationTryAfter}
                  </div>
                `}
              </div>
            `}
            <button class="btn btn-primary" data-action="start-manager" onClick=${handleStart} disabled=${startDisabled}>
              ${loading ? COMMON_ACTIONS.starting : MANAGER_LABELS.startManager}
            </button>
          </div>
        `}
        ${messages.map(m => html`
          <div key=${m.id} class="manager-msg-row ${m.type === 'user_input' ? 'manager-msg-row-user' : 'manager-msg-row-assistant'}">
            <div class="manager-msg ${m.type === 'user_input' ? 'manager-msg-user' : 'manager-msg-assistant'}">
              ${m.type === 'user_input'
                ? html`<div class="manager-msg-content">${m.text}</div>`
                : html`<div class="manager-msg-content markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.text) }}></div>`
              }
            </div>
            <div class="manager-msg-time">${timeAgo(m.time)}</div>
          </div>
        `)}
      </div>

      ${/* R2-C.2 SuggestedActions strip — renders directly above the
           input area when the session is active AND there is at least
           one rule-matched chip. Hidden otherwise (spec §11.2 — "빈 상태면
           strip 자체 hide"). The strip sits INSIDE the flex column so it
           doesn't overlap the message list's scroll, and it takes its
           own border so it visually separates from the input even when
           no dragover highlight is active. */ ''}
      ${status.active && suggestedActions.length > 0 && html`
        <div class="manager-suggested-actions" role="group" aria-label="Suggested actions">
          ${suggestedActions.map(action => html`
            <button
              key=${action.kind}
              type="button"
              class="manager-suggested-chip manager-suggested-${action.kind}"
              onClick=${() => handleSuggestedAction(action)}
              aria-label=${action.label}
            >
              <span class="manager-suggested-icon" aria-hidden="true">${action.icon}</span>
              <span class="manager-suggested-label">${action.label}</span>
            </button>
          `)}
        </div>
      `}

      ${status.active && html`
        <div class="manager-input-area ${dragOver ? 'drag-over' : ''}"
          onDragOver=${(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave=${() => setDragOver(false)}
          onDrop=${handleDrop}
        >
          ${attachedImages.length > 0 && html`
            <div class="manager-image-previews">
              ${attachedImages.map((img, i) => html`
                <div key=${i} class="manager-image-preview">
                  <img src=${img.preview} alt=${img.name} />
                  <button class="manager-image-remove" onClick=${() => removeImage(i)} title="Remove">\u00d7</button>
                </div>
              `)}
            </div>
          `}
          <div class="manager-input-row">
            <input type="file" accept="image/*" multiple hidden ref=${fileInputRef}
              onChange=${(e) => { addImages(e.target.files); e.target.value = ''; }}
            />
            <button class="manager-attach-btn" onClick=${() => fileInputRef.current?.click()} title="Attach image" disabled=${sending}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </button>
            <${MentionInput}
              inputRef=${inputRef}
              class="manager-input"
              placeholder="Message the manager..."
              value=${input}
              projects=${projects}
              onInput=${(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }}
              onKeyDown=${handleKeyDown}
              onPaste=${handlePaste}
              rows="1"
              disabled=${sending}
            />
            <button
              class="manager-send-btn"
              onClick=${handleSend}
              disabled=${(!input.trim() && attachedImages.length === 0) || sending}
              title="Send"
            >\u2191</button>
          </div>
        </div>
      `}

      ${!status.active && messages.length > 0 && html`
        <div class="manager-input-row">
          <button class="btn btn-primary" style="width:100%" onClick=${handleStart} disabled=${loading}>
            ${loading ? 'Starting...' : 'Start New Session'}
          </button>
        </div>
      `}

      ${/* R2-C.2: RunInspector triggered from SuggestedActions. The app
           also renders a RunInspector at the top level (app.js) for
           dashboard/board clicks; both inspectors render into the same
           .run-inspector-overlay class but only one is mounted at a time
           in practice because ManagerChat and the app-level inspector
           live in different parts of the DOM tree and the SuggestedAction
           path only fires when a user is focused on the Manager view. */ ''}
      ${inspectRun && html`
        <${RunInspector} run=${inspectRun} onClose=${() => setInspectRun(null)} />
      `}
    </div>
  `;
}
