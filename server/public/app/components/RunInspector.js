// RunInspector — slide-over panel that polls a single run for live
// output, events, diff, costs, and status, and lets the user send input
// or cancel the run.
//
// R2-B.1: converted from centered modal (`.modal-overlay` +
//   `.modal-panel.wide`) to right-anchored slide-over
//   (`.run-inspector-overlay` + `.run-inspector-slideover`). The
//   close semantics (Escape + backdrop click) are unchanged from the
//   modal version; Escape was previously routed at the app level so
//   this component now owns its own keydown handler for parity with
//   DriftDrawer.
// R2-B.2: added Diff tab — fetches `GET /api/runs/:id/diff` lazily
//   on first activation + every 5s while tab stays visible.
// R2-B.3: added Costs tab — surfaces `runs.cost_usd` for Claude Code
//   workers and aggregates `mgr.usage` events for Codex managers.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef, useMemo } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { timeAgo } from '../lib/format.js';

/**
 * R2-B.2: Colorise a unified diff string into per-line spans so +/-
 * lines visually pop. We avoid DOM injection — each line is stored
 * as `{ cls, text }` and rendered as a real child so HTM escapes
 * text content. This also keeps line-by-line layout deterministic
 * when `truncated` trims mid-line (the trailing partial line just
 * renders without a class).
 */
function splitDiffLines(diffText) {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  return lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return { cls: 'diff-file', text: line };
    if (line.startsWith('diff --git ')) return { cls: 'diff-file', text: line };
    if (line.startsWith('@@')) return { cls: 'diff-hunk', text: line };
    if (line.startsWith('+')) return { cls: 'diff-add', text: line };
    if (line.startsWith('-')) return { cls: 'diff-del', text: line };
    return { cls: '', text: line };
  });
}

/**
 * R2-B.3: sum `mgr.usage` payloads across this run's events. Each
 * `mgr.usage` event payload looks like
 *   { inputTokens, outputTokens, cachedInputTokens?, costUsd? }
 * Codex emits usage per turn (no dollars), Claude Code emits usage
 * per turn with `costUsd`. We accumulate all three so a long manager
 * conversation shows the session total rather than just the last turn.
 */
function aggregateManagerUsage(events) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;
  let turns = 0;
  let hasAny = false;
  for (const evt of events || []) {
    if (evt.event_type !== 'mgr.usage') continue;
    let payload = null;
    try { payload = JSON.parse(evt.payload_json || '{}'); } catch { continue; }
    const data = payload?.data || {};
    inputTokens += Number(data.inputTokens || 0);
    outputTokens += Number(data.outputTokens || 0);
    cachedInputTokens += Number(data.cachedInputTokens || 0);
    if (data.costUsd != null) costUsd += Number(data.costUsd || 0);
    turns += 1;
    hasAny = true;
  }
  return hasAny ? { inputTokens, outputTokens, cachedInputTokens, costUsd, turns } : null;
}

function RunSkillItem({ sp, runId, acceptanceChecks, onCheckToggle }) {
  const [showMcp, setShowMcp] = useState(false);
  let checklist = [];
  try { checklist = JSON.parse(sp.checklist_snapshot || '[]'); } catch { /* */ }
  const mcpSnap = sp.mcp_snapshot || null;
  return html`
    <div>
      <div class="run-skill-item">
        <span class="run-skill-name">${sp.name || sp.skill_pack_id?.slice(0, 8)}</span>
        <span class="run-skill-mode">${sp.applied_mode || 'full'}</span>
        <span style=${{ fontSize: '10px', color: 'var(--text-muted)' }}>P${sp.effective_priority ?? '?'}</span>
        <span style=${{ fontSize: '10px', color: 'var(--text-muted)' }}>#${(sp.applied_order ?? 0) + 1}</span>
      </div>
      ${checklist.length > 0 && html`
        <div class="run-skill-checklist">
          ${checklist.map((item, i) => {
            const globalIdx = (sp._checkOffset || 0) + i;
            const check = (acceptanceChecks || []).find(c => c.check_index === globalIdx);
            const checked = check ? !!check.checked : false;
            return html`
              <label key=${i} style=${{ cursor: 'pointer' }}>
                <input type="checkbox" checked=${checked}
                  onChange=${() => onCheckToggle && onCheckToggle(globalIdx, !checked)} />
                ${item}
              </label>
            `;
          })}
        </div>
      `}
      ${mcpSnap && html`
        <div>
          <button class="ghost small" style=${{ fontSize: '10px', padding: '2px 6px' }}
            onClick=${() => setShowMcp(v => !v)}>
            ${showMcp ? 'Hide MCP Config' : 'Show MCP Config'}
          </button>
          ${showMcp && html`<pre class="run-skill-mcp-snap">${typeof mcpSnap === 'string' ? mcpSnap : JSON.stringify(mcpSnap, null, 2)}</pre>`}
        </div>
      `}
    </div>
  `;
}

export function RunInspector({ run, onClose }) {
  const [events, setEvents] = useState([]);
  const [liveOutput, setLiveOutput] = useState('');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [currentRun, setCurrentRun] = useState(run);
  const [tab, setTab] = useState('output');
  const [skillPacks, setSkillPacks] = useState([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [acceptanceChecks, setAcceptanceChecks] = useState([]);
  // Phase 10F: preset snapshot + drift
  // presetLoaded guard removed (D2a): always refetch on tab activation for freshness.
  const [presetData, setPresetData] = useState(null);
  const [presetFetchError, setPresetFetchError] = useState(null);
  const [presetFetching, setPresetFetching] = useState(false);
  const presetFetchRef = useRef(false); // in-flight dedup
  // R2-B.2: diff tab state — lazy load on first activation; poll every
  // 5s while the tab is visible so an actively running agent's diff
  // refreshes without a manual refresh button.
  const [diff, setDiff] = useState(null);
  const [diffTruncated, setDiffTruncated] = useState(false);
  const [diffReason, setDiffReason] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const diffFetchRef = useRef(false);
  // R2-B.3: a dedicated event store for the Costs tab.
  //
  // Codex R2-B review (Medium 3): the main `events` array is capped
  // at 500 entries by the polling loop (to keep the Events tab DOM
  // bounded), which means a long-running manager session drops its
  // earliest `mgr.usage` events from memory. Aggregating against
  // `events` would then undercount cumulative tokens — visible to
  // users as "session total went DOWN after a tab switch".
  //
  // For Costs we therefore fetch the entire event stream (no
  // `after=` cursor, no cap) on tab activation + every 10s while
  // visible. This is additive to the main poll; the Events tab still
  // shows the 500 latest items.
  const [costEvents, setCostEvents] = useState(null);
  const costEventsFetchRef = useRef(false);
  const outputRef = useRef(null);
  const slideoverRef = useRef(null);
  const userScrolledUp = useRef(false);

  // Poll live output + events + run status
  useEffect(() => {
    if (!run) return;
    setCurrentRun(run);
    setEvents([]);
    setLiveOutput('');
    let cancelled = false;
    let lastEventId = 0;

    const poll = async () => {
      while (!cancelled) {
        try {
          // Fetch live output from tmux/subprocess
          const outputData = await apiFetch(`/api/runs/${run.id}/output?lines=200`);
          if (!cancelled && outputData.output) {
            setLiveOutput(outputData.output);
          }

          // Fetch new events
          const evtData = await apiFetch(`/api/runs/${run.id}/events?after=${lastEventId}`);
          if (cancelled) break;
          const newEvents = evtData.events || [];
          if (newEvents.length) {
            lastEventId = Math.max(...newEvents.map(e => e.id || 0));
            setEvents(prev => {
              const combined = [...prev, ...newEvents];
              return combined.length > 500 ? combined.slice(-500) : combined;
            });
          }

          // Refresh run status
          const runData = await apiFetch(`/api/runs/${run.id}`);
          if (!cancelled) {
            setCurrentRun(runData.run);
            if (['completed', 'failed', 'cancelled', 'stopped'].includes(runData.run?.status)) {
              // One final output fetch
              try {
                const finalOut = await apiFetch(`/api/runs/${run.id}/output?lines=200`);
                if (finalOut.output) setLiveOutput(finalOut.output);
              } catch {}
              break;
            }
          }
        } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    poll();
    return () => { cancelled = true; };
  }, [run?.id]);

  // Auto-scroll output unless user scrolled up
  useEffect(() => {
    if (outputRef.current && !userScrolledUp.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [liveOutput]);

  // R2-B.1: Escape-to-close + open/close focus management.
  //
  // Codex R2-B review (Medium 1): we intentionally allow tab flow to
  // escape the panel — the panel has live-updating regions and making
  // users cycle focus inside them is hostile. That is a deliberate
  // non-modal interaction, so we do NOT advertise `aria-modal="true"`
  // on the panel root; the parent dialog role is still useful for
  // structure but the aria-modal lie is removed.
  //
  // Codex R2-B review (Medium 2): on close we must restore focus to
  // the element that opened the panel. Skipping this leaves focus on
  // <body>, which is disorienting for keyboard/AT users. We snapshot
  // `document.activeElement` on mount and `.focus()` it on unmount.
  //
  // `requestAnimationFrame` (not `queueMicrotask`) is used for the
  // open-time focus call so focus moves after the panel's slide-in
  // has at least been laid out; microtasks run before paint, which
  // meant a screen reader could announce "focused" on a panel the
  // user hadn't seen arrive yet.
  useEffect(() => {
    if (!run) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { onClose && onClose(); }
    };
    window.addEventListener('keydown', onKeyDown);
    const raf = requestAnimationFrame(() => {
      slideoverRef.current?.focus?.();
    });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      cancelAnimationFrame(raf);
      // Only restore focus if the previously focused element is still
      // in the DOM and is not the <body> fallback. This avoids fighting
      // subsequent UI that might have moved focus intentionally.
      if (previouslyFocused
        && previouslyFocused !== document.body
        && document.contains(previouslyFocused)) {
        try { previouslyFocused.focus(); } catch { /* best-effort */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  // R2-B.3: Costs tab — fetch complete event list so mgr.usage
  // aggregation is not bounded by the Events tab's 500-item cap.
  // 10s cadence (slower than diff because usage events arrive at
  // turn boundaries, not continuously).
  useEffect(() => {
    if (!run || tab !== 'costs') return;
    let cancelled = false;
    const fetchCostEvents = async () => {
      if (costEventsFetchRef.current) return;
      costEventsFetchRef.current = true;
      try {
        // after=0 pulls the full stream (server returns all events
        // with id > 0). We only actually need `mgr.usage` entries —
        // the server could grow a query param someday, but for now
        // filtering client-side is fine: the typical long session
        // has ~a few hundred events, and we already fetch 200 in the
        // main poll without issue.
        const data = await apiFetch('/api/runs/' + run.id + '/events?after=0');
        if (!cancelled) setCostEvents(data.events || []);
      } catch { /* keep previous snapshot */ }
      finally { costEventsFetchRef.current = false; }
    };
    fetchCostEvents();
    const interval = setInterval(fetchCostEvents, 10000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, run?.id]);

  // R2-B.2: diff tab lazy fetch + 5s refresh while visible.
  // We key the interval on both `tab` and `run?.id` so switching tabs
  // tears down the poll, and switching runs resets it.
  useEffect(() => {
    if (!run || tab !== 'diff') return;
    let cancelled = false;
    const fetchDiff = async () => {
      if (diffFetchRef.current) return; // in-flight dedup
      diffFetchRef.current = true;
      setDiffLoading(true);
      try {
        const data = await apiFetch('/api/runs/' + run.id + '/diff');
        if (cancelled) return;
        setDiff(data.diff ?? null);
        setDiffTruncated(!!data.truncated);
        setDiffReason(data.reason || null);
      } catch (err) {
        if (!cancelled) {
          setDiffReason('fetch_failed');
        }
      } finally {
        diffFetchRef.current = false;
        if (!cancelled) setDiffLoading(false);
      }
    };
    fetchDiff();
    const interval = setInterval(fetchDiff, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, run?.id]);

  const handleOutputScroll = () => {
    if (!outputRef.current) return;
    const el = outputRef.current;
    userScrolledUp.current = el.scrollTop + el.clientHeight < el.scrollHeight - 40;
  };

  if (!run) return null;

  const handleSendInput = async () => {
    if (!inputText.trim()) return;
    setSending(true);
    try {
      // v3 Phase 1.5: use the new /api/conversations/worker:<id>/message
      // entry point. Going through this path guarantees the parent-notice
      // router fires (lock-in #2 + principle 9): the user's direct message
      // to this worker is queued as a system notice for the Top manager's
      // next turn. The legacy /api/runs/:id/input route is still an alias
      // for external callers but the in-app UI now speaks the new shape.
      await apiFetch(`/api/conversations/worker:${encodeURIComponent(run.id)}/message`, {
        method: 'POST',
        body: JSON.stringify({ text: inputText.trim() }),
      });
      setInputText('');
    } catch (err) {
      addToast?.(err.message, 'error');
    }
    setSending(false);
  };

  // v3 Phase 1.5: parent_run_id is set iff this worker was spawned by a
  // manager (Top in 1.5). We use it to show a visible hint next to the
  // input so users understand that direct messages surface to Top —
  // Principle 9 made legible.
  const hasManagerParent = !!(currentRun?.parent_run_id || run?.parent_run_id);

  const handleCancel = async () => {
    if (!confirm('Cancel this run?')) return;
    try {
      await apiFetch(`/api/runs/${run.id}/cancel`, { method: 'POST' });
    } catch (err) {
      addToast?.(err.message, 'error');
    }
  };

  const status = currentRun?.status || run.status;
  const isActive = status === 'running' || status === 'needs_input';

  // Filter meaningful events (skip heartbeats)
  const meaningfulEvents = events.filter(evt => {
    const t = evt.event_type || '';
    return t !== 'heartbeat';
  });

  // R2-B.3: cost view data. Worker-side cost_usd comes straight off
  // the run row; manager-side usage is aggregated from events. When
  // both are zero we render an empty state so OpenCode / unsupported
  // adapters don't show a confusing "$0.0000" headline.
  //
  // Manager runs persist their aggregated usage back into the run row
  // (codexAdapter.js updateRunResult) so the row-level tokens match the
  // event-level totals. Showing both as separate cards double-counts
  // and confuses the user — for is_manager=1 we surface only the
  // Manager Usage breakdown, which has the richer shape (cached input,
  // turn count).
  // R2-B.2: memoize line split so a 1 MiB diff doesn't re-parse on
  // every unrelated render (loading-state toggle, Events tab's
  // arrival of new events, etc.). Only recomputes when `diff` itself
  // changes — the poll loop calls setDiff with the same string when
  // nothing has changed (React won't re-render in that case, but
  // it's cheap insurance).
  const diffLines = useMemo(() => splitDiffLines(diff), [diff]);

  const isManagerRun = !!(currentRun?.is_manager || run?.is_manager);
  const workerCostUsd = typeof currentRun?.cost_usd === 'number'
    ? currentRun.cost_usd
    : typeof run.cost_usd === 'number' ? run.cost_usd : 0;
  const workerInputTokens = Number(currentRun?.input_tokens || run.input_tokens || 0);
  const workerOutputTokens = Number(currentRun?.output_tokens || run.output_tokens || 0);
  // Use the dedicated full-stream snapshot when present; fall back to
  // the bounded `events` array if the Costs tab hasn't loaded yet
  // (keeps the first render meaningful instead of flashing "no data").
  const managerUsage = aggregateManagerUsage(costEvents || events);
  const showWorkerCost = !isManagerRun
    && (workerCostUsd > 0 || workerInputTokens > 0 || workerOutputTokens > 0);
  const showManagerUsage = !!managerUsage;
  const hasCostData = showWorkerCost || showManagerUsage;

  return html`
    <div class="run-inspector-overlay">
      <div class="run-inspector-backdrop" onClick=${onClose}></div>
      <div
        class="run-inspector-slideover"
        ref=${slideoverRef}
        tabIndex="-1"
        role="dialog"
        aria-label="Run inspector"
      >
        <div class="run-inspector-header">
          <h2 class="run-inspector-title">${currentRun?.task_title || run.task_title || 'Run Inspector'}</h2>
          <button class="ghost" onClick=${onClose}>Close</button>
        </div>
        <div class="run-status-bar">
          <span class="run-status-dot ${status}"></span>
          <span>${status}</span>
          <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${currentRun?.agent_name || run.agent_name || ''}</span>
          <span style="margin-left: auto; font-size: 11px; color: rgba(155,178,166,0.55);">
            Started ${timeAgo(run.created_at)}
          </span>
          ${isActive && html`
            <button class="ghost danger" style="font-size: 10px; padding: 3px 8px;" onClick=${handleCancel}>Cancel</button>
          `}
        </div>

        ${currentRun?.result_summary && html`
          <div class="run-result-summary" style="padding:8px 16px;background:var(--bg-secondary,rgba(0,0,0,0.15));border-bottom:1px solid var(--border-color,rgba(155,178,166,0.1));font-size:12px;color:var(--text-secondary);">
            <span style="font-weight:600;color:var(--text-muted);margin-right:6px;">Summary:</span>
            ${currentRun.result_summary}
          </div>
        `}
        <div class="run-inspector-tabs">
          <button class="run-inspector-tab ${tab === 'output' ? 'active' : ''}" onClick=${() => setTab('output')}>
            Live Output
          </button>
          <button class="run-inspector-tab ${tab === 'events' ? 'active' : ''}" onClick=${() => setTab('events')}>
            Events (${meaningfulEvents.length})
          </button>
          <button class="run-inspector-tab ${tab === 'diff' ? 'active' : ''}" onClick=${() => setTab('diff')}>
            Diff
          </button>
          <button class="run-inspector-tab ${tab === 'costs' ? 'active' : ''}" onClick=${() => setTab('costs')}>
            Costs
          </button>
          <button class="run-inspector-tab ${tab === 'skills' ? 'active' : ''}" onClick=${async () => {
            setTab('skills');
            if (!skillsLoaded) {
              try {
                const data = await apiFetch('/api/runs/' + run.id + '/skill-packs');
                setSkillPacks(data.skill_packs || []);
                setAcceptanceChecks(data.acceptance_checks || []);
              } catch { /* ignore */ }
              setSkillsLoaded(true);
            }
          }}>
            Skills${skillPacks.length > 0 ? ` (${skillPacks.length})` : ''}
          </button>
          ${currentRun?.preset_id && html`
            <button class="run-inspector-tab ${tab === 'preset' ? 'active' : ''}" onClick=${async () => {
              setTab('preset');
              // D2a: always refetch on activation; in-flight dedup prevents duplicate requests
              if (presetFetchRef.current) return;
              presetFetchRef.current = true;
              setPresetFetching(true);
              try {
                const data = await apiFetch('/api/runs/' + run.id + '/preset-snapshot');
                setPresetData(data);
                setPresetFetchError(null);
              } catch (err) {
                // Keep existing presetData if already loaded (transient errors shouldn't wipe valid snapshot)
                setPresetFetchError(err.message || 'Failed to load preset');
              } finally {
                presetFetchRef.current = false;
                setPresetFetching(false);
              }
            }}>
              ${(() => {
                if (!presetData) return 'Preset';
                const d = presetData.drift;
                if (!d) return 'Preset';
                if (d.deleted) return 'Preset ⚠ deleted';
                const totalChanges = (d.changed_fields?.length || 0) + (d.changed_files?.length || 0);
                if (totalChanges > 0) return `Preset ⚠ ${totalChanges}`;
                // drift_error present but no actual field/file changes → show bare warning
                if (d.drift_error) return 'Preset ⚠';
                return 'Preset';
              })()}
            </button>
          `}
        </div>

        ${tab === 'output' && html`
          <div class="run-output-area" ref=${outputRef} onScroll=${handleOutputScroll}>
            ${liveOutput
              ? html`<pre class="run-output-pre">${liveOutput}</pre>`
              : html`<div style="color:var(--text-muted);text-align:center;padding:40px 0;">
                  ${isActive ? 'Waiting for output...' : 'No output captured.'}
                </div>`
            }
          </div>
        `}

        ${tab === 'events' && html`
          <div class="run-events-list">
            ${meaningfulEvents.length === 0 && html`
              <div class="run-event-item" style="color: rgba(155,178,166,0.5); text-align: center;">
                No events yet.
              </div>
            `}
            ${meaningfulEvents.map((evt, i) => {
              const evtType = evt.event_type || 'event';
              let evtText = '';
              try {
                const p = evt.payload_json ? JSON.parse(evt.payload_json) : {};
                evtText = p.text || p.message || p.result || p.output?.slice(0, 300) || p.tool || '';
                if (!evtText && Object.keys(p).length > 0) evtText = JSON.stringify(p);
              } catch { evtText = evt.payload_json || ''; }
              return html`
                <div key=${i} class="run-event-item">
                  <span class="event-channel">${evtType}</span>
                  <span class="run-event-text">${evtText}</span>
                </div>
              `;
            })}
          </div>
        `}

        ${tab === 'diff' && html`
          <div class="run-diff-area">
            ${diffTruncated && html`
              <div class="run-diff-warning">
                ⚠ Diff truncated at 1 MiB — showing the first portion only. Check the worktree directly for the full changeset.
              </div>
            `}
            ${(() => {
              if (diffLoading && diff === null && !diffReason) {
                return html`<div class="run-diff-empty">Loading diff...</div>`;
              }
              if (diffReason === 'no_worktree') {
                return html`<div class="run-diff-empty">This run did not create an isolated git worktree.</div>`;
              }
              if (diffReason === 'worktree_missing') {
                return html`<div class="run-diff-empty">Worktree directory no longer exists (it may have been cleaned up).</div>`;
              }
              if (diffReason === 'git_failed' || diffReason === 'fetch_failed') {
                return html`<div class="run-diff-empty">Could not compute diff.</div>`;
              }
              if (diff === '') {
                return html`<div class="run-diff-empty">No uncommitted changes in the worktree.</div>`;
              }
              return html`
                <pre class="run-diff-pre">${diffLines.map((l, i) => html`
                  <span key=${i} class=${l.cls}>${l.text}${i < diffLines.length - 1 ? '\n' : ''}</span>
                `)}</pre>
              `;
            })()}
          </div>
        `}

        ${tab === 'costs' && html`
          <div class="run-cost-area">
            ${!hasCostData && html`
              <div class="run-cost-empty">
                Cost data not available for this adapter.
                <div style=${{ fontSize: '11px', marginTop: '4px', opacity: 0.8 }}>
                  Claude Code workers and Codex manager sessions report usage; OpenCode and other adapters do not.
                </div>
              </div>
            `}
            ${showWorkerCost && html`
              <div class="run-cost-card">
                <div class="run-cost-card-label">Worker cost</div>
                <div class="run-cost-card-value">
                  ${workerCostUsd > 0 ? '$' + workerCostUsd.toFixed(4) : '—'}
                </div>
                ${(workerInputTokens > 0 || workerOutputTokens > 0) && html`
                  <dl class="run-cost-breakdown" style=${{ marginTop: '10px' }}>
                    <dt>Input tokens</dt><dd>${workerInputTokens.toLocaleString()}</dd>
                    <dt>Output tokens</dt><dd>${workerOutputTokens.toLocaleString()}</dd>
                  </dl>
                `}
                <div class="run-cost-card-sub">
                  Reported by the worker adapter on completion.
                </div>
              </div>
            `}
            ${showManagerUsage && html`
              <div class="run-cost-card">
                <div class="run-cost-card-label">Manager usage (${managerUsage.turns} turn${managerUsage.turns === 1 ? '' : 's'})</div>
                <div class="run-cost-card-value">
                  ${managerUsage.costUsd > 0 ? '$' + managerUsage.costUsd.toFixed(4) : (managerUsage.inputTokens + managerUsage.outputTokens).toLocaleString() + ' tokens'}
                </div>
                <dl class="run-cost-breakdown" style=${{ marginTop: '10px' }}>
                  <dt>Input tokens</dt><dd>${managerUsage.inputTokens.toLocaleString()}</dd>
                  ${managerUsage.cachedInputTokens > 0 && html`
                    <dt>Cached input</dt><dd>${managerUsage.cachedInputTokens.toLocaleString()}</dd>
                  `}
                  <dt>Output tokens</dt><dd>${managerUsage.outputTokens.toLocaleString()}</dd>
                  ${managerUsage.costUsd > 0 && html`<dt>Cost</dt><dd>$${managerUsage.costUsd.toFixed(4)}</dd>`}
                </dl>
                <div class="run-cost-card-sub">
                  Aggregated from <code>mgr.usage</code> run events. Codex does not report dollar cost.
                </div>
              </div>
            `}
          </div>
        `}

        ${tab === 'skills' && html`
          <div class="run-skills-section" style=${{ flex: 1, overflowY: 'auto' }}>
            ${skillPacks.length === 0 && html`
              <div style="color:var(--text-muted);text-align:center;padding:40px 0;">
                ${skillsLoaded ? 'No skill packs applied to this run.' : 'Loading...'}
              </div>
            `}
            ${(() => {
              const sorted = [...skillPacks].sort((a, b) => (a.applied_order ?? 0) - (b.applied_order ?? 0));
              let offset = 0;
              return sorted.map(sp => {
                const checkCount = (() => { try { return JSON.parse(sp.checklist_snapshot || '[]').length; } catch { return 0; } })();
                const item = html`<${RunSkillItem} key=${sp.skill_pack_id} sp=${{ ...sp, _checkOffset: offset }}
                  runId=${run.id} acceptanceChecks=${acceptanceChecks}
                  onCheckToggle=${async (idx, checked) => {
                    try {
                      const res = await apiFetch('/api/runs/' + run.id + '/skill-packs/checks', {
                        method: 'PATCH',
                        body: JSON.stringify({ checks: [{ check_index: idx, checked }] }),
                      });
                      setAcceptanceChecks(res.acceptance_checks || []);
                    } catch { /* ignore */ }
                  }} />`;
                offset += checkCount;
                return item;
              });
            })()}
          </div>
        `}

        ${tab === 'preset' && html`
          <div class="run-skills-section" style=${{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            ${presetFetching && html`<div style="color:var(--text-muted);">Loading preset snapshot...</div>`}
            ${!presetFetching && presetFetchError && html`
              <div style=${{ padding: '8px', background: 'color-mix(in srgb, var(--status-failed) 15%, transparent)', color: 'var(--status-failed)', borderRadius: '4px', marginBottom: '12px' }}>
                Failed to refresh preset snapshot: ${presetFetchError}
              </div>
            `}
            ${!presetFetching && !presetData?.snapshot && html`
              <div style="color:var(--text-muted);">No preset bound to this run.</div>
            `}
            ${!presetFetching && presetData?.snapshot && html`
              <div style=${{ marginBottom: '12px' }}>
                <div style=${{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Preset id: <code>${presetData.snapshot.preset_id}</code>
                </div>
                <div style=${{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Snapshot hash: <code>${(presetData.snapshot.preset_snapshot_hash || '').slice(0, 12)}…</code>
                </div>
                <div style=${{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Applied: ${presetData.snapshot.applied_at}
                </div>
              </div>
              ${presetData.drift?.deleted && html`
                <div style=${{ padding: '8px', background: 'color-mix(in srgb, var(--status-failed) 15%, transparent)', color: 'var(--status-failed)', borderRadius: '4px', marginBottom: '12px' }}>
                  ⚠ The preset has been deleted since this run. Snapshot below is the only record.
                </div>
              `}
              ${presetData.drift && !presetData.drift.deleted && presetData.drift.drift_error && html`
                <div style=${{ padding: '8px', background: 'color-mix(in srgb, #f59e0b 15%, transparent)', color: '#f59e0b', borderRadius: '4px', marginBottom: '12px' }}>
                  ⚠ Preset file drift could not be computed. Core-field drift is shown, but plugin file comparison is unavailable.
                  <div style=${{ marginTop: '4px', fontSize: '11px', opacity: 0.85 }}>
                    Reason: ${presetData.drift.drift_error}
                  </div>
                </div>
              `}
              ${presetData.drift && !presetData.drift.deleted && presetData.drift.has_drift && html`
                <div style=${{ padding: '8px', background: 'color-mix(in srgb, #f59e0b 15%, transparent)', color: '#f59e0b', borderRadius: '4px', marginBottom: '12px' }}>
                  ⚠ Preset drift detected.
                  ${presetData.drift.changed_fields?.length > 0 && html`
                    <div style=${{ marginTop: '4px' }}>
                      Changed fields: <strong>${presetData.drift.changed_fields.join(', ')}</strong>
                    </div>
                  `}
                  ${presetData.drift.changed_files?.length > 0 && html`
                    <div style=${{ marginTop: '6px' }}>
                      <strong>Changed plugin files (${presetData.drift.changed_files.length}):</strong>
                      <ul style=${{ margin: '4px 0 0 0', paddingLeft: '16px', fontSize: '11px' }}>
                        ${presetData.drift.changed_files.map((f, i) => html`
                          <li key=${i}>
                            <code style=${{ marginRight: '6px' }}>${f.path}</code>
                            <span style=${{ color: f.status === 'deleted' ? 'var(--status-failed)' : f.status === 'added' ? 'var(--success)' : '#f59e0b' }}>
                              ${f.status}
                            </span>
                          </li>
                        `)}
                      </ul>
                    </div>
                  `}
                </div>
              `}
              ${presetData.drift && !presetData.drift.deleted && !presetData.drift.drift_error && !presetData.drift.has_drift && html`
                <div style=${{ padding: '8px', background: 'color-mix(in srgb, var(--success) 15%, transparent)', color: 'var(--success)', borderRadius: '4px', marginBottom: '12px' }}>
                  ✓ Preset matches the snapshot — no drift.
                </div>
              `}
              ${presetData.mcp_template_drift && presetData.mcp_template_drift.modified_count > 0 && html`
                <div style=${{ padding: '8px', background: 'color-mix(in srgb, #f59e0b 15%, transparent)', color: '#f59e0b', borderRadius: '4px', marginBottom: '12px' }}>
                  ⚠ ${presetData.mcp_template_drift.modified_count} MCP template${presetData.mcp_template_drift.modified_count === 1 ? '' : 's'} modified after run started.
                  <div style=${{ marginTop: '4px', fontSize: '11px' }}>
                    The preset snapshot froze the template <em>ids</em>, not the template bodies. These aliases have changed since the run spawned:
                  </div>
                  <ul style=${{ margin: '4px 0 0 0', paddingLeft: '16px', fontSize: '11px' }}>
                    ${presetData.mcp_template_drift.templates.map((t) => html`
                      <li key=${t.id}>
                        <code>${t.alias}</code>
                        <span style=${{ opacity: 0.7, marginLeft: '6px' }}>(updated ${t.updated_at})</span>
                      </li>
                    `)}
                  </ul>
                </div>
              `}
              <div style=${{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <div style=${{ fontWeight: 600, marginBottom: '4px' }}>Snapshot (run-time)</div>
                  <pre class="run-skill-mcp-snap" style=${{ fontSize: '11px', maxHeight: '400px', overflow: 'auto' }}>${JSON.stringify(presetData.snapshot.core, null, 2)}</pre>
                </div>
                <div>
                  <div style=${{ fontWeight: 600, marginBottom: '4px' }}>Current preset</div>
                  <pre class="run-skill-mcp-snap" style=${{ fontSize: '11px', maxHeight: '400px', overflow: 'auto' }}>${presetData.current_preset ? JSON.stringify(presetData.current_preset, null, 2) : '(deleted)'}</pre>
                </div>
              </div>
            `}
          </div>
        `}

        ${isActive && html`
          <div class="run-input-row">
            <input
              class="form-input"
              placeholder="Send input to agent..."
              value=${inputText}
              onInput=${e => setInputText(e.target.value)}
              onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendInput(); }}}
            />
            <button class="primary" onClick=${handleSendInput} disabled=${sending || !inputText.trim()}>
              ${sending ? '...' : 'Send'}
            </button>
          </div>
          ${hasManagerParent && html`
            <div class="run-input-hint" style="font-size:11px;color:var(--text-muted);padding:4px 2px 0;">
              \u2726 Top Manager will be notified of this direct message on its next turn.
            </div>
          `}
        `}
      </div>
    </div>
  `;
}
