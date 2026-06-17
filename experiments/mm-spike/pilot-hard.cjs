'use strict';
// HARD-SEP mini-run (Codex #5). Usage: node pilot-hard.cjs <tier=codex> <gens=3> [trapOnly]
// Tests whether PRE-RESOLVED distilled memory (A7) beats RAW retrieval (A4 top-1, A4k top-3) when raw is stale/conflicting.
const fs = require('fs');
const path = require('path');
const store = require('./store.cjs');
const { seedScenario, buildArms } = require('./harness.cjs');
const { runMatrix } = require('./runner.cjs');
const { TIERS } = require('./model.cjs');
const { SCENARIOS_HARD } = require('./scenarios-hard.cjs');

const tier = process.argv[2] || 'codex';
const gens = Number(process.argv[3] || 3);
const trapOnly = process.argv.includes('trapOnly');
const ARMS = ['A0', 'A4', 'A4k', 'A7p', 'A7'];
const pct = (x) => (x == null ? ' n/a' : (100 * x).toFixed(0).padStart(3) + '%');
const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// tag each scenario by what raw top-1 surfaces (TRAP=stale, EASY=current, NEITHER, BOTH)
function tag(sc) {
  const db = store.open(':memory:');
  const { truthId } = seedScenario(db, sc);
  const a = buildArms(db, sc, truthId); db.close();
  sc.forbidden.lastIndex = 0; const stale = sc.forbidden.test(a.A4);
  sc.required.lastIndex = 0; const cur = sc.required.test(a.A4);
  return stale && !cur ? 'TRAP' : cur && !stale ? 'EASY' : stale && cur ? 'BOTH' : 'NEITHER';
}

(async () => {
  const t0 = Date.now();
  let scenarios = SCENARIOS_HARD.map((s) => ({ ...s, _tag: tag(s) }));
  if (trapOnly) scenarios = scenarios.filter((s) => s._tag === 'TRAP');
  console.log(`HARD-SEP run tier=${tier} gens=${gens} arms=[${ARMS}] scenarios=${scenarios.length} (~${scenarios.length * ARMS.length * gens} calls)`);
  console.log('tags:', scenarios.map((s) => `${s.id}:${s._tag}`).join(' '));
  let done = 0;
  const { rate, perScenario, errors } = await runMatrix({
    scenarios, arms: ARMS, gens, callModel: TIERS[tier],
    onProgress: (row) => { done++; console.log(`  [${done}/${scenarios.length}] ${row.id} ` + ARMS.map((a) => `${a}:${pct(row.byArm[a])}`).join(' ')); },
  });
  // attach tags to rows, group
  const tagOf = Object.fromEntries(scenarios.map((s) => [s.id, s._tag]));
  const grp = (t) => { const rows = perScenario.filter((r) => tagOf[r.id] === t); return rows.length ? Object.fromEntries(ARMS.map((a) => [a, avg(rows.map((r) => r.byArm[a]))])) : null; };
  const TRAP = grp('TRAP'); const NEITHER = grp('NEITHER');
  const bestRaw = (m) => Math.max(m.A4 ?? 0, m.A4k ?? 0);
  const out = { tier, gens, arms: ARMS, overall: rate, TRAP, NEITHER, perScenario: perScenario.map((r) => ({ ...r, tag: tagOf[r.id] })), errors, ms: Date.now() - t0 };
  fs.writeFileSync(path.join(__dirname, `results-hard-${tier}-g${gens}.json`), JSON.stringify(out, null, 2));

  console.log('\n=== HONORED RATE ===        ' + ARMS.map((a) => a.padStart(5)).join(''));
  console.log('overall                  ' + ARMS.map((a) => pct(rate[a]).padStart(5)).join(''));
  if (TRAP) console.log('TRAP (raw->stale, decisive)' + ARMS.map((a) => pct(TRAP[a]).padStart(5)).join(''));
  if (NEITHER) console.log('NEITHER (raw lacks answer) ' + ARMS.map((a) => pct(NEITHER[a]).padStart(5)).join(''));
  console.log('\n=== DECISIVE CONTRAST (distilled vs best raw) ===');
  if (TRAP) { const br = bestRaw(TRAP); console.log('  TRAP: A7', pct(TRAP.A7), 'vs best(A4,A4k)', pct(br), '=> margin', ((TRAP.A7 - br) * 100).toFixed(0) + 'pp'); }
  console.log('  overall: A7', pct(rate.A7), '| A4', pct(rate.A4), '| A4k', pct(rate.A4k), '| A7p', pct(rate.A7p), '| A0', pct(rate.A0));
  console.log('\nKILL/PASS rule: A7 beats best(A4,A4k) by >=15pp on TRAP, spread across families.');
  console.log('errors/format-fails:', errors, '| elapsed', ((Date.now() - t0) / 1000).toFixed(0) + 's', '|', `results-hard-${tier}-g${gens}.json`);
})();
