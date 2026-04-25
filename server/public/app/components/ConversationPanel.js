// ConversationPanel — message display + input for a selected session.
// Part of P9-4 SessionsView Preact rewrite.
//
// NOTE: window.marked and window.DOMPurify are loaded via index.html
// <script> tags — they are NOT ES module imports.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useCallback, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { formatTime } from '../lib/format.js';
import { renderMarkdown } from '../lib/markdown.js';
import { Modal } from './Modal.js';

// ── Constants ───────────────────────────────────────────────────────────────

const CLAMP_LINES = 20;
const INITIAL_MESSAGE_LIMIT = 40;
const MESSAGE_LIMIT_STEP = 40;

// ── Helpers ─────────────────────────────────────────────────────────────────

// Phase J: route through the shared `renderMarkdown` helper so this
// panel uses the same `breaks + gfm` flags + DOMPurify config as the
// rest of the app. The earlier inline `marked.parse(...)` call dropped
// `gfm` and skipped the helper's escape fallback for environments
// where marked/DOMPurify haven't loaded.
function renderMarkdownContent(raw) {
  if (raw == null) return '';
  return renderMarkdown(raw);
}

function fingerprintMessages(messages) {
  const last = messages[messages.length - 1];
  return {
    count: messages.length,
    lastId: last?.id || null,
    lastCreatedAt: last?.createdAt || 0,
    lastCompletedAt: last?.completedAt || 0,
  };
}

function fingerprintEqual(a, b) {
  if (!a || !b) return false;
  return a.count === b.count && a.lastId === b.lastId
    && a.lastCreatedAt === b.lastCreatedAt && a.lastCompletedAt === b.lastCompletedAt;
}

// ── Child session modal content ─────────────────────────────────────────────

function ChildSessionCard({ session, messages }) {
  const visible = (messages || []).filter(m => m.content && m.content.trim().length > 0);
  const agent = messages.find(m => m.agent)?.agent || 'unknown';
  const updatedAt = session?.time?.updated || session?.time?.created || null;

  return html`
    <div class="child-session-card">
      <div class="child-session-header">
        <div class="child-session-title">${session.title || session.slug || session.id}</div>
        <div class="child-session-meta">
          agent: ${agent} \u00B7 ${updatedAt ? `updated ${formatTime(updatedAt)}` : 'updated unknown'}
        </div>
      </div>
      <div class="child-session-messages">
        ${visible.length === 0 && html`
          <div class="trash-empty">No messages found for this session.</div>
        `}
        ${visible.map((m, i) => html`
          <div key=${i} class=${`message ${m.role || 'assistant'}`}>
            <div class="role">${m.role || 'assistant'}</div>
            <div class="content" dangerouslySetInnerHTML=${{ __html: renderMarkdownContent(m.content || '[no text]') || '' }}></div>
            <div class="timestamp">${formatTime(m.createdAt)}</div>
          </div>
        `)}
      </div>
    </div>
  `;
}

function ChildSessionViewer({ childIds }) {
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    if (!childIds || !childIds.length) return;
    setResults(null);
    setError(null);
    setActiveTab(0);
    Promise.all(childIds.map(async (id) => {
      const data = await apiFetch(`/api/sessions/${id}?limit=200`);
      if (!data.session) throw new Error(`Failed to load session ${id}`);
      return { session: data.session, messages: data.messages || [] };
    }))
      .then(setResults)
      .catch(e => setError(e?.message || 'Failed to load subagent activity.'));
  }, [childIds]);

  if (error) return html`<div>${error}</div>`;
  if (!results) return html`<div>Loading...</div>`;

  if (results.length === 1) {
    return html`<${ChildSessionCard} session=${results[0].session} messages=${results[0].messages} />`;
  }

  return html`
    <div class="child-session-tabs">
      ${results.map((r, i) => {
        const t = r.session.title || r.session.slug || r.session.id;
        const a = r.messages.find(m => m.agent)?.agent || 'agent';
        return html`
          <button key=${i} type="button"
                  class=${`child-session-tab${i === activeTab ? ' active' : ''}`}
                  onClick=${() => setActiveTab(i)}>${a}: ${t}</button>
        `;
      })}
    </div>
    <div class="child-session-panel">
      <${ChildSessionCard} session=${results[activeTab].session} messages=${results[activeTab].messages} />
    </div>
  `;
}

// ── ClampedMessage ──────────────────────────────────────────────────────────

function ClampedMessage({ msg, onChildClick }) {
  const contentRef = useRef(null);
  const [clamped, setClamped] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const childSessions = Array.isArray(msg.childSessionIds) ? msg.childSessionIds : [];
  const childKinds = Array.isArray(msg.childSessionKinds) ? msg.childSessionKinds : [];
  const hasChildren = childSessions.length > 0;

  // Determine child label
  let childLabel = 'agent';
  if (hasChildren) {
    if (childKinds.includes('background') && !childKinds.includes('subagent')) childLabel = 'background';
    else if (childKinds.includes('subagent') && !childKinds.includes('background')) childLabel = 'subagent';
  }

  // Check overflow after render
  useEffect(() => {
    const el = contentRef.current;
    if (!el || hasChildren) return;
    // Apply clamp, then measure
    el.classList.add('clamped');
    if (el.scrollHeight > el.clientHeight + 1) {
      setOverflows(true);
      setClamped(true);
    } else {
      el.classList.remove('clamped');
      setOverflows(false);
      setClamped(false);
    }
  }, [msg.content, hasChildren]);

  const toggleClamp = useCallback((e) => {
    e.stopPropagation();
    setClamped(prev => !prev);
  }, []);

  const handleWrapClick = useCallback((e) => {
    if (!hasChildren) return;
    if (e.target.closest('a') || e.target.closest('.expand-toggle')) return;
    if (window.getSelection && window.getSelection().toString()) return;
    onChildClick(msg);
  }, [hasChildren, msg, onChildClick]);

  const rawHtml = renderMarkdownContent(msg.content || '[no text]');

  return html`
    <div class=${`message ${msg.role || 'assistant'}${hasChildren ? ' has-children' : ''}`}
         title=${hasChildren ? 'Click to view agent activity' : ''}
         onClick=${handleWrapClick}>
      <div class="role">
        ${hasChildren ? `${msg.role || 'assistant'} \u00B7 ${childLabel}` : (msg.role || 'assistant')}
      </div>
      <div class=${`content${clamped ? ' clamped' : ''}`}
           style=${`--clamp-lines: ${CLAMP_LINES}`}
           ref=${contentRef}
           dangerouslySetInnerHTML=${{ __html: rawHtml || '' }}>
      </div>
      ${!hasChildren && overflows && html`
        <button class="expand-toggle" type="button"
                aria-expanded=${!clamped ? 'true' : 'false'}
                onClick=${toggleClamp}>
          ${clamped ? 'Expand' : 'Collapse'}
        </button>
      `}
      <div class="timestamp">${formatTime(msg.createdAt)}</div>
    </div>
  `;
}

// ── ConversationPanel ───────────────────────────────────────────────────────

export function ConversationPanel({ sessionId, session, onTitleUpdate }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [sendStatus, setSendStatus] = useState('');
  const [childModal, setChildModal] = useState(null); // { childSessionIds }
  const [messageLimit, setMessageLimit] = useState(INITIAL_MESSAGE_LIMIT);

  const conversationRef = useRef(null);
  const inputRef = useRef(null);
  const fingerprintRef = useRef(null);
  const requestIdRef = useRef(0);
  const autoScrollRef = useRef(false);
  const prevSessionIdRef = useRef(null);

  // Reset state when session changes
  useEffect(() => {
    if (sessionId !== prevSessionIdRef.current) {
      prevSessionIdRef.current = sessionId;
      setMessages([]);
      setHasMore(false);
      setSendStatus('');
      setMessageLimit(INITIAL_MESSAGE_LIMIT);
      fingerprintRef.current = null;
      autoScrollRef.current = true;
    }
  }, [sessionId]);

  // Load messages
  const loadMessages = useCallback(async (opts = {}) => {
    if (!sessionId) return;
    const { limit = messageLimit, forceAutoScroll = false, preserveScroll = false, forceRender = false } = opts;
    const reqId = ++requestIdRef.current;
    const fetchLimit = limit + 1;

    const data = await apiFetch(`/api/sessions/${sessionId}?limit=${fetchLimit}`);
    if (reqId !== requestIdRef.current) return; // stale

    if (!data.session) return;

    // Update title in parent if changed
    if (onTitleUpdate) {
      onTitleUpdate(data.session);
    }

    const msgs = data.messages || [];
    const moreAvailable = msgs.length > limit;
    const display = moreAvailable ? msgs.slice(Math.max(0, msgs.length - limit)) : msgs;
    const fp = fingerprintMessages(display);

    if (!forceRender && fingerprintEqual(fp, fingerprintRef.current)) {
      setHasMore(moreAvailable);
      return;
    }

    const shouldScroll = forceAutoScroll || autoScrollRef.current;
    autoScrollRef.current = false;

    // Capture scroll position before update if preserving
    const scrollSnap = preserveScroll && conversationRef.current
      ? { height: conversationRef.current.scrollHeight, top: conversationRef.current.scrollTop }
      : null;

    fingerprintRef.current = fp;
    setMessages(display.filter(m => m.content && m.content.trim().length > 0));
    setHasMore(moreAvailable);

    // Schedule scroll after render
    requestAnimationFrame(() => {
      if (scrollSnap && conversationRef.current) {
        conversationRef.current.scrollTop = scrollSnap.top + (conversationRef.current.scrollHeight - scrollSnap.height);
      } else if (shouldScroll && conversationRef.current) {
        conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
      }
    });
  }, [sessionId, messageLimit, onTitleUpdate]);

  // Initial load + polling
  useEffect(() => {
    if (!sessionId) return;
    loadMessages({ forceAutoScroll: true, forceRender: true });
    const timer = setInterval(() => {
      loadMessages();
    }, 5000);
    return () => clearInterval(timer);
  }, [sessionId, loadMessages]);

  // Load more
  const handleLoadMore = useCallback(() => {
    const newLimit = messageLimit + MESSAGE_LIMIT_STEP;
    setMessageLimit(newLimit);
    loadMessages({ limit: newLimit, preserveScroll: true, forceRender: true });
  }, [messageLimit, loadMessages]);

  // Send message
  const handleSend = useCallback(async (e) => {
    e.preventDefault();
    if (!sessionId || !inputRef.current) return;
    const content = inputRef.current.value.trim();
    if (!content) return;
    setSendStatus('Sending...');
    inputRef.current.value = '';

    const data = await apiFetch(`/api/sessions/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    setSendStatus(data.status === 'ok' ? 'Sent.' : 'Failed to send.');

    // Poll for the new message to appear
    const initialFp = fingerprintRef.current;
    for (let attempt = 0; attempt < 6; attempt++) {
      await loadMessages({ forceAutoScroll: true, forceRender: true });
      const nextFp = fingerprintRef.current;
      if (!initialFp || !nextFp) return;
      if (nextFp.count !== initialFp.count || nextFp.lastId !== initialFp.lastId) return;
      await new Promise(r => setTimeout(r, 800));
    }
  }, [sessionId, loadMessages]);

  // Enter to send
  const handleKeyDown = useCallback((e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const form = e.target.closest('form');
      if (form) {
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    }
  }, []);

  // Child session modal
  const openChildModal = useCallback((msg) => {
    const ids = msg.childSessionIds || [];
    if (ids.length) setChildModal({ childSessionIds: ids });
  }, []);

  const closeChildModal = useCallback(() => setChildModal(null), []);

  if (!sessionId) {
    return html`
      <section class="conversation" data-role="conversation">
        <div class="message-list" data-role="message-list">
          <div class="meta">Select a session to view messages.</div>
        </div>
      </section>
      <footer class="composer">
        <form data-role="send-form">
          <textarea data-role="message-input" placeholder="Send a message to the selected session..." rows="3" required disabled></textarea>
          <div class="composer-actions">
            <span class="status" data-role="send-status"></span>
            <button type="submit" class="primary" disabled>Send</button>
          </div>
        </form>
      </footer>
    `;
  }

  return html`
    <${Modal} open=${!!childModal} onClose=${closeChildModal}
              labelledBy="child-modal-title" panelClass="trash-panel child-panel">
      <div class="trash-header" data-role="child-modal">
        <h2 class="trash-title" id="child-modal-title">Agent Activity</h2>
        <button class="ghost" onClick=${closeChildModal}>Close</button>
      </div>
      <div class="child-session-body" data-role="child-body">
        ${childModal && html`<${ChildSessionViewer} childIds=${childModal.childSessionIds} />`}
      </div>
    </Modal>
    <section class="conversation" data-role="conversation" ref=${conversationRef}>
      <div class="message-controls" data-role="load-more-wrap" hidden=${!hasMore || !sessionId}>
        <button class="ghost load-more" data-action="load-more"
                disabled=${!hasMore} onClick=${handleLoadMore}>Load more</button>
      </div>
      <div class="message-list" data-role="message-list">
        ${messages.length === 0 && html`
          <div class="meta">No messages found for this session.</div>
        `}
        ${messages.map((msg, i) => html`
          <${ClampedMessage} key=${msg.id || i} msg=${msg} onChildClick=${openChildModal} />
        `)}
      </div>
    </section>
    <footer class="composer">
      <form data-role="send-form" onSubmit=${handleSend}>
        <textarea data-role="message-input" ref=${inputRef}
                  placeholder="Send a message to the selected session..." rows="3" required
                  onKeyDown=${handleKeyDown}></textarea>
        <div class="composer-actions">
          <span class="status" data-role="send-status">${sendStatus}</span>
          <button type="submit" class="primary">Send</button>
        </div>
      </form>
    </footer>
  `;
}
