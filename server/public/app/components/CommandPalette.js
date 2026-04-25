// CommandPalette — Cmd+K / Ctrl+K navigation overlay with fuzzy filter
// and number-key shortcuts.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { NAV_ITEMS } from '../lib/nav.js';
import { navigate, useEscape } from '../lib/hooks.js';

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

  const items = NAV_ITEMS.filter(item =>
    !query || item.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (hash) => {
    navigate(hash);
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, items.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (items[selectedIndex]) handleSelect(items[selectedIndex].hash); return; }
    // Number keys 1-5 only when query is empty (avoid conflict with typing)
    if (!query) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= items.length) {
        e.preventDefault();
        handleSelect(items[num - 1].hash);
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
        aria-label="Command palette"
        tabindex="-1"
        onClick=${e => e.stopPropagation()}
      >
        <input
          ref=${inputRef}
          class="command-palette-input"
          placeholder="Navigate to... (1-${NAV_ITEMS.length} to jump)"
          aria-label="Filter views"
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
              <span class="command-palette-hint">${i + 1}</span>
            </button>
          `)}
          ${items.length === 0 && html`
            <div class="command-palette-empty">No matching views</div>
          `}
        </div>
      </div>
    </div>
  `;
}
