// MentionInput — textarea wrapper with @mention autocomplete for project
// names. Extracted as part of P3-1 (ESM phase 2, @mention autocomplete).
//
// When the user types `@` as the first non-whitespace character, an inline
// popup appears below the textarea listing matching project names. Keyboard
// navigation (up/down to select, Enter to insert, Esc to dismiss) and mouse
// click both work. On selection the `@partial` prefix is replaced with
// `@projectName ` (trailing space included for quick follow-up text).
//
// P4-5 enhancements:
//   - Project color indicator dot in dropdown items
//   - Recently-used projects sorted first (localStorage palantir.mention.recent)
//   - Empty state message when no projects exist
//
// The component accepts all standard textarea props (value, onInput,
// onKeyDown, placeholder, rows, disabled, class, etc.) plus:
//   - projects: array of { id, name, color? } project objects
//   - ref: forwarded to the underlying <textarea> element
//
// Module-time dependencies are pulled from window because main.js assigns
// them BEFORE this module is imported — same convention as DriftDrawer.js
// and RunInspector.js.

const { useState, useRef, useEffect, useCallback, useMemo } = window.preactHooks;
const { h, createRef } = window.preact;
const html = window.htm.bind(h);

const RECENT_KEY = 'palantir.mention.recent';
const MAX_RECENT = 10;

// Read recently-used project IDs from localStorage.
function getRecentIds() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Record a project ID as recently used.
function recordRecent(projectId) {
  try {
    const ids = getRecentIds().filter(id => id !== projectId);
    ids.unshift(projectId);
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, MAX_RECENT)));
  } catch { /* localStorage unavailable */ }
}

export function MentionInput({ projects = [], ref: forwardedRef, onInput, onKeyDown, value, ...rest }) {
  // Internal ref for the textarea; we merge with the forwarded ref.
  const innerRef = useRef(null);
  const textareaRef = forwardedRef || innerRef;

  // Autocomplete state
  const [mentionQuery, setMentionQuery] = useState(null); // null = closed; string = filter text
  const [mentionIdx, setMentionIdx] = useState(0);
  const popupRef = useRef(null);

  // Filtered candidates — case-insensitive prefix match on project name,
  // sorted by recently-used first.
  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const filtered = (projects || []).filter(p => p.name.toLowerCase().includes(q));
    // Sort by recent usage (most recent first), then alphabetical.
    const recentIds = getRecentIds();
    return filtered.sort((a, b) => {
      const ai = recentIds.indexOf(a.id);
      const bi = recentIds.indexOf(b.id);
      // Both recent: lower index = more recent = first
      if (ai !== -1 && bi !== -1) return ai - bi;
      // Only one recent: it goes first
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      // Neither recent: alphabetical
      return a.name.localeCompare(b.name);
    });
  }, [mentionQuery, projects]);

  // When candidates shrink we clamp the selected index.
  useEffect(() => {
    setMentionIdx(i => Math.min(i, Math.max(0, candidates.length - 1)));
  }, [candidates.length]);

  // Detect `@` trigger: present when value starts with `@` (ignoring
  // leading whitespace). Extract the portion after `@` as the query.
  const computeMentionQuery = useCallback((text) => {
    const trimmed = (text || '').trimStart();
    if (!trimmed.startsWith('@')) return null;
    return trimmed.slice(1); // everything after the @
  }, []);

  // Apply a selected project back into the input and record as recent.
  const applyMention = useCallback((project) => {
    const el = textareaRef.current;
    if (!el) return;
    // Replace whatever comes after the leading whitespace + @ with the
    // chosen name plus a trailing space.
    const leading = (value || '').match(/^(\s*)/)[0];
    const newValue = `${leading}@${project.name} `;
    // Synthesise an input event so the parent state (setInput) updates.
    el.value = newValue;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setMentionQuery(null);
    recordRecent(project.id);
    el.focus();
  }, [value, textareaRef]);

  // Handle keydown: intercept up/down/Enter/Esc when popup is open, then fall
  // through to the parent's onKeyDown for everything else.
  const handleKeyDown = useCallback((e) => {
    if (mentionQuery !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setMentionIdx(i => Math.min(candidates.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setMentionIdx(i => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Enter') {
        // Only intercept Enter for mention selection — do NOT call
        // e.stopPropagation so the parent send handler (Enter = send) still
        // fires after the mention is applied. We suppress the default (new
        // line) and replace the text, which is sufficient.
        e.preventDefault();
        applyMention(candidates[mentionIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }
    // Forward to parent handler (e.g. Enter = send message, Shift+Enter = newline).
    if (onKeyDown) onKeyDown(e);
  }, [mentionQuery, candidates, mentionIdx, applyMention, onKeyDown]);

  // Handle input: keep mention query in sync with textarea value.
  const handleInput = useCallback((e) => {
    const q = computeMentionQuery(e.target.value);
    setMentionQuery(q);
    if (onInput) onInput(e);
  }, [computeMentionQuery, onInput]);

  // Sync query when value changes externally (e.g. on send the parent
  // resets value to '').
  useEffect(() => {
    const q = computeMentionQuery(value);
    setMentionQuery(q);
  }, [value, computeMentionQuery]);

  // Close popup on outside click.
  useEffect(() => {
    if (mentionQuery === null) return;
    const handler = (e) => {
      if (textareaRef.current?.contains(e.target)) return;
      if (popupRef.current?.contains(e.target)) return;
      setMentionQuery(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [mentionQuery, textareaRef]);

  // Determine whether to show popup, empty state, or nothing.
  const hasProjects = projects && projects.length > 0;
  const showPopup = mentionQuery !== null && (candidates.length > 0 || !hasProjects);

  return html`
    <div class="mention-input-wrap" style="position:relative;flex:1;display:flex;">
      <textarea
        ref=${textareaRef}
        value=${value}
        onInput=${handleInput}
        onKeyDown=${handleKeyDown}
        ...${rest}
      />
      ${showPopup && html`
        <div
          ref=${popupRef}
          class="mention-popup"
          style="position:absolute;bottom:calc(100% + 4px);left:0;z-index:9999;background:var(--bg-secondary,#1e1e2e);border:1px solid var(--border,#3f3f5a);border-radius:6px;min-width:180px;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,.4);overflow:hidden;"
        >
          ${!hasProjects && html`
            <div
              class="mention-empty"
              style="padding:10px 12px;color:var(--text-muted,#888);font-size:13px;text-align:center;"
            >
              프로젝트 없음
            </div>
          `}
          ${candidates.map((p, i) => html`
            <button
              key=${p.id}
              type="button"
              class="mention-item ${i === mentionIdx ? 'mention-item-active' : ''}"
              style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 12px;background:${i === mentionIdx ? 'var(--accent-muted,#3b3b5c)' : 'transparent'};border:none;cursor:pointer;color:var(--text,#e2e8f0);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
              onMouseEnter=${() => setMentionIdx(i)}
              onClick=${() => applyMention(p)}
            >
              <span
                class="mention-color-dot"
                style="display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${p.color || '#3b82f6'};"
              ></span>
              <span style="overflow:hidden;text-overflow:ellipsis;">
                <span style="opacity:.6;margin-right:2px;">@</span>${p.name}
              </span>
            </button>
          `)}
        </div>
      `}
    </div>
  `;
}
