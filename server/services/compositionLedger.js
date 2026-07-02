'use strict';

/**
 * compositionLedger.js — A2-2 composition persistence + gate
 *
 * Persists the output of memoryComposer.compose() into 3 tables
 * (memory_composition_events, memory_composition_owner_state,
 *  memory_composition_item_edges) and provides a shouldCompose() gate.
 *
 * Design rules:
 *   - composer (memoryComposer.js) remains pure / immutable — this is a
 *     separate DB service that wraps DB writes only.
 *   - never-throws (annotate-only): record/accept/gate errors degrade
 *     gracefully — callers must never assume a non-null return.
 *   - CONTRACT: manager-slot compositions use (run, conversation) identity.
 *     task_id=null is by-design — manager runs are not task-bound.
 *
 * peek-then-commit pattern (caller responsibility):
 *   1. shouldCompose() — gate check (pre-compose, currentOwnerRevisions provided by caller)
 *   2. compose() — if gate passes
 *   3. record(composition, opts) → compositionId (status='pending')
 *   4. inject block into prompt
 *   5. accept(compositionId) — mark accepted after successful injection
 */

const { randomUUID } = require('node:crypto');

function ownerStateKey(row) {
  const ownerType = row && row.owner_type;
  const ownerId = row && row.owner_id;
  const provenanceKey =
    row && row.provenance_key != null ? row.provenance_key :
      (row && row.provenance != null ? row.provenance : '');
  return `${ownerType}:${ownerId}:${provenanceKey}`;
}

function ownerStateProvenance(row) {
  return row && row.provenance != null ? row.provenance :
    (row && row.provenance_key != null ? row.provenance_key : '');
}

// ─── factory ─────────────────────────────────────────────────────────────────

/**
 * createCompositionLedger(db)
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ record, accept, commitAccepted, shouldCompose, cleanup }}
 */
function createCompositionLedger(db) {
  // ── prepared statements ───────────────────────────────────────────────────

  // commitAccepted: insert event with status='accepted' directly (no pending step)
  const stmtInsertEventAccepted = db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, conversation_id, task_id, slot_kind, provenance_key, mode,
       composer_version, policy_version, prompt_payload_hash, retrieval_query_hash,
       token_budget, owner_vector_hash, selected_set_hash, fingerprint, block_hash,
       status, accepted_at)
    VALUES
      (@id, @run_id, @conversation_id, @task_id, @slot_kind, @provenance_key, @mode,
       @composer_version, @policy_version, @prompt_payload_hash, @retrieval_query_hash,
       @token_budget, @owner_vector_hash, @selected_set_hash, @fingerprint, @block_hash,
       'accepted', datetime('now'))
  `);

  const stmtInsertEvent = db.prepare(`
    INSERT INTO memory_composition_events
      (id, run_id, conversation_id, task_id, slot_kind, provenance_key, mode,
       composer_version, policy_version, prompt_payload_hash, retrieval_query_hash,
       token_budget, owner_vector_hash, selected_set_hash, fingerprint, block_hash,
       status)
    VALUES
      (@id, @run_id, @conversation_id, @task_id, @slot_kind, @provenance_key, @mode,
       @composer_version, @policy_version, @prompt_payload_hash, @retrieval_query_hash,
       @token_budget, @owner_vector_hash, @selected_set_hash, @fingerprint, @block_hash,
       'pending')
  `);

  const stmtInsertOwnerState = db.prepare(`
    INSERT INTO memory_composition_owner_state
      (composition_id, owner_type, owner_id, provenance_key, revision,
       selected_set_hash, suppressed_set_hash, selected_count, suppressed_count,
       budget_limit, budget_used)
    VALUES
      (@composition_id, @owner_type, @owner_id, @provenance_key, @revision,
       @selected_set_hash, @suppressed_set_hash, @selected_count, @suppressed_count,
       @budget_limit, @budget_used)
  `);

  // INSERT OR IGNORE: the partial unique index on (composition_id, item_table, item_id)
  // WHERE item_id IS NOT NULL enforces dedup for non-null ids. null-id edges always insert.
  const stmtInsertEdge = db.prepare(`
    INSERT OR IGNORE INTO memory_composition_item_edges
      (composition_id, item_table, item_id, item_revision, content_hash, fact_key, kind,
       source_owner_type, source_owner_id, provenance_key, decision, reason, rank, token_cost)
    VALUES
      (@composition_id, @item_table, @item_id, @item_revision, @content_hash, @fact_key,
       @kind, @source_owner_type, @source_owner_id, @provenance_key, @decision, @reason,
       @rank, @token_cost)
  `);

  const stmtAccept = db.prepare(`
    UPDATE memory_composition_events
    SET status = 'accepted', accepted_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);

  // Gate: last accepted composition id for (run_id, slot_kind, provenance_key)
  const stmtGetLastAcceptedId = db.prepare(`
    SELECT id FROM memory_composition_events
    WHERE run_id = ? AND slot_kind = ? AND provenance_key = ? AND status = 'accepted'
    ORDER BY accepted_at DESC, created_at DESC, rowid DESC
    LIMIT 1
  `);

  // Gate: owner states of the last accepted composition (joined via id)
  const stmtGetLastAcceptedOwnerStates = db.prepare(`
    SELECT os.owner_type, os.owner_id, COALESCE(os.provenance_key, '') AS provenance_key, os.revision
    FROM memory_composition_owner_state os
    WHERE os.composition_id = ?
  `);

  const stmtGetLastAcceptedSelectedSetHash = db.prepare(`
    SELECT id, selected_set_hash
    FROM memory_composition_events
    WHERE run_id = ? AND slot_kind = ? AND provenance_key = ? AND status = 'accepted'
    ORDER BY accepted_at DESC, created_at DESC, rowid DESC
    LIMIT 1
  `);

  // Retention: delete all accepted except the latest for (run_id, slot_kind, provenance_key)
  const stmtCleanupOldAccepted = db.prepare(`
    DELETE FROM memory_composition_events
    WHERE status = 'accepted'
      AND run_id = @run_id
      AND slot_kind = @slot_kind
      AND provenance_key = @provenance_key
      AND id NOT IN (
        SELECT id FROM memory_composition_events
        WHERE run_id = @run_id
          AND slot_kind = @slot_kind
          AND provenance_key = @provenance_key
          AND status = 'accepted'
        ORDER BY accepted_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      )
  `);

  // Retention: delete stale pending events older than 1 day
  const stmtCleanupStalePending = db.prepare(`
    DELETE FROM memory_composition_events
    WHERE status = 'pending'
      AND created_at < datetime('now', '-1 day')
  `);

  // ── transaction: record all 3 tables atomically ───────────────────────────

  const txRecord = db.transaction((composition, opts) => {
    const {
      runId,
      conversationId = null,
      taskId = null,
      slotKind,
      provenanceKey,
      mode = null,
      promptPayloadHash = null,
      blockHash = null,
    } = opts;

    const {
      fingerprint,
      owner_states = [],
      item_edges = [],
      composer_version = '',
      policy_version = '',
      retrieval_query_hash = null,
      token_budget = null,
      owner_vector_hash: composerOwnerVectorHash = null,
      selected_set_hash: composerSelectedSetHash = null,
    } = composition;

    const id = randomUUID();

    stmtInsertEvent.run({
      id,
      run_id: runId,
      conversation_id: conversationId,
      task_id: taskId,
      slot_kind: slotKind,
      provenance_key: provenanceKey,
      mode,
      composer_version,
      policy_version,
      prompt_payload_hash: promptPayloadHash,
      retrieval_query_hash,
      token_budget,
      owner_vector_hash: composerOwnerVectorHash,
      selected_set_hash: composerSelectedSetHash,
      fingerprint,
      block_hash: blockHash,
    });

    for (const os of owner_states) {
      stmtInsertOwnerState.run({
        composition_id: id,
        owner_type: os.owner_type ?? null,
        owner_id: os.owner_id ?? null,
        // composer uses os.provenance (not os.provenance_key)
        provenance_key: ownerStateProvenance(os),
        revision: os.revision ?? null,
        selected_set_hash: os.selected_set_hash ?? null,
        suppressed_set_hash: os.suppressed_set_hash ?? null,
        selected_count: os.selected_count ?? null,
        suppressed_count: os.suppressed_count ?? null,
        budget_limit: os.budget_limit ?? null,
        budget_used: os.budget_used ?? null,
      });
    }

    for (const edge of item_edges) {
      stmtInsertEdge.run({
        composition_id: id,
        item_table: edge.item_table,
        item_id: edge.item_id ?? null,
        item_revision: edge.item_revision ?? null,
        content_hash: edge.content_hash ?? null,
        fact_key: edge.fact_key ?? null,
        kind: edge.kind ?? null,
        source_owner_type: edge.source_owner_type ?? null,
        source_owner_id: edge.source_owner_id ?? null,
        // composer uses edge.provenance (not edge.provenance_key)
        provenance_key: edge.provenance ?? null,
        decision: edge.decision,
        reason: edge.reason ?? null,
        rank: edge.rank ?? null,
        token_cost: edge.token_cost ?? null,
      });
    }

    return id;
  });

  // ── commitAccepted transaction ────────────────────────────────────────────
  // Merges record+accept into a single db.transaction.
  // THROWS on error (by design — atomicity requires rollback on any failure).
  const txCommitAccepted = db.transaction((composition, opts) => {
    const {
      runId,
      conversationId = null,
      taskId = null,
      slotKind,
      provenanceKey,
      mode = null,
      promptPayloadHash = null,
      blockHash = null,
    } = opts;

    const {
      fingerprint,
      owner_states = [],
      item_edges = [],
      composer_version = '',
      policy_version = '',
      retrieval_query_hash = null,
      token_budget = null,
      owner_vector_hash: composerOwnerVectorHash = null,
      selected_set_hash: composerSelectedSetHash = null,
    } = composition;

    const id = randomUUID();

    stmtInsertEventAccepted.run({
      id,
      run_id: runId,
      conversation_id: conversationId,
      task_id: taskId,
      slot_kind: slotKind,
      provenance_key: provenanceKey,
      mode,
      composer_version,
      policy_version,
      prompt_payload_hash: promptPayloadHash,
      retrieval_query_hash,
      token_budget,
      owner_vector_hash: composerOwnerVectorHash,
      selected_set_hash: composerSelectedSetHash,
      fingerprint,
      block_hash: blockHash,
    });

    for (const os of owner_states) {
      stmtInsertOwnerState.run({
        composition_id: id,
        owner_type: os.owner_type ?? null,
        owner_id: os.owner_id ?? null,
        provenance_key: ownerStateProvenance(os),
        revision: os.revision ?? null,
        selected_set_hash: os.selected_set_hash ?? null,
        suppressed_set_hash: os.suppressed_set_hash ?? null,
        selected_count: os.selected_count ?? null,
        suppressed_count: os.suppressed_count ?? null,
        budget_limit: os.budget_limit ?? null,
        budget_used: os.budget_used ?? null,
      });
    }

    for (const edge of item_edges) {
      stmtInsertEdge.run({
        composition_id: id,
        item_table: edge.item_table,
        item_id: edge.item_id ?? null,
        item_revision: edge.item_revision ?? null,
        content_hash: edge.content_hash ?? null,
        fact_key: edge.fact_key ?? null,
        kind: edge.kind ?? null,
        source_owner_type: edge.source_owner_type ?? null,
        source_owner_id: edge.source_owner_id ?? null,
        provenance_key: edge.provenance ?? null,
        decision: edge.decision,
        reason: edge.reason ?? null,
        rank: edge.rank ?? null,
        token_cost: edge.token_cost ?? null,
      });
    }

    return id;
  });

  // ── public API ────────────────────────────────────────────────────────────

  return {
    /**
     * Record a composition into the ledger with status='pending'.
     * Call accept(compositionId) after successful injection (peek-then-commit).
     *
     * @param {object} composition - memoryComposer.compose().composition
     * @param {object} opts
     * @param {string}  opts.runId
     * @param {string}  [opts.conversationId]
     * @param {string}  [opts.taskId]
     * @param {string}  opts.slotKind        — 'top' | 'pm'
     * @param {string}  opts.provenanceKey
     * @param {string}  [opts.mode]
     * @param {string}  [opts.promptPayloadHash]
     * @param {string}  [opts.blockHash]
     * @returns {string|null} compositionId or null on error (never-throws)
     */
    record(composition, opts) {
      try {
        if (!composition || !opts) return null;
        return txRecord(composition, opts);
      } catch (err) {
        // annotate-only: degrade gracefully
        console.error('[compositionLedger] record failed (degraded):', err.message);
        return null;
      }
    },

    /**
     * Atomic commit: inserts the composition event with status='accepted' directly
     * (merges record+accept), inserts owner_state and item_edges rows inside the
     * same db.transaction.
     *
     * THROWS on error — atomicity is the contract; callers must wrap in try/catch.
     *
     * @param {object} composition - memoryComposer.compose().composition
     * @param {object} opts        - same shape as record() opts
     * @returns {string} compositionId
     */
    commitAccepted(composition, opts) {
      if (!composition || !opts) {
        throw new Error('commitAccepted: composition and opts are required');
      }
      return txCommitAccepted(composition, opts);
    },

    /**
     * Mark a pending composition as accepted.
     * Must be called after successful injection into the prompt.
     * (peek-then-commit: pending compositions are invisible to the gate.)
     *
     * @param {string} compositionId
     * @returns {boolean} true if the row was updated, false otherwise (never-throws)
     */
    accept(compositionId) {
      try {
        if (!compositionId) return false;
        const result = stmtAccept.run(compositionId);
        return result.changes > 0;
      } catch (err) {
        console.error('[compositionLedger] accept failed (degraded):', err.message);
        return false;
      }
    },

    /**
     * Gate: should we re-compose for (runId, slotKind, provenanceKey)?
     *
     * MUST be called BEFORE compose() — it does NOT depend on composition.owner_states.
     * The caller provides `currentOwnerRevisions` (pre-compose, from adapter.getRevision()
     * calls or memoryService.getRevision / masterMemoryService.getRevision).
     *
     * Compatibility cadence (revision-only):
     *   - No prior accepted composition → { compose: true,  reason: 'no_prior_accepted' }
     *   - Any owner revision increased  → { compose: true,  reason: 'revision_increased:...' }
     *   - New owner not seen before     → { compose: true,  reason: 'new_owner:...' }
     *   - Prior owner no longer current → { compose: true,  reason: 'removed_owner:...' }
     *   - All revisions unchanged       → { compose: false, reason: 'unchanged' }
     *
     * Pending (not-yet-accepted) compositions are ignored — only accepted records count.
     *
     * @param {object} opts
     * @param {string}  opts.runId
     * @param {string}  opts.slotKind
     * @param {string}  opts.provenanceKey
     * @param {Array<{owner_type:string, owner_id:string, provenance?:string, provenance_key?:string, revision:number|null}>} opts.currentOwnerRevisions
     *   — caller-provided, obtained BEFORE calling compose().
     * @returns {{ compose: boolean, reason: string }} (never-throws; degrades to compose:true)
     */
    shouldCompose(arg) {
      try {
        const { runId, slotKind, provenanceKey, currentOwnerRevisions } =
          (arg != null && typeof arg === 'object') ? arg : {};
        // Find last accepted composition for this slot
        const lastAccepted = stmtGetLastAcceptedId.get(runId, slotKind, provenanceKey);
        if (!lastAccepted) {
          return { compose: true, reason: 'no_prior_accepted' };
        }

        // Load owner states from that accepted composition
        const priorRows = stmtGetLastAcceptedOwnerStates.all(lastAccepted.id);
        const priorMap = new Map();
        for (const row of priorRows) {
          priorMap.set(ownerStateKey(row), row.revision ?? null);
        }

        // Compare each current owner against the prior snapshot
        const currentRows = Array.isArray(currentOwnerRevisions) ? currentOwnerRevisions : [];
        const currentKeys = new Set();
        for (const cur of currentRows) {
          const key = ownerStateKey(cur);
          currentKeys.add(key);
          const curRevision = cur.revision ?? null;

          if (!priorMap.has(key)) {
            return { compose: true, reason: `new_owner:${key}` };
          }

          const priorRevision = priorMap.get(key);

          if (curRevision !== null && priorRevision !== null && curRevision > priorRevision) {
            return { compose: true, reason: `revision_increased:${key}:${priorRevision}->${curRevision}` };
          }

          if (curRevision !== null && priorRevision === null) {
            return { compose: true, reason: `revision_gained:${key}` };
          }
        }

        for (const priorKey of priorMap.keys()) {
          if (!currentKeys.has(priorKey)) {
            return { compose: true, reason: `removed_owner:${priorKey}` };
          }
        }

        return { compose: false, reason: 'unchanged' };
      } catch (err) {
        // annotate-only: degrade to always compose (safe direction)
        console.error('[compositionLedger] shouldCompose failed (degraded, compose:true):', err.message);
        return { compose: true, reason: 'gate_error' };
      }
    },

    /**
     * Fetch the latest accepted selected_set_hash for a composition gate tuple.
     *
     * @param {object} opts
     * @param {string} opts.runId
     * @param {string} opts.slotKind
     * @param {string} opts.provenanceKey
     * @returns {{ id: string, selected_set_hash: string|null }|null}
     */
    getLastAcceptedSelectedSetHash(arg) {
      try {
        const { runId, slotKind, provenanceKey } =
          (arg != null && typeof arg === 'object') ? arg : {};
        return stmtGetLastAcceptedSelectedSetHash.get(runId, slotKind, provenanceKey) || null;
      } catch (err) {
        console.error('[compositionLedger] getLastAcceptedSelectedSetHash failed (degraded):', err.message);
        return null;
      }
    },

    /**
     * Retention cleanup:
     *   - For (runId, slotKind, provenanceKey): delete all accepted except the latest.
     *   - Globally: delete pending events older than 1 day.
     *
     * FK CASCADE handles owner_state and item_edges automatically.
     *
     * @param {string} runId
     * @param {string} slotKind
     * @param {string} provenanceKey
     */
    cleanup(runId, slotKind, provenanceKey) {
      try {
        stmtCleanupOldAccepted.run({
          run_id: runId,
          slot_kind: slotKind,
          provenance_key: provenanceKey,
        });
        stmtCleanupStalePending.run();
      } catch (err) {
        console.error('[compositionLedger] cleanup failed (degraded):', err.message);
      }
    },
  };
}

module.exports = { createCompositionLedger };
