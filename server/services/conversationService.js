// server/services/conversationService.js
//
// v3 Phase 1.5: unified conversation surface for Top / worker (and later
// PM) chat. Two responsibilities:
//
//   1. Route a message for a conversation id to the right delivery target
//      (manager adapter runTurn vs lifecycleService.sendAgentInput).
//   2. Own the **parent-notice queue** — spec §9.3 / lock-in #2:
//        "자식 대상 사용자 메시지는 전부 부모 staleness 신호로 취급
//         (plan-modification 분류 없음, 무조건)"
//      When the user sends a message directly to a worker, the worker's
//      parent Top manager must learn about it before its next turn so the
//      plan state it hallucinates about doesn't silently drift.
//
// Design notes:
//
// * The queue is keyed by the PARENT run id, not the parent conversation
//   id, because:
//     - a worker row has a concrete parent_run_id (002 migration);
//     - when the parent Top run ends (/stop, crash), we want any lingering
//       notices for that specific run id to be dropped on the floor rather
//       than incorrectly applied to a fresh Top run.
//
// * On delivery we prepend a single synthetic user message containing the
//   notices before the user's real text. We do NOT try to inject via
//   adapter system prompt — that would break mid-turn, invalidate Codex
//   instructions-file caching, and mean each adapter would need its own
//   injection path. The "prepend as leading user content" shape is what
//   every adapter already handles.
//
// * Intent classification is explicitly forbidden (principle 2 + lock-in
//   #2). Every worker-targeted message queues a notice. No heuristics.
//
// * Worker direct delivery uses lifecycleService.sendAgentInput. Workers
//   are not stream-json chat surfaces in general; sendAgentInput is the
//   tmux / subprocess fallback that already exists from pre-1.5 usage.
//   The "worker direct chat UI" in Phase 1.5 is therefore a thin wrapper
//   over an existing backend — the NEW work is the parent notice router.

function createConversationService({
  runService,
  managerRegistry,
  managerAdapterFactory,
  lifecycleService,
  // v3 Phase 3a: optional PM spawn hook. When provided, sendToManagerSlot
  // for a 'pm:<projectId>' target will call ensureLivePm() on a 404 so
  // the first message to a project's PM lazily creates the run instead of
  // returning "No active PM manager session". Tests that don't care about
  // lazy spawn can omit this dependency and keep the pre-3a behavior.
  pmSpawnService,
    // ML PR1: optional Learned Memory injector. When wired, a message to a PM
    // slot (NOT top) for a project gets a `## Learned Memory` block prepended
    // to the user payload.
  // Memory is NEVER baked into the system prompt (Codex caching safety); the
  // user-payload prepend is the single injection point. Tests that omit this
  // dependency keep the pre-PR1 behavior byte-for-byte.
    memoryService,
    masterMemoryService,
    memoryMultiOwner,
    memoryComposer,
    compositionLedger,
    eventBus,
    logger,
  }) {
  // parentRunId -> array of notice strings
  const pendingNotices = new Map();

  const log = logger || ((msg) => console.log(`[conversation] ${msg}`));

  // Formats the outbound notice text that the parent will see prepended
  // to its own next user message. Kept centralized so the shape can
  // evolve without grepping multiple call sites.
  function formatParentNotice({ childConversationId, childRunId, text }) {
    const trimmed = (text || '').replace(/\s+/g, ' ').slice(0, 500).trim();
    return [
      '[system notice]',
      `사용자가 ${childConversationId} (run=${childRunId})에 직접 메시지를 보냈습니다:`,
      `  "${trimmed}"`,
      '상태가 stale 되었을 수 있으니 해당 워커의 최신 상태를 다시 조회한 뒤 현재 계획을 갱신하세요.',
    ].join('\n');
  }

  function queueParentNotice(parentRunId, notice) {
    if (!parentRunId || !notice) return;
    const arr = pendingNotices.get(parentRunId) || [];
    arr.push(notice);
    pendingNotices.set(parentRunId, arr);
  }

  // Drain and return any pending notices for a parent run id. Returns a
  // possibly empty array of strings. Called by the Top send path.
  function consumeParentNotices(parentRunId) {
    if (!parentRunId) return [];
    const arr = pendingNotices.get(parentRunId);
    if (!arr || arr.length === 0) return [];
    pendingNotices.delete(parentRunId);
    return arr;
  }

  // Clears any queued notices targeting a parent run id. Used when the
  // parent run terminates (/stop, crash) so notices are not inadvertently
  // applied to some future unrelated run.
  function clearParentNotices(parentRunId) {
    if (!parentRunId) return;
    pendingNotices.delete(parentRunId);
  }

  // Prepend drained notices to the user's own text. If there are no
  // pending notices, returns the original text unchanged.
  function prependPendingNotices(parentRunId, text) {
    const notices = consumeParentNotices(parentRunId);
    if (notices.length === 0) return text || '';
    const noticeBlock = notices.join('\n\n');
    const original = text || '';
    return `${noticeBlock}\n\n---\n\n${original}`;
  }

  // Parse a conversation id into its structural parts. Returns null for
  // malformed ids so callers can return 404 rather than crash.
  function parseConversationId(id) {
    if (typeof id !== 'string' || id.length === 0) return null;
    if (id === 'top') return { kind: 'top' };
    if (id.startsWith('pm:')) {
      const projectId = id.slice(3);
      if (!projectId) return null;
      return { kind: 'pm', projectId };
    }
    if (id.startsWith('worker:')) {
      const runId = id.slice(7);
      if (!runId) return null;
      return { kind: 'worker', runId };
    }
    return null;
  }

  // Resolve the run + metadata that backs a conversation id. Returns null
  // if the conversation does not currently have a backing run.
  function resolveConversation(id) {
    const parsed = parseConversationId(id);
    if (!parsed) return null;

    if (parsed.kind === 'top') {
      const run = managerRegistry.probeActive('top');
      return { kind: 'top', conversationId: 'top', run };
    }
    if (parsed.kind === 'pm') {
      // v3 Phase 2: PM slot is now a 1st-class runtime target. probeActive
      // returns the currently live PM run for this project (or null if no
      // PM has been spawned yet — Phase 3a handles lazy spawn). The /status
      // endpoint gets an accurate projected slot either way.
      const run = managerRegistry.probeActive(id);
      return { kind: 'pm', conversationId: id, projectId: parsed.projectId, run };
    }
    // Worker
    const run = runService.getRunByConversationId(id);
    return { kind: 'worker', conversationId: id, run };
  }

  // Send a message to a conversation. This is the single entry point the
  // /api/conversations/:id/message route delegates to.
  //
  // Returns { status: 'sent', target } on success, throws with a 4xx-style
  // Error otherwise. Callers should map errors to HTTP status codes.
  function sendMessage(conversationId, { text, images } = {}) {
    const parsed = parseConversationId(conversationId);
    if (!parsed) {
      const err = new Error(`invalid conversation id: ${conversationId}`);
      err.httpStatus = 400;
      throw err;
    }

    const hasText = typeof text === 'string' && text.length > 0;
    const hasImages = Array.isArray(images) && images.length > 0;
    if (!hasText && !hasImages) {
      const err = new Error('text or images is required');
      err.httpStatus = 400;
      throw err;
    }

    if (parsed.kind === 'top') {
      return sendToManagerSlot('top', { text, images });
    }
    if (parsed.kind === 'worker') {
      return sendToWorker(parsed.runId, { text, images });
    }
    if (parsed.kind === 'pm') {
      return sendToManagerSlot(conversationId, {
        text,
        images,
        projectId: parsed.projectId,
      });
    }
    const err = new Error('unreachable');
    err.httpStatus = 500;
    throw err;
  }

  // Peek (non-destructive) — used so the drain only commits when the send
  // is actually accepted by the adapter. Returns the joined notice block or
  // empty string.
  function peekParentNotices(parentRunId) {
    if (!parentRunId) return [];
    const arr = pendingNotices.get(parentRunId);
    return arr ? arr.slice() : [];
  }

  // Race-safe drain. Removes EXACTLY `count` items from the head of the
  // queue keyed by `parentRunId` and nothing more. This guarantees that
  // notices queued between the peek and the commit — e.g., a worker send
  // that lands mid-runTurn (codex R1 blocker) — stay in the queue and are
  // delivered on the NEXT manager turn instead of being silently deleted
  // together with the ones we actually shipped.
  function commitDrainParentNotices(parentRunId, count) {
    if (!parentRunId || !count || count <= 0) return;
    const arr = pendingNotices.get(parentRunId);
    if (!arr || arr.length === 0) return;
    const toRemove = Math.min(count, arr.length);
    arr.splice(0, toRemove);
    if (arr.length === 0) pendingNotices.delete(parentRunId);
  }

  // v3 Phase 2: unified manager slot sender. Handles both the Top singleton
  // ('top') and any PM slot ('pm:<projectId>') — both share the same
  // peek → deliver → commit-drain → parent-notice semantics. The only
  // layer-specific bit is how the parent is identified:
  //   * top: parent_run_id is NULL, no upward notice is queued
  //   * pm : parent_run_id points at the Top run that spawned this PM;
  //          on success, queue a PM→Top notice on the PM run's parent
  //          (but only if that parent still matches the currently active
  //           Top, to avoid leaking stale signals into unrelated runs).
  function sendToManagerSlot(conversationId, { text, images, projectId } = {}) {
    const isTop = conversationId === 'top';
    const layerLabel = isTop ? 'Top' : 'PM';

    let run = managerRegistry.probeActive(conversationId);
    // v3 Phase 3a: lazy PM spawn. If no PM is live for this project and a
    // spawn service is wired, delegate to it. The spawn service refuses
    // when no Top is active (409) or pm_enabled=0 (409) — those errors
    // bubble through unchanged. Top layer NEVER auto-spawns; /start is
    // the only legitimate entry point for Top.
    if (!run && !isTop && pmSpawnService && projectId) {
      try {
        const spawn = pmSpawnService.ensureLivePm({ projectId });
        run = spawn.run;
      } catch (spawnErr) {
        // Preserve the spawn service's httpStatus if set so the route
        // layer returns a meaningful code (409/404/502) instead of a
        // generic 500.
        const err = new Error(spawnErr.message || 'PM spawn failed');
        err.httpStatus = spawnErr.httpStatus || 502;
        throw err;
      }
    }
    if (!run) {
      const err = new Error(`No active ${layerLabel} manager session`);
      err.httpStatus = 404;
      throw err;
    }

    // Phase 0c (B3) — binding assert: fail-closed invariant check before ANY
    // memory read. A mismatch means the registry returned a run that does not
    // belong to this conversation slot — injecting memory into it would cause
    // cross-project contamination (worse than no-injection). Throw 502 so the
    // caller surfaces a visible error rather than silently poisoning the turn.
    // Worker sends (is_manager=0) go through sendToWorker(), never here.
    {
      const expectedLayer = isTop ? 'top' : 'pm';
      if (
        !run.is_manager ||
        run.manager_layer !== expectedLayer ||
        run.conversation_id !== conversationId
      ) {
        const bindErr = new Error(
          `manager run binding mismatch: run.id=${run.id} run.conversation_id=${run.conversation_id} ` +
          `run.is_manager=${run.is_manager} run.manager_layer=${run.manager_layer} ` +
          `expected conversationId=${conversationId} layer=${expectedLayer}`
        );
        bindErr.httpStatus = 502;
        throw bindErr;
      }
    }

    const adapter = managerRegistry.getActiveAdapter(conversationId)
      || managerAdapterFactory.getAdapter(run.manager_adapter || 'claude-code');

    // Peek (do not drain) pending notices. We only commit the drain AFTER
    // the adapter accepts the turn. This prevents losing notices when the
    // send fails — codex review findings, lock-in #2.
    const notices = peekParentNotices(run.id);
    const originalText = text || '';
    let effectiveText = notices.length > 0
      ? `${notices.join('\n\n')}\n\n---\n\n${originalText}`
      : originalText;

      // ML PR1: Learned Memory injection. Outermost prepend (memory → parent
      // notices → original text). PM slots only, never Top, and only when a
      // memoryService + projectId are present.
      // Annotate-only: any failure degrades to "no injection" and never blocks
      // message delivery. The ledger is written AFTER the adapter accepts the
      // turn (mirrors the peek-then-commit notice discipline) so a failed send
      // re-injects on the next attempt rather than recording a phantom inject.
      let composerInjection = null; // { composition, provenanceKey, revision } stash
      if (!isTop && memoryService && projectId && compositionLedger && memoryComposer) {
        // Composer+Ledger path (PM slot only). The composer is the sole injection
        // path (S5-LEDGER); if it is not wired (some unit harnesses), skip injection
        // cleanly rather than throwing inside the try/catch on every send.
        // peek/decide: gate check → compose → stash for commit phase.
        try {
          const useMultiOwner = memoryMultiOwner && !!masterMemoryService;
          const currentOwnerRevisions = useMultiOwner
            ? [
                { owner_type: 'workspace', owner_id: projectId, revision: memoryService.getRevision(projectId) },
                { owner_type: 'user', owner_id: 'user', provenance: 'user', revision: masterMemoryService.getRevision('user') },
              ]
            : [
                { owner_type: 'workspace', owner_id: projectId, revision: memoryService.getRevision(projectId) },
              ];
          const dec = compositionLedger.shouldCompose({
            runId: run.id,
            slotKind: 'pm',
            provenanceKey: projectId,
            currentOwnerRevisions,
          });
          if (dec.compose) {
            const owners = useMultiOwner
              ? [
                  { owner_type: 'user', owner_id: 'user', provenance: 'user' },
                  { owner_type: 'workspace', owner_id: projectId },
                ]
              : [
                  { owner_type: 'workspace', owner_id: projectId },
                ];
            const { block, composition } = memoryComposer.compose({
              owners,
              taskContext: originalText,
            });
            // Phase 0b (S9): composition===null means compose() hit its outer catch.
            // block===null with composition!==null is normal empty-memory — NOT a failure.
            if (composition === null) {
              log(`composer failed (compose() returned null) for ${conversationId} (run=${run.id})`);
              if (eventBus) {
                eventBus.emit('memory:composer_failed', {
                  runId: run.id,
                  conversationId,
                  slotKind: 'pm',
                  provenanceKey: projectId,
                });
              }
            }
            // [Q4 BLOCKER] only prepend if BOTH block and composition are non-null.
            // block null → skip prepend AND record (gate pollution prevention).
            if (block && composition) {
              effectiveText = `${block}\n\n---\n\n${effectiveText}`;
              composerInjection = {
                composition,
                provenanceKey: projectId,
                revision: currentOwnerRevisions[0].revision,
              };
            }
          }
        } catch (memErr) {
          log(`composer injection skipped for ${conversationId} (run=${run.id}): ${memErr.message}`);
          composerInjection = null;
        }
      }

      // L2 P1b / A2-3b: Master (user-scope) memory injection — the Top-slot analogue of the PM block above.
      // Top slots ONLY (scope='user'), keyed by the Top run id. Same peek-then-commit ledger discipline:
      // the composition ledger is written AFTER the adapter accepts the turn (below). Outermost
      // prepend (memory → original). Annotate-only: any failure degrades to "no injection", never blocks.
      let masterComposerInjection = null; // { composition, provenanceKey, revision } stash
      if (isTop && masterMemoryService && compositionLedger && memoryComposer) {
        // Composer+Ledger path (Top slot). Composer is the sole injection path
        // (S5-LEDGER); skip cleanly if it is not wired (some unit harnesses).
        // peek/decide: gate check → compose → stash for commit phase.
        try {
          const useMultiOwner = memoryMultiOwner && !!masterMemoryService;
          const currentOwnerRevisions = useMultiOwner
            ? [
                {
                  owner_type: 'user',
                  owner_id: 'user',
                  provenance: 'user',
                  revision: masterMemoryService.getRevision('user'),
                },
                {
                  owner_type: 'user',
                  owner_id: 'user',
                  provenance: 'cross_project',
                  revision: masterMemoryService.getRevision('cross_project'),
                },
              ]
            : [
                {
                  owner_type: 'user',
                  owner_id: 'user',
                  provenance: 'user',
                  revision: masterMemoryService.getRevision('user'),
                },
              ];
          const dec = compositionLedger.shouldCompose({
            runId: run.id,
            slotKind: 'top',
            provenanceKey: 'user',
            currentOwnerRevisions,
          });
          if (dec.compose) {
            const owners = useMultiOwner
              ? [
                  { owner_type: 'user', owner_id: 'user', provenance: 'user' },
                  { owner_type: 'user', owner_id: 'user', provenance: 'cross_project' },
                ]
              : [
                  { owner_type: 'user', owner_id: 'user', provenance: 'user' },
                ];
            const { block, composition } = memoryComposer.compose({
              owners,
              taskContext: originalText,
            });
            // Phase 0b (S9): composition===null means compose() hit its outer catch.
            // block===null with composition!==null is normal empty-memory — NOT a failure.
            if (composition === null) {
              log(`master composer failed (compose() returned null) for ${conversationId} (run=${run.id})`);
              if (eventBus) {
                eventBus.emit('memory:composer_failed', {
                  runId: run.id,
                  conversationId,
                  slotKind: 'top',
                  provenanceKey: 'user',
                });
              }
            }
            // [Q4 BLOCKER] only prepend if BOTH block and composition are non-null.
            // block null → skip prepend AND record (gate pollution prevention).
            if (block && composition) {
              const priorSelected = typeof compositionLedger.getLastAcceptedSelectedSetHash === 'function'
                ? compositionLedger.getLastAcceptedSelectedSetHash({
                    runId: run.id,
                    slotKind: 'top',
                    provenanceKey: 'user',
                  })
                : null;
              const unchangedSelection = priorSelected &&
                composition.selected_set_hash != null &&
                priorSelected.selected_set_hash === composition.selected_set_hash;
              // Inject the block ONLY when the selection changed — this bounds
              // cross_project write-storms (a bumped revision with an identical
              // selection must not re-inject the same content every turn).
              if (!unchangedSelection) {
                effectiveText = `${block}\n\n---\n\n${effectiveText}`;
              }
              // ALWAYS record the accepted composition (even on the skip path) so
              // the gate baseline advances and shouldCompose converges. Without it a
              // churning cross_project revision recomposes EVERY turn forever
              // (Codex A2-4b SERIOUS). block===null still skips record above
              // (Q4 BLOCKER: gate stays open until memory appears).
              masterComposerInjection = {
                composition,
                provenanceKey: 'user',
                revision: currentOwnerRevisions[0].revision,
              };
            }
          }
        } catch (memErr) {
          log(`master composer injection skipped for ${conversationId} (run=${run.id}): ${memErr.message}`);
          masterComposerInjection = null;
        }
      }

    const validImages = Array.isArray(images)
      ? images.filter(img => img && typeof img.data === 'string' && typeof img.media_type === 'string')
      : undefined;

    let accepted = false;
    try {
      const result = adapter.runTurn(run.id, {
        text: effectiveText,
        images: validImages,
      });
      accepted = !!(result && result.accepted);
    } catch (runErr) {
      // Notice queue is untouched — next send will retry.
      const err = new Error(`Failed to deliver message to ${layerLabel} manager: ${runErr.message}`);
      err.httpStatus = 502;
      throw err;
    }
    if (!accepted) {
      // Notice queue is untouched — next send will retry.
      const err = new Error(`Failed to deliver message to ${layerLabel} manager`);
      err.httpStatus = 502;
      throw err;
    }

    // Commit the drain now that the send is confirmed accepted. We remove
    // EXACTLY the number of notices we peeked — if a concurrent worker
    // send appended more while runTurn was in flight, those tail entries
    // remain queued for the next turn (codex R1 blocker fix).
    if (notices.length > 0) {
      commitDrainParentNotices(run.id, notices.length);
    }

    // ML PR1 / A2-3a: record the injection ledger ONLY now that the turn is
    // accepted. This is the commit half of the peek-then-commit discipline:
    // if the send had failed above we would have thrown before reaching
    // here, leaving the ledger untouched so the next send re-injects.
    // Never let a ledger write break a successfully delivered message.
      if (composerInjection) {
        try {
          compositionLedger.commitAccepted(
            composerInjection.composition,
            {
              runId: run.id,
              conversationId,
              taskId: null,
              slotKind: 'pm',
              provenanceKey: composerInjection.provenanceKey,
            },
          );
        } catch (ledgerErr) {
          log(`composer ledger write failed for ${conversationId} (run=${run.id}): ${ledgerErr.message}`);
        }
      }
      // L2 P1b / A2-3b: commit the Master memory injection ledger (Top slot), same peek-then-commit discipline.
      if (masterComposerInjection) {
        try {
          compositionLedger.commitAccepted(
            masterComposerInjection.composition,
            {
              runId: run.id,
              conversationId,
              taskId: null,
              slotKind: 'top',
              provenanceKey: masterComposerInjection.provenanceKey,
            },
          );
        } catch (ledgerErr) {
          log(`master composer ledger write failed for ${conversationId} (run=${run.id}): ${ledgerErr.message}`);
        }
      }

    if (run.status === 'needs_input') {
      try { runService.updateRunStatus(run.id, 'running', { force: true }); } catch {}
    }

    // PM → Top: every user message to a PM is a staleness signal to its
    // parent Top (lock-in #2, no intent classification). We queue the
    // notice only if the PM's parent_run_id is the currently active Top
    // run — a historical parent is dropped.
    if (!isTop && run.parent_run_id) {
      const activeTopRunId = managerRegistry.getActiveRunId('top');
      if (activeTopRunId && activeTopRunId === run.parent_run_id) {
        const notice = formatParentNotice({
          childConversationId: conversationId,
          childRunId: run.id,
          text,
        });
        queueParentNotice(run.parent_run_id, notice);
      } else {
        log(`pm ${conversationId} (run=${run.id}) parent_run_id=${run.parent_run_id} is not the active Top — notice dropped`);
      }
    }

    const target = isTop
      ? { kind: 'top', runId: run.id }
      : { kind: 'pm', runId: run.id, projectId };
    return { status: 'sent', target };
  }

  function sendToWorker(workerRunId, { text, images }) {
    // Workers don't accept image payloads via tmux/subprocess — only text.
    // Phase 1.5 does not try to bridge that. If the client sent images
    // only, we reject with 400 so the UI can fall back to text.
    const hasText = typeof text === 'string' && text.length > 0;
    if (!hasText) {
      const err = new Error('worker conversations accept text only (no image-only messages)');
      err.httpStatus = 400;
      throw err;
    }

    let worker;
    try {
      worker = runService.getRun(workerRunId);
    } catch {
      const err = new Error(`worker run not found: ${workerRunId}`);
      err.httpStatus = 404;
      throw err;
    }
    if (worker.is_manager) {
      const err = new Error(`run ${workerRunId} is not a worker`);
      err.httpStatus = 400;
      throw err;
    }

    if (!lifecycleService || typeof lifecycleService.sendAgentInput !== 'function') {
      const err = new Error('worker delivery requires lifecycleService');
      err.httpStatus = 501;
      throw err;
    }

    // Deliver to worker FIRST. If delivery fails we must not queue a
    // parent notice — otherwise Top would receive a stale signal about a
    // message the worker never actually saw (codex review finding).
    let delivered = false;
    try {
      delivered = !!lifecycleService.sendAgentInput(workerRunId, text);
    } catch (deliverErr) {
      const err = new Error(`failed to deliver input to worker: ${deliverErr.message}`);
      err.httpStatus = 502;
      throw err;
    }
    if (!delivered) {
      const err = new Error('failed to deliver input to worker');
      err.httpStatus = 502;
      throw err;
    }

    // Principle 9 + lock-in #2: now that the worker really received the
    // message, queue a parent-staleness notice for whichever manager slot
    // currently owns this worker's parent. The parent may be either the
    // active Top (worker→Top, Phase 1.5) OR an active PM (worker→PM,
    // Phase 2 extension). In either case we queue by parent RUN id, and
    // the drain happens on that parent's next accepted turn. A historical
    // parent — one that is no longer registered in managerRegistry under
    // the expected slot — gets its notice dropped rather than applied to
    // some unrelated future run.
    if (worker.parent_run_id) {
      const parentSlot = resolveParentSlot(worker.parent_run_id);
      if (parentSlot) {
        const notice = formatParentNotice({
          childConversationId: worker.conversation_id || `worker:${worker.id}`,
          childRunId: worker.id,
          text,
        });
        queueParentNotice(worker.parent_run_id, notice);
      } else {
        log(`worker ${worker.id} parent_run_id=${worker.parent_run_id} is not an active manager slot — notice dropped`);
      }
    }

    return { status: 'sent', target: { kind: 'worker', runId: workerRunId } };
  }

  // Given a worker's parent run id, return the conversation slot key
  // ('top' | 'pm:<projectId>') if that parent is currently the live
  // occupant of that slot, or null otherwise. This is the single place
  // that decides "is this parent still the one users see?" for both Top
  // and PM layers.
  function resolveParentSlot(parentRunId) {
    if (!parentRunId) return null;
    // Fast path: Top slot
    const activeTopRunId = managerRegistry.getActiveRunId('top');
    if (activeTopRunId && activeTopRunId === parentRunId) return 'top';

    // PM slot: we need to know which project the parent run belongs to so
    // we can look up the right 'pm:<projectId>' registry key. We read the
    // parent run row to get its conversation_id (set at createRun time for
    // PM runs: 'pm:<projectId>'). If the parent isn't a PM manager, bail.
    let parent;
    try {
      parent = runService.getRun(parentRunId);
    } catch {
      return null;
    }
    if (!parent || !parent.is_manager || parent.manager_layer !== 'pm') return null;
    const pmSlotKey = parent.conversation_id;
    if (!pmSlotKey || !pmSlotKey.startsWith('pm:')) return null;
    const activePmRunId = managerRegistry.getActiveRunId(pmSlotKey);
    if (activePmRunId && activePmRunId === parentRunId) return pmSlotKey;
    return null;
  }

  // Events for a conversation are simply the events of the backing run,
  // forwarded through runService.getRunEvents (which already handles the
  // ?after= cursor).
  function getEvents(conversationId, afterId) {
    const resolved = resolveConversation(conversationId);
    if (!resolved || !resolved.run) return [];
    return runService.getRunEvents(resolved.run.id, afterId);
  }

  return {
    // queue surface (exported so routes/manager.js can also consume/clear)
    queueParentNotice,
    consumeParentNotices,
    clearParentNotices,
    prependPendingNotices,
    formatParentNotice,
    // routing
    parseConversationId,
    resolveConversation,
    sendMessage,
    getEvents,
  };
}

module.exports = { createConversationService };
