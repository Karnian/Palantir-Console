'use strict';

function createOperatorIdentityLifecycleService({
  operatorProfileService,
  operatorInstanceService,
  operatorCleanupService,
  logger,
}) {
  function resetSharers(profileId) {
    for (const instanceId of operatorInstanceService.listInstanceIdsForProfile(profileId)) {
      operatorCleanupService.resetInstance(instanceId);
    }
  }

  function updateProfileContent(id, data) {
    const { identityChanged } = operatorProfileService.prepareUpdate(id, data);
    if (identityChanged) resetSharers(id);
    return operatorProfileService.updateProfile(id, data);
  }

  function assignProfile(instanceId, profileId) {
    operatorInstanceService.getInstance(instanceId);
    operatorProfileService.getProfile(profileId);
    operatorCleanupService.resetInstance(instanceId);
    return operatorInstanceService.setProfileId(instanceId, profileId);
  }

  function unassignProfile(instanceId) {
    operatorInstanceService.getInstance(instanceId);
    operatorCleanupService.resetInstance(instanceId);
    return operatorInstanceService.createPrivateProfileFor(instanceId);
  }

  function deleteProfile(id) {
    return operatorProfileService.deleteProfile(id);
  }

  return { updateProfileContent, assignProfile, unassignProfile, deleteProfile };
}

module.exports = { createOperatorIdentityLifecycleService };
