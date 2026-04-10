// SessionsView + initLegacySessions — Sessions management view.
// Extracted from server/public/app.js as part of P6-3 (ESM phase 5).
//
// Dependencies (all bridged onto window by main.js before this module loads):
//   - window.preact, window.preactHooks, window.htm
//   - window.formatTime   (from app/lib/format.js)
//   - window.marked, window.DOMPurify  (CDN scripts, loaded via index.html)
//
// initLegacySessions: vanilla JS scoped to a container element — no Preact
// dependency. Uses fetch directly (not apiFetch) since it predates the
// apiFetch helper and does not need auth-bounce behaviour.

const { h } = window.preact;
const { useEffect, useRef } = window.preactHooks;
const html = window.htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// Legacy session logic — ported as-is but scoped to a container
// ─────────────────────────────────────────────────────────────────────────────

export function initLegacySessions(root) {
  const $ = (sel) => root.querySelector(sel);
  const sessionList = $('[data-role="session-list"]');
  const sessionTitleEl = $('[data-role="session-title"]');
  const sessionMeta = $('[data-role="session-meta"]');
  const messageList = $('[data-role="message-list"]');
  const conversation = $('[data-role="conversation"]');
  const loadMoreWrap = $('[data-role="load-more-wrap"]');
  const loadMoreBtn = $('[data-action="load-more"]');
  const sendForm = $('[data-role="send-form"]');
  const messageInput = $('[data-role="message-input"]');
  const sendStatus = $('[data-role="send-status"]');
  const sessionSearch = $('[data-role="search"]');
  const newSessionBtn = $('[data-action="new"]');
  const refreshBtn = $('[data-action="refresh"]');
  const renameSessionBtn = $('[data-action="rename"]');
  const deleteSessionBtn = $('[data-action="delete"]');
  const usageToggleBtn = $('[data-action="usage"]');
  const trashToggleBtn = $('[data-action="trash"]');
  const usageModal = $('[data-role="usage-modal"]');
  const usageOutput = $('[data-role="usage-output"]');
  const trashModal = $('[data-role="trash-modal"]');
  const trashList = $('[data-role="trash-list"]');
  const childSessionModal = $('[data-role="child-modal"]');
  const childSessionBody = $('[data-role="child-body"]');
  const directoryModal = $('[data-role="dir-modal"]');
  const directoryPath = $('[data-role="dir-path"]');
  const directoryList = $('[data-role="dir-list"]');

  const state = {
    sessions: [],
    selectedId: null,
    storageRoot: null,
    sessionQuery: '',
    messageFingerprints: new Map(),
    messageLimitBySession: new Map(),
    hasActiveSession: false,
    directoryRoot: null,
    currentDirectory: null,
    pendingSessionTitle: null,
    showHiddenDirectories: false,
  };

  const CLAMP_LINES = 20;
  const INITIAL_MESSAGE_LIMIT = 40;
  const MESSAGE_LIMIT_STEP = 40;
  // marked's global options are configured once at boot from app/main.js via
  // configureMarked() in app/lib/markdown.js. Per-call options below merge
  // with that global config, so we no longer need a local MARKDOWN_OPTIONS
  // const here or per-render setOptions calls.

  function getMessageLimit(sessionId) {
    return state.messageLimitBySession.get(sessionId) ?? INITIAL_MESSAGE_LIMIT;
  }

  function updateLoadMoreVisibility(hasMore) {
    if (!loadMoreWrap || !loadMoreBtn) return;
    if (!state.hasActiveSession || !state.selectedId) {
      loadMoreWrap.hidden = true;
      loadMoreBtn.disabled = true;
      return;
    }
    loadMoreWrap.hidden = !hasMore;
    loadMoreBtn.disabled = !hasMore;
  }

  function updateSessionControls(enabled) {
    if (renameSessionBtn) renameSessionBtn.disabled = !enabled;
    if (deleteSessionBtn) deleteSessionBtn.disabled = !enabled;
  }

  function renderMessageContent(target, raw) {
    if (window.marked && window.DOMPurify) {
      target.innerHTML = window.DOMPurify.sanitize(window.marked.parse(raw, { breaks: true }));
    } else {
      target.textContent = raw;
    }
  }

  function createChildMessageNode(message) {
    const wrap = document.createElement('div');
    wrap.className = `message ${message.role || 'assistant'}`;
    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = message.role || 'assistant';
    const content = document.createElement('div');
    content.className = 'content';
    renderMessageContent(content, message.content || '[no text]');
    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = window.formatTime(message.createdAt);
    wrap.append(role, content, time);
    return wrap;
  }

  function renderChildSessionCard(session, messages) {
    const card = document.createElement('div');
    card.className = 'child-session-card';
    const header = document.createElement('div');
    header.className = 'child-session-header';
    const title = document.createElement('div');
    title.className = 'child-session-title';
    title.textContent = session.title || session.slug || session.id;
    const meta = document.createElement('div');
    meta.className = 'child-session-meta';
    const agent = messages.find(m => m.agent)?.agent || 'unknown';
    const updatedAt = session?.time?.updated || session?.time?.created || null;
    meta.textContent = `agent: ${agent} \u00B7 ${updatedAt ? `updated ${window.formatTime(updatedAt)}` : 'updated unknown'}`;
    header.append(title, meta);
    const list = document.createElement('div');
    list.className = 'child-session-messages';
    const visible = (messages || []).filter(m => m.content && m.content.trim().length > 0);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'trash-empty';
      empty.textContent = 'No messages found for this session.';
      list.appendChild(empty);
    } else {
      visible.forEach(m => list.appendChild(createChildMessageNode(m)));
    }
    card.append(header, list);
    return card;
  }

  function renderChildSessionTabs(results) {
    const tabs = document.createElement('div');
    tabs.className = 'child-session-tabs';
    const panel = document.createElement('div');
    panel.className = 'child-session-panel';
    const setActive = (index) => {
      Array.from(tabs.children).forEach((b, i) => b.classList.toggle('active', i === index));
      panel.innerHTML = '';
      const { session, messages } = results[index];
      panel.appendChild(renderChildSessionCard(session, messages));
    };
    results.forEach((result, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'child-session-tab';
      const t = result.session.title || result.session.slug || result.session.id;
      const a = result.messages.find(m => m.agent)?.agent || 'agent';
      button.textContent = `${a}: ${t}`;
      button.addEventListener('click', () => setActive(index));
      tabs.appendChild(button);
    });
    setActive(0);
    return { tabs, panel };
  }

  async function openChildSessionModal(message) {
    if (!childSessionModal || !childSessionBody) return;
    const ids = message.childSessionIds || [];
    if (!ids.length) return;
    childSessionBody.textContent = 'Loading...';
    childSessionModal.removeAttribute('hidden');
    try {
      const results = await Promise.all(ids.map(async (id) => {
        const response = await fetch(`/api/sessions/${id}?limit=200`);
        const data = await response.json();
        if (!response.ok || !data.session) throw new Error(data?.error || `Failed to load session ${id}`);
        return { session: data.session, messages: data.messages || [] };
      }));
      childSessionBody.innerHTML = '';
      if (results.length === 1) {
        childSessionBody.appendChild(renderChildSessionCard(results[0].session, results[0].messages));
        return;
      }
      const { tabs, panel } = renderChildSessionTabs(results);
      childSessionBody.append(tabs, panel);
    } catch (error) {
      childSessionBody.textContent = error?.message || 'Failed to load subagent activity.';
    }
  }

  function formatProviderModel(session) {
    if (!session) return 'unknown';
    if (session.lastModelId) return session.lastModelId;
    if (session.lastProviderId) return session.lastProviderId;
    return 'unknown';
  }

  function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.sessionId = session.id;
    const title = document.createElement('div');
    title.className = 'title';
    const directoryMeta = document.createElement('div');
    directoryMeta.className = 'meta meta-directory';
    const providerMeta = document.createElement('div');
    providerMeta.className = 'meta meta-provider';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const time = document.createElement('div');
    time.className = 'meta meta-time';
    card.append(title, directoryMeta, providerMeta, badge, time);
    card.addEventListener('click', () => selectSession(session.id, { focusInput: true, forceAutoScroll: true }));
    return card;
  }

  function updateSessionCard(card, session) {
    const activeClass = session.id === state.selectedId ? 'active' : '';
    card.className = `session-card ${activeClass}`.trim();
    card.dataset.sessionId = session.id;
    const title = card.querySelector('.title');
    if (title) title.textContent = session.title;
    const directoryMeta = card.querySelector('.meta-directory');
    if (directoryMeta) directoryMeta.textContent = session.directory || 'No directory';
    const providerMeta = card.querySelector('.meta-provider');
    if (providerMeta) providerMeta.textContent = formatProviderModel(session);
    const timeMeta = card.querySelector('.meta-time');
    if (timeMeta) timeMeta.textContent = `Last activity: ${window.formatTime(session.lastActivity)}`;
    const badge = card.querySelector('.badge');
    if (badge) {
      const nextStatus = session.status;
      if (badge.dataset.status !== nextStatus) {
        badge.className = `badge ${nextStatus}`;
        badge.textContent = nextStatus;
        badge.dataset.status = nextStatus;
      } else if (!badge.textContent) {
        badge.textContent = nextStatus;
      }
    }
  }

  function isChildSession(s) { return Boolean(s.parentId); }
  function isSubagentSession(s) { const m = `${s.title || ''} ${s.slug || ''}`.toLowerCase(); return m.includes('subagent') || m.includes('sub agent') || m.includes('sub-agent'); }
  function isBackgroundSession(s) { return `${s.title || ''} ${s.slug || ''}`.toLowerCase().includes('background'); }
  function isTaskSession(s) { return /\btask\b/.test(`${s.title || ''} ${s.slug || ''}`.toLowerCase()); }
  function getSessionSearchText(s) { return [s.title, s.slug, s.directory].filter(Boolean).join(' ').toLowerCase(); }

  function renderSessions() {
    if (!state.sessions.length) {
      sessionList.innerHTML = '<div class="meta">No sessions found.</div>';
      return;
    }
    const query = state.sessionQuery.trim().toLowerCase();
    const eligible = state.sessions.filter(s => {
      if (!s.hasUserMessage) return false;
      if (isChildSession(s) || isSubagentSession(s) || isBackgroundSession(s) || isTaskSession(s)) return false;
      return true;
    });
    const filtered = query ? eligible.filter(s => getSessionSearchText(s).includes(query)) : eligible;
    if (!filtered.length) {
      sessionList.innerHTML = query ? '<div class="meta">No matching sessions.</div>' : '<div class="meta">No user sessions found.</div>';
      return;
    }
    const cards = Array.from(sessionList.querySelectorAll('.session-card'));
    const existing = new Map(cards.map(c => [c.dataset.sessionId, c]));
    const nextOrder = filtered.map(s => s.id);
    const currentOrder = cards.map(c => c.dataset.sessionId);
    const sameOrder = currentOrder.length === nextOrder.length && currentOrder.every((id, i) => id === nextOrder[i]);
    if (sameOrder) {
      filtered.forEach(s => { const c = existing.get(s.id) || createSessionCard(s); updateSessionCard(c, s); });
      return;
    }
    const fragment = document.createDocumentFragment();
    filtered.forEach(s => {
      let c = existing.get(s.id);
      if (!c) c = createSessionCard(s);
      updateSessionCard(c, s);
      fragment.appendChild(c);
    });
    sessionList.innerHTML = '';
    sessionList.appendChild(fragment);
  }

  function renderMessages(messages, options = {}) {
    const { autoScroll = false, onRendered = null } = options;
    messageList.innerHTML = '';
    if (!messages.length) {
      messageList.innerHTML = '<div class="meta">No messages found for this session.</div>';
      updateLoadMoreVisibility(false);
      return;
    }
    const visible = messages.filter(m => m.content && m.content.trim().length > 0);
    if (!visible.length) {
      messageList.innerHTML = '<div class="meta">No text messages in this session.</div>';
      updateLoadMoreVisibility(false);
      return;
    }
    visible.forEach(msg => {
      const wrap = document.createElement('div');
      wrap.className = `message ${msg.role || 'assistant'}`;
      const role = document.createElement('div');
      role.className = 'role';
      role.textContent = msg.role || 'assistant';
      const content = document.createElement('div');
      content.className = 'content';
      renderMessageContent(content, msg.content || '[no text]');
      content.style.setProperty('--clamp-lines', CLAMP_LINES);
      const time = document.createElement('div');
      time.className = 'timestamp';
      time.textContent = window.formatTime(msg.createdAt);
      const childSessions = Array.isArray(msg.childSessionIds) ? msg.childSessionIds : [];
      const childKinds = Array.isArray(msg.childSessionKinds) ? msg.childSessionKinds : [];
      if (childSessions.length) {
        wrap.classList.add('has-children');
        wrap.title = 'Click to view agent activity';
        let label = 'agent';
        if (childKinds.includes('background') && !childKinds.includes('subagent')) label = 'background';
        else if (childKinds.includes('subagent') && !childKinds.includes('background')) label = 'subagent';
        role.textContent = `${msg.role || 'assistant'} \u00B7 ${label}`;
        wrap.addEventListener('click', (event) => {
          if (event.target.closest('a') || event.target.closest('.expand-toggle')) return;
          if (window.getSelection && window.getSelection().toString()) return;
          openChildSessionModal(msg);
        });
      }
      let toggle = null;
      if (!childSessions.length) {
        toggle = document.createElement('button');
        toggle.className = 'expand-toggle';
        toggle.type = 'button';
        toggle.textContent = 'Expand';
        toggle.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          const isCollapsed = content.classList.contains('clamped');
          if (isCollapsed) { content.classList.remove('clamped'); toggle.textContent = 'Collapse'; toggle.setAttribute('aria-expanded', 'true'); }
          else { content.classList.add('clamped'); toggle.textContent = 'Expand'; toggle.setAttribute('aria-expanded', 'false'); }
        });
      }
      wrap.append(role, content);
      if (toggle) wrap.appendChild(toggle);
      wrap.appendChild(time);
      messageList.appendChild(wrap);
    });
    requestAnimationFrame(() => {
      applyMessageClamp();
      if (autoScroll) scrollConversationToBottom();
      if (typeof onRendered === 'function') onRendered();
    });
  }

  function applyMessageClamp() {
    messageList.querySelectorAll('.message').forEach(item => {
      const content = item.querySelector('.content');
      const toggle = item.querySelector('.expand-toggle');
      if (!content || !toggle) return;
      content.classList.add('clamped');
      if (content.scrollHeight > content.clientHeight + 1) {
        toggle.hidden = false;
        toggle.textContent = 'Expand';
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        content.classList.remove('clamped');
        toggle.hidden = true;
      }
    });
  }

  function scrollConversationToBottom() {
    if (conversation) conversation.scrollTop = conversation.scrollHeight;
  }

  async function loadSessions() {
    updateLoadMoreVisibility(false);
    const response = await fetch('/api/sessions');
    const data = await response.json();
    state.sessions = data.sessions || [];
    state.storageRoot = data.storageRoot;
    const hasSelected = state.selectedId && state.sessions.some(s => s.id === state.selectedId);
    state.hasActiveSession = Boolean(hasSelected);
    updateSessionControls(Boolean(hasSelected));
    renderSessions();
  }

  let _selectRequestId = 0; // Guard against stale responses

  async function selectSession(id, options = {}) {
    const { preserveDraft = false, focusInput = false, clearStatus = true, forceRender = false, preserveScrollPosition = false, forceAutoScroll = false } = options;
    const previousId = state.selectedId;
    if (id !== previousId) state.messageLimitBySession.set(id, INITIAL_MESSAGE_LIMIT);
    const shouldAutoScroll = (forceAutoScroll || id !== previousId) && !preserveScrollPosition;
    const scrollSnapshot = preserveScrollPosition && conversation ? { height: conversation.scrollHeight, top: conversation.scrollTop } : null;
    state.selectedId = id;
    const requestId = ++_selectRequestId;
    renderSessions();
    if (clearStatus) sendStatus.textContent = '';
    if (!preserveDraft) messageInput.value = '';
    if (focusInput) messageInput.focus();
    const messageLimit = getMessageLimit(id);
    const response = await fetch(`/api/sessions/${id}?limit=${messageLimit + 1}`);
    const data = await response.json();
    // Guard: if user switched to a different session while we were fetching, discard
    if (requestId !== _selectRequestId || state.selectedId !== id) return;
    if (!data.session) {
      state.hasActiveSession = false;
      sessionTitleEl.querySelector('.title').textContent = 'Session not found';
      sessionMeta.textContent = '';
      messageList.innerHTML = '';
      updateLoadMoreVisibility(false);
      updateSessionControls(false);
      return;
    }
    state.hasActiveSession = true;
    updateSessionControls(true);
    sessionTitleEl.querySelector('.title').textContent = data.session.title || data.session.slug || data.session.id;
    sessionMeta.textContent = `${data.session.directory || 'No directory'} \u00B7 Updated ${window.formatTime(data.session.time?.updated)}`;
    const messages = data.messages || [];
    const hasMoreMessages = messages.length > messageLimit;
    const displayMessages = hasMoreMessages ? messages.slice(Math.max(0, messages.length - messageLimit)) : messages;
    const last = displayMessages[displayMessages.length - 1];
    const fingerprint = { count: displayMessages.length, lastId: last?.id || null, lastCreatedAt: last?.createdAt || 0, lastCompletedAt: last?.completedAt || 0 };
    const previous = state.messageFingerprints.get(id);
    const changed = !previous || previous.count !== fingerprint.count || previous.lastId !== fingerprint.lastId || previous.lastCreatedAt !== fingerprint.lastCreatedAt || previous.lastCompletedAt !== fingerprint.lastCompletedAt;
    if (forceRender || id !== previousId || changed) {
      renderMessages(displayMessages, {
        autoScroll: shouldAutoScroll,
        onRendered: () => {
          if (!scrollSnapshot || !conversation) return;
          conversation.scrollTop = scrollSnapshot.top + (conversation.scrollHeight - scrollSnapshot.height);
        },
      });
      state.messageFingerprints.set(id, fingerprint);
    }
    updateLoadMoreVisibility(hasMoreMessages);
  }

  async function loadMoreMessages() {
    if (!state.selectedId) return;
    state.messageLimitBySession.set(state.selectedId, getMessageLimit(state.selectedId) + MESSAGE_LIMIT_STEP);
    if (loadMoreBtn) loadMoreBtn.disabled = true;
    await selectSession(state.selectedId, { preserveDraft: true, focusInput: false, clearStatus: false, forceRender: true, preserveScrollPosition: true });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!state.selectedId) return;
    const content = messageInput.value.trim();
    if (!content) return;
    sendStatus.textContent = 'Sending...';
    const response = await fetch(`/api/sessions/${state.selectedId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await response.json();
    sendStatus.textContent = data.status === 'ok' ? 'Sent.' : 'Failed to send.';
    const sessionId = state.selectedId;
    const initial = state.messageFingerprints.get(sessionId);
    for (let attempt = 0; attempt < 6; attempt++) {
      await selectSession(sessionId, { forceAutoScroll: true, forceRender: true });
      const next = state.messageFingerprints.get(sessionId);
      if (!initial || !next) return;
      if (next.count !== initial.count || next.lastId !== initial.lastId) return;
      await new Promise(r => setTimeout(r, 800));
    }
  }

  async function createSession() {
    const title = window.prompt('New session title');
    if (!title) return;
    state.pendingSessionTitle = title.trim();
    openDirectoryModal();
  }

  async function createSessionWithDirectory(directory) {
    if (!state.pendingSessionTitle) return;
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: state.pendingSessionTitle, directory }),
    });
    const data = await response.json();
    if (!response.ok) { window.alert(data.error || 'Failed to create session'); return; }
    state.pendingSessionTitle = null;
    await loadSessions();
    if (data.session?.id) await selectSession(data.session.id, { focusInput: true, forceAutoScroll: true });
  }

  async function renameSession() {
    if (!state.selectedId) return;
    const current = sessionTitleEl.querySelector('.title')?.textContent || '';
    const title = window.prompt('Rename session', current);
    if (!title) return;
    const response = await fetch(`/api/sessions/${state.selectedId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() }),
    });
    if (!response.ok) { const d = await response.json(); window.alert(d.error || 'Failed to rename session'); return; }
    await loadSessions();
    await selectSession(state.selectedId, { preserveDraft: true, focusInput: true, clearStatus: false, forceAutoScroll: false });
  }

  async function deleteSession() {
    if (!state.selectedId) return;
    const name = sessionTitleEl.querySelector('.title')?.textContent || state.selectedId;
    if (!window.confirm(`Delete session "${name}"? It will be moved to storage/trash.`)) return;
    const response = await fetch(`/api/sessions/${state.selectedId}`, { method: 'DELETE' });
    if (!response.ok) { const d = await response.json(); window.alert(d.error || 'Failed to delete session'); return; }
    state.selectedId = null;
    state.hasActiveSession = false;
    updateSessionControls(false);
    updateLoadMoreVisibility(false);
    sessionTitleEl.querySelector('.title').textContent = 'Select a session';
    sessionMeta.textContent = '';
    messageList.innerHTML = '';
    await loadSessions();
    await loadTrashSessions();
  }

  // Usage panel
  function toggleUsagePanel() {
    if (!usageModal) return;
    const shouldOpen = usageModal.hasAttribute('hidden');
    if (shouldOpen) { usageModal.removeAttribute('hidden'); loadCodexStatus(); }
    else { usageModal.setAttribute('hidden', ''); }
  }

  function formatUsageReset(resetAt) {
    if (!resetAt) return '';
    const date = new Date(resetAt);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    if (sameDay) return time;
    return `${time} on ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  }

  function formatUsageBar(percentLeft) {
    const width = 20;
    if (percentLeft == null) return `[${'░'.repeat(width)}]`;
    const clamped = Math.max(0, Math.min(100, percentLeft));
    const filled = Math.round((clamped / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
  }

  function buildLimitLine(limit) {
    const label = limit.label || 'limit';
    const percentLeft = typeof limit.remainingPct === 'number' ? limit.remainingPct : null;
    const resetText = formatUsageReset(limit.resetAt);
    const resetSuffix = resetText ? `\nresets ${resetText}` : '';
    if (limit.errorMessage) return { label, barLine: limit.errorMessage };
    const usageText = percentLeft == null ? '? left' : `${Math.round(percentLeft)}% left`;
    return { label, barLine: `${formatUsageBar(percentLeft)} ${usageText}${resetSuffix}` };
  }

  function displayProviderLabel(id) {
    if (id === 'openai' || id === 'codex') return 'codex';
    if (id === 'google' || id === 'gemini') return 'gemini';
    if (id === 'anthropic' || id === 'claude') return 'claude';
    return id;
  }

  function renderUsageProviders(providers, registeredProviders) {
    if (!usageOutput) return;
    usageOutput.innerHTML = '';
    const headerEl = document.createElement('div');
    headerEl.className = 'usage-registered';
    const ordered = [];
    if (Array.isArray(providers)) providers.forEach(p => { const l = displayProviderLabel(p?.id || p?.name); if (l && !ordered.includes(l)) ordered.push(l); });
    if (Array.isArray(registeredProviders)) registeredProviders.forEach(i => { const l = displayProviderLabel(i); if (!ordered.includes(l)) ordered.push(l); });
    headerEl.textContent = ordered.length ? `Registered: ${ordered.join(', ')}` : 'Registered: none';
    const list = document.createElement('div');
    list.className = 'usage-cards';
    if (!Array.isArray(providers) || !providers.length) { usageOutput.textContent = 'No registered providers with usage data.'; return; }
    providers.forEach(provider => {
      const card = document.createElement('div');
      card.className = 'usage-card';
      const hdr = document.createElement('div');
      hdr.className = 'usage-card-header';
      const t = document.createElement('div');
      t.className = 'usage-card-title';
      t.textContent = provider.name || 'Provider';
      const m = document.createElement('div');
      m.className = 'usage-card-meta';
      if (provider.account?.type === 'chatgpt') { m.textContent = `${provider.account.email || 'unknown'}${provider.account.planType ? ` / ${provider.account.planType}` : ''}`; }
      else if (provider.account?.type === 'apiKey') { m.textContent = 'API key'; }
      else if (provider.requiresOpenaiAuth) { m.textContent = 'Login required'; }
      hdr.append(t, m);
      const summary = document.createElement('div');
      summary.className = 'usage-card-summary';
      const limits = Array.isArray(provider.limits) ? provider.limits : [];
      if (limits[0]) {
        const sl = buildLimitLine(limits[0]);
        const lb = document.createElement('div'); lb.className = 'usage-limit-label'; lb.textContent = sl.label;
        const bl = document.createElement('div'); bl.className = 'usage-limit-bar'; bl.textContent = sl.barLine;
        summary.append(lb, bl);
      } else { summary.textContent = 'No usage data.'; }
      const details = document.createElement('details');
      details.className = 'usage-details';
      const ds = document.createElement('summary');
      ds.textContent = '\uC0C1\uC138\uBCF4\uAE30';
      details.addEventListener('toggle', () => { ds.textContent = details.open ? '\uC811\uAE30' : '\uC0C1\uC138\uBCF4\uAE30'; });
      const db = document.createElement('div');
      db.className = 'usage-details-body';
      limits.slice(1).forEach(limit => {
        const block = document.createElement('div'); block.className = 'usage-limit-block';
        const line = buildLimitLine(limit);
        const lb = document.createElement('div'); lb.className = 'usage-limit-label'; lb.textContent = line.label;
        const bl = document.createElement('div'); bl.className = 'usage-limit-bar'; bl.textContent = line.barLine;
        block.append(lb, bl); db.append(block);
      });
      if (provider.accountError) { const el = document.createElement('div'); el.textContent = `Account error: ${provider.accountError}`; db.append(el); }
      if (provider.updatedAt) { const el = document.createElement('div'); const d = new Date(provider.updatedAt); el.textContent = Number.isNaN(d.getTime()) ? `Updated: ${provider.updatedAt}` : `Updated: ${d.toLocaleString()}`; db.append(el); }
      details.append(ds, db);
      card.append(hdr, summary, details);
      list.append(card);
    });
    usageOutput.append(headerEl, list);
  }

  async function loadCodexStatus() {
    if (!usageOutput) return;
    usageOutput.textContent = 'Loading...';
    try {
      const response = await fetch('/api/usage/providers');
      const data = await response.json();
      if (!response.ok) throw new Error(`${data?.error || 'Failed'}${data?.details ? '\n' + data.details : ''}`);
      renderUsageProviders(data.providers, data.registeredProviders);
    } catch (err) { usageOutput.textContent = err?.message || 'Failed to load codex status'; }
  }

  // Trash panel
  function toggleTrashPanel() {
    if (!trashModal) return;
    const shouldOpen = trashModal.hasAttribute('hidden');
    if (shouldOpen) { trashModal.removeAttribute('hidden'); loadTrashSessions(); }
    else { trashModal.setAttribute('hidden', ''); }
  }

  async function restoreTrashSession(trashId) {
    const r = await fetch(`/api/trash/sessions/${trashId}/restore`, { method: 'POST' });
    if (!r.ok) { window.alert('Failed to restore'); return; }
    await loadSessions();
    await loadTrashSessions();
  }

  async function deleteTrashSession(trashId) {
    if (!window.confirm('Permanently delete?')) return;
    const r = await fetch(`/api/trash/sessions/${trashId}`, { method: 'DELETE' });
    if (!r.ok) { window.alert('Failed to delete'); return; }
    await loadTrashSessions();
  }

  async function loadTrashSessions() {
    if (!trashList) return;
    const response = await fetch('/api/trash/sessions');
    const data = await response.json();
    const items = data.items || [];
    if (!items.length) { trashList.innerHTML = '<div class="trash-empty">No trashed sessions.</div>'; return; }
    trashList.innerHTML = '';
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'trash-item';
      const meta = document.createElement('div');
      meta.className = 'trash-meta';
      const t = document.createElement('div');
      t.textContent = item.session?.title || item.session?.slug || item.session?.id || 'Untitled';
      const w = document.createElement('div');
      w.textContent = `Trashed: ${item.trashedAt ? window.formatTime(item.trashedAt) : 'Unknown'}`;
      meta.append(t, w);
      const actions = document.createElement('div');
      actions.className = 'trash-actions';
      const rb = document.createElement('button');
      rb.className = 'ghost'; rb.textContent = 'Restore';
      rb.addEventListener('click', () => restoreTrashSession(item.trashId));
      const db = document.createElement('button');
      db.className = 'ghost danger'; db.textContent = 'Delete';
      db.addEventListener('click', () => deleteTrashSession(item.trashId));
      actions.append(rb, db);
      row.append(meta, actions);
      trashList.appendChild(row);
    });
  }

  // Directory modal
  function openDirectoryModal() {
    if (!directoryModal) return;
    directoryModal.removeAttribute('hidden');
    loadDirectory(state.currentDirectory || state.directoryRoot || null);
  }

  function closeDirectoryModal() { directoryModal?.setAttribute('hidden', ''); }
  function cancelDirectoryModal() { state.pendingSessionTitle = null; closeDirectoryModal(); }

  async function loadDirectory(targetPath) {
    if (!directoryList || !directoryPath) return;
    const hq = state.showHiddenDirectories ? 'showHidden=1' : 'showHidden=0';
    const url = targetPath ? `/api/fs?path=${encodeURIComponent(targetPath)}&${hq}` : `/api/fs?${hq}`;
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) { window.alert(data.error || 'Failed to load directory'); return; }
    state.directoryRoot = data.root;
    state.currentDirectory = data.path;
    directoryPath.textContent = data.path;
    const upBtn = root.querySelector('[data-action="dir-up"]');
    if (upBtn) upBtn.disabled = data.path === data.root;
    directoryList.innerHTML = '';
    const dirs = data.directories || [];
    if (!dirs.length) {
      const empty = document.createElement('div');
      empty.className = 'trash-empty';
      empty.textContent = 'No subfolders.';
      directoryList.appendChild(empty);
      return;
    }
    dirs.forEach(dir => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'directory-item';
      item.textContent = dir.name;
      item.addEventListener('click', () => loadDirectory(dir.path));
      directoryList.appendChild(item);
    });
  }

  function handleDirectoryConfirm() {
    if (!state.currentDirectory) { window.alert('Select a directory first'); return; }
    closeDirectoryModal();
    createSessionWithDirectory(state.currentDirectory);
  }

  // Wire up events via delegation on root
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'new') createSession();
    else if (action === 'refresh') loadSessions();
    else if (action === 'rename') renameSession();
    else if (action === 'delete') deleteSession();
    else if (action === 'usage') toggleUsagePanel();
    else if (action === 'usage-close') usageModal?.setAttribute('hidden', '');
    else if (action === 'usage-refresh') loadCodexStatus();
    else if (action === 'trash') toggleTrashPanel();
    else if (action === 'trash-close') trashModal?.setAttribute('hidden', '');
    else if (action === 'child-close') { childSessionModal?.setAttribute('hidden', ''); if (childSessionBody) childSessionBody.textContent = ''; }
    else if (action === 'dir-up') {
      if (state.currentDirectory && state.directoryRoot && state.currentDirectory !== state.directoryRoot) {
        loadDirectory(state.currentDirectory.split('/').slice(0, -1).join('/') || '/');
      }
    }
    else if (action === 'dir-select') handleDirectoryConfirm();
    else if (action === 'dir-cancel') cancelDirectoryModal();
    else if (action === 'load-more') loadMoreMessages();
  });

  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-action="dir-hidden"]')) {
      state.showHiddenDirectories = Boolean(e.target.checked);
      loadDirectory(state.currentDirectory || state.directoryRoot || null);
    }
  });

  if (sessionSearch) {
    sessionSearch.addEventListener('input', (e) => {
      state.sessionQuery = e.target.value;
      renderSessions();
    });
  }

  if (sendForm) {
    sendForm.addEventListener('submit', sendMessage);
  }

  if (messageInput) {
    messageInput.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (sendForm.requestSubmit) sendForm.requestSubmit();
        else sendForm.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }

  // Initial load + polling
  loadSessions();
  const pollTimer = setInterval(async () => {
    await loadSessions();
    if (state.selectedId) {
      const hadFocus = document.activeElement === messageInput;
      await selectSession(state.selectedId, { preserveDraft: true, focusInput: hadFocus, clearStatus: false, forceAutoScroll: false });
    }
  }, 5000);

  // Return cleanup function for React/Preact useEffect
  return () => clearInterval(pollTimer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions View — wraps the original vanilla JS logic
// ─────────────────────────────────────────────────────────────────────────────

export function SessionsView() {
  const containerRef = useRef(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;
    const cleanup = initLegacySessions(containerRef.current);
    return () => {
      if (typeof cleanup === 'function') cleanup();
      initializedRef.current = false;
    };
  }, []);

  return html`
    <div class="sessions-layout" ref=${containerRef}>
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-title">Palantir Console</div>
          <div class="brand-subtitle">Seeing Stones for AI Sessions</div>
        </div>
        <div class="session-header">
          <span>Sessions</span>
          <div class="session-actions">
            <button class="ghost" data-action="new">New</button>
            <button class="ghost" data-action="refresh">Refresh</button>
          </div>
        </div>
        <div class="session-search">
          <input type="search" placeholder="Filter by title, slug, or directory" data-role="search" />
        </div>
        <div class="session-list" data-role="session-list"></div>
      </aside>
      <main class="content">
        <header class="session-title" data-role="session-title">
          <div class="title-row">
            <div class="title">Select a session</div>
            <div class="session-controls">
              <button class="ghost" data-action="usage">Usage</button>
              <button class="ghost" data-action="trash">Trash</button>
              <button class="ghost" data-action="rename" disabled>Rename</button>
              <button class="ghost danger" data-action="delete" disabled>Delete</button>
            </div>
          </div>
          <div class="meta" data-role="session-meta"></div>
        </header>
        <div class="trash-modal" data-role="trash-modal" hidden>
          <div class="trash-backdrop" data-action="trash-close"></div>
          <div class="trash-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Trashed Sessions</h2>
              <button class="ghost" data-action="trash-close">Close</button>
            </div>
            <div class="trash-list" data-role="trash-list">
              <div class="trash-empty">No trashed sessions.</div>
            </div>
          </div>
        </div>
        <div class="trash-modal" data-role="usage-modal" hidden>
          <div class="trash-backdrop" data-action="usage-close"></div>
          <div class="trash-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Codex Status</h2>
              <div class="usage-actions">
                <button class="ghost" data-action="usage-refresh">Refresh</button>
                <button class="ghost" data-action="usage-close">Close</button>
              </div>
            </div>
            <div class="usage-output" data-role="usage-output">Loading...</div>
          </div>
        </div>
        <div class="trash-modal" data-role="child-modal" hidden>
          <div class="trash-backdrop" data-action="child-close"></div>
          <div class="trash-panel child-panel" role="dialog">
            <div class="trash-header">
              <h2 class="trash-title">Agent Activity</h2>
              <button class="ghost" data-action="child-close">Close</button>
            </div>
            <div class="child-session-body" data-role="child-body">Loading...</div>
          </div>
        </div>
        <div class="directory-modal" data-role="dir-modal" hidden>
          <div class="directory-backdrop" data-action="dir-cancel"></div>
          <div class="directory-panel" role="dialog">
            <div class="directory-header">
              <h2 class="directory-title">Select Directory</h2>
              <button class="ghost" data-action="dir-up">Up</button>
            </div>
            <div class="directory-path" data-role="dir-path">/</div>
            <div class="directory-toggle">
              <label class="directory-toggle-label">
                <input type="checkbox" data-action="dir-hidden" />
                <span>Show hidden folders</span>
              </label>
            </div>
            <div class="directory-list" data-role="dir-list" role="list"></div>
            <div class="directory-actions">
              <button class="primary" data-action="dir-select">Use this folder</button>
              <button class="ghost" data-action="dir-cancel">Cancel</button>
            </div>
          </div>
        </div>
        <section class="conversation" data-role="conversation">
          <div class="message-controls" data-role="load-more-wrap" hidden>
            <button class="ghost load-more" data-action="load-more">Load more</button>
          </div>
          <div class="message-list" data-role="message-list"></div>
        </section>
        <footer class="composer">
          <form data-role="send-form">
            <textarea data-role="message-input" placeholder="Send a message to the selected session..." rows="3" required></textarea>
            <div class="composer-actions">
              <span class="status" data-role="send-status"></span>
              <button type="submit" class="primary">Send</button>
            </div>
          </form>
        </footer>
      </main>
    </div>
  `;
}
