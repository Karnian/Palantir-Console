'use strict';

// G2 §5f — Gate 1 acceptance runner. Executes a task's assigned verify_check
// against the run's workspace and returns a normalized acceptance result. This
// only EXECUTES + aggregates — the verdict decision (retry/gate2/exhausted) is
// G3, and reads the persisted acceptance_json. Never the source of a task
// transition in G2.
//
// Provenance decides gate eligibility (§5k-3): a human-authored check GATES
// (gate:true); an operator-authored check is ADVISORY (gate:false) — it is
// still evaluated and surfaced, but must not gate a verdict.

const { evaluateArtifactCheck } = require('./artifactCheck');

async function runAcceptance({ check, workspaceDir, reportText = null, runCommand } = {}) {
  const gate = check.created_by === 'human';
  const kind = check.kind;
  let spec;
  try { spec = JSON.parse(check.spec_json); } catch { spec = {}; }

  if (kind === 'command') {
    // §5f: command uses the SAME runner as the harvest test stage. If that
    // runner is unavailable on this node (e.g. remote exec allowlist), report
    // skipped (→ G3 gate2 fail-open), never a silent pass.
    if (typeof runCommand !== 'function' || !workspaceDir) {
      return { check_id: check.id, name: check.name, kind, gate, status: 'skipped', reason: 'runner_unavailable', passed: null };
    }
    const result = await runCommand({ command: spec.command, cwd: workspaceDir, timeout_ms: spec.timeout_ms });
    return {
      check_id: check.id, name: check.name, kind, gate, status: 'ran',
      passed: !!result.passed,
      exit_code: result.exit_code ?? null,
      timed_out: !!result.timed_out,
      output_tail: typeof result.output_tail === 'string' ? result.output_tail.slice(-4000) : null,
    };
  }

  // artifact — declarative pure evaluation against the workspace.
  const res = evaluateArtifactCheck(spec, { workspaceRoot: workspaceDir, reportText });
  return {
    check_id: check.id, name: check.name, kind, gate, status: 'ran',
    passed: res.passed,
    reason: res.reason,
    results: Array.isArray(res.results) ? res.results.slice(0, 40) : [],
  };
}

module.exports = { runAcceptance };
