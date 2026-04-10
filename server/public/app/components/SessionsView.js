// SessionsView — layout shell + session management + modals.
// Rewritten as Preact components in P9-4 (replaces initLegacySessions).

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useCallback, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { SessionList } from './SessionList.js';
import { ConversationPanel } from './ConversationPanel.js';

// ── Usage helpers ───────────────────────────────────────────────────────────

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

// ── UsageModal ──────────────────────────────────────────────────────────────

function UsageModal({ onClose }) {
  const [providers, setProviders] = useState(null);
  const [registered, setRegistered] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setProviders(null);
    setError(null);
    try {
      const data = await apiFetch('/api/usage/providers');
      setProviders(data.providers || []);
      setRegistered(data.registeredProviders || []);
    } catch (e) {
      setError(e?.message || 'Failed to load codex status');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const ordered = [];
  if (Array.isArray(providers)) providers.forEach(p => {
    const l = displayProviderLabel(p?.id || p?.name);
    if (l && !ordered.includes(l)) ordered.push(l);
  });
  if (Array.isArray(registered)) registered.forEach(i => {
    const l = displayProviderLabel(i);
    if (!ordered.includes(l)) ordered.push(l);
  });

  return html`
    <div class="trash-modal" data-role="usage-modal">
      <div class="trash-backdrop" onClick=${onClose}></div>
      <div class="trash-panel" role="dialog">
        <div class="trash-header">
          <h2 class="trash-title">Codex Status</h2>
          <div class="usage-actions">
            <button class="ghost" onClick=${load}>Refresh</button>
            <button class="ghost" onClick=${onClose}>Close</button>
          </div>
        </div>
        <div class="usage-output" data-role="usage-output">
          ${error && html`<div>${error}</div>`}
          ${!error && !providers && 'Loading...'}
          ${!error && providers && providers.length === 0 && 'No registered providers with usage data.'}
          ${!error && providers && providers.length > 0 && html`
            <div class="usage-registered">
              ${ordered.length ? `Registered: ${ordered.join(', ')}` : 'Registered: none'}
            </div>
            <div class="usage-cards">
              ${providers.map((provider, pi) => html`
                <${UsageCard} key=${pi} provider=${provider} />
              `)}
            </div>
          `}
        </div>
      </div>
    </div>
  `;
}

function UsageCard({ provider }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const limits = Array.isArray(provider.limits) ? provider.limits : [];
  const primaryLimit = limits[0];
  const sl = primaryLimit ? buildLimitLine(primaryLimit) : null;

  let accountMeta = '';
  if (provider.account?.type === 'chatgpt') {
    accountMeta = `${provider.account.email || 'unknown'}${provider.account.planType ? ` / ${provider.account.planType}` : ''}`;
  } else if (provider.account?.type === 'apiKey') {
    accountMeta = 'API key';
  } else if (provider.requiresOpenaiAuth) {
    accountMeta = 'Login required';
  }

  return html`
    <div class="usage-card">
      <div class="usage-card-header">
        <div class="usage-card-title">${provider.name || 'Provider'}</div>
        <div class="usage-card-meta">${accountMeta}</div>
      </div>
      <div class="usage-card-summary">
        ${sl ? html`
          <div class="usage-limit-label">${sl.label}</div>
          <div class="usage-limit-bar">${sl.barLine}</div>
        ` : 'No usage data.'}
      </div>
      <details class="usage-details" open=${detailsOpen}
               onToggle=${(e) => setDetailsOpen(e.target.open)}>
        <summary>${detailsOpen ? '접기' : '상세보기'}</summary>
        <div class="usage-details-body">
          ${limits.slice(1).map((limit, i) => {
            const line = buildLimitLine(limit);
            return html`
              <div key=${i} class="usage-limit-block">
                <div class="usage-limit-label">${line.label}</div>
                <div class="usage-limit-bar">${line.barLine}</div>
              </div>
            `;
          })}
          ${provider.accountError && html`<div>Account error: ${provider.accountError}</div>`}
          ${provider.updatedAt && html`<div>Updated: ${(() => {
            const d = new Date(provider.updatedAt);
            return Number.isNaN(d.getTime()) ? provider.updatedAt : d.toLocaleString();
          })()}</div>`}
        </div>
      </details>
    </div>
  `;
}

// ── TrashModal ──────────────────────────────────────────────────────────────

function TrashModal({ onClose, onSessionsChanged }) {
  const [items, setItems] = useState([]);

  const load = useCallback(async () => {
    const data = await apiFetch('/api/trash/sessions');
    setItems(data.items || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const restore = useCallback(async (trashId) => {
    const r = await apiFetch(`/api/trash/sessions/${trashId}/restore`, { method: 'POST' });
    if (r) {
      await load();
      if (onSessionsChanged) onSessionsChanged();
    }
  }, [load, onSessionsChanged]);

  const remove = useCallback(async (trashId) => {
    if (!window.confirm('Permanently delete?')) return;
    await apiFetch(`/api/trash/sessions/${trashId}`, { method: 'DELETE' });
    await load();
  }, [load]);

  return html`
    <div class="trash-modal" data-role="trash-modal">
      <div class="trash-backdrop" onClick=${onClose}></div>
      <div class="trash-panel" role="dialog">
        <div class="trash-header">
          <h2 class="trash-title">Trashed Sessions</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="trash-list" data-role="trash-list">
          ${items.length === 0 && html`<div class="trash-empty">No trashed sessions.</div>`}
          ${items.map(item => html`
            <div key=${item.trashId} class="trash-item">
              <div class="trash-meta">
                <div>${item.session?.title || item.session?.slug || item.session?.id || 'Untitled'}</div>
                <div>Trashed: ${item.trashedAt ? formatTime(item.trashedAt) : 'Unknown'}</div>
              </div>
              <div class="trash-actions">
                <button class="ghost" onClick=${() => restore(item.trashId)}>Restore</button>
                <button class="ghost danger" onClick=${() => remove(item.trashId)}>Delete</button>
              </div>
            </div>
          `)}
        </div>
      </div>
    </div>
  `;
}

// ── DirectoryModal ──────────────────────────────────────────────────────────

function DirectoryModal({ onSelect, onCancel }) {
  const [currentPath, setCurrentPath] = useState(null);
  const [root, setRoot] = useState(null);
  const [dirs, setDirs] = useState([]);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async (targetPath, hidden) => {
    const hq = hidden ? 'showHidden=1' : 'showHidden=0';
    const url = targetPath ? `/api/fs?path=${encodeURIComponent(targetPath)}&${hq}` : `/api/fs?${hq}`;
    try {
      const data = await apiFetch(url);
      setRoot(data.root);
      setCurrentPath(data.path);
      setDirs(data.directories || []);
    } catch (e) {
      window.alert(e?.message || 'Failed to load directory');
    }
  }, []);

  useEffect(() => { load(null, showHidden); }, [load, showHidden]);

  const goUp = useCallback(() => {
    if (currentPath && root && currentPath !== root) {
      load(currentPath.split('/').slice(0, -1).join('/') || '/', showHidden);
    }
  }, [currentPath, root, load, showHidden]);

  const handleToggleHidden = useCallback((e) => {
    const next = Boolean(e.target.checked);
    setShowHidden(next);
    load(currentPath || root || null, next);
  }, [currentPath, root, load]);

  const handleConfirm = useCallback(() => {
    if (!currentPath) { window.alert('Select a directory first'); return; }
    onSelect(currentPath);
  }, [currentPath, onSelect]);

  return html`
    <div class="directory-modal" data-role="dir-modal">
      <div class="directory-backdrop" onClick=${onCancel}></div>
      <div class="directory-panel" role="dialog">
        <div class="directory-header">
          <h2 class="directory-title">Select Directory</h2>
          <button class="ghost" onClick=${goUp} disabled=${!currentPath || currentPath === root}>Up</button>
        </div>
        <div class="directory-path" data-role="dir-path">${currentPath || '/'}</div>
        <div class="directory-toggle">
          <label class="directory-toggle-label">
            <input type="checkbox" checked=${showHidden} onChange=${handleToggleHidden} />
            <span>Show hidden folders</span>
          </label>
        </div>
        <div class="directory-list" data-role="dir-list" role="list">
          ${dirs.length === 0 && html`<div class="trash-empty">No subfolders.</div>`}
          ${dirs.map(dir => html`
            <button key=${dir.path} type="button" class="directory-item"
                    onClick=${() => load(dir.path, showHidden)}>${dir.name}</button>
          `)}
        </div>
        <div class="directory-actions">
          <button class="primary" onClick=${handleConfirm}>Use this folder</button>
          <button class="ghost" onClick=${onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// ── SessionsView (main layout) ─────────────────────────────────────────────

export function SessionsView() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [sessionInfo, setSessionInfo] = useState(null); // { title, meta }
  const [showUsage, setShowUsage] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [showDirModal, setShowDirModal] = useState(false);
  const pendingTitleRef = useRef(null);

  // Load sessions
  const loadSessions = useCallback(async () => {
    const data = await apiFetch('/api/sessions');
    setSessions(data.sessions || []);
  }, []);

  // Initial load + polling
  useEffect(() => {
    loadSessions();
    const timer = setInterval(loadSessions, 5000);
    return () => clearInterval(timer);
  }, [loadSessions]);

  // Session selection
  const handleSelect = useCallback((id) => {
    setSelectedId(id);
    setSessionInfo(null);
  }, []);

  // Title update from ConversationPanel
  const handleTitleUpdate = useCallback((sess) => {
    if (!sess) return;
    setSessionInfo({
      title: sess.title || sess.slug || sess.id,
      meta: `${sess.directory || 'No directory'} \u00B7 Updated ${formatTime(sess.time?.updated)}`,
    });
  }, []);

  // Session CRUD
  const handleNew = useCallback(() => {
    const title = window.prompt('New session title');
    if (!title) return;
    pendingTitleRef.current = title.trim();
    setShowDirModal(true);
  }, []);

  const handleDirSelect = useCallback(async (directory) => {
    if (!pendingTitleRef.current) return;
    setShowDirModal(false);
    try {
      const data = await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: pendingTitleRef.current, directory }),
      });
      pendingTitleRef.current = null;
      await loadSessions();
      if (data.session?.id) {
        setSelectedId(data.session.id);
      }
    } catch (e) {
      window.alert(e?.message || 'Failed to create session');
    }
  }, [loadSessions]);

  const handleDirCancel = useCallback(() => {
    pendingTitleRef.current = null;
    setShowDirModal(false);
  }, []);

  const handleRename = useCallback(async () => {
    if (!selectedId) return;
    const current = sessionInfo?.title || '';
    const title = window.prompt('Rename session', current);
    if (!title) return;
    try {
      await apiFetch(`/api/sessions/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: title.trim() }),
      });
      await loadSessions();
    } catch (e) {
      window.alert(e?.message || 'Failed to rename session');
    }
  }, [selectedId, sessionInfo, loadSessions]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    const name = sessionInfo?.title || selectedId;
    if (!window.confirm(`Delete session "${name}"? It will be moved to storage/trash.`)) return;
    try {
      await apiFetch(`/api/sessions/${selectedId}`, { method: 'DELETE' });
      setSelectedId(null);
      setSessionInfo(null);
      await loadSessions();
    } catch (e) {
      window.alert(e?.message || 'Failed to delete session');
    }
  }, [selectedId, sessionInfo, loadSessions]);

  const hasSelected = selectedId && sessions.some(s => s.id === selectedId);

  return html`
    <div class="sessions-layout">
      <${SessionList} sessions=${sessions} selectedId=${selectedId}
                       onSelect=${handleSelect} onRefresh=${loadSessions} onNew=${handleNew} />
      <main class="content">
        <header class="session-title" data-role="session-title">
          <div class="title-row">
            <div class="title">${sessionInfo?.title || 'Select a session'}</div>
            <div class="session-controls">
              <button class="ghost" data-action="usage" onClick=${() => setShowUsage(true)}>Usage</button>
              <button class="ghost" data-action="trash" onClick=${() => setShowTrash(true)}>Trash</button>
              <button class="ghost" data-action="rename" disabled=${!hasSelected} onClick=${handleRename}>Rename</button>
              <button class="ghost danger" data-action="delete" disabled=${!hasSelected} onClick=${handleDelete}>Delete</button>
            </div>
          </div>
          <div class="meta" data-role="session-meta">${sessionInfo?.meta || ''}</div>
        </header>

        ${showUsage && html`<${UsageModal} onClose=${() => setShowUsage(false)} />`}
        ${showTrash && html`<${TrashModal} onClose=${() => setShowTrash(false)} onSessionsChanged=${loadSessions} />`}
        ${showDirModal && html`<${DirectoryModal} onSelect=${handleDirSelect} onCancel=${handleDirCancel} />`}

        <${ConversationPanel} sessionId=${selectedId} session=${sessionInfo}
                              onTitleUpdate=${handleTitleUpdate} />
      </main>
    </div>
  `;
}
