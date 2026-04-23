// AttentionStrip — Attention-scoped strip (needs_input + failed only).
// R2-A.2: extracted as an attention-only projection per spec §12.1.
// Unlike DashboardView.triage-feed (a superset including running/review/
// overdue/due-soon + "All clear" empty state), this component:
//   - Only surfaces needs_input + failed worker runs (is_manager=0)
//   - Hides the entire region when empty (spec §12.1)
//   - Caps the visible list at 5 and collapses the rest behind a toggle
//   - Offers inline Respond/Retry actions that open RunInspector
//
// Consumers pass the full `runs` list + `tasks` for title resolution
// and an `onOpenRun` callback. Manager runs (is_manager=1) are excluded
// at the source so PM/Top sessions never appear as attention items.
import { h } from '../../vendor/preact.module.js';
import { useState, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { timeAgo } from '../lib/format.js';

const MAX_VISIBLE = 5;

const ICON = {
  'needs_input': '⏸', // ⏸
  'failed': '✗',      // ✗
};

const ACTION_LABEL = {
  'needs_input': '응답하기',
  'failed': '재시도',
};

export function AttentionStrip({ runs, tasks, onOpenRun }) {
  const [expanded, setExpanded] = useState(false);

  const items = useMemo(() => {
    const workerRuns = (runs || []).filter(r => !r.is_manager);
    const taskMap = new Map((tasks || []).map(t => [t.id, t]));

    const entries = workerRuns
      .filter(r => r.status === 'needs_input' || r.status === 'failed')
      .map(run => {
        const task = run.task_id ? taskMap.get(run.task_id) : null;
        const title = task?.title || `Run ${String(run.id || '').slice(0, 8)}`;
        const ts = run.updated_at || run.created_at;
        return {
          id: run.id,
          status: run.status,
          title,
          meta: run.status === 'needs_input'
            ? `입력 대기 · ${timeAgo(ts)}`
            : `실패 · ${timeAgo(ts)}`,
          run,
        };
      });

    // needs_input first, then failed; within each bucket newest first
    entries.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'needs_input' ? -1 : 1;
      const at = a.run.updated_at || a.run.created_at || 0;
      const bt = b.run.updated_at || b.run.created_at || 0;
      return bt - at;
    });

    return entries;
  }, [runs, tasks]);

  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, MAX_VISIBLE);
  const hiddenCount = items.length - MAX_VISIBLE;

  return html`
    <div class="attention-strip" role="region" aria-label="Attention — needs input and failed runs">
      ${/* A11y note: do NOT nest interactive controls. The row is a plain
           container and the inline action button is the only focusable
           element per spec §12.1 ("인라인 액션 버튼 포함 — 클릭 한 번으로
           대응"). Clicking anywhere on the row also opens the inspector
           (larger tap target), but that path is exposed via the action
           button's accessible name, not a duplicate role="button" wrapper. */ ''}
      ${visible.map(item => html`
        <div
          key=${item.id}
          class="attention-item attention-${item.status === 'needs_input' ? 'input' : 'failed'}"
          onClick=${(e) => {
            // Mouse/touch convenience only — keyboard users go through the
            // action button. Swallow clicks that originate on the button
            // itself so the button's own handler runs (avoids double-fire).
            if (e.target.closest('.attention-action')) return;
            onOpenRun && onOpenRun(item.run);
          }}
        >
          <span class="attention-icon ${item.status === 'needs_input' ? 'pulse' : ''}" aria-hidden="true">${ICON[item.status]}</span>
          <div class="attention-body">
            <div class="attention-title">${item.title}</div>
            <div class="attention-meta">${item.meta}</div>
          </div>
          <button
            type="button"
            class="attention-action"
            aria-label=${`${ACTION_LABEL[item.status]}: ${item.title}`}
            onClick=${() => onOpenRun && onOpenRun(item.run)}
          >
            ${ACTION_LABEL[item.status]}
          </button>
        </div>
      `)}
      ${!expanded && hiddenCount > 0 && html`
        <button
          class="attention-more"
          onClick=${() => setExpanded(true)}
          aria-expanded="false"
        >
          +${hiddenCount} more
        </button>
      `}
      ${expanded && items.length > MAX_VISIBLE && html`
        <button
          class="attention-more"
          onClick=${() => setExpanded(false)}
          aria-expanded="true"
        >
          접기
        </button>
      `}
    </div>
  `;
}
