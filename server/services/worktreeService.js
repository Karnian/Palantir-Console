const path = require('node:path');
const { createLocalNodeExecutor } = require('./nodeExecutor');

/**
 * Async git worktree manager — classifies project directories and creates
 * isolated worktrees for agent runs through the canonical NodeExecutor APIs.
 * createWorktree succeeds only for git repositories and throws on
 * classification/worktree failures; callers that intentionally share a non-git
 * directory must opt in before spawning.
 */

function createWorktreeService({ nodeExecutor = createLocalNodeExecutor() } = {}) {
  /**
   * Validate branch name: only allow safe characters (alphanumeric, hyphens, underscores, slashes, dots).
   * Prevents path traversal and command injection.
   */
  function validateBranchName(name) {
    if (!name || typeof name !== 'string') {
      throw new Error('Branch name is required');
    }
    // Reject path traversal
    if (name.includes('..') || name.startsWith('/') || name.startsWith('-')) {
      throw new Error(`Invalid branch name: ${name}`);
    }
    // Only allow safe git branch name characters
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name)) {
      throw new Error(`Invalid branch name characters: ${name}`);
    }
    return name;
  }

  function gitError(args, res) {
    const message = res.stderr || res.stdout || `git ${args.join(' ')} failed with code ${res.code}`;
    const err = new Error(message);
    err.code = res.code;
    err.stdout = res.stdout;
    err.stderr = res.stderr;
    return err;
  }

  async function execGitOrThrow(cwd, args, opts = {}) {
    const res = await nodeExecutor.exec('git', args, { cwd, ...opts });
    if (res.code !== 0) {
      throw gitError(args, res);
    }
    return res.stdout;
  }

  async function classifyProjectDir(dir) {
    try {
      // LC_ALL=C forces English git messages. Exit 128 alone cannot separate
      // "not a repository" from other fatals (dubious ownership, bad config),
      // so stderr matching is required — and the host/pod locale must not
      // break it (found live on this ko_KR host: "깃 저장소가 아닙니다" made a
      // plain dir classify as 'unknown'). Remote executors (P2) must apply
      // the same env override.
      const res = await nodeExecutor.exec('git', ['rev-parse', '--git-dir'], {
        cwd: dir,
        env: { LC_ALL: 'C', LANG: 'C' },
      });
      if (res.code === 0) return 'git';
      if (res.code === 128 && /not a git repository/i.test(String(res.stderr || ''))) {
        return 'non_git';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function isGitRepo(dir) {
    try {
      return await classifyProjectDir(dir) === 'git';
    } catch {
      return false;
    }
  }

  async function assertGitProjectDir(dir) {
    const classification = await classifyProjectDir(dir);
    if (classification !== 'git') {
      throw new Error(`Cannot create worktree for ${classification} project directory`);
    }
  }

  /**
   * Resolve the base ref to branch a new worktree from. Falls back from the
   * current branch name -> HEAD sha (detached HEAD case) -> 'main'. Returning
   * something usable here is critical: an empty value would make the downstream
   * `git branch <new> ''` call fail and silently disable worktree isolation.
   */
  async function getCurrentBranch(dir) {
    try {
      const branch = (await execGitOrThrow(dir, ['branch', '--show-current'])).trim();
      if (branch) return branch;
    } catch { /* fall through */ }
    try {
      const sha = (await execGitOrThrow(dir, ['rev-parse', 'HEAD'])).trim();
      if (sha) return sha;
    } catch { /* fall through */ }
    return 'main';
  }

  /**
   * Create a new git worktree for an agent run.
   * @param {string} projectDir - The git repository root
   * @param {string} branchName - Branch name for the worktree
   * @returns {Promise<{ path: string, branch: string, created: boolean }>}
   */
  async function createWorktree(projectDir, branchName) {
    await assertGitProjectDir(projectDir);

    const safeBranch = validateBranchName(branchName);
    const worktreesBase = path.join(projectDir, '.palantir-worktrees');
    const worktreePath = path.join(worktreesBase, safeBranch);

    // Verify the resolved path is still under worktreesBase (prevent traversal)
    const resolvedPath = path.resolve(worktreePath);
    const resolvedBase = path.resolve(worktreesBase);
    if (!resolvedPath.startsWith(resolvedBase + path.sep)) {
      throw new Error(`Worktree path escapes base directory: ${branchName}`);
    }

    // If worktree already exists, return it
    if (await nodeExecutor.fileExists(worktreePath)) {
      return { path: worktreePath, branch: safeBranch, created: false };
    }

    // Track whether we created the branch ourselves so partial-failure cleanup
    // (after the branch exists but `git worktree add` failed) doesn't strand it.
    let branchPreexisted = true;
    try {
      // Ensure base directory exists
      await nodeExecutor.mkdir(worktreesBase, { recursive: true });

      // Create new branch from current HEAD — all args as arrays (no shell)
      const baseBranch = await getCurrentBranch(projectDir);
      try {
        await execGitOrThrow(projectDir, ['branch', safeBranch, baseBranch]);
        branchPreexisted = false;
      } catch {
        // Branch already existed; leave it alone on rollback
      }

      await execGitOrThrow(projectDir, ['worktree', 'add', worktreePath, safeBranch]);

      return { path: worktreePath, branch: safeBranch, created: true };
    } catch (error) {
      console.error(`[worktreeService] Failed to create worktree: ${error.message}`);
      // Roll back the freshly-created branch so it doesn't strand as `palantir/...` debris.
      // Pre-existing branches are left untouched.
      if (!branchPreexisted) {
        try {
          await execGitOrThrow(projectDir, ['branch', '-D', safeBranch]);
        } catch { /* best effort */ }
      }
      throw error;
    }
  }

  /**
   * Check if a worktree has uncommitted changes (staged or unstaged).
   * Returns true if there is anything that would be lost on removal.
   */
  async function hasUncommittedChanges(worktreePath) {
    try {
      const status = await execGitOrThrow(worktreePath, ['status', '--porcelain']);
      return status.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Auto-save uncommitted changes in a worktree before removal.
   * Stages all changes and creates a commit so work is not lost.
   * Returns true if a commit was created.
   */
  async function autoSaveWorktree(worktreePath, runId) {
    try {
      if (!await hasUncommittedChanges(worktreePath)) return false;

      // Stage all changes (new, modified, deleted)
      await execGitOrThrow(worktreePath, ['add', '-A']);

      // Commit with an identifiable message
      const msg = `[palantir] auto-save uncommitted changes from run ${runId || 'unknown'}`;
      await execGitOrThrow(worktreePath, ['commit', '-m', msg, '--no-verify']);
      console.log(`[worktreeService] Auto-saved uncommitted changes in ${worktreePath} (run: ${runId || 'unknown'})`);
      return true;
    } catch (err) {
      console.warn(`[worktreeService] Auto-save failed for ${worktreePath}: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if a branch has commits ahead of the base branch.
   * If it does, the branch should be preserved (not deleted).
   */
  async function branchHasWork(projectDir, branchName) {
    try {
      const safeBranch = validateBranchName(branchName);
      const baseBranch = await getCurrentBranch(projectDir);
      const count = await execGitOrThrow(
        projectDir,
        ['rev-list', '--count', `${baseBranch}..${safeBranch}`],
      );
      return parseInt(count.trim(), 10) > 0;
    } catch {
      return false;
    }
  }

  /**
   * G4b §5j — promote an accepted goal attempt's (surviving) branch onto a stable
   * `palantir/goal/<taskId>` ref so a human always has a clear, reviewable branch
   * to merge. `git branch -f` is idempotent (force-points the ref at the same
   * commit on a re-run). Both refs are validated (validateBranchName rejects
   * option-injection / traversal; check-ref-format is git's own validator on the
   * full target refname). Throws on any git failure so the caller annotates
   * (goal:deliver_failed) — never a silent success. Returns { branch, source, base, stat }.
   */
  async function promoteGoalBranch(projectDir, sourceBranch, targetBranch) {
    const safeSource = validateBranchName(sourceBranch);
    const safeTarget = validateBranchName(targetBranch);
    // Defense-in-depth (codex MINOR): git's own ref validator on the full refname.
    await execGitOrThrow(projectDir, ['check-ref-format', `refs/heads/${safeTarget}`]);
    // Force-point the stable ref at the accepted branch. `--` ends options; the
    // value is a branch name (palantir/goal/<id>), NOT refs/heads/... (codex MINOR).
    await execGitOrThrow(projectDir, ['branch', '-f', '--', safeTarget, safeSource]);
    let base = null;
    let stat = '';
    try { base = (await execGitOrThrow(projectDir, ['merge-base', 'HEAD', safeSource])).trim() || null; } catch { base = null; }
    try {
      const range = base ? `${base}..${safeSource}` : safeSource;
      stat = (await execGitOrThrow(projectDir, ['diff', '--stat', range])).trim();
    } catch { stat = ''; }
    return { branch: safeTarget, source: safeSource, base, stat };
  }

  /**
   * Remove a worktree. Auto-saves uncommitted changes before removal
   * and preserves the branch if it contains work (commits ahead of base).
   * @param {string} projectDir - The git repository root
   * @param {string} worktreePath - Path to the worktree directory
   * @param {string} branchName - Branch name to optionally delete
   * @param {object} [opts] - Options
   * @param {string} [opts.runId] - Run ID for the auto-save commit message
   * @param {boolean} [opts.autosave=true] - Set false to discard uncommitted changes on removal
   */
  async function removeWorktree(projectDir, worktreePath, branchName, opts = {}) {
    // Validate worktreePath is within projectDir to prevent arbitrary deletion
    const resolvedProject = path.resolve(projectDir);
    const resolvedWorktree = path.resolve(worktreePath);
    if (!resolvedWorktree.startsWith(resolvedProject + path.sep) && resolvedWorktree !== resolvedProject) {
      throw new Error(`Worktree path ${worktreePath} is outside project directory ${projectDir}`);
    }

    // Auto-save uncommitted changes before removal unless the caller has
    // already captured the work that should survive. Harvest uses this to
    // discard test-generated files after it has committed agent work.
    if (opts.autosave !== false && await nodeExecutor.fileExists(resolvedWorktree)) {
      await autoSaveWorktree(resolvedWorktree, opts.runId);
    }

    try {
      await execGitOrThrow(projectDir, ['worktree', 'remove', resolvedWorktree, '--force']);
    } catch (error) {
      console.error(`[worktreeService] Failed to remove worktree: ${error.message}`);
      // Try manual cleanup — only if path is confirmed inside project dir
      try {
        if (await nodeExecutor.fileExists(resolvedWorktree)) {
          const st = await nodeExecutor.stat(resolvedWorktree);
          if (st.isDirectory()) {
            await nodeExecutor.rmrf(resolvedWorktree);
          }
        }
        await execGitOrThrow(projectDir, ['worktree', 'prune']);
      } catch {
        // best effort
      }
    }

    // Only delete the branch if it has no commits ahead of base.
    // Branches with work are preserved so the user can review/merge them.
    if (branchName) {
      const safeBranch = validateBranchName(branchName);
      if (await branchHasWork(projectDir, safeBranch)) {
        console.log(`[worktreeService] Preserving branch '${safeBranch}' — has commits ahead of base`);
      } else {
        try {
          await execGitOrThrow(projectDir, ['branch', '-D', safeBranch]);
        } catch {
          // branch may have been merged or doesn't exist
        }
      }
    }
  }

  /**
   * List all active worktrees for a project.
   */
  async function listWorktrees(projectDir) {
    if (!await isGitRepo(projectDir)) return [];
    try {
      const output = await execGitOrThrow(projectDir, ['worktree', 'list', '--porcelain']);

      const worktrees = [];
      let current = {};

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          if (current.path) worktrees.push(current);
          current = { path: line.slice(9) };
        } else if (line.startsWith('HEAD ')) {
          current.head = line.slice(5);
        } else if (line.startsWith('branch ')) {
          current.branch = line.slice(7).replace('refs/heads/', '');
        } else if (line === 'detached') {
          current.detached = true;
        }
      }
      if (current.path) worktrees.push(current);

      return worktrees;
    } catch {
      return [];
    }
  }

  /**
   * Get diff summary for a worktree branch vs main.
   */
  async function getWorktreeDiff(projectDir, branchName) {
    try {
      const safeBranch = validateBranchName(branchName);
      const baseBranch = await getCurrentBranch(projectDir);
      const gitEnv = { GIT_EXTERNAL_DIFF: '', GIT_TEXTCONV_DIFF: '' };
      // Three-dot range (merge-base..branch): shows only what the branch
      // changed. Two-dot would also pick up base-branch commits that landed
      // after the worktree was created — noise that misattributes others'
      // work to this run's harvest.
      const stat = await execGitOrThrow(
        projectDir,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${baseBranch}...${safeBranch}`, '--stat'],
        { env: gitEnv },
      );
      const diffOutput = await execGitOrThrow(
        projectDir,
        ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${baseBranch}...${safeBranch}`, '--name-only'],
        { env: gitEnv },
      );
      return {
        base: baseBranch,
        branch: safeBranch,
        stat: stat.trim(),
        files: diffOutput.trim().split('\n').filter(Boolean),
      };
    } catch {
      return { stat: '', files: [] };
    }
  }

  return {
    createWorktree,
    removeWorktree,
    listWorktrees,
    getWorktreeDiff,
    classifyProjectDir,
    isGitRepo,
    hasUncommittedChanges,
    branchHasWork,
    autoSaveWorktree,
    promoteGoalBranch,
  };
}

module.exports = { createWorktreeService };
