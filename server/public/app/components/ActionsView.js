import { h } from '../../vendor/preact.module.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { formatTime, timeAgo } from '../lib/format.js';
import { EmptyState } from './EmptyState.js';

const STATUS_META = {
  awaiting_approval: { label: '승인 대기', token: '--status-needs-input' },
  queued: { label: '대기 중', token: '--status-queued' },
  executing: { label: '실행 중', token: '--status-running' },
  succeeded: { label: '성공', token: '--status-done' },
  partially_applied: { label: '부분 적용', token: '--status-needs-input' },
  failed: { label: '실패', token: '--status-failed' },
  unknown: { label: '확인 필요', token: '--status-queued' },
  reconciling: { label: '대조 중', token: '--status-review' },
  repairing: { label: '복구 중', token: '--status-running' },
  repair_retry_wait: { label: '복구 재시도 대기', token: '--status-needs-input' },
  repair_blocked: { label: '복구 차단', token: '--status-failed' },
  conflict: { label: '충돌', token: '--status-failed' },
};

const panelStyle = {
  minWidth: 0,
  padding: '1rem',
  border: '1px solid var(--border)',
  borderRadius: '0.75rem',
  background: 'var(--bg-surface)',
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || {
    label: status || '알 수 없음',
    token: '--status-queued',
  };
  return html`
    <span
      style=${{
        display: 'inline-flex',
        alignItems: 'center',
        width: 'fit-content',
        padding: '0.2rem 0.5rem',
        border: '1px solid var(' + meta.token + ')',
        borderRadius: '999px',
        color: 'var(' + meta.token + ')',
        background: 'var(--bg-elevated)',
        fontSize: '0.75rem',
        fontWeight: 700,
      }}
    >${meta.label}</span>
  `;
}

function safeExternalUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function externalUrl(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const receipt = events[index]?.receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) continue;
    const url = safeExternalUrl(receipt.html_url) || safeExternalUrl(receipt.url);
    if (url) return url;
  }
  return null;
}

function evidenceText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[표시할 수 없음]';
  }
}

function Fact({ label, value, children }) {
  return html`
    <div style=${{ minWidth: 0 }}>
      <dt style=${{
        color: 'var(--text-muted)',
        fontSize: '0.75rem',
        marginBottom: '0.2rem',
      }}>${label}</dt>
      <dd style=${{ margin: 0, overflowWrap: 'anywhere' }}>
        ${children || value || '—'}
      </dd>
    </div>
  `;
}

export function ActionsView() {
  const [status, setStatus] = useState('');
  const [actions, setActions] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const query = status ? '?status=' + encodeURIComponent(status) : '';
    apiFetch('/api/actions' + query)
      .then((data) => {
        if (!active) return;
        const next = Array.isArray(data.actions) ? data.actions : [];
        setActions(next);
        setSelectedId((current) => next.some((action) => action.id === current)
          ? current
          : (next[0]?.id || ''));
      })
      .catch((err) => {
        if (!active) return;
        setActions([]);
        setSelectedId('');
        setError('액션 목록을 불러오지 못했습니다: ' + err.message);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [status]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    setError('');
    apiFetch('/api/actions/' + encodeURIComponent(selectedId))
      .then((data) => { if (active) setDetail(data); })
      .catch((err) => {
        if (!active) return;
        setDetail(null);
        setError('액션 상세를 불러오지 못했습니다: ' + err.message);
      })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selectedId]);

  const selected = detail?.action;
  const events = Array.isArray(detail?.events) ? detail.events : [];
  const htmlUrl = externalUrl(events);

  return html`
    <div class="page" data-view="actions">
      <header class="page-header">
        <div>
          <h1>액션 관제</h1>
          <p style=${{ color: 'var(--text-muted)', margin: '0.25rem 0 0' }}>
            승인 출처, 외부 식별자와 append-only 실행 증거를 읽기 전용으로 확인합니다.
          </p>
        </div>
        <label style=${{ display: 'grid', gap: '0.35rem', minWidth: '12rem' }}>
          <span style=${{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>상태 필터</span>
          <select
            value=${status}
            onChange=${(event) => setStatus(event.currentTarget.value)}
            aria-label="액션 상태 필터"
          >
            <option value="">모든 상태</option>
            ${Object.entries(STATUS_META).map(([value, meta]) => html`
              <option value=${value}>${meta.label}</option>
            `)}
          </select>
        </label>
      </header>

      ${error ? html`
        <p role="alert" style=${{ color: 'var(--status-failed)' }}>${error}</p>
      ` : null}
      ${loading ? html`
        <div class="loading" role="status">액션을 불러오는 중…</div>
      ` : null}
      ${!loading && actions.length === 0 ? html`
        <${EmptyState}
          icon="⎇"
          text="아직 액션이 없습니다"
          sub="goal_kind 연결과 실행 플래그가 켜지면 액션이 여기에 표시됩니다."
        />
      ` : null}

      ${!loading && actions.length > 0 ? html`
        <div style=${{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 22rem), 1fr))',
          gap: '1rem',
          alignItems: 'start',
        }}>
          <section style=${panelStyle} aria-labelledby="actions-list-title">
            <h2 id="actions-list-title" style=${{ marginTop: 0 }}>액션 목록</h2>
            <ul style=${{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: '0.65rem',
            }}>
              ${actions.map((action) => {
                const summary = action.params_summary || {};
                const isSelected = selectedId === action.id;
                return html`
                  <li style=${{
                    border: '1px solid ' + (isSelected ? 'var(--accent)' : 'var(--border)'),
                    borderRadius: '0.65rem',
                    background: isSelected ? 'var(--accent-muted)' : 'var(--bg-surface)',
                    padding: '0.65rem',
                  }}>
                    <button
                      type="button"
                      aria-pressed=${isSelected}
                      onClick=${() => setSelectedId(action.id)}
                      style=${{
                        display: 'grid',
                        width: '100%',
                        gap: '0.45rem',
                        padding: 0,
                        border: 0,
                        color: 'var(--text-primary)',
                        background: 'inherit',
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      <${StatusBadge} status=${action.status} />
                      <strong>${action.operation || action.connector}</strong>
                      <span style=${{ overflowWrap: 'anywhere' }}>
                        ${summary.repo || '저장소 없음'}${summary.title ? ' · ' + summary.title : ''}
                      </span>
                      <span
                        class="relative-time"
                        data-visual-mask="true"
                        style=${{ color: 'var(--text-muted)', fontSize: '0.75rem' }}
                        title=${formatTime(action.created_at)}
                      >${timeAgo(action.created_at) || '시간 정보 없음'}</span>
                    </button>
                    ${action.status === 'awaiting_approval' ? html`
                      <button
                        type="button"
                        class="btn btn-sm"
                        disabled
                        title="승인 API와 변경 라우트는 PR2에서 제공됩니다."
                        style=${{ marginTop: '0.65rem' }}
                      >승인 (PR2)</button>
                    ` : null}
                  </li>
                `;
              })}
            </ul>
          </section>

          <section style=${panelStyle} aria-labelledby="action-detail-title">
            <h2 id="action-detail-title" style=${{ marginTop: 0 }}>액션 상세</h2>
            ${detailLoading ? html`
              <div class="loading" role="status">상세를 불러오는 중…</div>
            ` : null}
            ${!detailLoading && selected ? html`
              <div style=${{ display: 'grid', gap: '1rem' }}>
                <${StatusBadge} status=${selected.status} />
                <dl style=${{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(9rem, 1fr))',
                  gap: '0.85rem',
                  margin: 0,
                }}>
                  <${Fact} label="승인자" value=${selected.approved_by} />
                  <${Fact}
                    label="승인 시각"
                    value=${selected.approved_at && formatTime(selected.approved_at)}
                  />
                  <${Fact} label="인증 방식" value=${selected.approval_auth_method} />
                  <${Fact}
                    label="승인 만료"
                    value=${selected.approval_expires_at && formatTime(selected.approval_expires_at)}
                  />
                  <${Fact} label="외부 ID">
                    ${htmlUrl ? html`
                      <a href=${htmlUrl} target="_blank" rel="noopener noreferrer">
                        ${selected.external_id || htmlUrl}
                      </a>
                    ` : (selected.external_id || '—')}
                  </${Fact}>
                  <${Fact} label="외부 노드 ID" value=${selected.external_node_id} />
                  <${Fact} label="판정" value=${selected.verdict} />
                  <${Fact} label="복구 시도" value=${String(selected.repair_attempts ?? 0)} />
                </dl>

                <section aria-labelledby="action-evidence-title">
                  <h3 id="action-evidence-title">Evidence timeline</h3>
                  ${events.length === 0 ? html`
                    <p style=${{ color: 'var(--text-muted)' }}>기록된 이벤트가 없습니다.</p>
                  ` : html`
                    <ol style=${{
                      margin: 0,
                      paddingLeft: '1.25rem',
                      display: 'grid',
                      gap: '0.85rem',
                    }}>
                      ${events.map((event) => html`
                        <li>
                          <article style=${{
                            padding: '0.75rem',
                            border: '1px solid var(--border)',
                            borderRadius: '0.65rem',
                            background: 'var(--bg-elevated)',
                          }}>
                            <strong>${event.phase || '단계 없음'}</strong>
                            <div
                              data-visual-mask="true"
                              style=${{
                                color: 'var(--text-muted)',
                                fontSize: '0.75rem',
                                marginTop: '0.2rem',
                              }}
                            >${formatTime(event.ts)}</div>
                            ${event.transport_class ? html`
                              <p style=${{ marginBottom: 0 }}>
                                전송: ${event.transport_class}
                              </p>
                            ` : null}
                            ${event.receipt !== null ? html`
                              <pre style=${{
                                whiteSpace: 'pre-wrap',
                                overflowWrap: 'anywhere',
                                color: 'var(--text-secondary)',
                              }}>${evidenceText(event.receipt)}</pre>
                            ` : null}
                            ${event.error ? html`
                              <p style=${{
                                color: 'var(--status-failed)',
                                overflowWrap: 'anywhere',
                              }}>${event.error}</p>
                            ` : null}
                          </article>
                        </li>
                      `)}
                    </ol>
                  `}
                </section>
              </div>
            ` : null}
          </section>
        </div>
      ` : null}
    </div>
  `;
}
