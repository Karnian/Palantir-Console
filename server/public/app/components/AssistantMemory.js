import { h } from '../../vendor/preact.module.js';
import { useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { useAssistantMemory } from '../lib/hooks/useAssistantMemory.js';
import { Dropdown } from './Dropdown.js';
const html = htm.bind(h);
const ASSISTANT_KINDS = { preference: '선호', fact: '사실', person: '인물', project: '프로젝트', other: '기타' };
export function AssistantMemoryProposal({ proposal, busy, onDecision, readOnly = false }) {
  return html`<article class="session-hub-proposal" aria-label="기억 제안">
    <h3>${proposal.operation === 'forget' ? '기억 보관 제안' : '기억 제안'} · ${ASSISTANT_KINDS[proposal.kind]}</h3>
    <p>${proposal.content}</p>
    ${proposal.reason && html`<p class="work-label">${proposal.reason}</p>`}
    <blockquote><span class="work-label">출처 발언</span><p>${proposal.source_status === 'deleted'
      ? '삭제된 대화' : proposal.source_content || '발언을 읽지 못했습니다.'}</p></blockquote>
    ${!readOnly && html`<footer>
      <button class="primary" type="button" disabled=${busy}
        onClick=${() => onDecision(proposal, 'approve')}>기억</button>
      <button class="ghost" type="button" disabled=${busy} onClick=${() => onDecision(proposal, 'reject')}>거절</button>
    </footer>`}
  </article>`;
}
export function AssistantMemoryView() {
  const memory = useAssistantMemory();
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState(null);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState('preference');
  const [adding, setAdding] = useState(false);
  const formGeneration = useRef(0);
  const inputGeneration = useRef(0);
  const save = async event => {
    event.preventDefault();
    const requestedForm = formGeneration.current, requestedInput = inputGeneration.current;
    const success = await memory.mutate(editing ? `/${encodeURIComponent(editing.id)}` : '',
      editing ? 'PATCH' : 'POST', { content, kind, ...(editing ? { revision: editing.revision } : {}) }, '기억을 저장했습니다.');
    if (!success || requestedForm !== formGeneration.current) return;
    if (requestedInput !== inputGeneration.current) {
      // This successful PATCH advanced our revision once; retain newer edits against that acknowledgement.
      if (editing) setEditing(current => current?.id === editing.id && current.revision === editing.revision
        ? { ...current, revision: editing.revision + 1 } : current);
      return;
    }
    formGeneration.current++; inputGeneration.current++;
    setEditing(null); setAdding(false); setContent(''); setKind('preference');
  };
  return html`<section class="assistant-memory-content" aria-label="비서 기억">
    <div class="memory-hub-toolbar">
      <div class="memory-tabs" role="group" aria-label="비서 기억 상태">
        ${[['active', '활성'], ['pending', `승인 대기 ${memory.data.pending_count || 0}`], ['archived', '보관']]
          .map(([value, label]) => html`<button key=${value} class="ghost" type="button"
            aria-pressed=${status === value} onClick=${() => setStatus(value)}>${label}</button>`)}
      </div>
      <button class="ghost" type="button" onClick=${() => {
        formGeneration.current++;
        setEditing(null); setAdding(true); setContent(''); setKind('preference');
      }}>기억 추가</button>
      <button class="ghost" type="button" onClick=${memory.reload}>새로고침</button>
    </div>
    ${memory.notice && html`<p role="status">${memory.notice}</p>`}
    ${memory.error && html`<p role="alert">${memory.error}</p>`}
    ${memory.loading && html`<p role="status">기억 읽는 중</p>`}
    ${(editing || adding) && html`<form onSubmit=${save}>
      <label>기억 내용<textarea aria-label="비서 기억 내용" value=${content}
        onInput=${event => { inputGeneration.current++; setContent(event.target.value); }} /></label>
      <${Dropdown} ariaLabel="기억 종류" value=${kind} onChange=${value => {
        inputGeneration.current++; setKind(value);
      }}
        options=${Object.entries(ASSISTANT_KINDS).map(([value, label]) => ({ value, label }))} />
      <button class="primary" type="submit" disabled=${memory.busy || !content.trim() || [...content].length > 500}>
        저장</button>
      <button class="ghost" type="button" onClick=${() => {
        formGeneration.current++; setEditing(null); setAdding(false);
      }}>취소</button>
    </form>`}
    ${status === 'pending' ? memory.data.proposals.map(proposal => html`<${AssistantMemoryProposal}
      key=${proposal.id} proposal=${proposal} busy=${memory.busy} onDecision=${memory.decide} />`)
      : memory.data.memories.filter(item => item.status === status).map(item => html`
        <article class="assistant-memory-item" key=${item.id}>
          <span class="work-label">${ASSISTANT_KINDS[item.kind]}</span><p>${item.content}</p>
          ${status === 'active' && html`<footer>
            <button class="ghost" type="button" disabled=${memory.busy} onClick=${() => {
              formGeneration.current++;
              setAdding(false); setEditing(item); setContent(item.content); setKind(item.kind);
            }}>수정</button>
            <button class="ghost" type="button" disabled=${memory.busy} onClick=${() =>
              memory.mutate(`/${encodeURIComponent(item.id)}/archive`, 'POST', { revision: item.revision }, '보관했습니다.')}>
              보관</button>
          </footer>`}
        </article>`)}
    ${!memory.loading && !(status === 'pending' ? memory.data.proposals
      : memory.data.memories.filter(item => item.status === status)).length && html`<p>기억이 없습니다.</p>`}
  </section>`;
}
