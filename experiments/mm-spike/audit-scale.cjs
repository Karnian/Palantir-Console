'use strict';
// 0-LLM pre-check: at scale (large stale same-topic history), does raw FTS top-5 surface the CURRENT fact or is it BURIED?
// FOUND -> retrieval scales fine -> cheap KILL (no LLM). BURIED -> dedup/maintenance layer may win -> worth an LLM run.
const store = require('./store.cjs');
const { SCENARIOS_SCALE, historyOf } = require('./scenarios-scale.cjs');

console.log('SCALE pre-check: raw FTS top-5 over a large stale history — is the CURRENT fact retrievable? (0 LLM)\n');
console.log('id   family            histN  cur_in_top5  cur_rank  stale_in_top5  verdict');
let buried = 0, found = 0;
for (const sc of SCENARIOS_SCALE) {
  const db = store.open(':memory:');
  historyOf(sc).forEach((t) => store.ingestEvent(db, { source: 'conversation', event_type: 'message', actor: 'human', content_redacted: t }));
  const top5 = store.retrieveRaw(db, sc.task, 5);
  db.close();
  let curRank = -1, staleCount = 0;
  top5.forEach((r, i) => {
    sc.required.lastIndex = 0; if (sc.required.test(r.text) && curRank < 0) curRank = i + 1;
    sc.forbidden.lastIndex = 0; if (sc.forbidden.test(r.text)) staleCount++;
  });
  const curInTop5 = curRank > 0;
  curInTop5 ? found++ : buried++;
  const v = curInTop5 ? `FOUND@${curRank} (retrieval scales)` : 'BURIED (separation->LLM)';
  console.log(`${sc.id}  ${sc.family.padEnd(16)}  ${String(historyOf(sc).length).padEnd(5)}  ${String(curInTop5).padEnd(11)}  ${String(curRank > 0 ? curRank : '-').padEnd(8)}  ${String(staleCount).padEnd(13)}  ${v}`);
}
console.log(`\nBURIED=${buried} (current NOT in raw top-5 -> A7/dedup may win -> worth LLM)   FOUND=${found} (raw top-5 has current -> retrieval scales -> KILL)`);
console.log('Honest reading: if FOUND dominates, even the scale/dedup justification fails for answer-influence; raw top-K suffices.');
