// OperatorsView — read-only roster slice.
// Shows the current Top manager, project-bound live Operators, and folder-less
// available Operator profiles without adding any backend surface.

import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { apiFetch } from '../lib/api.js';
import { addToast } from '../lib/toast.js';
import { parseProjectConversationId } from '../lib/conversationId.js';
import {
  COMMON_ACTIONS,
  OPERATOR_ROSTER_LABELS,
  RUN_STATUS_LABELS,
  statusLabel,
} from '../lib/copy.js';
import { EmptyState } from './EmptyState.js';

// Contract: count ONLY 'running' worker runs (Codex review — 'active' was too broad;
// needs_input is waiting, not running). count-only, no run list (board 복제 방지).
const ACTIVE_WORKER_STATUSES = new Set(['running']);

function Loading() {
  return html`<div class="loading">${COMMON_ACTIONS.loading}</div>`;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
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

function runHref(id) {
  return `#run/${encodeURIComponent(String(id || ''))}`;
}

function specialistHref(profileId) {
  return `#operator/specialist/${encodeURIComponent(String(profileId || ''))}`;
}

function parsedProjectId(entry) {
  const fromEntry = parseProjectConversationId(entry?.conversationId);
  if (fromEntry) return fromEntry.projectId;
  const fromRun = parseProjectConversationId(entry?.run?.conversation_id);
  return fromRun ? fromRun.projectId : null;
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

function LiveOperatorCard({ entry, projectsById, runs, taskById }) {
  const run = entry?.run || {};
  const projectId = parsedProjectId(entry);
  const project = projectId ? projectsById.get(String(projectId)) : null;
  const projectName = project?.name || run.project_name || projectId || OPERATOR_ROSTER_LABELS.unknownProject;
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
      <div class="operator-roster-meta-grid">
        <span>${OPERATOR_ROSTER_LABELS.adapterLabel}</span>
        <strong>${adapterName(run)}</strong>
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
        </span>
      </div>
    </article>
  `;
}

function AvailableOperatorCard({ profile }) {
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
          <a
            class="ghost small"
            data-role="operator-roster-available-invoke-link"
            href=${specialistHref(profile.id)}
            aria-label=${`${profile.name} ${OPERATOR_ROSTER_LABELS.invokeOperator}`}
          >${OPERATOR_ROSTER_LABELS.invokeOperator}</a>
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
  const [profiles, setProfiles] = useState([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const seq = ++reqSeqRef.current;

    setLoadingStatus(true);
    setLoadingProfiles(true);

    apiFetch('/api/manager/status')
      .then((data) => {
        if (!alive || seq !== reqSeqRef.current) return;
        setManagerStatus(data || null);
      })
      .catch((err) => {
        if (!alive || seq !== reqSeqRef.current) return;
        setManagerStatus(null);
        addToast(err.message, 'error');
      })
      .finally(() => {
        if (alive && seq === reqSeqRef.current) setLoadingStatus(false);
      });

    apiFetch('/api/operator/profiles')
      .then((data) => {
        if (!alive || seq !== reqSeqRef.current) return;
        setProfiles(arrayValue(data?.profiles));
      })
      .catch((err) => {
        if (!alive || seq !== reqSeqRef.current) return;
        setProfiles([]);
        addToast(err.message, 'error');
      })
      .finally(() => {
        if (alive && seq === reqSeqRef.current) setLoadingProfiles(false);
      });

    return () => { alive = false; };
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

  const top = managerStatus?.top || (managerStatus?.run
    ? { conversationId: 'top', run: managerStatus.run }
    : null);
  const pms = arrayValue(managerStatus?.pms);

  return html`
    <div
      class="page operator-roster-page"
      data-view="operator-roster"
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
                projectsById=${projectsById}
                runs=${runs}
                taskById=${taskById}
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
              <${AvailableOperatorCard} key=${profile.id} profile=${profile} />
            `)}
          </div>
        `}
      </section>
    </div>
  `;
}
