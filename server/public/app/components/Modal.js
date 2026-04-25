// Modal — accessible dialog primitive. Handles role/aria-modal/aria-labelledby,
// initial focus, focus trap, focus restore on close, and Escape-to-close (via
// the existing useEscape stack so nested modals don't race).
//
// Extracted 2026-04-24 after an a11y review (Aphrodite + Codex) flagged that
// TaskModals / McpTemplatesView / Preset*Modal / SkillPack*Modal / UrlInstall /
// PackPreview / AgentsView / ProjectsView 등 15+ 곳의 모달이 전부 ARIA 미완성
// 에 focus trap 도 없었던 문제를 일괄 해결하기 위함.
//
// Canonical usage:
//   <${Modal} open=${open} onClose=${onClose} labelledBy="my-title" wide>
//     <div class="modal-header"><h2 id="my-title">...</h2></div>
//     <div class="modal-body">...</div>
//     <div class="modal-footer">...</div>
//   </Modal>
//
// props:
//   open           — boolean; renders nothing when false
//   onClose        — invoked by backdrop click, Escape, and focus-trap exit
//   labelledBy     — id of the heading element inside children (used for
//                    aria-labelledby). Omit if no heading — provide ariaLabel.
//   ariaLabel      — fallback accessible name when there is no visible heading
//   wide           — adds `.wide` class for the larger panel variant
//   maxWidth       — inline max-width override (e.g. '560px')
//   panelClass     — extra class tacked onto .modal-panel (e.g. 'task-detail-panel')
//   backdropClose  — defaults true; set false to disable click-out-to-close
//                    (e.g. forms with unsaved changes should guard)
//   escapeClose    — defaults true; set false to disable Escape-to-close
//                    (e.g. while an inline editor inside the modal is active
//                    and Escape should cancel the edit, not the whole modal)

import { h } from '../../vendor/preact.module.js';
import { useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { useEscape } from '../lib/hooks.js';

const FOCUSABLE_SEL = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  labelledBy,
  ariaLabel,
  wide,
  maxWidth,
  panelClass,
  backdropClose = true,
  escapeClose = true,
  children,
}) {
  const panelRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEscape(open && escapeClose, onClose);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    if (!panel) return;

    // Initial focus — first focusable inside the panel, or the panel itself
    // if nothing inside is focusable. Modals without any input still need SOME
    // focus target so Tab isn't trapped on the body.
    const focusables = Array.from(panel.querySelectorAll(FOCUSABLE_SEL));
    const first = focusables[0];
    if (first instanceof HTMLElement) first.focus();
    else panel.focus();

    // Tab trap — wrap Tab within the panel so keyboard users can't accidentally
    // traverse the background DOM while the modal is up. Attach to the panel
    // element itself (NOT window) so nested modals don't cross-intercept each
    // other's Tab handling — without this, opening ExecuteModal on top of
    // TaskDetailPanel makes the outer panel's `!panel.contains(active)` branch
    // fire first and breaks reverse traversal inside the inner dialog.
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
      // Restore focus — guard against the trigger being detached (e.g. removed
      // by the action the modal took). `.focus()` on a null no-ops.
      const prev = returnFocusRef.current;
      if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
        prev.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const style = maxWidth ? { maxWidth } : undefined;
  const classes = ['modal-panel', wide ? 'wide' : '', panelClass || '']
    .filter(Boolean)
    .join(' ');

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${backdropClose ? onClose : undefined}></div>
      <div
        class=${classes}
        ref=${panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby=${labelledBy || undefined}
        aria-label=${!labelledBy && ariaLabel ? ariaLabel : undefined}
        tabindex="-1"
        style=${style}
      >
        ${children}
      </div>
    </div>
  `;
}
