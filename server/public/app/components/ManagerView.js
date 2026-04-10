// ManagerView — Thin layout shell composing ManagerChat + SessionGrid.
// Split from monolithic ManagerView.js as part of P8-5.
//
// ManagerChat and SessionGrid are ESM siblings imported directly —
// they do NOT need window bridges (only ManagerView is bridged via main.js).

import { ManagerChat, managerProfileAuthState } from './ManagerChat.js';
import { SessionGrid } from './SessionGrid.js';

const { h } = window.preact;
const html = window.htm.bind(h);

// Re-export so tests and other consumers that import from ManagerView
// still find managerProfileAuthState at the same path.
export { managerProfileAuthState };

export function ManagerView({ manager, runs, tasks, projects, agents, agentsError, agentsLoading, reloadAgents, driftAudit, onOpenDrift }) {
  return html`
    <div class="manager-view">
      <${ManagerChat}
        manager=${manager}
        projects=${projects}
        agents=${agents}
        agentsError=${agentsError}
        agentsLoading=${agentsLoading}
        reloadAgents=${reloadAgents}
        driftAudit=${driftAudit}
        onOpenDrift=${onOpenDrift}
      />
      <${SessionGrid}
        tasks=${tasks}
        runs=${runs}
        projects=${projects}
      />
    </div>
  `;
}
