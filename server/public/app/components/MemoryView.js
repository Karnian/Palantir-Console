// Unified Memory Hub — user / workspace / Operator profile memory.
//
// Human mutations remain cookie-only at the server. In auth-disabled mode a
// "remember" request is intentionally staged as a candidate, never written
// active. Candidate raw_json never crosses an API boundary.

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

const SCOPE_TABS = [
  { key: 'user', label: '전체' },
  { key: 'workspace', label: '프로젝트' },
  { key: 'profile', label: 'Operator' },
  { key: 'cross_project', label: '공통 후보' },
];
const STATUS_TABS = [
  { key: 'active', label: '활성' },
  { key: 'candidate', label: '후보' },
  { key: 'archived', label: '보관' },
  { key: 'all', label: '전체 이력' },
];
const L1_KINDS = ['convention', 'pitfall', 'heuristic', 'constraint'];
const WORKSPACE_KINDS = [...L1_KINDS, 'fact'];
const MASTER_KINDS = ['preference', 'constraint', 'commitment', 'decision', 'pattern', 'fact'];

export function MemoryView({ projects = [] }) {
  const [scope, setScope] = useState('user');
  const [status, setStatus] = useState('active');
  const [projectId, setProjectId] = useState('');
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [items, setItems] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [candidateEditing, setCandidateEditing] = useState(null);
  const [candidateDraft, setCandidateDraft] = useState({ kind: '', content: '', importance: 5 });
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ kind: 'preference', content: '', importance: 5, factKey: '' });
  const [provenance, setProvenance] = useState(null);
  const [candidateBusy, setCandidateBusy] = useState('');
  const requestSeqRef = useRef(0);
  const cursorRef = useRef(null);
  const ownerKeyRef = useRef('');
  const reloadRef = useRef(null);
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

  // Include the status tab in the async commit fence. A mutation started from
  // "active" must not reload that list over a newly selected "archived" tab.
  const ownerKey = `${scope}:${scope === 'workspace' ? projectId : scope === 'profile' ? profileId : scope}:${status}`;
  ownerKeyRef.current = ownerKey;

  const reloadDiagnostics = useCallback(async () => {
    try {
      setDiagnostics(await apiFetch('/api/memory/status'));
    } catch (err) {
      addToast(`메모리 상태 로드 실패: ${err.message}`, 'error');
    }
  }, []);

  const reload = useCallback(async ({ append = false } = {}) => {
    const descriptor = describeScope(scope, projectId, profileId);
    if (!descriptor.ready) {
      requestSeqRef.current += 1;
      setLoading(false);
      setItems([]);
      setCandidates([]);
      setNextCursor(null);
      cursorRef.current = null;
      return;
    }
    if (status === 'candidate' && !diagnostics?.approval?.can_review) {
      requestSeqRef.current += 1;
      setLoading(false);
      setItems([]);
      setCandidates([]);
      setNextCursor(null);
      cursorRef.current = null;
      return;
    }
    const cursor = append ? cursorRef.current : null;
    if (append && !cursor) return;
    const myOwner = ownerKey;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      if (status === 'candidate') {
        const data = await apiFetch(withQuery(descriptor.candidates, [
          descriptor.listScopeQuery,
          'status=pending',
          'limit=50',
          cursor ? `cursor=${encodeURIComponent(cursor)}` : '',
        ]));
        if (seq !== requestSeqRef.current || ownerKeyRef.current !== myOwner) return;
        const next = Array.isArray(data.candidates) ? data.candidates : [];
        setCandidates((current) => append ? mergeCandidates(current, next) : next);
        setItems([]);
        cursorRef.current = data.next_cursor || null;
        setNextCursor(data.next_cursor || null);
      } else {
        const data = await apiFetch(withQuery(descriptor.items, [
          descriptor.listScopeQuery,
          `status=${status}`,
        ]));
        if (seq !== requestSeqRef.current || ownerKeyRef.current !== myOwner) return;
        setItems(Array.isArray(data.memory) ? data.memory : []);
        setCandidates([]);
        cursorRef.current = null;
        setNextCursor(null);
      }
    } catch (err) {
      if (seq !== requestSeqRef.current || ownerKeyRef.current !== myOwner) return;
      addToast(`메모리 로드 실패: ${err.message}`, 'error');
      if (!append) {
        setItems([]);
        setCandidates([]);
      }
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [scope, projectId, profileId, status, diagnostics, ownerKey]);
  reloadRef.current = reload;

  useEffect(() => { reloadDiagnostics(); }, [reloadDiagnostics]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const refresh = () => {
      if (liveReloadTimerRef.current) clearTimeout(liveReloadTimerRef.current);
      liveReloadTimerRef.current = setTimeout(() => {
        reload();
        reloadDiagnostics();
      }, 120);
    };
    const channels = [
      'memory:candidate_created',
      'memory:candidate_rejected',
      'memory:promoted',
      'memory:evicted',
      'memory:decayed',
      'master_memory:candidate_created',
      'master_memory:candidate_rejected',
      'master_memory:promoted',
      'master_memory:evicted',
      'master_memory:decayed',
    ];
    const unsubs = channels.map((channel) => sseBroker.subscribe(channel, refresh));
    return () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      if (liveReloadTimerRef.current) clearTimeout(liveReloadTimerRef.current);
    };
  }, [reload, reloadDiagnostics]);

  function selectScope(nextScope) {
    setScope(nextScope);
    setStatus(nextScope === 'cross_project' ? 'candidate' : 'active');
    setCandidateEditing(null);
    setEditing(null);
  }

  function openAdd() {
    const kinds = kindsForScope(scope);
    setAddDraft({ kind: kinds[0], content: '', importance: 5, factKey: '' });
    setAdding(true);
  }

  async function saveAdd() {
    const descriptor = describeScope(scope, projectId, profileId);
    if (!descriptor.ready || !addDraft.content.trim()) return;
    const myOwner = ownerKey;
    try {
      const data = await apiFetchWithToast(descriptor.remember, {
        method: 'POST',
        body: JSON.stringify({
          kind: addDraft.kind,
          content: addDraft.content,
          importance: Number(addDraft.importance),
          ...(addDraft.kind === 'fact' ? { factKey: addDraft.factKey } : {}),
          ...(scope === 'user' || scope === 'cross_project' ? { scope } : {}),
        }),
      });
      if (data.memory) {
        addToast(`${scopeLabel(scope)} 메모리에 저장됨`, 'success');
        setStatus('active');
      } else {
        addToast(`${scopeLabel(scope)} 후보로 등록됨 — 로그인 후 승인하세요`, 'info');
        setStatus('candidate');
      }
      setAdding(false);
      if (ownerKeyRef.current === myOwner) {
        await Promise.all([reload(), reloadDiagnostics()]);
      } else {
        await reloadDiagnostics();
      }
    } catch {
      // apiFetchWithToast already surfaced the error; keep the draft open.
    }
  }

  async function patchItem(item, body, okMessage) {
    const descriptor = describeScope(scope, projectId, profileId);
    try {
      await apiFetchWithToast(`${descriptor.itemBase}/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      addToast(okMessage, 'success');
      // Always refresh through the latest render's callback. If the user moved
      // to another status/owner while the mutation was pending, refreshing the
      // initiating closure would either overwrite or leave the current view stale.
      if (reloadRef.current) await reloadRef.current();
      return true;
    } catch {
      return false;
    }
  }

  function openEdit(item) {
    setEditing(item);
    setEditContent(item.content || '');
  }

  async function saveEdit() {
    if (!editing) return;
    const ok = await patchItem(editing, { action: 'update', content: editContent }, '메모리 수정됨');
    if (ok) setEditing(null);
  }

  async function openProvenance(item) {
    const descriptor = describeScope(scope, projectId, profileId);
    try {
      setProvenance(await apiFetch(`${descriptor.itemBase}/${encodeURIComponent(item.id)}/provenance`));
    } catch (err) {
      addToast(`출처 로드 실패: ${err.message}`, 'error');
    }
  }

  async function reviewCandidate(candidate, action, override = null) {
    const descriptor = describeScope(scope, projectId, profileId);
    setCandidateBusy(candidate.id);
    try {
      await apiFetchWithToast(
        `${descriptor.candidates}/${encodeURIComponent(candidate.id)}/${action}${descriptor.candidateScopeQuery}`,
        {
          method: 'POST',
          body: override ? JSON.stringify(override) : undefined,
        },
      );
      addToast(action === 'promote' ? '메모리 후보 승인됨' : '메모리 후보 거절됨', 'success');
      if (action === 'promote') setCandidateEditing(null);
      await Promise.all([
        reloadRef.current ? reloadRef.current() : Promise.resolve(),
        reloadDiagnostics(),
      ]);
    } catch {
      // apiFetchWithToast already surfaced the error.
      // A terminal server-side rejection can intentionally return 409 after
      // moving the candidate out of `pending`. Refresh even on failure so the
      // inbox cannot retain a stale, retryable-looking card if SSE is delayed
      // or disconnected.
      await Promise.all([
        reloadRef.current ? reloadRef.current() : Promise.resolve(),
        reloadDiagnostics(),
      ]);
    } finally {
      setCandidateBusy((current) => current === candidate.id ? '' : current);
    }
  }

  function openCandidateEdit(candidate) {
    const kinds = kindsForScope(scope).filter((kind) => kind !== 'fact');
    // Cross-project candidates originate from L1 workspace memory. Their
    // convention/pitfall/heuristic kinds are represented as the L2 `pattern`
    // kind after approval; defaulting them to the first master kind
    // (`preference`) silently changes their meaning.
    const proposedKind = scope === 'cross_project' && L1_KINDS.includes(candidate.kind)
      ? 'pattern'
      : candidate.kind;
    const initialKind = kinds.includes(proposedKind) ? proposedKind : kinds[0];
    setCandidateDraft({
      kind: initialKind,
      content: candidate.preview || '',
      importance: Number.isInteger(Number(candidate.importance))
        && Number(candidate.importance) >= 1
        && Number(candidate.importance) <= 10
        ? Number(candidate.importance)
        : 5,
    });
    setCandidateEditing(candidate);
  }

  async function saveCandidateEdit() {
    if (!candidateEditing || !candidateDraft.content.trim()) return;
    await reviewCandidate(candidateEditing, 'promote', {
      kind: candidateDraft.kind,
      content: candidateDraft.content,
      importance: Number(candidateDraft.importance),
    });
  }

  const descriptor = describeScope(scope, projectId, profileId);
  const canReview = !!diagnostics?.approval?.can_review;

  return html`
    <div class="page memory-page memory-hub" data-view="memory">
      <div class="page-header memory-hub-header">
        <div>
          <h1>Memory Hub</h1>
          <p class="memory-page-subtitle">수집 → 검토 → 활성화 → 주입 흐름을 범위별로 관리합니다.</p>
        </div>
        <button
          type="button"
          class="btn btn-primary"
          onClick=${openAdd}
          disabled=${!descriptor.ready || scope === 'cross_project'}
          title=${scope === 'cross_project' ? '공통 지식은 여러 프로젝트의 관측에서 후보로 생성됩니다' : ''}
        >
          기억 추가
        </button>
      </div>

      <nav class="memory-scope-tabs" role="tablist" aria-label="메모리 범위">
        ${SCOPE_TABS.map((tab) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${scope === tab.key}
            class=${`memory-scope-tab ${scope === tab.key ? 'is-active' : ''}`}
            onClick=${() => selectScope(tab.key)}
          >${tab.label}</button>
        `)}
      </nav>

      <div class="memory-hub-toolbar">
        <div class="memory-owner-picker">
          ${scope === 'workspace' ? html`
            <${Dropdown}
              wide
              ariaLabel="프로젝트 폴더 선택"
              value=${projectId}
              onChange=${setProjectId}
              options=${projects.length
                ? projects.map((project) => ({ value: project.id, label: project.name }))
                : [{ value: '', label: '프로젝트 폴더 없음' }]}
            />
          ` : null}
          ${scope === 'profile' ? html`
            <${Dropdown}
              wide
              ariaLabel="Operator 프로필 선택"
              value=${profileId}
              onChange=${setProfileId}
              options=${profiles.length
                ? profiles.map((profile) => ({ value: profile.id, label: profile.name }))
                : [{ value: '', label: 'Operator 프로필 없음' }]}
            />
          ` : null}
          <div class="memory-owner-summary">
            <strong>${scopeLabel(scope)}</strong>
            <span>${scopeDescription(scope)}</span>
          </div>
        </div>
        <div class="memory-tabs" role="tablist" aria-label="메모리 상태">
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

      <section class="memory-status-section" aria-labelledby="memory-status-title">
        <div class="memory-section-heading">
          <div>
            <h2 id="memory-status-title">누적 상태</h2>
            <p>후보가 활성 메모리로 전환되지 않는 원인을 여기서 확인합니다.</p>
          </div>
          <button type="button" class="btn btn-sm" onClick=${() => {
            reloadDiagnostics();
            reload();
          }}>새로고침</button>
        </div>
        ${diagnostics ? html`
          <div class="memory-status-grid">
            <${StatusMetric}
              label="정제기"
              value=${distillerLabel(diagnostics.distiller)}
              tone=${diagnostics.distiller?.state}
            />
            <${StatusMetric} label="대기 후보" value=${diagnostics.queue?.pending ?? 0} />
            <${StatusMetric} label="프로젝트" value=${diagnostics.queue?.workspace_pending ?? 0} />
            <${StatusMetric} label="Operator" value=${diagnostics.queue?.profile_pending ?? 0} />
            <${StatusMetric} label="현재 표시" value=${status === 'candidate' ? candidates.length : items.length} />
          </div>
        ` : html`<div class="loading">상태 확인 중…</div>`}
        ${diagnostics?.distiller?.state === 'missing_credential' ? html`
          <div class="memory-status-notice is-warning">
            자동 정제가 멈춰 있습니다. ANTHROPIC_API_KEY를 설정하거나 후보를 수정 후 승인하세요.
          </div>
        ` : null}
        ${diagnostics && !canReview ? html`
          <div class="memory-status-notice">
            현재 요청은 사람이 인증된 세션이 아닙니다. 기억 추가는 후보로 저장되며,
            승인·수정·보관은 PALANTIR_TOKEN 로그인 후 가능합니다.
          </div>
        ` : null}
        ${diagnostics?.approval?.actor_boundary === 'run_capabilities_unverified' ? html`
          <div class="memory-status-notice is-warning">
            에이전트는 실행 범위 capability만 받지만, 서버의 전역 토큰 저장소 경계가 확인되지 않았습니다.
            POSIX에서는 일회성 PALANTIR_ACTOR_TOKEN_FILE, Windows에서는 OS·컨테이너 secret 경계를 사용해
            재시작해야 사람 전용 승인을 보안 경계로 사용할 수 있습니다.
          </div>
        ` : null}
        ${diagnostics?.queue?.oldest_pending_at ? html`
          <div class="memory-oldest-pending">가장 오래된 대기 후보: ${diagnostics.queue.oldest_pending_at}</div>
        ` : null}
      </section>

      <section class="memory-content-section" aria-labelledby="memory-content-title">
        <div class="memory-section-heading">
          <div>
            <h2 id="memory-content-title">${scopeLabel(scope)} · ${statusLabel(status)}</h2>
            <p>${status === 'candidate'
              ? '정제된 제안만 표시합니다. 작업 신호의 raw JSON은 브라우저로 전송하지 않습니다.'
              : status === 'all'
                ? '활성·보관·대체된 메모리를 함께 확인합니다. 대체된 항목은 감사용 읽기 전용 이력입니다.'
                : '활성 메모리는 다음 관련 turn의 조합 대상이며, 보관 메모리는 주입되지 않습니다.'}</p>
          </div>
        </div>

        ${loading ? html`<div class="loading">불러오는 중…</div>` : status === 'candidate'
          ? (!canReview
              ? html`<${EmptyState} title="로그인이 필요합니다" message="후보 내용은 사람 세션에서만 검토할 수 있습니다." />`
              : candidates.length === 0
                ? html`<${EmptyState} title="대기 후보가 없습니다" message="제안 또는 작업 신호가 들어오면 여기에 표시됩니다." />`
                : html`<div class="memory-candidate-list">
                    ${candidates.map((candidate) => html`
                      <${CandidateCard}
                        key=${candidate.id}
                        candidate=${candidate}
                        busy=${candidateBusy === candidate.id}
                        onPromote=${() => reviewCandidate(candidate, 'promote')}
                        onEdit=${() => openCandidateEdit(candidate)}
                        onReject=${() => reviewCandidate(candidate, 'reject')}
                      />
                    `)}
                  </div>`)
          : (items.length === 0
              ? html`<${EmptyState}
                  title=${emptyTitle(status)}
                  message=${emptyMessage(scope, status, diagnostics)}
                />`
              : html`<div class="memory-list">
                  ${items.map((item) => html`
                    <${MemoryCard}
                      key=${item.id}
                      item=${item}
                      onEdit=${() => openEdit(item)}
                      onArchive=${() => patchItem(item, { action: 'archive' }, '보관됨')}
                      onRestore=${() => patchItem(item, { action: 'restore' }, '복원됨')}
                      onReview=${() => patchItem(item, { action: 'review' }, '검토 표시됨')}
                      onPin=${() => patchItem(item, { action: 'pin', pinned: !item.pinned }, item.pinned ? '고정 해제됨' : '고정됨')}
                      onProvenance=${() => openProvenance(item)}
                    />
                  `)}
                </div>`)}
        ${nextCursor && !loading ? html`
          <div class="memory-candidate-more">
            <button type="button" class="btn btn-sm" onClick=${() => reload({ append: true })}>더 보기</button>
          </div>
        ` : null}
      </section>

      ${adding ? html`
        <${Modal} open ariaLabel="기억 추가" onClose=${() => setAdding(false)}>
          <div class="modal-header"><h2>기억 추가</h2></div>
          <div class="memory-form">
            <label>범위<input value=${scopeLabel(scope)} disabled /></label>
            <label>종류
              <select value=${addDraft.kind} onChange=${(event) => setAddDraft({ ...addDraft, kind: event.target.value })}>
                ${kindsForScope(scope).map((kind) => html`<option value=${kind}>${kind}</option>`)}
              </select>
            </label>
            ${addDraft.kind === 'fact' ? html`
              <label>Fact key
                <input
                  value=${addDraft.factKey}
                  onInput=${(event) => setAddDraft({ ...addDraft, factKey: event.target.value })}
                  placeholder="tool.example"
                />
              </label>
            ` : null}
            <label>내용
              <textarea
                rows="6"
                value=${addDraft.content}
                onInput=${(event) => setAddDraft({ ...addDraft, content: event.target.value })}
                placeholder="다음 관련 작업에서도 재사용할 내용을 입력하세요"
              ></textarea>
            </label>
            <label>중요도
              <input
                type="number"
                min="1"
                max="10"
                value=${addDraft.importance}
                onInput=${(event) => setAddDraft({ ...addDraft, importance: event.target.value })}
              />
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" onClick=${() => setAdding(false)}>취소</button>
            <button type="button" class="btn btn-primary" onClick=${saveAdd}>저장</button>
          </div>
        </${Modal}>
      ` : null}

      ${editing ? html`
        <${Modal} open ariaLabel="메모리 수정" onClose=${() => setEditing(null)}>
          <div class="modal-header"><h2>메모리 수정</h2></div>
          <textarea
            class="memory-edit-textarea"
            rows="6"
            value=${editContent}
            onInput=${(event) => setEditContent(event.target.value)}
            aria-label="메모리 내용"
          ></textarea>
          <div class="modal-actions">
            <button type="button" class="btn" onClick=${() => setEditing(null)}>취소</button>
            <button type="button" class="btn btn-primary" onClick=${saveEdit}>저장</button>
          </div>
        </${Modal}>
      ` : null}

      ${candidateEditing ? html`
        <${Modal} open ariaLabel="후보 수정 후 승인" onClose=${() => setCandidateEditing(null)}>
          <div class="modal-header"><h2>후보 수정 후 승인</h2></div>
          <p class="memory-modal-note">
            아래 내용은 사람이 작성하는 최종 메모리입니다. 작업 신호 원문은 보안상 노출되지 않습니다.
          </p>
          <div class="memory-form">
            <label>종류
              <select
                value=${candidateDraft.kind}
                onChange=${(event) => setCandidateDraft({ ...candidateDraft, kind: event.target.value })}
              >
                ${kindsForScope(scope).filter((kind) => kind !== 'fact').map((kind) => html`
                  <option value=${kind}>${kind}</option>
                `)}
              </select>
            </label>
            <label>최종 내용
              <textarea
                rows="6"
                value=${candidateDraft.content}
                onInput=${(event) => setCandidateDraft({ ...candidateDraft, content: event.target.value })}
              ></textarea>
            </label>
            <label>중요도
              <input
                type="number"
                min="1"
                max="10"
                value=${candidateDraft.importance}
                onInput=${(event) => setCandidateDraft({ ...candidateDraft, importance: event.target.value })}
              />
            </label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" onClick=${() => setCandidateEditing(null)}>취소</button>
            <button type="button" class="btn btn-primary" onClick=${saveCandidateEdit}>수정 내용 승인</button>
          </div>
        </${Modal}>
      ` : null}

      ${provenance ? html`
        <${Modal} open ariaLabel="출처 (provenance)" onClose=${() => setProvenance(null)}>
          <div class="modal-header"><h2>출처 (provenance)</h2></div>
          <div class="memory-provenance">
            <div class="memory-provenance-origin"><strong>origin:</strong> ${provenance.origin || '—'}</div>
            <pre class="memory-provenance-json">${JSON.stringify(provenance.evidence ?? {}, null, 2)}</pre>
          </div>
        </${Modal}>
      ` : null}
    </div>
  `;
}

function describeScope(scope, projectId, profileId) {
  if (scope === 'workspace') {
    const base = projectId ? `/api/projects/${encodeURIComponent(projectId)}/memory` : '';
    return {
      ready: !!projectId,
      items: base,
      remember: `${base}/remember`,
      candidates: `${base}/candidates`,
      itemBase: base,
      listScopeQuery: '',
      candidateScopeQuery: '',
    };
  }
  if (scope === 'profile') {
    const base = profileId ? `/api/operator/profiles/${encodeURIComponent(profileId)}/memory` : '';
    return {
      ready: !!profileId,
      items: base,
      remember: `${base}/remember`,
      candidates: `${base}/candidates`,
      itemBase: base,
      listScopeQuery: '',
      candidateScopeQuery: '',
    };
  }
  const query = `scope=${encodeURIComponent(scope)}`;
  return {
    ready: true,
    items: '/api/master-memory',
    remember: '/api/master-memory/remember',
    candidates: '/api/master-memory/candidates',
    itemBase: '/api/master-memory',
    listScopeQuery: query,
    candidateScopeQuery: `?${query}`,
  };
}

function withQuery(url, parts) {
  const query = parts.filter(Boolean).join('&');
  return query ? `${url}?${query}` : url;
}

function kindsForScope(scope) {
  if (scope === 'workspace') return WORKSPACE_KINDS;
  if (scope === 'profile') return L1_KINDS;
  return MASTER_KINDS;
}

function scopeLabel(scope) {
  return {
    user: '전체 메모리',
    workspace: '프로젝트 메모리',
    profile: 'Operator 메모리',
    cross_project: 'Cross-project 메모리',
  }[scope] || scope;
}

function scopeDescription(scope) {
  return {
    user: 'Top과 관련 Operator가 공유하는 선호·공통 제약',
    workspace: '선택한 코드베이스에서만 사용하는 규칙·사실·함정',
    profile: '선택한 Operator 역할의 지속적인 작업 방식',
    cross_project: '여러 코드베이스에서 반복 관측되어 전체 승인을 기다리는 지식',
  }[scope] || '';
}

function statusLabel(status) {
  return {
    active: '활성',
    candidate: '후보',
    archived: '보관',
    all: '전체 이력',
  }[status] || status;
}

function emptyTitle(status) {
  return {
    active: '활성 메모리가 없습니다',
    archived: '보관된 메모리가 없습니다',
    all: '메모리 이력이 없습니다',
  }[status] || '메모리가 없습니다';
}

function emptyMessage(scope, status, diagnostics) {
  if (status === 'archived') return '보관 처리된 항목이 없습니다.';
  if (status === 'all') return '활성·보관·대체된 메모리 이력이 없습니다.';
  if (!diagnostics?.approval?.can_review) {
    return 'PALANTIR_TOKEN 로그인 후 기억을 추가하면 다음 관련 turn부터 사용할 수 있습니다.';
  }
  if (scope === 'cross_project') {
    return '두 개 이상의 프로젝트에서 동일하게 관측된 지식이 생기면 후보로 표시됩니다.';
  }
  return '기억 추가를 누르거나 작업 중 재사용 가능한 지식을 후보로 제안하세요.';
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
  return labels[distiller?.state] || '확인 중';
}

function StatusMetric({ label, value, tone = '' }) {
  return html`
    <div class=${`memory-status-metric ${tone ? `is-${tone}` : ''}`}>
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function CandidateCard({ candidate, busy, onPromote, onEdit, onReject }) {
  const direct = candidate.approval_mode === 'deterministic';
  return html`
    <article class="memory-candidate-card">
      <div class="memory-card-head">
        <span class="memory-badge memory-kind">${candidate.kind || candidate.rule}</span>
        <span class="memory-badge memory-origin">${candidate.rule}</span>
        <span class=${`memory-badge ${direct ? 'memory-candidate-ready' : 'memory-candidate-distill'}`}>
          ${direct ? '즉시 승인 가능' : '정제 또는 수정 필요'}
        </span>
      </div>
      <div class="memory-card-content">
        ${candidate.preview || '원시 작업 신호입니다. raw JSON은 노출되지 않으며 그대로 승인할 수 없습니다.'}
      </div>
      <div class="memory-candidate-meta">${candidate.created_at || ''}</div>
      <div class="memory-card-actions">
        ${candidate.can_promote && direct ? html`
          <button type="button" class="btn btn-sm btn-primary" disabled=${busy} onClick=${onPromote}>승인</button>
        ` : null}
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${onEdit}>수정 후 승인</button>
        <button type="button" class="btn btn-sm" disabled=${busy} onClick=${onReject}>거절</button>
      </div>
    </article>
  `;
}

function MemoryCard({ item, onEdit, onArchive, onRestore, onReview, onPin, onProvenance }) {
  const archived = item.status === 'archived';
  const superseded = item.status === 'superseded';
  const confidence = typeof item.confidence === 'number' ? item.confidence.toFixed(2) : null;
  return html`
    <article class=${`memory-card ${archived || superseded ? 'is-archived' : ''}`}>
      <div class="memory-card-head">
        <span class="memory-badge memory-kind">${item.kind}</span>
        <span class="memory-badge memory-origin">${item.origin}</span>
        ${item.pinned ? html`<span class="memory-badge memory-pinned">📌 고정</span>` : null}
        ${confidence !== null ? html`<span class="memory-badge memory-conf">${confidence}</span>` : null}
        ${archived ? html`<span class="memory-badge memory-archived">보관됨</span>` : null}
        ${superseded ? html`<span class="memory-badge memory-archived">대체됨</span>` : null}
      </div>
      <div class="memory-card-content">${item.content}</div>
      <div class="memory-card-meta">
        <span>중요도 ${item.importance ?? '—'}</span>
        <span>${item.updated_at || item.created_at || ''}</span>
      </div>
      <div class="memory-card-actions">
        ${item.status === 'active' ? html`
          <button type="button" class="btn btn-sm" onClick=${onEdit}>수정</button>
          <button type="button" class="btn btn-sm" onClick=${onArchive}>보관</button>
          <button type="button" class="btn btn-sm" onClick=${onReview}>검토</button>
        ` : null}
        ${archived ? html`<button type="button" class="btn btn-sm" onClick=${onRestore}>복원</button>` : null}
        ${!superseded ? html`
          <button type="button" class="btn btn-sm" onClick=${onPin}>${item.pinned ? '고정 해제' : '고정'}</button>
        ` : null}
        <button type="button" class="btn btn-sm" onClick=${onProvenance}>출처</button>
      </div>
    </article>
  `;
}
