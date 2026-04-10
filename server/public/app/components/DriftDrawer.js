// DriftDrawer — right-side slide panel listing pending PM
// dispatch-audit incoherences. Extracted from server/public/app.js as
// part of P2-10 (ESM phase 1 — single-component extraction to validate
// the pattern established by RunInspector.js).
//
// Why this component first:
//   - DriftDrawer is self-contained. It takes props (open, onClose,
//     driftAudit, projects) and has no out-of-scope references to
//     other legacy app.js state.
//   - It already has a hardened a11y contract (WCAG 2.2 AA — role
//     dialog, aria-modal, aria-labelledby, focus trap, Close button
//     aria-label). Extraction preserves the exact same shape and is
//     covered by server/tests/frontend-a11y-envelope.test.js.
//   - It is an active surface for ongoing work (dispatch audit UI) —
//     future edits are easier against an ES module than against a 4500-
//     line classic script.
//
// Module-time dependencies are now direct ES module imports.

import { h } from '../../vendor/preact.module.js';
import { useRef, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

export function DriftDrawer({ open, onClose, driftAudit, projects }) {
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
  const kindColor = (kind) => {
    if (kind === 'pm_hallucination') return '#ef4444';
    if (kind === 'user_intervention_stale') return '#f59e0b';
    if (kind === 'invalid_claim') return '#8b5cf6';
    return '#6b7280';
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
            <span>\u26A0 Drift</span>
            <span class="drift-drawer-count">${rows.length}</span>
          </div>
          <div class="drift-drawer-actions">
            ${driftAudit && driftAudit.dismissedCount > 0 && html`
              <button class="ghost" onClick=${() => driftAudit.clearDismissed()}>
                Restore ${driftAudit.dismissedCount} dismissed
              </button>
            `}
            <button class="ghost" onClick=${onClose} aria-label="Close drift drawer">Close</button>
          </div>
        </div>
        <div class="drift-drawer-body">
          ${rows.length === 0 && html`
            <div class="drift-drawer-empty">
              <div class="drift-drawer-empty-icon">\u2713</div>
              <div>모든 PM 주장과 DB 상태가 일치합니다.</div>
              <div class="drift-drawer-empty-sub">PM이 잘못된 주장을 기록하면 여기에 표시됩니다.</div>
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
                    ${row.incoherence_kind || 'unknown'}
                  </span>
                  <span class="drift-row-project">${pname}</span>
                  <span class="drift-row-time">${window.timeAgo(new Date(row.created_at).toISOString())}</span>
                  <button
                    class="ghost"
                    style="margin-left:auto"
                    onClick=${() => driftAudit.dismiss(row.id)}
                    title="Hide from this client (server row is kept as history)"
                  >Dismiss</button>
                </div>
                <div class="drift-row-diff">
                  <div class="drift-diff-col">
                    <div class="drift-diff-label">PM claimed</div>
                    <pre>${JSON.stringify(claim, null, 2)}</pre>
                  </div>
                  <div class="drift-diff-col">
                    <div class="drift-diff-label">DB truth</div>
                    <pre>${JSON.stringify(truth, null, 2)}</pre>
                  </div>
                </div>
                ${row.pm_run_id && html`
                  <div class="drift-row-meta">pm_run_id: <code>${row.pm_run_id}</code></div>
                `}
                ${row.rationale && html`
                  <div class="drift-row-meta">rationale: ${row.rationale}</div>
                `}
              </div>
            `;
          })}
        </div>
      </div>
    </div>
  `;
}
