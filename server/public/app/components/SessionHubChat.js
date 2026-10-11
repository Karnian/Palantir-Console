import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { apiFetch } from '../lib/api.js';
import { renderMarkdown } from '../lib/markdown.js';
const html = htm.bind(h);

export function SessionEvidence({ sessionKey, evidenceRev, panel, onOpenSession }) {
  const card = panel?.cards?.find(item => item.key === sessionKey);
  if (!card) return html`<span class="session-evidence missing">현재 스냅샷에 없는 세션</span>`;
  const changed = panel.rev && panel.rev !== evidenceRev;
  const label = `${card.machine.label} · ${Array.from(card.title || card.recent || '세션').slice(0, 24).join('')}`;
  return html`<button class="ghost session-evidence" type="button"
    onClick=${() => onOpenSession?.(sessionKey, evidenceRev)}>${label}
    ${changed && html`<span class="session-evidence-note">답변 뒤 갱신됨</span>`}</button>`;
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

const initialState = () => ({ state: 'idle', messages: [], turnInProgress: false });
const statusLabels = { idle: '중지됨', starting: '시작 중', running: '조회 준비됨', closing: '중지 중',
  closed: '종료됨', error: '오류' };
export function SessionHubChat({ panel, onOpenSession, onRevisionMismatch }) {
  const [state, setState] = useState(initialState);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clearNotice, setClearNotice] = useState('');
  const alive = useRef(false);
  const version = useRef(0);
  const controller = useRef(null);
  const messagesEnd = useRef(null);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    const source = new EventSource('/api/session-hub/chat/stream');
    const accept = event => {
      try { version.current++; setState(JSON.parse(event.data)); }
      catch { setError('대화를 읽지 못했습니다.'); }
    };
    source.addEventListener('snapshot', accept);
    const started = version.current;
    apiFetch('/api/session-hub/chat/state', { signal: controller.current.signal, allowAppForbidden: true })
      .then(value => { if (alive.current && version.current === started) setState(value); })
      .catch(() => { if (alive.current) setError('대화를 읽지 못했습니다.'); });
    source.onopen = () => { setError(''); };
    source.onerror = () => { setError('연결이 끊겼습니다. 다시 연결 중입니다.'); };
    return () => { alive.current = false; controller.current.abort(); source.close(); };
  }, []);
  useEffect(() => { messagesEnd.current?.scrollIntoView?.({ block: 'nearest' }); }, [state.messages]);
  const action = async (name, body) => {
    if (busy) return;
    setBusy(true); setError('');
    const before = version.current;
    try {
      const value = await apiFetch(`/api/session-hub/chat/${name}`, { method: 'POST',
        body: JSON.stringify(body || {}), signal: controller.current.signal, allowAppForbidden: true });
      if (!alive.current) return;
      if (version.current === before) setState(value);
      if (name === 'message') setText('');
      if (name === 'clear') setClearNotice(value.result === 'incomplete'
        ? `대화는 지웠지만 파일 ${value.remaining}개가 남았습니다.` : '대화를 지웠습니다.');
    } catch (err) {
      if (alive.current) setError(err.status === 409 ? '진행 중인 작업이 끝난 뒤 다시 시도하세요.'
        : '요청을 처리하지 못했습니다. 다시 시도하세요.');
    } finally { if (alive.current) setBusy(false); }
  };
  const rendered = useMemo(() => {
    const evidence = [];
    const messages = state.messages.map(message => ({ ...message, content: message.role === 'assistant'
      ? renderSessionMarkdown(message.text, panel, onOpenSession, evidence) : null }));
    const mismatch = !!panel?.rev && evidence.some(item => item.rev !== panel.rev
      && panel.cards.some(card => card.key === item.key));
    return { messages, mismatch };
  }, [state.messages, panel, onOpenSession]);
  useEffect(() => {
    onRevisionMismatch?.(rendered.mismatch);
    return () => onRevisionMismatch?.(false);
  }, [rendered.mismatch, onRevisionMismatch]);
  const running = state.state === 'running';
  const transitioning = ['starting', 'closing', 'closed'].includes(state.state);
  const disabled = busy || transitioning || !!state.disabled;
  return html`<section class="session-hub-chat" aria-label="세션 비서 채팅">
    <header class="manager-chat-header">
      <span role="status">${state.turnInProgress ? '답변 중' : statusLabels[state.state] || '오류'}</span>
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
    ${error && html`<p role="alert">${error}</p>`}
    ${state.error && html`<p role="alert">${state.disabled
      ? '이번 서버 실행에서는 세션 비서를 사용할 수 없습니다.'
      : state.error === 'session_hub_turn_timeout'
        ? '조회 시간이 초과되었습니다. 다시 시작해 주세요.'
        : '세션 비서에 오류가 발생했습니다. 중지 후 다시 시작해 주세요.'}</p>`}
    ${clearNotice && html`<p role="status">${clearNotice}</p>`}
    <div class="session-hub-messages" role="log" aria-label="세션 비서 대화">
      ${!state.messages.length && html`<p class="session-hub-empty">
        여러 머신의 세션을 물어보세요 — '아까 orca 상위 레이어 얘기한 세션 어디야?'</p>`}
      ${rendered.messages.map((message, index) => html`<article key=${index} class="session-hub-message">
        <span class="session-hub-note">${message.role === 'user' ? '나' : '세션 비서'}</span>
        <div class="markdown-body">${message.role === 'assistant'
          ? message.content
          : html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(message.text) }} />`}</div>
      </article>`)}
      <div ref=${messagesEnd} />
    </div>
    <form class="session-hub-input" onSubmit=${event => { event.preventDefault(); action('message', { text }); }}>
      <textarea aria-label="세션 비서에게 질문" value=${text} rows="2" disabled=${disabled}
        placeholder="모든 세션에 대해 물어보세요" onInput=${event => setText(event.target.value)} />
      <button type="submit" class="primary" disabled=${disabled || !running || state.turnInProgress || !text.trim()}>
        전송</button>
    </form>
  </section>`;
}
