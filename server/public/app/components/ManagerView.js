// ManagerView — Thin layout shell composing ManagerChat + SessionGrid.
// Split from monolithic ManagerView.js as part of P8-5.
//
// ManagerChat and SessionGrid are ESM siblings imported directly —
// they do NOT need window bridges (only ManagerView is bridged via main.js).

import { ManagerChat, managerProfileAuthState } from './ManagerChat.js';
import { SessionHubChat } from './SessionHubChat.js';
import { SessionHubSidebar, SessionHubDetail } from './SessionHubSidebar.js';
import { useSessionSnapshots } from '../lib/hooks/useSessionSnapshots.js';
import { snapshotCards } from '../lib/workBoard.js';
import { SessionGrid } from './SessionGrid.js';

import { h, cloneElement } from '../../vendor/preact.module.js';
import { useEffect, useState } from '../../vendor/hooks.module.js';
import { useNodeSummary } from '../lib/hooks.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

// Re-export so tests and other consumers that import from ManagerView
// still find managerProfileAuthState at the same path.
export { managerProfileAuthState };

const isManagerTarget = target => target === 'top'
  || (typeof target === 'string' && target.startsWith('operator:') && target.length > 'operator:'.length);

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
  const routeManagerTarget = isManagerTarget(initialTarget) ? initialTarget : null;
  const [managerTarget, setManagerTarget] = useState(() => routeManagerTarget || 'top');
  const conversationTarget = managerTarget;
  const setConversationTarget = target => {
    if (isManagerTarget(target)) setManagerTarget(target);
  };
  useEffect(() => {
    // Assistant selection belongs to AssistantLayout; it never becomes a send target.
    if (routeManagerTarget || !sessionHubActive) setManagerTarget(routeManagerTarget || 'top');
  }, [routeManagerTarget, sessionHubActive]);
  const activePms = manager.status?.pms || [];

  const chat = html`<${ManagerChat} manager=${manager} projects=${projects} runs=${runs} tasks=${tasks}
    agents=${agents} agentsError=${agentsError} agentsLoading=${agentsLoading} reloadAgents=${reloadAgents}
    driftAudit=${driftAudit} onOpenDrift=${onOpenDrift} conversationTarget=${conversationTarget}
    onConversationChange=${setConversationTarget} />`;
  const grid = html`<${SessionGrid} tasks=${tasks} runs=${runs} projects=${projects} activePms=${activePms}
    managerStatus=${manager.status} conversationTarget=${conversationTarget}
    onSelectConversation=${setConversationTarget} nodeSummary=${nodeSummary} />`;
  if (!sessionHubActive) return html`<div class="manager-view" data-view="manager">${chat}${grid}</div>`;
  return html`<${AssistantLayout} projects=${projects} initialTarget=${initialTarget} initialPanel=${initialPanel}
    chat=${chat} grid=${grid} conversationTarget=${conversationTarget}
    setConversationTarget=${setConversationTarget} />`;
}

function AssistantLayout({ projects, initialTarget, initialPanel, chat, grid,
  conversationTarget, setConversationTarget }) {
  const snapshots = useSessionSnapshots();
  const cards = snapshots.load.snapshots.flatMap(snapshotCards);
  const data = { ...snapshots, cards };
  const panel = { cards, rev: snapshots.load.rev };
  const [activeItem, setActiveItem] = useState(isManagerTarget(initialTarget) ? initialTarget : 'assistant');
  const [right, setRight] = useState(isManagerTarget(initialTarget) ? 'manager' : null);
  const [managerVisited, setManagerVisited] = useState(isManagerTarget(initialTarget));
  const [mobilePane, setMobilePane] = useState(initialPanel ? 'sidebar' : 'chat');
  const [selection, setSelection] = useState(null);
  const [revisionMismatch, setRevisionMismatch] = useState(false);
  const [draft, setDraft] = useState(null);
  const focusAssistant = text => {
    if (window.innerWidth >= 900 && window.innerWidth < 1280) {
      setRight(null); setActiveItem('assistant');
    }
    setMobilePane('chat');
    setDraft(value => ({ text, version: (value?.version || 0) + 1 }));
  };
  const close = () => { setRight(null); setActiveItem('assistant'); focusAssistant(); };
  useEffect(() => {
    if (isManagerTarget(initialTarget)) {
      setManagerVisited(true);
      setActiveItem(initialTarget); setRight('manager'); setMobilePane('right');
    } else {
      setActiveItem('assistant'); setRight(null); setMobilePane(initialPanel ? 'sidebar' : 'chat');
    }
  }, [initialTarget]);
  useEffect(() => {
    if (initialPanel) { setActiveItem('assistant'); setRight(null); setMobilePane('sidebar'); }
  }, [initialPanel]);
  useEffect(() => {
    const syncPanel = () => {
      if (location.hash === '#manager' || location.hash === '#manager/hub') {
        setActiveItem('assistant'); setRight(null); setMobilePane('chat');
      } else if (location.hash === '#work' || location.hash === '#manager/all-sessions') {
        setActiveItem('assistant'); setRight(null); setMobilePane('sidebar');
      }
    };
    const onLink = event => {
      if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search
        && ['#manager', '#manager/hub', '#manager/all-sessions'].includes(url.hash)
        && location.hash === url.hash) syncPanel();
    };
    window.addEventListener('hashchange', syncPanel);
    document.addEventListener('click', onLink);
    return () => {
      window.removeEventListener('hashchange', syncPanel);
      document.removeEventListener('click', onLink);
    };
  }, []);
  const openSession = (key, rev, query = '') => {
    setActiveItem(key); setSelection({ key, rev, query }); setRight('session'); setMobilePane('right');
  };
  const openConversation = target => {
    if (!isManagerTarget(target)) return;
    setManagerVisited(true);
    setActiveItem(target); setConversationTarget(target); setRight('manager'); setMobilePane('right');
  };
  // SessionHubChat always occupies this slot; pane changes only affect CSS visibility.
  return html`<div class="manager-view session-hub-manager" data-view="manager"
    data-pane=${mobilePane} data-right=${right || 'closed'}>
    <div class="session-hub-segments" role="group" aria-label="매니저 화면">
      ${[['sidebar', '목록'], ['chat', '비서'], ['right', '상세']].map(([pane, label]) => html`
        <button key=${pane} class="ghost" type="button" aria-pressed=${mobilePane === pane}
          disabled=${pane === 'right' && !right}
          onClick=${() => setMobilePane(pane)}>${label}</button>`)}
    </div>
    <${SessionHubSidebar} data=${data} projects=${projects} onAssistant=${close}
      onConversation=${openConversation} onWork=${() => {
        setActiveItem('work'); setRight('work'); setMobilePane('right');
      }}
      activeItem=${right === 'manager' ? conversationTarget : activeItem}
      onOpenSession=${openSession} revisionMismatch=${revisionMismatch} />
    <div class="session-hub-chat-side">
      <${SessionHubChat} panel=${panel} onOpenSession=${openSession} draft=${draft}
        onRevisionMismatch=${setRevisionMismatch} />
    </div>
    <div class="session-hub-panel-side" hidden=${!right}>
      <header class="session-hub-right-header">
        <span>${right === 'session' ? '세션 상세'
          : right === 'manager' ? 'Palantir' : right === 'work' ? '작업' : '상세'}</span>
        <button class="ghost" type="button" onClick=${close} aria-label="오른쪽 칸 닫기">×</button>
      </header>
      ${right === 'session' && html`<${SessionHubDetail} data=${data} selection=${selection}
        revisionMismatch=${revisionMismatch} onAsk=${(key, rev) =>
          focusAssistant(`이 세션 [[session:${key}@${rev}]] 지금 상태와 원래 목적 알려줘`)} />`}
      <div class="session-hub-manager-chat" hidden=${right !== 'manager'}
        aria-hidden=${right !== 'manager'} inert=${right !== 'manager' ? '' : null}>
        ${managerVisited && chat}
      </div>
      ${right === 'work' && cloneElement(grid, { onSelectConversation: openConversation })}
    </div>
  </div>`;
}
