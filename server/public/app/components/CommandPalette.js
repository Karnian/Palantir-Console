// CommandPalette — Cmd+K / Ctrl+K navigation overlay with fuzzy filter
// and number-key shortcuts.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { NAV_ITEMS, NAV_SUB_ITEMS } from '../lib/nav.js';
import { navigate, useEscape } from '../lib/hooks.js';
import { COMMAND_PALETTE_LABELS } from '../lib/copy.js';

const FOCUSABLE_SEL = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);

  // Phase F: ESC routed through the shared stack so nested overlays
  // (DriftDrawer / RunInspector) get correct LIFO closing. The previous
  // inline `e.key === 'Escape'` branch in handleKeyDown is removed; the
  // app-level Escape fallback for `showPalette` is also gone.
  useEscape(!!open, onClose);

  // Initial focus + Tab focus trap + focus restore on close — same shape
  // as Modal primitive, but we keep the bespoke chrome (.command-palette)
  // because it has a unique width / animation / number-key affordance and
  // needs a higher overlay z-index than centered modals so it stacks above
  // the DriftDrawer (z-index 900). The trap is panel-local (not window) to
  // stay compatible with nested modal scenarios — same rule as Modal.js.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    setQuery('');
    const panel = panelRef.current;
    if (inputRef.current) inputRef.current.focus();

    if (!panel) return;
    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const cur = Array.from(panel.querySelectorAll(FOCUSABLE_SEL));
      if (cur.length === 0) { e.preventDefault(); return; }
      const firstEl = cur[0];
      const lastEl = cur[cur.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstEl || !panel.contains(active)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (active === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
      const prev = returnFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  // When a query is typed, search over NAV_ITEMS + NAV_SUB_ITEMS combined
  // so users can jump directly to e.g. "스킬 팩" or "MCP 서버".
  // When the query is empty, show only NAV_ITEMS (top-level groups) so
  // the number-key shortcuts map 1:1 to the displayed rows.
  const allItems = query
    ? [...NAV_ITEMS, ...NAV_SUB_ITEMS].filter(item =>
        item.label.toLowerCase().includes(query.toLowerCase())
      )
    : NAV_ITEMS;

  // For keyboard navigation we always use `allItems`.
  const items = allItems;

  const handleSelect = (hash) => {
    navigate(hash);
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (items[selectedIndex]) handleSelect(items[selectedIndex].hash); return; }
    // Number keys 1–N only when query is empty (avoid conflict with typing)
    // and only over NAV_ITEMS (the top-level group list).
    if (!query) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= NAV_ITEMS.length) {
        e.preventDefault();
        handleSelect(NAV_ITEMS[num - 1].hash);
      }
    }
  };

  return html`
    <div class="command-palette-overlay" onClick=${onClose}>
      <div
        ref=${panelRef}
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label=${COMMAND_PALETTE_LABELS.ariaLabel}
        tabindex="-1"
        onClick=${e => e.stopPropagation()}
      >
        <input
          ref=${inputRef}
          class="command-palette-input"
          placeholder=${COMMAND_PALETTE_LABELS.placeholder(NAV_ITEMS.length)}
          aria-label=${COMMAND_PALETTE_LABELS.filterAriaLabel}
          value=${query}
          onInput=${e => setQuery(e.target.value)}
          onKeyDown=${handleKeyDown}
        />
        <div class="command-palette-list">
          ${items.map((item, i) => html`
            <button
              key=${item.hash}
              class="command-palette-item ${i === selectedIndex ? 'selected' : ''}"
              onClick=${() => handleSelect(item.hash)}
            >
              <span class="command-palette-icon">${item.icon}</span>
              <span class="command-palette-label">${item.label}</span>
              ${!query && html`<span class="command-palette-hint">${i + 1}</span>`}
            </button>
          `)}
          ${items.length === 0 && html`
            <div class="command-palette-empty">${COMMAND_PALETTE_LABELS.empty}</div>
          `}
        </div>
      </div>
    </div>
  `;
}
