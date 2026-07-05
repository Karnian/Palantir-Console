const { BadRequestError } = require('../utils/errors');

const PREFLIGHT_TIMEOUT_MS = 10000;
const PREFLIGHT_MAX_BUFFER = 1024 * 1024;

function isPreflightSkipped() {
  return process.env.PALANTIR_REPO_PREFLIGHT_SKIP === '1';
}

function parseFingerprint(stdout) {
  const firstLine = String(stdout || '').split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return null;
  const match = firstLine.trim().match(/^([0-9a-f]{40,64})\s+/i);
  return match ? match[1] : null;
}

function classifyFailure(text, err) {
  if (err && (
    err.code === 'ETIMEDOUT'
    || err.code === 'ESOCKETTIMEDOUT'
    || err.killed
    || err.signal === 'SIGTERM'
    || err.signal === 'SIGKILL'
    || /timed?\s*out/i.test(String(err.message || ''))
  )) {
    return 'repo_preflight_timeout';
  }

  const combined = String(text || '');
  if (/authentication failed|permission denied|access denied|could not read username|auth/i.test(combined)) {
    return 'repo_auth_failed';
  }
  // NOTE: repo_ref_not_found is signalled EXCLUSIVELY by `git ls-remote
  // --exit-code`'s exit code 2 (reachable repo, no matching ref) in the
  // caller. classifyFailure must NOT infer it from stderr text: strings like
  // "no matching host key type found" are SSH transport failures, not missing
  // refs, and misclassifying them produces a wrong reason toast (Codex R2
  // review, SERIOUS). This function only returns auth / timeout / unreachable.
  if (/timed?\s*out|operation timed out|connection timeout/i.test(combined)) {
    return 'repo_preflight_timeout';
  }
  if (/repository not found|repository access|not found/i.test(combined)) {
    return 'repo_unreachable';
  }
  return 'repo_unreachable';
}

function throwPreflightFailure(reason) {
  const err = new BadRequestError('Repository preflight failed');
  err.reason = reason;
  err.details = { reason };
  throw err;
}

function createRepoPreflightService({ nodeService } = {}) {
  async function preflight({ repoUrl, repoRef, nodeId } = {}) {
    if (isPreflightSkipped()) {
      return { ok: true, skipped: true, fingerprint: null };
    }
    if (!repoUrl) throwPreflightFailure('repo_unreachable');
    if (!nodeService || typeof nodeService.pickExecutor !== 'function') {
      throw new Error('repoPreflightService requires nodeService.pickExecutor');
    }

    const executor = nodeService.pickExecutor(nodeId);
    if (!executor || typeof executor.exec !== 'function') {
      throw new Error('node executor does not implement exec');
    }

    const args = ['ls-remote', '--exit-code', repoUrl, repoRef || 'HEAD'];
    let result;
    try {
      result = await executor.exec('git', args, {
        timeoutMs: PREFLIGHT_TIMEOUT_MS,
        maxBuffer: PREFLIGHT_MAX_BUFFER,
      });
    } catch (err) {
      const exitCode = Number(err?.exitCode ?? err?.status ?? (typeof err?.code === 'number' ? err.code : NaN));
      if (exitCode === 2) {
        throwPreflightFailure('repo_ref_not_found');
      }
      const reason = classifyFailure(`${err?.stderr || ''}\n${err?.stdout || ''}\n${err?.message || ''}`, err);
      throwPreflightFailure(reason);
    }

    const exitCode = Number(result?.code);
    if (exitCode === 2) {
      throwPreflightFailure('repo_ref_not_found');
    }
    if (exitCode !== 0) {
      const reason = classifyFailure(`${result?.stderr || ''}\n${result?.stdout || ''}`);
      throwPreflightFailure(reason);
    }

    return {
      ok: true,
      skipped: false,
      fingerprint: parseFingerprint(result.stdout),
    };
  }

  return { preflight };
}

module.exports = {
  createRepoPreflightService,
  parseFingerprint,
  classifyFailure,
};
