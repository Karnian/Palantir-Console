'use strict';

// Regressions for the Codex Phase-2 final-review fixes:
//   finding 1 — a QUOTED conflicting flag (`"--model"`, `"-c"`) is unquoted like
//               buildAgentArgs at execution, so the double-set scanner must unquote too.
//   finding 6 — an uppercase `Claude` command must still route to the stream-json
//               path (case-insensitive vendor) so structured spec.model is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createDatabase } = require('../db/database');
const { createAgentProfileService, validateStructuredModelEffort } = require('../services/agentProfileService');
const { createLifecycleService } = require('../services/lifecycleService');
const { createProjectService } = require('../services/projectService');
const { createRunService } = require('../services/runService');
const { createTaskService } = require('../services/taskService');

test('finding1: a QUOTED conflicting flag is unquoted and rejected by the double-set scanner', () => {
  // `exec "--model" baked {prompt}` runs as `--model baked` → double-sets model.
  assert.throws(() => validateStructuredModelEffort({
    command: 'codex', args_template: 'exec "--model" baked {prompt}', model: 'gpt-x', reasoning_effort: null,
  }), /conflicts/);
  // quoted `-c` + config fragment.
  assert.throws(() => validateStructuredModelEffort({
    command: 'codex', args_template: 'exec "-c" "model=y" {prompt}', model: 'gpt-x', reasoning_effort: null,
  }), /conflicts/);
  // a clean template is still accepted.
  assert.doesNotThrow(() => validateStructuredModelEffort({
    command: 'codex', args_template: 'exec {prompt}', model: 'gpt-x', reasoning_effort: null,
  }));
});

function createExecutionEngine() {
  const spawned = [];
  return { spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: `worker-${runId}` }; },
    isAlive() { return true; }, detectExitCode() { return null; }, getOutput() { return ''; },
    sendInput() { return true; }, kill() {}, discoverGhostSessions() { return []; }, hasProcess() { return false; } };
}
function createStreamJsonEngine() {
  const spawned = [];
  return { spawned,
    spawnAgent(runId, opts) { spawned.push({ runId, opts }); return { sessionName: null }; },
    hasProcess(runId) { return spawned.some(s => s.runId === runId); },
    isAlive() { return true; }, detectExitCode() { return null; }, sendInput() { return true; }, kill() { return true; } };
}

test('finding6: uppercase `Claude` command routes to stream-json with structured spec.model', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'palantir-review-fix-'));
  const { db, migrate, close } = createDatabase(path.join(dir, 'test.db'));
  migrate();
  t.after(async () => { close(); await fsp.rm(dir, { recursive: true, force: true }); });

  const runService = createRunService(db, null);
  const taskService = createTaskService(db);
  const projectService = createProjectService(db);
  const executionEngine = createExecutionEngine();
  const streamJsonEngine = createStreamJsonEngine();
  const lifecycleService = createLifecycleService({
    runService, taskService, agentProfileService: createAgentProfileService(db),
    projectService, executionEngine, streamJsonEngine, worktreeService: null, eventBus: null,
  });
  const project = projectService.createProject({ name: 'P', directory: null });
  const task = taskService.createTask({ project_id: project.id, title: 'T', description: 'x' });

  // raw-SQL insert with an uppercase `Claude` command + structured model (an
  // allowlisted custom command; bypasses validateCommand for the test).
  const profileId = `claude-${Date.now()}`;
  db.prepare(`INSERT INTO agent_profiles (id, name, type, command, args_template, capabilities_json, env_allowlist, max_concurrent, model)
              VALUES (?, ?, 'claude-code', 'Claude', '-p {prompt} --permission-mode bypassPermissions', '{}', '[]', 5, 'claude-x')`).run(profileId, profileId);

  await lifecycleService.executeTask(task.id, { agentProfileId: profileId, prompt: 'hi' });

  assert.equal(streamJsonEngine.spawned.length, 1, 'routed to stream-json (not the tmux else-branch)');
  assert.equal(executionEngine.spawned.length, 0);
  assert.equal(streamJsonEngine.spawned[0].opts.model, 'claude-x', 'structured model injected via spec.model');
});
