'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../app');
const { createSubprocessEngine } = require('../services/executionEngine');

const fakeCodexPath = path.join(__dirname, 'fixtures', 'bin', 'fake-codex-stdin.js');

test('shared injected execution engine keeps each app capability policy at spawn', async (t) => {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-app-engine-policy-a-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'palantir-app-engine-policy-b-'));
  const policyKeys = [
    'PALANTIR_TOKEN',
    'PALANTIR_PM_TOKEN',
    'PALANTIR_AGENT_PROCESS_ISOLATION',
    'PALANTIR_ACTOR_TOKEN_SOURCE',
  ];
  const previousPolicyEnv = Object.fromEntries(
    policyKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of policyKeys) delete process.env[key];
  const executionEngine = createSubprocessEngine();
  for (const key of policyKeys) {
    if (previousPolicyEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousPolicyEnv[key];
  }

  const app = createApp({
    storageRoot: tmpA,
    fsRoot: tmpA,
    dbPath: path.join(tmpA, 'test.db'),
    executionEngine,
    authToken: 'human-token',
    pmToken: 'automation-token',
    agentProcessIsolation: true,
    workerProposalBaseUrl: 'https://console.example',
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
    authResolverOpts: { hasKeychain: () => false },
  });
  const appWithoutIsolation = createApp({
    storageRoot: tmpB,
    fsRoot: tmpB,
    dbPath: path.join(tmpB, 'test.db'),
    executionEngine,
    authToken: 'other-human-token',
    pmToken: 'other-automation-token',
    agentProcessIsolation: false,
    workerProposalBaseUrl: 'https://other-console.example',
    memoryDistillEnabled: false,
    operatorSchedulerEnabled: false,
    authResolverOpts: { hasKeychain: () => false },
  });
  t.after(async () => {
    try { await app.shutdown(); } catch { /* ignore */ }
    try { await appWithoutIsolation.shutdown(); } catch { /* ignore */ }
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  });

  const project = app.services.projectService.createProject({
    name: 'Injected engine policy project',
    directory: null,
  });
  const task = app.services.taskService.createTask({
    project_id: project.id,
    title: 'Spawn through the injected engine',
  });
  const profileId = 'profile_injected_engine_policy';
  app.services._rawDb.prepare(`
    INSERT INTO agent_profiles (
      id, name, type, command, args_template, capabilities_json,
      env_allowlist, max_concurrent
    ) VALUES (?, ?, 'codex', ?, 'exec {prompt}', '{}', '[]', 1)
  `).run(profileId, 'Injected engine policy worker', fakeCodexPath);

  const run = await app.services.lifecycleService.executeTask(task.id, {
    agentProfileId: profileId,
    prompt: 'verify app-owned policy',
  });

  assert.equal(run.status, 'running');
  const deadline = Date.now() + 2000;
  while (executionEngine.detectExitCode(run.id) === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(executionEngine.detectExitCode(run.id), 0);
});
