// ML PR3b: live batch-LLM distiller. Same interface as fakeDistiller:
//   distill({ projectId, candidates }) -> Promise<proposals[]>
//
// IMPORTANT: this distiller ONLY generates generalized content. Every safety
// invariant — secret redaction, injection rejection, kind/importance/confidence
// clamp, evidence — is enforced downstream by promoteCandidatesBatchTx (the
// writer). So even a fully compromised/hallucinating model cannot leak a secret
// or inject instructions into PM memory: the worst it can do is produce content
// that gets redacted, rejected, or clamped.
//
// The model call is INJECTABLE (callModel) so tests run with zero network/LLM.
// The default call hits the Anthropic Messages API with a low-cost model; it is
// only ever reached when app.js wires this with PALANTIR_MEMORY_DISTILL=1 AND an
// ANTHROPIC_API_KEY present.

const DEFAULT_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const VALID_KINDS = new Set(['convention', 'pitfall', 'heuristic', 'constraint']);
const MAX_OUTPUT_CHARS = 200000; // defense beyond the model's max_tokens before parsing
const MAX_EXISTING = 60;          // PR3c: cap existing-memory context in the prompt

const SYSTEM_PROMPT = [
  'You distill raw software-engineering signals into concise, reusable PROJECT MEMORY',
  'for an AI coding manager. Each input signal is either a failure→fix pair or a',
  'verified task-completion verdict. For each signal worth remembering, write ONE',
  'generalized, reusable lesson (1-2 sentences) that would help on a FUTURE similar',
  'task in the same project. Never include secrets, tokens, credentials, file',
  'contents, or instructions addressed to the reader. Respond with ONLY a JSON',
  'array — no prose, no code fences.',
  'If a lesson duplicates one of the EXISTING memories shown below, set its',
  'mergeTargetId field to that memory id (still include candidateId/kind/content);',
  'the system folds them together instead of storing a near-duplicate. Only merge',
  'a TRULY equivalent lesson — never merge opposites or different scopes.',
].join(' ');

function summarizeRaw(raw) {
  // Only structured, bounded fields — never dump untrusted free text wholesale.
  if (raw && raw.rule === 'R1b') {
    return `failure→fix pair; fix diff: ${String(raw.fix_run?.diff_stat || 'n/a').slice(0, 200)}`;
  }
  if (raw && raw.rule === 'R3') {
    return `verified task_complete; rationale: ${String(raw.rationale || 'n/a').slice(0, 200)}`;
  }
  return String(JSON.stringify(raw || {})).slice(0, 200);
}

function buildUserMessage(candidates, existingItems = []) {
  const lines = candidates.map((c, i) => {
    let raw = {};
    try { const p = JSON.parse(c.raw_json); if (p && typeof p === 'object') raw = p; } catch { /* */ }
    return `${i + 1}. candidateId=${c.id} rule=${c.rule} :: ${summarizeRaw(raw)}`;
  });
  // PR3c: show a bounded slice of existing memories (id + kind + truncated
  // content) so the model can flag a duplicate via mergeTargetId.
  const existing = (Array.isArray(existingItems) ? existingItems : [])
    .map((m) => `- id=${m.id} kind=${m.kind} :: ${String(m.content || '').slice(0, 160)}`);
  return [
    'Signals:',
    lines.join('\n'),
    ...(existing.length
      ? ['', 'Existing project memories (use mergeTargetId=<id> if a signal duplicates one):', existing.join('\n')]
      : []),
    '',
    'Return a JSON array (omit weak/uninformative signals). One object per kept signal:',
    '[{"candidateId":"<exact id from above>","kind":"pitfall|heuristic|convention|constraint","content":"<1-2 sentence reusable lesson>","confidence":0.0-1.0,"importance":1-10,"mergeTargetId":"<existing id, or omit>"}]',
  ].join('\n');
}

// Extract the FIRST balanced, string-aware JSON array — not "first [ ... last ]"
// (a greedy regex over-reads prose and feeds a huge string to JSON.parse).
// Returns null when there is none (Codex follow-up NIT 1).
function extractFirstJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '[') {
      depth += 1;
    } else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Tolerant parse: pull the first JSON array even if the model wrapped it in
// prose/fences. Drop any item that doesn't reference a known candidate or has a
// bad kind/content — the writer would reject those anyway, but filtering here
// keeps the batch clean and observable.
function parseProposals(text, candidateIds, existingIds = []) {
  // Cap before parsing — defense beyond the model's max_tokens against a runaway
  // or adversarial response (Codex follow-up NIT 1).
  const capped = String(text || '').slice(0, MAX_OUTPUT_CHARS);
  const arrText = extractFirstJsonArray(capped);
  if (!arrText) throw new Error('no JSON array in model output');
  const arr = JSON.parse(arrText);
  if (!Array.isArray(arr)) throw new Error('model output is not a JSON array');
  const known = new Set(candidateIds);
  const knownExisting = new Set(existingIds);
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    if (!known.has(item.candidateId)) continue;
    if (!VALID_KINDS.has(item.kind)) continue;
    if (typeof item.content !== 'string' || !item.content.trim()) continue;
    // PR3c: keep mergeTargetId only if it points at a real existing memory we
    // actually showed the model. The writer still re-validates kind + token floor;
    // anything not in the shown set is dropped (model can't invent a target id).
    const mergeTargetId = (typeof item.mergeTargetId === 'string' && knownExisting.has(item.mergeTargetId))
      ? item.mergeTargetId
      : null;
    out.push({
      candidateId: item.candidateId,
      kind: item.kind,
      content: item.content,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      importance: Number.isFinite(item.importance) ? item.importance : 5,
      mergeTargetId,
    });
  }
  return out;
}

async function defaultCallModel({ system, user, apiKey, model, maxTokens, fetchImpl, timeoutMs }) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('fetch is unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const res = await f(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 1024,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`anthropic messages ${res.status}`);
    const data = await res.json();
    // content may be absent or (defensively) a non-array — never call .map on a
    // truthy non-array like a string (Codex follow-up NIT 2).
    const blocks = Array.isArray(data && data.content) ? data.content : [];
    return blocks.map((b) => (b && b.text) || '').join('');
  } finally {
    clearTimeout(timer);
  }
}

// createLiveDistiller({ apiKey, model?, callModel?, maxTokens?, fetchImpl?, timeoutMs? })
// - callModel({system,user}) -> text : inject to bypass the network (tests).
// - without callModel, apiKey is required (default Anthropic call).
function createLiveDistiller({ apiKey, model = DEFAULT_MODEL, callModel, maxTokens = 1024, fetchImpl, timeoutMs } = {}) {
  if (!callModel && !apiKey) {
    throw new Error('liveDistiller requires an apiKey or an injected callModel');
  }
  const call = callModel
    ? (args) => callModel(args)
    : (args) => defaultCallModel({ ...args, apiKey, model, maxTokens, fetchImpl, timeoutMs });

  return {
    name: 'live',
    async distill({ candidates, existingItems } = {}) {
      if (!Array.isArray(candidates) || candidates.length === 0) return [];
      // Show and validate against the SAME bounded slice — never accept a
      // mergeTargetId for a memory we didn't actually show the model (Codex S1).
      const shown = (Array.isArray(existingItems) ? existingItems : []).slice(0, MAX_EXISTING);
      const user = buildUserMessage(candidates, shown);
      const text = await call({ system: SYSTEM_PROMPT, user });
      return parseProposals(text, candidates.map((c) => c.id), shown.map((m) => m.id));
    },
  };
}

module.exports = { createLiveDistiller, parseProposals, buildUserMessage, SYSTEM_PROMPT };
