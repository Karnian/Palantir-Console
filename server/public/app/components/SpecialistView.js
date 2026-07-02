// SpecialistView — Operator specialist one-shot invocation UI (PF-3: profile-based).
//
// Picks a stored operator profile (persona + capabilities come FROM the profile,
// Contract A) and calls POST /api/operator/specialist { profileId, userText,
// originRunId }, then displays { invocationId, text, toolCallCount, iterations }.
// The specialist is read-only / stateless: no task, no run, no worktree.

import { h } from '../../vendor/preact.module.js';
import { useState, useMemo, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';

export function SpecialistView({ runs = [] }) {
  const [profileId, setProfileId]     = useState('');
  const [userText, setUserText]       = useState('');
  const [originRunId, setOriginRunId] = useState('');
  const [profiles, setProfiles]       = useState([]);
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null);
  const [error, setError]             = useState(null);

  // Load operator profiles for the picker (Contract A: the profile supplies
  // persona + capabilities, so the request only carries profileId).
  useEffect(() => {
    let alive = true;
    apiFetch('/api/operator/profiles')
      .then((data) => { if (alive) setProfiles(Array.isArray(data.profiles) ? data.profiles : []); })
      .catch(() => { if (alive) setProfiles([]); });
    return () => { alive = false; };
  }, []);

  // Active manager runs the operator invocation can be anchored to.
  const managerRuns = useMemo(() =>
    (runs || []).filter(r => r.is_manager &&
      (r.status === 'running' || r.status === 'needs_input')),
    [runs],
  );
  // Reset the selection if the chosen run leaves the active list.
  useEffect(() => {
    if (originRunId && !managerRuns.some(r => r.id === originRunId)) setOriginRunId('');
  }, [managerRuns, originRunId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiFetch('/api/operator/specialist', {
        method: 'POST',
        body: JSON.stringify({ profileId, userText, originRunId }),
      });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || !profileId || !userText.trim() || !originRunId;
  const selectedProfile = profiles.find((p) => p.id === profileId) || null;

  return html`
    <div class="page specialist-page" data-view="specialist">
      <div class="page-header">
        <div>
          <h1>스페셜리스트</h1>
          <p class="specialist-description">저장된 프로필로 폴더 없는 전문 에이전트를 한 번 호출합니다 (읽기 전용 · 도구 없음)</p>
        </div>
      </div>

      <form class="specialist-form" onSubmit=${handleSubmit} novalidate>

        <div class="form-field">
          <label class="form-label" for="specialist-profile">프로필</label>
          <select
            id="specialist-profile"
            class="form-select"
            value=${profileId}
            onChange=${(e) => setProfileId(e.target.value)}
          >
            ${profiles.length === 0
              ? html`<option value="" disabled selected>프로필 없음</option>`
              : html`
                  <option value="">— 프로필 선택 —</option>
                  ${profiles.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}</option>`)}
                `}
          </select>
          ${profiles.length === 0
            ? html`<p class="specialist-hint">오퍼레이터 프로필이 없습니다 — <a href="#operator/profiles">오퍼레이터 프로필</a> 화면에서 먼저 만드세요.</p>`
            : (selectedProfile && selectedProfile.description
              ? html`<p class="specialist-hint">${selectedProfile.description}</p>`
              : null)}
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
          <button type="submit" class="primary" disabled=${submitDisabled} aria-busy=${loading}>
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
