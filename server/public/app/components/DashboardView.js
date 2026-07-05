// DashboardView — Attention Dashboard component.
// Extracted from server/public/app.js as part of P5-1 (ESM phase 4a).

import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { timeAgo, formatDuration, parseDate } from '../lib/format.js';
import { navigate, useNodeSummary } from '../lib/hooks.js';
import { DASHBOARD_LABELS } from '../lib/copy.js';
import { fleetStripModel, nodeDetailHref, nodeDisplayName } from '../lib/nodeUi.js';
import { EmptyState } from './EmptyState.js';
import { dueState, formatDueDate, useNowTick, dueDateMeta } from '../lib/dueDate.js';

export function DashboardView({ tasks, runs, onOpenRun, onOpenTask, onDeleteRun, claudeSessions, manager, driftAudit, onOpenDrift, nodeSummary: nodeSummaryProp }) {
  // Tick every minute so overdue/due-soon triage rolls over without a reload.
  // The hook itself returns a counter we don't read; calling it is enough to
  // force a re-render at each tick.
  useNowTick(60_000);
  const hasNodeSummaryProp = nodeSummaryProp !== undefined;
  const fetchedNodeSummary = useNodeSummary({ enabled: !hasNodeSummaryProp, refreshKey: runs });
  const nodeSummary = hasNodeSummaryProp ? nodeSummaryProp : fetchedNodeSummary;

  const fleetModel = fleetStripModel(nodeSummary);
  // Manager session is tracked separately via /api/manager/status — exclude from worker dashboard counts
  const workerRuns = (runs || []).filter(r => !r.is_manager);
  const activeRuns = workerRuns.filter(r => r.status === 'running');
  const needsInputRuns = workerRuns.filter(r => r.status === 'needs_input');
  const failedRuns = workerRuns.filter(r => r.status === 'failed');
  const completedToday = workerRuns.filter(r => {
    if (r.status !== 'completed') return false;
    const d = parseDate(r.ended_at || r.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const reviewTasks = tasks.filter(t => t.status === 'review');

  // Build triage items sorted by urgency.
  // Track task ids that already appear via due-date triage so we don't re-list
  // them as separate "Ready for review" rows — the overdue/due-soon row
  // already surfaces the same task with more actionable context.
  const dueDateTaskIds = new Set();
  const triageItems = [];

  const runTitle = (run, task) => {
    if (run.is_manager) return DASHBOARD_LABELS.triageManagerTitle;
    return task?.title || `${DASHBOARD_LABELS.runFallbackPrefix} ${run.id.slice(0, 8)}`;
  };

  if (manager?.status?.active && manager.status.run) {
    const mrun = manager.status.run;
    triageItems.push({
      type: 'manager',
      priority: -1,
      title: DASHBOARD_LABELS.triageManagerTitle,
      meta: `${DASHBOARD_LABELS.triageManagerMetaActive} · ${timeAgo(mrun.started_at || mrun.created_at)}`,
      run: null,
      task: null,
    });
  }

  // Due-date triage: overdue and due-soon (excluding done tasks)
  tasks.forEach(t => {
    if (t.status === 'done') return;
    const due = dueDateMeta(t);
    if (!due) return;
    if (due.state === 'overdue') {
      triageItems.push({
        type: 'overdue',
        priority: 1.5, // between failed (1) and running (2)
        title: t.title,
        meta: `마감일 지남 ${due.formatted} (${due.label})`,
        run: null,
        task: t,
      });
      dueDateTaskIds.add(t.id);
    } else if (due.state === 'due-soon') {
      triageItems.push({
        type: 'due-soon',
        priority: 1.7,
        title: t.title,
        meta: `마감 임박 ${due.formatted} (${due.label})`,
        run: null,
        task: t,
      });
      dueDateTaskIds.add(t.id);
    }
  });

  needsInputRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'needs-input',
      priority: 0,
      title: runTitle(run, task),
      meta: `${DASHBOARD_LABELS.triageNeedsInputMeta} · ${timeAgo(run.updated_at || run.created_at)}`,
      run,
      task,
    });
  });

  fleetModel.blockedNodes.forEach(node => {
    const nodeBlockedMeta = Number(node.cordoned || 0) === 1
      ? DASHBOARD_LABELS.triageNodeCordonedMeta
      : DASHBOARD_LABELS.triageNodeUnreachableMeta;
    triageItems.push({
      type: 'node-unreachable',
      priority: 0.5,
      title: `${nodeDisplayName(node)} 노드`,
      meta: `${nodeBlockedMeta} · ${DASHBOARD_LABELS.fleetQueuedLabel} ${Number(node.queued_total || 0)}`,
      run: null,
      task: null,
      node,
    });
  });

  failedRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'failed',
      priority: 1,
      title: runTitle(run, task),
      meta: `${DASHBOARD_LABELS.triageFailedMeta} · ${timeAgo(run.updated_at || run.created_at)}`,
      run,
      task,
    });
  });

  activeRuns.forEach(run => {
    const task = tasks.find(t => t.id === run.task_id);
    triageItems.push({
      type: 'running',
      priority: 2,
      title: runTitle(run, task),
      meta: `${DASHBOARD_LABELS.triageRunningMeta} · ${timeAgo(run.created_at)}`,
      run,
      task,
    });
  });

  reviewTasks.forEach(task => {
    // Suppress review row if this task is already surfaced by a due-date row.
    if (dueDateTaskIds.has(task.id)) return;
    triageItems.push({
      type: 'review',
      priority: 3,
      title: task.title,
      meta: `${DASHBOARD_LABELS.triageReviewMeta} · ${timeAgo(task.updated_at || task.created_at)}`,
      run: null,
      task,
    });
  });

  triageItems.sort((a, b) => a.priority - b.priority);

  const iconMap = {
    'needs-input': '\u270B',
    'failed': '\u2718',
    'running': '\u25B6',
    'review': '\u2714',
    'done': '\u2713',
    'manager': '\u2726',
    'overdue': '\u23F0',
    'due-soon': '\u23F0',
    'node-unreachable': '\u26A0',
  };

  return html`
    <div class="dashboard-view" data-view="dashboard">
      <div class="dashboard-header">
        <h1 class="dashboard-title">${DASHBOARD_LABELS.pageTitle}</h1>
      </div>
      <div class="stats-bar">
        <div class="stat-chip stat-running">
          <div>
            <div class="stat-value">${activeRuns.length}</div>
            <div class="stat-label">${DASHBOARD_LABELS.statActive}</div>
          </div>
        </div>
        <div class="stat-chip stat-queued" data-role="queued-total-stat">
          <div>
            <div class="stat-value">${fleetModel.queuedTotal}</div>
            <div class="stat-label">${DASHBOARD_LABELS.statQueued}</div>
          </div>
        </div>
        <div class="stat-chip stat-needs-input">
          <div>
            <div class="stat-value">${needsInputRuns.length}</div>
            <div class="stat-label">${DASHBOARD_LABELS.statNeedsInput}</div>
          </div>
        </div>
        <div class="stat-chip stat-failed">
          <div>
            <div class="stat-value">${failedRuns.length}</div>
            <div class="stat-label">${DASHBOARD_LABELS.statFailed}</div>
          </div>
        </div>
        <div class="stat-chip stat-done">
          <div>
            <div class="stat-value">${completedToday.length}</div>
            <div class="stat-label">${DASHBOARD_LABELS.statDoneToday}</div>
          </div>
        </div>
        ${/* v3 Phase 7: Drift badge. Hidden when zero so the bar stays
             calm. Clickable → opens the DriftDrawer at app level. */ ''}
        ${driftAudit && driftAudit.totalCount > 0 && html`
          <div
            class="stat-chip stat-failed"
            style="cursor:pointer"
            role="button"
            tabIndex=${0}
            title=${DASHBOARD_LABELS.driftClickHint}
            aria-label=${`${DASHBOARD_LABELS.driftAriaPrefix}: ${driftAudit.totalCount}${DASHBOARD_LABELS.driftAriaSuffix}`}
            onClick=${() => onOpenDrift && onOpenDrift()}
            onKeyDown=${(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDrift && onOpenDrift(); } }}
          >
            <div>
              <div class="stat-value">${driftAudit.totalCount}</div>
              <div class="stat-label">${DASHBOARD_LABELS.statDriftLabelPrefix} \u26A0</div>
            </div>
          </div>
        `}
      </div>
      ${fleetModel.visible && html`
        <section class="fleet-strip" data-role="fleet-strip" aria-label=${DASHBOARD_LABELS.fleetTitle}>
          <div class="fleet-strip-head">
            <div>
              <div class="fleet-strip-title">${DASHBOARD_LABELS.fleetTitle}</div>
              <div class="fleet-strip-meta">${DASHBOARD_LABELS.fleetQueuedSummary} ${fleetModel.queuedTotal}</div>
            </div>
            ${fleetModel.unreachableNodes.length > 0 && html`
              <a
                class="fleet-strip-warning"
                data-role="fleet-unreachable-warning"
                href=${nodeDetailHref(fleetModel.unreachableNodes[0].node_id)}
              >
                ${DASHBOARD_LABELS.fleetUnreachablePrefix} ${fleetModel.unreachableNodes.length}
              </a>
            `}
          </div>
          <div class="fleet-node-list">
            ${fleetModel.rows.map(node => {
              const running = Number(node.running_total || 0);
              const queued = Number(node.queued_total || 0);
              const max = node.max_concurrent == null ? null : Number(node.max_concurrent);
              const slotLabel = max == null ? DASHBOARD_LABELS.fleetSlotsInfinite : max;
              const pct = max && max > 0 ? Math.min(100, Math.round((running / max) * 100)) : 0;
              return html`
                <a
                  key=${node.node_id}
                  class="fleet-node-row ${node.reachable ? '' : 'unreachable'}"
                  data-role="fleet-node-row"
                  href=${nodeDetailHref(node.node_id)}
                >
                  <span class="fleet-node-name">${nodeDisplayName(node)}</span>
                  <span class="fleet-node-slots">
                    ${DASHBOARD_LABELS.fleetRunningLabel} ${running} · ${DASHBOARD_LABELS.fleetQueuedLabel} ${queued} / ${DASHBOARD_LABELS.fleetSlotLabel} ${slotLabel}
                  </span>
                  <span class="fleet-slot-bar" aria-hidden="true"><span class="fleet-slot-fill" style=${`width:${pct}%`}></span></span>
                </a>
              `;
            })}
          </div>
        </section>
      `}
      <div class="triage-feed" tabindex="0" role="region" aria-label="Triage feed">
        ${triageItems.length === 0 && html`
          <${EmptyState}
            icon="\u2726"
            text=${DASHBOARD_LABELS.emptyText}
            sub=${DASHBOARD_LABELS.emptySub}
          />
        `}
        ${triageItems.map((item, i) => html`
          <div
            key=${item.run?.id || item.task?.id || `manager-${i}`}
            class="triage-item"
            data-role=${item.type === 'node-unreachable' ? 'node-attention-item' : undefined}
            onClick=${() => {
              if (item.type === 'manager') { navigate('manager'); return; }
              if (item.type === 'node-unreachable' && item.node) {
                navigate(`resources/nodes/${encodeURIComponent(item.node.node_id)}`);
                return;
              }
              if (item.type === 'overdue' || item.type === 'due-soon' || item.type === 'review') {
                if (item.task && onOpenTask) onOpenTask(item.task);
                return;
              }
              if (item.run) onOpenRun(item.run);
            }}
          >
            <div class="triage-icon ${item.type}">${iconMap[item.type]}</div>
            <div class="triage-body">
              <div class="triage-title">${item.title}</div>
              <div class="triage-meta">${item.meta}</div>
            </div>
            <div class="triage-actions">
              ${item.type === 'needs-input' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onOpenRun(item.run); }}>
                  ${DASHBOARD_LABELS.actionRespond}
                </button>
              `}
              ${item.type === 'failed' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onDeleteRun(item.run.id); }}>
                  ${DASHBOARD_LABELS.actionDismiss}
                </button>
              `}
              ${item.type === 'running' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.run && onOpenRun(item.run); }}>
                  ${DASHBOARD_LABELS.actionInspect}
                </button>
              `}
              ${item.type === 'review' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); if (item.task && onOpenTask) onOpenTask(item.task); }}>
                  ${DASHBOARD_LABELS.actionReview}
                </button>
              `}
              ${item.type === 'manager' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); navigate('manager'); }}>
                  ${DASHBOARD_LABELS.actionOpen}
                </button>
              `}
              ${item.type === 'node-unreachable' && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); item.node && navigate(`resources/nodes/${encodeURIComponent(item.node.node_id)}`); }}>
                  ${DASHBOARD_LABELS.actionOpenNode}
                </button>
              `}
              ${(item.type === 'overdue' || item.type === 'due-soon') && html`
                <button class="ghost" onClick=${(e) => { e.stopPropagation(); if (item.task && onOpenTask) onOpenTask(item.task); }}>
                  ${DASHBOARD_LABELS.actionOpen}
                </button>
              `}
            </div>
          </div>
        `)}
      </div>
      ${claudeSessions && claudeSessions.length > 0 && html`
        <div style="padding: 0 28px 28px;">
          <div class="task-detail-section-title" style="margin-bottom:8px;">${DASHBOARD_LABELS.claudeSessionsTitle} (${claudeSessions.filter(s => s.alive).length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${claudeSessions.filter(s => s.alive).map(s => html`
              <div key=${s.pid} class="claude-session-item">
                <span class="run-status-dot running"></span>
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${s.projectName}
                  </div>
                  <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title=${s.cwd}>
                    ${s.cwd}
                  </div>
                </div>
                <div style="text-align:right;flex-shrink:0;">
                  <div style="font-size:11px;color:var(--text-muted);">PID ${s.pid}</div>
                  <div style="font-size:11px;color:var(--text-secondary);">${formatDuration(s.runningFor)}</div>
                </div>
              </div>
            `)}
          </div>
        </div>
      `}
    </div>
  `;
}
