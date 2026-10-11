import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { useAssistantMemory } from '../lib/hooks/useAssistantMemory.js';
import { AssistantMemoryProposal } from './AssistantMemory.js';
import { apiFetch } from '../lib/api.js';
import { createClientMessageKey } from '../lib/clientMessageKey.js';
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
  thread_not_active: '대화가 바뀌었습니다. 다시 읽어 주세요.',
  request_conflict: '전송한 질문과 내용이 다릅니다. 새 질문으로 보내 주세요.',
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
export function groupHubMessages(messages) {
  const tools = new Map();
  for (const message of messages) if (message.role === 'tool_note') {
    const key = message.turn_id || message.id;
    if (!tools.has(key)) tools.set(key, []);
    tools.get(key).push(message);
  }
  const groups = [];
  const emitted = new Set();
  for (const message of messages) {
    const key = message.turn_id || message.id;
    if (message.role === 'assistant' && tools.has(key) && !emitted.has(key)) {
      groups.push({ role: 'tools', id: `tools-${key}`, tools: tools.get(key) }); emitted.add(key);
    }
    if (message.role !== 'tool_note') groups.push(message);
  }
  // A recent window may omit the assistant row; retain these notes as a folded group.
  for (const [key, notes] of tools) if (!emitted.has(key)) {
    groups.push({ role: 'tools', id: `tools-${key}`, tools: notes });
  }
  return groups;
}

const initialState = () => ({ state: 'idle', messages: [], turnInProgress: false });
const messageSignature = message => JSON.stringify([
  message.status, message.content, message.truncated, message.version,
]);
const statusLabels = { idle: '중지됨', starting: '시작 중', running: '조회 준비됨', closing: '중지 중',
  closed: '종료됨', error: '오류' };
export function SessionHubChat({ panel, onOpenSession, onRevisionMismatch, draft }) {
  const [state, setState] = useState(initialState);
  const [threadList, setThreadList] = useState(null);
  const [viewedThread, setViewedThread] = useState(null);
  const [threadBusy, setThreadBusy] = useState(false);
  const threadGeneration = useRef(0);
  const displayThread = useRef(null);
  displayThread.current = viewedThread?.id || state.thread_id;
  const readOnly = !!viewedThread;
  const thread = viewedThread?.id || state.thread_id;
  const windowMessages = viewedThread?.messages || state.messages;
  const proposalIds = windowMessages.filter(message => message.memory_proposal_id)
    .map(message => message.memory_proposal_id);
  const memory = useAssistantMemory({ enabled: !!state.memory?.pending_count || !!proposalIds.length,
    refreshKey: `${state.epoch}:${state.memory?.revision}:${state.memory?.pending_count}:${proposalIds.join(',')}` });
  const [text, setText] = useState('');
  const inputGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [localTransition, setLocalTransition] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState({ thread: null, messages: [], exhausted: false });
  const [fullMessages, setFullMessages] = useState({});
  const refreshingRows = useRef(new Set());
  const [sendNotice, setSendNotice] = useState('');
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const atBottom = useRef(true);
  const retry = useRef(null);
  const paging = useRef(false);
  const currentThread = useRef(null);
  const alive = useRef(false);
  useEffect(() => {
    if (!draft) return;
    threadGeneration.current++; setViewedThread(null); setThreadBusy(false);
    if (draft.text !== undefined) { inputGeneration.current++; setText(draft.text); }
  }, [draft]);
  useEffect(() => { if (draft && !readOnly) inputRef.current?.focus(); }, [draft, readOnly]);
  const epoch = useRef(null);
  const version = useRef(-1);
  const applied = useRef(0);
  const seenEpochs = useRef(new Set());
  const controller = useRef(null);
  const messagesEnd = useRef(null);
  const pending = useRef(false);
  const composing = useRef(false);
  const applySnapshot = (value, requestedAt) => {
    if (!alive.current || typeof value.epoch !== 'string' || !value.epoch
      || !Number.isSafeInteger(value.version)) return false;
    const sameEpoch = value.epoch === epoch.current;
    if (!sameEpoch && seenEpochs.current.has(value.epoch)) return false;
    if (requestedAt !== undefined && requestedAt !== applied.current
      && !(sameEpoch && value.version > version.current)) return false;
    if (sameEpoch && value.version <= version.current) return false;
    epoch.current = value.epoch;
    version.current = value.version;
    seenEpochs.current.add(value.epoch);
    applied.current++;
    currentThread.current = value.thread_id;
    if (retry.current && retry.current.thread_id !== value.thread_id) retry.current = null;
    setState(value);
    return true;
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
    const requestedAt = applied.current;
    apiFetch('/api/session-hub/chat/state', { signal: controller.current.signal, allowAppForbidden: true })
      .then(value => applySnapshot(value, requestedAt))
      .catch(() => { if (alive.current) setError('대화를 읽지 못했습니다.'); });
    source.onopen = () => { setError(''); };
    source.onerror = () => { setError('연결이 끊겼습니다. 다시 연결 중입니다.'); };
    return () => { alive.current = false; controller.current.abort(); source.close(); };
  }, []);
  useEffect(() => {
    if (atBottom.current) messagesEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [state.messages]);
  const action = async (name, body) => {
    if (pending.current || !controller.current) return;
    pending.current = true;
    const requestedInputGeneration = inputGeneration.current;
    setBusy(true); setError('');
    const autoStart = name === 'message' && state.state !== 'running';
    if (autoStart || name === 'start') setLocalTransition('starting');
    const request = async (operation, payload) => {
      const requestedAt = applied.current;
      const value = await apiFetch(`/api/session-hub/chat/${operation}`, { method: 'POST',
        body: JSON.stringify(payload || {}), signal: controller.current.signal, allowAppForbidden: true });
      applySnapshot(value, requestedAt);
      return value;
    };
    try {
      let thread = state.thread_id;
      const originalEpoch = epoch.current;
      if (autoStart) {
        const started = await request('start');
        if (!alive.current || controller.current.signal.aborted
          || started.epoch !== epoch.current || started.version !== version.current) return;
        if (originalEpoch && started.epoch !== originalEpoch) return;
        if (thread && thread !== started.thread_id) {
          setError('대화가 바뀌었습니다. 다시 보내 주세요.'); return;
        }
        thread = started.thread_id;
        if (started.state !== 'running' || started.disabled || started.turnInProgress) {
          setError(sessionHubErrorText(started.error || started.disabled || 'session_hub_not_running'));
          return;
        }
      }
      const sentEpoch = epoch.current;
      if (name === 'message') {
        if (!thread || thread !== currentThread.current) {
          setError('대화가 바뀌었습니다. 다시 보내 주세요.'); return;
        }
        if (!retry.current || retry.current.thread_id !== thread || retry.current.text !== body.text) {
          retry.current = { thread_id: thread, request_id: createClientMessageKey(), text: body.text };
        }
        body = retry.current;
      }
      const value = await request(name, body);
      if (!alive.current) return;
      if (name === 'message') {
        if (value.epoch === sentEpoch && value.epoch === epoch.current
          && value.thread_id === body.thread_id && currentThread.current === body.thread_id) {
          retry.current = null; atBottom.current = true;
          if (requestedInputGeneration === inputGeneration.current) setText('');
          setSendNotice('');
        } else setSendNotice('서버가 다시 시작되어 질문이 '
          + '전달되지 않았을 수 있습니다. 다시 보내 주세요.');
      }
      if (name === 'threads' && value.thread_id === currentThread.current && value.epoch === epoch.current) {
        retry.current = null; threadGeneration.current++; setViewedThread(null); setThreadList(null);
        setThreadBusy(false);
        if (requestedInputGeneration === inputGeneration.current) setText('');
        setNotice('새 대화를 시작했습니다.');
      }
    } catch (err) {
      if (alive.current) {
        setError(sessionHubErrorText(err.data?.error || err.code || err.message));
      }
    } finally {
      pending.current = false;
      if (alive.current) { setBusy(false); setLocalTransition(''); }
    }
  };
  const listThreads = async () => {
    const sequence = ++threadGeneration.current;
    setThreadBusy(true); setError('');
    try {
      const value = await apiFetch('/api/session-hub/chat/threads',
        { signal: controller.current.signal, allowAppForbidden: true });
      if (alive.current && sequence === threadGeneration.current) setThreadList(value.threads);
    } catch { if (alive.current && sequence === threadGeneration.current) setError('대화 목록을 읽지 못했습니다.'); }
    finally { if (alive.current && sequence === threadGeneration.current) setThreadBusy(false); }
  };
  const openThread = async item => {
    if (item.id === currentThread.current) {
      threadGeneration.current++; setViewedThread(null); setThreadBusy(false); return;
    }
    const sequence = ++threadGeneration.current;
    setThreadBusy(true); setError('');
    try {
      const value = await apiFetch(`/api/session-hub/chat/threads/${encodeURIComponent(item.id)}/messages?limit=50`,
        { signal: controller.current.signal, allowAppForbidden: true });
      if (alive.current && sequence === threadGeneration.current && item.id !== currentThread.current) {
        setViewedThread({ ...item, messages: value.messages }); setThreadList(null);
      }
    } catch { if (alive.current && sequence === threadGeneration.current) setError('이전 대화를 읽지 못했습니다.'); }
    finally { if (alive.current && sequence === threadGeneration.current) setThreadBusy(false); }
  };
  const deleteThread = async item => {
    if (threadBusy || item.id === currentThread.current) return;
    const sequence = ++threadGeneration.current;
    setThreadBusy(true); setError('');
    try {
      await apiFetch(`/api/session-hub/chat/threads/${encodeURIComponent(item.id)}`,
        { method: 'DELETE', signal: controller.current.signal, allowAppForbidden: true });
      if (!alive.current || sequence !== threadGeneration.current) return;
      if (viewedThread?.id === item.id) setViewedThread(null);
      setThreadList(current => current?.filter(value => value.id !== item.id) || null);
      setNotice('이전 대화를 삭제했습니다.');
    } catch { if (alive.current && sequence === threadGeneration.current) setError('대화를 삭제하지 못했습니다.'); }
    finally { if (alive.current && sequence === threadGeneration.current) setThreadBusy(false); }
  };
  const loadOlder = async () => {
    if (paging.current || !thread || (history.thread === thread && history.epoch === state.epoch
      && history.exhausted)) return;
    const older = history.thread === thread && history.epoch === state.epoch ? history.messages : [];
    const before = Math.min(...[...older, ...windowMessages].map(message => message.seq));
    if (!Number.isSafeInteger(before) || before <= 1) return;
    paging.current = true;
    const requestedEpoch = epoch.current;
    const requestedVersion = version.current;
    const scroller = scrollRef.current, height = scroller?.scrollHeight || 0;
    try {
      const value = await apiFetch(`/api/session-hub/chat/threads/${encodeURIComponent(thread)}/messages`
        + `?before=${before}&limit=50`, { signal: controller.current.signal, allowAppForbidden: true });
      if (!alive.current || thread !== displayThread.current || requestedEpoch !== epoch.current) return;
      setHistory({ thread, epoch: requestedEpoch,
        messages: [...value.messages.map(row => ({ ...row, observedVersion: requestedVersion })), ...older],
        exhausted: !value.messages.length });
      requestAnimationFrame(() => {
        if (alive.current && displayThread.current === thread && scroller) {
          scroller.scrollTop += scroller.scrollHeight - height;
        }
      });
    } catch { if (alive.current && displayThread.current === thread) setError('이전 메시지를 읽지 못했습니다.'); }
    finally { paging.current = false; }
  };
  const showFull = async message => {
    const requestedEpoch = epoch.current;
    const requestedVersion = version.current;
    try {
      const value = await apiFetch(`/api/session-hub/chat/threads/${encodeURIComponent(thread)}/messages/`
        + encodeURIComponent(message.id), { signal: controller.current.signal, allowAppForbidden: true });
      if (alive.current && displayThread.current === thread && requestedEpoch === epoch.current) {
        const row = { ...message, ...value, truncated: false, observedVersion: requestedVersion };
        setHistory(current => {
          const sameThread = current.thread === thread && current.epoch === requestedEpoch;
          const rows = sameThread ? current.messages.filter(item => item.id !== row.id) : [];
          return { thread, epoch: requestedEpoch, exhausted: sameThread && current.exhausted,
            messages: [...rows, row].sort((a, b) => a.seq - b.seq) };
        });
        setFullMessages(current => ({ ...current, [`${requestedEpoch}:${thread}:${message.id}`]: {
          row, signature: messageSignature(message),
          epoch: requestedEpoch, thread, observedVersion: requestedVersion,
        } }));
      }
    } catch { if (alive.current && displayThread.current === thread) setError('메시지를 읽지 못했습니다.'); }
  };
  // Paged/full partial rows can leave the recent SSE window before their final commit.
  useEffect(() => {
    if (!state.epoch || !thread) return;
    const previous = history.thread === thread && history.epoch === state.epoch ? history.messages : [];
    const visible = new Map([...previous, ...windowMessages].map(row => [row.id, row]));
    const candidates = new Map(previous.filter(row => row.status === 'partial'
      && row.observedVersion < state.version).map(row => [row.id, row]));
    for (const cached of Object.values(fullMessages)) {
      const row = visible.get(cached.row.id);
      if (cached.epoch === state.epoch && cached.thread === thread && cached.row.status === 'partial'
        && cached.observedVersion < state.version && row?.status === 'partial') candidates.set(row.id, row);
    }
    for (const row of candidates.values()) {
      if (windowMessages.some(item => item.id === row.id && item.status !== 'partial')) continue;
      const key = `${state.epoch}:${thread}:${row.id}`, flight = `${key}:${state.version}`;
      if (refreshingRows.current.has(flight)) continue;
      refreshingRows.current.add(flight);
      const requestedAt = applied.current;
      apiFetch(`/api/session-hub/chat/threads/${encodeURIComponent(thread)}/messages/${encodeURIComponent(row.id)}`,
        { signal: controller.current.signal, allowAppForbidden: true }).then(value => {
        if (!alive.current || displayThread.current !== thread || applied.current !== requestedAt) return;
        const updated = { ...row, ...value, truncated: false, observedVersion: state.version };
        setHistory(current => current.thread === thread && current.epoch === state.epoch ? { ...current,
          messages: current.messages.map(item => item.id === row.id ? updated : item),
        } : current);
        setFullMessages(current => ({ ...current, [key]: { row: updated, signature: messageSignature(row),
          epoch: state.epoch, thread, observedVersion: state.version } }));
      }).catch(() => {
        if (alive.current && displayThread.current === thread && applied.current === requestedAt) {
          setError('메시지를 읽지 못했습니다.');
        }
      }).finally(() => refreshingRows.current.delete(flight));
    }
  }, [state.epoch, state.version, thread, history, fullMessages, windowMessages]);
  const rendered = useMemo(() => {
    const evidence = [];
    const recentIds = new Set(windowMessages.map(message => message.id));
    const previous = history.thread === thread && history.epoch === state.epoch
      ? history.messages.filter(message => !recentIds.has(message.id)) : [];
    const messages = [...previous, ...windowMessages].map(message => {
      const cached = fullMessages[`${state.epoch}:${thread}:${message.id}`];
      const full = cached?.signature === messageSignature(message) ? cached.row : null;
      const merged = { ...message, ...full }, text = merged.content;
      return { ...merged, text,
        rendered: message.role === 'assistant'
          ? renderSessionMarkdown(text, panel, onOpenSession, evidence) : null };
    });
    const mismatch = !!panel?.rev && evidence.some(item => item.rev !== panel.rev
      && panel.cards.some(card => card.key === item.key));
    return { messages: groupHubMessages(messages), mismatch };
  }, [state.epoch, windowMessages, thread, history, fullMessages, panel, onOpenSession]);
  useEffect(() => {
    onRevisionMismatch?.(rendered.mismatch);
    return () => onRevisionMismatch?.(false);
  }, [rendered.mismatch, onRevisionMismatch]);
  const running = state.state === 'running';
  const transitioning = ['starting', 'closing', 'closed'].includes(state.state);
  const disabled = busy || transitioning || !!state.disabled;
  const canSend = !readOnly && !disabled && (running || state.state === 'idle' || state.state.startsWith('error'))
    && !state.turnInProgress && !!text.trim();
  const send = () => { if (canSend) action('message', { text }); };
  const handleKeyDown = event => {
    if (event.isComposing || composing.current || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  };
  return html`<section class="session-hub-chat" aria-label="세션 비서 채팅">
    <header class="manager-chat-header">
      <div class="session-hub-chat-title">
        <span class="session-status-dot ${state.turnInProgress || localTransition
          ? 'working' : running ? 'ended' : 'unknown'}"
          aria-hidden="true" />
        <span>세션 비서</span>
        <span class="manager-status-badge ${state.turnInProgress ? 'running' : 'idle'}" role="status">
          ${state.turnInProgress ? '답변 중' : statusLabels[localTransition || state.state] || '오류'}</span>
      </div>
      <div class="session-hub-chat-actions">
        <button type="button" class="ghost" disabled=${busy || transitioning || state.turnInProgress}
          onClick=${() => action('threads')}>새 대화</button>
        <details class="session-hub-menu" onKeyDown=${event => {
          if (event.key === 'Escape') {
            event.currentTarget.open = false; event.currentTarget.querySelector('summary').focus();
          }
        }}>
          <summary class="ghost session-hub-icon" aria-label="대화 메뉴">⋯</summary>
          <div class="session-hub-menu-content">
            <button type="button" class="ghost" disabled=${threadBusy} onClick=${event => {
              event.currentTarget.closest('details').open = false; void listThreads();
            }}>이전 대화</button>
            <button type="button" data-action="start" class="ghost" disabled=${disabled || running}
              onClick=${() => action('start')}>시작</button>
            <button type="button" class="ghost" disabled=${busy || !running}
              onClick=${() => action('stop')}>중지</button>
          </div>
        </details>
      </div>
    </header>
    ${threadList && html`<section class="session-hub-thread-list" aria-label="이전 대화 목록">
      <button class="ghost" type="button" onClick=${() => {
        threadGeneration.current++; setThreadList(null); setThreadBusy(false);
      }}>닫기</button>
      ${threadList.map(item => html`<div key=${item.id} class="session-hub-thread-row">
        <button class="ghost" type="button" disabled=${threadBusy} onClick=${() => openThread(item)}>
          ${item.title}${item.id === state.thread_id ? ' · 현재' : ' · 읽기 전용'}</button>
        ${item.id !== state.thread_id && html`<button class="ghost" type="button" disabled=${threadBusy}
          aria-label=${`${item.title} 삭제`} onClick=${() => deleteThread(item)}>삭제</button>`}
      </div>`)}
      ${!threadList.length && html`<p>이전 대화가 없습니다.</p>`}
    </section>`}
    ${threadBusy && html`<p class="session-hub-note" role="status">대화 읽는 중</p>`}
    ${viewedThread && html`<div class="session-hub-readonly"><span>${viewedThread.title} · 읽기 전용</span>
      <button class="ghost" type="button" onClick=${() => {
        threadGeneration.current++; setViewedThread(null); setThreadBusy(false);
      }}>
        현재 대화로</button>
      <button class="ghost" type="button" disabled=${threadBusy} onClick=${() => deleteThread(viewedThread)}>삭제</button>
    </div>`}
    ${state.transcripts_remaining > 0 && html`<p class="session-hub-note" role="status">
      정리할 기록 파일 ${state.transcripts_remaining}개</p>`}
    ${error && html`<p class="session-hub-error" role="alert">${error}</p>`}
    ${state.error && html`<p class="session-hub-error" role="alert">${sessionHubErrorText(state.error)}</p>`}
    <div ref=${scrollRef} class="manager-messages session-hub-messages"
      onScroll=${event => {
        const node = event.currentTarget;
        atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        if (node.scrollTop < 40) { atBottom.current = false; void loadOlder(); }
      }} tabindex="0" role="log" aria-label="세션 비서 대화">
      ${notice && html`<p class="session-hub-note" role="status">${notice}</p>`}
      ${sendNotice && html`<p class="session-hub-note" role="status">${sendNotice}</p>`}
      ${!windowMessages.length && html`<p class="session-hub-empty">
        여러 머신의 세션을 물어보세요 — '아까 orca 상위 레이어 얘기한 세션 어디야?'</p>`}
      ${rendered.messages.map((message, index) => message.role === 'tools' ? html`
        <div key=${message.id || index}><details class="session-hub-tools">
          <summary>도구 ${message.tools.length}회 사용 ▸</summary>
          <ul>${message.tools.map((tool, toolIndex) => html`<li key=${toolIndex}>
            ${tool.content}</li>`)}</ul>
        </details>
        ${message.tools.filter(tool => tool.memory_proposal_id).map(tool => {
          const proposal = memory.data.proposals.find(item => item.id === tool.memory_proposal_id);
          return proposal && html`<${AssistantMemoryProposal} key=${proposal.id} proposal=${proposal}
            busy=${memory.busy} readOnly=${readOnly} onDecision=${memory.decide} />`;
        })}</div>` : message.role === 'system_note' && message.status === 'error' ? html`
          <p key=${message.id || index} class="session-hub-error"
            role="alert">${hubErrorLabels[message.text] || message.text}</p>` : html`
          <div key=${message.id || index}
            class="manager-msg-row manager-msg-row-${message.role === 'user' ? 'user' : 'assistant'}">
            <div class="manager-msg manager-msg-${message.role === 'user' ? 'user' : 'assistant'}">
              <div class="manager-msg-content ${message.role === 'assistant' ? 'markdown-body' : ''}">
                ${message.role === 'assistant' ? message.rendered : message.text}</div>
              ${message.role === 'assistant' && message.status !== 'complete' && message.status && html`
                <span class="session-hub-note">${message.status === 'partial' ? '답변 중' : '중단된 답변'}</span>`}
              ${message.truncated && html`<button class="ghost" type="button"
                onClick=${() => showFull(message)}>전체 보기</button>`}
            </div>
          </div>`)}
      ${memory.data.proposals.filter(proposal => proposal.source_thread_id === thread
        && !proposalIds.includes(proposal.id)).map(proposal => html`<${AssistantMemoryProposal}
          key=${proposal.id} proposal=${proposal} busy=${memory.busy}
          readOnly=${readOnly} onDecision=${memory.decide} />`)}
      ${memory.notice && html`<p class="session-hub-note" role="status">${memory.notice}</p>`}
      ${memory.error && html`<p class="session-hub-error" role="alert">${memory.error}</p>`}
      <div ref=${messagesEnd} />
    </div>
    <form class="session-hub-input" onSubmit=${event => { event.preventDefault(); send(); }}>
      <textarea ref=${inputRef} aria-label="세션 비서에게 질문" value=${text} rows="2" disabled=${disabled || readOnly}
        onKeyDown=${handleKeyDown} oncompositionstart=${() => { composing.current = true; }}
        oncompositionend=${() => { composing.current = false; }}
        placeholder="모든 세션에 대해 물어보세요" onInput=${event => {
          inputGeneration.current++; setText(event.target.value);
        }} />
      <button type="submit" class="primary" disabled=${!canSend}>
        전송</button>
    </form>
  </section>`;
}
