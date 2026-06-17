'use strict';
// CLI model adapters for the spike (no API key needed). Two tiers: codex + gemini.
// Robust output extraction via <ANS>...</ANS> sentinel (agent-scaffold-agnostic), with fallbacks.
const { spawnSync } = require('child_process');

function extractAns(raw) {
  const s = String(raw || '');
  const m = s.match(/<ANS>([\s\S]*?)<\/ANS>/i);
  if (m) return m[1].trim();
  // fallback 1: text after the last codex "tokens used\n<num>" transcript footer
  const parts = s.split(/tokens used\s*\n[\d,]+/i);
  if (parts.length > 1) return parts[parts.length - 1].trim();
  return s.trim();
}

function run(cmd, args, prompt, timeoutMs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, err: String(r.error.message || r.error), out: '' };
  if (r.status !== 0 && !r.stdout) return { ok: false, err: `exit ${r.status}: ${(r.stderr || '').slice(0, 200)}`, out: '' };
  return { ok: true, out: r.stdout || '' }; // raw; runner.extractArtifact parses the JSON artifact field
}

function callCodex(prompt, { timeoutMs = 120000 } = {}) {
  const r = run('codex', ['exec', prompt], prompt, timeoutMs);
  if (!r.ok) throw new Error('codex: ' + r.err);
  return r.out;
}

function callGemini(prompt, { timeoutMs = 120000 } = {}) {
  const r = run('gemini', ['-p', prompt], prompt, timeoutMs);
  if (!r.ok) throw new Error('gemini: ' + r.err);
  return r.out;
}

const TIERS = { codex: callCodex, gemini: callGemini };
module.exports = { callCodex, callGemini, extractAns, TIERS };

// 1-call end-to-end validation of sentinel extraction per CLI (small cost)
if (require.main === module) {
  const which = process.argv[2] || 'codex';
  const p = 'Reply to: what is 2+2? Wrap your final answer between <ANS> and </ANS> tags, nothing else inside.';
  try {
    const out = TIERS[which](p, { timeoutMs: 120000 });
    console.log(`${which} extracted answer: ${JSON.stringify(out)}`);
    console.log(out.includes('4') ? 'OK sentinel extraction works' : 'WARN unexpected answer');
  } catch (e) { console.log(`${which} ERROR: ${e.message}`); }
}
