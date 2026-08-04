'use strict';

/**
 * Manager-callable operation manifest.
 *
 * `request_body` describes the manager agent-call contract. It is NOT the
 * source of truth for route validation; validators and actor gates remain in
 * the routes/services that enforce them. Keeping that distinction explicit
 * prevents this prompt-facing contract from being mistaken for an HTTP schema.
 *
 * The data below is deliberately JSON-serializable and deterministic. It does
 * not consult the database, clock, environment, process, or mounted routers.
 * `availability` is verified against the corresponding mounted-router gates by
 * manager-operation-manifest.test.js. PR 2's `/api/agent-context` consumer will
 * use the already-verified value for filtering.
 */

const LAYERS = Object.freeze(['top', 'operator']);
const NO_BODY = {
  contract_scope: 'manager_agent_call_not_route_validator_source',
  required: [],
  optional: [],
  types: {},
  examples: {},
  replay: null,
};

function body({
  required = [], optional = [], types = {}, examples = {}, prompt_render_overrides = {},
  replay = { mode: 'mounted_route_success' },
} = {}) {
  return {
    contract_scope: 'manager_agent_call_not_route_validator_source',
    required,
    optional,
    types,
    examples,
    prompt_render_overrides,
    replay,
  };
}

function prompt({ visible = false, section = null, order = 0, lines = [], layer_variants = {}, adapter_variants = {} } = {}) {
  return { visible, section, order, lines, layer_variants, adapter_variants };
}

const operations = [
  {
    id: 'runs.list', method: 'GET', path_template: '/api/runs', layers: [...LAYERS], availability: 'always',
    path_params: [],
    query: [
      { name: 'status', required: false, type: 'string', example: 'running' },
      { name: 'task_id', required: false, type: 'string', example: 'TASK_ID' },
    ],
    request_body: NO_BODY, constraints: [], canonical_cases: ['/api/runs', '/api/runs?status=running', '/api/runs?task_id=task-1'],
    prompt: prompt({ visible: true, section: 'runs', order: 10, lines: [
      { label: 'List all runs' },
      { label: 'Filter by status', query: 'status=running' },
      { label: 'Filter by task', query: 'task_id=TASK_ID' },
    ] }),
  },
  {
    id: 'runs.get', method: 'GET', path_template: '/api/runs/{run_id}', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'run_id', type: 'string', prompt_value: 'RUN_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/runs/run-1'],
    prompt: prompt({ visible: true, section: 'runs', order: 20, lines: [{ label: 'Get single run' }] }),
  },
  {
    id: 'runs.events', method: 'GET', path_template: '/api/runs/{run_id}/events', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'run_id', type: 'string', prompt_value: 'RUN_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/runs/run-1/events'],
    prompt: prompt({ visible: true, section: 'runs', order: 30, lines: [{ label: 'Get run events' }] }),
  },
  {
    id: 'runs.output', method: 'GET', path_template: '/api/runs/{run_id}/output', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'run_id', type: 'string', prompt_value: 'RUN_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/runs/run-1/output'],
    prompt: prompt({ visible: true, section: 'runs', order: 40, lines: [{ label: 'Get run output' }] }),
  },
  {
    id: 'runs.send_input', method: 'POST', path_template: '/api/runs/{run_id}/input', layers: ['operator'], availability: 'always',
    path_params: [{ name: 'run_id', type: 'string', prompt_value: 'RUN_ID' }], query: [],
    request_body: body({ required: ['text'], types: { text: 'string' }, examples: { operator: { rest: { text: '...' } } } }),
    constraints: [
      { id: 'operator_only', critical: true, rule: 'Worker input is Operator-only.' },
      { id: 'worker_target_only', critical: true, rule: 'A manager capability may not intervene in a manager run.' },
    ],
    canonical_cases: ['/api/runs/run-1/input'],
    prompt: prompt({ visible: true, section: 'runs', order: 50, lines: [{ label: 'Send input to run', body_example: 'rest' }], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'runs.cancel', method: 'POST', path_template: '/api/runs/{run_id}/cancel', layers: ['operator'], availability: 'always',
    path_params: [{ name: 'run_id', type: 'string', prompt_value: 'RUN_ID' }], query: [], request_body: NO_BODY,
    constraints: [
      { id: 'operator_only', critical: true, rule: 'Worker cancellation is Operator-only.' },
      { id: 'worker_target_only', critical: true, rule: 'A manager capability may not intervene in a manager run.' },
    ],
    canonical_cases: ['/api/runs/run-1/cancel'],
    prompt: prompt({ visible: true, section: 'runs', order: 60, lines: [{ label: 'Cancel run' }], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'tasks.list', method: 'GET', path_template: '/api/tasks', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [
      { name: 'status', required: false, type: 'string', example: 'in_progress' },
      { name: 'project_id', required: false, type: 'string', example: 'PROJECT_ID' },
    ], request_body: NO_BODY, constraints: [], canonical_cases: ['/api/tasks', '/api/tasks?status=in_progress', '/api/tasks?project_id=project-1'],
    prompt: prompt({ visible: true, section: 'tasks', order: 10, lines: [
      { label: 'List all tasks' },
      { label: 'Filter by status', query: 'status=in_progress' },
      { label: 'Filter by project', query: 'project_id=PROJECT_ID' },
    ] }),
  },
  {
    id: 'tasks.get', method: 'GET', path_template: '/api/tasks/{task_id}', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'task_id', type: 'string', prompt_value: 'TASK_ID' }], query: [], request_body: NO_BODY,
    constraints: [],
    canonical_cases: ['/api/tasks/task-1'], prompt: prompt(),
  },
  {
    id: 'tasks.create', method: 'POST', path_template: '/api/tasks', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [],
    request_body: body({
      required: ['title'], optional: ['description', 'priority', 'project_id'],
      types: { title: 'string', description: 'string', priority: 'string', project_id: 'string' },
      examples: {
        top: { rest: { title: '...', description: '...', priority: 'medium', project_id: 'PROJECT_ID' }, curl: { title: '...', project_id: '...' } },
        operator: { rest: { title: '...', description: '...', priority: 'medium', project_id: 'PROJECT_ID' }, curl: { title: '...', project_id: '...' } },
      },
    }),
    constraints: [{ id: 'project_assignment', critical: false, rule: 'Include project_id only for a clearly matching existing project.' }],
    canonical_cases: ['/api/tasks'],
    prompt: prompt({ visible: true, section: 'tasks', order: 20, lines: [{
      label: 'Create task', body_example: 'rest',
      after: '  Only include project_id if the task clearly belongs to an existing project. If unrelated, omit project_id (the task will be unassigned). Do NOT guess or force a project assignment.',
    }] }),
  },
  {
    id: 'tasks.update', method: 'PATCH', path_template: '/api/tasks/{task_id}', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'task_id', type: 'string', prompt_value: 'TASK_ID' }], query: [],
    request_body: body({
      required: [], optional: ['title', 'description', 'priority', 'project_id', 'goal_enabled', 'goal_max_attempts', 'goal_judge_enabled'],
      types: { title: 'string', description: 'string', priority: 'string', project_id: 'string|null', goal_enabled: 'boolean', goal_max_attempts: 'number', goal_judge_enabled: 'boolean' },
      examples: { top: { rest: { title: '...', description: '...', priority: 'high' } }, operator: { rest: { title: '...', description: '...', priority: 'high' } } },
    }),
    constraints: [
      { id: 'reorder_not_task_id', critical: true, rule: 'The static task id reorder is not manager-callable through the task-id PATCH operation.' },
      { id: 'goal_task_not_done', critical: true, rule: 'A manager mutation may not leave a goal-enabled task in done status.' },
    ],
    canonical_cases: ['/api/tasks/task-1'],
    prompt: prompt({ visible: true, section: 'tasks', order: 30, lines: [{ label: 'Update task', body_example: 'rest' }] }),
  },
  {
    id: 'tasks.update_status', method: 'PATCH', path_template: '/api/tasks/{task_id}/status', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'task_id', type: 'string', prompt_value: 'TASK_ID' }], query: [],
    request_body: body({ required: ['status'], types: { status: 'string' }, examples: {
      top: { done: { status: 'done' } }, operator: { done: { status: 'done' } },
    } }),
    constraints: [
      { id: 'goal_task_done_forbidden', critical: true, rule: 'Managers must not mark goal-enabled tasks done; leave them in review and recommend human acceptance or rejection.', prompt_text: '- For a goal-enabled task, do not mark it "done": recommend human acceptance/rejection and leave its status in "review".' },
    ],
    canonical_cases: ['/api/tasks/task-1/status'],
    prompt: prompt({ visible: true, section: 'tasks', order: 40, lines: [{ label: 'Complete a satisfactory non-goal task', body_example: 'done', constraint_after: 'goal_task_done_forbidden' }] }),
  },
  {
    id: 'tasks.delete', method: 'DELETE', path_template: '/api/tasks/{task_id}', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'task_id', type: 'string', prompt_value: 'TASK_ID' }], query: [], request_body: NO_BODY,
    constraints: [],
    canonical_cases: ['/api/tasks/task-1'],
    prompt: prompt({ visible: true, section: 'tasks', order: 50, lines: [{ label: 'Delete task' }] }),
  },
  {
    id: 'tasks.execute', method: 'POST', path_template: '/api/tasks/{task_id}/execute', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'task_id', type: 'string', prompt_value: 'TASK_ID' }], query: [],
    request_body: body({
      required: ['agent_profile_id', 'prompt'], optional: ['skill_pack_ids', 'preset_id', 'pm_run_id'],
      types: { agent_profile_id: 'string', prompt: 'string', skill_pack_ids: 'string[]', preset_id: 'string', pm_run_id: 'string' },
      examples: {
        top: {
          rest: { agent_profile_id: 'AGENT_ID', prompt: 'detailed work instructions here' },
          workflow: { agent_profile_id: 'AGENT_ID', prompt: 'detailed instructions' },
        },
        operator: {
          rest: { agent_profile_id: 'AGENT_ID', prompt: 'detailed work instructions here', pm_run_id: 'YOUR_OWN_OPERATOR_RUN_ID', skill_pack_ids: ['PACK_ID', '...'] },
          workflow: { agent_profile_id: 'AGENT_ID', prompt: 'detailed instructions', pm_run_id: 'YOUR_OWN_OPERATOR_RUN_ID' },
          skill_pack: { agent_profile_id: 'AGENT_ID', prompt: '...', pm_run_id: 'YOUR_OWN_OPERATOR_RUN_ID', skill_pack_ids: ['pack-id-1', 'pack-id-2'] },
        },
      },
      prompt_render_overrides: {
        operator: {
          rest: {
            raw_json_values: [{ path: ['skill_pack_ids', 1], value: '...' }],
          },
        },
      },
    }),
    constraints: [
      { id: 'operator_pm_run_self_attribution', critical: true, rule: 'Operator calls must include their own manager run id as pm_run_id.' },
      { id: 'top_no_pm_run_attribution', critical: true, rule: 'Top calls must omit pm_run_id or send it as null; a non-null value is forbidden.' },
    ],
    canonical_cases: ['/api/tasks/task-1/execute'],
    prompt: prompt({ visible: true, section: 'tasks', order: 60, lines: [{
      label: 'Execute task with agent', body_example: 'rest',
      after_by_layer: { operator: '  pm_run_id (ALWAYS include this when you dispatch): YOUR OWN Operator run id (shown in your Project Scope section). It attributes the spawned worker to YOU so the worker\'s completion/failure review notification comes back to YOU — including for a turn directed at a codebase you don\'t primarily own. Omitting it leaves the worker unattributed and its review falls back to the codebase\'s default Operator.\n  skill_pack_ids (optional): array of skill pack IDs to equip on the worker for this run. These are per-run ephemeral — they do NOT persist as task bindings. Omit to use only project auto_apply + task persistent bindings.' },
    }] }),
  },
  {
    id: 'projects.list', method: 'GET', path_template: '/api/projects', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [], request_body: NO_BODY, constraints: [], canonical_cases: ['/api/projects'],
    prompt: prompt({ visible: true, section: 'projects', order: 10, lines: [{ label: 'List projects' }] }),
  },
  {
    id: 'projects.tasks', method: 'GET', path_template: '/api/projects/{project_id}/tasks', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'project_id', type: 'string', prompt_value: 'PROJECT_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/projects/project-1/tasks'],
    prompt: prompt({ visible: true, section: 'projects', order: 20, lines: [{ label: 'Get project tasks' }] }),
  },
  {
    id: 'projects.memory', method: 'GET', path_template: '/api/projects/{project_id}/memory', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'project_id', type: 'string', prompt_value: 'PROJECT_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/projects/project-1/memory'],
    prompt: prompt({ visible: true, section: 'context', order: 10, lines: [], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'projects.skill_packs', method: 'GET', path_template: '/api/projects/{project_id}/skill-packs', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'project_id', type: 'string', prompt_value: 'PROJECT_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/projects/project-1/skill-packs'],
    prompt: prompt({ visible: true, section: 'skill_packs', order: 20, lines: [{ label: 'View project bindings' }], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'agents.list', method: 'GET', path_template: '/api/agents', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [], request_body: NO_BODY, constraints: [], canonical_cases: ['/api/agents'],
    prompt: prompt({ visible: true, section: 'agents', order: 10, lines: [{ label: 'List agents' }] }),
  },
  {
    id: 'skill_packs.list', method: 'GET', path_template: '/api/skill-packs', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [
      { name: 'scope', required: false, type: 'string', example: 'global' },
      { name: 'project_id', required: false, type: 'string', example: 'PROJECT_ID' },
    ], request_body: NO_BODY, constraints: [], canonical_cases: ['/api/skill-packs', '/api/skill-packs?scope=global'],
    prompt: prompt({ visible: true, section: 'skill_packs', order: 10, lines: [
      { label: 'Browse all available skill packs' },
      { label: '  Query global packs only', query: 'scope=global', raw_prefix: '' },
      { label: '  Query project-effective view', query: 'project_id=PROJECT_ID', raw_prefix: '' },
    ], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'operator_profiles.list', method: 'GET', path_template: '/api/operator/profiles', layers: [...LAYERS], availability: 'always',
    path_params: [], query: [], request_body: NO_BODY, constraints: [], canonical_cases: ['/api/operator/profiles'],
    prompt: prompt({ visible: true, section: 'specialist', order: 10, lines: [], adapter_variants: { codex: 'visible' } }),
  },
  {
    id: 'conversations.message', method: 'POST', path_template: '/api/conversations/{conversation_id}/message', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'conversation_id', type: 'string', prompt_value: 'CONVERSATION_ID' }], query: [],
    request_body: body({ required: ['text'], types: { text: 'string' }, examples: {
      top: { rest: { text: '...' }, delegation: { text: 'your instructions here' } },
      operator: { rest: { text: '...' } },
    }, replay: { mode: 'real_service_validation', success_boundary_status: 404 } }),
    constraints: [{ id: 'top_no_worker_alias', critical: true, rule: 'Top may not target worker conversation ids; that alias is worker input.' }],
    canonical_cases: ['/api/conversations/operator:project-1/message'],
    prompt: prompt({ visible: true, section: 'conversations', order: 10, lines: [{
      label: 'Send message to conversation', body_example: 'rest',
      after: '  CONVERSATION_ID format: "top" | "operator:PROJECT_ID" | "worker:RUN_ID"',
    }] }),
  },
  {
    id: 'conversations.events', method: 'GET', path_template: '/api/conversations/{conversation_id}/events', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'conversation_id', type: 'string', prompt_value: 'CONVERSATION_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/conversations/operator:project-1/events'],
    prompt: prompt({ visible: true, section: 'conversations', order: 20, lines: [{ label: 'Get conversation events' }] }),
  },
  {
    id: 'conversations.memory_propose', method: 'POST', path_template: '/api/conversations/{conversation_id}/memory/propose', layers: [...LAYERS], availability: 'always',
    path_params: [{ name: 'conversation_id', type: 'string', prompt_value: 'CONVERSATION_ID' }], query: [],
    request_body: body({
      required: ['kind', 'content'], optional: ['target', 'importance'],
      types: { target: 'string', kind: 'string', content: 'string', importance: 'number' },
      examples: {
        top: { proposal: { kind: 'preference|constraint|commitment|decision|pattern', content: '...', importance: 5 } },
        operator: { proposal: { target: 'workspace|profile', kind: 'convention|pitfall|heuristic|constraint', content: '...', importance: 5 } },
      },
    }),
    constraints: [{ id: 'candidate_only', critical: false, rule: 'This creates a review candidate, never active memory.' }],
    canonical_cases: ['/api/conversations/top/memory/propose', '/api/conversations/operator:project-1/memory/propose'],
    prompt: prompt({ visible: true, section: 'memory', order: 10, lines: [] }),
  },
  {
    id: 'dispatch_audit.create', method: 'POST', path_template: '/api/dispatch-audit', layers: ['operator'], availability: 'always',
    path_params: [], query: [],
    request_body: body({
      required: ['project_id', 'pm_run_id', 'pm_claim'], optional: ['task_id', 'selected_agent_profile_id', 'rationale'],
      types: { project_id: 'string', task_id: 'string', pm_run_id: 'string', selected_agent_profile_id: 'string', rationale: 'string', pm_claim: 'object' },
      examples: { operator: { claim: { project_id: 'PROJECT_ID', task_id: 'TASK_ID', pm_run_id: 'YOUR_OWN_PM_RUN_ID', pm_claim: { kind: 'task_complete', task_id: 'TASK_ID' } } } },
    }),
    constraints: [{ id: 'operator_pm_run_self_attribution', critical: true, rule: 'The pm_run_id must be the calling Operator manager run id.' }],
    canonical_cases: ['/api/dispatch-audit'],
    prompt: prompt({ visible: true, section: 'dispatch_audit', order: 10, lines: [], layer_variants: { operator: 'visible' } }),
  },
  {
    id: 'operator_specialist.invoke', method: 'POST', path_template: '/api/operator/specialist', layers: [...LAYERS], availability: 'specialist_mounted',
    path_params: [], query: [],
    request_body: body({
      required: ['profileId', 'userText', 'originRunId'], optional: [],
      types: { profileId: 'string', userText: 'string', originRunId: 'string' },
      examples: {
        top: { invoke: { profileId: 'PROFILE_ID', userText: 'your focused question', originRunId: 'RUN_ID' } },
        operator: { invoke: { profileId: 'PROFILE_ID', userText: 'your focused question', originRunId: 'RUN_ID' } },
      },
    }),
    constraints: [{ id: 'own_origin_run', critical: true, rule: 'originRunId is the calling manager run id.' }],
    canonical_cases: ['/api/operator/specialist'],
    prompt: prompt({ visible: true, section: 'specialist', order: 20, lines: [], adapter_variants: { codex: 'visible' } }),
  },
  {
    id: 'verify_checks.list', method: 'GET', path_template: '/api/verify-checks', layers: ['operator'], availability: 'goal_mode',
    path_params: [], query: [{ name: 'project_id', required: false, type: 'string', example: 'PROJECT_ID' }], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/verify-checks'], prompt: prompt(),
  },
  {
    id: 'verify_checks.get', method: 'GET', path_template: '/api/verify-checks/{check_id}', layers: ['operator'], availability: 'goal_mode',
    path_params: [{ name: 'check_id', type: 'number', prompt_value: 'CHECK_ID' }], query: [], request_body: NO_BODY,
    constraints: [], canonical_cases: ['/api/verify-checks/1'], prompt: prompt(),
  },
  {
    id: 'verify_checks.create', method: 'POST', path_template: '/api/verify-checks', layers: ['operator'], availability: 'goal_mode',
    path_params: [], query: [],
    request_body: body({
      required: ['name', 'kind'], optional: ['project_id', 'is_default', 'spec', 'spec_json'],
      types: { project_id: 'string', name: 'string', kind: 'string', spec: 'object', spec_json: 'object', is_default: 'boolean' },
      examples: { operator: {
        artifact: { project_id: 'PROJECT_ID', name: 'artifact exists', kind: 'artifact', spec: { files: [{ glob: 'dist/output/**', must_exist: true }] } },
        command_forbidden: { project_id: 'PROJECT_ID', name: 'command forbidden', kind: 'command', spec: { command: 'true' } },
      } }, replay: { mode: 'real_service_database' },
    }),
    request_examples: {
      artifact_success: { body_example: ['operator', 'artifact'], target: 'new', expected_status: 201 },
      command_forbidden: { body_example: ['operator', 'command_forbidden'], target: 'new', expected_status: 403, note: 'Manager bearer auth cannot create shell-command checks.' },
    },
    constraints: [
      { id: 'spec_object', critical: false, rule: 'Provide spec or spec_json as an object; artifact specs use files[].glob and/or report.' },
      { id: 'artifact_only', critical: true, rule: 'Operator managers may create artifact checks only; command checks require human cookie auth.' },
    ],
    canonical_cases: ['/api/verify-checks'], prompt: prompt(),
  },
  {
    id: 'verify_checks.assign', method: 'POST', path_template: '/api/verify-checks/assign', layers: ['operator'], availability: 'goal_mode',
    path_params: [], query: [],
    request_body: body({ required: ['task_id'], optional: ['check_id'], types: { task_id: 'string', check_id: 'number|null' }, examples: { operator: {
      artifact: { task_id: 'TASK_ID', check_id: 1 },
      command_forbidden: { task_id: 'TASK_ID', check_id: 1 },
    } }, replay: { mode: 'real_service_database' } }),
    request_examples: {
      artifact_success: { body_example: ['operator', 'artifact'], target: 'artifact', expected_status: 200 },
      command_forbidden: { body_example: ['operator', 'command_forbidden'], target: 'command', expected_status: 403, note: 'Manager bearer auth cannot assign shell-command checks.' },
    },
    constraints: [{ id: 'artifact_only', critical: true, rule: 'Operator managers may assign artifact checks only; command checks require human cookie auth.' }],
    canonical_cases: ['/api/verify-checks/assign'], prompt: prompt(),
  },
  {
    id: 'verify_checks.update', method: 'PATCH', path_template: '/api/verify-checks/{check_id}', layers: ['operator'], availability: 'goal_mode',
    path_params: [{ name: 'check_id', type: 'number', prompt_value: 'CHECK_ID' }], query: [],
    request_body: body({
      required: [], optional: ['name', 'spec', 'spec_json', 'is_default'],
      types: { name: 'string', spec: 'object', spec_json: 'object', is_default: 'boolean' },
      examples: { operator: {
        artifact: { name: 'updated artifact check', spec: { files: [{ glob: 'dist/revised/**', must_exist: true }] } },
        command_forbidden: { name: 'command edit forbidden', spec: { command: 'false' } },
      } }, replay: { mode: 'real_service_database' },
    }),
    request_examples: {
      artifact_success: { body_example: ['operator', 'artifact'], target: 'artifact', expected_status: 200 },
      command_forbidden: { body_example: ['operator', 'command_forbidden'], target: 'command', expected_status: 403, note: 'Manager bearer auth cannot edit shell-command checks.' },
    },
    constraints: [{ id: 'artifact_only', critical: true, rule: 'Operator managers may edit artifact checks only; command checks require human cookie auth.' }],
    canonical_cases: ['/api/verify-checks/1'], prompt: prompt(),
  },
  {
    id: 'verify_checks.delete', method: 'DELETE', path_template: '/api/verify-checks/{check_id}', layers: ['operator'], availability: 'goal_mode',
    path_params: [{ name: 'check_id', type: 'number', prompt_value: 'CHECK_ID' }], query: [], request_body: NO_BODY,
    request_examples: {
      artifact_success: { target: 'artifact', expected_status: 200 },
      command_forbidden: { target: 'command', expected_status: 403, note: 'Manager bearer auth cannot delete shell-command checks.' },
    },
    constraints: [{ id: 'artifact_only', critical: true, rule: 'Operator managers may delete artifact checks only; command checks require human cookie auth.' }],
    canonical_cases: ['/api/verify-checks/1'], prompt: prompt(),
  },
];

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const managerOperationManifest = deepFreeze({
  version: 1,
  contract_scope: 'manager_agent_calls_not_route_validator_source',
  follow_ups: [
    {
      id: 'prompt_prose_enums',
      note: 'pm_claim.kind plus task and run status enums remain prompt-prose contracts.',
    },
    {
      id: 'auto_review_notification_api_literals',
      note: 'Agent-facing API literals in server/app.js auto-review notifications remain outside this manifest round.',
    },
    {
      id: 'execute_permission_strategy_prose',
      note: 'The permission meaning of /execute intentionally remains in multiple prompt strategy passages.',
    },
  ],
  operations,
});

function getManagerOperation(id) {
  const operation = managerOperationManifest.operations.find(candidate => candidate.id === id);
  if (!operation) throw new Error(`Unknown manager operation: ${id}`);
  return operation;
}

function renderOperationPath(id, { base = '', path_params = {}, query = '' } = {}) {
  const operation = getManagerOperation(id);
  const values = Object.fromEntries(operation.path_params.map(param => [
    param.name,
    Object.prototype.hasOwnProperty.call(path_params, param.name) ? path_params[param.name] : param.prompt_value,
  ]));
  const rendered = operation.path_template.replace(/\{([^}]+)\}/g, (_match, name) => String(values[name]));
  return `${base}${rendered}${query ? `?${query}` : ''}`;
}

function getAgentCallBodyExample(id, layer, exampleName) {
  const operation = getManagerOperation(id);
  const example = operation.request_body.examples?.[layer]?.[exampleName];
  if (!example) throw new Error(`Missing ${layer}.${exampleName} body example for ${id}`);
  return example;
}

module.exports = {
  managerOperationManifest,
  getManagerOperation,
  renderOperationPath,
  getAgentCallBodyExample,
};
