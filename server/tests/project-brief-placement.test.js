const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createDatabase } = require('../db/database');
const { createProjectBriefService } = require('../services/projectBriefService');
const { createProjectService } = require('../services/projectService');

async function mkdb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-brief-placement-'));
  const dbPath = path.join(dir, 'test.db');
  const { db, migrate, close } = createDatabase(dbPath);
  migrate();
  t.after(async () => {
    close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return db;
}

function createServices(db) {
  return {
    projectService: createProjectService(db),
    projectBriefService: createProjectBriefService(db),
  };
}

test('setPmThread persists PM thread placement fields when provided', async (t) => {
  const db = await mkdb(t);
  const { projectService, projectBriefService } = createServices(db);
  const project = projectService.createProject({ name: 'alpha' });

  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_1',
    pm_adapter: 'codex',
    pm_thread_node_id: 'local',
    pm_thread_cwd: '/some/path',
  });

  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, 'thread_1');
  assert.equal(brief.pm_adapter, 'codex');
  assert.equal(brief.pm_thread_node_id, 'local');
  assert.equal(brief.pm_thread_cwd, '/some/path');
});

test('setPmThread without placement leaves fresh placement fields null', async (t) => {
  const db = await mkdb(t);
  const { projectService, projectBriefService } = createServices(db);
  const project = projectService.createProject({ name: 'alpha' });

  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_1',
    pm_adapter: 'codex',
  });

  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, 'thread_1');
  assert.equal(brief.pm_adapter, 'codex');
  assert.equal(brief.pm_thread_node_id, null);
  assert.equal(brief.pm_thread_cwd, null);
});

test('setPmThread without placement preserves existing placement fields', async (t) => {
  const db = await mkdb(t);
  const { projectService, projectBriefService } = createServices(db);
  const project = projectService.createProject({ name: 'alpha' });

  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_1',
    pm_adapter: 'codex',
    pm_thread_node_id: 'local',
    pm_thread_cwd: '/some/path',
  });
  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_2',
    pm_adapter: 'codex',
  });

  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, 'thread_2');
  assert.equal(brief.pm_adapter, 'codex');
  assert.equal(brief.pm_thread_node_id, 'local');
  assert.equal(brief.pm_thread_cwd, '/some/path');
});

test('clearPmThread clears PM thread and placement fields', async (t) => {
  const db = await mkdb(t);
  const { projectService, projectBriefService } = createServices(db);
  const project = projectService.createProject({ name: 'alpha' });

  projectBriefService.setPmThread(project.id, {
    pm_thread_id: 'thread_1',
    pm_adapter: 'codex',
    pm_thread_node_id: 'local',
    pm_thread_cwd: '/some/path',
  });
  projectBriefService.clearPmThread(project.id);

  const brief = projectBriefService.getBrief(project.id);
  assert.equal(brief.pm_thread_id, null);
  assert.equal(brief.pm_adapter, null);
  assert.equal(brief.pm_thread_node_id, null);
  assert.equal(brief.pm_thread_cwd, null);
});
