'use strict';

function createOperatorIdentityLifecycleService({
  operatorProfileService,
  operatorInstanceService,
  operatorCleanupService,
  operatorSpawnService,
  logger,
}) {
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
    operatorInstanceService.getInstance(instanceId);
    operatorProfileService.getProfile(profileId);
    return withInstanceTransitions([instanceId], async () => {
      await operatorCleanupService.resetInstance(instanceId);
      return operatorInstanceService.setProfileId(instanceId, profileId);
    });
  }

  async function unassignProfile(instanceId) {
    operatorInstanceService.getInstance(instanceId);
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

  return {
    updateProfileContent,
    assignProfile,
    unassignProfile,
    setPreferredAdapter,
    deleteProfile,
  };
}

module.exports = { createOperatorIdentityLifecycleService };
