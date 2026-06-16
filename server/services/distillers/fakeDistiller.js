// ML PR3a: injectable fake distiller.
//
// The distiller contract is the seam between memoryDistillService (claim ->
// promote orchestration, deterministic) and the actual generalization step
// (batch LLM, expensive, non-deterministic). This slice ships ONLY the fake so
// the whole pipeline is testable with zero LLM calls; the live LLM distiller is
// the next slice and implements the same interface.
//
// Contract:
//   distiller.distill({ projectId, candidates, existingItems }) -> Promise<proposals[]>
//   proposal = { candidateId, kind, content, confidence?, importance?, mergeTargetId? }
//     - candidateId MUST be one of the input candidates' ids.
//     - kind is a memory_items kind EXCEPT 'fact' (R6 owns facts).
//     - content is a generalized pitfall/heuristic string (will be sanitized).
//     - mergeTargetId (PR3c): an existingItems id this lesson duplicates. The
//       WRITER re-validates it (active / same kind / token floor), so a fake
//       handler may return any id to exercise that validation.
//
// The fake takes a handler so tests fully control the output (including
// secret-bearing / injection content to exercise the sanitize gate). With no
// handler it is a deterministic identity-ish stub that turns each candidate
// into a trivial proposal — useful for wiring smoke tests.

function defaultStub({ candidates }) {
  return (candidates || []).map((c) => {
    let raw = {};
    try { raw = JSON.parse(c.raw_json) || {}; } catch { /* */ }
    let content;
    if (raw.rule === 'R1b') {
      content = `When a task's tests fail, the fix that made them pass changed: ${raw.fix_run?.diff_stat || 'see run history'}.`;
    } else if (raw.rule === 'R3') {
      content = `A task of this kind is considered complete when: ${raw.rationale || 'the PM verified it against DB truth'}.`;
    } else {
      content = `Observed signal for rule ${raw.rule || c.rule}.`;
    }
    return {
      candidateId: c.id,
      kind: raw.rule === 'R1b' ? 'pitfall' : 'heuristic',
      content,
      confidence: 0.6,
      importance: 5,
    };
  });
}

// createFakeDistiller(handler?) — handler({projectId, candidates}) may be sync
// or async and returns proposals[]. Throwing simulates a transient LLM failure.
function createFakeDistiller(handler) {
  return {
    name: 'fake',
    async distill(input) {
      const fn = typeof handler === 'function' ? handler : defaultStub;
      return fn(input);
    },
  };
}

module.exports = { createFakeDistiller, defaultStub };
