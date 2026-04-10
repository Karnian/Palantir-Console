// ManagerView — Full-page manager chat + session grid.
// Extracted from server/public/app.js as part of P6-1 (ESM phase 5a).
//
// Dependencies (all bridged onto window by main.js before this module loads):
//   - window.preact, window.preactHooks, window.htm
//   - window.apiFetch                        (from app/lib/api.js)
//   - window.addToast                        (from app/lib/toast.js)
//   - window.useConversation                 (from app/lib/hooks.js)
//   - window.renderMarkdown                  (from app/lib/markdown.js)
//   - window.timeAgo                         (from app/lib/format.js)
//   - window.Dropdown                        (from app/components/Dropdown.js)
//   - window.EmptyState                      (from app/components/EmptyState.js)
//   - window.MentionInput                    (from app/components/MentionInput.js)
//   - window.RunInspector                    (from app/components/RunInspector.js)
//   - window.TaskDetailPanel                 (lives in app.js — loaded before this)
//
// Only ManagerView and managerProfileAuthState are exported.

const { h } = window.preact;
const { useState, useEffect, useMemo, useRef } = window.preactHooks;
const html = window.htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// Manager View (Full Page — Left: Chat 60%, Right: Session Grid 40%)
// ─────────────────────────────────────────────────────────────────────────────

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

export function ManagerView({ manager, runs, tasks, projects, agents = [], agentsError = null, agentsLoading = false, reloadAgents, driftAudit, onOpenDrift }) {
  const apiFetch = window.apiFetch;
  const addToast = window.addToast;
  const useConversation = window.useConversation;
  const renderMarkdown = window.renderMarkdown;
  const timeAgo = window.timeAgo;
  const Dropdown = window.Dropdown;
  const EmptyState = window.EmptyState;
  const MentionInput = window.MentionInput;
  const RunInspector = window.RunInspector;
  const TaskDetailPanel = window.TaskDetailPanel;

  const { status, events: topEvents, loading, start, sendMessage: topSendMessage, stop } = manager;
  const [input, setInput] = useState('');

  // v3 Phase 6 — conversation target selector.
  //
  // The chat panel can now point at the Top manager OR a project-scoped
  // PM conversation (`pm:<projectId>`). State is kept in one string so
  // every downstream read (events, send, reset availability, header
  // label) can branch on a single value. Defaults to 'top' so the legacy
  // behavior is unchanged on first mount — users only see a difference
  // after they pick a PM from the dropdown.
  const [conversationTarget, setConversationTarget] = useState('top');
  const pmConversationId = conversationTarget !== 'top' ? conversationTarget : null;
  const pmConv = useConversation(pmConversationId); // null-safe in hook
  const isPm = conversationTarget !== 'top';
  const pmProjectId = isPm ? conversationTarget.slice(3) : null;
  const pmProject = isPm ? (projects || []).find(p => p.id === pmProjectId) || null : null;

  // Unified event source + send path + run + active flag. The PM hook
  // mirrors the Top hook's shape (events, run, sendMessage), so the
  // downstream rendering code doesn't have to branch per target beyond
  // these aliases.
  const events = isPm ? (pmConv.events || []) : topEvents;
  const sendMessage = isPm
    ? (async (text, images) => pmConv.sendMessage(text, images))
    : topSendMessage;
  // A PM conversation is "active" when its backing run exists and is
  // running. The Top session uses status.active (legacy).
  const pmRunActive = isPm && pmConv.run && pmConv.run.status === 'running';
  const chatActive = isPm ? pmRunActive : status.active;
  // Badge label for the header
  const chatBadge = isPm
    ? (pmConv.run
        ? (pmConv.run.status === 'running' ? 'Active' : pmConv.run.status)
        : 'Idle')
    : (status.active ? 'Active' : 'Idle');
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
  const [attachedImages, setAttachedImages] = useState([]);
  const messagesRef = useRef(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);

  // Refocus chat input when conversation target changes (e.g. PM picker)
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
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
          if (typeof resolved.text === 'string' && resolved.text.length > 0) {
            effectiveText = resolved.text;
          }
          if (resolved.ambiguous && resolved.candidates && resolved.candidates.length > 0) {
            const names = resolved.candidates.map(c => c.name).join(', ');
            addToast(`여러 프로젝트와 매칭되어 ${effectiveTarget}로 보냅니다: ${names}`, 'info');
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

  // v3 Phase 6 — Reset PM. Only meaningful while a PM conversation is
  // selected. Confirms first, then hits the single-owner cleanup route
  // from Phase 3a, and flips the selector back to Top on success so the
  // next message isn't stranded against a dead slot.
  const handleResetPm = async () => {
    if (!isPm || !pmProjectId) return;
    const label = pmProject ? pmProject.name : pmProjectId;
    const ok = confirm(
      `Reset PM for "${label}"? 이 PM 세션은 종료되고 저장된 thread가 삭제됩니다. ` +
      `다음 메시지부터 새 thread로 시작합니다.`
    );
    if (!ok) return;
    try {
      await apiFetch(`/api/manager/pm/${encodeURIComponent(pmProjectId)}/reset`, {
        method: 'POST',
      });
      addToast(`PM reset: ${label}`, 'success');
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

  const [inspectRun, setInspectRun] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [collapsedProjects, setCollapsedProjects] = useState({});
  const toggleProject = (key) => setCollapsedProjects(prev => ({ ...prev, [key]: !prev[key] }));

  const workerRuns = useMemo(() => (runs || []).filter(r => !r.is_manager), [runs]);

  // Group: Project → Task → Runs
  const projectGroups = useMemo(() => {
    // Build runs map by task
    const runsMap = new Map();
    for (const r of workerRuns) {
      const tid = r.task_id || '_orphan';
      if (!runsMap.has(tid)) runsMap.set(tid, []);
      runsMap.get(tid).push(r);
    }

    // Build project groups with tasks
    const projMap = new Map();
    for (const t of (tasks || [])) {
      const pid = t.project_id || '_none';
      const pname = (projects || []).find(p => p.id === t.project_id)?.name || 'No Project';
      if (!projMap.has(pid)) projMap.set(pid, { key: pid, name: pname, tasks: [] });
      const taskRuns = runsMap.get(t.id) || [];
      runsMap.delete(t.id);
      projMap.get(pid).tasks.push({ task: t, runs: taskRuns });
    }

    // Orphan runs (no task)
    const orphanRuns = runsMap.get('_orphan') || [];
    runsMap.delete('_orphan');

    // Group tasks by status within each project
    const STATUS_SECTIONS = [
      { key: 'in_progress', label: 'In Progress', statuses: ['in_progress'] },
      { key: 'todo', label: 'Todo', statuses: ['todo'] },
      { key: 'review', label: 'Review', statuses: ['review'] },
      { key: 'failed', label: 'Failed', statuses: ['failed'] },
      { key: 'backlog', label: 'Backlog', statuses: ['backlog'] },
      { key: 'done', label: 'Done', statuses: ['done'] },
    ];
    const STATUS_COLORS = { in_progress: '#3b82f6', todo: '#6b7280', review: '#f59e0b', failed: '#ef4444', backlog: '#6b7280', done: '#22c55e' };

    for (const group of projMap.values()) {
      group.sections = STATUS_SECTIONS
        .map(sec => ({
          ...sec,
          color: STATUS_COLORS[sec.key],
          tasks: group.tasks.filter(t => t.task && sec.statuses.includes(t.task.status)),
        }))
        .filter(sec => sec.tasks.length > 0);
      // Keep orphan tasks (no status match)
      const orphanTasks = group.tasks.filter(t => !t.task);
      if (orphanTasks.length > 0) {
        group.sections.push({ key: '_orphan', label: 'Unassigned', color: '#6b7280', tasks: orphanTasks });
      }
    }

    const result = Array.from(projMap.values());

    // Add orphan runs as a virtual group if any
    if (orphanRuns.length > 0) {
      const noneGroup = result.find(g => g.key === '_none') || { key: '_none', name: 'No Project', tasks: [] };
      if (!result.includes(noneGroup)) result.push(noneGroup);
      noneGroup.tasks.push({ task: null, runs: orphanRuns });
    }

    return result;
  }, [tasks, workerRuns, projects]);

  const runStatusIcon = (status) => {
    switch (status) {
      case 'running': return '\u25CF'; // ●
      case 'completed': return '\u2713'; // ✓
      case 'failed': return '\u2717'; // ✗
      case 'needs_input': return '\u23F8'; // ⏸
      case 'queued': return '\u25CB'; // ○
      case 'cancelled': return '\u2015'; // ―
      case 'stopped': return '\u23F9'; // ⏹
      default: return '\u25CB';
    }
  };

  const runStatusColor = (status) => {
    switch (status) {
      case 'running': return '#3b82f6';
      case 'completed': return '#22c55e';
      case 'failed': return '#ef4444';
      case 'needs_input': return '#f59e0b';
      case 'queued': return '#6b7280';
      case 'cancelled': return '#6b7280';
      case 'stopped': return '#6b7280';
      default: return '#6b7280';
    }
  };

  return html`
    <div class="manager-view">
      <!-- Left: Chat Panel (40%) -->
      <div class="manager-chat-side">
        <div class="manager-chat-header">
          <div class="manager-panel-title">
            <span class="manager-icon">\u2726</span>
            <span>${isPm ? `PM · ${pmProject ? pmProject.name : pmProjectId}` : 'Manager Session'}</span>
            <span class="manager-status-badge ${chatBadgeClass}">${chatBadge}</span>
          </div>
          <div class="manager-panel-actions">
            ${!isPm && status.active && status.usage && html`
              <span class="manager-cost">$${(status.usage.costUsd || 0).toFixed(4)}</span>
            `}
            ${/* v3 Phase 6 + P2-9: conversation selector. Upgraded from
                 the native <select> to the existing Dropdown component
                 so it matches the rest of the app's picker styling AND
                 so the "· active" annotation can use a small trailing
                 chip rather than jamming everything into the option
                 text. The option list is derived from projects with
                 pm_enabled !== 0; Top is always present as the first
                 option. */ ''}
            ${status.active && html`
              <${Dropdown}
                className="manager-picker-select"
                style="max-width:220px"
                title="Conversation target — pick Top or a project PM"
                ariaLabel="Conversation target"
                value=${conversationTarget}
                onChange=${(v) => setConversationTarget(v)}
                options=${[
                  { value: 'top', label: 'Top manager' },
                  ...((projects || [])
                    .filter(p => p.pm_enabled !== 0)
                    .map(p => {
                      const active = (status.pms || []).some(s => s.conversationId === `pm:${p.id}`);
                      return {
                        value: `pm:${p.id}`,
                        // `· active` suffix preserved — Dropdown renders
                        // the label as plain text, so the visual is the
                        // same as the pre-P2-9 native <select>.
                        label: `@${p.name}${active ? ' · active' : ''}`,
                      };
                    })),
                ]}
              />
            `}
            ${/* v3 Phase 7: per-PM drift indicator. Only surfaces
                 when the currently selected PM has one or more
                 incoherent audit rows. Clicking opens the global
                 DriftDrawer so the user can inspect + dismiss. */ ''}
            ${isPm && driftAudit && (driftAudit.countByProject.get(pmProjectId) || 0) > 0 && html`
              <button
                class="btn btn-sm btn-danger"
                style="padding:2px 8px"
                title="This PM has pending drift warnings. Click to inspect."
                onClick=${() => onOpenDrift && onOpenDrift()}
              >\u26A0 ${driftAudit.countByProject.get(pmProjectId)}</button>
            `}
            ${/* P2-9: clarified tooltips so the Stop (Top) vs Reset PM
                 distinction is unambiguous. Stop terminates the shared
                 Top manager process — all PMs keep running. Reset PM
                 terminates ONLY this project's PM thread; Top and other
                 PMs are unaffected. The label text stays short; the
                 tooltip + aria-label carry the detail. */ ''}
            ${isPm && pmRunActive && html`
              <button
                class="btn btn-sm btn-danger"
                onClick=${handleResetPm}
                title="Reset PM: terminate this project's PM thread only. Top and other PMs keep running. Next message starts a fresh PM thread for this project."
                aria-label="Reset PM for this project"
              >Reset PM</button>
            `}
            ${!isPm && status.active && html`
              <button
                class="btn btn-sm btn-danger"
                onClick=${stop}
                title="Stop Top manager: terminate the shared Top manager process. Any currently active PMs continue running in their own sessions."
                aria-label="Stop Top manager"
              >Stop</button>
            `}
          </div>
        </div>

        <div class="manager-messages" ref=${messagesRef}>
          ${!status.active && messages.length === 0 && html`
            <div class="manager-empty">
              <div class="manager-empty-icon">\u2726</div>
              <div class="manager-empty-text">Start a Manager session to orchestrate your agents</div>
              ${agentsLoading && managerProfiles.length === 0 ? html`
                <div class="manager-picker-empty">Loading agent profiles\u2026</div>
              ` : agentsError ? html`
                <div class="manager-picker-empty" role="alert">
                  Couldn't load agent profiles: ${agentsError}.
                  <br/>
                  <button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>Retry</button>
                </div>
              ` : managerProfiles.length === 0 ? html`
                <div class="manager-picker-empty">
                  No Claude Code or Codex agents registered.<br/>
                  <a href="#agents" class="manager-picker-link">Go to the Agents page</a> to create one.
                </div>
              ` : html`
                <div class="manager-picker" role="group" aria-label="Manager agent picker">
                  <label class="manager-picker-label" for="manager-profile-select">Agent</label>
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
                      title="Refresh auth status"
                      aria-label="Refresh auth status"
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
                        ? html`<span>Authenticated${selectedProfile.auth.sources && selectedProfile.auth.sources.length > 0 ? ' \u00B7 ' + selectedProfile.auth.sources.join(', ') : ''}</span>`
                        : selectedAuthState === 'unknown'
                        ? html`<span>Auth status unavailable. The server may be outdated \u2014 restart the server and refresh.</span>`
                        : html`<span>${selectedProfile.auth && selectedProfile.auth.diagnostics && selectedProfile.auth.diagnostics[0] ? selectedProfile.auth.diagnostics[0] : 'No credentials resolved for this profile.'}</span>`
                      }
                    </div>
                  `}
                  ${selectedAuthState === 'missing' && selectedProfile && selectedProfile.auth && selectedProfile.auth.diagnostics && selectedProfile.auth.diagnostics.length > 1 && html`
                    <ul class="manager-picker-diagnostics">
                      ${selectedProfile.auth.diagnostics.slice(1).map((d, i) => html`<li key=${i}>${d}</li>`)}
                    </ul>
                  `}
                  ${selectedAuthState === 'missing' && html`
                    <div class="manager-picker-remediation">
                      Fix credentials on the <a href="#agents" class="manager-picker-link">Agents page</a>, then <button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>refresh</button>.
                    </div>
                  `}
                  ${selectedAuthState === 'unknown' && html`
                    <div class="manager-picker-remediation">
                      Try <button type="button" class="manager-picker-link manager-picker-link-btn" onClick=${() => reloadAgents && reloadAgents()}>refresh</button>. If this persists, restart the server to pick up the latest code.
                    </div>
                  `}
                </div>
              `}
              <button class="btn btn-primary" onClick=${handleStart} disabled=${startDisabled}>
                ${loading ? 'Starting...' : 'Start Manager'}
              </button>
            </div>
          `}
          ${messages.map(m => html`
            <div key=${m.id} class="manager-msg ${m.type === 'user_input' ? 'manager-msg-user' : 'manager-msg-assistant'}">
              ${m.type === 'user_input'
                ? html`<div class="manager-msg-content">${m.text}</div>`
                : html`<div class="manager-msg-content markdown-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.text) }}></div>`
              }
              <div class="manager-msg-time">${timeAgo(m.time)}</div>
            </div>
          `)}
        </div>

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
                ref=${inputRef}
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
      </div>

      <!-- Right: Task Sessions -->
      <div class="manager-grid-side">
        <div class="manager-grid-header">
          <h3>Task Sessions</h3>
          <div class="manager-grid-stats">
            <span class="mgr-stat" style="color: #3b82f6">\u25CF ${workerRuns.filter(r => r.status === 'running').length} running</span>
            <span class="mgr-stat" style="color: #f59e0b">\u23F8 ${workerRuns.filter(r => r.status === 'needs_input').length} waiting</span>
            <span class="mgr-stat" style="color: #ef4444">\u2717 ${workerRuns.filter(r => r.status === 'failed').length} failed</span>
          </div>
        </div>

        <div class="manager-grid-body">
          ${projectGroups.length === 0 && html`
            <${EmptyState} icon="\u2699" text="No tasks yet" sub="Start a manager and assign tasks" />
          `}
          ${projectGroups.map(group => {
            const projCollapsed = collapsedProjects[group.key];
            const activeCount = group.tasks.reduce((n, t) => n + t.runs.filter(r => ['running', 'needs_input'].includes(r.status)).length, 0);
            return html`
            <div class="worker-project-group">
              <div class="worker-project-label" onClick=${() => toggleProject(group.key)} style="cursor:pointer">
                <span class="worker-project-chevron">${projCollapsed ? '\u25B6' : '\u25BC'}</span>
                <span>${group.name}</span>
                <span class="worker-project-count">${group.tasks.length} task${group.tasks.length !== 1 ? 's' : ''}${activeCount > 0 ? ` \u00B7 ${activeCount} active` : ''}</span>
              </div>
              ${!projCollapsed && group.sections.map(sec => html`
                <div class="task-status-section">
                  <div class="task-status-divider">
                    <span class="task-status-divider-dot" style="background:${sec.color}"></span>
                    <span class="task-status-divider-label">${sec.label}</span>
                    <span class="task-status-divider-count">${sec.tasks.length}</span>
                    <span class="task-status-divider-line"></span>
                  </div>
                  ${sec.tasks.map(({ task, runs: taskRuns }) => {
                    const activeRunCount = taskRuns.filter(r => ['running', 'needs_input'].includes(r.status)).length;
                    return html`
                      <div class="task-session-group">
                        <div class="task-session-header">
                          <span class="task-session-title">${task?.title || 'Unassigned Runs'}</span>
                          <span class="task-session-meta">
                            ${taskRuns.length > 0 ? `${taskRuns.length} run${taskRuns.length > 1 ? 's' : ''}` : ''}${activeRunCount > 0 ? ` \u00B7 ${activeRunCount} active` : ''}
                          </span>
                          ${task && html`<button class="task-session-detail-btn" onClick=${(e) => { e.stopPropagation(); setSelectedTask(task); }}>Detail</button>`}
                        </div>
                      </div>
                    `;
                  })}
                </div>
              `)}
            </div>
          `;})}
        </div>
      </div>

      ${inspectRun && html`
        <${RunInspector} run=${inspectRun} onClose=${() => setInspectRun(null)} />
      `}
      ${selectedTask && html`
        <${TaskDetailPanel}
          task=${selectedTask}
          onClose=${() => setSelectedTask(null)}
          projects=${projects}
          agents=${[]}
          runs=${workerRuns}
          onOpenRun=${(run) => { setSelectedTask(null); setInspectRun(run); }}
          onExecute=${() => {}}
          reloadTasks=${() => {}}
        />
      `}
    </div>
  `;
}
