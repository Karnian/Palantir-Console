// ModelPoliciesView — Model/Effort policy CRUD and effective-value preview.

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { COMMON_ACTIONS } from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { Dropdown } from './Dropdown.js';
import { Modal } from './Modal.js';

const CLI_DEFAULT = '__cli_default__';
const SCOPE_TYPES = [
  ['global', '전역'],
  ['layer:top', 'Top 레이어'],
  ['layer:operator', 'Operator 레이어'],
  ['codebase', '프로젝트 폴더'],
];
const VENDORS = ['codex', 'claude'];
const FIELD_LABELS = {
  model: 'model',
  reasoning_effort: 'reasoning_effort',
  tier: 'tier',
};
const VALUE_OPTIONS = {
  reasoning_effort: [
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
  ],
  tier: [
    ['fast', 'fast'],
    ['standard', 'standard'],
  ],
};
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function Loading() {
  return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`;
}

function policyPath(policy) {
  return `/api/model-policies/${encodeURIComponent(policy.scope_type)}/${encodeURIComponent(policy.scope_id)}/${encodeURIComponent(policy.vendor)}`;
}

function policyKey(policy) {
  return `${policy.scope_type}:${policy.scope_id}:${policy.vendor}`;
}

function projectName(projects, projectId) {
  const project = (projects || []).find(item => item.id === projectId);
  return project?.name || projectId;
}

function scopeTitle(policy, projects) {
  const label = SCOPE_TYPES.find(([value]) => value === policy.scope_type)?.[1] || policy.scope_type;
  return policy.scope_type === 'codebase'
    ? `${label}: ${projectName(projects, policy.scope_id)}`
    : label;
}

function storedValue(params, field) {
  if (!hasOwn(params, field)) return 'inherit';
  return params[field] === CLI_DEFAULT ? 'cli-default' : String(params[field]);
}

function modeFor(params, field) {
  if (!hasOwn(params, field)) return 'inherit';
  return params[field] === CLI_DEFAULT ? 'cli-default' : 'explicit';
}

function valueFor(params, field) {
  if (modeFor(params, field) !== 'explicit') {
    if (field === 'reasoning_effort') return 'medium';
    if (field === 'tier') return 'standard';
    return '';
  }
  return params[field];
}

function FieldEditor({ field, mode, value, onMode, onValue }) {
  const modeId = `model-policy-${field}-mode`;
  const valueId = `model-policy-${field}-value`;
  const allowsCliDefault = field !== 'tier';

  return html`
    <div class="form-row" data-policy-field=${field}>
      <label class="form-label" for=${modeId}>${FIELD_LABELS[field]} 설정 방식</label>
      <${Dropdown}
        id=${modeId}
        className="dropdown-field"
        value=${mode}
        onChange=${onMode}
        options=${[
          { value: 'inherit', label: 'inherit' },
          { value: 'explicit', label: 'explicit' },
          ...(allowsCliDefault ? [{ value: 'cli-default', label: 'cli-default' }] : []),
        ]}
      />
      ${mode === 'explicit' && field === 'model' && html`
        <label class="form-label" for=${valueId} style=${{ marginTop: '8px' }}>model 값</label>
        <input
          id=${valueId}
          class="form-input"
          type="text"
          maxlength="200"
          value=${value}
          onInput=${event => onValue(event.target.value)}
          autocomplete="off"
        />
      `}
      ${mode === 'explicit' && field !== 'model' && html`
        <label class="form-label" for=${valueId} style=${{ marginTop: '8px' }}>${FIELD_LABELS[field]} 값</label>
        <${Dropdown}
          id=${valueId}
          className="dropdown-field"
          value=${value}
          onChange=${onValue}
          options=${VALUE_OPTIONS[field].map(([optionValue, label]) => ({ value: optionValue, label }))}
        />
      `}
    </div>
  `;
}

function PolicyEditor({ open, policy, projects, onClose, onSaved, onConflict }) {
  const isEdit = !!policy;
  const [scopeType, setScopeType] = useState('global');
  const [scopeId, setScopeId] = useState('*');
  const [vendor, setVendor] = useState('codex');
  const [fieldModes, setFieldModes] = useState({
    model: 'inherit',
    reasoning_effort: 'inherit',
    tier: 'inherit',
  });
  const [fieldValues, setFieldValues] = useState({
    model: '',
    reasoning_effort: 'medium',
    tier: 'standard',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const params = policy?.params || {};
    setScopeType(policy?.scope_type || 'global');
    setScopeId(policy?.scope_id || '*');
    setVendor(policy?.vendor || 'codex');
    setFieldModes({
      model: modeFor(params, 'model'),
      reasoning_effort: modeFor(params, 'reasoning_effort'),
      tier: modeFor(params, 'tier'),
    });
    setFieldValues({
      model: valueFor(params, 'model'),
      reasoning_effort: valueFor(params, 'reasoning_effort'),
      tier: valueFor(params, 'tier'),
    });
    setSaving(false);
  }, [open, policy]);

  const changeScope = (nextScopeType) => {
    setScopeType(nextScopeType);
    setScopeId(nextScopeType === 'codebase' ? ((projects || [])[0]?.id || '') : '*');
  };

  const changeMode = (field, nextMode) => {
    setFieldModes(current => ({ ...current, [field]: nextMode }));
  };

  const changeValue = (field, nextValue) => {
    setFieldValues(current => ({ ...current, [field]: nextValue }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const finalScopeId = scopeType === 'codebase' ? scopeId : '*';
    if (scopeType === 'codebase' && !finalScopeId) {
      addToast('프로젝트 폴더를 선택하세요.', 'error');
      return;
    }

    const supportedFields = vendor === 'claude'
      ? ['model']
      : ['model', 'reasoning_effort', 'tier'];
    const params = {};
    for (const field of supportedFields) {
      const mode = fieldModes[field];
      if (mode === 'inherit') continue;
      if (mode === 'cli-default') {
        params[field] = CLI_DEFAULT;
        continue;
      }
      const value = field === 'model' ? fieldValues[field].trim() : fieldValues[field];
      if (field === 'model' && !value) {
        addToast('model 값을 입력하세요.', 'error');
        return;
      }
      params[field] = value;
    }

    const body = { params };
    if (isEdit) body.expectedRevision = policy.revision;

    setSaving(true);
    try {
      await apiFetch(policyPath({ scope_type: scopeType, scope_id: finalScopeId, vendor }), {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      addToast('모델 정책을 저장했습니다.', 'success');
      await onSaved();
      onClose();
    } catch (err) {
      if (err?.status === 409) {
        addToast('다른 곳에서 변경됨, 새로고침', 'error');
        await onConflict();
      } else {
        addToast(err.message, 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  return html`
    <${Modal}
      open=${open}
      onClose=${onClose}
      labelledBy="model-policy-editor-title"
      maxWidth="560px"
      backdropClose=${!saving}
      escapeClose=${!saving}
    >
      <form onSubmit=${handleSubmit}>
        <div class="modal-header">
          <h2 class="modal-title" id="model-policy-editor-title">${isEdit ? '모델 정책 편집' : '새 모델 정책'}</h2>
        </div>
        <div class="modal-body">
          <div class="form-row">
            <label class="form-label" for="model-policy-scope-type">범위</label>
            <${Dropdown}
              id="model-policy-scope-type"
              className="dropdown-field"
              value=${scopeType}
              onChange=${changeScope}
              disabled=${isEdit}
              options=${SCOPE_TYPES.map(([value, label]) => ({ value, label }))}
            />
          </div>
          ${scopeType === 'codebase' && html`
            <div class="form-row">
              <label class="form-label" for="model-policy-scope-id">프로젝트 폴더</label>
              <${Dropdown}
                id="model-policy-scope-id"
                className="dropdown-field"
                value=${scopeId}
                onChange=${setScopeId}
                disabled=${isEdit}
                options=${(projects || []).length === 0
                  ? [{ value: '', label: '선택 가능한 프로젝트 폴더 없음' }]
                  : (projects || []).map(project => ({ value: project.id, label: project.name || project.id }))}
              />
            </div>
          `}
          <div class="form-row">
            <label class="form-label" for="model-policy-vendor">공급자</label>
            <${Dropdown}
              id="model-policy-vendor"
              className="dropdown-field"
              value=${vendor}
              onChange=${setVendor}
              disabled=${isEdit}
              options=${VENDORS.map(value => ({ value, label: value }))}
            />
          </div>
          <${FieldEditor}
            field="model"
            mode=${fieldModes.model}
            value=${fieldValues.model}
            onMode=${value => changeMode('model', value)}
            onValue=${value => changeValue('model', value)}
          />
          ${vendor === 'codex' && html`
            <${FieldEditor}
              field="reasoning_effort"
              mode=${fieldModes.reasoning_effort}
              value=${fieldValues.reasoning_effort}
              onMode=${value => changeMode('reasoning_effort', value)}
              onValue=${value => changeValue('reasoning_effort', value)}
            />
            <${FieldEditor}
              field="tier"
              mode=${fieldModes.tier}
              value=${fieldValues.tier}
              onMode=${value => changeMode('tier', value)}
              onValue=${value => changeValue('tier', value)}
            />
          `}
        </div>
        <div class="modal-footer">
          <button type="button" class="ghost" data-role="model-policy-editor-cancel" onClick=${onClose} disabled=${saving}>${COMMON_ACTIONS.cancel}</button>
          <button type="submit" class="primary" data-role="model-policy-save" disabled=${saving}>${saving ? COMMON_ACTIONS.saving : COMMON_ACTIONS.save}</button>
        </div>
      </form>
    <//>
  `;
}

function DeletePolicyModal({ policy, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (policy) setDeleting(false);
  }, [policy]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetch(policyPath(policy), { method: 'DELETE' });
      addToast('모델 정책을 삭제했습니다.', 'success');
      await onDeleted();
      onClose();
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  return html`
    <${Modal}
      open=${!!policy}
      onClose=${onClose}
      labelledBy="model-policy-delete-title"
      maxWidth="440px"
      backdropClose=${!deleting}
      escapeClose=${!deleting}
    >
      <div class="modal-header">
        <h2 class="modal-title" id="model-policy-delete-title">모델 정책 삭제</h2>
      </div>
      <div class="modal-body">
        <p>이 범위와 공급자의 정책을 삭제하면 상위 범위의 값을 다시 상속합니다.</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="ghost" onClick=${onClose} disabled=${deleting}>${COMMON_ACTIONS.cancel}</button>
        <button type="button" class="danger" data-role="model-policy-delete-confirm" onClick=${handleDelete} disabled=${deleting}>${deleting ? '삭제 중...' : COMMON_ACTIONS.delete}</button>
      </div>
    <//>
  `;
}

function EffectivePreview({ projects }) {
  const [layer, setLayer] = useState('top');
  const [vendor, setVendor] = useState('codex');
  const [projectId, setProjectId] = useState((projects || [])[0]?.id || '');
  const [effective, setEffective] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const available = projects || [];
    if (available.length > 0 && !available.some(project => project.id === projectId)) {
      setProjectId(available[0].id);
    }
  }, [projects]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      let path = `/api/model-policies/effective?layer=${encodeURIComponent(layer)}&vendor=${encodeURIComponent(vendor)}`;
      if (layer === 'operator' && projectId) {
        path += `&projectId=${encodeURIComponent(projectId)}`;
      }
      try {
        const result = await apiFetch(path);
        if (!cancelled) setEffective(result.effective || null);
      } catch (err) {
        if (!cancelled) {
          setEffective(null);
          addToast(err.message, 'error');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [layer, vendor, projectId]);

  const rows = [
    ['model', effective?.model],
    ['effort', effective?.effort],
    ['tier', effective?.tier],
  ];

  return html`
    <section class="skill-pack-card static" data-role="effective-preview" aria-labelledby="model-policy-effective-title">
      <div class="skill-pack-card-header">
        <h2 class="skill-pack-name" id="model-policy-effective-title" style=${{ margin: 0 }}>Effective 미리보기</h2>
      </div>
      <div style=${{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <div style=${{ flex: '1 1 160px' }}>
          <label class="form-label" for="model-policy-preview-layer">레이어</label>
          <${Dropdown}
            id="model-policy-preview-layer"
            className="dropdown-field"
            value=${layer}
            onChange=${setLayer}
            options=${[
              { value: 'top', label: 'top' },
              { value: 'operator', label: 'operator' },
            ]}
          />
        </div>
        <div style=${{ flex: '1 1 160px' }}>
          <label class="form-label" for="model-policy-preview-vendor">공급자</label>
          <${Dropdown}
            id="model-policy-preview-vendor"
            className="dropdown-field"
            value=${vendor}
            onChange=${setVendor}
            options=${VENDORS.map(value => ({ value, label: value }))}
          />
        </div>
        ${layer === 'operator' && html`
          <div style=${{ flex: '1 1 200px' }}>
            <label class="form-label" for="model-policy-preview-project">프로젝트 폴더</label>
            <${Dropdown}
              id="model-policy-preview-project"
              className="dropdown-field"
              value=${projectId}
              onChange=${setProjectId}
              options=${(projects || []).length === 0
                ? [{ value: '', label: '선택 가능한 프로젝트 폴더 없음' }]
                : (projects || []).map(project => ({ value: project.id, label: project.name || project.id }))}
            />
          </div>
        `}
      </div>
      <div aria-live="polite" style=${{ display: 'grid', gap: '6px', marginTop: '4px' }}>
        ${loading && html`<div class="small">${COMMON_ACTIONS.loading}</div>`}
        ${!loading && rows.map(([field, value]) => html`
          <div key=${field} data-role=${`effective-field-${field}`} style=${{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <strong style=${{ minWidth: '52px' }}>${field}</strong>
            <code>${value == null || value === '' ? 'CLI 기본값' : String(value)}</code>
            <span class="skill-pack-scope" data-role=${`effective-source-${field}`} data-source=${effective?.sources?.[field] || 'cli'}>
              ${effective?.sources?.[field] || 'cli'}
            </span>
          </div>
        `)}
      </div>
    </section>
  `;
}

function PolicyCard({ policy, projects, onEdit, onDelete }) {
  const fields = policy.vendor === 'claude'
    ? ['model']
    : ['model', 'reasoning_effort', 'tier'];

  return html`
    <article
      class="skill-pack-card static"
      key=${policyKey(policy)}
      data-role="model-policy-card"
      data-scope-type=${policy.scope_type}
      data-vendor=${policy.vendor}
    >
      <div class="skill-pack-card-header">
        <h3 class="skill-pack-name" style=${{ margin: 0 }}>${scopeTitle(policy, projects)}</h3>
        <span class="skill-pack-scope">${policy.vendor}</span>
      </div>
      <div class="small" style=${{ color: 'var(--text-muted)' }}>
        <code>${policy.scope_type}</code> · <code>${policy.scope_id}</code>
      </div>
      <div style=${{ display: 'grid', gap: '4px' }}>
        ${fields.map(field => html`
          <div key=${field} data-param=${field} class="small">
            <strong>${FIELD_LABELS[field]}</strong>: <code>${storedValue(policy.params || {}, field)}</code>
          </div>
        `)}
      </div>
      <div class="small" style=${{ color: 'var(--text-muted)' }}>revision ${policy.revision}</div>
      <div class="skill-pack-card-actions">
        <button type="button" class="ghost small" data-action="edit" onClick=${() => onEdit(policy)}>${COMMON_ACTIONS.edit}</button>
        <button type="button" class="ghost small" data-action="delete" onClick=${() => onDelete(policy)}>${COMMON_ACTIONS.delete}</button>
      </div>
    </article>
  `;
}

export function ModelPoliciesView({ projects = [] }) {
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const reload = async () => {
    setLoading(true);
    try {
      const result = await apiFetch('/api/model-policies');
      setPolicies(result.policies || []);
    } catch (err) {
      addToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const closeEditor = () => {
    setEditorOpen(false);
    setEditTarget(null);
  };

  return html`
    <div class="skill-packs-view" data-view="model-policies">
      <div class="skill-packs-header">
        <h1 class="skill-packs-title">모델 정책</h1>
        <button
          type="button"
          class="primary"
          data-role="new-model-policy"
          onClick=${() => { setEditTarget(null); setEditorOpen(true); }}
        >+ 새 정책</button>
      </div>
      <div style=${{ flex: 1, overflowY: 'auto', padding: '0 24px 24px' }}>
        <${EffectivePreview} projects=${projects} />
        <h2 class="skill-packs-title" style=${{ margin: '18px 0 10px' }}>저장된 정책</h2>
        ${loading && html`<${Loading} />`}
        ${!loading && policies.length === 0 && html`
          <${EmptyState}
            icon="⚙"
            text="저장된 모델 정책이 없습니다"
            sub="새 정책을 만들어 범위별 모델 설정을 지정하세요."
          />
        `}
        ${!loading && policies.length > 0 && html`
          <div class="skill-packs-list" style=${{ padding: 0, overflow: 'visible' }}>
            ${policies.map(policy => html`
              <${PolicyCard}
                key=${policyKey(policy)}
                policy=${policy}
                projects=${projects}
                onEdit=${target => { setEditTarget(target); setEditorOpen(true); }}
                onDelete=${setDeleteTarget}
              />
            `)}
          </div>
        `}
      </div>
      <${PolicyEditor}
        open=${editorOpen}
        policy=${editTarget}
        projects=${projects}
        onClose=${closeEditor}
        onSaved=${reload}
        onConflict=${async () => { closeEditor(); await reload(); }}
      />
      <${DeletePolicyModal}
        policy=${deleteTarget}
        onClose=${() => setDeleteTarget(null)}
        onDeleted=${reload}
      />
    </div>
  `;
}
