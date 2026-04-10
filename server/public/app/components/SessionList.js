// SessionList — session sidebar list with search/filter.
// Part of P9-4 SessionsView Preact rewrite.

import { h } from '../../vendor/preact.module.js';
import { useState, useCallback, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { formatTime } from '../lib/format.js';

// ── Session filter helpers ──────────────────────────────────────────────────

function isChildSession(s) { return Boolean(s.parentId); }
function isSubagentSession(s) {
  const m = `${s.title || ''} ${s.slug || ''}`.toLowerCase();
  return m.includes('subagent') || m.includes('sub agent') || m.includes('sub-agent');
}
function isBackgroundSession(s) {
  return `${s.title || ''} ${s.slug || ''}`.toLowerCase().includes('background');
}
function isTaskSession(s) {
  return /\btask\b/.test(`${s.title || ''} ${s.slug || ''}`.toLowerCase());
}
function getSessionSearchText(s) {
  return [s.title, s.slug, s.directory].filter(Boolean).join(' ').toLowerCase();
}

function formatProviderModel(session) {
  if (!session) return 'unknown';
  if (session.lastModelId) return session.lastModelId;
  if (session.lastProviderId) return session.lastProviderId;
  return 'unknown';
}

// ── SessionList component ───────────────────────────────────────────────────

export function SessionList({ sessions, selectedId, onSelect, onRefresh, onNew }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const eligible = (sessions || []).filter(s => {
      if (!s.hasUserMessage) return false;
      if (isChildSession(s) || isSubagentSession(s) || isBackgroundSession(s) || isTaskSession(s)) return false;
      return true;
    });
    const q = query.trim().toLowerCase();
    return q ? eligible.filter(s => getSessionSearchText(s).includes(q)) : eligible;
  }, [sessions, query]);

  const handleSearch = useCallback((e) => {
    setQuery(e.target.value);
  }, []);

  const handleCardClick = useCallback((id) => {
    onSelect(id, { focusInput: true, forceAutoScroll: true });
  }, [onSelect]);

  return html`
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-title">Palantir Console</div>
        <div class="brand-subtitle">Seeing Stones for AI Sessions</div>
      </div>
      <div class="session-header">
        <span>Sessions</span>
        <div class="session-actions">
          <button class="ghost" data-action="new" onClick=${onNew}>New</button>
          <button class="ghost" data-action="refresh" onClick=${onRefresh}>Refresh</button>
        </div>
      </div>
      <div class="session-search">
        <input type="search" placeholder="Filter by title, slug, or directory"
               data-role="search" value=${query} onInput=${handleSearch} />
      </div>
      <div class="session-list" data-role="session-list">
        ${filtered.length === 0 && html`
          <div class="meta">${query ? 'No matching sessions.' : sessions.length ? 'No user sessions found.' : 'No sessions found.'}</div>
        `}
        ${filtered.map(s => html`
          <${SessionCard} key=${s.id} session=${s} active=${s.id === selectedId}
                          onClick=${() => handleCardClick(s.id)} />
        `)}
      </div>
    </aside>
  `;
}

// ── SessionCard ─────────────────────────────────────────────────────────────

function SessionCard({ session, active, onClick }) {
  return html`
    <div class=${`session-card${active ? ' active' : ''}`}
         data-session-id=${session.id} onClick=${onClick}>
      <div class="title">${session.title}</div>
      <div class="meta meta-directory">${session.directory || 'No directory'}</div>
      <div class="meta meta-provider">${formatProviderModel(session)}</div>
      <span class=${`badge ${session.status || ''}`}>${session.status}</span>
      <div class="meta meta-time">Last activity: ${formatTime(session.lastActivity)}</div>
    </div>
  `;
}
