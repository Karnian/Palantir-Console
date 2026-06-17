'use strict';
// Deterministic check (0 LLM) that HARD-SEP scenarios are genuinely raw-resistant:
// what does A4 (raw FTS top-1) actually retrieve — the STALE(forbidden) value (TRAP, hard) or the CURRENT(required) value (EASY)?
const store = require('./store.cjs');
const { seedScenario, buildArms } = require('./harness.cjs');
const { SCENARIOS_HARD } = require('./scenarios-hard.cjs');

let trap = 0, easy = 0, neither = 0, both = 0;
console.log('\nHARD-SEP A4 (raw top-1) retrieval analysis  [what raw retrieval surfaces for the task]\n');
console.log('id   family            A4_has_stale  A4_has_current  verdict');
for (const sc of SCENARIOS_HARD) {
  const db = store.open(':memory:');
  const { truthId } = seedScenario(db, sc);
  const arms = buildArms(db, sc, truthId);
  db.close();
  sc.forbidden.lastIndex = 0; sc.required.lastIndex = 0;
  const hasStale = sc.forbidden.test(arms.A4);
  sc.required.lastIndex = 0;
  const hasCurrent = sc.required.test(arms.A4);
  let v;
  if (hasStale && !hasCurrent) { v = 'TRAP (raw->wrong)'; trap++; }
  else if (hasCurrent && !hasStale) { v = 'EASY (raw->right)'; easy++; }
  else if (hasStale && hasCurrent) { v = 'BOTH (ambiguous)'; both++; }
  else { v = 'NEITHER (no answer)'; neither++; }
  console.log(`${sc.id}  ${sc.family.padEnd(16)}  ${String(hasStale).padEnd(12)}  ${String(hasCurrent).padEnd(14)}  ${v}`);
}
console.log(`\nTRAP=${trap} (A7 should beat A4)  EASY=${easy} (A4 ties A7)  BOTH=${both}  NEITHER=${neither}`);
console.log('Hard enough if TRAP+NEITHER dominate; EASY scenarios cannot show distillation value.');
