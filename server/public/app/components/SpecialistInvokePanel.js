// SpecialistInvokePanel — shared operator specialist invocation flow.
//
// This component owns the origin-run contract and POST shape for specialist
// calls. Page and roster entrypoints must pass `runs`; they must not duplicate
// the auto-select / explicit-pick rules or invoke request logic.

import { h } from '../../vendor/preact.module.js';
import { useState, useMemo, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { Dropdown } from './Dropdown.js';

export function SpecialistInvokePanel({ initialProfileId = '', runs = [], onCompleted = null }) {
  const [profileId, setProfileId]     = useState('');
  const [userText, setUserText]       = useState('');
  const [originRunId, setOriginRunId] = useState('');
  const [profiles, setProfiles]       = useState([]);
  const [loading, setLoading]         = useState(false);
  const [result, setResult]           = useState(null);
  const [error, setError]             = useState(null);
  const initialProfileSeedRef         = useRef(null);
  const originAutoSelectedRef         = useRef(false);
  const normalizedInitialProfileId    = String(initialProfileId || '').trim();

  // Load operator profiles for the picker (Contract A: the profile supplies
  // persona + capabilities, so the request only carries profileId).
  useEffect(() => {
    let alive = true;
    apiFetch('/api/operator/profiles')
      .then((data) => { if (alive) setProfiles(Array.isArray(data?.profiles) ? data.profiles : []); })
      .catch(() => { if (alive) setProfiles([]); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!normalizedInitialProfileId) return;
    if (initialProfileSeedRef.current === normalizedInitialProfileId) return;
    if (!profiles.some((p) => String(p?.id || '') === normalizedInitialProfileId)) return;
    setProfileId(normalizedInitialProfileId);
    initialProfileSeedRef.current = normalizedInitialProfileId;
  }, [profiles, normalizedInitialProfileId]);

  // Active manager runs the operator invocation can be anchored to.
  const managerRuns = useMemo(() =>
    (runs || []).filter(r => r.is_manager &&
      (r.status === 'running' || r.status === 'needs_input')),
    [runs],
  );

  // Auto-anchor when there is exactly one active manager run; otherwise keep
  // the origin-run contract explicit and reset stale selections.
  useEffect(() => {
    if (managerRuns.length === 1) {
      const nextRunId = managerRuns[0]?.id || '';
      if (nextRunId && originRunId !== nextRunId) {
        originAutoSelectedRef.current = true;
        setOriginRunId(nextRunId);
      }
      return;
    }
    // Transitioned from the single auto-anchored run to multiple: the user
    // never explicitly chose, so drop the auto-selection and force a pick
    // (multiple active runs = explicit origin-run contract).
    if (originAutoSelectedRef.current) {
      originAutoSelectedRef.current = false;
      if (originRunId) setOriginRunId('');
      return;
    }
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
      if (typeof onCompleted === 'function') onCompleted(data);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  const submitDisabled = loading || !profileId || !userText.trim() || !originRunId;
  const selectedProfile = profiles.find((p) => String(p.id) === profileId) || null;

  return html`
    <div class="specialist-invoke-panel" data-role="specialist-invoke-panel">
      <form class="specialist-form" onSubmit=${handleSubmit} novalidate>

        <div class="form-field">
          <label class="form-label" for="specialist-profile">프로필</label>
          <${Dropdown}
            id="specialist-profile"
            className="dropdown-field"
            value=${profileId}
            onChange=${setProfileId}
            disabled=${profiles.length === 0}
            placeholder=${profiles.length === 0 ? '프로필 없음' : undefined}
            options=${profiles.length === 0
              ? []
              : [
                { value: '', label: '— 프로필 선택 —' },
                ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ]}
          />
          ${profiles.length === 0
            ? html`<p class="specialist-hint">오퍼레이터 프로필이 없습니다 — <a href="#operator/profiles">오퍼레이터 프로필</a> 화면에서 먼저 만드세요.</p>`
            : (selectedProfile && selectedProfile.description
              ? html`<p class="specialist-hint">${selectedProfile.description}</p>`
              : null)}
        </div>

        <div class="form-field">
          <label class="form-label" for="specialist-origin-run">원본 매니저 run</label>
          <${Dropdown}
            id="specialist-origin-run"
            className="dropdown-field"
            value=${originRunId}
            onChange=${(next) => { originAutoSelectedRef.current = false; setOriginRunId(next); }}
            disabled=${managerRuns.length === 0}
            placeholder=${managerRuns.length === 0 ? '활성 매니저 run 없음' : undefined}
            options=${managerRuns.length === 0
              ? []
              : [
                { value: '', label: '— run 선택 —' },
                ...managerRuns.map((r) => ({
                  value: r.id,
                  label: `${r.id.slice(0, 8)} · ${r.conversation_id || r.status}`,
                })),
              ]}
          />
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
