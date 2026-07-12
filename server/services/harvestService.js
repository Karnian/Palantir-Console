const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertSpawnAllowed } = require('../utils/spawnGuard');
const { isWithinRoot } = require('../utils/pathGuard');
const { createLocalNodeExecutor } = require('./nodeExecutor');
const { runAcceptance } = require('./goalAcceptance'); // G2 §5f

const GOAL_MAX_FILE_BYTES = 5 * 1024 * 1024; // G2 §5k-2: per-file read/copy hard cap
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
  // G2 §5f: Gate 1 acceptance. Optional — when absent, harvest behaves exactly
  // as pre-G2 (no acceptance stage), so non-goal deployments are unaffected.
  // The goal gate here is per-run (run.goal_active, stamped at spawn) — harvest
  // does NOT re-evaluate goalFeatureActive() (unified activation).
  taskService = null,
  verifyCheckService = null,
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

  // G2 §5f: resolve the run's assigned Gate 1 verify_check (or null). Guards on
  // the optional deps + goal-enabled task + a non-null assignment.
  function resolveGoalCheck(run) {
    if (!run.goal_active) return null; // single per-run gate (unified activation)
    if (!taskService || !verifyCheckService || !run.task_id) return null;
    let task;
    try { task = taskService.getTask(run.task_id); } catch { return null; }
    if (!task || !task.verify_check_id) return null;
    try { return verifyCheckService.getCheck(task.verify_check_id); } catch { return null; }
  }

  // G2 §5f: run the Gate 1 acceptance for a completed goal run against its
  // workspace, persist runs.acceptance_json, and emit harvest:acceptance. The
  // VERDICT (retry/gate2/…) is G3 — this is observational aggregation only.
  // Never throws (caller wraps too); a command check reuses the harvest test
  // runner (same runner contract §5f).
  async function runGate1Acceptance(run, workspaceDir, summary, reportText) {
    if (run.status !== 'completed') return;
    const check = resolveGoalCheck(run);
    if (!check) return;
    // G2b §5k-1: a remote workspace's machine check can't run with the local
    // runner — record it skipped (runner_unavailable, provider:remote) so the
    // verdict fail-opens to gate2 (semantic review), NOT a silent pass. The
    // remote CHECK RUNNER is G3b. §5f: a skipped check → gate2, surfaced.
    if (!isLocalNodeRun(run)) {
      const acceptance = { check_id: check.id, name: check.name, kind: check.kind, gate: check.created_by === 'human', status: 'skipped', reason: 'runner_unavailable', passed: null, provider: 'remote' };
      try { runService.updateGoalAcceptance(run.id, acceptance); } catch { /* annotate-only */ }
      addEvent(run.id, 'harvest:acceptance', acceptance);
      summary.acceptance = { passed: null, gate: acceptance.gate, kind: acceptance.kind, status: 'skipped' };
      return;
    }
    try {
      // final_output was persisted by captureGoalOutput just before harvest, so
      // the run object here may be stale — re-read for the artifact report check.
      let report = reportText;
      if (report == null) { try { report = runService.getRun(run.id)?.final_output || null; } catch { report = null; } }
      const acceptance = await runAcceptance({
        check,
        workspaceDir,
        reportText: report,
        runCommand: ({ command, cwd }) => runTestCommand({ command, cwd, testRunner, nodeResolver }),
      });
      try { runService.updateGoalAcceptance(run.id, acceptance); } catch { /* annotate-only */ }
      addEvent(run.id, 'harvest:acceptance', acceptance);
      summary.acceptance = { passed: acceptance.passed, gate: acceptance.gate, kind: acceptance.kind, status: acceptance.status };
    } catch (err) {
      addError(run.id, 'acceptance', err);
      pushSummaryError(summary, 'acceptance');
    }
  }

  // G2 §5k-2: enumerate a deliverable workspace into a bounded manifest
  // (path/size/hash; cap 20 files / 10MB; excess flagged manifest_truncated).
  // Symlinks are skipped (lstat), reads are within-root by construction.
  // G2 (Codex R4): TOCTOU-safe capped file read — hashes at most `cap` bytes via
  // a descriptor + fixed 64KB buffer, so even if the file GROWS after lstat the
  // read is hard-bounded (never slurps the whole file into memory). Returns the
  // sha256 of the first `cap` bytes, or null on error.
  function hashCappedFile(abs, cap) {
    let fd;
    try { fd = fs.openSync(abs, 'r'); } catch { return null; }
    try {
      const h = crypto.createHash('sha256');
      const buf = Buffer.allocUnsafe(64 * 1024);
      let read = 0;
      while (read < cap) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, cap - read), null);
        if (n <= 0) break;
        h.update(buf.subarray(0, n));
        read += n;
      }
      return h.digest('hex');
    } catch { return null; } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  // G2 (Codex R4): TOCTOU-safe capped copy — copies at most `cap` bytes via
  // descriptors + a fixed buffer, so a file that grows after lstat cannot make
  // the copy unbounded. Returns true on success.
  function copyCappedFile(src, dst, cap) {
    let sfd; let dfd;
    try { sfd = fs.openSync(src, 'r'); } catch { return false; }
    try { dfd = fs.openSync(dst, 'w', 0o600); } catch { try { fs.closeSync(sfd); } catch { /* */ } return false; }
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let written = 0;
      while (written < cap) {
        const n = fs.readSync(sfd, buf, 0, Math.min(buf.length, cap - written), null);
        if (n <= 0) break;
        fs.writeSync(dfd, buf, 0, n);
        written += n;
      }
      return true;
    } catch { return false; } finally { try { fs.closeSync(sfd); } catch { /* */ } try { fs.closeSync(dfd); } catch { /* */ } }
  }

  function enumerateDeliverable(root) {
    const MAX_FILES = 20;
    const MAX_TOTAL = 10 * 1024 * 1024;   // total hashed/bundled budget
    const MAX_FILE_BYTES = 5 * 1024 * 1024; // never read a single file bigger than this
    const MAX_ENTRIES = 5000; // Codex R2: bound the WALK itself (not just the manifest)
    const MAX_STACK = 5000;
    const files = [];
    let truncated = false;
    let total = 0;
    let visited = 0;
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length) {
      if (visited >= MAX_ENTRIES) { truncated = true; break; } // stop the whole walk
      const { dir, depth } = stack.pop();
      if (depth > 10) continue;
      // Codex R3: stream directory entries with opendirSync (one Dirent at a
      // time) instead of readdirSync (which materializes the ENTIRE directory
      // before any cap can apply). A single directory of millions of entries is
      // now bounded by the global visit budget, not by physical memory.
      let dh;
      try { dh = fs.opendirSync(dir); } catch { continue; }
      try {
        let ent;
        while ((ent = dh.readSync()) !== null) {
          if (visited >= MAX_ENTRIES) { truncated = true; break; }
          visited++;
          const abs = path.join(dir, ent.name);
          if (ent.isSymbolicLink()) continue;
          if (ent.isDirectory()) {
            if (stack.length < MAX_STACK) stack.push({ dir: abs, depth: depth + 1 });
            else truncated = true;
            continue;
          }
          if (!ent.isFile()) continue;
          if (files.length >= MAX_FILES || total >= MAX_TOTAL) { truncated = true; continue; }
          // Size-first (Codex BLOCKER-2): decide from lstat BEFORE any read, so a
          // huge file is never slurped into memory and never bundled.
          let st;
          try { st = fs.lstatSync(abs); } catch { continue; }
          if (!st.isFile()) continue;
          const rel = path.relative(root, abs).split(path.sep).join('/');
          const size = st.size;
          if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL) {
            files.push({ path: rel, size, sha256: null, skipped: 'too_large' });
            truncated = true;
            continue;
          }
          // TOCTOU-safe: bounded descriptor read (never readFileSync the whole file).
          const hash = hashCappedFile(abs, MAX_FILE_BYTES);
          if (hash == null) continue;
          total += size;
          files.push({ path: rel, size, sha256: hash });
        }
      } finally {
        try { dh.closeSync(); } catch { /* ignore */ }
      }
    }
    return { files, truncated, total_bytes: total };
  }

  // G2b §5k-1: enumerate a REMOTE deliverable workspace via the node executor
  // (bounded listing with sizes). Same caps as the local walk. hash is deferred
  // to the bundle step (it needs a read); size-first skip of oversize files.
  async function enumerateDeliverableRemote(executor, ws) {
    const MAX_FILES = 20;
    const MAX_TOTAL = 10 * 1024 * 1024;
    const MAX_FILE_BYTES = GOAL_MAX_FILE_BYTES;
    const MAX_ENTRIES = 5000;
    let listing;
    try { listing = await executor.listFilesWithSizes(ws, { maxEntries: MAX_ENTRIES }); } catch { return null; }
    const files = [];
    let truncated = !!(listing && listing.truncated);
    let total = 0;
    for (const entry of (listing && listing.files) || []) {
      const size = Number(entry.size) || 0;
      if (files.length >= MAX_FILES || total >= MAX_TOTAL) { truncated = true; continue; }
      // Size-first: oversize files are metadata-only, never read (from the listing).
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL) {
        files.push({ path: entry.relPath, size, sha256: null, skipped: 'too_large' });
        truncated = true;
        continue;
      }
      total += size;
      files.push({ path: entry.relPath, size, sha256: null }); // hash filled at bundle
    }
    return { files, truncated, total_bytes: total };
  }

  // G2b §5k-1: transactionally bundle a REMOTE deliverable workspace to the
  // control plane. Each non-skipped file is capped-read (base64, budgeted by the
  // remaining aggregate), written locally, and RE-HASHED (written == read). Only
  // if EVERY file bundles cleanly does the caller mark 'bundled' + rmrf the remote
  // workspace; any failure leaves 'captured' (no rmrf) so nothing is lost.
  async function bundleDeliverableRemote(executor, manifest, ws, dest) {
    const MAX_TOTAL = 10 * 1024 * 1024;
    let runningTotal = 0;
    let copied = 0;
    let allOk = true;
    for (const f of manifest.files) {
      if (f.skipped) continue;
      const remaining = MAX_TOTAL - runningTotal;
      if (remaining <= 0) { f.skipped = 'total_budget'; manifest.truncated = true; continue; }
      const readCap = Math.min(GOAL_MAX_FILE_BYTES, remaining);
      const dst = path.join(dest, f.path);
      if (!isWithinRoot(dest, dst)) { allOk = false; continue; }
      let raw;
      // Read cap+1 so we can PROVE EOF within budget (codex BLOCKER): if the file
      // grew past the cap between listing and read, `head -c cap+1` returns cap+1
      // bytes → we bundle only the first cap + flag it truncated, never claiming a
      // complete capture of a file that exceeded the budget.
      try { raw = await executor.readFileCapped(path.posix.join(ws, f.path), readCap + 1); } catch { allOk = false; continue; }
      let buf = raw;
      if (raw.length > readCap) { buf = raw.subarray(0, readCap); f.truncated = 'budget'; manifest.truncated = true; }
      const readHash = crypto.createHash('sha256').update(buf).digest('hex');
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, buf, { mode: 0o600 });
        // Re-hash the WRITTEN bytes (integrity), not just a length compare.
        const writtenHash = crypto.createHash('sha256').update(fs.readFileSync(dst)).digest('hex');
        if (writtenHash !== readHash) { allOk = false; continue; }
      } catch { allOk = false; continue; }
      f.sha256 = readHash;
      runningTotal += buf.length;
      copied++;
    }
    return { allOk, copied };
  }

  // G2b §5k-1: remote deliverable harvest. Mirrors the local order but via the
  // node executor + transactional bundle. rmrf the remote workspace ONLY after a
  // fully-verified bundle (else retain 'captured' for a boot re-harvest).
  async function harvestDeliverableRunRemote(run, summary) {
    summary.harvested = true;
    const ws = run.goal_workspace_path;
    const executor = executorFor(run);
    let manifest = null;
    try {
      if (ws && executor && typeof executor.listFilesWithSizes === 'function') {
        manifest = await enumerateDeliverableRemote(executor, ws);
      }
    } catch (err) { addError(run.id, 'deliverable_enumerate', err); pushSummaryError(summary, 'deliverable_enumerate'); }
    if (manifest) {
      addEvent(run.id, 'harvest:deliverable', { files: manifest.files.length, total_bytes: manifest.total_bytes, manifest_truncated: manifest.truncated, remote: true });
      try { runService.setDeliverableState(run.id, 'captured'); } catch { /* annotate */ }
    }

    // Gate 1 acceptance: remote machine check is skipped (runner_unavailable) → gate2.
    await runGate1Acceptance(run, ws, summary, run.final_output);

    if (manifest && ws && executor) {
      try {
        const safeSeg = (v, fb) => (String(v || '').replace(/[^a-zA-Z0-9_-]/g, '') || fb);
        const dest = path.resolve(process.cwd(), 'runtime', 'goal-artifacts', safeSeg(run.task_id, 'none'), safeSeg(run.id, 'run'));
        fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        const { allOk, copied } = await bundleDeliverableRemote(executor, manifest, ws, dest);
        if (allOk) {
          // Persist the manifest BEFORE marking bundled + reclaiming the workspace
          // (codex SERIOUS): a swallowed setDeliverableJson failure must not delete
          // the sole workspace with no persisted manifest — retain 'captured' then.
          let manifestPersisted = true;
          if (taskService && run.task_id) {
            try { taskService.setDeliverableJson(run.task_id, JSON.stringify({ run_id: run.id, files: manifest.files, truncated: manifest.truncated, remote: true })); }
            catch (err) { manifestPersisted = false; addError(run.id, 'deliverable_manifest_persist', err); }
          }
          if (!manifestPersisted) {
            addEvent(run.id, 'goal:deliverable_bundle_deferred', { files: copied, remote: true, reason: 'manifest_persist_failed' });
            pushSummaryError(summary, 'deliverable_bundle_deferred');
          } else {
            runService.setDeliverableState(run.id, 'bundled');
            addEvent(run.id, 'harvest:deliverable_bundled', { dest: path.relative(process.cwd(), dest), files: copied, remote: true });
            // Success path ONLY: reclaim the remote workspace now that both the
            // bundle AND the manifest are durable.
            try { await executor.rmrf(ws); } catch (err) { addError(run.id, 'deliverable_workspace_rmrf', err); pushSummaryError(summary, 'deliverable_workspace_rmrf'); }
          }
        } else {
          // Retain 'captured' + do NOT rmrf → a boot re-harvest re-attempts.
          addEvent(run.id, 'goal:deliverable_bundle_deferred', { files: copied, remote: true });
          pushSummaryError(summary, 'deliverable_bundle_deferred');
        }
      } catch (err) { addError(run.id, 'deliverable_bundle', err); pushSummaryError(summary, 'deliverable_bundle'); }
    }
  }

  // G2 §5k-2: harvest a deliverable-mode goal run (no git workspace). Order per
  // Codex SERIOUS-3: enumerate → Gate 1 acceptance (live workspace) → copy bundle
  // → mark bundled → emit. The source workspace is removed later by lifecycle
  // cleanup. annotate-only / never-throws. The final run:harvested is emitted by
  // the caller (exactly-once contract preserved).
  async function harvestDeliverableRun(run, summary) {
    // G2b §5k-1: a remote deliverable workspace goes through the executor path.
    if (!isLocalNodeRun(run)) return harvestDeliverableRunRemote(run, summary);
    summary.harvested = true;
    const ws = run.goal_workspace_path;
    let manifest = null;
    try {
      if (ws && fs.existsSync(ws)) manifest = enumerateDeliverable(ws);
    } catch (err) { addError(run.id, 'deliverable_enumerate', err); pushSummaryError(summary, 'deliverable_enumerate'); }
    if (manifest) {
      addEvent(run.id, 'harvest:deliverable', { files: manifest.files.length, total_bytes: manifest.total_bytes, manifest_truncated: manifest.truncated });
      try { runService.setDeliverableState(run.id, 'captured'); } catch { /* annotate */ }
    }

    // Gate 1 acceptance against the LIVE workspace (before any copy/delete).
    await runGate1Acceptance(run, ws, summary, run.final_output);

    // Copy the bundle out so it survives the workspace cleanup (retention).
    if (manifest && ws) {
      try {
        // Defense-in-depth: sanitize id segments to a safe filename charset so a
        // corrupt task_id/run.id can never escape the goal-artifacts root.
        const safeSeg = (v, fb) => (String(v || '').replace(/[^a-zA-Z0-9_-]/g, '') || fb);
        // dest embeds the runId and harvest is exactly-once per run (seenRunIds +
        // hasExistingHarvestEvent), so the destination is always fresh — no
        // recursive rmSync needed (Codex R5: that pre-clear was itself unbounded
        // I/O). mkdir is idempotent; each capped copy overwrites its own file.
        const dest = path.resolve(process.cwd(), 'runtime', 'goal-artifacts', safeSeg(run.task_id, 'none'), safeSeg(run.id, 'run'));
        fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
        // Copy ONLY the bounded manifest files (Codex BLOCKER-2) — NOT the whole
        // tree — so an oversized/huge workspace can't blow up the bundle. Each
        // destination is re-checked to stay within the bundle root.
        let copied = 0;
        for (const f of manifest.files) {
          if (f.skipped) continue; // oversized file — metadata only, not bundled
          const src = path.join(ws, f.path);
          const dst = path.join(dest, f.path);
          if (!isWithinRoot(dest, dst) || !isWithinRoot(ws, src)) continue;
          try {
            const st = fs.lstatSync(src);
            if (!st.isFile()) continue; // never follow a symlink into a copy
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            // TOCTOU-safe capped copy (Codex R4) — bounded even if src grows.
            if (copyCappedFile(src, dst, GOAL_MAX_FILE_BYTES)) copied++;
          } catch { /* skip this file */ }
        }
        runService.setDeliverableState(run.id, 'bundled');
        addEvent(run.id, 'harvest:deliverable_bundled', { dest: path.relative(process.cwd(), dest), files: copied });
        if (taskService && run.task_id) {
          try {
            taskService.setDeliverableJson(run.task_id, JSON.stringify({ run_id: run.id, files: manifest.files, truncated: manifest.truncated }));
          } catch { /* annotate */ }
        }
      } catch (err) { addError(run.id, 'deliverable_bundle', err); pushSummaryError(summary, 'deliverable_bundle'); }
    }
  }

  async function harvestRun(run, { projectDir } = {}) {
    if (!isReviewTargetRun(run)) return;
    if (seenRunIds.has(run.id)) return;
    if (hasExistingHarvestEvent(run.id)) return;
    seenRunIds.add(run.id);

    const summary = createSummary();
    try {
      // G2 §5k-2: deliverable-mode goal run (isolated workspace, no git worktree).
      // Runs the deliverable stage (enumerate → Gate 1 acceptance → bundle) rather
      // than falling into the no_worktree early-return. run:harvested still emits
      // exactly once below.
      if (run.goal_active && run.goal_workspace_path && !run.worktree_path && !isMaterializedHarvestTarget(run)) {
        await harvestDeliverableRun(run, summary);
        emitHarvested(run, summary);
        return;
      }
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

      // G2 §5f: Gate 1 acceptance for a code-mode goal run — runs the assigned
      // check against the worktree AFTER the test stage, BEFORE worktree removal.
      await runGate1Acceptance(run, run.worktree_path, summary, run.final_output);

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

  // G2b §5k-1: re-attempt the bundle for a run whose remote deliverable workspace
  // was retained ('captured', not yet 'bundled'). Runs WITHOUT emitting
  // run:harvested (no re-review), so a transient bundle failure recovers on boot
  // without a permanent artifact loss. never-throws.
  async function reharvestRemoteDeliverable(run) {
    if (!run || run.is_manager || !run.goal_active || !run.goal_workspace_path) return;
    if (isLocalNodeRun(run)) return; // only remote retained workspaces
    const summary = createSummary();
    try { await harvestDeliverableRunRemote(run, summary); }
    catch (err) { addError(run.id, 'deliverable_reharvest', err); }
  }

  return { harvestRun, reharvestRemoteDeliverable };
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
