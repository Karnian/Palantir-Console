import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { WORK_BOARD_LABELS as W } from '../lib/copy.js';
import { rankCards, sessionDisplayState, sessionDisplayStatusLabel,
  sessionHasOldTranscript } from '../lib/workBoard.js';
import { SnapshotRefreshControls } from './SnapshotRefreshControls.js';
import { Dropdown } from './Dropdown.js';
import { SnapshotTime, SessionRow, SessionCard, Coverage } from './SessionSnapshotParts.js';
const html = htm.bind(h);
const GROUP_KEY = 'session-hub-grouping';
const PALANTIR_KEY = 'session-hub-palantir';
function readPreference(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writePreference(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}
export function sessionGroups(cards, grouping, now = Date.now()) {
  const groups = new Map();
  const groupKeys = ['waiting', 'working', 'working-old-record', 'ended', 'interrupted', 'unknown'];
  if (grouping === 'status') for (const key of groupKeys) groups.set(key, {
    label: key === 'working-old-record' ? '작업 중 · 30분 넘게 새 기록 없음' : W.states[key], cards: [],
  });
  for (const card of cards) {
    const state = sessionDisplayState(card);
    const statusGroup = sessionHasOldTranscript(card, now) ? 'working-old-record'
      : groupKeys.includes(state) ? state : 'unknown';
    const key = grouping === 'status' ? statusGroup
      : `${card.machine.id}:${card.repo_label || card.cwd_id || ''}`;
    if (!groups.has(key)) groups.set(key, { label: `${card.machine.label} · ${card.repo_label || W.repoUnknown}`,
      cards: [] });
    groups.get(key).cards.push(card);
  }
  return [...groups].filter(([, group]) => group.cards.length).map(([key, group]) => ({ key, ...group,
    cards: group.cards.sort((a, b) => (Date.parse(b.last_record_at) || 0) - (Date.parse(a.last_record_at) || 0)
      || a.key.localeCompare(b.key)),
  }));
}
export function SessionHubSidebar({ data, projects = [], onAssistant, onConversation, onWork, onOpenSession,
  revisionMismatch = false, activeItem = 'assistant' }) {
  const { load, cards, loading, error, now, reload } = data;
  const [query, setQuery] = useState('');
  const [machine, setMachine] = useState('');
  const [provider, setProvider] = useState('');
  const [grouping, setGrouping] = useState(() =>
    readPreference(GROUP_KEY, 'status') === 'repo' ? 'repo' : 'status');
  const [palantir, setPalantir] = useState(() => readPreference(PALANTIR_KEY, 'open') !== 'closed');
  const results = useMemo(() => rankCards(cards, query, machine, provider), [cards, query, machine, provider]);
  const groups = useMemo(() => sessionGroups(results, grouping, now), [results, grouping, now]);
  const machines = load.entries.filter(entry => entry.machine_id).map(entry => ({
    value: entry.machine_id, label: entry.machine_label || entry.machine_id,
  }));
  return html`<aside class="session-hub-sidebar all-sessions-panel" aria-label="세션 목록">
    <header class="session-hub-sidebar-header">
      <input id="hub-query" class="work-search" type="search" value=${query} placeholder="세션 검색"
        aria-label="세션 검색" onInput=${event => setQuery(event.target.value)} />
      <div class="session-hub-filters">
        <div class="board-filter"><${Dropdown} ariaLabel="묶음 선택" value=${grouping}
          options=${[{ value: 'status', label: '상태별' }, { value: 'repo', label: '머신·repo' }]}
          onChange=${value => { setGrouping(value); writePreference(GROUP_KEY, value); }} /></div>
        <div class="board-filter"><${Dropdown} ariaLabel="머신" value=${machine} onChange=${setMachine}
          options=${[{ value: '', label: '머신' }, ...machines]} /></div>
        <div class="board-filter"><${Dropdown} ariaLabel="도구" value=${provider} onChange=${setProvider}
          options=${[{ value: '', label: '도구' }, { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex' }]} /></div>
      </div>
      <${SnapshotRefreshControls} load=${load} now=${now} loading=${loading} reload=${reload} />
      ${!loading && !load.rev && html`<p class="work-label" role="status">스냅샷 확인 불가
        <button class="ghost" onClick=${reload}>다시 시도</button></p>`}
      ${revisionMismatch && html`<p class="work-label" role="status">답변 뒤 갱신됨</p>`}
    </header>
    <div class="session-hub-sidebar-body">
      <button class="ghost session-hub-nav" type="button" aria-current=${activeItem === 'assistant' ? 'page' : null}
        onClick=${onAssistant}>★ 비서</button>
      <button class="ghost session-hub-group-title" type="button" aria-expanded=${palantir}
        onClick=${() => { setPalantir(!palantir); writePreference(PALANTIR_KEY, palantir ? 'closed' : 'open'); }}>
        Palantir ${palantir ? '▾' : '▸'}</button>
      <div hidden=${!palantir}>
        <button class="ghost session-hub-nav" type="button" aria-current=${activeItem === 'top' ? 'page' : null}
          onClick=${() => onConversation('top')}>Top</button>
        ${projects.filter(project => project.pm_enabled).map(project => html`
          <button key=${project.id} class="ghost session-hub-nav" type="button"
            aria-current=${activeItem === `operator:${project.id}` ? 'page' : null}
            onClick=${() => onConversation(`operator:${project.id}`)}>Operator · ${project.name}</button>`)}
        <button class="ghost session-hub-nav" type="button" aria-current=${activeItem === 'work' ? 'page' : null}
          onClick=${onWork}>작업</button>
      </div>
      ${loading && html`<p role="status">${W.loading(load.done, load.total)}</p>`}
      ${error && html`<p role="alert">${W.error}</p>`}
      ${!loading && !error && !results.length && html`<p>${cards.length ? W.noResults : W.empty}</p>`}
      ${groups.map(group => html`<section key=${group.key} class="session-hub-group">
        <h2 class="session-hub-group-title">${group.label} <span>${group.cards.length}</span></h2>
        ${group.cards.map(card => html`<${SessionRow} key=${card.key} compact=${true}
          selected=${activeItem === card.key} card=${card}
          query=${query} now=${now} onOpen=${key => onOpenSession(key, load.rev, query)} />`)}
      </section>`)}
      <details class="session-hub-coverage"><summary>수집 범위</summary><${Coverage} load=${load} /></details>
    </div>
  </aside>`;
}
export function SessionHubDetail({ data, selection, revisionMismatch, onAsk }) {
  const { cards, load, now, loading } = data;
  const selectedCard = cards.find(item => item.key === selection?.key);
  const query = selection?.query || '';
  const card = selectedCard && { ...selectedCard, match: rankCards([selectedCard], query)[0]?.match };
  const header = useRef(null);
  useEffect(() => { header.current?.focus(); }, [selection?.key]);
  const changed = revisionMismatch || (selection?.rev && load.rev && selection.rev !== load.rev);
  return html`<section class="all-sessions-panel session-hub-detail" aria-label="세션 상세">
    <header class="session-hub-detail-header" ref=${header} tabindex="-1">
      ${changed && html`<p class="work-label" role="status">답변 뒤 갱신됨 · 현재 스냅샷을 표시합니다.</p>`}
      ${card && html`<div class="work-meta"><span>${sessionDisplayStatusLabel(card, now)}</span>
        <span>${card.status.source === 'orca' ? 'Orca'
          : card.status.source === 'transcript' ? '기록' : '근거 없음'}</span>
        <${SnapshotTime} value=${card.status.evidence_at} label="근거" now=${now} />
        ${String(card.status.reason || '').includes('conflict') && html`<span class="work-warning">상태 충돌</span>`}
        <span>${card.orca_link.confirmed ? 'Orca 연결됨' : 'Orca 연결 미확정'}</span>
        <button class="ghost" type="button" onClick=${() => onAsk(card.key, load.rev)}>비서에게 묻기</button>
      </div>`}
    </header>
    <div class="work-body">${card ? html`<${SessionCard} key=${card.key} card=${card}
      query=${query} now=${now} timeline=${true} showStatus=${false} />`
      : html`<p>${loading ? '읽는 중' : load.rev ? '현재 스냅샷에 없는 세션' : '세션 확인 불가'}</p>`}</div>
  </section>`;
}
