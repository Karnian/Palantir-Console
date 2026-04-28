// DriftDrawer — right-side slide panel listing pending PM
// dispatch-audit incoherences.

import { h } from '../../vendor/preact.module.js';
import { useRef, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { timeAgo } from '../lib/format.js';
import { useEscape } from '../lib/hooks.js';
import {
  COMMON_ACTIONS,
  DRIFT_LABELS,
  INCOHERENCE_KIND_LABELS,
  statusLabel,
} from '../lib/copy.js';

export function DriftDrawer({ open, onClose, driftAudit, projects }) {
  // Phase F: ESC handling joins the shared useEscape stack so a Cmd+K
  // palette opened on top of the drawer closes the palette first, then
  // the drawer on a second press — same LIFO semantics as the centered
  // modals. The earlier app-level Escape branch (app.js global keydown)
  // is removed in lockstep.
  useEscape(!!open, onClose);

  // PR3b / P1-11: WCAG 2.2 AA a11y. Pre-PR3b the drawer had none of
  // the dialog semantics — no role, no aria-modal, no label wiring,
  // and tabbing out would land in the underlying dashboard which is
  // still in the DOM. ESC handling already lives at app level (App's
  // useEffect for showDriftDrawer), so we only need to cover:
  //   * role="dialog" + aria-modal + aria-labelledby on the drawer root
  //   * auto-focus the Close button on open (first meaningful focus
  //     target; the dismiss buttons rotate, Close is stable)
  //   * focus trap via keydown handler — Tab cycles through focusable
  //     elements inside the drawer, Shift+Tab cycles in reverse
  const drawerRef = useRef(null);

  // Auto-focus + focus trap. Effect intentionally depends only on
  // `open` — the rows may change over the drawer's lifetime but the
  // trap should stay bound to mount/unmount, not churn per reload.
  useEffect(() => {
    if (!open || !drawerRef.current) return;
    const node = drawerRef.current;

    // First focusable: the Close button. Scan once after mount — if
    // it's missing (e.g. someone removes it), fall back to the first
    // button in document order.
    const focusables = () => Array.from(node.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));
    const first = focusables()[0];
    if (first) first.focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === firstEl || !node.contains(document.activeElement)) {
          e.preventDefault();
          lastEl.focus();
        }
      } else {
        if (document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    node.addEventListener('keydown', onKeyDown);
    return () => { node.removeEventListener('keydown', onKeyDown); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const rows = driftAudit ? driftAudit.rows : [];
  const projectName = (pid) => {
    const p = (projects || []).find(p => p.id === pid);
    return p ? p.name : pid;
  };
  const parseJson = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  // Phase Theme Contract γ (2026-04-28): mechanical swap of inline
  // hex values to design tokens (visual delta 0 — values are equal).
  // pm_hallucination = --status-failed, user_intervention_stale =
  // --warning, invalid_claim = --status-review, default = --status-queued.
  const kindColor = (kind) => {
    if (kind === 'pm_hallucination') return 'var(--status-failed)';
    if (kind === 'user_intervention_stale') return 'var(--warning)';
    if (kind === 'invalid_claim') return 'var(--status-review)';
    return 'var(--status-queued)';
  };
  return html`
    <div class="drift-drawer-backdrop" onClick=${onClose}>
      <div
        class="drift-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drift-drawer-title"
        ref=${drawerRef}
        onClick=${(e) => e.stopPropagation()}
      >
        <div class="drift-drawer-header">
          <div class="drift-drawer-title" id="drift-drawer-title">
            <span>${DRIFT_LABELS.title}</span>
            <span class="drift-drawer-count">${rows.length}</span>
          </div>
          <div class="drift-drawer-actions">
            ${driftAudit && driftAudit.dismissedCount > 0 && html`
              <button class="ghost" onClick=${() => driftAudit.clearDismissed()}>
                ${DRIFT_LABELS.restorePrefix} ${driftAudit.dismissedCount}${DRIFT_LABELS.restoreSuffix}
              </button>
            `}
            <button class="ghost" onClick=${onClose} aria-label=${DRIFT_LABELS.closeAria}>${COMMON_ACTIONS.close}</button>
          </div>
        </div>
        <div class="drift-drawer-body">
          ${rows.length === 0 && html`
            <div class="drift-drawer-empty">
              <div class="drift-drawer-empty-icon">✓</div>
              <div>${DRIFT_LABELS.empty}</div>
              <div class="drift-drawer-empty-sub">${DRIFT_LABELS.emptySub}</div>
            </div>
          `}
          ${rows.map(row => {
            const claim = parseJson(row.pm_claim);
            const truth = parseJson(row.db_truth);
            const pname = projectName(row.project_id);
            return html`
              <div key=${row.id} class="drift-row" style=${`border-left: 3px solid ${kindColor(row.incoherence_kind)}`}>
                <div class="drift-row-header">
                  <span class="drift-row-kind" style=${`color:${kindColor(row.incoherence_kind)}`}>
                    ${statusLabel(INCOHERENCE_KIND_LABELS, row.incoherence_kind || 'unknown')}
                  </span>
                  <span class="drift-row-project">${pname}</span>
                  <span class="drift-row-time">${timeAgo(new Date(row.created_at).toISOString())}</span>
                  <button
                    class="ghost"
                    style="margin-left:auto"
                    onClick=${() => driftAudit.dismiss(row.id)}
                    title=${DRIFT_LABELS.dismissTitle}
                  >${DRIFT_LABELS.dismiss}</button>
                </div>
                <div class="drift-row-diff">
                  <div class="drift-diff-col">
                    <div class="drift-diff-label">${DRIFT_LABELS.pmClaimed}</div>
                    <pre>${JSON.stringify(claim, null, 2)}</pre>
                  </div>
                  <div class="drift-diff-col">
                    <div class="drift-diff-label">${DRIFT_LABELS.dbTruth}</div>
                    <pre>${JSON.stringify(truth, null, 2)}</pre>
                  </div>
                </div>
                ${row.pm_run_id && html`
                  <div class="drift-row-meta">${DRIFT_LABELS.pmRunIdLabel}: <code>${row.pm_run_id}</code></div>
                `}
                ${row.rationale && html`
                  <div class="drift-row-meta">${DRIFT_LABELS.rationaleLabel}: ${row.rationale}</div>
                `}
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}
