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
//   id   — forwarded to the trigger button so a sibling `<label for="X">`
//          can announce a visible label without forcing every call site
//          onto `aria-label`. Phase G (2026-04-26) added this so SkillPack /
//          Preset / Agent modal Dropdowns can pair with their visible labels.
//   dataRole — forwarded as `data-role` on the trigger button so call sites
//          that were driven by `[data-role=…]` selectors (jsdom / e2e) keep
//          the same handle after the native-<select> port.
//   placeholder — muted trigger text shown when `value` matches no option.
//          Native <select> always renders SOME option, so a bare port of a
//          select whose value is '' would show an empty trigger. Call sites
//          that have no ''-valued option pass a placeholder instead.
//
// Dropdown unification (2026-07-23): every former native `<select>` in the
// app now renders through this component so the popup looks and behaves the
// same everywhere (the Board "전체 프로젝트 폴더" filter is the reference).
// Form-shaped call sites pass `className="dropdown-field"`, which sizes the
// trigger like `.form-input` so it stays aligned with adjacent text fields.

// Phase I (2026-04-26): each Dropdown gets a stable instance id used as
// the prefix for its option ids. We need stable ids because the listbox
// container points at the active option via `aria-activedescendant` so
// AT users can hear the option text as Arrow keys move the highlight —
// without explicit ids the listbox would announce nothing.
let _dropdownIdSeq = 0;
const TYPEAHEAD_RESET_MS = 500;

export function Dropdown({ id, value, onChange, options, disabled, style, className, title, ariaLabel, ariaDescribedBy, wide, placeholder, dataRole }) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null); // { top, left, width, flipUp }
  const [hoverIdx, setHoverIdx] = useState(-1);
  const [externalLabelId, setExternalLabelId] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const seededMenuNodeRef = useRef(null);
  const typeaheadBufferRef = useRef('');
  const typeaheadTimerRef = useRef(null);
  const closedTypeaheadIdxRef = useRef(-1);
  const typeaheadOpenRef = useRef(open);
  // Stable per-instance id used for option ids (see comment above the
  // module). The id is computed once on first render via useMemo so
  // re-renders don't shuffle option ids while the listbox is open.
  const instanceId = useMemo(() => `dropdown-${++_dropdownIdSeq}`, []);

  // Selectable options only (separators are skipped for value matching + keyboard nav)
  const selectableOptions = options.filter(o => !o.separator);
  const selected = selectableOptions.find(o => o.value === value);
  const displayedLabel = selected ? selected.label : (placeholder ?? '');
  const valueLabelId = `${instanceId}-value`;
  const triggerAriaLabel = ariaLabel
    ? [ariaLabel, displayedLabel]
      .filter(part => part != null && String(part).trim())
      .join(', ')
    : undefined;
  const activeOptionId = hoverIdx >= 0 && hoverIdx < selectableOptions.length
    ? `${instanceId}-opt-${hoverIdx}`
    : undefined;

  // A <label for=…> gives the button its field name, but that name replaces
  // the button's selected-value text in the accessible-name computation.
  // Give the associated label a stable id when it lacks one so the trigger
  // can explicitly name itself from both the field label and displayed value.
  useEffect(() => {
    setExternalLabelId(null);
    if (!id || ariaLabel || !buttonRef.current) return;

    const externalLabel = buttonRef.current.labels?.[0];
    if (!externalLabel) return;

    const previousId = externalLabel.id;
    const labelId = previousId || `${instanceId}-label`;
    if (!previousId) externalLabel.id = labelId;
    setExternalLabelId(labelId);

    return () => {
      if (!previousId && externalLabel.id === labelId) {
        externalLabel.removeAttribute('id');
      }
    };
  }, [id, ariaLabel]);

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

  const resetTypeahead = useCallback(() => {
    if (typeaheadTimerRef.current != null) {
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = null;
    }
    typeaheadBufferRef.current = '';
    closedTypeaheadIdxRef.current = -1;
  }, []);

  // Keep closed-trigger input typed immediately after mount intact. Reset the
  // search on actual open/close transitions, and cancel its timer on unmount.
  useEffect(() => {
    if (typeaheadOpenRef.current === open) return;
    typeaheadOpenRef.current = open;
    resetTypeahead();
  }, [open, resetTypeahead]);
  useEffect(() => resetTypeahead, [resetTypeahead]);

  // On open: compute position, close on ancestor scroll/resize. We listen in
  // capture phase so we catch scrolls inside any ancestor (modal-body etc.),
  // but we must IGNORE scrolls originating inside the menu itself — otherwise
  // the menu's own `overflow-y: auto` triggers self-close on the first wheel
  // event when the option list is long.
  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    computePosition();
    const closeForViewportChange = () => {
      const menuNode = menuRef.current;
      if (menuNode && menuNode.contains(document.activeElement)) {
        buttonRef.current?.focus();
      }
      setOpen(false);
    };
    const onScroll = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      closeForViewportChange();
    };
    const onResize = closeForViewportChange;
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, computePosition]);

  // Disabled options stay in `selectableOptions` (so option ids and
  // `aria-activedescendant` keep pointing at the row the user sees) but they
  // are skipped by keyboard navigation and refuse commits — mirroring how a
  // native `<option disabled>` behaves.
  const findEnabled = useCallback((from, step) => {
    for (let i = from; i >= 0 && i < selectableOptions.length; i += step) {
      if (!selectableOptions[i].disabled) return i;
    }
    return -1;
  }, [options]);

  const findTypeaheadMatch = useCallback((key, currentIdx) => {
    const char = key.toLocaleLowerCase();
    const previousBuffer = typeaheadBufferRef.current;
    const isRepeatedChar = previousBuffer.length > 0
      && Array.from(previousBuffer).every(bufferChar => bufferChar === char);
    const search = isRepeatedChar ? char : previousBuffer + char;
    typeaheadBufferRef.current = search;

    if (typeaheadTimerRef.current != null) {
      window.clearTimeout(typeaheadTimerRef.current);
    }
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadBufferRef.current = '';
      typeaheadTimerRef.current = null;
      closedTypeaheadIdxRef.current = -1;
    }, TYPEAHEAD_RESET_MS);

    if (isRepeatedChar && selectableOptions.length > 0) {
      for (let offset = 1; offset <= selectableOptions.length; offset += 1) {
        const idx = (currentIdx + offset + selectableOptions.length) % selectableOptions.length;
        const opt = selectableOptions[idx];
        if (!opt.disabled && String(opt.label ?? '').toLocaleLowerCase().startsWith(search)) {
          return idx;
        }
      }
      return -1;
    }

    return selectableOptions.findIndex(opt => (
      !opt.disabled
      && String(opt.label ?? '').toLocaleLowerCase().startsWith(search)
    ));
  }, [options]);

  const isTypeaheadKey = (e) => (
    typeof e.key === 'string'
    && e.key.length === 1
    && !e.ctrlKey
    && !e.metaKey
    && !e.altKey
    && !e.isComposing
    && e.keyCode !== 229
  );

  // Focus and seed only after the listbox has actually mounted. Tracking the
  // mounted node (rather than menuPos) avoids resetting keyboard navigation
  // when an open menu is repositioned.
  useEffect(() => {
    if (!open) {
      seededMenuNodeRef.current = null;
      setHoverIdx(-1);
      return;
    }

    const menuNode = menuRef.current;
    if (!menuNode || seededMenuNodeRef.current === menuNode) return;

    seededMenuNodeRef.current = menuNode;
    menuNode.focus();
    const idx = selectableOptions.findIndex(o => o.value === value && !o.disabled);
    setHoverIdx(idx >= 0 ? idx : findEnabled(0, 1));
  }, [open, menuPos, value, findEnabled]);

  // Keep the active row visible for every hoverIdx change, including the
  // post-mount seed and all keyboard/typeahead navigation.
  useEffect(() => {
    if (!open || hoverIdx < 0) return;
    const activeNode = document.getElementById(`${instanceId}-opt-${hoverIdx}`);
    activeNode?.scrollIntoView?.({ block: 'nearest' });
  }, [open, hoverIdx]);

  const commit = (opt) => {
    if (opt.disabled) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (opt.value !== value) onChange(opt.value);
  };

  const handleButtonKey = (e) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    } else if (isTypeaheadKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      const selectedIdx = selectableOptions.findIndex(opt => opt.value === value && !opt.disabled);
      const currentIdx = closedTypeaheadIdxRef.current >= 0
        ? closedTypeaheadIdxRef.current
        : selectedIdx;
      const matchIdx = findTypeaheadMatch(e.key, currentIdx);
      if (matchIdx >= 0) {
        closedTypeaheadIdxRef.current = matchIdx;
        commit(selectableOptions[matchIdx]);
      }
    }
  };

  const handleMenuKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => { const n = findEnabled(i + 1, 1); return n >= 0 ? n : i; });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => { const n = findEnabled(i - 1, -1); return n >= 0 ? n : i; });
    } else if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => { const n = findEnabled(0, 1); return n >= 0 ? n : i; });
    } else if (e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      setHoverIdx(i => { const n = findEnabled(selectableOptions.length - 1, -1); return n >= 0 ? n : i; });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (hoverIdx >= 0 && selectableOptions[hoverIdx]) commit(selectableOptions[hoverIdx]);
    } else if (e.key === 'Escape') {
      // Stop propagation so the modal's window-level Escape handler
      // doesn't ALSO close the modal when we just want to close the menu.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    } else if (isTypeaheadKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      const matchIdx = findTypeaheadMatch(e.key, hoverIdx);
      if (matchIdx >= 0) {
        setHoverIdx(matchIdx);
      }
    }
  };

  // Map flat options list into render items, tracking selectable index separately
  // so keyboard hoverIdx lines up with selectableOptions[].
  let selectableCounter = 0;

  return html`
    <div class="dropdown ${className || ''} ${disabled ? 'is-disabled' : ''} ${open ? 'is-open' : ''} ${wide ? 'dropdown-wide' : ''}">
      <button type="button" ref=${buttonRef}
        id=${id || undefined}
        class="dropdown-button"
        data-role=${dataRole || undefined}
        data-value=${value == null ? undefined : String(value)}
        style=${style || ''}
        disabled=${disabled}
        title=${title || ''}
        aria-label=${triggerAriaLabel}
        aria-labelledby=${!ariaLabel && externalLabelId ? `${externalLabelId} ${valueLabelId}` : undefined}
        aria-describedby=${ariaDescribedBy || undefined}
        aria-haspopup="listbox"
        aria-expanded=${open}
        onClick=${() => !disabled && setOpen(o => !o)}
        onKeyDown=${handleButtonKey}>
        ${selected?.dot != null && html`
          <span class="dropdown-dot ${selected.dot ? '' : 'dropdown-dot-inactive'}"
            style=${selected.dot ? `background:${selected.dot}` : ''}
            aria-hidden="true"></span>
        `}
        <span id=${valueLabelId} class="dropdown-label ${!selected && placeholder ? 'is-placeholder' : ''}">${displayedLabel}</span>
        <span class="dropdown-chevron" aria-hidden="true">\u25BE</span>
      </button>
      ${open && menuPos && html`
        <div class="dropdown-menu ${menuPos.flipUp ? 'flip-up' : ''}"
          ref=${menuRef} role="listbox" tabindex="-1"
          aria-activedescendant=${activeOptionId}
          aria-labelledby=${id || undefined}
          aria-label=${!id && ariaLabel ? ariaLabel : undefined}
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
                id=${`${instanceId}-opt-${si}`}
                data-value=${opt.value == null ? undefined : String(opt.value)}
                role="option"
                aria-selected=${isSelected}
                aria-disabled=${opt.disabled ? 'true' : undefined}
                tabindex="-1"
                class="dropdown-item ${isSelected ? 'selected' : ''} ${isHover ? 'hover' : ''} ${opt.disabled ? 'is-disabled' : ''}"
                onMouseEnter=${() => !opt.disabled && setHoverIdx(si)}
                onClick=${() => commit(opt)}>
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
