// RunInspector — modal that polls a single run for live output, events,
// and status, and lets the user send input or cancel.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { timeAgo } from '../lib/format.js';

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
  const outputRef = useRef(null);
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

  return html`
    <div class="modal-overlay">
      <div class="modal-backdrop" onClick=${onClose}></div>
      <div class="modal-panel wide">
        <div class="modal-header">
          <h2 class="modal-title">${currentRun?.task_title || run.task_title || 'Run Inspector'}</h2>
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
