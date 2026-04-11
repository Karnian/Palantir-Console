// Dropdown — styled trigger + absolutely-positioned menu. Extracted from
// the legacy app.js monolith as part of P3-2 (ESM phase 2).
//
// Background: native <select> elements receive platform-default styling
// that ignores CSS `padding`, which makes it impossible to keep visual
// alignment with adjacent fields. This component renders a styled trigger
// + an absolutely-positioned menu the same width as the trigger.
//
import { h } from '../../vendor/preact.module.js';
import { useState, useRef, useEffect, useCallback, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

// Option shape (all fields optional except value + label):
//   { value, label, dot?: string (CSS color), disabled?: bool }
// Separator pseudo-item:
//   { separator: true }   — rendered as a visual divider, not selectable
//
// Additional component props:
//   wide — makes the trigger width: max-content (don't stretch to container)
export function Dropdown({ value, onChange, options, disabled, style, className, title, ariaLabel, wide }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null); // { top, left, width, flipUp }
  const [hoverIdx, setHoverIdx] = useState(-1);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  // Selectable options only (separators are skipped for value matching + keyboard nav)
  const selectableOptions = options.filter(o => !o.separator);
  const selected = selectableOptions.find(o => o.value === value);

  // Compute fixed-position coordinates from the trigger's bounding box.
  // Using `position: fixed` (not absolute) escapes the modal-body's scroll
  // container so the popup doesn't grow the modal's scroll area.
  const computePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // Approx menu height: 4px padding * 2 + ~30px per row, capped at 280
    const estimated = Math.min(280, selectableOptions.length * 30 + 12);
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const flipUp = spaceBelow < estimated && spaceAbove > spaceBelow;
    setMenuPos({
      top: flipUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      flipUp,
    });
  }, [options.length]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (buttonRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // On open: compute position, close on ancestor scroll/resize. We listen in
  // capture phase so we catch scrolls inside any ancestor (modal-body etc.),
  // but we must IGNORE scrolls originating inside the menu itself — otherwise
  // the menu's own `overflow-y: auto` triggers self-close on the first wheel
  // event when the option list is long.
  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    computePosition();
    const onScroll = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computePosition]);

  // Focus the menu when opening so keyboard navigation works
  useEffect(() => {
    if (open && menuRef.current) {
      menuRef.current.focus();
      const idx = selectableOptions.findIndex(o => o.value === value);
      setHoverIdx(idx >= 0 ? idx : 0);
    }
  }, [open]);

  const handleButtonKey = (e) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const commit = (v) => {
    setOpen(false);
    if (v !== value) onChange(v);
  };

  const handleMenuKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => Math.min(selectableOptions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(selectableOptions.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (hoverIdx >= 0) commit(selectableOptions[hoverIdx].value);
    } else if (e.key === 'Escape') {
      // Stop propagation so the modal's window-level Escape handler
      // doesn't ALSO close the modal when we just want to close the menu.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  // Map flat options list into render items, tracking selectable index separately
  // so keyboard hoverIdx lines up with selectableOptions[].
  let selectableCounter = 0;

  return html`
    <div class="dropdown ${className || ''} ${disabled ? 'is-disabled' : ''} ${open ? 'is-open' : ''} ${wide ? 'dropdown-wide' : ''}">
      <button type="button" ref=${buttonRef}
        class="dropdown-button"
        style=${style || ''}
        disabled=${disabled}
        title=${title || ''}
        aria-label=${ariaLabel || ''}
        aria-haspopup="listbox"
        aria-expanded=${open}
        onClick=${() => !disabled && setOpen(o => !o)}
        onKeyDown=${handleButtonKey}>
        ${selected?.dot != null && html`
          <span class="dropdown-dot ${selected.dot ? '' : 'dropdown-dot-inactive'}"
            style=${selected.dot ? `background:${selected.dot}` : ''}
            aria-hidden="true"></span>
        `}
        <span class="dropdown-label">${selected?.label ?? ''}</span>
        <span class="dropdown-chevron" aria-hidden="true">\u25BE</span>
      </button>
      ${open && menuPos && html`
        <div class="dropdown-menu ${menuPos.flipUp ? 'flip-up' : ''}"
          ref=${menuRef} role="listbox" tabindex="-1"
          style=${`position: fixed; top: ${menuPos.top}px; left: ${menuPos.left}px; width: ${menuPos.width}px; ${menuPos.flipUp ? 'transform: translateY(-100%);' : ''}`}
          onKeyDown=${handleMenuKey}>
          ${options.map((opt) => {
            // Separator pseudo-item — not a button, not focusable
            if (opt.separator) {
              return html`<div key=${opt.key || '_sep'} class="dropdown-separator" role="separator" aria-hidden="true"></div>`;
            }
            const si = selectableCounter++;
            const isSelected = value === opt.value;
            const isHover = si === hoverIdx;
            return html`
              <button type="button" key=${opt.value}
                role="option"
                aria-selected=${isSelected}
                class="dropdown-item ${isSelected ? 'selected' : ''} ${isHover ? 'hover' : ''}"
                onMouseEnter=${() => setHoverIdx(si)}
                onClick=${() => commit(opt.value)}>
                <span class="dropdown-item-check">${isSelected ? '\u2713' : ''}</span>
                ${opt.dot != null && html`
                  <span class="dropdown-dot ${opt.dot ? 'dropdown-dot-active' : 'dropdown-dot-inactive'}"
                    style=${opt.dot ? `background:${opt.dot}` : ''}
                    aria-hidden="true"></span>
                `}
                <span class="dropdown-item-label">${opt.label}</span>
              </button>
            `;
          })}
        </div>
      `}
    </div>
  `;
}
