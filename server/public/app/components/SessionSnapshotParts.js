import { h } from '../../vendor/preact.module.js';
import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import htm from '../../vendor/htm.module.js';
import { WORK_BOARD_LABELS as W } from '../lib/copy.js';
import { snapshotCards, rankCards, highlightParts, matchedLines,
  coverageCounts, formatLocalSnapshotTime, cardLineVisibility,
  displayInstructionText, sessionDisplayTitle, sessionDisplayState, sessionDisplayStatusLabel
} from '../lib/workBoard.js';

const html = htm.bind(h);

export function SnapshotTime({ value, now, relativeOnly = false, snapshot = false, label = '' }) {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return html`<span>${label ? `${label} · ${W.timeUnknown}` : W.timeUnknown}</span>`;
  const minutes = Math.floor((now - epoch) / 60000);
  const relative = minutes < 0 ? W.future : minutes < 1 ? W.secondsAgo : minutes < 60
    ? W.minutesAgo(minutes) : minutes < 1440 ? W.hoursAgo(Math.floor(minutes / 60))
      : W.daysAgo(Math.floor(minutes / 1440));
  const absolute = formatLocalSnapshotTime(value, now);
  const text = relativeOnly ? relative : snapshot ? `${relative} ${W.snapshot} · ${absolute}`
    : `${relative} · ${absolute}`;
  return html`<time dateTime=${value}>${label ? `${label} · ${text}` : text}</time>`;
}

export function Highlight({ text, query, transformed = false }) {
  if (transformed) return String(text || '').split(/(\[붙여넣은 내용\])/u).map(part =>
    part === '[붙여넣은 내용]' ? html`<span class="session-pasted-label">${part}</span>` : part);
  return highlightParts(text, query).map((part, index) => part.highlighted
    ? html`<mark key=${index}>${part.text}</mark>` : part.text);
}

export function Instruction({ instruction, query, now }) {
  const text = displayInstructionText(instruction.text);
  const transformed = !instruction.text_missing && text !== instruction.text;
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
      text=${instruction.text_missing ? W.missing : text} query=${query} transformed=${transformed} /></p>
    <button class="ghost session-selector-copy" type="button" onClick=${copy}>${W.copy}</button>
    <span role="status">${copyState === 'copied' ? W.copied : copyState === 'fallback' ? W.copyFallback : ''}</span>
    ${copyState === 'fallback' && html`<input ref=${selectorRef} class="work-selector"
      aria-label=${W.selector} value=${selector} readOnly />`}
  </li>`;
}

export function SessionRow({ card, query, now, onOpen, compact = false, selected = false }) {
  const title = sessionDisplayTitle(card);
  const recent = card.recent || (card.instructions.length ? W.missing : W.noInstruction);
  const displayState = sessionDisplayState(card, now);
  const stateLabel = sessionDisplayStatusLabel(card, now);
  return html`<button class="ghost work-card session-row" type="button"
    data-session-key=${card.key} aria-current=${selected ? 'true' : null}
    aria-label=${`${card.machine.label} · ${title} · ${stateLabel}`} onClick=${() => onOpen(card.key)}>
    <span class="work-title"><span class="session-status-dot ${displayState}"
      title=${stateLabel} aria-label=${stateLabel} /><${Highlight} text=${title} query=${query}
      transformed=${card.titleTransformed} /></span>
    <span class="work-meta">${`${card.machine.label} · ${card.repo_label || W.repoUnknown} · `}
      <${SnapshotTime} value=${card.last_record_at} now=${now} relativeOnly=${true} />
      ${!compact && html`<span class="work-orca">${` · ${stateLabel}`}</span>`}
    </span>
    ${!compact && html`<span class="work-recent"><${Highlight} text=${recent} query=${query}
      transformed=${card.recentTransformed} /></span>`}
  </button>`;
}

export function SessionCard({ card, query, rank, now, onOpen, timeline = false, showStatus = true }) {
  const [expanded, setExpanded] = useState(timeline);
  const first = card.first_instruction === 'unrecoverable' ? W.unrecoverable
    : card.first_instruction === 'unknown' ? W.unknownFirst : card.first || W.missing;
  const titleFallback = card.first_instruction === 'unrecoverable' ? W.unrecoverable
    : card.first_instruction === 'unknown' ? W.unknownFirst : W.noTextInstruction;
  const title = card.title || titleFallback;
  const recent = card.recent || (card.instructions.length ? W.missing : W.noInstruction);
  const { omitRecent, showFirst } = cardLineVisibility(title, recent, card.showFirst ? first : null);
  const timelineId = `work-timeline-${encodeURIComponent(card.key)}`;
  return html`<article class="work-card">
    <div class="work-meta">
      ${rank && html`<span class="work-rank">${rank}</span>`}
      <span class="work-pill">${card.machine.label}</span>
      <span>${card.provider === 'claude' ? 'Claude' : 'Codex'}</span>
      <span class="work-repo">${card.repo_label || W.repoUnknown}</span>
      <span>${card.git_branch || W.branchUnknown}</span>
    </div>
    <div><span class="work-label">${card.titleSource === 'ai' ? W.aiTitle : W.first}</span>
      <h2 class="work-title"><${Highlight} text=${title} query=${query}
        transformed=${card.titleTransformed} /></h2></div>
    ${card.first_instruction !== 'recoverable' && html`<p class="work-first-status work-label">
      ${card.first_instruction === 'unrecoverable' ? W.unrecoverable : W.unknownFirst}</p>`}
    ${!omitRecent && html`<div class="work-recent-block">
      <span class="work-label"><${SnapshotTime} value=${card.recentAt} now=${now}
        label=${W.recent} relativeOnly=${true} /></span>
      <p class="work-recent"><${Highlight} text=${recent} query=${query}
        transformed=${card.recentTransformed} /></p></div>`}
    ${showFirst && html`<div class="work-first-block"><span class="work-label">${W.first}</span>
      <p class="work-first"><${Highlight} text=${first} query=${query}
        transformed=${card.firstTransformed} /></p></div>`}
    ${card.match && html`<div class="work-match">
      <span class="work-label">${card.match.target === 0 ? W.instructionMatch : W.titleMatch}</span>
      <p><${Highlight} text=${matchedLines(card.match.text, query)} query=${query} /></p>
    </div>`}
    <div class="work-meta"><span>${W.lastObserved}</span>
      <${SnapshotTime} value=${card.last_record_at} now=${now} /></div>
    ${showStatus && html`<div class="work-meta work-orca"><span>${W.states[card.status.state]}</span>
      <${SnapshotTime} value=${card.status.evidence_at} now=${now} label="근거" /></div>`}
    ${(card.compact_only_history || card.unknown_count > 0) && html`<div class="work-meta">
      ${card.compact_only_history && html`<span class="work-warning">${W.compact}</span>`}
      ${card.unknown_count > 0 && html`<span class="work-warning">
        ${W.unknownRatio(card.unknown_count, card.unknown_count + card.instruction_count)}</span>`}
    </div>`}
    <footer class="work-card-footer"><span>${W.instructions(card.instruction_total)}</span>
      <button class="ghost" type="button" aria-label=${onOpen ? `${card.machine.label} · ${title} · ${W.timeline}`
        : undefined} aria-expanded=${expanded}
        aria-controls=${timelineId} onClick=${() => onOpen ? onOpen(card.key) : setExpanded(value => !value)}>
        ${expanded ? W.closeTimeline : W.timeline}</button></footer>
    <div id=${timelineId} class="work-timeline" hidden=${!expanded}>
      ${expanded && (card.instructions.length === 0 ? html`<p>${W.timelineEmpty}</p>` : html`<ol>
        ${[...card.instructions].reverse().map(instruction => html`<${Instruction} key=${instruction.id}
          instruction=${instruction} query=${query} now=${now} />`)}
      </ol>`)}</div>
  </article>`;
}

export function Coverage({ load }) {
  return html`<section class="work-coverage" aria-labelledby="work-coverage-title">
    <h2 id="work-coverage-title">${W.coverage}</h2>
    ${[...load.snapshots].sort((a, b) => a.machine.id < b.machine.id ? -1 : 1).map(snapshot => html`
      <div class="work-coverage-machine" key=${snapshot.machine.id}>
        <h3>${snapshot.machine.label}</h3><dl>
          ${Object.entries(coverageCounts(snapshot.coverage)).map(([key, value]) => html`
            <div key=${key}><dt>${W.coverageFields[key]}</dt><dd>${value}</dd></div>`)}
          <div><dt>${W.unverifiedSessions}</dt>
            <dd>${snapshot.sessions.filter(session => session.format_unverified).length}</dd></div>
          <div><dt>Orca</dt><dd>${W.orcaStates[snapshot.coverage.orca.state]}</dd></div>
        </dl>
      </div>`)}
    ${load.failures.map((entry, index) => html`<p key=${index} class="work-failure">
      ${entry.machine_label || entry.machine_id || W.unnamedFailure} · ${W.machineFailure}</p>`)}
  </section>`;
}
