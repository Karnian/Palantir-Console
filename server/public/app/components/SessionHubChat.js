import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { apiFetch } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
import { sessionEvidenceLabel } from '../lib/workBoard.js';
const html = htm.bind(h);

export function SessionEvidence({ sessionKey, evidenceRev, panel, onOpenSession }) {
  const card = panel?.cards?.find(item => item.key === sessionKey);
  if (!card && panel?.rev) return html`<span class="session-evidence missing">현재 스냅샷에 없는 세션</span>`;
  const changed = panel?.rev && panel.rev !== evidenceRev;
  const label = card ? sessionEvidenceLabel(card) : `세션 ${sessionKey.slice(-6)}`;
  return html`<button class="ghost session-evidence" type="button"
    onClick=${() => onOpenSession?.(sessionKey, evidenceRev)}>${label}
    ${!panel?.rev ? html`<span class="session-evidence-note">확인 불가</span>`
      : changed && html`<span class="session-evidence-note">답변 뒤 갱신됨</span>`}</button>`;
}

// Parse only sanitized DOM text. Attribute values never participate in evidence replacement.
export function renderSessionMarkdown(text, panel, onOpenSession, evidence = []) {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(text);
  const token = /\[\[session:([A-Za-z0-9:_-]{1,128})@([0-9a-f]{16})\]\]/g;
  const convert = (node, inCode = false) => {
    if (node.nodeType === 3) {
      if (inCode) return node.textContent;
      const parts = []; let end = 0;
      for (const match of node.textContent.matchAll(token)) {
        evidence.push({ key: match[1], rev: match[2] });
        parts.push(node.textContent.slice(end, match.index));
        parts.push(h(SessionEvidence, { sessionKey: match[1], evidenceRev: match[2], panel, onOpenSession }));
        end = match.index + match[0].length;
      }
      parts.push(node.textContent.slice(end));
      return parts;
    }
    if (node.nodeType !== 1) return null;
    let tag = node.tagName.toLowerCase();
    const props = Object.fromEntries(Array.from(node.attributes, attr => [attr.name, attr.value]));
    // Evidence owns its click; unwrap enclosing links to avoid nested interactive elements.
    if (tag === 'a' && new RegExp(token.source).test(node.textContent)) {
      tag = 'span'; delete props.href; delete props.target; delete props.rel;
    }
    return h(tag, props, Array.from(node.childNodes, child =>
      convert(child, inCode || tag === 'pre' || tag === 'code')));
  };
  return Array.from(template.content.childNodes, node => convert(node));
}

const hubErrorLabels = {
  session_hub_start_failed: '세션 비서를 시작하지 못했습니다. 다시 시도해 주세요.',
  session_hub_failed: '세션 비서 요청을 처리하지 못했습니다. 다시 시도해 주세요.',
  session_hub_off: '세션 비서가 비활성화되어 있습니다.',
  session_hub_managed_settings: '관리자 설정이 적용되어 세션 비서를 사용할 수 없습니다.',
  session_hub_hooks_detected: '설정된 훅을 발견해 세션 비서를 중지했습니다.',
  session_hub_binary_unavailable: 'Claude 실행 파일을 찾지 못했습니다.',
  session_hub_unsafe_storage: '세션 비서 저장 공간의 권한을 확인해 주세요.',
  session_hub_unsafe_cwd: '세션 비서의 작업 경로를 안전하게 준비하지 못했습니다.',
  session_hub_unexpected_paths: '세션 비서의 저장 경로 확인에 실패했습니다.',
  session_hub_unexpected_pgid: '조회 도구의 실행 상태를 확인하지 못했습니다.',
  session_hub_storage_failed: '세션 비서 대화를 기록하지 못했습니다.',
  session_hub_cleanup_failed: '세션 비서 정리를 완료하지 못했습니다.',
  session_hub_output_too_large: '답변이 너무 커서 세션 비서를 중지했습니다.',
  session_hub_process_exited: '세션 비서가 종료되었습니다. 다시 시작해 주세요.',
  session_hub_turn_timeout: '조회 시간이 초과되었습니다. 다시 시작해 주세요.',
  session_hub_turn_failed: '세션 조회에 실패했습니다. 다시 시도해 주세요.',
  session_hub_mcp_lost: '조회 도구 연결이 끊겼습니다. 다시 시작해 주세요.',
  session_hub_socket_path_too_long:
    '조회 도구의 연결 경로가 너무 깁니다. 임시 경로를 확인해 주세요.',
  session_hub_not_listening: '서버가 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요.',
  session_hub_not_running: '세션 비서를 먼저 시작해 주세요.',
  session_hub_busy: '진행 중인 작업이 끝난 뒤 다시 시도하세요.',
  session_hub_closed: '세션 비서가 종료되었습니다. 서버를 다시 시작해 주세요.',
  turn_in_progress: '답변이 끝난 뒤 다시 전송해 주세요.',
  reap_failed: '세션 비서 프로세스를 중지하지 못했습니다.',
  invalid_message: '질문 내용을 확인해 주세요.',
};
export function sessionHubErrorText(code) {
  return hubErrorLabels[code] || `세션 비서를 시작하지 못했습니다(${String(code || 'unknown')}).`;
}
export function sessionToolSummary(message, panel) {
  let args;
  try { args = JSON.parse(message.text); } catch { args = {}; }
  if (!args || typeof args !== 'object') args = {};
  const name = String(message.name || '').replace(/^mcp__session_hub__/, '');
  const page = args.cursor ? ' (다음 페이지)' : '';
  if (name === 'search_instructions') return `검색: ${String(args.q || '').replace(/\s+/gu, ' ').trim()}${page}`;
  if (name === 'list_sessions') {
    const machine = panel?.cards?.find(card => card.machine.id === args.machine)?.machine.label || args.machine;
    const filters = [machine, args.provider].filter(Boolean).join(' · ');
    return `세션 목록 조회${filters ? ` · ${filters}` : ''}${page}`;
  }
  if (name === 'get_session') {
    const card = panel?.cards?.find(item => item.key === args.key);
    return `세션 열기: ${card ? sessionEvidenceLabel(card) : `세션 ${String(args.key || '').slice(-6)}`}`;
  }
  return '세션 조회';
}
function groupHubMessages(messages) {
  const groups = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (groups.at(-1)?.role !== 'tools') groups.push({ role: 'tools', tools: [] });
      groups.at(-1).tools.push(message);
    } else groups.push(message);
  }
  return groups;
}

const initialState = () => ({ state: 'idle', messages: [], turnInProgress: false });
const statusLabels = { idle: '중지됨', starting: '시작 중', running: '조회 준비됨', closing: '중지 중',
  closed: '종료됨', error: '오류' };
export function SessionHubChat({ panel, onOpenSession, onRevisionMismatch }) {
  const [state, setState] = useState(initialState);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [localTransition, setLocalTransition] = useState('');
  const [error, setError] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const alive = useRef(false);
  const epoch = useRef(null);
  const version = useRef(-1);
  const controller = useRef(null);
  const messagesEnd = useRef(null);
  const pending = useRef(false);
  const composing = useRef(false);
  const applySnapshot = value => {
    if (!alive.current || typeof value.epoch !== 'string' || !value.epoch
      || !Number.isSafeInteger(value.version)) return;
    if (value.epoch === epoch.current && value.version <= version.current) return;
    epoch.current = value.epoch;
    version.current = value.version;
    setState(value);
  };
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    const source = new EventSource('/api/session-hub/chat/stream');
    const accept = event => {
      try { applySnapshot(JSON.parse(event.data)); }
      catch { setError('대화를 읽지 못했습니다.'); }
    };
    source.addEventListener('snapshot', accept);
    apiFetch('/api/session-hub/chat/state', { signal: controller.current.signal, allowAppForbidden: true })
      .then(applySnapshot)
      .catch(() => { if (alive.current) setError('대화를 읽지 못했습니다.'); });
    source.onopen = () => { setError(''); };
    source.onerror = () => { setError('연결이 끊겼습니다. 다시 연결 중입니다.'); };
    return () => { alive.current = false; controller.current.abort(); source.close(); };
  }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'nearest' }); }, [state.messages]);
  const action = async (name, body) => {
    if (pending.current || !controller.current) return;
    pending.current = true;
    setBusy(true); setError('');
    const autoStart = name === 'message' && state.state === 'idle';
    if (autoStart || name === 'start') setLocalTransition('starting');
    const request = async (operation, payload) => {
      const value = await apiFetch(`/api/session-hub/chat/${operation}`, { method: 'POST',
        body: JSON.stringify(payload || {}), signal: controller.current.signal, allowAppForbidden: true });
      applySnapshot(value);
      return value;
    };
    try {
      if (autoStart) {
        const started = await request('start');
        if (!alive.current || controller.current.signal.aborted) return;
        if (started.state !== 'running' || started.disabled || started.turnInProgress) {
          setError(sessionHubErrorText(started.error || started.disabled || 'session_hub_not_running'));
          return;
        }
      }
      const value = await request(name, body);
      if (!alive.current) return;
      if (name === 'message') setText('');
      if (name === 'clear') setClearNotice(value.result === 'incomplete'
        ? `대화는 지웠지만 파일 ${value.remaining}개가 남았습니다.` : '대화를 지웠습니다.');
    } catch (err) {
      if (alive.current) {
        setError(sessionHubErrorText(err.data?.error || err.code || err.message));
      }
    } finally {
      pending.current = false;
      if (alive.current) { setBusy(false); setLocalTransition(''); }
    }
  };
  const rendered = useMemo(() => {
    const evidence = [];
    const messages = state.messages.map(message => ({ ...message, content: message.role === 'assistant'
      ? renderSessionMarkdown(message.text, panel, onOpenSession, evidence) : null }));
    const mismatch = !!panel?.rev && evidence.some(item => item.rev !== panel.rev
      && panel.cards.some(card => card.key === item.key));
    return { messages: groupHubMessages(messages), mismatch };
  }, [state.messages, panel, onOpenSession]);
  useEffect(() => {
    onRevisionMismatch?.(rendered.mismatch);
    return () => onRevisionMismatch?.(false);
  }, [rendered.mismatch, onRevisionMismatch]);
  const running = state.state === 'running';
  const transitioning = ['starting', 'closing', 'closed'].includes(state.state);
  const disabled = busy || transitioning || !!state.disabled;
  const canSend = !disabled && (running || state.state === 'idle') && !state.turnInProgress && !!text.trim();
  const send = () => { if (canSend) action('message', { text }); };
  const handleKeyDown = event => {
    if (event.isComposing || composing.current || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  };
  return html`<section class="session-hub-chat" aria-label="세션 비서 채팅">
    <header class="manager-chat-header">
      <div class="manager-panel-title">
      <span class="manager-status-badge ${state.turnInProgress ? 'running' : 'idle'}"
        role="status">${state.turnInProgress ? '답변 중'
          : statusLabels[localTransition || state.state] || '오류'}</span></div>
      <div class="manager-panel-actions">
        <button type="button" class="ghost" disabled=${disabled || running}
          onClick=${() => action('start')}>시작</button>
        <button type="button" class="ghost" disabled=${busy || !running}
          onClick=${() => action('stop')}>중지</button>
        <button type="button" class="ghost" disabled=${busy || transitioning}
          onClick=${() => action('clear')}>대화 지우기</button>
      </div>
    </header>
    <p class="session-hub-note">서버 재시작 시 대화가 사라집니다.</p>
    ${error && html`<p class="session-hub-error" role="alert">${error}</p>`}
    ${state.error && html`<p class="session-hub-error" role="alert">${sessionHubErrorText(state.error)}</p>`}
    <div class="manager-messages session-hub-messages" tabindex="0" role="log" aria-label="세션 비서 대화">
      ${clearNotice && html`<p class="session-hub-note" role="status">${clearNotice}</p>`}
      ${!state.messages.length && html`<p class="session-hub-empty">
        여러 머신의 세션을 물어보세요 — '아까 orca 상위 레이어 얘기한 세션 어디야?'</p>`}
      ${rendered.messages.map((message, index) => message.role === 'tools' ? html`
        <details key=${index} class="session-hub-tools">
          <summary>${sessionToolSummary(message.tools.at(-1), panel)} · 조회 ${message.tools.length}회</summary>
          <ul>${message.tools.map((tool, toolIndex) => html`<li key=${toolIndex}>
            ${sessionToolSummary(tool, panel)}</li>`)}</ul>
        </details>` : message.role === 'error' ? html`
          <p key=${index} class="session-hub-error" role="alert">${sessionHubErrorText(message.text)}</p>` : html`
          <div key=${index} class="manager-msg-row manager-msg-row-${message.role === 'user' ? 'user' : 'assistant'}">
            <div class="manager-msg manager-msg-${message.role === 'user' ? 'user' : 'assistant'}">
              <div class="manager-msg-content ${message.role === 'assistant' ? 'markdown-body' : ''}">
                ${message.role === 'assistant' ? message.content : message.text}</div>
            </div>
          </div>`)}
      <div ref=${messagesEnd} />
    </div>
    <form class="session-hub-input" onSubmit=${event => { event.preventDefault(); send(); }}>
      <textarea aria-label="세션 비서에게 질문" value=${text} rows="2" disabled=${disabled}
        onKeyDown=${handleKeyDown} oncompositionstart=${() => { composing.current = true; }}
        oncompositionend=${() => { composing.current = false; }}
        placeholder="모든 세션에 대해 물어보세요" onInput=${event => setText(event.target.value)} />
      <button type="submit" class="primary" disabled=${!canSend}>
        전송</button>
    </form>
  </section>`;
}
