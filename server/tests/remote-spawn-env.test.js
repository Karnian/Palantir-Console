'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const { createRemoteSshNodeExecutor, shq } = require('../services/remoteSshExecutor');
const { createNodeUsageService } = require('../services/nodeUsageService');
const { EXEC_ENV_KEYS } = require('../services/execEnvPolicy');

const REMOTE_BASELINE = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TMPDIR',
  'TEMP',
  'TMP',
];
const NETWORK_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];
const ACTOR_KEYS = [
  'PALANTIR_TOKEN',
  'PALANTIR_PM_TOKEN',
  'PALANTIR_WORKER_TOKEN',
  'PALANTIR_MANAGER_TOKEN',
];

function nodeRow(fields = {}) {
  return {
    id: 'pod-env',
    name: 'Pod env',
    kind: 'ssh',
    ssh_host: 'pod.example',
    ssh_user: 'runner',
    ssh_port: null,
    exposed_roots: JSON.stringify(['/srv/root']),
    ...fields,
  };
}

function complete(child, { code = 0, stdout = '', stderr = '' } = {}) {
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code, null);
  });
}

function makeSpawn(handler) {
  const calls = [];
  function spawn(cmd, args, opts) {
    const child = new EventEmitter();
    const call = { cmd, args, opts, child, stdin: '' };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        call.stdin += chunk.toString('utf8');
        callback();
      },
    });
    child.kill = () => true;
    calls.push(call);
    handler(call, child);
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

function unshq(value) {
  assert.equal(value[0], "'");
  assert.equal(value[value.length - 1], "'");
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function firstShqWord(value) {
  assert.equal(value[0], "'");
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== "'") continue;
    if (value.slice(index, index + 4) === "'\\''") {
      index += 3;
      continue;
    }
    return value.slice(0, index + 1);
  }
  assert.fail('unterminated shell-quoted word');
}

function destinationIndex(args) {
  const separator = args.indexOf('--');
  assert.notEqual(separator, -1);
  return separator + 1;
}

function rawScriptOf(call) {
  const remoteArgs = call.args.slice(destinationIndex(call.args) + 1);
  assert.equal(remoteArgs.length, 1);
  assert.ok(remoteArgs[0].startsWith('sh -c '));
  return unshq(remoteArgs[0].slice('sh -c '.length));
}

function logicalScriptOf(call) {
  const script = rawScriptOf(call);
  const commandPrefix = `exec env LC_ALL=${shq('C')} `;
  const scriptPrefix = `export LC_ALL=${shq('C')}; `;
  if (
    script.startsWith(commandPrefix)
    && /^'(?:realpath|test|find)'(?: |$)/.test(script.slice(commandPrefix.length))
  ) {
    return `exec ${script.slice(commandPrefix.length)}`;
  }
  if (script.startsWith(scriptPrefix)) return script.slice(scriptPrefix.length);
  return script;
}

function assertSingleInnerPath(script, prefix) {
  const assignments = script.match(/\bPATH=/g) || [];
  assert.equal(assignments.length, 1, script);
  // The pod PATH expansion is DOUBLE-QUOTED: under env -i this is an ordinary
  // argument, not an assignment word, so an unquoted $PATH containing a space
  // splits into two arguments and env exits 127.
  const expected = `PATH=${shq(prefix)}:"$PATH"`;
  assert.ok(script.includes(`env -i "$@" ${expected}`), script);
  assert.ok(script.indexOf('env -i') < script.indexOf(expected), script);
}

function assertBaselineLoop(script) {
  assert.ok(script.includes('set --; for k in '), script);
  assert.ok(script.includes('eval "v=\\${$k+x}"'), script);
  assert.ok(script.includes('[ -n "$v" ] && eval "set -- \\"\\$@\\" \\"$k=\\$$k\\""'), script);
  for (const key of REMOTE_BASELINE.filter((candidate) => candidate !== 'PATH')) {
    assert.ok(script.includes(shq(key)), `missing pod baseline key ${key}`);
  }
  assert.doesNotMatch(script, /\bTMPDIR=''/);
}

function rootAwareSpawn({ cwd = '/srv/root/project', secretPath = null } = {}) {
  const statusReal = new Map();
  const spawn = makeSpawn((call, child) => {
    const script = logicalScriptOf(call);
    if (script === `exec ${shq('realpath')} ${shq('/srv/root')}`) {
      return complete(child, { stdout: '/real/root\n' });
    }
    if (script === `exec ${shq('realpath')} ${shq(cwd)}`) {
      return complete(child, { stdout: `${cwd.replace('/srv/root', '/real/root')}\n` });
    }
    if (secretPath && script === `exec ${shq('realpath')} ${shq(secretPath)}`) {
      return complete(child, {
        stdout: `${secretPath.replace('/srv/root', '/real/root')}\n`,
      });
    }
    if (/^exec 'mkdir' '-p' /.test(script)) {
      const created = unshq(script.slice("exec 'mkdir' '-p' ".length));
      statusReal.set(created, created.replace('/srv/root', '/real/root'));
      return complete(child);
    }
    if (/^exec 'realpath' /.test(script)) {
      const target = unshq(script.slice("exec 'realpath' ".length));
      if (statusReal.has(target)) {
        return complete(child, { stdout: `${statusReal.get(target)}\n` });
      }
    }
    if (secretPath && script.includes(`mktemp -d ${shq('/srv/root/.palantir-secret-XXXXXX')}`)) {
      child.stdin.once('finish', () => complete(child, { stdout: `${secretPath}\n` }));
      return undefined;
    }
    if (/^exec 'rm' '-f' /.test(script)) return complete(child);
    if (script.includes('tmux new-session -d -s ')) return complete(child);
    return undefined;
  });
  return spawn;
}

test('manager spawn builds a pod-derived clean env with one PATH and reference-only capability', async () => {
  const cwd = `/srv/root/project dir/'quoted" $cash *glob*`;
  const prefix = `/opt/agent bin/'quoted" $cash/*glob*`;
  const explicitValue = `space ' " $HOME * ? [abc]`;
  const providerSecret = `provider space ' " $HOME * ? [abc]`;
  const hostileArg = `arg ' " $HOME * ? [abc]`;
  const managerToken = 'manager-capability-literal-must-not-enter-argv';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const spawn = rootAwareSpawn({ cwd, secretPath });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec', hostileArg], {
    cwd,
    pathPrefix: prefix,
    envAllowlist: ['POD_ONLY_PROVIDER_KEY', 'GITHUB_TOKEN', 'PALANTIR_TOKEN', 'CUSTOM_ENV'],
    env: {
      PATH: '/controller/path/must-not-win',
      CUSTOM_ENV: explicitValue,
      GITHUB_TOKEN: providerSecret,
      PALANTIR_TOKEN: 'human-global-secret',
      PALANTIR_PM_TOKEN: 'pm-global-secret',
      PALANTIR_WORKER_TOKEN: 'wrong-run-secret',
      PALANTIR_MANAGER_TOKEN: managerToken,
    },
  });

  const call = spawn.calls.at(-1);
  const script = logicalScriptOf(call);
  assert.ok(script.includes('exec env -i "$@"'));
  assertSingleInnerPath(script, prefix);
  assertBaselineLoop(script);
  assert.ok(script.includes(shq('POD_ONLY_PROVIDER_KEY')));
  assert.ok(script.includes(shq('GITHUB_TOKEN')));
  assert.equal(script.includes(`GITHUB_TOKEN=${shq(providerSecret)}`), false);
  assert.ok(script.includes('GITHUB_TOKEN=$(cat --'));
  assert.ok(script.includes('export GITHUB_TOKEN'));
  assert.ok(
    script.indexOf(shq('GITHUB_TOKEN')) < script.indexOf('GITHUB_TOKEN=$(cat --'),
    'controller materialisation must remain the final explicit override',
  );
  for (const key of NETWORK_KEYS) assert.ok(script.includes(shq(key)), `manager lost ${key}`);
  for (const key of ['CODEX_HOME', 'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE']) {
    assert.ok(script.includes(shq(key)), `codex manager lost ${key}`);
  }
  for (const key of ['NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR']) {
    assert.equal(script.includes(shq(key)), false, `codex manager received claude-only ${key}`);
  }
  // Read from SSH stdin INSIDE the clean shell, never handed to env as an
  // argument — otherwise the real /usr/bin/env argv carries the value and
  // /proc/<pid>/cmdline exposes it to every process on the pod. Verified on a
  // live pod: zero process argv contained the value while the child env did.
  assert.equal(script.includes(`PALANTIR_MANAGER_TOKEN="$PALANTIR_MANAGER_TOKEN"`), false);
  assert.ok(script.includes('IFS= read -r PALANTIR_MANAGER_TOKEN || exit 126'));
  assert.ok(script.includes('export PALANTIR_MANAGER_TOKEN'));
  assert.ok(
    script.indexOf('export PALANTIR_MANAGER_TOKEN') < script.indexOf('exec "$@"'),
    'manager capability must be exported before exec',
  );
  assert.ok(script.includes('/bin/sh -c '), 'clean shell must be an absolute path under env -i');
  assert.equal(script.includes(managerToken), false);
  for (const spawnCall of spawn.calls) {
    assert.equal(JSON.stringify(spawnCall.args).includes(providerSecret), false);
  }
  for (const secret of ['human-global-secret', 'pm-global-secret', 'wrong-run-secret']) {
    assert.equal(script.includes(secret), false);
  }
  assert.equal(call.stdin, `${managerToken}\n`);
  assert.ok(script.includes(`cd ${shq(cwd.replace('/srv/root', '/real/root'))} &&`));
  assert.equal(script.includes(`CUSTOM_ENV=${shq(explicitValue)}`), false);
  assert.ok(script.includes('CUSTOM_ENV=$(cat --'));
  assert.ok(script.endsWith(`${shq('codex')} ${shq('exec')} ${shq(hostileArg)}`));
  assert.equal(script.includes('/controller/path/must-not-win'), false);
  for (const key of ACTOR_KEYS) {
    assert.equal(
      script.includes(`for k in ${shq(key)}`) || script.includes(` ${shq(key)} `),
      false,
      `actor key ${key} must not be preserved by the pod loop`,
    );
  }
});

test('worker spawn preserves pod allowlist names without manager network/vendor env', async () => {
  const runId = 'clean_worker';
  const cwd = '/srv/root/project';
  const prefix = `/home/runner/agent bin/'quoted" $cash/*glob*`;
  const workerToken = 'worker-capability-literal-must-not-enter-argv';
  const apiBase = 'https://argv-zero.example:8443/proxy-prefix';
  const explicitValue = `controller ' " $HOME * ? [abc]`;
  const unlistedSecret = 'unlisted-worker-secret-must-use-file-channel';
  const spawn = rootAwareSpawn({ cwd });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnWorker(runId, {
    command: 'codex',
    args: ['exec'],
    cwd,
    workerPath: prefix,
    envAllowlist: ['POD_ONLY_PROVIDER_KEY', 'GITHUB_TOKEN', 'PALANTIR_PM_TOKEN'],
    env: {
      GITHUB_TOKEN: explicitValue,
      UNLISTED_WORKER_SECRET: unlistedSecret,
      PALANTIR_TOKEN: 'human-global-secret',
      PALANTIR_PM_TOKEN: 'pm-global-secret',
      PALANTIR_MANAGER_TOKEN: 'wrong-run-secret',
      PALANTIR_WORKER_TOKEN: workerToken,
      PALANTIR_API_BASE: apiBase,
    },
  });

  const tmuxScript = spawn.calls
    .map(logicalScriptOf)
    .find((script) => script.includes('tmux new-session -d -s '));
  const tmuxPrefix = `tmux new-session -d -s ${shq(`palantir-run-${runId}`)} `;
  const tmuxIndex = tmuxScript.indexOf(tmuxPrefix);
  assert.notEqual(tmuxIndex, -1);
  const inner = unshq(firstShqWord(tmuxScript.slice(tmuxIndex + tmuxPrefix.length)));
  assert.ok(inner.includes('env -i "$@"'));
  assertSingleInnerPath(inner, prefix);
  assertBaselineLoop(inner);
  assert.ok(inner.includes(shq('POD_ONLY_PROVIDER_KEY')));
  assert.ok(inner.includes(shq('GITHUB_TOKEN')));
  assert.equal(inner.includes(`GITHUB_TOKEN=${shq(explicitValue)}`), false);
  assert.ok(inner.includes('GITHUB_TOKEN=$(cat --'));
  assert.ok(inner.includes('export GITHUB_TOKEN'));
  const unlistedRead = inner.slice(
    inner.indexOf('UNLISTED_WORKER_SECRET=$(cat --'),
    inner.indexOf(';', inner.indexOf('UNLISTED_WORKER_SECRET=$(cat --')),
  );
  assert.ok(unlistedRead.startsWith('UNLISTED_WORKER_SECRET=$(cat --'), inner);
  assert.ok(
    unlistedRead.includes(`/srv/root/.palantir-runs/${runId}/controller-env-UNLISTED_WORKER_SECRET`),
    unlistedRead,
  );
  assert.ok(inner.includes('export UNLISTED_WORKER_SECRET'));
  assert.ok(
    inner.indexOf(shq('GITHUB_TOKEN')) < inner.indexOf('GITHUB_TOKEN=$(cat --'),
    'controller materialisation must remain the final explicit override',
  );
  for (const key of [
    ...NETWORK_KEYS,
    'CODEX_HOME',
    'CODEX_CA_CERTIFICATE',
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'CLAUDE_CONFIG_DIR',
  ]) {
    assert.equal(inner.includes(shq(key)), false, `worker received manager-only ${key}`);
  }
  // The capability is read from its 0600 file INSIDE the clean shell. It must
  // NOT be an env -i argument: `KEY="$KEY"` is expanded before exec, so the real
  // /usr/bin/env argv would carry the value (world-readable via /proc).
  assert.equal(inner.includes('PALANTIR_WORKER_TOKEN="$PALANTIR_WORKER_TOKEN"'), false);
  assert.ok(inner.includes('PALANTIR_WORKER_TOKEN=$(cat --'));
  assert.ok(inner.includes('export PALANTIR_WORKER_TOKEN'));
  assert.ok(inner.includes('PALANTIR_API_BASE=$(cat --'));
  assert.ok(inner.includes('export PALANTIR_API_BASE'));
  assert.equal(inner.includes(workerToken), false);
  assert.equal(inner.includes(apiBase), false);
  for (const secret of ['human-global-secret', 'pm-global-secret', 'wrong-run-secret']) {
    assert.equal(inner.includes(secret), false);
  }
  const bundleWrite = spawn.calls.find(
    (call) => call.stdin === workerToken + apiBase + explicitValue + unlistedSecret,
  );
  assert.ok(bundleWrite, 'worker capability, API base, and controller env share one stdin bundle write');
  for (const call of spawn.calls) {
    assert.equal(JSON.stringify(call.args).includes(workerToken), false);
    assert.equal(JSON.stringify(call.args).includes(apiBase), false);
    assert.equal(JSON.stringify(call.args).includes(explicitValue), false);
    assert.equal(JSON.stringify(call.args).includes(unlistedSecret), false);
  }
  assert.equal(
    spawn.calls.reduce((count, call) => count + call.stdin.split(unlistedSecret).length - 1, 0),
    1,
    'the non-allowlisted worker value appears exactly once, in upload stdin',
  );
  assert.equal(
    spawn.calls.reduce((count, call) => count + call.stdin.split(apiBase).length - 1, 0),
    1,
    'the API base value appears exactly once, in upload stdin',
  );
});

test('worker spawn with only controller env uploads, slices, exports, and cleans its bundle', async () => {
  const runId = 'controller_env_only';
  const cwd = '/srv/root/project';
  const firstSecret = 'secret';
  const secondSecret = 'longer-secret';
  const spawn = rootAwareSpawn({ cwd });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnWorker(runId, {
    command: 'codex',
    cwd,
    env: {
      CUSTOM_SECRET: firstSecret,
      SECOND_SECRET: secondSecret,
    },
    envAllowlist: [],
  });

  for (const call of spawn.calls) {
    const argv = JSON.stringify(call.args);
    assert.equal(argv.includes(firstSecret), false);
    assert.equal(argv.includes(secondSecret), false);
  }

  const bundleWrite = spawn.calls.find(
    (call) => call.stdin === firstSecret + secondSecret,
  );
  assert.ok(bundleWrite, 'controller env-only values must create one upload bundle');
  const script = logicalScriptOf(bundleWrite);
  const tmuxPrefix = `tmux new-session -d -s ${shq(`palantir-run-${runId}`)} `;
  const tmuxIndex = script.indexOf(tmuxPrefix);
  assert.notEqual(tmuxIndex, -1);
  const inner = unshq(firstShqWord(script.slice(tmuxIndex + tmuxPrefix.length)));
  const bundle = `/real/root/.palantir-runs/${runId}/worker-input.bundle`;
  const firstFile = `/srv/root/.palantir-runs/${runId}/controller-env-CUSTOM_SECRET`;
  const secondFile = `/srv/root/.palantir-runs/${runId}/controller-env-SECOND_SECRET`;
  assert.ok(inner.includes(`head -c ${Buffer.byteLength(firstSecret)} ${shq(bundle)} > ${shq(firstFile)}`), inner);
  assert.ok(
    inner.includes(
      `tail -c +${Buffer.byteLength(firstSecret) + 1} ${shq(bundle)} | head -c ${Buffer.byteLength(secondSecret)} > ${shq(secondFile)}`,
    ),
    inner,
  );
  const firstRead = inner.slice(
    inner.indexOf('CUSTOM_SECRET=$(cat --'),
    inner.indexOf(';', inner.indexOf('CUSTOM_SECRET=$(cat --')),
  );
  assert.ok(firstRead.includes(firstFile), firstRead);
  assert.ok(inner.includes('export CUSTOM_SECRET'), inner);
  const secondRead = inner.slice(
    inner.indexOf('SECOND_SECRET=$(cat --'),
    inner.indexOf(';', inner.indexOf('SECOND_SECRET=$(cat --')),
  );
  assert.ok(secondRead.includes(secondFile), secondRead);
  assert.ok(inner.includes('export SECOND_SECRET'), inner);
  const cleanup = `rm -f -- ${shq(bundle)} ${shq(firstFile)} ${shq(secondFile)}`;
  assert.ok(script.includes(cleanup), script);
});

test('worker spawn rejects multiline controller materialization without changing it', async () => {
  const cwd = '/srv/root/project';
  const spawn = rootAwareSpawn({ cwd });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await assert.rejects(
    executor.spawnWorker('multiline_env', {
      command: 'codex',
      args: ['exec'],
      cwd,
      env: { GITHUB_TOKEN: 'line one\nline two' },
      envAllowlist: ['GITHUB_TOKEN'],
    }),
    (err) => err && err.code === 'ENV_MATERIALIZATION_INVALID'
      && /GITHUB_TOKEN/.test(err.message),
  );
  for (const call of spawn.calls) {
    assert.equal(JSON.stringify(call.args).includes('line one\nline two'), false);
  }
});

test('manager spawn sends non-empty controller env outside the allowlist through files, never argv', async () => {
  const cwd = '/srv/root/project';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const secret = 'non-allowlisted-secret-must-not-enter-argv';
  const spawn = rootAwareSpawn({ cwd, secretPath });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: ['GITHUB_TOKEN'],
    env: { UNLISTED_SECRET: secret },
  });
  for (const call of spawn.calls) {
    assert.equal(JSON.stringify(call.args).includes(secret), false);
  }
  const script = logicalScriptOf(spawn.calls.at(-1));
  assert.ok(script.includes('UNLISTED_SECRET=$(cat --'));
  assert.ok(script.includes('export UNLISTED_SECRET'));
});

test('manager spawn keeps empty non-allowlisted controller env as argv blanking', async () => {
  const cwd = '/srv/root/project';
  const spawn = rootAwareSpawn({ cwd });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: [],
    env: { UNLISTED_BLANK: '' },
  });

  const script = logicalScriptOf(spawn.calls.at(-1));
  assert.ok(script.includes(`UNLISTED_BLANK=${shq('')}`));
});

test('git/materialize exec filters pod env with the shared policy while filesystem primitives stay separate', async () => {
  const spawn = makeSpawn((call, child) => {
    const script = logicalScriptOf(call);
    if (script === `exec ${shq('realpath')} ${shq('/srv/root')}`) {
      return complete(child, { stdout: '/real/root\n' });
    }
    if (script === `exec ${shq('realpath')} ${shq('/srv/root/project')}`) {
      return complete(child, { stdout: '/real/root/project\n' });
    }
    return complete(child);
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), {
    spawnFn: spawn,
    commandAllowlist: ['git'],
  });

  await executor.exec('git', ['status'], {
    env: { LC_ALL: 'C', PATH: '/explicit/git/bin' },
  });
  await executor.realpath('/srv/root/project');

  const scripts = spawn.calls.map(logicalScriptOf);
  const gitScript = scripts.find((script) => script.includes(`${shq('git')} ${shq('status')}`));
  const filesystemScripts = scripts.filter((script) => script.includes(shq('realpath')));
  assert.ok(gitScript.startsWith('set --; for k in '), gitScript);
  assert.ok(gitScript.includes('exec env -i "$@"'), gitScript);
  for (const key of EXEC_ENV_KEYS) {
    assert.ok(gitScript.includes(shq(key)), `remote exec lost shared policy key ${key}`);
  }
  assert.ok(gitScript.includes(`PATH=${shq('/explicit/git/bin')}`));
  assert.ok(gitScript.endsWith(`LC_ALL=${shq('C')} PATH=${shq('/explicit/git/bin')} ${shq('git')} ${shq('status')}`));
  for (const secretKey of ['PALANTIR_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(gitScript.includes(secretKey), false, `remote exec exposed ${secretKey}`);
  }
  assert.ok(filesystemScripts.length > 0);
  for (const script of filesystemScripts) assert.equal(script.includes('env -i'), false);
});

class ProbeChild extends EventEmitter {
  constructor({ stdout = '', onLine = null } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.closed = false;
    this.buffer = '';
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.buffer += chunk.toString('utf8');
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          if (onLine) onLine(line, this);
        }
        callback();
      },
      final: (callback) => {
        process.nextTick(() => this.close());
        callback();
      },
    });
    if (stdout) {
      process.nextTick(() => {
        this.stdout.write(stdout);
        this.close();
      });
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', 0, null);
  }

  kill() {
    this.close();
    return true;
  }
}

function appServerChild() {
  return new ProbeChild({
    onLine(line, child) {
      const request = JSON.parse(line);
      let result = {};
      if (request.method === 'account/read') {
        result = { account: { email: 'pod@example.test' }, requiresOpenaiAuth: false };
      } else if (request.method === 'account/rateLimits/read') {
        result = { rateLimits: { primary: { remaining_pct: 50 } } };
      }
      child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      if (request.method === 'account/rateLimits/read') {
        process.nextTick(() => child.close());
      }
    },
  });
}

test('nodeUsage remote probes go through the executor clean-env boundary', async () => {
  const calls = [];
  const spawnInteractiveFn = async (command, args, opts) => {
    calls.push({ command, args, opts });
    const key = `${command} ${args.join(' ')}`;
    if (key === 'codex --version') return new ProbeChild({ stdout: 'codex-cli 1.0\n' });
    if (key === 'codex app-server') return appServerChild();
    if (key === 'claude --version') return new ProbeChild({ stdout: 'claude 1.0\n' });
    if (key === 'claude auth status') {
      return new ProbeChild({ stdout: `${JSON.stringify({ loggedIn: true })}\n` });
    }
    throw new Error(`unexpected probe ${key}`);
  };
  const service = createNodeUsageService({
    nodeService: {
      getNode() {
        return {
          id: 'pod-env',
          name: 'Pod env',
          kind: 'ssh',
          reachable: 1,
          node_prefix: '/home/runner/.npm-global/bin',
        };
      },
    },
    spawnInteractiveFn,
    probeTimeoutMs: 1000,
  });

  await service.getUsageSnapshot('pod-env');

  const appCall = calls.find(
    (call) => call.command === 'codex' && call.args.join(' ') === 'app-server',
  );
  assert.ok(appCall);
  // Asserting a `cleanEnv` flag on the fake would prove nothing: the real SSH
  // executor's spawnInteractive does not take that option and cleans every
  // interactive spawn. Pin the property that actually holds — no probe asks for
  // inherited env — and pin the real script shape separately below.
  for (const call of calls) {
    assert.equal(call.opts.cleanEnv, undefined, `${call.command} must not request an env mode`);
  }

  // The contract that matters: a real remote executor emits env -i for every
  // interactive probe, version and auth included.
  const scripts = [];
  const probeSpawn = makeSpawn((call, child) => {
    scripts.push(logicalScriptOf(call));
    complete(child, { stdout: 'codex-cli 1.0\n' });
  });
  const realExecutor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: probeSpawn });
  await realExecutor.spawnInteractive('codex', ['--version'], {});
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes('env -i "$@"'), scripts[0]);
});

// --- #519 리뷰 후속: 크레덴셜 파일이 pod 에 남는 경로 3종 ---

test('materialized bootstrap traps EVERY file so a failed read cannot strand later ones', async () => {
  const cwd = '/srv/root/project';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const spawn = rootAwareSpawn({ cwd, secretPath });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: ['KEY_A', 'KEY_B'],
    env: { KEY_A: 'secret-a', KEY_B: 'secret-b' },
  });
  const script = logicalScriptOf(spawn.calls.at(-1));

  // 선행 trap 이 없으면, 첫 cat 실패의 `exit 78` 이 뒤 파일의 rm 을 건너뛰어
  // mode-0600 크레덴셜이 pod 에 남는다 — 이 이슈가 없애려던 바로 그 유출이다.
  // 스크립트는 중첩 셸이라 따옴표가 `'\''` 로 escape 된다. 인용 방식에 기대지 않고
  // "첫 읽기 이전 구간" 을 잘라서 본다.
  const firstRead = script.indexOf('=$(cat --');
  assert.ok(firstRead > 0, 'materialized 읽기가 생성돼야 한다');
  const beforeFirstRead = script.slice(0, firstRead);
  assert.ok(beforeFirstRead.includes('trap'), 'trap 이 첫 읽기보다 먼저 설치돼야 한다');
  assert.ok(beforeFirstRead.includes('rm -f --'), 'trap 이 파일을 지워야 한다');
  const trappedFiles = (beforeFirstRead.match(/controller-env/g) || []).length;
  assert.equal(trappedFiles, 2, 'trap 이 두 파일을 **모두** 덮어야 한다 (하나만 덮으면 나머지가 남는다)');
});

test('materialized bootstrap refuses to continue when cleanup itself fails', async () => {
  const cwd = '/srv/root/project';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const spawn = rootAwareSpawn({ cwd, secretPath });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: ['KEY_A'],
    env: { KEY_A: 'secret-a' },
  });
  const script = logicalScriptOf(spawn.calls.at(-1));
  // 읽기는 성공했는데 rm 이 실패하면 크레덴셜을 남긴 채 에이전트가 실행된다.
  assert.ok(/materialized_env_0_rm_rc=\$\?/.test(script), 'rm 의 상태를 잡아야 한다');
  assert.ok(/\[ "\$materialized_env_0_rm_rc" -eq 0 \] \|\| exit 79/.test(script),
    'rm 실패는 계속 진행이 아니라 중단이어야 한다');
});

test('manager spawn cleans materialized files when ssh fails ASYNCHRONOUSLY', async () => {
  const cwd = '/srv/root/project';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const base = rootAwareSpawn({ cwd, secretPath });
  const removals = [];
  let bootstrapChild = null;
  const spawn = (cmd, args, opts) => {
    const call = { cmd, args, opts };
    const script = String(args[args.length - 1]);
    // 중첩 셸이라 따옴표가 escape 된다. 인용 방식에 기대지 않고 내용으로 판별하되,
    // **파일 생성 스크립트를 배제**해야 한다 — writeTempFile 의 스크립트에도
    // `rm -rf -- "$tmpdir"` cleanup 과 파일명이 들어 있어, 그걸 세면 정리를
    // 하지 않아도 통과하는 vacuous 테스트가 된다.
    if (
      script.includes('controller-env')
      && script.includes('rm')
      && !script.includes('env -i')
      && !script.includes('mktemp')
    ) {
      removals.push(script);
    }
    const child = base(cmd, args, opts);
    // 부트스트랩(‑ keepAlive 스크립트)에는 trap 이 있지만, ssh 가 거기 도달하지
    // 못하면 파일이 pod 에 남는다. spawn 의 실행 실패는 대개 throw 가 아니라
    // 비동기 'error' 이벤트로 온다.
    if (script.includes('cat --') && script.includes('env -i')) {
      bootstrapChild = child;
      setImmediate(() => child.emit('error', Object.assign(new Error('connect failed'), { code: 'ENOENT' })));
    }
    return child;
  };
  spawn.calls = base.calls;
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: ['KEY_A'],
    env: { KEY_A: 'secret-a' },
  });
  assert.ok(bootstrapChild, '부트스트랩 spawn 이 일어나야 한다');
  // 정리는 비동기 체인이라 고정 대기는 flaky 하다. 조건이 성립할 때까지 폴링한다.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !removals.some((script) => script.includes('controller-env'))) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    removals.some((script) => script.includes('controller-env')),
    "비동기 'error' 에서도 materialized 파일이 정리돼야 한다",
  );
});

test('trap body survives paths with spaces and single quotes (no quote break)', () => {
  const { buildMaterializedEnvBootstrap } = require('../services/remoteSshExecutor');
  const hostile = "/srv/root/.palantir-secret-x y/it's/controller-env";
  const lines = buildMaterializedEnvBootstrap({ KEY_A: hostile });
  const trapLine = lines[0];
  // `trap 'rm -f -- '/a b'' 0` 처럼 이미 인용된 경로를 바깥 작은따옴표에 그대로
  // 끼우면 첫 파싱에서 인용이 깨져 trap 설치 실패·오삭제·명령 주입이 된다.
  // "escape 된 따옴표가 보인다" 는 단언은 vacuous 하다 — 경로 자체에 작은따옴표가
  // 있으면 재인용 없이도 그 문자열이 나타난다. 기대값을 정확히 구성해 비교한다.
  const expected = `trap ${shq(`rm -f -- ${shq(hostile)}`)} 0`;
  assert.equal(trapLine, expected, 'trap 본문 전체가 한 번 더 인용돼야 한다');
});

test('manager spawn cleans materialized files when ssh fails with exit 255 (close, not error)', async () => {
  const cwd = '/srv/root/project';
  const secretPath = '/srv/root/.palantir-secret-manager/controller-env';
  const base = rootAwareSpawn({ cwd, secretPath });
  const removals = [];
  const spawn = (cmd, args, opts) => {
    const script = String(args[args.length - 1]);
    // 중첩 셸이라 따옴표가 escape 된다. 인용 방식에 기대지 않고 내용으로 판별하되,
    // **파일 생성 스크립트를 배제**해야 한다 — writeTempFile 의 스크립트에도
    // `rm -rf -- "$tmpdir"` cleanup 과 파일명이 들어 있어, 그걸 세면 정리를
    // 하지 않아도 통과하는 vacuous 테스트가 된다.
    if (
      script.includes('controller-env')
      && script.includes('rm')
      && !script.includes('env -i')
      && !script.includes('mktemp')
    ) {
      removals.push(script);
    }
    const child = base(cmd, args, opts);
    // 실제 ssh 는 연결·인증·호스트 실패를 'error' 가 아니라 **종료 코드 255** 로
    // 알린다. 'error' 만 처리하면 이 흔한 실패에서 크레덴셜 파일이 pod 에 남는다.
    if (script.includes('cat --') && script.includes('env -i')) {
      setImmediate(() => child.emit('close', 255, null));
    }
    return child;
  };
  spawn.calls = base.calls;
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  await executor.spawnInteractive('codex', ['exec'], {
    cwd,
    envAllowlist: ['KEY_A'],
    env: { KEY_A: 'secret-a' },
  });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && removals.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(removals.length > 0, 'ssh 255 종료에서도 materialized 파일이 정리돼야 한다');
});

test('kill reaps controller env files and fixed artifacts, tolerating a missing status dir', async () => {
  const existingRunId = 'kill-controller-env';
  const missingRunId = 'kill-missing-status';
  const statusDir = `/srv/root/.palantir-runs/${existingRunId}`;
  const canonicalStatusDir = `/real/root/.palantir-runs/${existingRunId}`;
  const scripts = [];
  const spawn = makeSpawn((call, child) => {
    const script = logicalScriptOf(call);
    scripts.push(script);
    if (script === `exec ${shq('realpath')} ${shq('/srv/root')}`) {
      return complete(child, { stdout: '/real/root\n' });
    }
    if (script === `exec ${shq('realpath')} ${shq(statusDir)}`) {
      return complete(child, { stdout: `${canonicalStatusDir}\n` });
    }
    if (script === `exec ${shq('realpath')} ${shq(`/srv/root/.palantir-runs/${missingRunId}`)}`) {
      return complete(child, { code: 1 });
    }
    if (script === `exec ${shq('realpath')} ${shq('/srv/root/.palantir-runs')}`) {
      return complete(child, { stdout: '/real/root/.palantir-runs\n' });
    }
    return complete(child, { code: 0 });
  });
  const executor = createRemoteSshNodeExecutor(nodeRow(), { spawnFn: spawn });

  assert.equal(await executor.kill(existingRunId), true);
  const fixedCleanup = [
    'stdin.txt',
    'system-prompt.txt',
    'worker-capability',
    'worker-api-base',
    'worker-input.bundle',
    'result.jsonl.tmp',
  ].map((name) => shq(`${statusDir}/${name}`)).join(' ');
  assert.ok(
    scripts.includes(`exec 'rm' '-f' ${fixedCleanup}`),
    'kill must retain cleanup of every fixed artifact',
  );
  assert.ok(
    scripts.includes(
      `exec 'find' ${shq(canonicalStatusDir)} '-maxdepth' '1' '-type' 'f' '-name' 'controller-env-*' '-delete'`,
    ),
    'kill must delete dynamic controller env files inside the validated status dir',
  );

  assert.equal(await executor.kill(missingRunId), true);
  assert.equal(
    scripts.some((script) => script.startsWith("exec 'find' ") && script.includes(missingRunId)),
    false,
    'a missing status dir must skip find without changing the return contract',
  );
});
