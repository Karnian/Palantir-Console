'use strict';

function createOperatorIdentityLifecycleService({
  operatorProfileService,
  operatorInstanceService,
  operatorCleanupService,
  operatorSpawnService,
  managerMessageQueueService,
  eventBus,
  logger,
}) {
  const log = logger || (() => {});
  async function withInstanceTransitions(instanceIds, action, index = 0) {
    if (index >= instanceIds.length) return action();
    if (!operatorSpawnService || typeof operatorSpawnService.withInstanceTransition !== 'function') {
      return withInstanceTransitions(instanceIds, action, index + 1);
    }
    return operatorSpawnService.withInstanceTransition(
      instanceIds[index],
      () => withInstanceTransitions(instanceIds, action, index + 1),
    );
  }

  async function resetInstances(instanceIds) {
    for (const instanceId of instanceIds) {
      await operatorCleanupService.resetInstance(instanceId);
    }
  }

  async function updateProfileContent(id, data) {
    const { identityChanged } = operatorProfileService.prepareUpdate(id, data);
    if (!identityChanged) return operatorProfileService.updateProfile(id, data);
    const instanceIds = operatorInstanceService.listInstanceIdsForProfile(id).sort();
    return withInstanceTransitions(instanceIds, async () => {
      await resetInstances(instanceIds);
      return operatorProfileService.updateProfile(id, data);
    });
  }

  async function assignProfile(instanceId, profileId) {
    operatorInstanceService.assertActiveInstance(instanceId);
    operatorProfileService.getProfile(profileId);
    return withInstanceTransitions([instanceId], async () => {
      await operatorCleanupService.resetInstance(instanceId);
      return operatorInstanceService.setProfileId(instanceId, profileId);
    });
  }

  async function unassignProfile(instanceId) {
    operatorInstanceService.assertActiveInstance(instanceId);
    return withInstanceTransitions([instanceId], async () => {
      await operatorCleanupService.resetInstance(instanceId);
      return operatorInstanceService.createPrivateProfileFor(instanceId);
    });
  }

  async function setPreferredAdapter(instanceId, preferredAdapter) {
    const prepared = operatorInstanceService.preparePreferredAdapterUpdate(
      instanceId,
      preferredAdapter,
    );
    if (!prepared.changed) {
      return { instance: prepared.instance, changed: false, reset: null };
    }
    const applyChange = async () => {
      const reset = await operatorCleanupService.resetInstance(instanceId);
      const instance = operatorInstanceService.setPreferredAdapter(
        instanceId,
        prepared.preferredAdapter,
      );
      return { instance, changed: true, reset };
    };
    if (operatorSpawnService && typeof operatorSpawnService.withInstanceTransition === 'function') {
      return operatorSpawnService.withInstanceTransition(instanceId, applyChange);
    }
    return applyChange();
  }

  function deleteProfile(id) {
    return operatorProfileService.deleteProfile(id);
  }

  async function archiveInstance(instanceId, { now = new Date() } = {}) {
    const current = operatorInstanceService.getInstance(instanceId);
    if (current.archived_at) {
      return {
        instance: current,
        already_archived: true,
        affected_codebases: [],
        archived_schedule_ids: [],
        cancelled_invocation_count: 0,
        terminalized_queue_count: 0,
        reset: null,
      };
    }
    if (!operatorSpawnService || typeof operatorSpawnService.withInstanceTransition !== 'function') {
      throw new Error('operator archive requires an instance transition fence');
    }

    return operatorSpawnService.withInstanceTransition(instanceId, async () => {
      // Re-check after acquiring the fence so a completed earlier request is
      // idempotent and no second runtime reset is attempted.
      const fenced = operatorInstanceService.getInstance(instanceId);
      if (fenced.archived_at) {
        return {
          instance: fenced,
          already_archived: true,
          affected_codebases: [],
          archived_schedule_ids: [],
          cancelled_invocation_count: 0,
          terminalized_queue_count: 0,
          reset: null,
        };
      }

      operatorInstanceService.assertActiveInstance(instanceId);
      const reset = await operatorCleanupService.resetInstance(instanceId);
      const archived = operatorInstanceService.archiveDatabaseState(instanceId, {
        now,
        terminalizeQueued: managerMessageQueueService
          && typeof managerMessageQueueService.terminalizeQueuedForConversation === 'function'
          ? (conversationId, options) => (
              managerMessageQueueService.terminalizeQueuedForConversation(conversationId, options)
            )
          : null,
      });

      const terminalized = managerMessageQueueService
        && typeof managerMessageQueueService.notifyTerminalized === 'function'
        ? managerMessageQueueService.notifyTerminalized(archived.terminalized_queue_messages)
        : [];
      if (eventBus) {
        try {
          for (const scheduleId of archived.archived_schedule_ids) {
            eventBus.emit('operator:schedule', {
              kind: 'schedule_changed',
              schedule_id: scheduleId,
              operator_instance_id: instanceId,
              archived: true,
            });
          }
          eventBus.emit('operator:archived', {
            operator_instance_id: instanceId,
            archived_at: archived.instance.archived_at,
            affected_codebases: archived.affected_codebases,
          });
        } catch (err) {
          log(`operator archive post-commit event failed instance=${instanceId}: ${err.message}`);
        }
      }

      return {
        instance: archived.instance,
        already_archived: archived.already_archived,
        affected_codebases: archived.affected_codebases,
        archived_schedule_ids: archived.archived_schedule_ids,
        cancelled_invocation_count: archived.cancelled_invocation_count,
        terminalized_queue_count: terminalized.length,
        reset,
      };
    });
  }

  return {
    updateProfileContent,
    assignProfile,
    unassignProfile,
    setPreferredAdapter,
    archiveInstance,
    deleteProfile,
  };
}

module.exports = { createOperatorIdentityLifecycleService };
