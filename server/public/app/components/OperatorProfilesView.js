// OperatorProfilesView — Operator Profile management (PF-2 UI).
// List + create/edit modal + delete confirm. Mirrors PresetsView conventions.
// Backend: GET /api/operator/profiles → { profiles: [...] }
//          POST /api/operator/profiles → { profile }
//          PATCH /api/operator/profiles/:id → { profile }
//          DELETE /api/operator/profiles/:id → 200 { profile }

import { h } from '../../vendor/preact.module.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { COMMON_ACTIONS, OPERATOR_PROFILES_LABELS } from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';

// Single capability available to folder-less specialists in PF-2. (Korean-first
// label; the programmatic key is shown as a secondary <code> identifier. Other
// valid caps set via API are preserved on save — see handleSave merge.)
const AVAILABLE_CAPABILITIES = [
  {
    key: 'registry_metadata_search',
    label: '내부 메타데이터 검색',
    hint: '이 권한을 켜면 스페셜리스트가 내부 레지스트리·에이전트 프로필 메타데이터를 조회할 수 있습니다.',
  },
];

function Loading() {
  return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProfileModal — create / edit
// ─────────────────────────────────────────────────────────────────────────────

function ProfileModal({ open, onClose, profile, onSaved }) {
  const [name, setName]               = useState('');
  const [description, setDescription] = useState('');
  const [persona, setPersona]         = useState('');
  const [capChecked, setCapChecked]   = useState(false);
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    if (!open) return;
    if (profile) {
      setName(profile.name || '');
      setDescription(profile.description || '');
      setPersona(profile.persona || '');
      const caps = Array.isArray(profile.capabilities) ? profile.capabilities : [];
      setCapChecked(caps.includes('registry_metadata_search'));
    } else {
      setName('');
      setDescription('');
      setPersona('');
      setCapChecked(false);
    }
  }, [open, profile]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Codex review BLOCKER: the UI only represents registry_metadata_search, but
      // a profile may carry other valid caps (set via API). MERGE — preserve any
      // caps the UI doesn't manage, and toggle only registry_metadata_search — so
      // an edit never silently strips API-set capabilities.
      const existingCaps = (profile && Array.isArray(profile.capabilities)) ? profile.capabilities : [];
      const otherCaps = existingCaps.filter((c) => c !== 'registry_metadata_search');
      const capabilities = capChecked ? [...otherCaps, 'registry_metadata_search'] : otherCaps;
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        persona: persona.trim() || null,
        capabilities,
      };
      if (profile) {
        await apiFetchWithToast(`/api/operator/profiles/${profile.id}`, {
          method: 'PATCH', body: JSON.stringify(body),
        });
        addToast(OPERATOR_PROFILES_LABELS.toastUpdated, 'success');
      } else {
        await apiFetchWithToast('/api/operator/profiles', {
          method: 'POST', body: JSON.stringify(body),
        });
        addToast(OPERATOR_PROFILES_LABELS.toastCreated, 'success');
      }
      onSaved();
      onClose();
    } catch { /* toast already shown by apiFetchWithToast */ }
    setSaving(false);
  };

  return html`
    <${Modal} open=${open} onClose=${onClose} labelledBy="op-profile-modal-title" maxWidth="560px">
      <div class="modal-header">
        <h2 class="modal-title" id="op-profile-modal-title">
          ${profile ? OPERATOR_PROFILES_LABELS.modalEdit : OPERATOR_PROFILES_LABELS.modalNew}
        </h2>
        <button type="button" class="modal-close" onClick=${onClose} aria-label="닫기"><span aria-hidden="true">✕</span></button>
      </div>
      <div class="modal-body">
        <div class="form-field">
          <label class="form-label" for="op-profile-name">${OPERATOR_PROFILES_LABELS.fieldName}</label>
          <input
            id="op-profile-name"
            class="form-input"
            type="text"
            value=${name}
            onInput=${e => setName(e.target.value)}
            placeholder=${OPERATOR_PROFILES_LABELS.namePlaceholder}
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="op-profile-description">${OPERATOR_PROFILES_LABELS.fieldDescription}</label>
          <input
            id="op-profile-description"
            class="form-input"
            type="text"
            value=${description}
            onInput=${e => setDescription(e.target.value)}
            placeholder=${OPERATOR_PROFILES_LABELS.descriptionPlaceholder}
          />
        </div>

        <div class="form-field">
          <label class="form-label" for="op-profile-persona">${OPERATOR_PROFILES_LABELS.fieldPersona}</label>
          <textarea
            id="op-profile-persona"
            class="form-textarea"
            rows="5"
            value=${persona}
            onInput=${e => setPersona(e.target.value)}
            placeholder=${OPERATOR_PROFILES_LABELS.personaPlaceholder}
          ></textarea>
        </div>

        <fieldset class="form-field">
          <legend class="form-label">${OPERATOR_PROFILES_LABELS.fieldCapabilities}</legend>
          ${AVAILABLE_CAPABILITIES.map(cap => html`
            <label key=${cap.key} class="operator-profile-cap-label" for=${'op-profile-cap-' + cap.key}>
              <input
                id=${'op-profile-cap-' + cap.key}
                type="checkbox"
                checked=${capChecked}
                onChange=${e => setCapChecked(e.target.checked)}
              />
              <span>${cap.label} <code class="operator-profile-cap-key">${cap.key}</code></span>
            </label>
            ${cap.hint && html`<p class="operator-profile-cap-hint">${cap.hint}</p>`}
          `)}
        </fieldset>
      </div>
      <div class="modal-footer">
        <button type="button" class="ghost" onClick=${onClose}>${COMMON_ACTIONS.cancel}</button>
        <button
          type="submit"
          class="primary"
          onClick=${handleSave}
          disabled=${saving || !name.trim()}
          aria-busy=${saving}
        >
          ${saving ? COMMON_ACTIONS.saving : profile ? COMMON_ACTIONS.update : COMMON_ACTIONS.create}
        </button>
      </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// DeleteConfirm
// ─────────────────────────────────────────────────────────────────────────────

function DeleteConfirm({ open, profile, onClose, onConfirm }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiFetchWithToast(`/api/operator/profiles/${profile.id}`, { method: 'DELETE' });
      addToast(OPERATOR_PROFILES_LABELS.toastDeleted, 'success');
      onConfirm();
    } catch { /* toast already shown */ }
    setDeleting(false);
  };

  return html`
    <${Modal} open=${open && !!profile} onClose=${onClose} labelledBy="op-profile-delete-title" maxWidth="420px">
      <div class="modal-header">
        <h2 class="modal-title" id="op-profile-delete-title">${OPERATOR_PROFILES_LABELS.deleteTitle}</h2>
      </div>
      <div class="modal-body">
        <p><strong>${profile?.name}</strong>${OPERATOR_PROFILES_LABELS.deleteBodySuffix}</p>
      </div>
      <div class="modal-footer">
        <button type="button" class="ghost" onClick=${onClose}>${COMMON_ACTIONS.cancel}</button>
        <button type="button" class="danger" onClick=${handleDelete} disabled=${deleting}>
          ${deleting ? COMMON_ACTIONS.deleting : COMMON_ACTIONS.delete}
        </button>
      </div>
    </Modal>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// OperatorProfilesView — list
// ─────────────────────────────────────────────────────────────────────────────

export function OperatorProfilesView() {
  const [loading, setLoading]         = useState(true);
  const [profiles, setProfiles]       = useState([]);
  const [editTarget, setEditTarget]   = useState(null);
  const [modalOpen, setModalOpen]     = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  // Stale-guard: if a newer request lands, discard the older response.
  const reqSeqRef = useRef(0);

  const reload = async () => {
    setLoading(true);
    const seq = ++reqSeqRef.current;
    try {
      const data = await apiFetch('/api/operator/profiles');
      if (seq !== reqSeqRef.current) return; // stale
      setProfiles(data.profiles || []);
    } catch (err) {
      if (seq !== reqSeqRef.current) return;
      addToast(err.message, 'error');
    }
    setLoading(false);
  };

  useEffect(() => { reload(); }, []);

  const openCreate = () => { setEditTarget(null); setModalOpen(true); };
  const openEdit   = (p) => { setEditTarget(p);   setModalOpen(true); };
  const closeModal = () => { setModalOpen(false); setEditTarget(null); };

  return html`
    <div class="page operator-profiles-page" data-view="operator-profiles">
      <div class="operator-profiles-header">
        <div>
          <h1 class="operator-profiles-title">${OPERATOR_PROFILES_LABELS.pageTitle}</h1>
          <p class="operator-profiles-description">${OPERATOR_PROFILES_LABELS.pageDescription}</p>
        </div>
        <button type="button" class="primary" onClick=${openCreate}>
          + ${OPERATOR_PROFILES_LABELS.newProfile}
        </button>
      </div>

      ${loading && html`<${Loading} />`}

      ${!loading && profiles.length === 0 && html`
        <${EmptyState}
          icon="⊙"
          text=${OPERATOR_PROFILES_LABELS.emptyText}
          sub=${OPERATOR_PROFILES_LABELS.emptySub}
        />
      `}

      ${!loading && profiles.length > 0 && html`
        <div class="operator-profile-grid">
          ${profiles.map(p => {
            const caps = Array.isArray(p.capabilities) ? p.capabilities : [];
            const personaPreview = (p.persona || '').slice(0, 120);
            return html`
              <div class="operator-profile-card" key=${p.id}>
                <div class="operator-profile-card-header">
                  <h3 class="operator-profile-name">${p.name}</h3>
                </div>
                ${p.description && html`
                  <p class="operator-profile-desc">${p.description}</p>
                `}
                ${personaPreview && html`
                  <p class="operator-profile-persona">${personaPreview}${p.persona.length > 120 ? '…' : ''}</p>
                `}
                ${caps.length > 0 && html`
                  <div class="operator-profile-caps">
                    ${caps.map(c => html`
                      <span key=${c} class="operator-profile-cap">${c}</span>
                    `)}
                  </div>
                `}
                <div class="operator-profile-card-actions">
                  <button type="button" class="ghost small" onClick=${() => openEdit(p)}>
                    ${COMMON_ACTIONS.edit}
                  </button>
                  <button type="button" class="ghost small" onClick=${() => setDeleteTarget(p)}>
                    ${COMMON_ACTIONS.delete}
                  </button>
                </div>
              </div>
            `;
          })}
        </div>
      `}

      <${ProfileModal}
        open=${modalOpen}
        profile=${editTarget}
        onClose=${closeModal}
        onSaved=${reload}
      />
      <${DeleteConfirm}
        open=${!!deleteTarget}
        profile=${deleteTarget}
        onClose=${() => setDeleteTarget(null)}
        onConfirm=${() => { setDeleteTarget(null); reload(); }}
      />
    </div>
  `;
}
