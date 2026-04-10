// RunInspector — modal that polls a single run for live output, events,
// and status, and lets the user send input or cancel. First component
// extracted from the legacy app.js monolith as part of Phase 4 to validate
// the "ESM module + window bridge" pattern.
//
import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

export function RunInspector({ run, onClose }) {
  const [events, setEvents] = useState([]);
  const [liveOutput, setLiveOutput] = useState('');
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [currentRun, setCurrentRun] = useState(run);
  const [tab, setTab] = useState('output');
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
          const outputData = await window.apiFetch(`/api/runs/${run.id}/output?lines=200`);
          if (!cancelled && outputData.output) {
            setLiveOutput(outputData.output);
          }

          // Fetch new events
          const evtData = await window.apiFetch(`/api/runs/${run.id}/events?after=${lastEventId}`);
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
          const runData = await window.apiFetch(`/api/runs/${run.id}`);
          if (!cancelled) {
            setCurrentRun(runData.run);
            if (['completed', 'failed', 'cancelled', 'stopped'].includes(runData.run?.status)) {
              // One final output fetch
              try {
                const finalOut = await window.apiFetch(`/api/runs/${run.id}/output?lines=200`);
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
      await window.apiFetch(`/api/conversations/worker:${encodeURIComponent(run.id)}/message`, {
        method: 'POST',
        body: JSON.stringify({ text: inputText.trim() }),
      });
      setInputText('');
    } catch (err) {
      window.addToast?.(err.message, 'error');
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
      await window.apiFetch(`/api/runs/${run.id}/cancel`, { method: 'POST' });
    } catch (err) {
      window.addToast?.(err.message, 'error');
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
            Started ${window.timeAgo(run.created_at)}
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
