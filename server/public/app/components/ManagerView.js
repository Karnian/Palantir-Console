// ManagerView — Thin layout shell composing ManagerChat + SessionGrid.
// Split from monolithic ManagerView.js as part of P8-5.
//
// ManagerChat and SessionGrid are ESM siblings imported directly —
// they do NOT need window bridges (only ManagerView is bridged via main.js).

import { ManagerChat, managerProfileAuthState } from './ManagerChat.js';
import { SessionGrid } from './SessionGrid.js';

import { h } from '../../vendor/preact.module.js';
import { useState } from '../../vendor/hooks.module.js';
import { useNodeSummary } from '../lib/hooks.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

// Re-export so tests and other consumers that import from ManagerView
// still find managerProfileAuthState at the same path.
export { managerProfileAuthState };

export function ManagerView({ manager, runs, tasks, projects, agents, agentsError, agentsLoading, reloadAgents, driftAudit, onOpenDrift, nodeSummary: nodeSummaryProp }) {
  // N1-C: AttentionStrip (rendered inside SessionGrid) needs the fleet
  // summary for its node-unreachable promotion. Self-fetch unless a test
  // injects the summary as a prop.
  const hasNodeSummaryProp = nodeSummaryProp !== undefined;
  const fetchedNodeSummary = useNodeSummary({ enabled: !hasNodeSummaryProp, refreshKey: runs });
  const nodeSummary = hasNodeSummaryProp ? nodeSummaryProp : fetchedNodeSummary;
  // Lifted conversation target state — shared between ManagerChat (dropdown)
  // and SessionGrid (PM session click).
  const [conversationTarget, setConversationTarget] = useState('top');
  const activePms = manager.status?.pms || [];

  return html`
    <div class="manager-view" data-view="manager">
      <${ManagerChat}
        manager=${manager}
        projects=${projects}
        runs=${runs}
        tasks=${tasks}
        agents=${agents}
        agentsError=${agentsError}
        agentsLoading=${agentsLoading}
        reloadAgents=${reloadAgents}
        driftAudit=${driftAudit}
        onOpenDrift=${onOpenDrift}
        conversationTarget=${conversationTarget}
        onConversationChange=${setConversationTarget}
      />
      <${SessionGrid}
        tasks=${tasks}
        runs=${runs}
        projects=${projects}
        activePms=${activePms}
        managerStatus=${manager.status}
        conversationTarget=${conversationTarget}
        onSelectConversation=${setConversationTarget}
        nodeSummary=${nodeSummary}
      />
    </div>
  `;
}
