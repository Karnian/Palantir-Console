// SpecialistView — B2c-4 Operator specialist one-shot invocation UI.
//
// Calls POST /api/operator/specialist { profileId, persona?, capabilities[],
// userText, originRunId } and displays the returned { invocationId, text,
// toolCallCount, iterations }.  The view is read-only / stateless on the
// backend: no task, no run, no worktree — just a synchronous specialist turn.

import { h } from '../../vendor/preact.module.js';
import { useState, useMemo, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';

export function SpecialistView({ runs = [] }) {
  const [profileId, setProfileId]           = useState('');
  const [persona, setPersona]               = useState('');
  const [userText, setUserText]             = useState('');
  const [originRunId, setOriginRunId]       = useState('');
  const [metadataSearch, setMetadataSearch] = useState(true);
  const [loading, setLoading]               = useState(false);
  const [result, setResult]                 = useState(null);
  const [error, setError]                   = useState(null);

  // Active manager runs the operator invocation can be anchored to. Truthy
  // is_manager check matches the rest of the console (AttentionStrip/Dashboard/
  // ManagerChat all use `!r.is_manager`); the wire type is integer 1/0.
  const managerRuns = useMemo(() =>
    (runs || []).filter(r => r.is_manager &&
      (r.status === 'running' || r.status === 'needs_input')),
    [runs],
  );

  // Reset the selection if the chosen run leaves the active list, so originRunId
  // never lies about what submit will do (Codex review MINOR).
  useEffect(() => {
    if (originRunId && !managerRuns.some(r => r.id === originRunId)) setOriginRunId('');
  }, [managerRuns, originRunId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    const capabilities = metadataSearch ? ['registry_metadata_search'] : [];
    try {
      const data = await apiFetch('/api/operator/specialist', {
        method: 'POST',
        body: JSON.stringify({
          profileId,
          persona: persona || undefined,
          capabilities,
          userText,
          originRunId,
        }),
      });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || !profileId.trim() || !userText.trim() || !originRunId;

  return html`
    <div class="page specialist-page" data-view="specialist">
      <div class="page-header">
        <div>
          <h1>스페셜리스트</h1>
          <p class="specialist-description">폴더 없는 전문 에이전트를 한 번 호출합니다 (읽기 전용 · 도구 없음)</p>
        </div>
      </div>

      <form class="specialist-form" onSubmit=${handleSubmit} novalidate>

        <div class="form-field">
          <label class="form-label" for="specialist-profile-id">프로필 ID</label>
          <input
            id="specialist-profile-id"
            class="form-input"
            type="text"
            placeholder="예: agent-profile-uuid"
            required
            value=${profileId}
            onInput=${(e) => setProfileId(e.target.value)}
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="specialist-origin-run">원본 매니저 run</label>
          <select
            id="specialist-origin-run"
            class="form-select"
            value=${originRunId}
            onChange=${(e) => setOriginRunId(e.target.value)}
          >
            ${managerRuns.length === 0
              ? html`<option value="" disabled selected>활성 매니저 run 없음</option>`
              : html`
                  <option value="">— run 선택 —</option>
                  ${managerRuns.map((r) => html`
                    <option key=${r.id} value=${r.id}>
                      ${r.id.slice(0, 8)} · ${r.conversation_id || r.status}
                    </option>
                  `)}
                `}
          </select>
          ${managerRuns.length === 0 && html`
            <p class="specialist-hint">활성 매니저 run이 없습니다 — 먼저 매니저를 시작하세요. (실행 버튼이 비활성화됩니다.)</p>
          `}
        </div>

        <div class="form-field">
          <label class="form-label" for="specialist-user-text">요청</label>
          <textarea
            id="specialist-user-text"
            class="form-textarea"
            placeholder="스페셜리스트에게 전달할 내용을 입력하세요..."
            rows="5"
            required
            value=${userText}
            onInput=${(e) => setUserText(e.target.value)}
          ></textarea>
        </div>

        <div class="form-field">
          <label class="form-label" for="specialist-persona">페르소나 (선택)</label>
          <textarea
            id="specialist-persona"
            class="form-textarea"
            placeholder="선택 사항 — 비워두면 프로필 기본 페르소나를 사용합니다."
            rows="3"
            value=${persona}
            onInput=${(e) => setPersona(e.target.value)}
          ></textarea>
        </div>

        <div class="form-field">
          <label class="specialist-checkbox">
            <input
              type="checkbox"
              checked=${metadataSearch}
              onChange=${(e) => setMetadataSearch(e.target.checked)}
            />
            <span>registry_metadata_search (내부 메타데이터 검색)</span>
          </label>
        </div>

        <div class="form-field">
          <button
            type="submit"
            class="btn-primary"
            disabled=${submitDisabled}
            aria-busy=${loading}
          >
            ${loading ? '실행 중…' : '실행'}
          </button>
        </div>
      </form>

      ${error && html`
        <div class="specialist-error" role="alert">${error}</div>
      `}

      ${loading && !error && !result && html`
        <div class="loading" role="status" aria-live="polite">실행 중…</div>
      `}

      ${result && html`
        <div class="specialist-result">
          <pre class="specialist-result-text">${result.text}</pre>
          <div class="specialist-meta">
            도구 호출 ${result.toolCallCount} · 반복 ${result.iterations}
            <span class="specialist-meta-id" data-visual-mask="true">${result.invocationId}</span>
          </div>
        </div>
      `}
    </div>
  `;
}
