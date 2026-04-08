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
      // Phase 1.5: PM is not yet wired. Return a placeholder so /status can
      // show an empty PM slot without 404ing.
      return { kind: 'pm', conversationId: id, projectId: parsed.projectId, run: null };
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
      return sendToTop({ text, images });
    }
    if (parsed.kind === 'worker') {
      return sendToWorker(parsed.runId, { text, images });
    }
    if (parsed.kind === 'pm') {
      const err = new Error('PM conversation not yet implemented (Phase 3a)');
      err.httpStatus = 501;
      throw err;
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

  function sendToTop({ text, images }) {
    const run = managerRegistry.probeActive('top');
    if (!run) {
      const err = new Error('No active Top manager session');
      err.httpStatus = 404;
      throw err;
    }
    const adapter = managerRegistry.getActiveAdapter('top')
      || managerAdapterFactory.getAdapter(run.manager_adapter || 'claude-code');

    // Peek (do not drain) pending notices. We only commit the drain AFTER
    // the adapter accepts the turn. This prevents losing notices when the
    // send fails — codex review findings, lock-in #2.
    const notices = peekParentNotices(run.id);
    const originalText = text || '';
    const effectiveText = notices.length > 0
      ? `${notices.join('\n\n')}\n\n---\n\n${originalText}`
      : originalText;

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
      const err = new Error(`Failed to deliver message to Top manager: ${runErr.message}`);
      err.httpStatus = 502;
      throw err;
    }
    if (!accepted) {
      // Notice queue is untouched — next send will retry.
      const err = new Error('Failed to deliver message to Top manager');
      err.httpStatus = 502;
      throw err;
    }

    // Commit the drain now that the send is confirmed accepted.
    if (notices.length > 0) {
      consumeParentNotices(run.id);
    }

    if (run.status === 'needs_input') {
      try { runService.updateRunStatus(run.id, 'running', { force: true }); } catch {}
    }

    return { status: 'sent', target: { kind: 'top', runId: run.id } };
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
    // message, queue a parent-staleness notice for the currently live Top
    // — IF and only if the worker's parent_run_id matches it. A historical
    // parent (old Top that has since stopped) gets its notice dropped
    // rather than applied to some unrelated Top run.
    if (worker.parent_run_id) {
      const activeTopRunId = managerRegistry.getActiveRunId('top');
      if (activeTopRunId && activeTopRunId === worker.parent_run_id) {
        const notice = formatParentNotice({
          childConversationId: worker.conversation_id || `worker:${worker.id}`,
          childRunId: worker.id,
          text,
        });
        queueParentNotice(worker.parent_run_id, notice);
      } else {
        log(`worker ${worker.id} parent_run_id=${worker.parent_run_id} is not the active Top — notice dropped`);
      }
    }

    return { status: 'sent', target: { kind: 'worker', runId: workerRunId } };
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
