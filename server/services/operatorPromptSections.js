// server/services/operatorPromptSections.js
//
// A2b (codebase-pool-memory-axes-brief §5): the SINGLE source for an Operator's
// project-scoped system-prompt sections. Both the fresh spawn path
// (operatorSpawnService) and the boot-resume path (routes/manager.js) build the
// exact same block — previously each duplicated the strings inline, so a change
// to one silently drifted from the other (Codex R2 BLOCKER 3). Centralizing here
// guarantees fresh/resume byte-identical assembly and one place to evolve the
// PM Role text.
//
// The sections are baked into the STATIC system prompt (stable per Operator
// session → Codex prompt-cache-safe). Per-turn codebase selection is NOT baked
// here; it rides the user payload (turnMode/codebaseProjectId, A2a) so the
// static prompt stays cache-stable.

// Favorite-pool-aware PM Role (§4 LOCKED). The pre-favorite text said "Stay
// within this project's scope", which contradicts the shared-pool model where
// an Operator may be directed at any codebase. It now names the primary codebase
// as the default while allowing per-turn direction to another codebase in the
// pool (delivered in the turn's context, when present).
const PM_ROLE_SECTION = "## PM Role\n"
  + "You are an Operator (project-scoped dispatcher). Your PRIMARY codebase is the one shown in Project Scope above — it is your default cwd and routing target. "
  + "You work in a SHARED codebase pool: a given turn may direct you at a different codebase (its id/path appears in that turn's context when applicable); act on the codebase indicated for the turn, defaulting to your primary otherwise. "
  + "Every user turn is either: answer from the brief, dispatch a worker via /execute, or modify an in-flight worker via the worker intervention APIs above. "
  + "ALWAYS include your pm_run_id (shown in Project Scope above) in the /execute body when you dispatch a worker AND in your dispatch-audit claims — it attributes the worker to you so its review notification returns to you (never omit it).\n\n"
  + "When spawning workers, choose skill packs that match the task's nature. Use the target codebase's auto_apply skills as a baseline (a turn directed at another codebase uses THAT codebase's defaults, not your primary's), and add extra skills via skill_pack_ids when the task needs specialized capabilities beyond the defaults.";

/**
 * buildProjectScopedSystemSection
 *   { project, brief, operatorRunId, skillPackService?, logger? } → string
 *
 * project      — the primary project row (name/id/directory).
 * brief        — project_briefs row (conventions/known_pitfalls) or null.
 * operatorRunId — the Operator run id, baked so the Operator can self-identify
 *                 its pm_run_id for dispatch-audit.
 * skillPackService — optional; when present, auto_apply skill packs are listed.
 * logger       — optional (err) => void for skill-pack load failures.
 */
function buildProjectScopedSystemSection({ project, brief, operatorRunId, skillPackService, logger }) {
  const sections = [];
  sections.push(
    `## Project Scope\nname: ${project.name}\nid: ${project.id}`
    + `${project.directory ? `\ndirectory: ${project.directory}` : ''}`
    + `${operatorRunId ? `\npm_run_id: ${operatorRunId}` : ''}`,
  );
  if (brief && brief.conventions) {
    sections.push(`## Project Conventions\n${brief.conventions}`);
  }
  if (brief && brief.known_pitfalls) {
    sections.push(`## Known Pitfalls\n${brief.known_pitfalls}`);
  }
  if (skillPackService) {
    try {
      const bindings = skillPackService.listProjectBindings(project.id);
      const autoApply = bindings.filter((b) => b.auto_apply !== 0);
      if (autoApply.length > 0) {
        const lines = autoApply.map((b) =>
          `- ${b.skill_pack_name}${b.skill_pack_description ? `: ${b.skill_pack_description}` : ''} (id: ${b.skill_pack_id})`,
        );
        sections.push(
          '## Project Skill Packs (auto_apply)\n'
          + 'These skills are automatically applied to every worker in this project. '
          + 'You do NOT need to include them in skill_pack_ids.\n'
          + lines.join('\n'),
        );
      }
    } catch (err) {
      if (typeof logger === 'function') logger(err);
    }
  }
  sections.push(PM_ROLE_SECTION);
  return sections.join('\n\n');
}

module.exports = { buildProjectScopedSystemSection, PM_ROLE_SECTION };
