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
  NAV_LABELS,
  OPERATOR_ROSTER_LABELS,
  OPERATOR_SCHEDULER_LABELS,
  RUN_STATUS_LABELS,
  statusLabel,
} from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';
import { Dropdown } from './Dropdown.js';
import { Modal } from './Modal.js';
import { SpecialistInvokePanel } from './SpecialistInvokePanel.js';

// Contract: count ONLY 'running' worker runs (Codex review — 'active' was too broad;
// needs_input is waiting, not running). count-only, no run list (board 복제 방지).
const ACTIVE_WORKER_STATUSES = new Set(['running']);
const ROSTER_LIVE_CHANNELS = ['manager:started', 'manager:stopped', 'run:status', 'run:completed', 'operator:schedule'];
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

function projectPlacementLabel(project) {
  if (!project) return OPERATOR_ROSTER_LABELS.unknownProject;
  const name = project.name || project.id || OPERATOR_ROSTER_LABELS.unknownProject;
  const node = project.node_id || OPERATOR_ROSTER_LABELS.localNode;
  const folder = project.directory || project.repo_url || '';
  return [name, node, folder].filter(Boolean).join(' · ');
}

function instanceLabel(instance) {
  const id = String(instance?.id || '');
  return id.length > 12 ? `${id.slice(0, 12)}...` : id || OPERATOR_ROSTER_LABELS.unknownValue;
}

function operatorDisplayName(instance) {
  return instance?.display_name || instance?.profile_name || instanceLabel(instance);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
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
      <div class="operator-roster-master-empty" data-role="operator-roster-master-empty">
        <${EmptyState}
          icon="✦"
          text=${OPERATOR_ROSTER_LABELS.masterEmptyText}
          sub=${OPERATOR_ROSTER_LABELS.masterEmptySub}
        />
        <a
          class="ghost operator-roster-master-cta"
          data-role="operator-roster-master-cta"
          href="#manager"
        >${NAV_LABELS.manager} ${COMMON_ACTIONS.open}</a>
      </div>
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

function ConfiguredOperatorCard({ instance, liveEntry, projectsById, onOpenRefs, onRemoveReference, onOpenSchedules }) {
  const primary = primaryRef(instance);
  const live = Boolean(liveEntry?.run);
  return html`
    <article class="operator-profile-card operator-roster-card operator-configured-card" data-role="operator-configured-card">
      <div class="operator-profile-card-header">
        <h3 class="operator-profile-name">${operatorDisplayName(instance)}</h3>
        <span class=${`task-badge ${live ? 'active' : 'project'}`}>
          ${live ? OPERATOR_ROSTER_LABELS.liveStatus : OPERATOR_ROSTER_LABELS.idleStatus}
        </span>
      </div>
      <p class="form-hint">${instance.profile_name || instance.profile_id || OPERATOR_ROSTER_LABELS.unknownValue}</p>
      <${WatchListBadges}
        instance=${instance}
        projectsById=${projectsById}
        onRemoveReference=${onRemoveReference}
      />
      ${!primary && html`<p class="operator-schedule-warning">${OPERATOR_ROSTER_LABELS.noPrimaryFolder}</p>`}
      ${primary && html`
        <p class="form-hint operator-placement-detail">
          ${projectPlacementLabel(primary.project || projectsById.get(String(primary.project_id)))}
        </p>
      `}
      <div class="operator-roster-meta-grid">
        <span>${OPERATOR_ROSTER_LABELS.instanceLabel}</span>
        <strong>${instanceLabel(instance)}</strong>
        <span>${OPERATOR_ROSTER_LABELS.scheduleCountLabel}</span>
        <strong>${Number(instance.schedule_count) || 0}</strong>
        <span>${OPERATOR_ROSTER_LABELS.nextScheduleLabel}</span>
        <strong>${formatDateTime(instance.next_schedule_at)}</strong>
      </div>
      <div class="operator-roster-footer">
        <span class="operator-roster-actions">
          <button type="button" class="ghost small" data-role="operator-folder-mapping-button" onClick=${() => onOpenRefs(instance)}>
            ${OPERATOR_ROSTER_LABELS.folderMappings}
          </button>
          <button
            type="button"
            class="ghost small"
            data-role="operator-schedule-button"
            disabled=${!primary}
            title=${!primary ? OPERATOR_ROSTER_LABELS.noPrimaryFolder : ''}
            onClick=${() => onOpenSchedules(instance)}
          >${OPERATOR_ROSTER_LABELS.scheduleAction}</button>
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
  const [showCreateOperator, setShowCreateOperator] = useState(false);
  const [createDisplayName, setCreateDisplayName] = useState('');
  const [createProfileId, setCreateProfileId] = useState('');
  const [createPrimaryProjectId, setCreatePrimaryProjectId] = useState('');
  const [creatingOperator, setCreatingOperator] = useState(false);
  const [refsEditorInstance, setRefsEditorInstance] = useState(null);
  const [selectedRefProjectId, setSelectedRefProjectId] = useState('');
  const [selectedRefRole, setSelectedRefRole] = useState('reference');
  const [refsSaving, setRefsSaving] = useState(false);
  const [scheduleInstance, setScheduleInstance] = useState(null);
  const [schedules, setSchedules] = useState([]);
  const [schedulesLoading, setSchedulesLoading] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleName, setScheduleName] = useState('');
  const [schedulePrompt, setSchedulePrompt] = useState('');
  const [scheduleProjectId, setScheduleProjectId] = useState('');
  const [scheduleKind, setScheduleKind] = useState('interval');
  const [scheduleIntervalMinutes, setScheduleIntervalMinutes] = useState('60');
  const [scheduleAt, setScheduleAt] = useState('09:00');
  const [scheduleWeekday, setScheduleWeekday] = useState('1');
  const [scheduleOnceAt, setScheduleOnceAt] = useState('');
  const [scheduleTimezone, setScheduleTimezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  });
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

  const pms = arrayValue(managerStatus?.pms);
  const liveEntryByInstance = useMemo(() => {
    const map = new Map();
    for (const entry of pms) {
      const instance = resolveLiveInstance(entry, { instancesById, primaryInstanceByProject });
      if (instance?.id) map.set(String(instance.id), entry);
    }
    return map;
  }, [pms, instancesById, primaryInstanceByProject]);

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
    const hasPrimary = Boolean(primaryRef(instance));
    const role = hasPrimary ? 'reference' : 'primary';
    setSelectedRefRole(role);
    const existingIds = new Set(arrayValue(instance?.refs).map((ref) => String(ref.project_id)));
    const firstAvailable = arrayValue(projects).find((project) => (
      project?.id
      && !existingIds.has(String(project.id))
      && (role !== 'primary' || !primaryInstanceByProject.has(String(project.id)))
    ));
    setSelectedRefProjectId(firstAvailable?.id || '');
  };

  const changeRefRole = (role) => {
    setSelectedRefRole(role);
    const existingIds = new Set(arrayValue(refsEditorInstance?.refs).map((ref) => String(ref.project_id)));
    const selectedStillValid = arrayValue(projects).some((project) => (
      String(project?.id || '') === String(selectedRefProjectId)
      && !existingIds.has(String(project.id))
      && (role !== 'primary' || !primaryInstanceByProject.has(String(project.id)))
    ));
    if (selectedStillValid) return;
    const firstAvailable = arrayValue(projects).find((project) => (
      project?.id
      && !existingIds.has(String(project.id))
      && (role !== 'primary' || !primaryInstanceByProject.has(String(project.id)))
    ));
    setSelectedRefProjectId(firstAvailable?.id || '');
  };

  const closeRefsEditor = () => {
    setRefsEditorInstance(null);
    setSelectedRefProjectId('');
    setSelectedRefRole('reference');
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
          role: selectedRefRole,
        }),
      });
      await refreshOperatorInstances();
      closeRefsEditor();
    } catch (err) {
      // apiFetchWithToast owns the error toast.
      setRefsSaving(false);
    }
  };

  const openCreateOperatorModal = () => {
    setCreateProfileId(profiles[0]?.id || '');
    setCreateDisplayName('');
    setCreatePrimaryProjectId('');
    setShowCreateOperator(true);
  };

  const createOperator = async () => {
    if (!createProfileId) return;
    setCreatingOperator(true);
    try {
      await apiFetchWithToast('/api/operator-instances', {
        method: 'POST',
        body: JSON.stringify({
          profile_id: createProfileId,
          display_name: createDisplayName.trim() || undefined,
          primary_project_id: createPrimaryProjectId || undefined,
        }),
      });
      await refreshOperatorInstances();
      setShowCreateOperator(false);
    } catch {
      // apiFetchWithToast owns the toast.
    } finally {
      setCreatingOperator(false);
    }
  };

  const fetchSchedules = async (instance) => {
    if (!instance?.id) return;
    setSchedulesLoading(true);
    try {
      const data = await apiFetch(`/api/operator-instances/${encodeURIComponent(instance.id)}/schedules`);
      setSchedules(arrayValue(data?.schedules));
    } catch (err) {
      setSchedules([]);
      addToast(err.message, 'error');
    } finally {
      setSchedulesLoading(false);
    }
  };

  const openSchedules = (instance) => {
    const primary = primaryRef(instance);
    setScheduleInstance(instance);
    setScheduleProjectId(primary?.project_id || '');
    setScheduleName('');
    setSchedulePrompt('');
    setScheduleKind('interval');
    setScheduleIntervalMinutes('60');
    setScheduleAt('09:00');
    setScheduleWeekday('1');
    setScheduleOnceAt('');
    fetchSchedules(instance);
  };

  const closeSchedules = () => {
    setScheduleInstance(null);
    setSchedules([]);
    setScheduleSaving(false);
  };

  const buildScheduleRule = () => {
    if (scheduleKind === 'interval') return { kind: 'interval', minutes: Number(scheduleIntervalMinutes) };
    if (scheduleKind === 'once') return { kind: 'once', at: new Date(scheduleOnceAt).toISOString() };
    if (scheduleKind === 'weekly') return { kind: 'weekly', weekday: Number(scheduleWeekday), at: scheduleAt };
    return { kind: scheduleKind, at: scheduleAt };
  };

  const createSchedule = async () => {
    if (!scheduleInstance?.id || !scheduleName.trim() || !schedulePrompt.trim() || !scheduleProjectId) return;
    setScheduleSaving(true);
    try {
      await apiFetchWithToast(`/api/operator-instances/${encodeURIComponent(scheduleInstance.id)}/schedules`, {
        method: 'POST',
        body: JSON.stringify({
          name: scheduleName.trim(),
          prompt: schedulePrompt.trim(),
          codebase_project_id: scheduleProjectId,
          rule: buildScheduleRule(),
          timezone: scheduleTimezone,
        }),
      });
      setScheduleName('');
      setSchedulePrompt('');
      await Promise.all([fetchSchedules(scheduleInstance), refreshOperatorInstances()]);
    } catch {
      // apiFetchWithToast owns the toast.
    } finally {
      setScheduleSaving(false);
    }
  };

  const patchSchedule = async (schedule, fields) => {
    try {
      await apiFetchWithToast(`/api/operator-schedules/${encodeURIComponent(schedule.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...fields, expected_revision: schedule.revision }),
      });
      await Promise.all([fetchSchedules(scheduleInstance), refreshOperatorInstances()]);
    } catch {
      // apiFetchWithToast owns the toast.
    }
  };

  const runScheduleNow = async (schedule) => {
    try {
      await apiFetchWithToast(`/api/operator-schedules/${encodeURIComponent(schedule.id)}/run-now`, { method: 'POST' });
      await fetchSchedules(scheduleInstance);
    } catch {
      // apiFetchWithToast owns the toast.
    }
  };

  const removeSchedule = async (schedule) => {
    if (typeof window !== 'undefined' && !window.confirm(`${schedule.name} ${OPERATOR_SCHEDULER_LABELS.remove}?`)) return;
    try {
      await apiFetchWithToast(`/api/operator-schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' });
      await Promise.all([fetchSchedules(scheduleInstance), refreshOperatorInstances()]);
    } catch {
      // apiFetchWithToast owns the toast.
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
  const invokeModalTitleId = 'operator-roster-specialist-invoke-title';
  const refsModalTitleId = 'operator-roster-refs-title';
  const createModalTitleId = 'operator-roster-create-title';
  const scheduleModalTitleId = 'operator-roster-schedules-title';
  const refsEditorLatest = refsEditorInstance?.id ? instancesById.get(String(refsEditorInstance.id)) || refsEditorInstance : null;
  const refsEditorHasPrimary = Boolean(primaryRef(refsEditorLatest));
  const refsEditorExistingProjectIds = new Set(arrayValue(refsEditorLatest?.refs).map((ref) => String(ref.project_id)));
  const refsEditorAvailableProjects = arrayValue(projects)
    .filter((project) => project?.id && !refsEditorExistingProjectIds.has(String(project.id)))
    .filter((project) => selectedRefRole !== 'primary' || !primaryInstanceByProject.has(String(project.id)));
  const unownedPrimaryProjects = arrayValue(projects)
    .filter((project) => project?.id && !primaryInstanceByProject.has(String(project.id)));
  const schedulePrimary = primaryRef(scheduleInstance);
  const schedulePrimaryProject = schedulePrimary?.project
    || projectsById.get(String(schedulePrimary?.project_id || ''));
  const schedulePrimaryNodeId = schedulePrimaryProject?.node_id || 'local';
  const scheduleMappedRefs = arrayValue(scheduleInstance?.refs).filter((ref) => {
    const project = ref?.project || projectsById.get(String(ref?.project_id || ''));
    return (project?.node_id || 'local') === schedulePrimaryNodeId;
  });
  const scheduleCreateReady = Boolean(
    scheduleName.trim()
    && schedulePrompt.trim()
    && scheduleProjectId
    && scheduleTimezone.trim()
    && (scheduleKind !== 'once' || scheduleOnceAt)
    && (scheduleKind !== 'interval' || Number(scheduleIntervalMinutes) >= 15)
  );

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
        <button
          type="button"
          class="primary"
          data-role="operator-create-button"
          onClick=${openCreateOperatorModal}
          disabled=${loadingProfiles || profiles.length === 0}
        >${OPERATOR_ROSTER_LABELS.newOperator}</button>
      </div>

      <section class="operator-roster-section" data-role="operator-roster-master-section" aria-labelledby="operator-roster-master-title">
        <div class="operator-roster-section-header">
          <h2 id="operator-roster-master-title">${OPERATOR_ROSTER_LABELS.masterTitle}</h2>
        </div>
        ${loadingStatus
          ? html`<${Loading} />`
          : html`<div class="operator-roster-grid single"><${MasterCard} top=${top} /></div>`}
      </section>

      <${Modal}
        open=${showCreateOperator}
        onClose=${() => setShowCreateOperator(false)}
        labelledBy=${createModalTitleId}
        maxWidth="560px"
      >
        <div class="modal-header">
          <h2 class="modal-title" id=${createModalTitleId}>${OPERATOR_ROSTER_LABELS.createTitle}</h2>
          <button type="button" class="ghost small" onClick=${() => setShowCreateOperator(false)}>${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="operator-create-name">${OPERATOR_ROSTER_LABELS.displayNameLabel}</label>
            <input id="operator-create-name" class="form-input" value=${createDisplayName} onInput=${(e) => setCreateDisplayName(e.target.value)} placeholder=${OPERATOR_ROSTER_LABELS.displayNamePlaceholder} maxlength="120" />
          </div>
          <div class="form-field">
            <label class="form-label" for="operator-create-profile">${OPERATOR_ROSTER_LABELS.profileLabel}</label>
            <${Dropdown}
              id="operator-create-profile"
              className="dropdown-field"
              value=${createProfileId}
              onChange=${setCreateProfileId}
              options=${profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            />
          </div>
          <div class="form-field">
            <label class="form-label" for="operator-create-primary">${OPERATOR_ROSTER_LABELS.primaryFolderLabel}</label>
            <${Dropdown}
              id="operator-create-primary"
              className="dropdown-field"
              value=${createPrimaryProjectId}
              onChange=${setCreatePrimaryProjectId}
              options=${[
                { value: '', label: OPERATOR_ROSTER_LABELS.primaryFolderOptional },
                ...unownedPrimaryProjects.map((project) => ({ value: project.id, label: projectPlacementLabel(project) })),
              ]}
            />
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="ghost" onClick=${() => setShowCreateOperator(false)} disabled=${creatingOperator}>${COMMON_ACTIONS.cancel}</button>
          <button type="button" class="primary" data-role="operator-create-submit" onClick=${createOperator} disabled=${creatingOperator || !createProfileId}>
            ${creatingOperator ? COMMON_ACTIONS.saving : OPERATOR_ROSTER_LABELS.createSubmit}
          </button>
        </div>
      <//>

      <section class="operator-roster-section" data-role="operator-configured-section" aria-labelledby="operator-configured-title">
        <div class="operator-roster-section-header">
          <h2 id="operator-configured-title">${OPERATOR_ROSTER_LABELS.configuredTitle}</h2>
        </div>
        ${!operatorInstancesKnown && html`<${Loading} />`}
        ${operatorInstancesKnown && arrayValue(instances).length === 0 && html`
          <${EmptyState}
            icon="◫"
            text=${OPERATOR_ROSTER_LABELS.configuredEmptyText}
            sub=${OPERATOR_ROSTER_LABELS.configuredEmptySub}
          />
        `}
        ${operatorInstancesKnown && arrayValue(instances).length > 0 && html`
          <div class="operator-roster-grid">
            ${arrayValue(instances).map((instance) => html`
              <${ConfiguredOperatorCard}
                key=${instance.id}
                instance=${instance}
                liveEntry=${liveEntryByInstance.get(String(instance.id))}
                projectsById=${projectsById}
                onOpenRefs=${openRefsEditor}
                onRemoveReference=${removeReference}
                onOpenSchedules=${openSchedules}
              />
            `)}
          </div>
        `}
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
            <h2 class="modal-title" id=${refsModalTitleId}>${OPERATOR_ROSTER_LABELS.folderMappings}</h2>
            <p class="modal-subtitle">${operatorDisplayName(refsEditorLatest)} · ${instanceLabel(refsEditorLatest)}</p>
          </div>
          <button
            type="button"
            class="ghost small"
            onClick=${closeRefsEditor}
          >${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-field">
            <label class="form-label" for="operator-roster-ref-role">${OPERATOR_ROSTER_LABELS.mappingRoleLabel}</label>
            <${Dropdown}
              id="operator-roster-ref-role"
              className="dropdown-field"
              value=${selectedRefRole}
              onChange=${changeRefRole}
              disabled=${refsSaving}
              options=${[
                ...(!refsEditorHasPrimary
                  ? [{ value: 'primary', label: OPERATOR_ROSTER_LABELS.mappingPrimaryRole }]
                  : []),
                { value: 'reference', label: OPERATOR_ROSTER_LABELS.mappingReferenceRole },
              ]}
            />
          </div>
          <div class="form-field">
            <label class="form-label" for="operator-roster-ref-project">${OPERATOR_ROSTER_LABELS.referenceProjectLabel}</label>
            <${Dropdown}
              id="operator-roster-ref-project"
              className="dropdown-field"
              dataRole="operator-roster-ref-project-select"
              value=${selectedRefProjectId}
              onChange=${setSelectedRefProjectId}
              disabled=${refsEditorAvailableProjects.length === 0 || refsSaving}
              options=${refsEditorAvailableProjects.length === 0
                ? [{ value: '', label: OPERATOR_ROSTER_LABELS.noReferenceProjects }]
                : refsEditorAvailableProjects.map((project) => ({
                  value: project.id,
                  label: projectPlacementLabel(project),
                }))}
            />
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
          >${refsSaving ? COMMON_ACTIONS.saving : OPERATOR_ROSTER_LABELS.folderMappings}</button>
        </div>
      <//>

      <${Modal}
        open=${Boolean(scheduleInstance)}
        onClose=${closeSchedules}
        labelledBy=${scheduleModalTitleId}
        maxWidth="760px"
      >
        <div class="modal-header">
          <div>
            <h2 class="modal-title" id=${scheduleModalTitleId}>${OPERATOR_SCHEDULER_LABELS.modalTitle}</h2>
            <p class="modal-subtitle">${operatorDisplayName(scheduleInstance)}</p>
          </div>
          <button type="button" class="ghost small" onClick=${closeSchedules}>${COMMON_ACTIONS.close}</button>
        </div>
        <div class="modal-body operator-schedule-modal-body">
          <section class="operator-schedule-list" aria-label=${OPERATOR_SCHEDULER_LABELS.modalTitle}>
            ${schedulesLoading && html`<${Loading} />`}
            ${!schedulesLoading && schedules.length === 0 && html`<p class="form-hint">${OPERATOR_SCHEDULER_LABELS.empty}</p>`}
            ${!schedulesLoading && schedules.map((schedule) => html`
              <article class="operator-schedule-row" key=${schedule.id} data-role="operator-schedule-row">
                <div>
                  <strong>${schedule.name}</strong>
                  <div class="form-hint">
                    ${schedule.enabled ? OPERATOR_SCHEDULER_LABELS.enabled : OPERATOR_SCHEDULER_LABELS.disabled}
                    · ${schedule.rule?.kind || ''}
                    ${schedule.rule?.minutes ? ` ${schedule.rule.minutes}m` : ''}
                    · ${OPERATOR_SCHEDULER_LABELS.nextFire} ${formatDateTime(schedule.next_fire_at)}
                  </div>
                </div>
                <div class="operator-schedule-actions">
                  <button type="button" class="ghost small" onClick=${() => runScheduleNow(schedule)}>${OPERATOR_SCHEDULER_LABELS.runNow}</button>
                  <button type="button" class="ghost small" onClick=${() => patchSchedule(schedule, { enabled: !schedule.enabled })}>
                    ${schedule.enabled ? OPERATOR_SCHEDULER_LABELS.disable : OPERATOR_SCHEDULER_LABELS.enable}
                  </button>
                  <button type="button" class="ghost small danger-text" onClick=${() => removeSchedule(schedule)}>${OPERATOR_SCHEDULER_LABELS.remove}</button>
                </div>
              </article>
            `)}
          </section>

          <section class="operator-schedule-create" aria-labelledby="operator-schedule-create-title">
            <h3 id="operator-schedule-create-title">${OPERATOR_SCHEDULER_LABELS.newSchedule}</h3>
            <div class="form-field">
              <label class="form-label" for="operator-schedule-name">${OPERATOR_SCHEDULER_LABELS.nameLabel}</label>
              <input id="operator-schedule-name" class="form-input" value=${scheduleName} onInput=${(e) => setScheduleName(e.target.value)} placeholder=${OPERATOR_SCHEDULER_LABELS.namePlaceholder} maxlength="120" />
            </div>
            <div class="form-field">
              <label class="form-label" for="operator-schedule-prompt">${OPERATOR_SCHEDULER_LABELS.promptLabel}</label>
              <textarea id="operator-schedule-prompt" class="form-textarea" value=${schedulePrompt} onInput=${(e) => setSchedulePrompt(e.target.value)} placeholder=${OPERATOR_SCHEDULER_LABELS.promptPlaceholder} rows="4" maxlength="12000"></textarea>
            </div>
            <div class="form-grid operator-schedule-grid">
              <div class="form-field">
                <label class="form-label" for="operator-schedule-folder">${OPERATOR_SCHEDULER_LABELS.folderLabel}</label>
                <${Dropdown}
                  id="operator-schedule-folder"
                  className="dropdown-field"
                  value=${scheduleProjectId}
                  onChange=${setScheduleProjectId}
                  options=${scheduleMappedRefs.map((ref) => ({
                    value: ref.project_id,
                    label: `${projectPlacementLabel(ref.project || projectsById.get(String(ref.project_id)))} · ${refRoleLabel(ref.role)}`,
                  }))}
                />
              </div>
              <div class="form-field">
                <label class="form-label" for="operator-schedule-rule">${OPERATOR_SCHEDULER_LABELS.ruleKindLabel}</label>
                <${Dropdown}
                  id="operator-schedule-rule"
                  className="dropdown-field"
                  value=${scheduleKind}
                  onChange=${setScheduleKind}
                  options=${[
                    { value: 'interval', label: OPERATOR_SCHEDULER_LABELS.intervalKind },
                    { value: 'daily', label: OPERATOR_SCHEDULER_LABELS.dailyKind },
                    { value: 'weekdays', label: OPERATOR_SCHEDULER_LABELS.weekdaysKind },
                    { value: 'weekly', label: OPERATOR_SCHEDULER_LABELS.weeklyKind },
                    { value: 'once', label: OPERATOR_SCHEDULER_LABELS.onceKind },
                  ]}
                />
              </div>
              ${scheduleKind === 'interval' && html`
                <div class="form-field">
                  <label class="form-label" for="operator-schedule-interval">${OPERATOR_SCHEDULER_LABELS.intervalMinutesLabel}</label>
                  <input id="operator-schedule-interval" class="form-input" type="number" min="15" max="10080" value=${scheduleIntervalMinutes} onInput=${(e) => setScheduleIntervalMinutes(e.target.value)} />
                </div>
              `}
              ${['daily', 'weekdays', 'weekly'].includes(scheduleKind) && html`
                <div class="form-field">
                  <label class="form-label" for="operator-schedule-at">${OPERATOR_SCHEDULER_LABELS.atTimeLabel}</label>
                  <input id="operator-schedule-at" class="form-input" type="time" value=${scheduleAt} onInput=${(e) => setScheduleAt(e.target.value)} />
                </div>
              `}
              ${scheduleKind === 'weekly' && html`
                <div class="form-field">
                  <label class="form-label" for="operator-schedule-weekday">${OPERATOR_SCHEDULER_LABELS.weekdayLabel}</label>
                  <${Dropdown}
                    id="operator-schedule-weekday"
                    className="dropdown-field"
                    value=${scheduleWeekday}
                    onChange=${setScheduleWeekday}
                    options=${OPERATOR_SCHEDULER_LABELS.weekdays.map((label, index) => ({
                      value: String(index + 1),
                      label,
                    }))}
                  />
                </div>
              `}
              ${scheduleKind === 'once' && html`
                <div class="form-field">
                  <label class="form-label" for="operator-schedule-once">${OPERATOR_SCHEDULER_LABELS.onceAtLabel}</label>
                  <input id="operator-schedule-once" class="form-input" type="datetime-local" value=${scheduleOnceAt} onInput=${(e) => setScheduleOnceAt(e.target.value)} />
                </div>
              `}
              <div class="form-field">
                <label class="form-label" for="operator-schedule-timezone">${OPERATOR_SCHEDULER_LABELS.timezoneLabel}</label>
                <input id="operator-schedule-timezone" class="form-input" value=${scheduleTimezone} onInput=${(e) => setScheduleTimezone(e.target.value)} />
              </div>
            </div>
          </section>
        </div>
        <div class="modal-footer">
          <button type="button" class="ghost" onClick=${closeSchedules}>${COMMON_ACTIONS.close}</button>
          <button type="button" class="primary" data-role="operator-schedule-create-submit" onClick=${createSchedule} disabled=${scheduleSaving || !scheduleCreateReady}>
            ${scheduleSaving ? COMMON_ACTIONS.saving : OPERATOR_SCHEDULER_LABELS.create}
          </button>
        </div>
      <//>
    </div>
  `;
}
