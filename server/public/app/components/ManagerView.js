// ManagerView — Thin layout shell composing ManagerChat + SessionGrid.
// Split from monolithic ManagerView.js as part of P8-5.
//
// ManagerChat and SessionGrid are ESM siblings imported directly —
// they do NOT need window bridges (only ManagerView is bridged via main.js).

import { ManagerChat, managerProfileAuthState } from './ManagerChat.js';
import { SessionHubChat } from './SessionHubChat.js';
import { AllSessionsPanel } from './AllSessionsPanel.js';
import { Dropdown } from './Dropdown.js';
import { operatorConversationId } from '../lib/conversationId.js';
import { SessionGrid } from './SessionGrid.js';

import { h } from '../../vendor/preact.module.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { useNodeSummary } from '../lib/hooks.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

// Re-export so tests and other consumers that import from ManagerView
// still find managerProfileAuthState at the same path.
export { managerProfileAuthState };

export function ManagerView({ manager, runs, tasks, projects, agents, agentsError, agentsLoading,
  reloadAgents, driftAudit, onOpenDrift, nodeSummary: nodeSummaryProp, initialTarget,
  sessionHubActive = false, initialPanel }) {
  // N1-C: AttentionStrip (rendered inside SessionGrid) needs the fleet
  // summary for its node-unreachable promotion. Self-fetch unless a test
  // injects the summary as a prop.
  const hasNodeSummaryProp = nodeSummaryProp !== undefined;
  const fetchedNodeSummary = useNodeSummary({ enabled: !hasNodeSummaryProp, refreshKey: runs });
  const nodeSummary = hasNodeSummaryProp ? nodeSummaryProp : fetchedNodeSummary;
  // Lifted conversation target state — shared between ManagerChat (dropdown)
  // and SessionGrid (PM session click).
  const [conversationTarget, setConversationTarget] = useState(() =>
    initialTarget || (sessionHubActive ? 'hub' : 'top'));
  useEffect(() => {
    setConversationTarget(initialTarget || (sessionHubActive ? 'hub' : 'top'));
  }, [initialTarget, sessionHubActive]);
  const activePms = manager.status?.pms || [];

  const [panelTab, setPanelTab] = useState(initialPanel || 'all');
  const [mobilePane, setMobilePane] = useState(initialPanel ? 'panel' : 'chat');
  const [panelData, setPanelData] = useState({ cards: [], rev: null });
  const [selection, setSelection] = useState(null);
  const [revisionMismatch, setRevisionMismatch] = useState(false);
  useEffect(() => {
    if (initialPanel) { setPanelTab(initialPanel); setMobilePane('panel'); }
  }, [initialPanel]);
  const openSession = (key, rev) => {
    setSelection({ key, rev }); setPanelTab('all'); setMobilePane('panel');
  };
  const selectConversation = target => {
    setConversationTarget(target);
    if (sessionHubActive) setMobilePane('chat');
  };
  const conversationOptions = [{ value: 'hub', label: '세션 비서' }, { value: 'top', label: 'Top Manager' },
    ...(projects || []).filter(project => project.pm_enabled).map(project => ({
      value: operatorConversationId(project.id), label: project.name,
    }))];
  const chat = conversationTarget === 'hub' && sessionHubActive ? html`
    <${SessionHubChat} panel=${panelData} onOpenSession=${openSession}
      onRevisionMismatch=${setRevisionMismatch} />` : html`
    <${ManagerChat} manager=${manager} projects=${projects} runs=${runs} tasks=${tasks}
      agents=${agents} agentsError=${agentsError} agentsLoading=${agentsLoading} reloadAgents=${reloadAgents}
      driftAudit=${driftAudit} onOpenDrift=${onOpenDrift} conversationTarget=${conversationTarget}
      onConversationChange=${setConversationTarget} />`;
  const grid = html`<${SessionGrid} tasks=${tasks} runs=${runs} projects=${projects} activePms=${activePms}
    managerStatus=${manager.status} conversationTarget=${conversationTarget}
    onSelectConversation=${sessionHubActive ? selectConversation : setConversationTarget}
    nodeSummary=${nodeSummary} />`;
  if (!sessionHubActive) return html`<div class="manager-view" data-view="manager">${chat}${grid}</div>`;
  return html`<div class="manager-view session-hub-manager" data-view="manager" data-pane=${mobilePane}>
    <div class="session-hub-segments" role="group" aria-label="매니저 화면">
      <button class="ghost" type="button" aria-pressed=${mobilePane === 'chat'}
        onClick=${() => setMobilePane('chat')}>채팅</button>
      <button class="ghost" type="button" aria-pressed=${mobilePane === 'panel'}
        onClick=${() => setMobilePane('panel')}>세션 패널</button>
    </div>
    <div class="session-hub-chat-side">
      <div class="session-hub-picker board-filter"><${Dropdown} wide ariaLabel="대화 선택"
        value=${conversationTarget} options=${conversationOptions} onChange=${setConversationTarget} /></div>
      ${chat}
    </div>
    <div class="session-hub-panel-side">
      <div class="session-hub-tabs" role="group" aria-label="세션 패널 선택">
        <button type="button" class="ghost" aria-pressed=${panelTab === 'all'}
          onClick=${() => setPanelTab('all')}>모든 세션</button>
        <button type="button" class="ghost" aria-pressed=${panelTab === 'palantir'}
          onClick=${() => setPanelTab('palantir')}>Palantir 작업</button>
      </div>
      <div class="session-hub-panel-content" hidden=${panelTab !== 'all'}>
        <${AllSessionsPanel} onData=${setPanelData} selection=${selection}
          revisionMismatch=${revisionMismatch} onSelectionChange=${setSelection} />
      </div>
      ${panelTab === 'palantir' && grid}
    </div>
  </div>`;
}
