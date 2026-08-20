// A2b — shared Operator prompt sections (codebase-pool-memory-axes-brief §5).
//
// The fresh-spawn path (operatorSpawnService) and the boot-resume path
// (routes/manager.js) now both assemble their project-scoped system-prompt
// sections through server/services/operatorPromptSections, so they can never
// drift (Codex R2 BLOCKER 3). The PM Role is favorite-pool-aware — it names the
// primary codebase but no longer hard-locks the Operator to it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildProjectScopedSystemSection, buildFinalOperatorSystemPrompt, PM_ROLE_SECTION } = require('../services/operatorPromptSections');

const SENTINEL = '\u0000PALANTIR_OPERATION_SEGMENT:';
const SENTINEL_SUFFIX = ':PALANTIR_OPERATION_SEGMENT\u0000';

test('A2b: shared builder emits the expected sections + favorite-pool PM Role', () => {
  const section = buildProjectScopedSystemSection({
    project: { name: 'Alpha', id: 'proj_1', directory: '/tmp/alpha' },
    profile: { persona: 'Act as a cautious release operator.' },
    brief: { conventions: 'use tabs', known_pitfalls: 'flaky test X' },
    operatorRunId: 'run_mgr_1',
  });
  assert.match(section, /## Project Scope/);
  assert.match(section, /name: Alpha/);
  assert.match(section, /id: proj_1/);
  assert.match(section, /directory: \/tmp\/alpha/);
  assert.match(section, /pm_run_id: run_mgr_1/);
  assert.match(section, /## Operator Brief/);
  assert.match(section, /### Role and Behavior\nAct as a cautious release operator\./);
  assert.match(section, /### Codebase Conventions\nuse tabs/);
  assert.match(section, /### Known Pitfalls\nflaky test X/);
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
  assert.ok(!/## Operator Brief/.test(minimal));
  assert.ok(!/### Codebase Conventions/.test(minimal));
  assert.ok(!/### Known Pitfalls/.test(minimal));
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

test('final Operator prompt rejects sentinels in project name, persona, and brief fields', () => {
  const cases = [
    { project: { name: `bad${SENTINEL}`, id: 'p' } },
    { project: { name: 'p', id: 'p' }, profile: { persona: `bad${SENTINEL}` } },
    { project: { name: 'p', id: 'p' }, brief: { conventions: `bad${SENTINEL}` } },
    { project: { name: 'p', id: 'p' }, brief: { known_pitfalls: `bad${SENTINEL}` } },
    // codex R2 비차단 보강: suffix 단독으로도 거부되어야 한다. prefix 만 막으면
    // 여는 쪽을 다른 경로에서 얻은 공격자가 닫는 쪽만 주입해 마커를 완성할 수 있다.
    { project: { name: `bad${SENTINEL_SUFFIX}`, id: 'p' } },
    // Skill pack names/descriptions reach the prompt through skillPackService,
    // not a plain field -- exercise that path, not a shape the builder ignores.
    {
      project: { name: 'p', id: 'p' },
      skillPackService: {
        listProjectBindings: () => [{
          skill_pack_id: 'sp1', skill_pack_name: `bad${SENTINEL}`, skill_pack_description: 'd', auto_apply: 1,
        }],
      },
    },
    {
      project: { name: 'p', id: 'p' },
      skillPackService: {
        listProjectBindings: () => [{
          skill_pack_id: 'sp1', skill_pack_name: 'n', skill_pack_description: `bad${SENTINEL_SUFFIX}`, auto_apply: 1,
        }],
      },
    },
  ];
  for (const value of cases) {
    assert.throws(
      () => buildFinalOperatorSystemPrompt({ baseSystemPrompt: 'base', ...value }),
      error => error.code === 'OPERATOR_PROMPT_USER_SENTINEL',
    );
  }
});

test('final Operator prompt permits /api/ in user data and preserves normal assembly bytes', () => {
  const args = {
    baseSystemPrompt: 'base',
    project: { name: 'docs /api/project', id: 'p', directory: '/tmp/api/work' },
    profile: { persona: 'Explain /api/persona literally.' },
    brief: { conventions: 'Keep /api/brief unchanged.' },
  };
  const section = buildProjectScopedSystemSection(args);
  assert.equal(buildFinalOperatorSystemPrompt(args), `base\n\n${section}`);
});
