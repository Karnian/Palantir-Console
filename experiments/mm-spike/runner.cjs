'use strict';
// Stage-1 runner: inject an arm's memory under a CONSTANT frame + single-artifact task, get model output,
// parse the structured {"artifact":"..."} field (Codex must-fix #3), score honored = required AND NOT forbidden.
// callModel(prompt)->raw model text is injected (mock for self-test; codex/gemini CLI for real).
const { SCENARIOS } = require('./scenarios.cjs');
const store = require('./store.cjs');
const { seedScenario, buildArms, ARMS } = require('./harness.cjs');

// constant frame: only inner CONTENT differs across arms (prevents framing/authority confound). Structured JSON out.
function buildPrompt(sc, armText) {
  const ctx = armText && armText.trim()
    ? `Relevant context from your memory of this user:\n${armText}\n\n`
    : '';
  return `You are a coding assistant helping this specific user.\n${ctx}Task: ${sc.task}\n` +
    `Respond with ONLY a single JSON object of the form {"artifact":"<the requested artifact>"} — no markdown fences, no explanation, nothing else.`;
}

// parse the artifact field from (possibly scaffold-wrapped) model output; robust fallbacks
function extractArtifact(output) {
  const s = String(output ?? '');
  const m = s.match(/\{[^{}]*"artifact"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/);
  if (m) { try { return String(JSON.parse(m[0]).artifact ?? ''); } catch { return m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'); } }
  const after = s.split(/tokens used\s*\n[\d,]+/i).pop();          // strip codex transcript footer
  const fence = after.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  return (fence ? fence[1] : after).trim();
}

function score(sc, output) {
  const artifact = extractArtifact(output);
  sc.required.lastIndex = 0; sc.forbidden.lastIndex = 0;
  const formatOk = artifact.length > 0;
  const honored = formatOk && sc.required.test(artifact) && !sc.forbidden.test(artifact);
  return { honored, artifact, formatOk };
}

async function runCell(sc, armText, callModel) {
  const output = await callModel(buildPrompt(sc, armText));
  return score(sc, output);
}

async function runMatrix({ scenarios = SCENARIOS, arms = ARMS, gens = 3, callModel, onProgress }) {
  const perArm = Object.fromEntries(arms.map((a) => [a, { honored: 0, total: 0 }]));
  const perScenario = [];
  let errors = 0;
  for (const sc of scenarios) {
    const db = store.open(':memory:');
    const { truthId } = seedScenario(db, sc);
    const built = buildArms(db, sc, truthId);
    db.close();
    const row = { id: sc.id, kind: sc.kind, byArm: {} };
    for (const a of arms) {
      let h = 0;
      for (let g = 0; g < gens; g++) {
        perArm[a].total++;
        try {
          const { honored } = await runCell(sc, built[a], callModel);
          if (honored) { h++; perArm[a].honored++; }
        } catch (e) { errors++; }
      }
      row.byArm[a] = h / gens;
    }
    perScenario.push(row);
    if (onProgress) onProgress(row);
  }
  const rate = Object.fromEntries(arms.map((a) => [a, perArm[a].total ? perArm[a].honored / perArm[a].total : null]));
  return { rate, perScenario, perArm, errors };
}

module.exports = { buildPrompt, extractArtifact, score, runCell, runMatrix };

// ---- scorer self-test (0 LLM): JSON-wrapped mock outputs, incl. codex-transcript scaffold ----
if (require.main === module) {
  const sc01 = SCENARIOS.find((s) => s.id === 'sc01');
  const sc10 = SCENARIOS.find((s) => s.id === 'sc10');
  const cases = [
    [sc01, '{"artifact":"node --test test/utils.test.js"}', true, 'clean JSON compliant'],
    [sc01, '{"artifact":"npx jest test/utils.test.js"}', false, 'JSON uses jest'],
    [sc01, '{"artifact":"node --test"}', true, 'negative-mention no longer leaks (jest outside artifact)'],
    [sc01, 'blah\ncodex\n{"artifact":"node --test x.js"}\ntokens used\n10,614\n', true, 'extract from codex scaffold'],
    [sc10, '{"artifact":"throw new Error(e.message)"}', true, 'rethrow'],
    [sc10, '{"artifact":"console.log(e); return null;"}', false, 'swallow'],
  ];
  let pass = 0;
  for (const [sc, out, expect, desc] of cases) {
    const { honored, artifact } = score(sc, out);
    const ok = honored === expect; if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${sc.id} expect=${expect} got=${honored}  [${desc}]  artifact="${artifact.slice(0, 36)}"`);
  }
  console.log(`\nscorer self-test: ${pass}/${cases.length} passed`);
  if (pass !== cases.length) process.exitCode = 1;
}
