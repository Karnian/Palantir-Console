// A2b — shared Operator prompt sections (codebase-pool-memory-axes-brief §5).
//
// The fresh-spawn path (operatorSpawnService) and the boot-resume path
// (routes/manager.js) now both assemble their project-scoped system-prompt
// sections through server/services/operatorPromptSections, so they can never
// drift (Codex R2 BLOCKER 3). The PM Role is favorite-pool-aware — it names the
// primary codebase but no longer hard-locks the Operator to it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProjectScopedSystemSection, PM_ROLE_SECTION } = require('../services/operatorPromptSections');

test('A2b: shared builder emits the expected sections + favorite-pool PM Role', () => {
  const section = buildProjectScopedSystemSection({
    project: { name: 'Alpha', id: 'proj_1', directory: '/tmp/alpha' },
    brief: { conventions: 'use tabs', known_pitfalls: 'flaky test X' },
    operatorRunId: 'run_mgr_1',
  });
  assert.match(section, /## Project Scope/);
  assert.match(section, /name: Alpha/);
  assert.match(section, /id: proj_1/);
  assert.match(section, /directory: \/tmp\/alpha/);
  assert.match(section, /pm_run_id: run_mgr_1/);
  assert.match(section, /## Project Conventions\nuse tabs/);
  assert.match(section, /## Known Pitfalls\nflaky test X/);
  assert.match(section, /## PM Role/);
  // favorite-pool wording present, pre-favorite hard lock gone
  assert.match(section, /shared codebase pool/i);
  assert.ok(!/Stay within this project's scope/.test(section), 'hard project-lock phrase must be removed');
});

test('A2b: optional brief fields + skill packs are conditionally included', () => {
  // No brief, no skill service → only Project Scope + PM Role.
  const minimal = buildProjectScopedSystemSection({
    project: { name: 'B', id: 'proj_2' },
    brief: null,
    operatorRunId: null,
  });
  assert.match(minimal, /## Project Scope/);
  assert.match(minimal, /## PM Role/);
  assert.ok(!/## Project Conventions/.test(minimal));
  assert.ok(!/## Known Pitfalls/.test(minimal));
  assert.ok(!/directory:/.test(minimal)); // no directory field
  assert.ok(!/pm_run_id:/.test(minimal)); // no run id

  // skill packs included when the service reports auto_apply bindings.
  const withSkills = buildProjectScopedSystemSection({
    project: { name: 'B', id: 'proj_2' },
    brief: null,
    operatorRunId: null,
    skillPackService: {
      listProjectBindings: () => [
        { skill_pack_name: 'lint', skill_pack_description: 'linter', skill_pack_id: 'sp_1', auto_apply: 1 },
        { skill_pack_name: 'skip', auto_apply: 0 }, // filtered out
      ],
    },
  });
  assert.match(withSkills, /## Project Skill Packs \(auto_apply\)/);
  assert.match(withSkills, /lint: linter \(id: sp_1\)/);
  assert.ok(!/skip/.test(withSkills));
});

test('A2b: skill-pack load failure is swallowed via logger (never throws)', () => {
  const errors = [];
  const section = buildProjectScopedSystemSection({
    project: { name: 'B', id: 'proj_2' },
    brief: null,
    operatorRunId: null,
    skillPackService: { listProjectBindings: () => { throw new Error('boom'); } },
    logger: (err) => errors.push(err),
  });
  assert.match(section, /## PM Role/); // still produced
  assert.ok(!/## Project Skill Packs/.test(section));
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /boom/);
});

test('A2b: PM_ROLE_SECTION is exported and mentions the shared pool', () => {
  assert.match(PM_ROLE_SECTION, /## PM Role/);
  assert.match(PM_ROLE_SECTION, /shared codebase pool/i);
  assert.match(PM_ROLE_SECTION, /skill_pack_ids/);
});
