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

export function Dropdown({ value, onChange, options, disabled, style, className, title, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null); // { top, left, width, flipUp }
  const [hoverIdx, setHoverIdx] = useState(-1);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const selected = options.find(o => o.value === value);

  // Compute fixed-position coordinates from the trigger's bounding box.
  // Using `position: fixed` (not absolute) escapes the modal-body's scroll
  // container so the popup doesn't grow the modal's scroll area.
  const computePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    // Approx menu height: 4px padding * 2 + ~30px per row, capped at 280
    const estimated = Math.min(280, options.length * 30 + 12);
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
      const idx = options.findIndex(o => o.value === value);
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
      setHoverIdx(i => Math.min(options.length - 1, i + 1));
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
      setHoverIdx(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (hoverIdx >= 0) commit(options[hoverIdx].value);
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

  return html`
    <div class="dropdown ${className || ''} ${disabled ? 'is-disabled' : ''} ${open ? 'is-open' : ''}">
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
        <span class="dropdown-label">${selected?.label ?? ''}</span>
        <span class="dropdown-chevron" aria-hidden="true">\u25BE</span>
      </button>
      ${open && menuPos && html`
        <div class="dropdown-menu ${menuPos.flipUp ? 'flip-up' : ''}"
          ref=${menuRef} role="listbox" tabindex="-1"
          style=${`position: fixed; top: ${menuPos.top}px; left: ${menuPos.left}px; width: ${menuPos.width}px; ${menuPos.flipUp ? 'transform: translateY(-100%);' : ''}`}
          onKeyDown=${handleMenuKey}>
          ${options.map((opt, i) => html`
            <button type="button" key=${opt.value}
              role="option"
              aria-selected=${value === opt.value}
              class="dropdown-item ${value === opt.value ? 'selected' : ''} ${i === hoverIdx ? 'hover' : ''}"
              onMouseEnter=${() => setHoverIdx(i)}
              onClick=${() => commit(opt.value)}>
              <span class="dropdown-item-check">${value === opt.value ? '\u2713' : ''}</span>
              <span class="dropdown-item-label">${opt.label}</span>
            </button>
          `)}
        </div>
      `}
    </div>
  `;
}
