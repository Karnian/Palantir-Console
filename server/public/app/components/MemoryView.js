// MemoryView — L1 project memory inspection + post-hoc correction (PR4b).
//
// Lists a project's accumulated memory (active / archived / all) and lets a
// human correct it: edit content, archive/restore, mark reviewed, pin (protect
// from PR5 decay), and view provenance (server-redacted evidence). Every
// mutation is cookie(human)-only — the server (PATCH) returns 403 for
// bearer/none, so this view is for the browser operator.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useCallback, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { EmptyState } from './EmptyState.js';
import { Dropdown } from './Dropdown.js';
import { Modal } from './Modal.js';

const STATUS_TABS = [
  { key: 'active', label: '활성' },
  { key: 'archived', label: '보관' },
  { key: 'all', label: '전체' },
];

export function MemoryView({ projects = [] }) {
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('active');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [provenance, setProvenance] = useState(null);
  // monotonic fetch token: a slower earlier request must not overwrite a newer
  // project/status's result (Codex SERIOUS A2 — stale-fetch race).
  const reqSeqRef = useRef(0);

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  const reload = useCallback(async () => {
    if (!projectId) { setItems([]); return; }
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      const data = await apiFetch(`/api/projects/${projectId}/memory?status=${status}`);
      if (seq !== reqSeqRef.current) return; // a newer request superseded this one
      setItems(Array.isArray(data.memory) ? data.memory : []);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      addToast(`메모리 로드 실패: ${err.message}`, 'error');
      setItems([]);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [projectId, status]);

  useEffect(() => { reload(); }, [reload]);

  async function patch(itemId, body, okMsg) {
    try {
      await apiFetchWithToast(`/api/projects/${projectId}/memory/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      addToast(okMsg, 'success');
      await reload();
      return true;
    } catch {
      return false; // apiFetchWithToast already surfaced the error
    }
  }

  function openEdit(item) { setEditing(item); setEditContent(item.content); }
  async function saveEdit() {
    if (!editing) return;
    // Close ONLY on success — keep the modal + draft on failure (Codex SERIOUS A5).
    const ok = await patch(editing.id, { action: 'update', content: editContent }, '메모리 수정됨');
    if (ok) setEditing(null);
  }

  async function openProvenance(item) {
    try {
      const data = await apiFetch(`/api/projects/${projectId}/memory/${item.id}/provenance`);
      setProvenance(data);
    } catch (err) {
      addToast(`출처 로드 실패: ${err.message}`, 'error');
    }
  }

  return html`
    <div class="page memory-page" data-view="memory">
      <div class="page-header">
        <h1>메모리</h1>
        <div class="memory-controls">
          <${Dropdown}
            wide
            ariaLabel="프로젝트 폴더 선택"
            value=${projectId}
            onChange=${setProjectId}
            options=${projects.length === 0
              ? [{ value: '', label: '프로젝트 폴더 없음' }]
              : projects.map((p) => ({ value: p.id, label: p.name }))}
          />
          <div class="memory-tabs" role="tablist" aria-label="메모리 상태 필터">
            ${STATUS_TABS.map((tab) => html`
              <button
                type="button"
                role="tab"
                aria-selected=${status === tab.key}
                class=${`memory-tab ${status === tab.key ? 'is-active' : ''}`}
                onClick=${() => setStatus(tab.key)}
              >${tab.label}</button>
            `)}
          </div>
        </div>
      </div>

      ${loading
        ? html`<div class="loading">불러오는 중…</div>`
        : (items.length === 0
          ? html`<${EmptyState} title="메모리가 없습니다" message="이 프로젝트 폴더에 표시할 메모리가 아직 없습니다." />`
          : html`<div class="memory-list">
              ${items.map((it) => MemoryCard({ it, patch, openEdit, openProvenance }))}
            </div>`)}

      ${editing && html`
        <${Modal} title="메모리 수정" onClose=${() => setEditing(null)}>
          <textarea
            class="memory-edit-textarea"
            rows="5"
            value=${editContent}
            onInput=${(e) => setEditContent(e.target.value)}
            aria-label="메모리 내용"
          ></textarea>
          <div class="modal-actions">
            <button type="button" class="btn" onClick=${() => setEditing(null)}>취소</button>
            <button type="button" class="btn btn-primary" onClick=${saveEdit}>저장</button>
          </div>
        </${Modal}>
      `}

      ${provenance && html`
        <${Modal} title="출처 (provenance)" onClose=${() => setProvenance(null)}>
          <div class="memory-provenance">
            <div class="memory-provenance-origin"><strong>origin:</strong> ${provenance.origin || '—'}</div>
            <pre class="memory-provenance-json">${JSON.stringify(provenance.evidence ?? {}, null, 2)}</pre>
          </div>
        </${Modal}>
      `}
    </div>
  `;
}

function MemoryCard({ it, patch, openEdit, openProvenance }) {
  const archived = it.status === 'archived';
  const conf = typeof it.confidence === 'number' ? it.confidence.toFixed(2) : null;
  return html`
    <div class=${`memory-card ${archived ? 'is-archived' : ''}`} key=${it.id}>
      <div class="memory-card-head">
        <span class="memory-badge memory-kind">${it.kind}</span>
        <span class="memory-badge memory-origin">${it.origin}</span>
        ${it.pinned ? html`<span class="memory-badge memory-pinned" title="고정됨">📌 고정</span>` : null}
        ${conf !== null ? html`<span class="memory-badge memory-conf" title="신뢰도">${conf}</span>` : null}
        ${archived ? html`<span class="memory-badge memory-archived">보관됨</span>` : null}
      </div>
      <div class="memory-card-content">${it.content}</div>
      <div class="memory-card-actions">
        ${!archived ? html`<button type="button" class="btn btn-sm" onClick=${() => openEdit(it)}>수정</button>` : null}
        ${archived
          ? html`<button type="button" class="btn btn-sm" onClick=${() => patch(it.id, { action: 'restore' }, '복원됨')}>복원</button>`
          : html`<button type="button" class="btn btn-sm" onClick=${() => patch(it.id, { action: 'archive' }, '보관됨')}>보관</button>`}
        <button type="button" class="btn btn-sm" onClick=${() => patch(it.id, { action: 'review' }, '검토 표시됨')}>검토</button>
        <button type="button" class="btn btn-sm" onClick=${() => patch(it.id, { action: 'pin', pinned: !it.pinned }, it.pinned ? '고정 해제됨' : '고정됨')}>
          ${it.pinned ? '고정 해제' : '고정'}
        </button>
        <button type="button" class="btn btn-sm" onClick=${() => openProvenance(it)}>출처</button>
      </div>
    </div>
  `;
}
