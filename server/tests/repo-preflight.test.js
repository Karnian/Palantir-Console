'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRepoPreflightService } = require('../services/repoPreflightService');

function createService(execImpl) {
  const calls = [];
  return {
    calls,
    service: createRepoPreflightService({
      nodeService: {
        pickExecutor(nodeId) {
          calls.push(['pickExecutor', nodeId]);
          return {
            async exec(command, args, opts) {
              calls.push(['exec', command, args, opts]);
              return execImpl(command, args, opts);
            },
          };
        },
      },
    }),
  };
}

test('repo preflight runs git ls-remote and returns first SHA fingerprint', async () => {
  const { service, calls } = createService(async () => ({
    code: 0,
    stdout: '0123456789abcdef0123456789abcdef01234567\trefs/heads/main\n',
    stderr: '',
  }));

  const result = await service.preflight({
    repoUrl: 'git@github.com:acme/repo.git',
    repoRef: 'main',
    nodeId: 'node-a',
  });

  assert.deepEqual(result, {
    ok: true,
    skipped: false,
    fingerprint: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.deepEqual(calls[0], ['pickExecutor', 'node-a']);
  assert.equal(calls[1][1], 'git');
  assert.equal(calls[1][2][0], 'ls-remote');
  assert.deepEqual(calls[1][2], ['ls-remote', '--exit-code', '--', 'git@github.com:acme/repo.git', 'main']);
  assert.equal(calls[1][3].timeoutMs, 10000);
  // Non-interactive env so an ssh:// preflight cannot hang on a host-key /
  // password prompt (Codex PR5a R2 NIT).
  assert.equal(calls[1][3].env.GIT_TERMINAL_PROMPT, '0');
  assert.match(calls[1][3].env.GIT_SSH_COMMAND, /BatchMode=yes/);
});

test('repo preflight puts option terminator before a hostile repo_url (no git option smuggling)', async () => {
  const { service, calls } = createService(async () => ({
    code: 0,
    stdout: '0123456789abcdef0123456789abcdef01234567\tHEAD\n',
    stderr: '',
  }));

  await service.preflight({
    repoUrl: '--upload-pack=touch /tmp/pwned',
    repoRef: '--config=core.foo=bar',
    nodeId: 'node-a',
  });

  const args = calls[1][2];
  const dashDash = args.indexOf('--');
  // The `--` must precede BOTH positionals so git parses the hostile strings as
  // a URL + ref, never as options.
  assert.ok(dashDash >= 0, 'ls-remote args must contain an option terminator');
  assert.ok(args.indexOf('--upload-pack=touch /tmp/pwned') > dashDash);
  assert.ok(args.indexOf('--config=core.foo=bar') > dashDash);
});

test('repo preflight classifies auth failure without exposing stderr', async () => {
  const secretStderr = 'Authentication failed for https://user:secret@example.test/repo.git';
  const { service } = createService(async () => ({ code: 128, stdout: '', stderr: secretStderr }));

  await assert.rejects(
    () => service.preflight({ repoUrl: 'https://example.test/repo.git', repoRef: 'HEAD', nodeId: 'local' }),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.reason, 'repo_auth_failed');
      assert.deepEqual(err.details, { reason: 'repo_auth_failed' });
      assert.equal(String(err.message).includes('secret'), false);
      assert.equal(JSON.stringify(err.details).includes('secret'), false);
      return true;
    },
  );
});

test('repo preflight classifies missing refs', async () => {
  const { service } = createService(async () => ({ code: 2, stdout: '', stderr: 'fatal: remote ref not found' }));

  await assert.rejects(
    () => service.preflight({ repoUrl: 'git@example.test:acme/repo.git', repoRef: 'missing' }),
    (err) => err.reason === 'repo_ref_not_found',
  );
});

test('repo preflight classifies repository-not-found as unreachable, not missing ref', async () => {
  const { service } = createService(async () => ({ code: 128, stdout: '', stderr: 'ERROR: Repository not found.' }));

  await assert.rejects(
    () => service.preflight({ repoUrl: 'git@example.test:acme/private.git', repoRef: 'main' }),
    (err) => {
      assert.equal(err.reason, 'repo_unreachable');
      return true;
    },
  );
});

test('repo preflight maps thrown ls-remote exit 2 to missing ref', async () => {
  const { service } = createService(async () => {
    const err = new Error('Command failed: git ls-remote');
    err.code = 2;
    err.stderr = '';
    throw err;
  });

  await assert.rejects(
    () => service.preflight({ repoUrl: 'git@example.test:acme/repo.git', repoRef: 'missing' }),
    (err) => err.reason === 'repo_ref_not_found',
  );
});

test('repo preflight classifies executor timeout', async () => {
  const timeout = new Error('operation timed out');
  timeout.code = 'ETIMEDOUT';
  timeout.stderr = 'token=should-not-leak';
  const { service } = createService(async () => { throw timeout; });

  await assert.rejects(
    () => service.preflight({ repoUrl: 'git@example.test:acme/repo.git', repoRef: 'HEAD' }),
    (err) => {
      assert.equal(err.reason, 'repo_preflight_timeout');
      assert.equal(String(err.message).includes('should-not-leak'), false);
      return true;
    },
  );
});

test('repo preflight skip env avoids executor calls', async (t) => {
  const prev = process.env.PALANTIR_REPO_PREFLIGHT_SKIP;
  process.env.PALANTIR_REPO_PREFLIGHT_SKIP = '1';
  t.after(() => {
    if (prev === undefined) delete process.env.PALANTIR_REPO_PREFLIGHT_SKIP;
    else process.env.PALANTIR_REPO_PREFLIGHT_SKIP = prev;
  });

  const { service, calls } = createService(async () => {
    throw new Error('should not execute');
  });

  const result = await service.preflight({ repoUrl: 'git@example.test:acme/repo.git' });

  assert.deepEqual(result, { ok: true, skipped: true, fingerprint: null });
  assert.deepEqual(calls, []);
});
