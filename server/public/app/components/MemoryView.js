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
import { sseBroker } from '../lib/hooks/sse.js';
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
  const [diagnostics, setDiagnostics] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [candidateScope, setCandidateScope] = useState('workspace');
  const [profileId, setProfileId] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [candidateNextCursor, setCandidateNextCursor] = useState(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  // monotonic fetch token: a slower earlier request must not overwrite a newer
  // project/status's result (Codex SERIOUS A2 — stale-fetch race).
  const reqSeqRef = useRef(0);
  const candidateReqSeqRef = useRef(0);
  const candidateCursorRef = useRef(null);
  const candidateBaseRef = useRef('');
  const liveReloadTimerRef = useRef(null);

  useEffect(() => {
    if (!projectId && projects.length) setProjectId(projects[0].id);
  }, [projects, projectId]);

  useEffect(() => {
    let active = true;
    apiFetch('/api/operator/profiles')
      .then((data) => {
        if (!active) return;
        const next = Array.isArray(data.profiles) ? data.profiles : [];
        setProfiles(next);
        setProfileId((current) => current || (next[0] && next[0].id) || '');
      })
      .catch(() => { if (active) setProfiles([]); });
    return () => { active = false; };
  }, []);

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

  const reloadDiagnostics = useCallback(async () => {
    try {
      setDiagnostics(await apiFetch('/api/memory/status'));
    } catch (err) {
      addToast(`메모리 상태 로드 실패: ${err.message}`, 'error');
    }
  }, []);

  const candidateBase = candidateScope === 'workspace'
    ? (projectId ? `/api/projects/${projectId}/memory/candidates` : '')
    : (profileId ? `/api/operator/profiles/${profileId}/memory/candidates` : '');
  candidateBaseRef.current = candidateBase;

  const reloadCandidates = useCallback(async ({ append = false } = {}) => {
    const base = candidateScope === 'workspace'
      ? (projectId ? `/api/projects/${projectId}/memory/candidates` : '')
      : (profileId ? `/api/operator/profiles/${profileId}/memory/candidates` : '');
    const canReview = diagnostics && diagnostics.approval && diagnostics.approval.can_review;
    if (!base || !canReview) {
      candidateReqSeqRef.current += 1;
      setCandidates([]);
      candidateCursorRef.current = null;
      setCandidateNextCursor(null);
      setCandidateLoading(false);
      return;
    }
    const cursor = append ? candidateCursorRef.current : null;
    if (append && !cursor) return;
    const seq = ++candidateReqSeqRef.current;
    setCandidateLoading(true);
    try {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const data = await apiFetch(`${base}?status=pending&limit=50${cursorQuery}`);
      if (seq !== candidateReqSeqRef.current) return;
      const next = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates((current) => append ? mergeCandidates(current, next) : next);
      candidateCursorRef.current = data.next_cursor || null;
      setCandidateNextCursor(data.next_cursor || null);
    } catch (err) {
      if (seq !== candidateReqSeqRef.current) return;
      addToast(`후보 로드 실패: ${err.message}`, 'error');
      if (!append) setCandidates([]);
    } finally {
      if (seq === candidateReqSeqRef.current) setCandidateLoading(false);
    }
  }, [candidateScope, projectId, profileId, diagnostics]);

  useEffect(() => { reloadDiagnostics(); }, [reloadDiagnostics]);
  useEffect(() => { reloadCandidates(); }, [reloadCandidates]);

  useEffect(() => {
    const refreshLive = () => {
      if (liveReloadTimerRef.current) clearTimeout(liveReloadTimerRef.current);
      liveReloadTimerRef.current = setTimeout(() => {
        reload();
        reloadDiagnostics();
        reloadCandidates();
      }, 120);
    };
    const channels = [
      'memory:candidate_created',
      'memory:candidate_rejected',
      'memory:promoted',
      'memory:evicted',
      'memory:decayed',
      'master_memory:promoted',
      'master_memory:evicted',
      'master_memory:decayed',
    ];
    const unsubs = channels.map((channel) => sseBroker.subscribe(channel, refreshLive));
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      if (liveReloadTimerRef.current) clearTimeout(liveReloadTimerRef.current);
    };
  }, [reload, reloadCandidates, reloadDiagnostics]);

  async function reviewCandidate(candidate, action) {
    const reviewBase = candidateBase;
    if (!reviewBase) return;
    try {
      await apiFetchWithToast(`${reviewBase}/${candidate.id}/${action}`, {
        method: 'POST',
      });
      addToast(action === 'promote' ? '메모리 후보 승인됨' : '메모리 후보 거절됨', 'success');
      // The operator may switch project/profile while the mutation is in
      // flight. Old-owner reload closures must not overwrite the new view.
      if (candidateBaseRef.current === reviewBase) {
        await Promise.all([reloadCandidates(), reloadDiagnostics(), reload()]);
      } else {
        await reloadDiagnostics();
      }
    } catch {
      // apiFetchWithToast already surfaced the error.
    }
  }

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

      <section class="memory-section memory-status-section" aria-labelledby="memory-status-title">
        <div class="memory-section-heading">
          <div>
            <h2 id="memory-status-title">누적 상태</h2>
            <p>후보가 실제 메모리로 전환되는 경로와 대기열 상태입니다.</p>
          </div>
          <button type="button" class="btn btn-sm" onClick=${() => {
            reloadDiagnostics();
            reloadCandidates();
          }}>새로고침</button>
        </div>
        ${diagnostics
          ? html`<div class="memory-status-grid">
              <${StatusMetric}
                label="정제기"
                value=${distillerLabel(diagnostics.distiller)}
                tone=${diagnostics.distiller && diagnostics.distiller.state}
              />
              <${StatusMetric} label="대기 후보" value=${diagnostics.queue?.pending ?? 0} />
              <${StatusMetric} label="프로젝트" value=${diagnostics.queue?.workspace_pending ?? 0} />
              <${StatusMetric} label="오퍼레이터" value=${diagnostics.queue?.profile_pending ?? 0} />
            </div>`
          : html`<div class="loading">상태 확인 중…</div>`}
        ${diagnostics?.distiller?.state === 'missing_credential'
          ? html`<div class="memory-status-notice is-warning">
              자동 정제가 멈춰 있습니다. 서버에 ANTHROPIC_API_KEY를 설정하거나 후보를 직접 검토하세요.
            </div>`
          : null}
        ${diagnostics && !diagnostics.approval?.can_review
          ? html`<div class="memory-status-notice">
              후보 승인·거절은 PALANTIR_TOKEN으로 로그인한 브라우저 세션에서만 가능합니다.
            </div>`
          : null}
      </section>

      <section class="memory-section memory-candidate-section" aria-labelledby="memory-candidate-title">
        <div class="memory-section-heading">
          <div>
            <h2 id="memory-candidate-title">후보 Inbox</h2>
            <p>R4 후보는 모델 호출 없이 승인되고, 작업 신호 후보는 자동 정제를 기다립니다.</p>
          </div>
          <div class="memory-candidate-controls">
            <div class="memory-tabs" role="tablist" aria-label="후보 소유자 범위">
              <button
                type="button"
                role="tab"
                aria-selected=${candidateScope === 'workspace'}
                class=${`memory-tab ${candidateScope === 'workspace' ? 'is-active' : ''}`}
                onClick=${() => setCandidateScope('workspace')}
              >프로젝트</button>
              <button
                type="button"
                role="tab"
                aria-selected=${candidateScope === 'profile'}
                class=${`memory-tab ${candidateScope === 'profile' ? 'is-active' : ''}`}
                onClick=${() => setCandidateScope('profile')}
              >오퍼레이터</button>
            </div>
            ${candidateScope === 'profile' ? html`
              <${Dropdown}
                wide
                ariaLabel="오퍼레이터 프로필 선택"
                value=${profileId}
                onChange=${setProfileId}
                options=${profiles.length === 0
                  ? [{ value: '', label: '오퍼레이터 프로필 없음' }]
                  : profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
              />
            ` : null}
          </div>
        </div>
        ${candidateLoading
          ? html`<div class="loading">후보 불러오는 중…</div>`
          : (!diagnostics?.approval?.can_review
            ? html`<div class="memory-candidate-empty">로그인 후 후보 원문을 안전하게 검토할 수 있습니다.</div>`
            : candidates.length === 0
              ? html`<div class="memory-candidate-empty">대기 중인 후보가 없습니다.</div>`
              : html`<div class="memory-candidate-list">
                  ${candidates.map((candidate) => html`
                    <${CandidateCard}
                      key=${candidate.id}
                      candidate=${candidate}
                      onPromote=${() => reviewCandidate(candidate, 'promote')}
                      onReject=${() => reviewCandidate(candidate, 'reject')}
                    />
                  `)}
                </div>`)}
        ${candidateNextCursor && !candidateLoading
          ? html`<div class="memory-candidate-more">
              <button
                type="button"
                class="btn btn-sm"
                onClick=${() => reloadCandidates({ append: true })}
              >더 보기</button>
            </div>`
          : null}
      </section>

      <section class="memory-section memory-active-section" aria-labelledby="memory-active-title">
        <div class="memory-section-heading">
          <div>
            <h2 id="memory-active-title">프로젝트 메모리</h2>
            <p>현재 선택한 프로젝트의 활성·보관 메모리입니다.</p>
          </div>
        </div>
      ${loading
        ? html`<div class="loading">불러오는 중…</div>`
        : (items.length === 0
          ? html`<${EmptyState} title="메모리가 없습니다" message="이 프로젝트 폴더에 표시할 메모리가 아직 없습니다." />`
          : html`<div class="memory-list">
              ${items.map((it) => MemoryCard({ it, patch, openEdit, openProvenance }))}
            </div>`)}
      </section>

      ${editing && html`
        <${Modal} open ariaLabel="메모리 수정" onClose=${() => setEditing(null)}>
          <div class="modal-header"><h2>메모리 수정</h2></div>
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
        <${Modal} open ariaLabel="출처 (provenance)" onClose=${() => setProvenance(null)}>
          <div class="modal-header"><h2>출처 (provenance)</h2></div>
          <div class="memory-provenance">
            <div class="memory-provenance-origin"><strong>origin:</strong> ${provenance.origin || '—'}</div>
            <pre class="memory-provenance-json">${JSON.stringify(provenance.evidence ?? {}, null, 2)}</pre>
          </div>
        </${Modal}>
      `}
    </div>
  `;
}

function mergeCandidates(current, next) {
  const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
  next.forEach((candidate) => byId.set(candidate.id, candidate));
  return Array.from(byId.values());
}

function distillerLabel(distiller) {
  const labels = {
    running: '실행 중',
    disabled: '꺼짐',
    missing_credential: '자격 증명 없음',
    failed: '시작 실패',
    unavailable: '확인 불가',
  };
  return labels[distiller && distiller.state] || '확인 중';
}

function StatusMetric({ label, value, tone = '' }) {
  return html`
    <div class=${`memory-status-metric ${tone ? `is-${tone}` : ''}`}>
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function CandidateCard({ candidate, onPromote, onReject }) {
  const deterministic = candidate.approval_mode === 'deterministic';
  return html`
    <article class="memory-candidate-card">
      <div class="memory-card-head">
        <span class="memory-badge memory-kind">${candidate.kind || candidate.rule}</span>
        <span class="memory-badge memory-origin">${candidate.rule}</span>
        <span class=${`memory-badge ${deterministic ? 'memory-candidate-ready' : 'memory-candidate-distill'}`}>
          ${deterministic ? '즉시 승인 가능' : '자동 정제 필요'}
        </span>
      </div>
      <div class="memory-card-content">
        ${candidate.preview || '원시 작업 신호입니다. 모델 정제 전에는 메모리 내용으로 노출되지 않습니다.'}
      </div>
      <div class="memory-candidate-meta">${candidate.created_at || ''}</div>
      <div class="memory-card-actions">
        ${candidate.can_promote
          ? html`<button type="button" class="btn btn-sm btn-primary" onClick=${onPromote}>승인</button>`
          : null}
        <button type="button" class="btn btn-sm" onClick=${onReject}>거절</button>
      </div>
    </article>
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
