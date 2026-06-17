'use strict';
// Kill-test PILOT runner. Usage: node pilot.cjs <tier=codex|gemini> <gens=1>
// arms exclude A6 (positive answer-token control, not a baseline — Codex #4). A5 included (semantic-leakage of masks).
const fs = require('fs');
const path = require('path');
const { SCENARIOS } = require('./scenarios.cjs');
const { runMatrix } = require('./runner.cjs');
const { TIERS } = require('./model.cjs');

const tier = process.argv[2] || 'codex';
const gens = Number(process.argv[3] || 1);
const ARMS = ['A0', 'A4', 'A5', 'A5c', 'A7p', 'A7'];
const pct = (x) => (x == null ? ' n/a' : (100 * x).toFixed(0).padStart(3) + '%');
const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

(async () => {
  const t0 = Date.now();
  const total = SCENARIOS.length * ARMS.length * gens;
  console.log(`PILOT tier=${tier} gens=${gens} arms=[${ARMS}] scenarios=${SCENARIOS.length} (~${total} model calls)`);
  let done = 0;
  const { rate, perScenario, perArm, errors } = await runMatrix({
    scenarios: SCENARIOS, arms: ARMS, gens, callModel: TIERS[tier],
    onProgress: (row) => { done++; console.log(`  [${done}/${SCENARIOS.length}] ${row.id}(${row.kind}) ` + ARMS.map((a) => `${a}:${pct(row.byArm[a])}`).join(' ')); },
  });
  const split = (k) => { const rows = perScenario.filter((r) => (k === 'SEP' ? r.kind === 'inferred' : r.kind === 'explicit')); return Object.fromEntries(ARMS.map((a) => [a, avg(rows.map((r) => r.byArm[a]))])); };
  const SEP = split('SEP'); const SAT = split('SAT');
  const out = { tier, gens, arms: ARMS, overall: rate, SEP, SAT, perArm, perScenario, errors, ms: Date.now() - t0 };
  fs.writeFileSync(path.join(__dirname, `results-${tier}-g${gens}.json`), JSON.stringify(out, null, 2));

  console.log('\n=== HONORED RATE ===           ' + ARMS.map((a) => a.padStart(5)).join(''));
  console.log('overall                     ' + ARMS.map((a) => pct(rate[a]).padStart(5)).join(''));
  console.log('SEP (inferred: distill test)' + ARMS.map((a) => pct(SEP[a]).padStart(5)).join(''));
  console.log('SAT (explicit: anchor test) ' + ARMS.map((a) => pct(SAT[a]).padStart(5)).join(''));
  console.log('\n=== KEY CONTRASTS ===');
  console.log('  distilled vs raw   (SEP A7-A4):', pct(SEP.A7), 'vs', pct(SEP.A4));
  console.log('  content vs wrong   (all A7-A7p):', pct(rate.A7), 'vs', pct(rate.A7p));
  console.log('  content vs placebo (all A7-A5c):', pct(rate.A7), 'vs', pct(rate.A5c));
  console.log('  masked claim       (all A5):', pct(rate.A5), '(should be low if content matters)');
  console.log('  memory vs none     (all A7-A0):', pct(rate.A7), 'vs', pct(rate.A0));
  console.log('\nerrors/format-fails:', errors, '| elapsed:', ((Date.now() - t0) / 1000).toFixed(0) + 's', '| ->', `results-${tier}-g${gens}.json`);
  console.log('\nNOTE: tier=' + tier + ', gens=' + gens + ' — ' + (gens < 2 || true ? 'DIRECTIONAL/plumbing only (single tier or low gens); not the frozen verdict.' : ''));
})();
