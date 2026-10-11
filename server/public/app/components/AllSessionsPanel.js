import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { apiFetch } from '../lib/api.js';
import { WORK_BOARD_LABELS as W } from '../lib/copy.js';
import { snapshotCards, rankCards, loadSessionSnapshots } from '../lib/workBoard.js';
import { SnapshotTime, SessionCard, SessionRow, Coverage } from './SessionSnapshotParts.js';
import { Dropdown } from './Dropdown.js';
const html = htm.bind(h);
const emptyPanelLoad = () => ({ entries: [], snapshots: [], failures: [], done: 0, total: 0, rev: null });

export function AllSessionsPanel({ onData, selection, onSelectionChange, revisionMismatch = false }) {
  const [load, setLoad] = useState(emptyPanelLoad);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [machine, setMachine] = useState('');
  const [provider, setProvider] = useState('');
  const [localSelection, setLocalSelection] = useState(null);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  const selected = selection === undefined ? localSelection : selection;
  const select = onSelectionChange || setLocalSelection;
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoad(emptyPanelLoad()); setLoading(true); setError(false);
    onData?.({ cards: [], rev: null });
    loadSessionSnapshots(apiFetch, controller.signal, next => {
      if (!controller.signal.aborted && generation.current === current) {
        setLoad(next);
        onData?.({ cards: next.rev ? next.snapshots.flatMap(snapshotCards) : [], rev: next.rev });
      }
    }).catch(() => {
      if (!controller.signal.aborted && generation.current === current) {
        setLoad(emptyPanelLoad()); setError(true); onData?.({ cards: [], rev: null });
      }
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === current) setLoading(false);
    });
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { generation.current++; controller.abort(); clearInterval(timer); };
  }, [revision]);
  const cards = useMemo(() => load.snapshots.flatMap(snapshotCards), [load.snapshots]);
  const results = useMemo(() => rankCards(cards, query, machine, provider), [cards, query, machine, provider]);
  const selectedCard = cards.find(card => card.key === selected?.key);
  const currentCard = selectedCard && { ...selectedCard, match: rankCards([selectedCard], query)[0]?.match };
  const changed = selected?.rev && load.rev && selected.rev !== load.rev;
  const machines = load.entries.filter(entry => entry.machine_id)
    .map(entry => ({ value: entry.machine_id, label: entry.machine_label }));
  return html`<section data-view="all-sessions" class="work-board all-sessions-panel" aria-label="모든 세션">
    <header class="work-header">
      <div class="work-snapshot-times">${load.entries.filter(entry => entry.machine_id).map(entry => {
        const snapshot = load.snapshots.find(item => item.machine.id === entry.machine_id);
        return html`<span key=${entry.machine_id}><${SnapshotTime}
          value=${snapshot?.generated_at || entry.generated_at} now=${now}
          label=${snapshot?.machine.label || entry.machine_label} snapshot=${true} /></span>`;
      })}<span class="work-observation-note">${W.observationNote}</span></div>
      <button type="button" class="ghost" disabled=${loading}
        onClick=${() => setRevision(value => value + 1)}><span aria-hidden="true">↻</span> ${W.refresh}</button>
      ${(changed || revisionMismatch) && html`<p role="status" class="work-label">
        답변 뒤 갱신됨 · 현재 스냅샷을 표시합니다.</p>`}
    </header>
    <div class="work-body">
      ${selected ? html`<button type="button" class="ghost" onClick=${() => select(null)}>← 모든 세션</button>`
        : html`<label class="work-label" for="work-query">${W.search}</label>
          <input id="work-query" class="work-search" type="search" value=${query}
            placeholder=${W.searchPlaceholder} aria-describedby="work-search-hint"
            onInput=${event => setQuery(event.target.value)} />
          <p id="work-search-hint" class="work-label">${W.searchHint}</p>
          <div class="work-filter-row">
            <div class="board-filter"><${Dropdown} wide ariaLabel=${W.machine} value=${machine}
              onChange=${setMachine} options=${[{ value: '', label: `${W.machine}: ${W.all}` },
                ...machines.map(option => ({ ...option, label: `${W.machine}: ${option.label}` }))]} /></div>
            <div class="board-filter"><${Dropdown} wide ariaLabel=${W.tool} value=${provider}
              onChange=${setProvider} options=${[{ value: '', label: `${W.tool}: ${W.all}` },
                { value: 'claude', label: `${W.tool}: Claude` },
                { value: 'codex', label: `${W.tool}: Codex` }]} /></div>
          </div>`}
      <p class="work-label" role="status">${loading ? W.loading(load.done, load.total)
        : `${W.results(results.length)} · ${query.trim() ? W.searchOrder : W.order}`}</p>
      ${error && html`<p role="alert">${W.error}</p>`}
      ${!loading && !error && !selected && results.length === 0 && html`<p>${cards.length ? W.noResults : W.empty}</p>`}
      ${selected && !currentCard && !loading && html`<p>현재 스냅샷에 없는 세션</p>`}
      <div class="work-grid ${selected ? 'session-timeline' : 'session-rows'}">
        ${selected ? currentCard && html`<${SessionCard} key=${`${currentCard.key}:timeline`}
          card=${currentCard} query=${query} now=${now} timeline=${true} />`
          : results.map(card => html`<${SessionRow} key=${card.key} card=${card} query=${query} now=${now}
              onOpen=${key => select({ key, rev: load.rev })} />`)}
      </div>
      <${Coverage} load=${load} />
    </div>
  </section>`;
}
