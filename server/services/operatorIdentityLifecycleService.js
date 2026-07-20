'use strict';

function createOperatorIdentityLifecycleService({
  operatorProfileService,
  operatorInstanceService,
  operatorCleanupService,
  logger,
}) {
  async function resetSharers(profileId) {
    for (const instanceId of operatorInstanceService.listInstanceIdsForProfile(profileId)) {
      await operatorCleanupService.resetInstance(instanceId);
    }
  }

  async function updateProfileContent(id, data) {
    const { identityChanged } = operatorProfileService.prepareUpdate(id, data);
    if (identityChanged) await resetSharers(id);
    return operatorProfileService.updateProfile(id, data);
  }

  async function assignProfile(instanceId, profileId) {
    operatorInstanceService.getInstance(instanceId);
    operatorProfileService.getProfile(profileId);
    await operatorCleanupService.resetInstance(instanceId);
    return operatorInstanceService.setProfileId(instanceId, profileId);
  }

  async function unassignProfile(instanceId) {
    operatorInstanceService.getInstance(instanceId);
    await operatorCleanupService.resetInstance(instanceId);
    return operatorInstanceService.createPrivateProfileFor(instanceId);
  }

  function deleteProfile(id) {
    return operatorProfileService.deleteProfile(id);
  }

  return { updateProfileContent, assignProfile, unassignProfile, deleteProfile };
}

module.exports = { createOperatorIdentityLifecycleService };
