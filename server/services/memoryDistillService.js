// ML PR3a: batch distill orchestration (candidate -> active promotion).
//
// runOnce() drives ONE claimed job:
//   claim (CAS lease) -> list pending candidates -> distill (injected) ->
//   promote (single tx; the WRITER enforces sanitize/kind/clamps/evidence) ->
//   release -> drain a successor if progress was made and a backlog remains.
//
// The writer (memoryService.promoteCandidates) is the single enforcement point
// for every safety invariant (Codex BLOCKER 1), so this orchestrator stays thin:
// it does NOT sanitize, clamp, or build evidence itself. runOnce performs zero
// LLM calls with the fake distiller and NEVER throws into the event bus
// (Codex SERIOUS 2).
//
// Omitted (next slice): live LLM distiller, setInterval scheduler +
// PALANTIR_MEMORY_DISTILL wiring, fuzzy/semantic merge, permanent candidate
// reject marking.

function createMemoryDistillService({ memoryService, distiller, logger = console, options = {} } = {}) {
  if (!memoryService || !distiller) {
    throw new Error('memoryService and distiller are required');
  }
  const {
    batchSize = 5,
    activeCap = 200,
    confidenceCeiling = 0.7,
    maxLen = 500,
    staleSeconds = 600,
    maxAttempts = 5,
    backoffSeconds = 60,
  } = options;

  function safeWarn(msg) {
    try { logger.warn(msg); } catch { /* a throwing logger must not re-raise */ }
  }

  async function runOnce({ projectId = null } = {}) {
    // Claim is inside its own guard: a DB error here (busy/locked) must not
    // escape the never-throws contract (Codex SERIOUS 2).
    let job;
    try {
      job = memoryService.claimDistillJob({ projectId, staleSeconds, maxAttempts });
    } catch (err) {
      safeWarn(`[distill] claim failed: ${err?.message || err}`);
      return { claimed: false, error: String(err?.message || err) };
    }
    if (!job) return { claimed: false };

    const lease = { jobId: job.id, claimToken: job.claim_token };
    try {
      const candidates = memoryService
        .listCandidates(job.project_id, 'pending')
        .slice(0, batchSize);

      if (candidates.length === 0) {
        memoryService.releaseDistillJob({ ...lease, outcome: 'done' });
        return { claimed: true, jobId: job.id, empty: true, promoted: [], skipped: [] };
      }

      const candById = new Map(candidates.map((c) => [c.id, c]));

      let rawProposals;
      try {
        rawProposals = await distiller.distill({ projectId: job.project_id, candidates });
      } catch (err) {
        // transient (network/parse): keep candidates pending, retry w/ backoff.
        memoryService.releaseDistillJob({
          ...lease, outcome: 'retry', lastError: String(err?.message || err), backoffSeconds, maxAttempts,
        });
        return { claimed: true, jobId: job.id, error: 'distill_failed', retried: true };
      }

      // Keep only proposals that reference a candidate in THIS batch; the writer
      // re-validates everything else (kind/sanitize/clamps/cap). Unknown ids are
      // surfaced but never sent to the writer.
      const proposals = [];
      const preSkipped = [];
      for (const rp of rawProposals || []) {
        if (!rp || !candById.has(rp.candidateId)) {
          preSkipped.push({ candidateId: rp?.candidateId ?? null, reason: 'unknown_candidate' });
          continue;
        }
        proposals.push({
          candidateId: rp.candidateId,
          kind: rp.kind,
          content: rp.content,
          confidence: rp.confidence,
          importance: rp.importance,
        });
      }

      let result = { promoted: [], skipped: [] };
      if (proposals.length > 0) {
        try {
          result = memoryService.promoteCandidates({ ...lease, proposals, activeCap, confidenceCeiling, maxLen });
        } catch (err) {
          if (err && err.code === 'MEMORY_LEASE_LOST') {
            // lease stolen (stale-requeue + re-claim); we wrote nothing and no
            // longer own the job. Don't release (token-guarded would no-op).
            return { claimed: true, jobId: job.id, leaseLost: true };
          }
          // MEMORY_CANDIDATE_RACE or anything else: tx rolled back but we still
          // hold the lease -> fall to the outer catch, which retries w/ backoff.
          throw err;
        }
      }

      memoryService.releaseDistillJob({ ...lease, outcome: 'done' });

      // Drain: if real progress was made AND pending candidates remain (overflow
      // beyond batchSize, or rows inserted after the claim), enqueue a successor
      // so a single scheduler tick eventually drains the backlog. Gated on
      // progress so an all-rejected batch can't spawn infinite successor jobs
      // (Codex SERIOUS 1).
      try {
        if (result.promoted.length > 0 &&
            memoryService.listCandidates(job.project_id, 'pending').length > 0) {
          memoryService.enqueueDistillJob(job.project_id);
        }
      } catch (err) { safeWarn(`[distill] successor enqueue job=${job.id}: ${err?.message || err}`); }

      return {
        claimed: true,
        jobId: job.id,
        promoted: result.promoted,
        skipped: [...preSkipped, ...result.skipped],
      };
    } catch (err) {
      // Unexpected: retry with backoff (token-guarded; no-op if the lease was
      // stolen). Never rethrow.
      try {
        memoryService.releaseDistillJob({
          ...lease, outcome: 'retry', lastError: String(err?.message || err), backoffSeconds, maxAttempts,
        });
      } catch { /* */ }
      safeWarn(`[distill] runOnce job=${job.id}: ${err?.message || err}`);
      return { claimed: true, jobId: job.id, error: String(err?.message || err) };
    }
  }

  return { runOnce };
}

module.exports = { createMemoryDistillService };
