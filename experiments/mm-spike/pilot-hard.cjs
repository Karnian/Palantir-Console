'use strict';
// HARD-SEP decisive mini-run (Codex #5 + design review). Usage: node pilot-hard.cjs <tier=codex> <gens=3> [all]
// Default = TRAP-only (decisive). Tests: does PRE-RESOLVED distilled memory (A7) beat RAW retrieval under stale/current conflict?
// Arms: A0 none | A4 raw top-1 | A4k raw top-3 (steelman) | A4cur raw current-event-only (salience guard) | A7p stale claim | A7 current claim.
// Conclusion scope (Codex): "bi-temporal supersede/conflict-resolution layer" — NOT "full graph memory".
const fs = require('fs');
const path = require('path');
const store = require('./store.cjs');
const { seedScenario, buildArms } = require('./harness.cjs');
const { runMatrix } = require('./runner.cjs');
const { TIERS } = require('./model.cjs');
const { SCENARIOS_HARD } = require('./scenarios-hard.cjs');

const tier = process.argv[2] || 'codex';
const gens = Number(process.argv[3] || 3);
const runAll = process.argv.includes('all');
const ARMS = ['A0', 'A4', 'A4k', 'A4cur', 'A7p', 'A7'];
const pct = (x) => (x == null ? ' n/a' : (100 * x).toFixed(0).padStart(3) + '%');

function tag(sc) {
  const db = store.open(':memory:'); const { truthId } = seedScenario(db, sc);
  const a = buildArms(db, sc, truthId); db.close();
  sc.forbidden.lastIndex = 0; const stale = sc.forbidden.test(a.A4);
  sc.required.lastIndex = 0; const cur = sc.required.test(a.A4);
  return stale && !cur ? 'TRAP' : cur && !stale ? 'EASY' : stale && cur ? 'BOTH' : 'NEITHER';
}

(async () => {
  const t0 = Date.now();
  const tagged = SCENARIOS_HARD.map((s) => ({ ...s, _tag: tag(s) }));
  const scenarios = runAll ? tagged : tagged.filter((s) => s._tag === 'TRAP');
  const N = scenarios.length * gens;
  console.log(`HARD-SEP ${runAll ? 'ALL' : 'TRAP-only (decisive)'} tier=${tier} gens=${gens} arms=[${ARMS}] scenarios=${scenarios.length} (~${scenarios.length * ARMS.length * gens} calls)`);
  console.log('scenarios:', scenarios.map((s) => `${s.id}:${s.family}`).join(' '));
  let done = 0;
  const { rate, perScenario, perArm, errors } = await runMatrix({
    scenarios, arms: ARMS, gens, callModel: TIERS[tier],
    onProgress: (row) => { done++; console.log(`  [${done}/${scenarios.length}] ${row.id} ` + ARMS.map((a) => `${a}:${pct(row.byArm[a])}`).join(' ')); },
  });

  const correct = Object.fromEntries(ARMS.map((a) => [a, perArm[a].honored]));
  const bestRawRate = Math.max(rate.A4 ?? 0, rate.A4k ?? 0);
  const bestRawCorrect = Math.max(correct.A4, correct.A4k);
  const marginPP = Math.round((rate.A7 - bestRawRate) * 100);
  const net = correct.A7 - bestRawCorrect;
  // family dominance: which families have A7 strictly beating best-raw (by rate)
  const winFamilies = perScenario.filter((r) => r.byArm.A7 > Math.max(r.byArm.A4, r.byArm.A4k))
    .map((r) => (scenarios.find((s) => s.id === r.id) || {}).family);
  const uniqWin = [...new Set(winFamilies)];

  const out = { tier, gens, arms: ARMS, scope: runAll ? 'all' : 'TRAP-only', overall: rate, correct, N, marginPP, net, winFamilies, perScenario: perScenario.map((r, i) => ({ ...r, family: scenarios[i].family })), errors, ms: Date.now() - t0 };
  fs.writeFileSync(path.join(__dirname, `results-hard-${tier}-g${gens}.json`), JSON.stringify(out, null, 2));

  console.log('\n=== HONORED RATE ===   ' + ARMS.map((a) => a.padStart(6)).join(''));
  console.log('rate                 ' + ARMS.map((a) => pct(rate[a]).padStart(6)).join(''));
  console.log('correct/' + String(N).padEnd(12) + ARMS.map((a) => String(correct[a] + '/' + N).padStart(6)).join(''));
  console.log('\n=== DECISIVE (Codex rule) ===');
  console.log(`  A7 ${pct(rate.A7)} (${correct.A7}/${N})  vs  best raw[A4,A4k] ${pct(bestRawRate)} (${bestRawCorrect}/${N})  =>  margin ${marginPP}pp, net +${net}`);
  console.log(`  A4cur raw-current-oracle: ${pct(rate.A4cur)} (${correct.A4cur}/${N})  [if ~A7, win is salience/conciseness, NOT supersede resolution]`);
  console.log(`  A7p stale claim: ${pct(rate.A7p)} (${correct.A7p}/${N})  [must be materially < A7]`);
  console.log(`  families where A7 > best-raw: ${uniqWin.length} (${uniqWin.join(',') || 'none'})  [must be >1, no single-family dominance]`);
  const pass = (marginPP >= 20 || net >= 3) && rate.A7 > rate.A7p && uniqWin.length > 1;
  const salienceCaveat = rate.A4cur != null && Math.abs(rate.A7 - rate.A4cur) < 0.15;
  console.log(`\n>>> DIRECTIONAL VERDICT: ${pass ? 'PASS' : 'KILL'} (supersede/conflict-resolution layer)` +
    `${pass && salienceCaveat ? ' — but A4cur~A7: mechanism likely salience, not supersede (weak PASS)' : ''}`);
  console.log(`    rule: (margin>=20pp OR net>=3) AND A7>A7p AND families>1. got: margin=${marginPP}pp net=+${net} A7p=${pct(rate.A7p)} families=${uniqWin.length}`);
  console.log(`errors/format-fails: ${errors} | elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s | results-hard-${tier}-g${gens}.json`);
  console.log('SCOPE: conclusion applies to bi-temporal supersede/conflict-resolution only, NOT full graph memory (Codex).');
})();
