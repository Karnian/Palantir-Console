// Session snapshot board: spec §6. No persistent client state.
// Display only: input is already sanitized. Keep payloads literal and search the original text.
export function displayInstructionText(text) {
  if (typeof text !== 'string') return text;
  const pasted = text.replace(/<pasted_content\b[^>]*>\s*/giu, '[붙여넣은 내용] ')
    .replace(/\s*<\/pasted_content\s*>(\s*)/giu,
      (tag, after, offset, source) => offset + tag.length === source.length ? ''
        : /[\r\n\u2028\u2029]/u.test(after) ? '\n' : ' ');
  if (pasted !== text) text = pasted.replace(/\[붙여넣은 내용\] $/u, '[붙여넣은 내용]');
  const trimmed = text.trim();
  const tags = /<command-(name|message|args)>([\s\S]*?)<\/command-\1>/gu;
  const values = {};
  let end = 0;
  for (const match of trimmed.matchAll(tags)) {
    if (trimmed.slice(end, match.index).trim()) return text;
    if (Object.hasOwn(values, match[1])) return text;
    if (match[2].includes('<command-')) return text;
    values[match[1]] = match[2];
    end = match.index + match[0].length;
  }
  if (!values.name || trimmed.slice(end).trim()) return text;
  if (!values.name.trim().replace(/^\/+/u, '').trim()) return text;
  const name = values.name.replace(/^\/+/u, '');
  if (values.message !== undefined && values.message.trim().replace(/^\/+/u, '') !== name) return text;
  const args = values.args || '';
  return `/${name}${args ? ` ${args}` : ''}`;
}

// A readable title is shared by compact rows, evidence chips and tool summaries.
export function sessionDisplayTitle(card) {
  const first = card.first_instruction === 'recoverable'
    ? displayInstructionText(card.instructions?.[0]?.text) || card.first : card.first;
  const meaningful = card.instructions?.filter(instruction => !instruction.text_missing)
    .map(instruction => displayInstructionText(instruction.text)) || [];
  const candidates = [card.ai_title, first, ...meaningful, card.recent];
  if (!card.ai_title && !first && !card.instructions?.length) candidates.unshift(card.title);
  const lines = candidates.map(candidate => String(displayInstructionText(candidate) || '').split(/\r?\n/u)
    .map(value => value.trim()).find(value => value && !/^(?:<?[a-z][a-z0-9+.-]*:\/\/|www\.)/iu.test(value)))
    .filter(Boolean);
  return lines.find(line => !/^\/[A-Za-z][\w-]*(?:\s|$)/u.test(line)) || lines[0]
    || `세션 ${String(card.key || '').slice(-6)}`;
}

export function sessionEvidenceLabel(card) {
  return `${card.machine.label} · ${Array.from(sessionDisplayTitle(card)).slice(0, 24).join('')}`;
}

export function sessionDisplayState(card) {
  return card.status?.state || 'unknown';
}
export function sessionHasOldTranscript(card, now = Date.now()) {
  const status = card.status || { state: 'unknown' };
  const evidence = Date.parse(status.evidence_at);
  return status.state === 'working' && status.source === 'transcript' && Number.isFinite(evidence)
    && now - evidence > 30 * 60000;
}
export function sessionDisplayStatusLabel(card, now = Date.now()) {
  const labels = { waiting: '입력 대기', working: '작업 중', ended: '응답 끝남',
    interrupted: '중단됨', unknown: '알 수 없음' };
  const label = labels[sessionDisplayState(card)] || labels.unknown;
  if (!sessionHasOldTranscript(card, now)) return label;
  const minutes = Math.floor((now - Date.parse(card.status.evidence_at)) / 60000);
  const age = minutes < 60 ? `${minutes}분 전` : minutes < 1440
    ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
  return `${label} · 마지막 기록 ${age}`;
}

export function normalizeSearch(text) {
  const spaced = String(text || '').normalize('NFC').toLowerCase();
  return { spaced, compact: spaced.replace(/\s/gu, '') };
}

const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const epoch = value => Date.parse(value) || 0;
const firstLine = instruction => instruction?.text_missing
  ? null : displayInstructionText(instruction?.text)?.split(/\r?\n/u).find(line => line.trim() !== '') || null;
const instructionTransformed = instruction => !instruction?.text_missing
  && displayInstructionText(instruction?.text) !== instruction?.text;
const displayKey = text => String(text || '').normalize('NFC').trim().replace(/\s+/gu, ' ');

// Spec §6: compare display lines without changing their rendered text.
export function cardLineVisibility(title, recent, first) {
  const [titleKey, recentKey, firstKey] = [title, recent, first].map(displayKey);
  return {
    omitRecent: !!recentKey && recentKey === titleKey,
    showFirst: !!firstKey && firstKey !== titleKey && firstKey !== recentKey,
  };
}

export function formatLocalSnapshotTime(value, now = Date.now()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = number => String(number).padStart(2, '0');
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `${date.getFullYear()}/`;
  return `${year}${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function snapshotCards(snapshot) {
  const bySession = new Map();
  for (const instruction of snapshot.instructions) {
    if (!bySession.has(instruction.session_key)) bySession.set(instruction.session_key, []);
    bySession.get(instruction.session_key).push(instruction);
  }
  const agents = snapshot.orca.worktrees.flatMap(tree => tree.agents);
  return snapshot.sessions.map(session => {
    const instructions = (bySession.get(session.key) || []).sort((a, b) => a.seq - b.seq);
    const recent = firstLine(instructions.at(-1));
    const first = session.first_instruction === 'recoverable' ? firstLine(instructions[0]) : null;
    const titleInstruction = instructions.find(instruction => firstLine(instruction) !== null);
    const aiTitle = displayKey(session.ai_title) ? session.ai_title : null;
    const title = aiTitle ? displayInstructionText(aiTitle) : firstLine(titleInstruction);
    return {
      ...session,
      status: session.status || { state: 'unknown', source: 'none', evidence_at: null, reason: null },
      machine: snapshot.machine, instructions, recent, first,
      ai_title: aiTitle, title, titleSource: aiTitle ? 'ai' : 'first',
      titleTransformed: aiTitle ? title !== aiTitle : instructionTransformed(titleInstruction),
      recentTransformed: instructionTransformed(instructions.at(-1)),
      firstTransformed: session.first_instruction === 'recoverable' && instructionTransformed(instructions[0]),
      ...cardLineVisibility(title, recent, first),
      recentAt: instructions.at(-1)?.ts || null,
      recentMissing: !!instructions.at(-1)?.text_missing,
      agent: session.orca_link.confirmed
        ? agents.find(agent => agent.pane_key === session.orca_link.pane_key) || null : null,
    };
  });
}

function compareScore(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function matchText(text, query) {
  const needle = normalizeSearch(query);
  if (!needle.compact) return null;
  const haystack = normalizeSearch(text);
  for (const [form, key] of ['spaced', 'compact'].entries()) {
    const position = haystack[key].indexOf(needle[key]);
    if (position >= 0) return { form, position, length: needle[key].length };
  }
  return null;
}

export function rankCards(cards, query, machine = '', provider = '') {
  const filtered = cards.filter(card => (!machine || card.machine.id === machine)
    && (!provider || card.provider === provider));
  const searching = !!normalizeSearch(query).compact;
  return filtered.map(card => {
    let match = null;
    if (searching) {
      const targets = card.instructions.map(instruction => ({
        text: instruction.text, ts: instruction.ts, target: 0, instruction,
      }));
      if (card.ai_title) targets.push({ text: card.ai_title, ts: card.last_record_at, target: 1 });
      for (const candidate of targets) {
        const found = matchText(candidate.text, query);
        if (!found) continue;
        const score = [candidate.target, found.form, found.position, -epoch(candidate.ts)];
        if (!match || compareScore(score, match.score) < 0) match = { ...candidate, ...found, score };
      }
    }
    return { ...card, match };
  }).filter(card => !searching || card.match).sort((a, b) => {
    const score = searching ? compareScore(a.match.score, b.match.score) : 0;
    return score || epoch(b.last_record_at) - epoch(a.last_record_at) || lexical(a.key, b.key);
  });
}

// Map normalized graphemes back to original text offsets, including NFC expansion.
export function highlightParts(text, query) {
  text = String(text || '');
  const match = matchText(text, query);
  if (!match) return [{ text, highlighted: false }];
  const map = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const { segment, index } of segmenter.segment(text)) {
    let normalized = segment.normalize('NFC').toLowerCase();
    if (match.form === 1) normalized = normalized.replace(/\s/gu, '');
    for (let i = 0; i < normalized.length; i++) map.push([index, index + segment.length]);
  }
  const start = map[match.position][0];
  const end = map[match.position + match.length - 1][1];
  return [
    { text: text.slice(0, start), highlighted: false },
    { text: text.slice(start, end), highlighted: true },
    { text: text.slice(end), highlighted: false },
  ].filter(part => part.text);
}

export function matchedLines(text, query) {
  const parts = highlightParts(text, query);
  const start = parts[0]?.highlighted ? 0 : parts[0]?.text.length || 0;
  const marked = parts.find(part => part.highlighted);
  if (!marked) return text;
  const end = start + marked.text.length;
  return text.slice(text.lastIndexOf('\n', start - 1) + 1,
    text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end));
}

export function coverageCounts(coverage) {
  const sources = [coverage.claude, coverage.codex];
  const sum = names => sources.reduce((total, source) =>
    total + names.reduce((n, key) => n + (source[key] || 0), 0), 0);
  return {
    scanned: sum(['files_scanned']), skipped: sum(['files_skipped']), failed: sum(['files_failed']),
    excluded: sum(['excluded_sessions']), deleted: sum(['deleted_instructions']),
    unknown: sum(['records_unknown']), unverified: sum(['records_unverified']),
    exec: sum(['exec_sessions_excluded']),
    withheld: sum(['withheld_sessions', 'multi_file_withheld', 'mixed_session_withheld',
      'invalid_time_withheld', 'large_file_withheld', 'queued_duplicate_withheld']),
  };
}

export async function loadWorkSnapshots(request, signal, publish) {
  const { snapshots: entries } = await request('/api/observe/snapshots', { signal, allowAppForbidden: true });
  if (signal.aborted) return;
  const result = { entries, snapshots: [], failures: [], done: 0, total: entries.length };
  const emit = () => { if (!signal.aborted) publish({ ...result,
    snapshots: [...result.snapshots], failures: [...result.failures] }); };
  emit();
  await Promise.all(entries.map(async entry => {
    try {
      if (!entry.machine_id) throw new Error('unavailable');
      const snapshot = await request(`/api/observe/snapshots/${encodeURIComponent(entry.machine_id)}`,
        { signal, allowAppForbidden: true });
      if (!signal.aborted) result.snapshots.push(snapshot);
    } catch (error) {
      if (!signal.aborted) result.failures.push(entry);
      if (error.message === 'Not authenticated') {
        throw error;
      }
    } finally {
      result.done++;
      emit();
    }
  }));
}

// Confirm one complete observe generation; a changed detail restarts the entire list.
export async function loadSessionSnapshots(request, signal, publish) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      const list = await request('/api/observe/snapshots',
        { signal: controller.signal, allowAppForbidden: true });
      if (signal.aborted) return;
      const result = { entries: list.snapshots, snapshots: [], failures: [],
        done: 0, total: list.snapshots.length, rev: null };
      const emit = () => publish({ ...result, snapshots: [...result.snapshots], failures: [...result.failures] });
      emit();
      let changed = false;
      let unconfirmed = false;
      const details = Promise.all(list.snapshots.map(async entry => {
        try {
          if (!entry.machine_id || !entry.sha256 || entry.error_code) {
            if (entry.machine_id && !entry.error_code) unconfirmed = true;
            result.failures.push(entry); return;
          }
          const path = `/api/observe/snapshots/${encodeURIComponent(entry.machine_id)}`;
          const snapshot = await request(`${path}?sha256=${encodeURIComponent(entry.sha256)}`,
            { signal: controller.signal, allowAppForbidden: true });
          if (!controller.signal.aborted) result.snapshots.push(snapshot);
        } catch (error) {
          if (error.status === 409) { changed = true; controller.abort(); }
          else if (error.message === 'Not authenticated') throw error;
          else if (!controller.signal.aborted) { unconfirmed = true; result.failures.push(entry); }
        } finally { result.done++; }
      }));
      await Promise.race([details, new Promise(resolve => {
        if (controller.signal.aborted) resolve();
        else controller.signal.addEventListener('abort', resolve, { once: true });
      })]);
      if (signal.aborted) return;
      if (changed) {
        if (attempt === 3) throw new Error('snapshot_changed');
        continue;
      }
      result.rev = unconfirmed ? null : list.rev;
      emit();
      return;
    } finally {
      controller.abort();
      signal.removeEventListener('abort', abort);
    }
  }
}

// Spec §6 entry: fallback and any user navigation permanently close default selection.
export function startObserveEntry({ request, getHash, navigate, subscribe, publish,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const controller = new AbortController();
  let moved = !!getHash();
  let fallback = false;
  let activation = 'pending';
  const emit = () => publish({ activation, loading: activation === 'pending' && !fallback && !moved && !getHash() });
  const unsubscribe = subscribe(() => { moved = true; emit(); });
  const timer = setTimer(() => { fallback = true; emit(); }, 1500);
  const settle = value => {
    if (controller.signal.aborted) return;
    activation = value;
    clearTimer(timer);
    if (value === 'on' && !fallback && !moved && !getHash()) navigate('work');
    emit();
  };
  request('/api/observe/snapshots', { signal: controller.signal, expectedStatus: 200, allowAppForbidden: true })
    .then(() => settle('on'), error => settle(error.status === 404 ? 'off' : 'error'));
  emit();
  return () => { controller.abort(); clearTimer(timer); unsubscribe(); };
}
