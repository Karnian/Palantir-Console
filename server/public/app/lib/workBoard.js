// Session snapshot board: spec §6. No persistent client state.
// Display only: input is already sanitized. Keep payloads literal and search the original text.
export function displayInstructionText(text) {
  if (typeof text !== 'string') return text;
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
      ...session, machine: snapshot.machine, instructions, recent, first,
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
      'invalid_time_withheld']),
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
