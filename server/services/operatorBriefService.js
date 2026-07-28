'use strict';

const { BadRequestError } = require('../utils/errors');
const { buildOperatorBriefSection } = require('./operatorPromptSections');

function createOperatorBriefService({
  db,
  operatorInstanceService,
  operatorProfileService,
  projectBriefService,
  operatorCleanupService,
  operatorSpawnService,
}) {
  if (!db) throw new Error('createOperatorBriefService: db is required');
  if (!operatorInstanceService) throw new Error('createOperatorBriefService: operatorInstanceService is required');
  if (!operatorProfileService) throw new Error('createOperatorBriefService: operatorProfileService is required');
  if (!projectBriefService) throw new Error('createOperatorBriefService: projectBriefService is required');
  if (!operatorCleanupService) throw new Error('createOperatorBriefService: operatorCleanupService is required');

  function mappedProjectRef(instance, projectId = null) {
    const refs = Array.isArray(instance?.refs) ? instance.refs : [];
    const requested = typeof projectId === 'string' ? projectId.trim() : '';
    if (requested) {
      const matched = refs.find((ref) => ref.project_id === requested);
      if (!matched) {
        throw new BadRequestError(`project_id is not mapped to operator instance: ${requested}`);
      }
      return matched;
    }
    return refs.find((ref) => ref.role === 'primary') || refs[0] || null;
  }

  function readEffectiveBrief(instanceId, { projectId = null } = {}) {
    const instance = operatorInstanceService.getInstance(instanceId);
    const profile = operatorProfileService.getProfile(instance.profile_id);
    const projectRef = mappedProjectRef(instance, projectId);
    const projectBrief = projectRef
      ? projectBriefService.getBrief(projectRef.project_id)
      : null;
    const content = {
      persona: profile.persona || null,
      conventions: projectBrief?.conventions || null,
      known_pitfalls: projectBrief?.known_pitfalls || null,
    };
    return {
      instance_id: instance.id,
      profile: {
        id: profile.id,
        name: profile.name,
        updated_at: profile.updated_at || null,
      },
      project: projectRef
        ? {
            id: projectRef.project_id,
            name: projectRef.project?.name || projectRef.project_name || null,
            role: projectRef.role,
            updated_at: projectBrief?.updated_at || null,
          }
        : null,
      ...content,
      prompt_section: buildOperatorBriefSection({
        profile: content,
        brief: content,
      }),
    };
  }

  function assertUpdateBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestError('request body must be an object');
    }
    const allowed = ['persona', 'conventions', 'known_pitfalls'];
    if (!allowed.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
      throw new BadRequestError('one of persona, conventions, or known_pitfalls is required');
    }
  }

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
    const results = [];
    for (const instanceId of instanceIds) {
      results.push(await operatorCleanupService.resetInstance(instanceId));
    }
    return results;
  }

  function sortedUnique(values) {
    return Array.from(new Set(values.filter(Boolean))).sort();
  }

  async function updateEffectiveBrief(instanceId, { projectId = null, body = {} } = {}) {
    assertUpdateBody(body);
    const instance = operatorInstanceService.assertActiveInstance(instanceId);
    const profile = operatorProfileService.getProfile(instance.profile_id);
    const projectRef = mappedProjectRef(instance, projectId);
    const hasPersona = Object.prototype.hasOwnProperty.call(body, 'persona');
    const projectFields = {};
    if (Object.prototype.hasOwnProperty.call(body, 'conventions')) {
      projectFields.conventions = body.conventions;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'known_pitfalls')) {
      projectFields.known_pitfalls = body.known_pitfalls;
    }
    if (Object.keys(projectFields).length > 0 && !projectRef) {
      throw new BadRequestError('a mapped project is required for codebase brief fields');
    }

    const profilePrepared = hasPersona
      ? operatorProfileService.prepareUpdate(profile.id, { persona: body.persona })
      : null;
    const projectPrepared = projectRef && Object.keys(projectFields).length > 0
      ? projectBriefService.prepareUpdate(projectRef.project_id, projectFields)
      : null;
    const personaChanged = Boolean(profilePrepared?.identityChanged);
    const projectChanged = Boolean(projectPrepared?.contentChanged);
    const affectedInstanceIds = sortedUnique([
      ...(personaChanged ? operatorInstanceService.listInstanceIdsForProfile(profile.id) : []),
      ...(projectChanged ? operatorInstanceService.listInstanceIdsForProject(projectRef.project_id) : []),
    ]);

    if (!personaChanged && !projectChanged) {
      return {
        brief: readEffectiveBrief(instance.id, { projectId: projectRef?.project_id || null }),
        reset_instance_ids: [],
      };
    }

    return withInstanceTransitions(affectedInstanceIds, async () => {
      await resetInstances(affectedInstanceIds);
      db.transaction(() => {
        if (personaChanged) {
          operatorProfileService.updateProfile(profile.id, { persona: body.persona });
        }
        if (projectChanged) {
          projectBriefService.updateBrief(projectRef.project_id, projectFields);
        }
      })();
      return {
        brief: readEffectiveBrief(instance.id, { projectId: projectRef?.project_id || null }),
        reset_instance_ids: affectedInstanceIds,
      };
    });
  }

  async function updateProjectContext(projectId, fields = {}) {
    const prepared = projectBriefService.prepareUpdate(projectId, fields);
    if (!prepared.contentChanged) {
      return {
        brief: projectBriefService.ensureBrief(projectId),
        reset_instance_ids: [],
      };
    }
    const affectedInstanceIds = sortedUnique(
      operatorInstanceService.listInstanceIdsForProject(projectId),
    );
    return withInstanceTransitions(affectedInstanceIds, async () => {
      await resetInstances(affectedInstanceIds);
      const brief = projectBriefService.updateBrief(projectId, fields);
      return { brief, reset_instance_ids: affectedInstanceIds };
    });
  }

  return {
    readEffectiveBrief,
    updateEffectiveBrief,
    updateProjectContext,
  };
}

module.exports = { createOperatorBriefService };
