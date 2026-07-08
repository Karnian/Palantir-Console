// OperatorsView — roster slice.
// Shows the current Top manager, project-bound live Operators, and folder-less
// available Operator profiles.

import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { sseBroker } from '../lib/hooks/sse.js';
import { addToast, apiFetchWithToast } from '../lib/toast.js';
import { parseProjectConversationId } from '../lib/conversationId.js';
import {
  COMMON_ACTIONS,
  OPERATOR_ROSTER_LABELS,
  RUN_STATUS_LABELS,
  statusLabel,
} from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { Modal } from './Modal.js';
import { SpecialistInvokePanel } from './SpecialistInvokePanel.js';

// Contract: count ONLY 'running' worker runs (Codex review — 'active' was too broad;
// needs_input is waiting, not running). count-only, no run list (board 복제 방지).
const ACTIVE_WORKER_STATUSES = new Set(['running']);
const ROSTER_LIVE_CHANNELS = ['manager:started', 'manager:stopped', 'run:status', 'run:completed'];
const ROSTER_REFRESH_DEBOUNCE_MS = 400;
const OPERATOR_CONVERSATION_PREFIX = 'operator:';
const OPERATOR_INSTANCE_PREFIX = 'oi_';

function Loading() {
  return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function instanceConversationId(id) {
  if (typeof id !== 'string') return null;
  if (!id.startsWith(OPERATOR_CONVERSATION_PREFIX)) return null;
  const instanceId = id.slice(OPERATOR_CONVERSATION_PREFIX.length);
  return instanceId.startsWith(OPERATOR_INSTANCE_PREFIX) ? instanceId : null;
}

function adapterName(run) {
  return run?.manager_adapter || OPERATOR_ROSTER_LABELS.unknownValue;
}

function nodeName(run) {
  return run?.node_id || OPERATOR_ROSTER_LABELS.localNode;
}

function runStatus(run) {
  return statusLabel(RUN_STATUS_LABELS, run?.status) || OPERATOR_ROSTER_LABELS.unknownValue;
}

function shortRunId(id) {
  const s = String(id || '');
  if (!s) return OPERATOR_ROSTER_LABELS.unknownValue;
  return s.length > 12 ? `${s.slice(0, 12)}...` : s;
}

function parsedProjectId(entry) {
  if (entry?.primaryProjectId) return entry.primaryProjectId;
  const fromEntry = parseProjectConversationId(entry?.conversationId);
  if (fromEntry) return fromEntry.projectId;
  // W-P5 canonical flip: snapshot conversationId is instance-form (operator:oi_*),
  // which the project parser deliberately rejects — use the server-provided
  // legacy alias to keep the codebase join working.
  const fromLegacy = parseProjectConversationId(entry?.legacyConversationId);
  if (fromLegacy) return fromLegacy.projectId;
  const fromRun = parseProjectConversationId(entry?.run?.conversation_id);
  return fromRun ? fromRun.projectId : null;
}

function primaryRef(instance) {
  return arrayValue(instance?.refs).find((ref) => ref?.role === 'primary') || null;
}

function refProjectName(ref, projectsById) {
  const projectId = ref?.project_id;
  const project = projectId ? projectsById.get(String(projectId)) : null;
  return ref?.project?.name || project?.name || projectId || OPERATOR_ROSTER_LABELS.unknownProject;
}

function instanceLabel(instance) {
  const id = String(instance?.id || '');
  return id.length > 12 ? `${id.slice(0, 12)}...` : id || OPERATOR_ROSTER_LABELS.unknownValue;
}

function refRoleLabel(role) {
  return role === 'primary'
    ? OPERATOR_ROSTER_LABELS.primaryRefRole
    : OPERATOR_ROSTER_LABELS.referenceRefRole;
}

function capabilitySummary(profile) {
  const caps = arrayValue(profile?.capabilities).filter(Boolean);
  return caps.length ? caps.join(', ') : OPERATOR_ROSTER_LABELS.capabilitiesEmpty;
}

function personaSummary(profile) {
  const text = String(profile?.persona || profile?.description || '').trim();
  return text || OPERATOR_ROSTER_LABELS.personaEmpty;
}

function countActiveWorkers({ projectId, runs, taskById }) {
  if (!projectId) return 0;
  return arrayValue(runs).filter((run) => {
    if (Number(run?.is_manager || 0) === 1) return false;
    if (!ACTIVE_WORKER_STATUSES.has(run?.status)) return false;
    const runProjectId = run?.project_id
      || (run?.task_id ? taskById.get(run.task_id)?.project_id : null);
    return String(runProjectId || '') === String(projectId);
  }).length;
}

function resolveLiveInstance(entry, { instancesById, primaryInstanceByProject }) {
  const directId = entry?.instanceId
    || entry?.run?.operator_instance_id
    || instanceConversationId(entry?.conversationId)
    || instanceConversationId(entry?.run?.conversation_id);
  if (directId && instancesById.has(String(directId))) {
    return instancesById.get(String(directId));
  }
  const projectId = parsedProjectId(entry);
  if (projectId && primaryInstanceByProject.has(String(projectId))) {
    return primaryInstanceByProject.get(String(projectId));
  }
  return null;
}

function WatchListBadges({ instance, projectsById, onRemoveReference }) {
  const refs = arrayValue(instance?.refs);
  if (refs.length === 0) return null;

  return html`
    <div class="operator-watch-list" data-role="operator-watch-list" aria-label=${OPERATOR_ROSTER_LABELS.watchListLabel}>
      ${refs.map((ref) => {
        const isPrimary = ref.role === 'primary';
        const projectName = refProjectName(ref, projectsById);
        return html`
          <span
            key=${`${ref.project_id}:${ref.role}`}
            class=${`operator-watch-badge ${isPrimary ? 'primary' : 'reference'}`}
            data-role=${isPrimary ? 'operator-watch-ref-primary' : 'operator-watch-ref-reference'}
          >
            <span class="operator-watch-role">${refRoleLabel(ref.role)}</span>
            <span class="operator-watch-project">${projectName}</span>
            ${!isPrimary && html`
              <button
                type="button"
                class="operator-watch-remove"
                data-role="operator-watch-ref-remove"
                aria-label=${`${projectName} ${OPERATOR_ROSTER_LABELS.removeReference}`}
                onClick=${() => onRemoveReference(instance, ref)}
              >×</button>
            `}
          </span>
        `;
      })}
    </div>
  `;
}

function MasterCard({ top }) {
  const run = top?.run || null;
  if (!run) {
    return html`
      <${EmptyState}
        icon="✦"
        text=${OPERATOR_ROSTER_LABELS.masterEmptyText}
        sub=${OPERATOR_ROSTER_LABELS.masterEmptySub}
      />
    `;
  }

  return html`
    <a class="operator-profile-card operator-roster-card" data-role="operator-roster-master-card" href="#manager">
      <div class="operator-profile-card-header">
        <h3 class="operator-profile-name">${OPERATOR_ROSTER_LABELS.masterCardTitle}</h3>
        <span class="task-badge project">${OPERATOR_ROSTER_LABELS.masterTopBadge}</span>
      </div>
      <div class="operator-roster-meta-grid">
        <span>${OPERATOR_ROSTER_LABELS.adapterLabel}</span>
        <strong>${adapterName(run)}</strong>
        <span>${OPERATOR_ROSTER_LABELS.statusLabel}</span>
        <strong>${runStatus(run)}</strong>
      </div>
      <div class="operator-roster-footer">
        <span class="operator-roster-run-id">${shortRunId(run.id)}</span>
      </div>
    </a>
  `;
}

function LiveOperatorCard({
  entry,
  instance,
  operatorInstancesKnown,
  projectsById,
  runs,
  taskById,
  onOpenRefs,
  onRemoveReference,
}) {
  const run = entry?.run || {};
  const primary = primaryRef(instance);
  const projectId = parsedProjectId(entry) || primary?.project_id;
  const project = projectId ? projectsById.get(String(projectId)) : null;
  const projectName = primary
    ? refProjectName(primary, projectsById)
    : (project?.name || run.project_name || projectId || OPERATOR_ROSTER_LABELS.unknownProject);
  const workerCount = countActiveWorkers({ projectId, runs, taskById });
  const projectHref = projectId ? `#operator/codebases/${encodeURIComponent(String(projectId))}` : '#operator/codebases';
  const conversationHref = projectId ? `#manager/operator/${encodeURIComponent(String(projectId))}` : '#manager';

  return html`
    <article class="operator-profile-card operator-roster-card operator-roster-live-card" data-role="operator-roster-live-card">
      <div class="operator-profile-card-header">
        <h3 class="operator-profile-name">${projectName}</h3>
        <span class="task-badge project">${OPERATOR_ROSTER_LABELS.liveBinding}</span>
      </div>
      <div class="operator-roster-badges">
        <span class="skill-badge skill-badge-ok">${OPERATOR_ROSTER_LABELS.liveMode}</span>
        <span class="skill-badge skill-badge-ok">${OPERATOR_ROSTER_LABELS.liveLifecycle}</span>
      </div>
      ${operatorInstancesKnown && html`
        <${WatchListBadges}
          instance=${instance}
          projectsById=${projectsById}
          onRemoveReference=${onRemoveReference}
        />
      `}
      ${!operatorInstancesKnown && html`
        <p class="form-hint" data-role="operator-watch-list-unavailable">
          ${OPERATOR_ROSTER_LABELS.watchListUnavailable}
        </p>
      `}
      <div class="operator-roster-meta-grid">
        <span>${OPERATOR_ROSTER_LABELS.adapterLabel}</span>
        <strong>${adapterName(run)}</strong>
        ${instance && html`
          <span>${OPERATOR_ROSTER_LABELS.instanceLabel}</span>
          <strong>${instanceLabel(instance)}</strong>
        `}
        <span>${OPERATOR_ROSTER_LABELS.nodeLabel}</span>
        <strong>${nodeName(run)}</strong>
        <span>${OPERATOR_ROSTER_LABELS.activeWorkerRuns}</span>
        <strong data-role="operator-roster-worker-count">${workerCount}</strong>
      </div>
      <div class="operator-roster-footer">
        <span class="operator-roster-run-id">${shortRunId(run.id)}</span>
        <span class="operator-roster-actions">
          <a
            class="ghost small"
            data-role="operator-roster-live-primary-link"
            href=${conversationHref}
          >${OPERATOR_ROSTER_LABELS.openConversation}</a>
          <a
            class="ghost small"
            data-role="operator-roster-live-project-link"
            href=${projectHref}
          >${OPERATOR_ROSTER_LABELS.openProject}</a>
          ${operatorInstancesKnown && instance && html`
            <button
              type="button"
              class="ghost small"
              data-role="operator-roster-add-reference-button"
              aria-haspopup="dialog"
              aria-label=${`${projectName} ${OPERATOR_ROSTER_LABELS.addReference}`}
              onClick=${() => onOpenRefs(instance)}
            >${OPERATOR_ROSTER_LABELS.addReference}</button>
          `}
        </span>
      </div>
    </article>
  `;
}

function AvailableOperatorCard({ profile, onInvoke }) {
  return html`
    <article
      class="operator-profile-card operator-roster-card operator-roster-available-card"
      data-role="operator-roster-available-card"
    >
      <div class="operator-profile-card-header">
        <h3 class="operator-profile-name">${profile.name}</h3>
        <span class="task-badge project">${OPERATOR_ROSTER_LABELS.availableBinding}</span>
      </div>
      <p class="operator-profile-persona">${personaSummary(profile)}</p>
      <div class="operator-roster-badges">
        <span class="skill-badge skill-badge-ok">${OPERATOR_ROSTER_LABELS.availableMode}</span>
        <span class="skill-badge skill-badge-ok">${OPERATOR_ROSTER_LABELS.availableLifecycle}</span>
        <span class="skill-badge skill-badge-ok">${OPERATOR_ROSTER_LABELS.readyToInvoke}</span>
      </div>
      <div class="operator-roster-capability-summary">
        <span>${OPERATOR_ROSTER_LABELS.capabilitySummaryLabel}</span>
        <strong>${capabilitySummary(profile)}</strong>
      </div>
      <div class="operator-roster-footer">
        <span class="operator-roster-actions">
          <button
            type="button"
            class="ghost small"
            data-role="operator-roster-available-invoke-button"
            aria-haspopup="dialog"
            aria-label=${`${profile.name} ${OPERATOR_ROSTER_LABELS.invokeOperator}`}
            onClick=${() => onInvoke(profile)}
          >${OPERATOR_ROSTER_LABELS.invokeOperator}</button>
          <a
            class="ghost small"
            data-role="operator-roster-available-profile-link"
            href="#operator/profiles"
            aria-label=${`${profile.name} ${OPERATOR_ROSTER_LABELS.openProfile}`}
          >${OPERATOR_ROSTER_LABELS.openProfile}</a>
        </span>
      </div>
    </article>
  `;
}

export function OperatorsView({ runs = [], projects = [], tasks = [] }) {
  const [managerStatus, setManagerStatus] = useState(null);
  const [instances, setInstances] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [invokeProfile, setInvokeProfile] = useState(null);
  const [refsEditorInstance, setRefsEditorInstance] = useState(null);
  const [selectedRefProjectId, setSelectedRefProjectId] = useState('');
  const [refsSaving, setRefsSaving] = useState(false);
  const managerReqSeqRef = useRef(0);
  const instancesReqSeqRef = useRef(0);
  const profilesReqSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    let refreshTimer = null;

    const fetchManagerStatus = ({ initial = false } = {}) => {
      const seq = ++managerReqSeqRef.current;
      if (initial) setLoadingStatus(true);
      return apiFetch('/api/manager/status')
      .then((data) => {
        if (!alive || seq !== managerReqSeqRef.current) return;
        setManagerStatus(data || null);
      })
      .catch((err) => {
        if (!alive || seq !== managerReqSeqRef.current) return;
        if (initial) {
          setManagerStatus(null);
          addToast(err.message, 'error');
        }
      })
      .finally(() => {
        if (alive && seq === managerReqSeqRef.current) setLoadingStatus(false);
      });
    };

    const fetchOperatorInstances = () => {
      const seq = ++instancesReqSeqRef.current;
      return apiFetch('/api/operator-instances')
      .then((data) => {
        if (!alive || seq !== instancesReqSeqRef.current) return;
        setInstances(arrayValue(data?.instances));
      })
      .catch((err) => {
        if (!alive || seq !== instancesReqSeqRef.current) return;
        setInstances('unknown');
      });
    };

    const fetchProfiles = () => {
      const seq = ++profilesReqSeqRef.current;
      setLoadingProfiles(true);
      return apiFetch('/api/operator/profiles')
      .then((data) => {
        if (!alive || seq !== profilesReqSeqRef.current) return;
        setProfiles(arrayValue(data?.profiles));
      })
      .catch((err) => {
        if (!alive || seq !== profilesReqSeqRef.current) return;
        setProfiles([]);
        addToast(err.message, 'error');
      })
      .finally(() => {
        if (alive && seq === profilesReqSeqRef.current) setLoadingProfiles(false);
      });
    };

    const scheduleLiveRefresh = () => {
      managerReqSeqRef.current += 1;
      instancesReqSeqRef.current += 1;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        fetchManagerStatus();
        fetchOperatorInstances();
      }, ROSTER_REFRESH_DEBOUNCE_MS);
    };

    fetchManagerStatus({ initial: true });
    fetchOperatorInstances();
    fetchProfiles();

    const broker = typeof sseBroker !== 'undefined' ? sseBroker : null;
    const unsubscribes = broker && typeof broker.subscribe === 'function'
      ? ROSTER_LIVE_CHANNELS.map((channel) => broker.subscribe(channel, scheduleLiveRefresh))
      : [];

    return () => {
      alive = false;
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribes.forEach((unsubscribe) => {
        if (typeof unsubscribe === 'function') unsubscribe();
      });
    };
  }, []);

  const projectsById = useMemo(() => {
    const map = new Map();
    for (const project of arrayValue(projects)) {
      if (project?.id) map.set(String(project.id), project);
    }
    return map;
  }, [projects]);

  const taskById = useMemo(() => {
    const map = new Map();
    for (const task of arrayValue(tasks)) {
      if (task?.id) map.set(task.id, task);
    }
    return map;
  }, [tasks]);

  const operatorInstancesKnown = instances !== 'unknown';

  const instancesById = useMemo(() => {
    const map = new Map();
    if (!operatorInstancesKnown) return map;
    for (const instance of arrayValue(instances)) {
      if (instance?.id) map.set(String(instance.id), instance);
    }
    return map;
  }, [instances, operatorInstancesKnown]);

  const primaryInstanceByProject = useMemo(() => {
    const map = new Map();
    if (!operatorInstancesKnown) return map;
    for (const instance of arrayValue(instances)) {
      const primary = primaryRef(instance);
      if (primary?.project_id) map.set(String(primary.project_id), instance);
    }
    return map;
  }, [instances, operatorInstancesKnown]);

  const refreshOperatorInstances = async () => {
    const seq = ++instancesReqSeqRef.current;
    try {
      const data = await apiFetch('/api/operator-instances');
      if (seq !== instancesReqSeqRef.current) return;
      setInstances(arrayValue(data?.instances));
    } catch (err) {
      if (seq !== instancesReqSeqRef.current) return;
      setInstances('unknown');
    }
  };

  const openRefsEditor = (instance) => {
    setRefsEditorInstance(instance);
    const existingIds = new Set(arrayValue(instance?.refs).map((ref) => String(ref.project_id)));
    const firstAvailable = arrayValue(projects).find((project) => project?.id && !existingIds.has(String(project.id)));
    setSelectedRefProjectId(firstAvailable?.id || '');
  };

  const closeRefsEditor = () => {
    setRefsEditorInstance(null);
    setSelectedRefProjectId('');
    setRefsSaving(false);
  };

  const addReference = async () => {
    if (!refsEditorInstance?.id || !selectedRefProjectId) return;
    setRefsSaving(true);
    try {
      await apiFetchWithToast(`/api/operator-instances/${encodeURIComponent(refsEditorInstance.id)}/refs`, {
        method: 'POST',
        body: JSON.stringify({
          project_id: selectedRefProjectId,
          role: 'reference',
        }),
      });
      await refreshOperatorInstances();
      closeRefsEditor();
    } catch (err) {
      // apiFetchWithToast owns the error toast.
      setRefsSaving(false);
    }
  };

  const removeReference = async (instance, ref) => {
    if (!instance?.id || !ref?.project_id || ref.role === 'primary') return;
    try {
      await apiFetchWithToast(
        `/api/operator-instances/${encodeURIComponent(instance.id)}/refs/${encodeURIComponent(ref.project_id)}`,
        { method: 'DELETE' },
      );
      await refreshOperatorInstances();
    } catch (err) {
      // apiFetchWithToast owns the error toast.
    }
  };

  const top = managerStatus?.top || (managerStatus?.run
    ? { conversationId: 'top', run: managerStatus.run }
    : null);
  const pms = arrayValue(managerStatus?.pms);
  const invokeModalTitleId = 'operator-roster-specialist-invoke-title';
  const refsModalTitleId = 'operator-roster-refs-title';
  const refsEditorLatest = refsEditorInstance?.id ? instancesById.get(String(refsEditorInstance.id)) || refsEditorInstance : null;
  const refsEditorExistingProjectIds = new Set(arrayValue(refsEditorLatest?.refs).map((ref) => String(ref.project_id)));
  const refsEditorAvailableProjects = arrayValue(projects)
    .filter((project) => project?.id && !refsEditorExistingProjectIds.has(String(project.id)));

  return html`
    <div
      class="page operator-roster-page"
      data-view="operator-roster"
      data-operator-instances-state=${operatorInstancesKnown ? 'ready' : 'unknown'}
      tabindex="0"
      role="region"
      aria-label=${OPERATOR_ROSTER_LABELS.pageTitle}
    >
      <div class="operator-profiles-header">
        <div>
          <h1 class="operator-profiles-title">${OPERATOR_ROSTER_LABELS.pageTitle}</h1>
          <p class="operator-profiles-description">${OPERATOR_ROSTER_LABELS.pageDescription}</p>
        </div>
      </div>

      <section class="operator-roster-section" data-role="operator-roster-master-section" aria-labelledby="operator-roster-master-title">
        <div class="operator-roster-section-header">
          <h2 id="operator-roster-master-title">${OPERATOR_ROSTER_LABELS.masterTitle}</h2>
        </div>
        ${loadingStatus
          ? html`<${Loading} />`
          : html`<div class="operator-roster-grid single"><${MasterCard} top=${top} /></div>`}
      </section>

      <section class="operator-roster-section" data-role="operator-roster-live-section" aria-labelledby="operator-roster-live-title">
        <div class="operator-roster-section-header">
          <h2 id="operator-roster-live-title">${OPERATOR_ROSTER_LABELS.liveTitle}</h2>
        </div>
        ${loadingStatus && html`<${Loading} />`}
        ${!loadingStatus && pms.length === 0 && html`
          <${EmptyState}
            icon="✸"
            text=${OPERATOR_ROSTER_LABELS.liveEmptyText}
            sub=${OPERATOR_ROSTER_LABELS.liveEmptySub}
          />
        `}
        ${!loadingStatus && pms.length > 0 && html`
          <div class="operator-roster-grid">
            ${pms.map((entry) => html`
              <${LiveOperatorCard}
                key=${entry.conversationId || entry.run?.id}
                entry=${entry}
                instance=${resolveLiveInstance(entry, { instancesById, primaryInstanceByProject })}
                operatorInstancesKnown=${operatorInstancesKnown}
                projectsById=${projectsById}
                runs=${runs}
                taskById=${taskById}
                onOpenRefs=${openRefsEditor}
                onRemoveReference=${removeReference}
              />
            `)}
          </div>
        `}
      </section>

      <section class="operator-roster-section" data-role="operator-roster-available-section" aria-labelledby="operator-roster-available-title">
        <div class="operator-roster-section-header">
          <h2 id="operator-roster-available-title">${OPERATOR_ROSTER_LABELS.availableTitle}</h2>
        </div>
        ${loadingProfiles && html`<${Loading} />`}
        ${!loadingProfiles && profiles.length === 0 && html`
          <${EmptyState}
            icon="⊙"
            text=${OPERATOR_ROSTER_LABELS.availableEmptyText}
            sub=${OPERATOR_ROSTER_LABELS.availableEmptySub}
          />
        `}
        ${!loadingProfiles && profiles.length > 0 && html`
          <div class="operator-roster-grid">
            ${profiles.map((profile) => html`
              <${AvailableOperatorCard}
                key=${profile.id}
                profile=${profile}
                onInvoke=${setInvokeProfile}
              />
            `)}
          </div>
        `}
      </section>

      <${Modal}
        open=${Boolean(invokeProfile)}
        onClose=${() => setInvokeProfile(null)}
        labelledBy=${invokeModalTitleId}
        wide
      >
        <div class="modal-header">
          <div>
            <h2 id=${invokeModalTitleId}>${invokeProfile?.name || OPERATOR_ROSTER_LABELS.invokeOperator}</h2>
            <p class="modal-subtitle">${OPERATOR_ROSTER_LABELS.availableBinding} · ${OPERATOR_ROSTER_LABELS.availableLifecycle}</p>
          </div>
          <button
            type="button"
            class="ghost small"
            onClick=${() => setInvokeProfile(null)}
          >닫기</button>
        </div>
        <${SpecialistInvokePanel}
          initialProfileId=${invokeProfile?.id || ''}
          runs=${runs}
        />
      <//>

      <${Modal}
        open=${Boolean(refsEditorLatest)}
        onClose=${closeRefsEditor}
        labelledBy=${refsModalTitleId}
        maxWidth="520px"
      >
        <div class="modal-header">
          <div>
            <h2 class="modal-title" id=${refsModalTitleId}>${OPERATOR_ROSTER_LABELS.addReferenceTitle}</h2>
            <p class="modal-subtitle">${instanceLabel(refsEditorLatest)}</p>
          </div>
          <button
            type="button"
            class="ghost small"
            onClick=${closeRefsEditor}
          >${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="operator-roster-ref-project">${OPERATOR_ROSTER_LABELS.referenceProjectLabel}</label>
            <select
              id="operator-roster-ref-project"
              class="form-select"
              data-role="operator-roster-ref-project-select"
              value=${selectedRefProjectId}
              onChange=${(e) => setSelectedRefProjectId(e.target.value)}
              disabled=${refsEditorAvailableProjects.length === 0 || refsSaving}
            >
              ${refsEditorAvailableProjects.length === 0
                ? html`<option value="">${OPERATOR_ROSTER_LABELS.noReferenceProjects}</option>`
                : refsEditorAvailableProjects.map((project) => html`
                  <option key=${project.id} value=${project.id}>${project.name || project.id}</option>
                `)}
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button
            type="button"
            class="ghost"
            onClick=${closeRefsEditor}
            disabled=${refsSaving}
          >${COMMON_ACTIONS.cancel}</button>
          <button
            type="button"
            class="primary"
            data-role="operator-roster-ref-submit"
            onClick=${addReference}
            disabled=${refsSaving || !selectedRefProjectId}
            aria-busy=${refsSaving ? 'true' : 'false'}
          >${refsSaving ? COMMON_ACTIONS.saving : OPERATOR_ROSTER_LABELS.addReference}</button>
        </div>
      <//>
    </div>
  `;
}
