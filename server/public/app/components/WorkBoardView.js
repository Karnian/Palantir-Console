import { h } from '../../vendor/preact.module.js';
import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { apiFetch } from '../lib/api.js';
import { WORK_BOARD_LABELS as W } from '../lib/copy.js';
import { snapshotCards, rankCards, highlightParts, matchedLines,
  coverageCounts, loadWorkSnapshots } from '../lib/workBoard.js';

const html = htm.bind(h);
const emptyLoad = () => ({ entries: [], snapshots: [], failures: [], done: 0, total: 0 });

function SnapshotTime({ value, now }) {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return html`<span>${W.timeUnknown}</span>`;
  const minutes = Math.floor((now - epoch) / 60000);
  const relative = minutes < 0 ? W.future : minutes < 1 ? W.secondsAgo : minutes < 60
    ? W.minutesAgo(minutes) : minutes < 1440 ? W.hoursAgo(Math.floor(minutes / 60))
      : W.daysAgo(Math.floor(minutes / 1440));
  return html`<time dateTime=${value}>${relative} · ${W.absolute(new Date(epoch).toISOString())}</time>`;
}

function Highlight({ text, query }) {
  return highlightParts(text, query).map((part, index) => part.highlighted
    ? html`<mark key=${index}>${part.text}</mark>` : part.text);
}

function Instruction({ instruction, query, now }) {
  const [copyState, setCopyState] = useState('');
  const alive = useRef(true);
  const selectorRef = useRef(null);
  const selector = `${instruction.id}#${instruction.ref}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (copyState === 'fallback') { selectorRef.current?.focus(); selectorRef.current?.select(); }
  }, [copyState]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(selector);
      if (alive.current) setCopyState('copied');
    } catch {
      if (alive.current) setCopyState('fallback');
    }
  };
  return html`<li class="work-event">
    <div class="work-meta"><${SnapshotTime} value=${instruction.ts} now=${now} />
      <span class="work-pill">${W.kinds[instruction.kind]}</span>
      ${instruction.truncated && html`<span class="work-warning">${W.truncated}</span>`}
      ${instruction.redacted && html`<span class="work-warning">${W.redacted}</span>`}
      <span>${W.attachments(instruction.attachments)}</span>
      ${instruction.unknown_blocks > 0 && html`<span>${W.unknownBlocks(instruction.unknown_blocks)}</span>`}
    </div>
    <p class="work-instruction"><${Highlight}
      text=${instruction.text_missing ? W.missing : instruction.text} query=${query} /></p>
    <button class="work-button" type="button" onClick=${copy}>${W.copy}</button>
    <span role="status">${copyState === 'copied' ? W.copied : copyState === 'fallback' ? W.copyFallback : ''}</span>
    ${copyState === 'fallback' && html`<input ref=${selectorRef} class="work-selector"
      aria-label=${W.selector} value=${selector} readOnly />`}
  </li>`;
}

function SessionCard({ card, query, rank, now }) {
  const [expanded, setExpanded] = useState(false);
  const first = card.first_instruction === 'unrecoverable' ? W.unrecoverable
    : card.first_instruction === 'unknown' ? W.unknownFirst : card.first || W.missing;
  const timelineId = `work-timeline-${encodeURIComponent(card.key)}`;
  return html`<article class="work-card">
    <div class="work-meta">
      ${rank && html`<span class="work-rank">${rank}</span>`}
      <span class="work-pill">${card.machine.label}</span>
      <span>${card.provider === 'claude' ? 'Claude' : 'Codex'}</span>
      <span class="work-repo">${card.repo_label || W.repoUnknown}</span>
      <span>${card.git_branch || W.branchUnknown}</span>
    </div>
    <div><span class="work-label">${W.recent}</span>
      <h2 class="work-recent"><${Highlight}
        text=${card.recent || (card.recentMissing ? W.missing : W.noInstruction)} query=${query} /></h2></div>
    ${!card.omitFirst && html`<div><span class="work-label">${W.first}</span>
      <p class="work-first"><${Highlight} text=${first} query=${query} /></p></div>`}
    ${card.match && html`<div class="work-match">
      <span class="work-label">${card.match.target === 0 ? W.instructionMatch : W.titleMatch}</span>
      <p><${Highlight} text=${matchedLines(card.match.text, query)} query=${query} /></p>
    </div>`}
    ${card.ai_title && html`<p class="work-first">${W.aiTitle}: <${Highlight}
      text=${card.ai_title} query=${query} /></p>`}
    <div class="work-meta"><span>${W.lastObserved}</span>
      <${SnapshotTime} value=${card.last_record_at} now=${now} /></div>
    <div class="work-meta"><span>${card.orca_link.confirmed ? W.connected : W.unconfirmed}</span>
      ${card.orca_link.confirmed && card.orca_link.terminal_handle
        && html`<span>${card.orca_link.terminal_handle}</span>`}
      <span>${W.observed} · ${W.states[card.agent?.state || 'unknown']}</span>
    </div>
    <div class="work-meta">
      ${card.format_unverified && html`<span class="work-warning">${W.unverified}</span>`}
      ${card.compact_only_history && html`<span class="work-warning">${W.compact}</span>`}
      ${card.unknown_count > 0 && html`<span class="work-warning">
        ${W.unknownRatio(card.unknown_count, card.unknown_count + card.instruction_count)}</span>`}
    </div>
    <footer class="work-card-footer"><span>${W.instructions(card.instruction_count)}</span>
      <button class="work-button" type="button" aria-expanded=${expanded}
        aria-controls=${timelineId} onClick=${() => setExpanded(value => !value)}>
        ${expanded ? W.closeTimeline : W.timeline}</button></footer>
    <div id=${timelineId} class="work-timeline" hidden=${!expanded}>
      ${expanded && (card.instructions.length === 0 ? html`<p>${W.timelineEmpty}</p>` : html`<ol>
        ${[...card.instructions].reverse().map(instruction => html`<${Instruction} key=${instruction.id}
          instruction=${instruction} query=${query} now=${now} />`)}
      </ol>`)}</div>
  </article>`;
}

function FilterChips({ label, options, selected, onSelect }) {
  return html`<div class="work-filters" role="group" aria-label=${label}>
    <span class="work-label">${label}</span>
    ${[{ value: '', label: W.all }, ...options].map(option => html`<button type="button"
      key=${option.value} class="work-button work-chip" aria-pressed=${selected === option.value}
      onClick=${() => onSelect(option.value)}>${option.label}</button>`)}
  </div>`;
}

function Coverage({ load }) {
  return html`<section class="work-coverage" aria-labelledby="work-coverage-title">
    <h2 id="work-coverage-title">${W.coverage}</h2>
    ${[...load.snapshots].sort((a, b) => a.machine.id < b.machine.id ? -1 : 1).map(snapshot => html`
      <div class="work-coverage-machine" key=${snapshot.machine.id}>
        <h3>${snapshot.machine.label}</h3><dl>
          ${Object.entries(coverageCounts(snapshot.coverage)).map(([key, value]) => html`
            <div key=${key}><dt>${W.coverageFields[key]}</dt><dd>${value}</dd></div>`)}
          <div><dt>Orca</dt><dd>${W.orcaStates[snapshot.coverage.orca.state]}</dd></div>
        </dl>
      </div>`)}
    ${load.failures.map((entry, index) => html`<p key=${index} class="work-failure">
      ${entry.machine_label || entry.machine_id || W.unnamedFailure} · ${W.machineFailure}</p>`)}
  </section>`;
}

export function WorkBoardView({ activation = 'on' }) {
  const [load, setLoad] = useState(emptyLoad);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [machine, setMachine] = useState('');
  const [provider, setProvider] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (activation !== 'on') return;
    const controller = new AbortController();
    let active = true;
    setLoad(emptyLoad()); setLoading(true); setError(false);
    loadWorkSnapshots(apiFetch, controller.signal, setLoad).catch(() => {
      if (active) { controller.abort(); setLoad(emptyLoad()); setError(true); }
    }).finally(() => { if (active) setLoading(false); });
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [activation, revision]);
  const cards = useMemo(() => load.snapshots.flatMap(snapshotCards), [load.snapshots]);
  const results = useMemo(() => rankCards(cards, query, machine, provider), [cards, query, machine, provider]);
  const machines = load.entries.filter(entry => entry.machine_id)
    .map(entry => ({ value: entry.machine_id, label: entry.machine_label }));
  if (activation !== 'on') return html`<section data-view="work" class="work-board">
    <h1>${W.title}</h1><p role="status">${activation === 'pending' ? W.pending
      : activation === 'error' ? W.error : W.off}</p></section>`;
  return html`<section data-view="work" class="work-board">
    <header class="work-header">
      <div><h1>${W.title}</h1><p class="work-label">${W.description}</p></div>
      <div class="work-snapshot-times">${load.entries.filter(entry => entry.machine_id).map(entry => {
        const snapshot = load.snapshots.find(item => item.machine.id === entry.machine_id);
        return html`<span class="work-pill" key=${entry.machine_id}>
          ${snapshot?.machine.label || entry.machine_label} · ${W.snapshot} ·
          <${SnapshotTime} value=${snapshot?.generated_at || entry.generated_at} now=${now} /></span>`;
      })}</div>
      <button type="button" class="work-button" disabled=${loading}
        onClick=${() => setRevision(value => value + 1)}>${W.refresh}</button>
    </header>
    <div class="work-body">
      <label class="work-label" for="work-query">${W.search}</label>
      <input id="work-query" class="work-search" type="search" value=${query}
        placeholder=${W.searchPlaceholder} aria-describedby="work-search-hint"
        onInput=${event => setQuery(event.target.value)} />
      <p id="work-search-hint" class="work-label">${W.searchHint}</p>
      <div class="work-filter-row">
        <${FilterChips} label=${W.machine} options=${machines} selected=${machine} onSelect=${setMachine} />
        <${FilterChips} label=${W.tool} options=${[{ value: 'claude', label: 'Claude' },
          { value: 'codex', label: 'Codex' }]} selected=${provider} onSelect=${setProvider} />
      </div>
      <p class="work-label" role="status">${loading ? W.loading(load.done, load.total)
        : `${W.results(results.length)} · ${query.trim() ? W.searchOrder : W.order}`}</p>
      ${error && html`<p role="alert">${W.error}</p>`}
      ${!loading && !error && results.length === 0 && html`<p>${cards.length ? W.noResults : W.empty}</p>`}
      <div class="work-grid">${results.map((card, index) => html`<${SessionCard} key=${card.key}
        card=${card} query=${query} rank=${card.match ? index + 1 : null} now=${now} />`)}</div>
      <${Coverage} load=${load} />
    </div>
  </section>`;
}
