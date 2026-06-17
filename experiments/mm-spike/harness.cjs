'use strict';
// Kill-test harness: seed per-scenario store, build the 8 arms, and run the DETERMINISTIC leakage audit (0 LLM).
// Codex "cheaper first experiment": before spending any LLM budget, verify scenarios can SEPARATE A7 from baselines.
const store = require('./store.cjs');
const { SCENARIOS } = require('./scenarios.cjs');

const DISTRACTORS = ['naming things is hard', 'prefer small PRs', 'document the why not the what'];

function seedScenario(db, sc) {
  const evIds = sc.rawEvents.map((t) =>
    store.ingestEvent(db, { source: 'conversation', event_type: 'message', actor: 'human', project_id: null, content_redacted: t }));
  const truthId = store.upsertClaim(db, { subject: sc.subject, predicate: sc.predicate, object_json: sc.truth,
    kind: 'constraint', page: sc.page, slot_key: sc.slot, source_kind: 'human', confidence: 1.0, importance: 8 }, evIds);
  // same-slot mate (A5c placebo) + recency fillers (A1 buries truth)
  store.upsertClaim(db, { subject: sc.subject, predicate: 'note', object_json: sc.distractorSlotMate,
    kind: 'preference', page: sc.page, slot_key: sc.slot, source_kind: 'human', confidence: 0.6, importance: 4 });
  DISTRACTORS.forEach((d) => store.upsertClaim(db, { subject: sc.subject, predicate: 'note', object_json: d,
    kind: 'preference', page: sc.page, slot_key: 'misc', source_kind: 'human', confidence: 0.5, importance: 3 }));
  return { truthId };
}

const render = (subj, pred, obj) => `## User Memory\n- ${subj} ${pred}: ${obj}`;

function buildArms(db, sc, truthId) {
  const rawTop3 = store.retrieveRaw(db, sc.task, 3);
  const rawTop = rawTop3[0];
  const slotMate = store.claimsBySlot(db, sc.page, sc.slot, truthId)[0];
  const recent = store.recentClaims(db, 3);
  return {
    A0: '',
    A1: '## User Memory\n' + recent.map((c) => `- ${c.subject} ${c.predicate}: ${c.object_json}`).join('\n'),
    A4: rawTop ? rawTop.text : '',
    A4k: rawTop3.map((r) => r.text).join('\n---\n'), // steelman: raw top-3 (sees stale+current; model can resolve)
    A5: render(sc.subject, sc.predicate, '[value withheld]'),
    A6: sc.truth,
    A5c: slotMate ? render(sc.subject, slotMate.predicate, slotMate.object_json) : '',
    A7p: render(sc.subject, sc.predicate, sc.wrong),
    A7: render(sc.subject, sc.predicate, sc.truth),
  };
}

const ARMS = ['A0', 'A1', 'A4', 'A5', 'A6', 'A5c', 'A7p', 'A7'];

function audit() {
  const rows = [];
  let sep = 0, sat = 0;
  const anomalies = [];
  for (const sc of SCENARIOS) {
    const db = store.open(':memory:');
    const { truthId } = seedScenario(db, sc);
    const arms = buildArms(db, sc, truthId);
    const leak = {};
    for (const a of ARMS) { sc.decisive.lastIndex = 0; leak[a] = sc.decisive.test(arms[a]); }
    db.close();
    // expected invariants: A7 & A6 expose; A5/A5c/A7p must NOT expose the (correct) decisive answer
    if (!leak.A7) anomalies.push(`${sc.id}: A7 does NOT expose decisive (claim/decisive mismatch)`);
    if (leak.A5) anomalies.push(`${sc.id}: A5 (masked) leaks decisive — mask ineffective`);
    if (leak.A5c) anomalies.push(`${sc.id}: A5c (placebo) leaks decisive — distractor too close`);
    if (leak.A7p) anomalies.push(`${sc.id}: A7p (wrong-content) leaks correct decisive — wrong object overlaps truth`);
    const separating = !leak.A4 && leak.A7; // A7 decisive but raw retrieval is not -> distillation can show value
    if (separating) sep++; else sat++;
    rows.push({ id: sc.id, kind: sc.kind, ...Object.fromEntries(ARMS.map((a) => [a, leak[a] ? '✓' : '·'])), class: separating ? 'SEP' : 'SAT' });
  }
  // print
  console.log('\nDECISIVE-ANSWER LEAKAGE PER ARM  (✓ = arm exposes the decisive answer)\n');
  console.log(['id', 'kind', ...ARMS, 'class'].map((s) => s.padEnd(s === 'kind' ? 9 : 4)).join(' '));
  for (const r of rows) console.log([r.id, r.kind, ...ARMS.map((a) => r[a]), r.class].map((s, i) => String(s).padEnd(i === 1 ? 9 : 4)).join(' '));
  console.log(`\nSEP (A4 raw does NOT expose answer, A7 does) = ${sep}   SAT (raw already exposes / no separation) = ${sat}`);
  console.log('A7-vs-baseline separable scenarios available:', sep, '/', SCENARIOS.length);
  if (anomalies.length) { console.log('\n⚠ ANOMALIES (scenario/regex bugs to fix before LLM run):'); anomalies.forEach((a) => console.log('  -', a)); }
  else console.log('\n✓ no leakage anomalies — masks/placebo/wrong-content all withhold the correct decisive answer');
  // arm-level summary
  const totals = Object.fromEntries(ARMS.map((a) => [a, rows.filter((r) => r[a] === '✓').length]));
  console.log('\nleak counts by arm (/' + SCENARIOS.length + '):', totals);
  return { sep, sat, anomalies };
}

if (require.main === module) audit();
module.exports = { seedScenario, buildArms, audit, ARMS };
