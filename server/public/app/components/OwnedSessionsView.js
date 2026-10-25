import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { apiFetch } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { OWNED_COPY as C } from '../lib/copy.js';
import { Modal } from './Modal.js';
import { DirectoryPicker } from './BoardView.js';
const html = htm.bind(h);
const base = '/api/owned-sessions';
const label = value => C[value] || C.unknown;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const time = value => value ? new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : C.noTime;

export function ownedRequestKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `rk_${Date.now()}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
export function ownedInteraction(state) {
  const inc = (state?.incarnations || []).find(row => row.id === state.current_incarnation_id);
  if (!inc || inc.state !== 'alive' || inc.attribution_uncertain || inc.interrupt_unknown) return 'unknown';
  const cards = (state.tool_requests || []).filter(row => row.incarnation_id === inc.id && row.state === 'pending');
  if (cards.length) return cards.some(row => row.tool_name === 'AskUserQuestion') ? 'awaiting_user' : 'awaiting_permission';
  return (state.deliveries || []).some(row => row.incarnation_id === inc.id && row.kind === 'prompt' &&
    ['sending', 'written', 'provider_observed'].includes(row.state) && !row.outcome) ? 'running' : 'idle';
}
export function OwnedDeliveryBadge({ delivery }) {
  return html`<span class=${delivery.state === 'unknown' || delivery.outcome === 'outcome_unknown' ? 'owned-unknown' : ''}>
    ${delivery.state === 'unknown' ? C.deliveryUnknown : label(delivery.state)}
    ${delivery.outcome ? ` · ${label(delivery.outcome)}` : ''}
    ${['tool_finished', 'tool_finished_error'].includes(delivery.reason) ? ` · ${label(delivery.reason)}` : ''}</span>`;
}
export function OwnedPrompt({ row, sessionId, disabled, onResend }) {
  const [body, setBody] = useState(row.body_truncated ? null : parse(row.body));
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (row.body_truncated) ownedFullText(sessionId, 'delivery_body', row.id).then(text => { if (active) setBody(parse(text)); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [sessionId, row.id, row.body_truncated]);
  return html`<article class="owned-card"><pre>${body === null ? error ? C.fullError : C.loading : typeof body === 'string' ? body : JSON.stringify(body)}</pre>
    <${OwnedDeliveryBadge} delivery=${row} />${row.state === 'unknown' && html`<p>${C.resendWarning}
    <button disabled=${disabled || typeof body !== 'string'} onClick=${() => onResend(body)}>${C.resend}</button></p>`}</article>`;
}
// Fetch complete UTF-8 chunks, never substitute a truncated preview for an approval input.
export async function ownedFullText(sessionId, source, ref) {
  let offset = 0, text = '';
  for (;;) {
    const result = await apiFetch(`${base}/${encodeURIComponent(sessionId)}/chunks?source=${source}&ref=${encodeURIComponent(ref)}&offset=${offset}`);
    if (result.host !== 'running' || !result.found) throw new Error('host_unreachable');
    text += result.data;
    if (result.done) return text;
    const length = new TextEncoder().encode(result.data).length;
    if (!length) throw new Error('invalid_chunk');
    offset += length;
  }
}
export function OwnedQuestion({ input, disabled, onAnswer }) {
  const [values, setValues] = useState({});
  const group = useRef(ownedRequestKey());
  const questions = input?.questions || [];
  const set = (question, value) => setValues(old => ({ ...old, [question]: value }));
  return html`<div>${questions.map((q, qi) => html`<fieldset disabled=${disabled}><legend>${q.question}</legend>
    ${(q.options || []).map((option, oi) => html`<label class="owned-choice"><input type=${q.multiSelect ? 'checkbox' : 'radio'}
      name=${`${group.current}-${qi}`} checked=${q.multiSelect ? (values[q.question]?.selected || []).includes(option.label) : values[q.question]?.selected === option.label}
      onChange=${event => {
        const old = values[q.question] || {};
        const selected = q.multiSelect ? event.target.checked ? [...(old.selected || []), option.label] : (old.selected || []).filter(x => x !== option.label) : option.label;
        set(q.question, { ...old, selected });
      }} />${option.label}${option.description ? ` — ${option.description}` : ''}</label>`)}
    <label>${C.custom}<input value=${values[q.question]?.custom || ''} onInput=${event => set(q.question, { ...values[q.question], custom: event.target.value })} /></label>
  </fieldset>`)}<button disabled=${disabled || !questions.length || questions.some(q => !values[q.question]?.custom?.trim() && !values[q.question]?.selected?.length)}
    onClick=${() => onAnswer(Object.fromEntries(questions.map(q => [q.question, values[q.question].custom?.trim() ||
      (Array.isArray(values[q.question].selected) ? values[q.question].selected.join(', ') : values[q.question].selected)])))}>${C.answer}</button></div>`;
}
export function OwnedApproval({ card, sessionId, cwd, disabled, delivery, onSubmit }) {
  const [full, setFull] = useState(card.input_truncated ? null : card.input || '');
  const [error, setError] = useState(false);
  const [reason, setReason] = useState('');
  useEffect(() => {
    let active = true;
    if (card.input_truncated) ownedFullText(sessionId, 'tool_input', card.id).then(value => { if (active) setFull(value); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [sessionId, card.id, card.input, card.input_truncated]);
  const locked = disabled || card.state !== 'pending' || full === null;
  return html`<article class="owned-card"><h3>${card.tool_name}</h3><p>${cwd} · ${C.timestamp}: ${time(card.created_at)}</p>
    <details open><summary>${C.input}</summary><pre>${full === null ? error ? C.fullError : C.loading : full}</pre></details>
    <p>${label(card.state)} ${delivery && html`<${OwnedDeliveryBadge} delivery=${delivery} />`}</p>
    ${card.tool_name === 'AskUserQuestion' ? html`<${OwnedQuestion} input=${parse(full)} disabled=${locked}
      onAnswer=${answer => onSubmit('question-answer', { tool_use_id: card.tool_use_id, answer })} />` : html`
      <label>${C.reason}<input value=${reason} disabled=${locked} onInput=${event => setReason(event.target.value)} /></label>
      <button disabled=${locked} onClick=${() => onSubmit('tool-decision', { tool_use_id: card.tool_use_id, behavior: 'allow' })}>${C.allow}</button>
      <button disabled=${locked} onClick=${() => onSubmit('tool-decision', { tool_use_id: card.tool_use_id, behavior: 'deny', message: reason })}>${C.deny}</button>`}</article>`;
}
export function OwnedStart({ open, disabled, onClose, onStart }) {
  const [cwd, setCwd] = useState('');
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fence = useRef(0);
  useEffect(() => () => { fence.current++; }, []);
  const select = value => { fence.current++; setCwd(value); setPreview(null); setConfirmed(false); setBusy(false); };
  const inspect = async () => {
    const token = ++fence.current; setBusy(true); setError(''); setConfirmed(false); setPreview(null);
    try {
      const result = await apiFetch(`${base}/settings-preview`, { method: 'POST', body: JSON.stringify({ cwd, node_id: 'local' }) });
      if (token === fence.current) setPreview(result);
    } catch (err) { if (token === fence.current) setError(label(err.reason || err.message)); }
    finally { if (token === fence.current) setBusy(false); }
  };
  return html`<${Modal} open=${open} onClose=${onClose} labelledBy="owned-start-title"><div class="modal-header"><h2 id="owned-start-title">${C.newSession}</h2></div>
    <div class="modal-body owned-view"><${DirectoryPicker} value=${cwd} onSelect=${select} nodeId="local" directoryNodeId="local" />
    <button disabled=${disabled || !cwd || busy} onClick=${inspect}>${C.settings}</button>
    <p>${C.projectWarning}</p><p>${C.userWarning}</p>
    ${preview && html`<div><h3>${C.hooks}</h3>${(preview.hooks || []).map(row => html`<p>${row.event} · ${row.paths.join(' · ')}</p>`)}
      <h3>${C.mcp}</h3>${(preview.mcp_servers || []).map(row => html`<p>${row.name} · ${row.paths.join(' · ')}</p>`)}
      <h3>${C.sources}</h3>${(preview.source_paths || []).map(path => html`<p>${path}</p>`)}
      ${(preview.warnings || []).includes('permission_request_hook') && html`<p class="owned-unknown" role="alert">${C.permissionWarning}</p>`}
      ${!preview.ok && html`<p role="alert">${label(preview.reason)} ${preview.detail || ''}</p>`}</div>`}
    <label><input type="checkbox" checked=${confirmed} disabled=${disabled || !preview?.ok || busy} onChange=${event => setConfirmed(event.target.checked)} />${C.confirm}</label>
    <p role="status">${busy ? C.settings_checking : error}</p></div><div class="modal-footer">
    <button disabled=${disabled || !preview?.ok || !confirmed || busy} onClick=${() => onStart(cwd)}>${C.start}</button></div></${Modal}>`;
}
export function OwnedMessage({ event, sessionId, uncertain }) {
  const [content, setContent] = useState(event.json || (!event.truncated && parse(event.preview)));
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (!content) ownedFullText(sessionId, 'event', event.seq).then(text => { if (active) setContent(parse(text)); }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [event.seq, sessionId]);
  const message = content?.message;
  if (!message) return html`<p>${error ? C.fullError : C.loading}</p>`;
  if (message.type === 'user') {
    const results = (message.message?.content || []);
    if (!Array.isArray(results) || !results.some(x => x.type === 'tool_result')) return null;
  }
  const blocks = message.message?.content;
  return html`<article class="owned-message">${uncertain && message.type === 'result' && html`<strong>${C.unattributed}</strong>`}
    ${Array.isArray(blocks) ? blocks.map(block => block.type === 'text' ? html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text || '') }} />` :
      html`<details><summary>${C.tools} ${block.name || block.tool_use_id || ''}</summary><pre>${JSON.stringify(block, null, 2)}</pre></details>`) :
      html`<details><summary>${C.tools}</summary><pre>${JSON.stringify(message, null, 2)}</pre></details>`}</article>`;
}
export function OwnedComposer({ interaction, disabled, uncertain, interruptUnknown, onSubmit }) {
  const [body, setBody] = useState('');
  const locked = disabled || uncertain || interruptUnknown || interaction === 'unknown';
  return html`<div>${uncertain && html`<p class="owned-unknown">${C.uncertain}</p>`}${interruptUnknown && html`<p class="owned-unknown">${C.interruptUnknown}</p>`}
    <label>${C.prompt}<textarea value=${body} disabled=${locked} onInput=${event => setBody(event.target.value)} /></label>
    ${interaction === 'idle' ? html`<button disabled=${locked || !body.trim()} onClick=${() => onSubmit('prompt', { body })}>${C.send}</button>` : html`
      <button disabled=${locked || !body.trim()} onClick=${() => onSubmit('interrupt-send', { body })}>${C.interruptSend}</button>
      <button disabled=${locked || !body.trim()} onClick=${() => onSubmit('prompt', { body })}>${C.queue}</button>`}</div>`;
}
export function OwnedSessionsView({ sessionId }) {
  const [snapshot, setSnapshot] = useState(null), [sessions, setSessions] = useState([]), [events, setEvents] = useState([]);
  const [host, setHost] = useState('loading'), [asOf, setAsOf] = useState(null), [notice, setNotice] = useState('');
  const [next, setNext] = useState(null), [start, setStart] = useState(false), [remove, setRemove] = useState(false);
  const [pending, setPending] = useState(null), [busy, setBusy] = useState(false);
  const identity = useRef(sessionId); identity.current = sessionId;
  const epoch = useRef(0), submitLock = useRef(false), sequence = useRef(0), lastDraw = useRef(null);
  const follow = useRef(null), reload = useRef(() => {});
  useEffect(() => {
    const token = ++epoch.current, id = sessionId;
    let source, timer, disposed = false, reading = false, again = false, lossGeneration = 0, networkLost = false;
    const current = () => !disposed && identity.current === id && epoch.current === token;
    const merge = rows => setEvents(old => [...new Map([...old, ...rows].map(row => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq));
    const connect = () => {
      source?.close();
      source = new EventSource(`${base}/stream?since=${sequence.current}`);
      const lost = () => { if (current()) { lossGeneration++; setHost('unreachable'); setAsOf(lastDraw.current); } };
      source.addEventListener('host_unreachable', lost);
      source.addEventListener('error', () => { networkLost = true; lost(); });
      source.addEventListener('open', () => { if (current() && networkLost) { networkLost = false; setNotice(C.reconnect); void refresh(true); } });
      source.addEventListener('reconnected', () => { if (current()) { setNotice(C.reconnect); void refresh(true); } });
      source.addEventListener('resync', () => { if (current()) void refresh(true); });
      source.addEventListener('event', frame => {
        if (!current()) return;
        let event; try { event = JSON.parse(frame.data); } catch { return; }
        sequence.current = Math.max(sequence.current, event.seq || 0);
        if (event.type === 'sdk_message' && event.session_id === id) merge([event]);
        clearTimeout(timer); timer = setTimeout(() => { void refresh(false); }, 100);
      });
    };
    const refresh = async (resubscribe = false) => {
      if (reading) { again = true; return; }
      reading = true;
      const generation = lossGeneration;
      try {
        const result = await apiFetch(id ? `${base}/${encodeURIComponent(id)}` : base);
        if (!current() || generation !== lossGeneration) return;
        if (result.host !== 'running') { setHost(result.host); if (result.host === 'unreachable') setAsOf(lastDraw.current); return; }
        if (id) {
          setSnapshot(result.state);
          if (['deleting', 'deleted'].includes(result.state?.session?.state)) { setEvents([]); setNext(null); }
        } else setSessions(result.sessions || []);
        setHost('running'); lastDraw.current = Date.now(); setAsOf(lastDraw.current);
        sequence.current = result.seq_high || 0;
        if (id && (!source || resubscribe)) {
          const page = await apiFetch(`${base}/${encodeURIComponent(id)}/transcript?limit=50`);
          if (!current() || generation !== lossGeneration) return;
          if (page.host === 'unreachable') { setHost('unreachable'); return; }
          merge(page.events || []); setNext(page.next_before_seq);
        }
        if (!source || resubscribe) connect();
      } catch (err) { if (current()) { setNotice(label(err.reason || err.message)); setHost('unreachable'); setAsOf(lastDraw.current); } }
      finally { reading = false; if (again && current()) { again = false; void refresh(true); } }
    };
    reload.current = () => refresh(false);
    void refresh();
    return () => { disposed = true; epoch.current++; source?.close(); clearTimeout(timer); };
  }, [sessionId]);
  const state = snapshot, inc = state?.incarnations?.find(row => row.id === state.current_incarnation_id);
  const interaction = ownedInteraction(state);
  const controllable = host === 'running' && inc?.state === 'alive' && inc.control_available === true && state?.session?.state === 'active' &&
    !(state.controls || []).some(row => row.state === 'accepted');
  const disabled = host !== 'running' || busy || !!pending;
  const execute = async (path, body, method = 'POST', requestKey) => {
    if (submitLock.current || host === 'unreachable') return;
    submitLock.current = true; setBusy(true);
    const id = sessionId, token = epoch.current;
    const current = () => identity.current === id && epoch.current === token;
    const request = { path, method, body: { ...body, request_key: requestKey || ownedRequestKey() } };
    try {
      const response = await apiFetch(path, { method, body: JSON.stringify(request.body) });
      if (!current()) return;
      if (response.acceptance === 'acceptance_unknown') { setPending(request); setNotice(C.acceptanceUnknown); }
      else {
        setPending(null);
        const result = response.result || {};
        setNotice(label(response.code || result.reason || result.stage || result.state));
        if (path === `${base}/start` && result.session_id) { location.hash = `owned/${result.session_id}`; return; }
        await reload.current();
      }
    } catch (err) {
      if (!current()) return;
      if (!err.status) { setPending(request); setNotice(C.acceptanceUnknown); }
      else setNotice(label(err.reason || err.message));
    } finally { if (current()) setBusy(false); submitLock.current = false; }
  };
  const submit = (action, body = {}) => {
    if (disabled) return;
    const key = ownedRequestKey();
    if (action === 'interrupt-send') { follow.current = { kind: 'prompt', body, incarnation: inc?.id, key }; action = 'interrupt'; }
    if (action === 'restart') { follow.current = { kind: 'resume', incarnation: inc?.id, key }; action = 'stop'; }
    return execute(`${base}/${encodeURIComponent(sessionId)}/${action}`, { ...body, incarnation_id: state.current_incarnation_id }, 'POST', key);
  };
  useEffect(() => {
    const waiting = follow.current;
    if (!waiting || disabled || waiting.incarnation !== inc?.id) return;
    if (waiting.kind === 'prompt') {
      const done = (state.deliveries || []).some(row => row.request_key === waiting.key && row.kind === 'interrupt' && row.incarnation_id === inc.id && row.state === 'completed');
      if (done && interaction === 'idle' && !inc.attribution_uncertain) { follow.current = null; submit('prompt', waiting.body); }
    } else if ((state.controls || []).some(row => row.request_key === waiting.key && row.kind === 'stop' && row.incarnation_id === inc.id && row.state === 'done')) {
      follow.current = null; submit('resume');
    }
  }, [state, disabled]);
  const retry = async () => {
    if (!pending || host !== 'running' || busy) return;
    const saved = pending, id = sessionId, token = epoch.current;
    try {
      const lookup = await apiFetch(`${base}/requests/${encodeURIComponent(saved.body.request_key)}`);
      if (identity.current !== id || epoch.current !== token) return;
      if (lookup.host !== 'running') { setHost('unreachable'); return; }
      // Lookup is informational; identical replay is safe even when the receipt exists.
      await execute(saved.path, saved.body, saved.method, saved.body.request_key);
    } catch { if (identity.current === id && epoch.current === token) setNotice(C.acceptanceUnknown); }
  };
  const history = async () => {
    const id = sessionId, token = epoch.current; setBusy(true);
    try {
      const page = await apiFetch(`${base}/${encodeURIComponent(id)}/transcript?before_seq=${next}&limit=50`);
      if (identity.current !== id || epoch.current !== token) return;
      if (page.host !== 'running') { setHost('unreachable'); return; }
      setEvents(old => [...new Map([...(page.events || []), ...old].map(row => [row.seq, row])).values()].sort((a,b) => a.seq-b.seq)); setNext(page.next_before_seq);
    } catch { if (identity.current === id && epoch.current === token) setNotice(C.error); }
    finally { if (identity.current === id && epoch.current === token) setBusy(false); }
  };
  const account = parse(inc?.account_snapshot);
  const conversation = [
    ...(state?.deliveries || []).filter(row => row.kind === 'prompt').map(row => ({ kind: 'prompt', row })),
    ...events.map(row => ({ kind: 'event', row }))
  ].sort((a, b) => (a.row.created_at || 0) - (b.row.created_at || 0) || (a.row.seq || 0) - (b.row.seq || 0));
  const resumeReady = inc && ['exited', 'never_started'].includes(inc.state) && state?.session?.state === 'active' &&
    state.controls?.some(row => row.incarnation_id === inc.id && row.kind === 'stop' && row.state === 'done');
  return html`<section class="owned-view"><h1>${C.title}</h1>
    <div aria-live="polite" role="status">${host === 'unreachable' ? html`<p class="owned-unknown">${C.lost} ${time(asOf)} ${C.asOf}</p>` : host === 'not_running' ? C.off : ''}
      ${notice && html`<p>${notice}</p>`}</div>
    ${pending && html`<p class="owned-unknown">${C.acceptanceUnknown}<button disabled=${host !== 'running' || busy} onClick=${retry}>${C.retry}</button></p>`}
    ${!sessionId ? html`<button disabled=${host === 'unreachable' || busy || !!pending} onClick=${() => setStart(true)}>${C.newSession}</button>
      ${!sessions.length && html`<p>${C.empty}</p>`}<ul>${sessions.map(row => html`<li class="owned-card"><a href=${`#owned/${encodeURIComponent(row.id)}`}>${row.cwd || row.id}</a>
        <p>${label(row.state)} · ${label(row.incarnation?.state)} · ${C.approvals}: ${row.pending_approvals} · ${C.activity}: ${row.last_activity_seq}</p></li>`)}</ul>` : html`
      <a href="#owned">${C.back}</a>
      ${!state?.session ? html`<p>${host === 'loading' ? C.loading : C.notFound}</p>` : html`
      <div class="owned-card"><p>${host === 'running' ? C.connected : C.disconnected} · ${inc?.state === 'alive' || inc?.state === 'orphaned' ? C.alive : ['exited','never_started'].includes(inc?.state) ? C.exited : C.unknown}
        · ${controllable ? C.control : C.noControl} · ${label(interaction)} · ${label(state.session.state)}</p>
        <p>${C.cwd}: ${state.session.cwd}</p><p>${C.cli}: ${inc?.cli_version || C.verdict} · ${C.auth}: ${account?.subscriptionType || C.verdict}</p>
        ${inc?.rate_limit_info?.isUsingOverage && html`<p class="owned-unknown">${C.overage}</p>`}
        <p>${['observe','prompt','tool_approval','cancel','resume'].map(name => html`<span class="owned-badge">${C[name]}: ${!inc?.capabilityVerdict?.[name] || inc.capabilityVerdict[name] === 'unknown' ? C.verdict : label(inc.capabilityVerdict[name])}</span>`)}</p>
        ${(state.controls || []).map(row => html`<p>${label(row.kind)} · ${label(row.stage)} · ${label(row.state)} ${row.reason ? label(row.reason) : ''}</p>`)}
      </div><div class="owned-actions">
        <button disabled=${disabled || !controllable} onClick=${() => submit('interrupt')}>${C.interrupt}</button>
        <button disabled=${disabled || state.session.state !== 'active' || !inc || !['alive','orphaned','exited','never_started'].includes(inc.state)} onClick=${() => submit('restart')}>${C.restart}</button>
        <button disabled=${disabled || !resumeReady} onClick=${() => submit('resume')}>${C.resume}</button>
        <button disabled=${disabled || state.session.state !== 'active'} onClick=${() => submit('close')}>${C.close}</button>
        <button disabled=${disabled || state.session.state !== 'closed'} onClick=${() => setRemove(true)}>${C.remove}</button>
      </div><h2>${C.conversation}</h2>
      ${next && html`<button disabled=${disabled} onClick=${history}>${C.history}</button>`}
      ${conversation.map(({ kind, row }) => kind === 'prompt' ? html`<${OwnedPrompt} key=${row.id} row=${row} sessionId=${sessionId}
        disabled=${disabled || !controllable || row.incarnation_id === inc?.id ||
          !state.incarnations.some(i => i.id === row.incarnation_id && ['exited','never_started'].includes(i.state))}
        onResend=${body => submit('prompt', { body })} />` : html`<${OwnedMessage} key=${row.seq} event=${row} sessionId=${sessionId}
          uncertain=${!row.incarnation_id || !!state.incarnations?.find(i => i.id === row.incarnation_id)?.attribution_uncertain} />`)}
      ${(state.tool_requests || []).map(card => html`<${OwnedApproval} key=${card.id} card=${card} sessionId=${sessionId} cwd=${state.session.cwd}
        disabled=${disabled || !controllable || card.incarnation_id !== inc?.id} delivery=${state.deliveries?.find(row => row.id === card.answer_delivery_id)} onSubmit=${submit} />`)}
      <${OwnedComposer} interaction=${interaction} disabled=${disabled || !controllable} uncertain=${!!inc?.attribution_uncertain} interruptUnknown=${!!inc?.interrupt_unknown} onSubmit=${submit} />`}`}
    ${start && html`<${OwnedStart} open disabled=${host === 'unreachable' || busy || !!pending} onClose=${() => setStart(false)}
      onStart=${cwd => execute(`${base}/start`, { cwd, node_id: 'local', confirmed_settings: true })} />`}
    <${Modal} open=${remove} onClose=${() => setRemove(false)} labelledBy="owned-delete-title"><div class="modal-body"><h2 id="owned-delete-title">${C.remove}</h2><p>${C.deleteWarning}</p>
      <button disabled=${disabled} onClick=${() => { setRemove(false); execute(`${base}/${encodeURIComponent(sessionId)}`, { incarnation_id: state?.current_incarnation_id }, 'DELETE'); }}>${C.remove}</button></div></${Modal}>
  </section>`;
}
