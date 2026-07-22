'use strict';

const { conversationIdForProject } = require('../utils/conversationId');

const DEFAULT_INTERVAL_MS = 20000;
const DEFAULT_MAX_JOBS = 20;

function createOperatorScheduler({
  operatorScheduleService,
  conversationService,
  managerRegistry,
  projectService,
  nodeService,
  runService,
  eventBus,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxJobs = DEFAULT_MAX_JOBS,
} = {}) {
  if (!operatorScheduleService) throw new Error('operatorScheduleService is required');
  const log = logger || ((message) => console.warn(`[operator-scheduler] ${message}`));
  let timer = null;
  let inflight = null;
  let unsubscribe = null;
  let stopped = false;

  function wait(invocation, reason, error, delayMs) {
    return operatorScheduleService.releaseClaim(invocation.id, invocation.claim_token, {
      waitingReason: reason,
      error,
      delayMs,
    });
  }

  async function deliver(invocation) {
    let context;
    try {
      context = operatorScheduleService.getInvocationContext(invocation.id);
    } catch (err) {
      operatorScheduleService.cancelClaim(invocation.id, invocation.claim_token, 'invalid_snapshot', err.message);
      return null;
    }

    const { schedule, project, primaryProjectId } = context;
    if (schedule && (schedule.archived_at || schedule.revision !== invocation.schedule_revision)) {
      operatorScheduleService.cancelClaim(invocation.id, invocation.claim_token, 'schedule_changed');
      return null;
    }
    if (Number(project.pm_enabled) === 0) {
      operatorScheduleService.cancelClaim(invocation.id, invocation.claim_token, 'codebase_disabled');
      return null;
    }

    const activeTopRunId = managerRegistry && typeof managerRegistry.getActiveRunId === 'function'
      ? managerRegistry.getActiveRunId('top')
      : null;
    if (!activeTopRunId) {
      return wait(invocation, 'top_unavailable', 'Top manager is not active', 60000);
    }

    let primaryProject;
    try {
      primaryProject = projectService.getProject(primaryProjectId);
    } catch (err) {
      operatorScheduleService.cancelClaim(invocation.id, invocation.claim_token, 'primary_folder_missing', err.message);
      return null;
    }
    if (Number(primaryProject.pm_enabled) === 0) {
      operatorScheduleService.cancelClaim(invocation.id, invocation.claim_token, 'operator_disabled');
      return null;
    }

    const nodeId = primaryProject.node_id || 'local';
    if (nodeId !== 'local' && nodeService && typeof nodeService.getNode === 'function') {
      let node;
      try { node = nodeService.getNode(nodeId); } catch { node = null; }
      if (!node) return wait(invocation, 'node_unavailable', `Node not found: ${nodeId}`, 60000);
      if (Number(node.cordoned) === 1) return wait(invocation, 'node_cordoned', `Node is cordoned: ${nodeId}`, 60000);
      if (Number(node.reachable) !== 1) return wait(invocation, 'node_unreachable', `Node is unreachable: ${nodeId}`, 60000);
    }

    // Persist the non-atomic external delivery window before touching the
    // adapter. A process crash from here until markRunning is recovered as
    // uncertain and is never replayed automatically.
    operatorScheduleService.markDelivering(invocation.id, invocation.claim_token);

    let sent;
    try {
      sent = conversationService.sendMessage(
        conversationIdForProject(invocation.operator_instance_id),
        {
          text: invocation.prompt_snapshot,
          codebaseProjectId: project.id,
          turnMode: 'codebase',
          source: invocation.source === 'manual_run_now' ? 'manual_run_now' : 'scheduled',
          invocationId: invocation.id,
        },
      );
      if (sent && typeof sent.then === 'function') sent = await sent;
    } catch (err) {
      const status = Number(err?.httpStatus || err?.status || 0);
      if (status === 409 || status === 404) {
        return wait(invocation, status === 409 ? 'operator_unavailable' : 'operator_missing', err.message, 60000);
      }
      if (status === 502 && /deliver message|previous turn|in flight|busy/i.test(err.message || '')) {
        return wait(invocation, 'operator_busy', err.message, 30000);
      }
      if (status === 400 || /spawn|startSession|materializ|auth unavailable|binding mismatch/i.test(err.message || '')) {
        operatorScheduleService.failClaim(invocation.id, invocation.claim_token, err.message);
        return null;
      }
      // Delivery acceptance is uncertain for arbitrary transport failures. Do
      // not replay automatically: a duplicate LLM turn is more harmful than a
      // human-visible uncertain invocation.
      operatorScheduleService.markClaimUncertain(invocation.id, invocation.claim_token, err.message);
      return null;
    }

    const managerRunId = sent?.target?.runId;
    if (!managerRunId) {
      return wait(invocation, 'operator_busy', 'delivery did not return a manager run id', 30000);
    }
    const running = operatorScheduleService.markRunning(invocation.id, invocation.claim_token, managerRunId);
    try {
      runService.addRunEvent(managerRunId, 'operator:schedule_dispatched', JSON.stringify({
        invocation_id: invocation.id,
        schedule_id: invocation.schedule_id,
        source: invocation.source,
        codebase_project_id: project.id,
      }));
    } catch { /* annotate-only */ }
    return running;
  }

  async function drainAll() {
    const results = [];
    for (let i = 0; i < maxJobs; i += 1) {
      const invocation = operatorScheduleService.claimNext(new Date());
      if (!invocation) break;
      try {
        results.push(await deliver(invocation));
      } catch (err) {
        log(`delivery ${invocation.id}: ${err.message}`);
        try { operatorScheduleService.failClaim(invocation.id, invocation.claim_token, err.message); } catch { /* lost claim */ }
      }
    }
    return results;
  }

  async function runTick() {
    operatorScheduleService.materializeDue(new Date());
    return drainAll();
  }

  function tick() {
    if (stopped || inflight) return inflight;
    inflight = Promise.resolve()
      .then(runTick)
      .catch((err) => log(`tick failed: ${err.message}`))
      .finally(() => { inflight = null; });
    return inflight;
  }

  function onEvent(event) {
    if (event?.channel !== 'run:event') return;
    const type = event.data?.eventType;
    if (type !== 'mgr.turn_completed' && type !== 'mgr.turn_failed') return;
    try {
      operatorScheduleService.completeByManagerRun(
        event.data.runId,
        type === 'mgr.turn_completed',
        type === 'mgr.turn_failed' ? 'manager turn failed' : null,
      );
    } catch (err) {
      log(`completion correlation failed: ${err.message}`);
    }
  }

  function start() {
    if (timer) return { stop, tick, awaitDrain };
    stopped = false;
    operatorScheduleService.recoverAfterRestart(new Date());
    if (eventBus && typeof eventBus.subscribe === 'function') unsubscribe = eventBus.subscribe(onEvent);
    timer = setInterval(tick, Math.max(1000, Number(intervalMs) || DEFAULT_INTERVAL_MS));
    if (typeof timer.unref === 'function') timer.unref();
    tick();
    return { stop, tick, awaitDrain };
  }

  function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  function awaitDrain() {
    return inflight;
  }

  return { start, stop, tick, awaitDrain, drainAll, deliver };
}

module.exports = { DEFAULT_INTERVAL_MS, createOperatorScheduler };
