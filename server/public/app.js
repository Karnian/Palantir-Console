const sessionList = document.getElementById('sessionList');
const sessionTitle = document.getElementById('sessionTitle');
const sessionMeta = document.getElementById('sessionMeta');
const messageList = document.getElementById('messageList');
const conversation = document.querySelector('.conversation');
const loadMoreWrap = document.getElementById('loadMoreWrap');
const loadMoreBtn = document.getElementById('loadMoreBtn');
const sendForm = document.getElementById('sendForm');
const messageInput = document.getElementById('messageInput');
const sendStatus = document.getElementById('sendStatus');
const refreshBtn = document.getElementById('refreshBtn');
const sessionSearch = document.getElementById('sessionSearch');
const newSessionBtn = document.getElementById('newSessionBtn');
const renameSessionBtn = document.getElementById('renameSessionBtn');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');
const usageToggleBtn = document.getElementById('usageToggleBtn');
const trashToggleBtn = document.getElementById('trashToggleBtn');
const usageModal = document.getElementById('usageModal');
const usagePanel = document.getElementById('usagePanel');
const usageBackdrop = document.getElementById('usageBackdrop');
const usageOutput = document.getElementById('usageOutput');
const usageCloseBtn = document.getElementById('usageCloseBtn');
const usageRefreshBtn = document.getElementById('usageRefreshBtn');
const trashModal = document.getElementById('trashModal');
const trashPanel = document.getElementById('trashPanel');
const trashList = document.getElementById('trashList');
const trashCloseBtn = document.getElementById('trashCloseBtn');
const directoryModal = document.getElementById('directoryModal');
const directoryBackdrop = document.getElementById('directoryBackdrop');
const directoryPath = document.getElementById('directoryPath');
const directoryList = document.getElementById('directoryList');
const directoryUpBtn = document.getElementById('directoryUpBtn');
const directorySelectBtn = document.getElementById('directorySelectBtn');
const directoryCancelBtn = document.getElementById('directoryCancelBtn');
const directoryHiddenToggle = document.getElementById('directoryHiddenToggle');

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
  showHiddenDirectories: false
};

const CLAMP_LINES = 20;
const INITIAL_MESSAGE_LIMIT = 40;
const MESSAGE_LIMIT_STEP = 40;
const MARKDOWN_OPTIONS = {
  breaks: true,
  gfm: true
};

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

function formatTime(ms) {
  if (!ms) return 'unknown';
  const date = new Date(ms);
  return date.toLocaleString();
}

function formatProviderModel(session) {
  if (!session) return 'unknown';
  const model = session.lastModelId || null;
  if (model) return model;
  const provider = session.lastProviderId || null;
  if (provider) return provider;
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
  card.addEventListener('click', () =>
    selectSession(session.id, { focusInput: true, forceAutoScroll: true })
  );
  return card;
}

function updateSessionCard(card, session) {
  const activeClass = session.id === state.selectedId ? 'active' : '';
  const desiredClass = `session-card ${activeClass}`.trim();
  if (card.className !== desiredClass) {
    card.className = desiredClass;
  }
  card.dataset.sessionId = session.id;

  const title = card.querySelector('.title');
  if (title) title.textContent = session.title;

  const directoryMeta = card.querySelector('.meta-directory');
  if (directoryMeta) directoryMeta.textContent = session.directory || 'No directory';

  const providerMeta = card.querySelector('.meta-provider');
  if (providerMeta) providerMeta.textContent = formatProviderModel(session);

  const timeMeta = card.querySelector('.meta-time');
  if (timeMeta) timeMeta.textContent = `Last activity: ${formatTime(session.lastActivity)}`;

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

function renderSessions() {
  if (!state.sessions.length) {
    sessionList.innerHTML = '<div class="meta">No sessions found.</div>';
    return;
  }

  const query = state.sessionQuery.trim().toLowerCase();
  const eligible = state.sessions.filter((session) => {
    if (!session.hasUserMessage) return false;
    if (isSubagentSession(session)) return false;
    if (isBackgroundSession(session)) return false;
    if (isTaskSession(session)) return false;
    return true;
  });
  const filtered = query
    ? eligible.filter((session) => getSessionSearchText(session).includes(query))
    : eligible;

  if (!filtered.length) {
    sessionList.innerHTML = query
      ? '<div class="meta">No matching sessions.</div>'
      : '<div class="meta">No user sessions found.</div>';
    return;
  }

  const cards = Array.from(sessionList.querySelectorAll('.session-card'));
  const existing = new Map(cards.map((card) => [card.dataset.sessionId, card]));
  const nextOrder = filtered.map((session) => session.id);
  const currentOrder = cards.map((card) => card.dataset.sessionId);
  const sameOrder =
    currentOrder.length === nextOrder.length &&
    currentOrder.every((id, index) => id === nextOrder[index]);

  if (sameOrder) {
    filtered.forEach((session) => {
      const card = existing.get(session.id) || createSessionCard(session);
      updateSessionCard(card, session);
    });
    return;
  }

  const fragment = document.createDocumentFragment();
  const used = new Set();
  filtered.forEach((session) => {
    let card = existing.get(session.id);
    if (!card) {
      card = createSessionCard(session);
    }
    updateSessionCard(card, session);
    fragment.appendChild(card);
    used.add(session.id);
  });

  sessionList.innerHTML = '';
  sessionList.appendChild(fragment);
}

function getSessionSearchText(session) {
  return [session.title, session.slug, session.directory].filter(Boolean).join(' ').toLowerCase();
}

function isSubagentSession(session) {
  const marker = `${session.title || ''} ${session.slug || ''}`.toLowerCase();
  return marker.includes('subagent') || marker.includes('sub agent') || marker.includes('sub-agent');
}

function isBackgroundSession(session) {
  const marker = `${session.title || ''} ${session.slug || ''}`.toLowerCase();
  return marker.includes('background');
}

function isTaskSession(session) {
  const marker = `${session.title || ''} ${session.slug || ''}`.toLowerCase();
  return /\btask\b/.test(marker);
}

function renderMessages(messages, options = {}) {
  const { autoScroll = false, onRendered = null } = options;
  if (window.marked) {
    window.marked.setOptions(MARKDOWN_OPTIONS);
  }
  messageList.innerHTML = '';
  if (!messages.length) {
    messageList.innerHTML = '<div class="meta">No messages found for this session.</div>';
    updateLoadMoreVisibility(false);
    return;
  }

  const visible = messages.filter((msg) => {
    if (!msg.content) return false;
    return msg.content.trim().length > 0;
  });

  if (!visible.length) {
    messageList.innerHTML = '<div class="meta">No text messages in this session.</div>';
    updateLoadMoreVisibility(false);
    return;
  }

  visible.forEach((msg) => {
    const wrap = document.createElement('div');
    wrap.className = `message ${msg.role || 'assistant'}`;

    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = msg.role || 'assistant';

    const content = document.createElement('div');
    content.className = 'content';
    const raw = msg.content || '[no text]';
    if (window.marked && window.DOMPurify) {
      const rendered = window.marked.parse(raw, { breaks: true });
      content.innerHTML = window.DOMPurify.sanitize(rendered);
    } else {
      content.textContent = raw;
    }
    content.style.setProperty('--clamp-lines', CLAMP_LINES);

    const toggle = document.createElement('button');
    toggle.className = 'expand-toggle';
    toggle.type = 'button';
    toggle.textContent = 'Expand';
    toggle.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const isCollapsed = content.classList.contains('clamped');
      if (isCollapsed) {
        content.classList.remove('clamped');
        toggle.textContent = 'Collapse';
        toggle.setAttribute('aria-expanded', 'true');
      } else {
        content.classList.add('clamped');
        toggle.textContent = 'Expand';
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    const time = document.createElement('div');
    time.className = 'timestamp';
    time.textContent = formatTime(msg.createdAt);

    wrap.append(role, content, toggle, time);
    messageList.appendChild(wrap);
  });

  requestAnimationFrame(() => {
    applyMessageClamp();
    if (autoScroll) {
      scrollConversationToBottom();
    }
    if (typeof onRendered === 'function') {
      onRendered();
    }
  });
}

function applyMessageClamp() {
  const items = messageList.querySelectorAll('.message');
  items.forEach((item) => {
    const content = item.querySelector('.content');
    const toggle = item.querySelector('.expand-toggle');
    if (!content || !toggle) return;

    content.classList.add('clamped');
    const isOverflowing = content.scrollHeight > content.clientHeight + 1;
    if (isOverflowing) {
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
  if (!conversation) return;
  conversation.scrollTop = conversation.scrollHeight;
}

async function loadSessions() {
  updateLoadMoreVisibility(false);
  const response = await fetch('/api/sessions');
  const data = await response.json();
  state.sessions = data.sessions || [];
  state.storageRoot = data.storageRoot;
  const hasSelected = state.selectedId && state.sessions.some((session) => session.id === state.selectedId);
  state.hasActiveSession = Boolean(hasSelected);
  updateSessionControls(Boolean(hasSelected));
  renderSessions();
}

async function selectSession(id, options = {}) {
  const {
    preserveDraft = false,
    focusInput = false,
    clearStatus = true,
    forceRender = false,
    preserveScrollPosition = false,
    forceAutoScroll = false
  } = options;
  const previousId = state.selectedId;
  if (id !== previousId) {
    state.messageLimitBySession.set(id, INITIAL_MESSAGE_LIMIT);
  }
  const shouldAutoScroll = (forceAutoScroll || id !== previousId) && !preserveScrollPosition;
  const scrollSnapshot =
    preserveScrollPosition && conversation
      ? { height: conversation.scrollHeight, top: conversation.scrollTop }
      : null;
  state.selectedId = id;
  renderSessions();
  if (clearStatus) {
    sendStatus.textContent = '';
  }
  if (!preserveDraft) {
    messageInput.value = '';
  }
  if (focusInput) {
    messageInput.focus();
  }
  const messageLimit = getMessageLimit(id);
  const requestLimit = messageLimit + 1;
  const response = await fetch(`/api/sessions/${id}?limit=${requestLimit}`);
  const data = await response.json();

  if (!data.session) {
    state.hasActiveSession = false;
    sessionTitle.querySelector('.title').textContent = 'Session not found';
    sessionMeta.textContent = '';
    messageList.innerHTML = '';
    updateLoadMoreVisibility(false);
    updateSessionControls(false);
    return;
  }

  state.hasActiveSession = true;
  updateSessionControls(true);

  sessionTitle.querySelector('.title').textContent = data.session.title || data.session.slug || data.session.id;
  sessionMeta.textContent = `${data.session.directory || 'No directory'} · Updated ${formatTime(data.session.time?.updated)}`;

  const messages = data.messages || [];
  const hasMoreMessages = messages.length > messageLimit;
  const displayMessages = hasMoreMessages
    ? messages.slice(Math.max(0, messages.length - messageLimit))
    : messages;
  const last = displayMessages[displayMessages.length - 1];
  const fingerprint = {
    count: displayMessages.length,
    lastId: last?.id || null,
    lastCreatedAt: last?.createdAt || 0,
    lastCompletedAt: last?.completedAt || 0
  };
  const previous = state.messageFingerprints.get(id);
  const changed =
    !previous ||
    previous.count !== fingerprint.count ||
    previous.lastId !== fingerprint.lastId ||
    previous.lastCreatedAt !== fingerprint.lastCreatedAt ||
    previous.lastCompletedAt !== fingerprint.lastCompletedAt;

  const shouldRender = forceRender || id !== previousId || changed;
  if (shouldRender) {
    renderMessages(displayMessages, {
      autoScroll: shouldAutoScroll,
      onRendered: () => {
        if (!scrollSnapshot || !conversation) return;
        const nextHeight = conversation.scrollHeight;
        conversation.scrollTop = scrollSnapshot.top + (nextHeight - scrollSnapshot.height);
      }
    });
    state.messageFingerprints.set(id, fingerprint);
  }
  updateLoadMoreVisibility(hasMoreMessages);
}

async function loadMoreMessages() {
  if (!state.selectedId) return;
  const currentLimit = getMessageLimit(state.selectedId);
  const nextLimit = currentLimit + MESSAGE_LIMIT_STEP;
  state.messageLimitBySession.set(state.selectedId, nextLimit);
  if (loadMoreBtn) {
    loadMoreBtn.disabled = true;
  }
  await selectSession(state.selectedId, {
    preserveDraft: true,
    focusInput: false,
    clearStatus: false,
    forceRender: true,
    preserveScrollPosition: true
  });
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
    body: JSON.stringify({ content })
  });

  const data = await response.json();
  sendStatus.textContent = data.status === 'ok' ? 'Sent.' : 'Failed to send.';
  await refreshSessionAfterSend();
}

async function refreshSessionAfterSend() {
  const sessionId = state.selectedId;
  if (!sessionId) return;
  const initial = state.messageFingerprints.get(sessionId);
  const maxAttempts = 6;
  const delayMs = 800;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await selectSession(sessionId, { forceAutoScroll: true, forceRender: true });
    const next = state.messageFingerprints.get(sessionId);
    if (!initial || !next) return;
    if (next.count !== initial.count || next.lastId !== initial.lastId) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    body: JSON.stringify({ title: state.pendingSessionTitle, directory })
  });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to create session');
    return;
  }
  state.pendingSessionTitle = null;
  await loadSessions();
  if (data.session?.id) {
    await selectSession(data.session.id, { focusInput: true, forceAutoScroll: true });
  }
}

async function renameSession() {
  if (!state.selectedId) return;
  const current = sessionTitle.querySelector('.title')?.textContent || '';
  const title = window.prompt('Rename session', current);
  if (!title) return;
  const response = await fetch(`/api/sessions/${state.selectedId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.trim() })
  });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to rename session');
    return;
  }
  await loadSessions();
  await selectSession(state.selectedId, { preserveDraft: true, focusInput: false, clearStatus: false, forceAutoScroll: false });
}

async function deleteSession() {
  if (!state.selectedId) return;
  const name = sessionTitle.querySelector('.title')?.textContent || state.selectedId;
  const confirmed = window.confirm(`Delete session "${name}"? It will be moved to storage/trash.`);
  if (!confirmed) return;
  const response = await fetch(`/api/sessions/${state.selectedId}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to delete session');
    return;
  }
  state.selectedId = null;
  state.hasActiveSession = false;
  updateSessionControls(false);
  updateLoadMoreVisibility(false);
  sessionTitle.querySelector('.title').textContent = 'Select a session';
  sessionMeta.textContent = '';
  messageList.innerHTML = '';
  await loadSessions();
  await loadTrashSessions();
}

function toggleUsagePanel() {
  if (!usageModal || !usageToggleBtn) return;
  const shouldOpen = usageModal.hasAttribute('hidden');
  if (shouldOpen) {
    usageModal.removeAttribute('hidden');
    usageToggleBtn.setAttribute('aria-expanded', 'true');
    loadCodexStatus();
  } else {
    usageModal.setAttribute('hidden', '');
    usageToggleBtn.setAttribute('aria-expanded', 'false');
  }
}

function closeUsagePanel() {
  if (!usageModal || !usageToggleBtn) return;
  usageModal.setAttribute('hidden', '');
  usageToggleBtn.setAttribute('aria-expanded', 'false');
}

function formatUsageReset(resetAt) {
  if (!resetAt) return '';
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return time;
  const dateLabel = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${time} on ${dateLabel}`;
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
  if (limit.errorMessage) {
    return {
      label,
      barLine: limit.errorMessage
    };
  }
  const usageText = percentLeft == null ? '? left' : `${Math.round(percentLeft)}% left`;
  return {
    label,
    barLine: `${formatUsageBar(percentLeft)} ${usageText}${resetSuffix}`
  };
}

function displayProviderLabel(id) {
  if (id === 'openai' || id === 'codex') return 'codex';
  if (id === 'google' || id === 'gemini') return 'gemini';
  if (id === 'anthropic' || id === 'claude') return 'claude';
  return id;
}

function formatRegisteredProviders(list, providers) {
  if (!Array.isArray(list) || !list.length) return 'Registered: none';
  const ordered = [];
  if (Array.isArray(providers) && providers.length) {
    providers.forEach((provider) => {
      const id = provider?.id || provider?.name;
      if (!id) return;
      const label = displayProviderLabel(id);
      if (!ordered.includes(label)) ordered.push(label);
    });
  }

  list.forEach((item) => {
    const label = displayProviderLabel(item);
    if (!ordered.includes(label)) ordered.push(label);
  });
  return `Registered: ${ordered.join(', ')}`;
}

function renderUsageProviders(providers, registeredProviders) {
  if (!usageOutput) return;
  usageOutput.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'usage-registered';
  header.textContent = formatRegisteredProviders(registeredProviders, providers);

  const list = document.createElement('div');
  list.className = 'usage-cards';

  if (!Array.isArray(providers) || !providers.length) {
    usageOutput.textContent = 'No registered providers with usage data.';
    return;
  }

  providers.forEach((provider) => {
    const card = document.createElement('div');
    card.className = 'usage-card';

    const header = document.createElement('div');
    header.className = 'usage-card-header';

    const title = document.createElement('div');
    title.className = 'usage-card-title';
    title.textContent = provider.name || 'Provider';

    const meta = document.createElement('div');
    meta.className = 'usage-card-meta';
    if (provider.account?.type === 'chatgpt') {
      const accountLabel = provider.account.email || 'unknown';
      const planLabel = provider.account.planType ? ` / ${provider.account.planType}` : '';
      meta.textContent = `${accountLabel}${planLabel}`;
    } else if (provider.account?.type === 'apiKey') {
      meta.textContent = 'API key';
    } else if (provider.requiresOpenaiAuth) {
      meta.textContent = 'Login required';
    }

    header.append(title, meta);

    const summary = document.createElement('div');
    summary.className = 'usage-card-summary';
    const limits = Array.isArray(provider.limits) ? provider.limits : [];
    const firstLimit = limits[0] || null;
    if (firstLimit) {
      const summaryLine = buildLimitLine(firstLimit);
      const label = document.createElement('div');
      label.className = 'usage-limit-label';
      label.textContent = summaryLine.label;
      const barLine = document.createElement('div');
      barLine.className = 'usage-limit-bar';
      barLine.textContent = summaryLine.barLine;
      summary.append(label, barLine);
    } else {
      summary.textContent = 'No usage data.';
    }

    const details = document.createElement('details');
    details.className = 'usage-details';
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = '상세보기';

    details.addEventListener('toggle', () => {
      detailsSummary.textContent = details.open ? '접기' : '상세보기';
    });

    const detailsBody = document.createElement('div');
    detailsBody.className = 'usage-details-body';

    const detailLimits = limits.length > 1 ? limits.slice(1) : [];
    if (detailLimits.length) {
      detailLimits.forEach((limit) => {
        const block = document.createElement('div');
        block.className = 'usage-limit-block';
        const line = buildLimitLine(limit);
        const label = document.createElement('div');
        label.className = 'usage-limit-label';
        label.textContent = line.label;
        const barLine = document.createElement('div');
        barLine.className = 'usage-limit-bar';
        barLine.textContent = line.barLine;
        block.append(label, barLine);
        detailsBody.append(block);
      });
    }

    if (provider.accountError) {
      const errorLine = document.createElement('div');
      errorLine.textContent = `Account error: ${provider.accountError}`;
      detailsBody.append(errorLine);
    }

    if (provider.updatedAt) {
      const updatedLine = document.createElement('div');
      const localUpdated = new Date(provider.updatedAt);
      updatedLine.textContent = Number.isNaN(localUpdated.getTime())
        ? `Updated: ${provider.updatedAt}`
        : `Updated: ${localUpdated.toLocaleString()}`;
      detailsBody.append(updatedLine);
    }

    details.append(detailsSummary, detailsBody);

    card.append(header, summary, details);
    list.append(card);
  });

  usageOutput.append(header, list);
}

async function loadCodexStatus() {
  if (!usageOutput) return;
  usageOutput.textContent = 'Loading...';
  try {
    const response = await fetch('/api/usage/providers');
    const data = await response.json();
    if (!response.ok) {
      const details = data?.details ? `\n${data.details}` : '';
      throw new Error(`${data?.error || 'Failed to load codex status'}${details}`);
    }
    renderUsageProviders(data.providers, data.registeredProviders);
  } catch (err) {
    usageOutput.textContent = err?.message || 'Failed to load codex status';
  }
}

function toggleTrashPanel() {
  if (!trashModal || !trashToggleBtn) return;
  const shouldOpen = trashModal.hasAttribute('hidden');
  if (shouldOpen) {
    trashModal.removeAttribute('hidden');
    trashToggleBtn.setAttribute('aria-expanded', 'true');
    loadTrashSessions();
  } else {
    trashModal.setAttribute('hidden', '');
    trashToggleBtn.setAttribute('aria-expanded', 'false');
  }
}

function closeTrashPanel() {
  if (!trashModal || !trashToggleBtn) return;
  trashModal.setAttribute('hidden', '');
  trashToggleBtn.setAttribute('aria-expanded', 'false');
}

function formatTrashMeta(trashedAt, session) {
  const title = session?.title || session?.slug || session?.id || 'Untitled session';
  const when = trashedAt ? formatTime(trashedAt) : 'Unknown time';
  return { title, when };
}

async function restoreTrashSession(trashId) {
  const response = await fetch(`/api/trash/sessions/${trashId}/restore`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to restore session');
    return;
  }
  await loadSessions();
  await loadTrashSessions();
}

async function deleteTrashSession(trashId) {
  const confirmed = window.confirm('Permanently delete this trashed session? This cannot be undone.');
  if (!confirmed) return;
  const response = await fetch(`/api/trash/sessions/${trashId}`, { method: 'DELETE' });
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to delete trashed session');
    return;
  }
  await loadTrashSessions();
}

async function loadTrashSessions() {
  if (!trashList) return;
  const response = await fetch('/api/trash/sessions');
  const data = await response.json();
  const items = data.items || [];
  if (!items.length) {
    trashList.innerHTML = '<div class="trash-empty">No trashed sessions.</div>';
    return;
  }
  trashList.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'trash-item';

    const meta = document.createElement('div');
    meta.className = 'trash-meta';
    const { title, when } = formatTrashMeta(item.trashedAt, item.session);
    const titleEl = document.createElement('div');
    titleEl.textContent = title;
    const whenEl = document.createElement('div');
    whenEl.textContent = `Trashed: ${when}`;
    meta.append(titleEl, whenEl);

    const actions = document.createElement('div');
    actions.className = 'trash-actions';
    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'ghost';
    restoreBtn.type = 'button';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => restoreTrashSession(item.trashId));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'ghost danger';
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteTrashSession(item.trashId));
    actions.append(restoreBtn, deleteBtn);

    row.append(meta, actions);
    trashList.appendChild(row);
  });
}

function openDirectoryModal() {
  if (!directoryModal) return;
  directoryModal.removeAttribute('hidden');
  loadDirectory(state.currentDirectory || state.directoryRoot || null);
}

function closeDirectoryModal() {
  if (!directoryModal) return;
  directoryModal.setAttribute('hidden', '');
}

function cancelDirectoryModal() {
  state.pendingSessionTitle = null;
  closeDirectoryModal();
}

async function loadDirectory(targetPath) {
  if (!directoryList || !directoryPath) return;
  const hiddenQuery = state.showHiddenDirectories ? 'showHidden=1' : 'showHidden=0';
  const url = targetPath
    ? `/api/fs?path=${encodeURIComponent(targetPath)}&${hiddenQuery}`
    : `/api/fs?${hiddenQuery}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) {
    window.alert(data.error || 'Failed to load directory');
    return;
  }
  state.directoryRoot = data.root;
  state.currentDirectory = data.path;
  directoryPath.textContent = data.path;
  if (directoryUpBtn) {
    directoryUpBtn.disabled = data.path === data.root;
  }
  renderDirectoryList(data.directories || []);
}

function renderDirectoryList(directories) {
  if (!directoryList) return;
  directoryList.innerHTML = '';
  if (!directories.length) {
    const empty = document.createElement('div');
    empty.className = 'trash-empty';
    empty.textContent = 'No subfolders.';
    directoryList.appendChild(empty);
    return;
  }
  directories.forEach((dir) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'directory-item';
    item.textContent = dir.name;
    item.addEventListener('click', () => loadDirectory(dir.path));
    directoryList.appendChild(item);
  });
}

function handleDirectoryConfirm() {
  if (!state.currentDirectory) {
    window.alert('Select a directory first');
    return;
  }
  closeDirectoryModal();
  createSessionWithDirectory(state.currentDirectory);
}

refreshBtn.addEventListener('click', loadSessions);
sendForm.addEventListener('submit', sendMessage);
if (newSessionBtn) newSessionBtn.addEventListener('click', createSession);
if (renameSessionBtn) renameSessionBtn.addEventListener('click', renameSession);
if (deleteSessionBtn) deleteSessionBtn.addEventListener('click', deleteSession);
if (usageToggleBtn) usageToggleBtn.addEventListener('click', toggleUsagePanel);
if (usageCloseBtn) usageCloseBtn.addEventListener('click', closeUsagePanel);
if (usageBackdrop) usageBackdrop.addEventListener('click', closeUsagePanel);
if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', loadCodexStatus);
if (trashToggleBtn) trashToggleBtn.addEventListener('click', toggleTrashPanel);
if (trashCloseBtn) trashCloseBtn.addEventListener('click', closeTrashPanel);
if (directoryBackdrop) directoryBackdrop.addEventListener('click', cancelDirectoryModal);
if (directoryCancelBtn) directoryCancelBtn.addEventListener('click', cancelDirectoryModal);
if (directorySelectBtn) directorySelectBtn.addEventListener('click', handleDirectoryConfirm);
if (directoryHiddenToggle) {
  directoryHiddenToggle.addEventListener('change', (event) => {
    state.showHiddenDirectories = Boolean(event.target.checked);
    loadDirectory(state.currentDirectory || state.directoryRoot || null);
  });
}
if (directoryUpBtn) {
  directoryUpBtn.addEventListener('click', () => {
    if (!state.currentDirectory || !state.directoryRoot) return;
    if (state.currentDirectory === state.directoryRoot) return;
    const parent = state.currentDirectory.split('/').slice(0, -1).join('/') || '/';
    loadDirectory(parent);
  });
}
messageInput.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (sendForm.requestSubmit) {
      sendForm.requestSubmit();
    } else {
      sendForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
  }
});
if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', loadMoreMessages);
}
sessionSearch.addEventListener('input', (event) => {
  state.sessionQuery = event.target.value;
  renderSessions();
});

loadSessions();
setInterval(async () => {
  await loadSessions();
  if (state.selectedId) {
    await selectSession(state.selectedId, {
      preserveDraft: true,
      focusInput: false,
      clearStatus: false,
      forceAutoScroll: false
    });
  }
}, 5000);
