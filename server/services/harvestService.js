const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const { createLocalNodeExecutor } = require('./nodeExecutor');

const MAX_STAT_CHARS = 8 * 1024;
const MAX_OUTPUT_TAIL_CHARS = 8 * 1024;
const MAX_SUMMARY_STAT_CHARS = 500;
const MAX_SUMMARY_OUTPUT_TAIL_CHARS = 500;
const MAX_FILES = 500;
const MAX_COMMITS = 50;
const DEFAULT_TEST_TIMEOUT_MS = 300_000;
const SERVER_NODE_MAJOR = Number.parseInt(process.versions.node, 10);
const MAX_DECL_BYTES = 1024 * 1024;

function repoFeatureEnabled() {
  return process.env.PALANTIR_PROJECT_REPO !== '0';
}

function tailString(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function capString(value, maxChars) {
  const text = String(value || '');
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}

function stripControlChars(value) {
  return String(value || '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function testTimeoutMs() {
  const raw = Number(process.env.PALANTIR_HARVEST_TEST_TIMEOUT_MS || DEFAULT_TEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TEST_TIMEOUT_MS;
}

function parsePositiveMajor(value) {
  const major = Number.parseInt(value, 10);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

function readSmallDeclarationFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DECL_BYTES) {
      return { exists: true, text: null };
    }
    return { exists: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { exists: false, text: null };
    }
    return { exists: true, text: null };
  }
}

function parseNvmrcMajor(value) {
  const match = String(value || '').trim().match(/^v?(\d+)(?:\.\d+){0,2}$/);
  return match ? parsePositiveMajor(match[1]) : null;
}

function parseEnginesNodeMajor(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /\s/.test(text) || /[<>]/.test(text) || text.includes('||') || text.includes(' - ')) {
    return null;
  }
  const match = text.match(/^(?:[\^~])?v?(\d+)(?:\.(?:\d+|x)){0,2}$/);
  return match ? parsePositiveMajor(match[1]) : null;
}

function resolveDeclaredNodeMajor(worktreePath) {
  try {
    if (!worktreePath) return null;

    const nvmrc = readSmallDeclarationFile(path.join(worktreePath, '.nvmrc'));
    if (nvmrc.exists) {
      return nvmrc.text == null ? null : parseNvmrcMajor(nvmrc.text);
    }

    const pkg = readSmallDeclarationFile(path.join(worktreePath, 'package.json'));
    if (!pkg.exists || pkg.text == null) return null;
    try {
      const parsed = JSON.parse(pkg.text);
      return parseEnginesNodeMajor(parsed?.engines?.node);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

// NOTE (fleet P0a): node-version detection (readSmallDeclarationFile /
// defaultNodeResolver) and the test-command spawn below intentionally stay
// control-plane-local. They move to the execution node together with the
// whole harvest step in fleet P2/P3 (docs/specs/fleet-remote-nodes-brief.md
// §4.3) — routing only these reads through NodeExecutor now would resolve
// node binaries against the wrong host. In P0a only worktree existence and
// git calls go through the injected nodeExecutor.
function defaultNodeResolver(major) {
  try {
    const parsedMajor = parsePositiveMajor(major);
    if (parsedMajor == null) return null;
    const prefix = process.env.PALANTIR_NODE_PREFIX || '/opt/homebrew/opt';
    const binDir = path.join(prefix, `node@${parsedMajor}`, 'bin');
    fs.accessSync(path.join(binDir, 'node'), fs.constants.X_OK);
    return binDir;
  } catch {
    return null;
  }
}

function resolveProjectNode(worktreePath, nodeResolver = defaultNodeResolver) {
  try {
    const declared = resolveDeclaredNodeMajor(worktreePath);
    if (declared == null) {
      return { binDir: null, major: SERVER_NODE_MAJOR, source: 'server' };
    }
    if (declared === SERVER_NODE_MAJOR) {
      return { binDir: null, major: declared, source: 'server' };
    }
    const binDir = nodeResolver(declared);
    if (typeof binDir === 'string' && binDir) {
      return { binDir, major: declared, source: 'project' };
    }
    return { binDir: null, major: declared, source: 'fallback' };
  } catch {
    return { binDir: null, major: SERVER_NODE_MAJOR, source: 'server' };
  }
}

function buildHarvestEnvFromNode(projectNode) {
  // Prefer the server node unless a project declares a clear, different major
  // and the configured resolver can locate that node. Keeping the server node
  // for missing/range/same-major declarations preserves PR #188's ABI fix.
  const extraPaths = [
    projectNode?.binDir || path.dirname(process.execPath),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ];
  const currentPath = process.env.PATH || '';
  const env = {
    PATH: [...extraPaths, currentPath].filter(Boolean).join(path.delimiter),
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  return env;
}

function buildHarvestEnv(worktreePath, nodeResolver = defaultNodeResolver) {
  const projectNode = worktreePath
    ? resolveProjectNode(worktreePath, nodeResolver)
    : { binDir: null, major: SERVER_NODE_MAJOR, source: 'server' };
  return buildHarvestEnvFromNode(projectNode);
}

function normalizeRepoSubdir(subdir) {
  if (!subdir) return null;
  const normalized = String(subdir).trim();
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) throw new Error('repo_subdir must be relative');
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new Error('repo_subdir escapes repository root');
  }
  return parts.join(path.sep);
}

function materializedCwd(run) {
  const subdir = normalizeRepoSubdir(run?.repo_subdir_snapshot || null);
  return subdir ? path.join(run.workspace_path, subdir) : run.workspace_path;
}

function runTestCommand({ command, cwd, testRunner, nodeResolver = defaultNodeResolver }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = testTimeoutMs();
    const args = [...(testRunner.args || []), command];
    const projectNode = resolveProjectNode(cwd, nodeResolver);
    assertSpawnAllowed({ command: testRunner.bin, source: 'harvestService:test' });

    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(testRunner.bin, args, {
      cwd,
      env: buildHarvestEnvFromNode(projectNode),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const appendOutput = (chunk) => {
      output = tailString(output + chunk.toString('utf8'), MAX_OUTPUT_TAIL_CHARS * 2);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const outputTail = tailString(stripControlChars(output), MAX_OUTPUT_TAIL_CHARS);
      resolve({
        command,
        exit_code: timedOut ? null : code,
        passed: !timedOut && code === 0,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        output_tail: outputTail,
        node_major: projectNode.major,
        node_source: projectNode.source,
      });
    });
  });
}

async function runExecutorTestCommand({
  command,
  cwd,
  testRunner,
  executor,
  nodeResolver = defaultNodeResolver,
  useLocalNodeResolution = false,
}) {
  const started = Date.now();
  const timeoutMs = testTimeoutMs();
  const args = [...(testRunner.args || []), command];
  const projectNode = useLocalNodeResolution
    ? resolveProjectNode(cwd, nodeResolver)
    : { binDir: null, major: null, source: 'executor' };
  let res;
  let timedOut = false;
  try {
    res = await executor.exec(testRunner.bin, args, {
      cwd,
      env: useLocalNodeResolution ? buildHarvestEnvFromNode(projectNode) : undefined,
      timeoutMs,
      maxBuffer: MAX_OUTPUT_TAIL_CHARS * 2,
    });
  } catch (err) {
    if (!err?.killed && err?.code !== 'ETIMEDOUT' && !err?.signal) throw err;
    timedOut = true;
    res = {
      code: null,
      stdout: err.stdout || '',
      stderr: err.stderr || '',
    };
  }
  const outputTail = tailString(
    stripControlChars(`${res.stdout || ''}${res.stderr || ''}`),
    MAX_OUTPUT_TAIL_CHARS
  );
  return {
    command,
    exit_code: timedOut ? null : res.code,
    passed: !timedOut && res.code === 0,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
    output_tail: outputTail,
    node_major: projectNode.major,
    node_source: projectNode.source,
  };
}

function createHarvestService({
  runService,
  worktreeService,
  projectService,
  eventBus,
  testRunner = { bin: '/bin/sh', args: ['-c'] },
  nodeResolver = defaultNodeResolver,
  nodeExecutor = createLocalNodeExecutor(),
  nodeService = null,
} = {}) {
  const seenRunIds = new Set();

  function isReviewTargetRun(run) {
    return Boolean(
      run?.id
      && !run.is_manager
      && ['completed', 'failed'].includes(run.status)
    );
  }

  function createSummary() {
    return {
      files: 0,
      commits: 0,
      statText: '',
      test: null,
      errors: [],
      harvested: false,
    };
  }

  function pushSummaryError(summary, stage) {
    if (!summary.errors.includes(stage)) summary.errors.push(stage);
  }

  function latestRun(run) {
    try {
      return runService.getRun(run.id);
    } catch {
      return run;
    }
  }

  function emitHarvested(run, summary) {
    if (!eventBus) return;
    try {
      eventBus.emit('run:harvested', {
        run: latestRun(run),
        summary: {
          files: Number(summary.files) || 0,
          commits: Number(summary.commits) || 0,
          statText: capString(summary.statText || '', MAX_SUMMARY_STAT_CHARS).value,
          test: summary.test ? {
            passed: Boolean(summary.test.passed),
            timed_out: Boolean(summary.test.timed_out),
            exit_code: summary.test.exit_code ?? null,
            duration_ms: summary.test.duration_ms ?? null,
            output_tail: tailString(
              stripControlChars(summary.test.output_tail || ''),
              MAX_SUMMARY_OUTPUT_TAIL_CHARS
            ),
          } : null,
          errors: Array.isArray(summary.errors) ? [...summary.errors] : [],
          harvested: Boolean(summary.harvested),
        },
      });
    } catch {
      // harvestRun is annotate-only; subscribers must not make it throw.
    }
  }

  function hasExistingHarvestEvent(runId) {
    try {
      return (runService.getRunEvents(runId) || []).some((evt) => (
        evt.event_type === 'harvest:diff' || evt.event_type === 'harvest:error'
      ));
    } catch {
      return false;
    }
  }

  function addEvent(runId, eventType, payload) {
    try {
      runService.addRunEvent(runId, eventType, JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  function addError(runId, stage, err) {
    return addEvent(runId, 'harvest:error', {
      stage,
      error: err?.message || String(err || 'unknown error'),
    });
  }

  function executorFor(run) {
    if (nodeService && typeof nodeService.pickExecutor === 'function') {
      return nodeService.pickExecutor(run?.node_id || 'local');
    }
    return nodeExecutor;
  }

  function isLocalNodeRun(run) {
    const nodeId = run?.node_id || 'local';
    if (nodeId === 'local') return true;
    if (nodeService && typeof nodeService.getNode === 'function') {
      try {
        const node = nodeService.getNode(nodeId);
        // Only a resolvable node explicitly marked local is local. An unknown /
        // stale node id must NOT fall through to control-plane node resolution
        // for a remote run (Codex PR5c review SERIOUS).
        return Boolean(node && node.kind === 'local');
      } catch {
        return false;
      }
    }
    return false;
  }

  function isMaterializedHarvestTarget(run) {
    return Boolean(repoFeatureEnabled() && run?.workspace_path && run.resolved_commit);
  }

  function resolveProject(run, projectDir) {
    if (run?.project_id && projectService) {
      try {
        const project = projectService.getProject(run.project_id);
        return { project, projectDir: projectDir || project.directory || null };
      } catch {
        return { project: null, projectDir: projectDir || null };
      }
    }
    return { project: null, projectDir: projectDir || null };
  }

  function gitError(args, res) {
    const err = new Error(res.stderr || res.stdout || `git ${args.join(' ')} failed with code ${res.code}`);
    err.code = res.code;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    return err;
  }

  async function execMaterializedGit(executor, args, opts = {}) {
    const res = await executor.exec('git', args, {
      ...opts,
      env: {
        GIT_EXTERNAL_DIFF: '',
        GIT_TEXTCONV_DIFF: '',
        LC_ALL: 'C',
        LANG: 'C',
        ...(opts.env || {}),
      },
      maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
    });
    if (res.code !== 0) throw gitError(args, res);
    return res;
  }

  // NUL-delimited parsing (git `-z`) so filenames with spaces / quotes /
  // embedded newlines are handled verbatim instead of being split or trimmed
  // apart (Codex PR5c review NIT). These parsers are materialized-path only;
  // the legacy worktree path uses worktreeService.getWorktreeDiff.
  function diffFilesFromOutput(stdout) {
    return String(stdout || '').split('\0').filter(Boolean);
  }

  function untrackedFilesFromStatus(stdout) {
    // `status --porcelain -z`: each record is `XY <path>` terminated by NUL.
    // Untracked records are `?? <path>` and never carry a rename second field.
    return String(stdout || '').split('\0')
      .filter(entry => entry.startsWith('?? '))
      .map(entry => entry.slice(3))
      .filter(Boolean);
  }

  function uniqueFiles(files) {
    const seen = new Set();
    const out = [];
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
    return out;
  }

  async function listCommits(projectDir, base, branch) {
    const gitEnv = { GIT_EXTERNAL_DIFF: '', GIT_TEXTCONV_DIFF: '' };
    const res = await nodeExecutor.exec(
      'git',
      ['log', '--no-color', '--oneline', `--max-count=${MAX_COMMITS + 1}`, `${base}..${branch}`],
      { cwd: projectDir, env: gitEnv },
    );
    if (res.code !== 0) {
      const err = new Error(res.stderr || res.stdout || `git log failed with code ${res.code}`);
      err.code = res.code;
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      throw err;
    }
    const lines = res.stdout.trim().split('\n').filter(Boolean);
    return {
      commits: lines.slice(0, MAX_COMMITS),
      truncated: lines.length > MAX_COMMITS,
    };
  }

  async function harvestMaterializedRun(run, summary) {
    // executorFor(pickExecutor) + remote fileExists can throw/reject — keep the
    // preflight inside try/catch so a transport failure becomes a stage
    // harvest:error and never escapes harvestRun (annotate-only/never-throws
    // contract; Codex PR5c review SERIOUS).
    let executor;
    try {
      executor = executorFor(run);
      if (!await executor.fileExists(run.workspace_path)) {
        pushSummaryError(summary, 'worktree_missing');
        return;
      }
    } catch (err) {
      addError(run.id, 'preflight', err);
      pushSummaryError(summary, 'preflight');
      return;
    }

    let cwd;
    try {
      cwd = materializedCwd(run);
    } catch (err) {
      addError(run.id, 'preflight', err);
      pushSummaryError(summary, 'preflight');
      return;
    }

    const resolved = resolveProject(run, null);
    summary.harvested = true;

    try {
      // Diff the working tree against resolved_commit (the commit the worker
      // checked out). Without the base rev this only shows unstaged vs index
      // and misses staged / committed-on-top changes, yet the payload records
      // base=resolved_commit — Operator review would get an empty/partial diff
      // (Codex PR5c review BLOCKER). status --porcelain still covers untracked.
      const base = run.resolved_commit;
      const statResult = await execMaterializedGit(
        executor,
        ['-C', run.workspace_path, 'diff', '--stat', base, '--', '.'],
        { cwd: run.workspace_path },
      );
      const nameResult = await execMaterializedGit(
        executor,
        ['-C', run.workspace_path, 'diff', '--name-only', '-z', base, '--', '.'],
        { cwd: run.workspace_path },
      );
      const statusResult = await execMaterializedGit(
        executor,
        ['-C', run.workspace_path, 'status', '--porcelain', '-z', '--', '.'],
        { cwd: run.workspace_path },
      );
      let truncated = false;
      const cappedStat = capString(statResult.stdout || '', MAX_STAT_CHARS);
      truncated = truncated || cappedStat.truncated;
      const files = uniqueFiles([
        ...diffFilesFromOutput(nameResult.stdout),
        ...untrackedFilesFromStatus(statusResult.stdout),
      ]);
      if (files.length > MAX_FILES) truncated = true;
      summary.files = files.length;
      summary.commits = 0;
      summary.statText = capString(statResult.stdout || '', MAX_SUMMARY_STAT_CHARS).value;
      addEvent(run.id, 'harvest:diff', {
        base: run.resolved_commit,
        branch: null,
        stat: cappedStat.value,
        files: files.slice(0, MAX_FILES),
        commits: [],
        truncated,
      });
    } catch (err) {
      addError(run.id, 'diff', err);
      pushSummaryError(summary, 'diff');
    }

    try {
      const command = resolved.project?.test_command || null;
      if (command && run.status === 'completed') {
        const useLocalNodeResolution = isLocalNodeRun(run);
        const result = await runExecutorTestCommand({
          command,
          cwd,
          testRunner,
          executor,
          nodeResolver,
          useLocalNodeResolution,
        });
        addEvent(run.id, 'harvest:test', result);
        if (useLocalNodeResolution && result.node_source === 'fallback') {
          addError(
            run.id,
            'node_unresolved',
            new Error(`Declared node@${result.node_major} was not found; used server node`)
          );
          pushSummaryError(summary, 'node_unresolved');
        }
        summary.test = {
          passed: result.passed,
          timed_out: result.timed_out,
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          output_tail: tailString(result.output_tail || '', MAX_SUMMARY_OUTPUT_TAIL_CHARS),
        };
      }
    } catch (err) {
      addError(run.id, 'test', err);
      pushSummaryError(summary, 'test');
    }

    try {
      if (!run.repo_cache_path) throw new Error('repo_cache_path unavailable');
      await execMaterializedGit(
        executor,
        ['-C', run.repo_cache_path, 'worktree', 'remove', '--force', '--', run.workspace_path],
        { cwd: run.repo_cache_path },
      );
    } catch (err) {
      addError(run.id, 'worktree_remove', err);
      pushSummaryError(summary, 'worktree_remove');
    }
    // prune ALWAYS runs (separate try) — a failed/already-removed worktree
    // leaves stale registration behind; pruning it keeps a later re-materialize
    // at the same path idempotent (Codex PR5c review SERIOUS).
    try {
      await execMaterializedGit(
        executor,
        ['-C', run.repo_cache_path, 'worktree', 'prune'],
        { cwd: run.repo_cache_path },
      );
    } catch (err) {
      addError(run.id, 'worktree_prune', err);
      pushSummaryError(summary, 'worktree_prune');
    }
  }

  async function harvestRun(run, { projectDir } = {}) {
    if (!isReviewTargetRun(run)) return;
    if (seenRunIds.has(run.id)) return;
    if (hasExistingHarvestEvent(run.id)) return;
    seenRunIds.add(run.id);

    const summary = createSummary();
    try {
      const materialized = isMaterializedHarvestTarget(run);
      if (!materialized && (!run.worktree_path || !run.branch)) {
        pushSummaryError(summary, 'no_worktree');
        emitHarvested(run, summary);
        return;
      }
      if (materialized) {
        await harvestMaterializedRun(run, summary);
        emitHarvested(run, summary);
        return;
      }
      // Worktree already gone (e.g. executeTask's spawn-failure catch runs its
      // synchronous cleanup before this setImmediate fires). Review still needs
      // one terminal notification, but harvest itself cannot proceed.
      if (!await nodeExecutor.fileExists(run.worktree_path)) {
        pushSummaryError(summary, 'worktree_missing');
        emitHarvested(run, summary);
        return;
      }
      const resolved = resolveProject(run, projectDir);
      const resolvedProjectDir = resolved.projectDir;
      if (!resolvedProjectDir) {
        addError(run.id, 'preflight', new Error('Project directory unavailable'));
        pushSummaryError(summary, 'no_project_dir');
        emitHarvested(run, summary);
        return;
      }

      summary.harvested = true;
      try {
        await worktreeService.autoSaveWorktree(run.worktree_path, run.id);
      } catch (err) {
        addError(run.id, 'autosave', err);
        pushSummaryError(summary, 'autosave');
      }

      try {
        const diff = await worktreeService.getWorktreeDiff(resolvedProjectDir, run.branch);
        const base = diff.base || 'HEAD';
        let truncated = false;
        const cappedStat = capString(diff.stat || '', MAX_STAT_CHARS);
        truncated = truncated || cappedStat.truncated;
        const files = Array.isArray(diff.files) ? diff.files : [];
        if (files.length > MAX_FILES) truncated = true;
        summary.files = files.length;
        summary.statText = capString(diff.stat || '', MAX_SUMMARY_STAT_CHARS).value;
        let commits = [];
        try {
          const commitResult = await listCommits(resolvedProjectDir, base, run.branch);
          commits = commitResult.commits;
          truncated = truncated || commitResult.truncated;
          summary.commits = commits.length;
        } catch (err) {
          addError(run.id, 'commits', err);
          pushSummaryError(summary, 'commits');
        }
        addEvent(run.id, 'harvest:diff', {
          base,
          branch: run.branch,
          stat: cappedStat.value,
          files: files.slice(0, MAX_FILES),
          commits,
          truncated,
        });
      } catch (err) {
        addError(run.id, 'diff', err);
        pushSummaryError(summary, 'diff');
      }

      try {
        const command = resolved.project?.test_command || null;
        if (command && run.status === 'completed') {
          const result = await runTestCommand({
            command,
            cwd: run.worktree_path,
            testRunner,
            nodeResolver,
          });
          addEvent(run.id, 'harvest:test', result);
          if (result.node_source === 'fallback') {
            addError(
              run.id,
              'node_unresolved',
              new Error(`Declared node@${result.node_major} was not found; used server node`)
            );
            pushSummaryError(summary, 'node_unresolved');
          }
          summary.test = {
            passed: result.passed,
            timed_out: result.timed_out,
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            output_tail: tailString(result.output_tail || '', MAX_SUMMARY_OUTPUT_TAIL_CHARS),
          };
        }
      } catch (err) {
        addError(run.id, 'test', err);
        pushSummaryError(summary, 'test');
      }

      try {
        await worktreeService.removeWorktree(resolvedProjectDir, run.worktree_path, run.branch, {
          runId: run.id,
          autosave: false,
        });
      } catch (err) {
        addError(run.id, 'cleanup', err);
        pushSummaryError(summary, 'cleanup');
      }
      emitHarvested(run, summary);
    } catch (err) {
      try { addError(run?.id, 'fatal', err); } catch { /* never throw */ }
      pushSummaryError(summary, 'fatal');
      emitHarvested(run, summary);
    }
  }

  return { harvestRun };
}

module.exports = {
  createHarvestService,
  stripControlChars,
  buildHarvestEnv,
  defaultNodeResolver,
  resolveDeclaredNodeMajor,
  resolveProjectNode,
  runTestCommand,
  SERVER_NODE_MAJOR,
  MAX_DECL_BYTES,
};
