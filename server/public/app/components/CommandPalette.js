// CommandPalette — Cmd+K / Ctrl+K navigation overlay with fuzzy filter
// and number-key shortcuts. Extracted from server/public/app.js as part
// of P4-3 (ESM phase 3).
//
// Dependencies:
//   - window.NAV_ITEMS: navigation item array (stays in app.js because
//     NavSidebar also consumes it)
//   - window.navigate: hash router helper (bridged from hooks.js)
//
// Module-time dependencies are pulled from window because main.js assigns
// them BEFORE this module is imported — same convention as DriftDrawer.js,
// RunInspector.js, MentionInput.js, etc.

const { useState, useEffect, useRef } = window.preactHooks;
const { h } = window.preact;
const html = window.htm.bind(h);

export function CommandPalette({ open, onClose }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) {
      setQuery('');
      inputRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const NAV_ITEMS = window.NAV_ITEMS || [];
  const navigate = window.navigate;

  const items = NAV_ITEMS.filter(item =>
    !query || item.label.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (hash) => {
    navigate(hash);
    onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
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
    <div class="modal-overlay" onClick=${onClose}>
      <div class="command-palette" onClick=${e => e.stopPropagation()}>
        <input
          ref=${inputRef}
          class="command-palette-input"
          placeholder="Navigate to... (1-${NAV_ITEMS.length} to jump)"
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
