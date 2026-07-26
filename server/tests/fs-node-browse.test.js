'use strict';

// task_85d43f96 — node-aware directory browsing for /api/fs.
//
// Covers the local regression (no nodeId ⇒ the control-plane behaviour is
// unchanged), remote browsing inside exposed_roots through the real
// remoteSshExecutor (driven by a fake ssh spawn), and the fail-closed refusals
// plus the specific failure reasons the picker needs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { createFsService } = require('../services/fsService');
const { createFsRouter } = require('../routes/fs');
const { createRemoteSshNodeExecutor, shq } = require('../services/remoteSshExecutor');
const { createLocalNodeExecutor } = require('../services/nodeExecutor');

// ── fake ssh transport ───────────────────────────────────────────────────────

function unshq(value) {
  assert.equal(value[0], "'", `expected a single-quoted token, got ${value}`);
  assert.equal(value[value.length - 1], "'");
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function scriptOf(call) {
  const last = String(call.args[call.args.length - 1]);
  assert.ok(last.startsWith('sh -c '), `expected an ssh sh -c payload, got ${last}`);
  return unshq(last.slice('sh -c '.length));
}

function makeSpawn(handler) {
  const calls = [];
  function spawn(cmd, args) {
    const child = new EventEmitter();
    const call = { cmd, args, child };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    child.kill = () => true;
    calls.push(call);
    handler(call, child);
    return child;
  }
  spawn.calls = calls;
  return spawn;
}

function complete(child, { code = 0, stdout = '', stderr = '' } = {}) {
  process.nextTick(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code, null);
  });
}

/**
 * A tiny remote filesystem the fake ssh transport answers from.
 *   dirs:     canonical dir path → [{ type: 'd'|'f'|'l', name }]
 *   symlinks: literal path → canonical target (what `realpath` returns)
 *   denied:   canonical dir paths whose `find` fails with EACCES
 */
function makeRemoteFs({ dirs = {}, symlinks = {}, denied = [], transportFail = false } = {}) {
  const deniedSet = new Set(denied);
  return makeSpawn((call, child) => {
    if (transportFail) {
      complete(child, { code: 255, stderr: 'ssh: connect to host pod.example port 22: Connection refused' });
      return;
    }
    const script = scriptOf(call);

    const realpathMatch = script.match(/^exec 'realpath' (.+)$/);
    if (realpathMatch) {
      const target = unshq(realpathMatch[1]);
      const resolved = Object.prototype.hasOwnProperty.call(symlinks, target) ? symlinks[target] : target;
      const known = Object.prototype.hasOwnProperty.call(dirs, resolved)
        || Object.values(dirs).some((entries) => entries.some(
          (entry) => path.posix.join(Object.keys(dirs).find((d) => dirs[d] === entries), entry.name) === resolved,
        ));
      if (!known && !Object.prototype.hasOwnProperty.call(symlinks, target)) {
        complete(child, { code: 1, stderr: `realpath: ${target}: No such file or directory\n` });
        return;
      }
      complete(child, { code: 0, stdout: `${resolved}\n` });
      return;
    }

    // listDirectoryEntries wraps `find` in a `[ ! -d ]` guard so a regular file
    // cannot come back as a successful EMPTY listing (a file would otherwise be
    // bindable as a project directory). Answer NOTDIR for any canonical path
    // the fake fs does not know as a directory.
    const findMatch = script.match(/^if \[ ! -d (.+?) \]; then printf 'NOTDIR/);
    if (findMatch) {
      const target = unshq(findMatch[1]);
      if (!Object.prototype.hasOwnProperty.call(dirs, target)) {
        complete(child, { code: 0, stdout: 'NOTDIR\0' });
        return;
      }
      if (deniedSet.has(target)) {
        complete(child, {
          code: 0,
          stdout: 'FINDEXIT:1\0',
          stderr: `find: '${target}': Permission denied\n`,
        });
        return;
      }
      const entries = dirs[target] || [];
      const records = entries.map((entry) => `${entry.type}\t${entry.name}\0`).join('');
      complete(child, { code: 0, stdout: `${records}FINDEXIT:0\0` });
      return;
    }

    complete(child, { code: 127, stderr: `unexpected remote script: ${script}\n` });
  });
}

const SSH_NODE = {
  id: 'pod-a',
  name: 'Pod A',
  kind: 'ssh',
  ssh_host: 'pod.example',
  ssh_user: 'runner',
  exposed_roots: JSON.stringify(['/srv/root']),
  can_execute: 1,
  files_only: 0,
  updated_at: '2026-07-23 00:00:00',
};

function makeNodeService({ node = SSH_NODE, spawnFn, pickExecutorError = null, getNodeError = null } = {}) {
  return {
    getNode(id) {
      // A non-404 failure stands in for a control-plane outage (closed/corrupt
      // SQLite handle), which must NOT be reported as a missing node.
      if (getNodeError) throw getNodeError;
      if (id !== node.id) {
        const err = new Error(`Node not found: ${id}`);
        err.status = 404;
        throw err;
      }
      return node;
    },
    pickExecutor() {
      if (pickExecutorError) throw pickExecutorError;
      return createRemoteSshNodeExecutor(node, { spawnFn });
    },
  };
}

function makeApp(fsService) {
  return createFsRouter({ fsService });
}

// Exercise the real Express route handler without opening a TCP listener.
// This keeps the focused suite hermetic (and avoids colliding with the user's
// :4177 server) while still verifying query parsing plus HTTP status/body.
function request(router) {
  const layer = router.stack.find((candidate) => candidate.route?.path === '/');
  const handler = layer?.route?.stack?.[0]?.handle;
  assert.equal(typeof handler, 'function', 'expected the /api/fs GET handler');
  return {
    get(url) {
      const parsed = new URL(url, 'http://palantir.test');
      const query = Object.fromEntries(parsed.searchParams.entries());
      return new Promise((resolve, reject) => {
        const response = {
          statusCode: 200,
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(body) {
            resolve({ status: this.statusCode, body });
            return this;
          },
        };
        handler({ query }, response, reject);
      });
    },
  };
}

function remoteApp(remoteFsOptions, { node = SSH_NODE, pickExecutorError = null, getNodeError = null } = {}) {
  const spawnFn = makeRemoteFs(remoteFsOptions);
  const nodeService = makeNodeService({ node, spawnFn, pickExecutorError, getNodeError });
  const fsService = createFsService({ fsRoot: '/control/plane/root' }, {
    nodeExecutor: createLocalNodeExecutor(),
    nodeService,
  });
  return { app: makeApp(fsService), spawnFn };
}

const DEFAULT_REMOTE_FS = {
  dirs: {
    '/srv/root': [
      { type: 'd', name: 'proj-b' },
      { type: 'd', name: 'proj-a' },
      { type: 'd', name: '.cache' },
      { type: 'f', name: 'README.md' },
      { type: 'l', name: 'escape-link' },
    ],
    '/srv/root/proj-a': [{ type: 'd', name: 'src' }],
  },
};

// ── local browsing (regression) ──────────────────────────────────────────────

async function makeLocalApp(t) {
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fsbrowse-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-outside-'));
  t.after(async () => {
    await fs.rm(fsRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(fsRoot, 'projects'));
  await fs.mkdir(path.join(fsRoot, '.hidden'));
  await fs.writeFile(path.join(fsRoot, 'file.txt'), 'x');
  const fsService = createFsService({ fsRoot }, { nodeExecutor: createLocalNodeExecutor() });
  return { app: makeApp(fsService), fsRoot, outside };
}

test('local browsing without nodeId is unchanged (root, directories, hidden filter)', async (t) => {
  const { app, fsRoot } = await makeLocalApp(t);

  const res = await request(app).get('/api/fs');
  assert.equal(res.status, 200);
  assert.equal(res.body.root, fsRoot);
  assert.equal(res.body.path, fsRoot);
  assert.deepEqual(res.body.directories.map((d) => d.name), ['projects']);
  assert.equal(res.body.node_id, 'local');

  const hidden = await request(app).get('/api/fs?showHidden=1');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body.directories.map((d) => d.name), ['.hidden', 'projects']);
});

test('local browsing with nodeId=local takes the same path as no nodeId', async (t) => {
  const { app, fsRoot } = await makeLocalApp(t);
  const res = await request(app).get('/api/fs?nodeId=local');
  assert.equal(res.status, 200);
  assert.equal(res.body.root, fsRoot);
  assert.equal(res.body.node_id, 'local');
});

test('local browsing refuses a path outside fsRoot', async (t) => {
  const { app } = await makeLocalApp(t);
  const res = await request(app).get('/api/fs?path=/');
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'Path not allowed');
  assert.equal(res.body.reason, 'path_outside_root');
});

test('local browsing refuses a symlink that escapes fsRoot', async (t) => {
  const { app, fsRoot, outside } = await makeLocalApp(t);
  await fs.mkdir(path.join(outside, 'secret'));
  const link = path.join(fsRoot, 'escape');
  await fs.symlink(outside, link);

  const res = await request(app).get(`/api/fs?path=${encodeURIComponent(link)}`);
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'symlink_escape');
});

test('local browsing reports a missing path as path_not_found', async (t) => {
  const { app, fsRoot } = await makeLocalApp(t);
  const res = await request(app).get(`/api/fs?path=${encodeURIComponent(path.join(fsRoot, 'nope'))}`);
  assert.equal(res.status, 404);
  assert.equal(res.body.reason, 'path_not_found');
});

// ── remote browsing ──────────────────────────────────────────────────────────

test('remote browsing lists real directories under the first exposed root', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS);
  const res = await request(app).get('/api/fs?nodeId=pod-a');

  assert.equal(res.status, 200);
  assert.equal(res.body.node_id, 'pod-a');
  assert.equal(res.body.node_kind, 'ssh');
  assert.equal(res.body.path, '/srv/root');
  assert.equal(res.body.root, '/srv/root');
  // Sorted, dot-entry filtered, and — critically — the regular file and the
  // symlink are NOT offered as browsable children.
  assert.deepEqual(res.body.directories, [
    { name: 'proj-a', path: '/srv/root/proj-a' },
    { name: 'proj-b', path: '/srv/root/proj-b' },
  ]);
  assert.equal(res.body.truncated, false);
});

test('remote browsing honours showHidden and navigates into subdirectories', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS);

  const hidden = await request(app).get('/api/fs?nodeId=pod-a&showHidden=1');
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.body.directories.map((d) => d.name), ['.cache', 'proj-a', 'proj-b']);

  const nested = await request(app).get('/api/fs?nodeId=pod-a&path=/srv/root/proj-a');
  assert.equal(nested.status, 200);
  assert.equal(nested.body.path, '/srv/root/proj-a');
  assert.deepEqual(nested.body.directories, [{ name: 'src', path: '/srv/root/proj-a/src' }]);
});

test('remote browsing refuses a path outside exposed_roots', async () => {
  const { app } = remoteApp({
    dirs: { ...DEFAULT_REMOTE_FS.dirs, '/etc': [{ type: 'd', name: 'ssh' }] },
  });
  const res = await request(app).get('/api/fs?nodeId=pod-a&path=/etc');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'path_outside_root');
});

test('remote browsing refuses a symlink that escapes exposed_roots', async () => {
  // The literal path is inside /srv/root; realpath resolves it to /etc.
  const { app } = remoteApp({
    dirs: { ...DEFAULT_REMOTE_FS.dirs, '/etc': [{ type: 'd', name: 'ssh' }] },
    symlinks: { '/srv/root/escape-link': '/etc' },
  });
  const res = await request(app).get('/api/fs?nodeId=pod-a&path=/srv/root/escape-link');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'symlink_escape');
});

test('remote directory listing uses the node custom ssh_port', async () => {
  const node = { ...SSH_NODE, ssh_port: 2222 };
  const { app, spawnFn } = remoteApp(DEFAULT_REMOTE_FS, { node });
  const res = await request(app).get('/api/fs?nodeId=pod-a');

  assert.equal(res.status, 200);
  assert.ok(spawnFn.calls.length >= 3, 'expected root/target realpath plus directory listing calls');
  for (const call of spawnFn.calls) {
    const portIndex = call.args.indexOf('-p');
    assert.ok(portIndex >= 0, `missing -p in ${JSON.stringify(call.args)}`);
    assert.equal(call.args[portIndex + 1], '2222');
    assert.ok(portIndex < call.args.indexOf('--'), 'the port option must precede the ssh option terminator');
  }
});

test('remote browsing refuses a relative or option-looking path before any ssh call', async () => {
  const { app, spawnFn } = remoteApp(DEFAULT_REMOTE_FS);

  for (const bad of ['--upload-pack=evil', 'srv/root', '-rf']) {
    const res = await request(app).get(`/api/fs?nodeId=pod-a&path=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 403, `expected ${bad} to be refused`);
    assert.equal(res.body.reason, 'path_outside_root');
  }
  assert.equal(spawnFn.calls.length, 0, 'a non-absolute path must never reach the transport');
});

test('remote browsing passes the path as a quoted argv token, not interpolated shell', async () => {
  const evil = "/srv/root/a'; touch /tmp/pwned; '";
  const { app, spawnFn } = remoteApp({
    dirs: { ...DEFAULT_REMOTE_FS.dirs, [evil]: [] },
  });
  const res = await request(app).get(`/api/fs?nodeId=pod-a&path=${encodeURIComponent(evil)}`);
  assert.equal(res.status, 200);
  // The remote shell parsed the payload back into the EXACT literal path, so
  // the embedded quote never terminated the quoting and `touch` never became a
  // command word. Every script must also carry the shq()-escaped form verbatim.
  assert.equal(res.body.path, evil);
  const scripts = spawnFn.calls.map(scriptOf);
  assert.ok(
    scripts.some((script) => script.includes(shq(evil))),
    `no script carried the shq-escaped path: ${JSON.stringify(scripts)}`,
  );
  for (const script of scripts) {
    assert.ok(!script.includes("a'; touch"), `unescaped injection in: ${script}`);
  }
});

test('remote browsing maps a missing path to path_not_found', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS);
  const res = await request(app).get('/api/fs?nodeId=pod-a&path=/srv/root/missing');
  assert.equal(res.status, 404);
  assert.equal(res.body.reason, 'path_not_found');
});

test('remote browsing maps an unreadable directory to permission_denied', async () => {
  const { app } = remoteApp({
    dirs: { ...DEFAULT_REMOTE_FS.dirs, '/srv/root/locked': [] },
    denied: ['/srv/root/locked'],
  });
  const res = await request(app).get('/api/fs?nodeId=pod-a&path=/srv/root/locked');
  assert.equal(res.status, 403);
  assert.equal(res.body.reason, 'permission_denied');
});

test('remote browsing maps ssh transport failure to node_unreachable', async () => {
  const { app } = remoteApp({ ...DEFAULT_REMOTE_FS, transportFail: true });
  const res = await request(app).get('/api/fs?nodeId=pod-a');
  assert.equal(res.status, 502);
  assert.equal(res.body.reason, 'node_unreachable');
  assert.equal(res.body.error, 'Execution node is unreachable');
});

test('remote browsing reports an unknown node as node_not_found', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS);
  const res = await request(app).get('/api/fs?nodeId=ghost');
  assert.equal(res.status, 404);
  assert.equal(res.body.reason, 'node_not_found');
});

// `find <regular file> -mindepth 1` exits 0 and prints NOTHING, so without the
// NOTDIR guard a file answered as a successful empty listing. The node-change
// validator reads a 2xx as "valid on this node" and the save-time binding check
// only tests existence — a project directory could be rebound to a file and
// fail much later when used as a working directory.
test('remote browsing refuses a non-directory target as path_not_directory', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS);
  const res = await request(app).get('/api/fs?nodeId=pod-a&path=/srv/root/README.md');
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'path_not_directory');
  assert.notEqual(res.status, 200, 'a file must never answer as a browsable directory');
});

// A blanket catch around getNode() would rewrite a control-plane outage as a
// 404 "you picked a bad node", hiding a real incident. Only the expected
// missing-row (404) case is translated.
test('remote browsing does not disguise an unexpected node lookup failure as node_not_found', async () => {
  const boom = new Error('SQLITE_MISUSE: Database handle is closed');
  const { app } = remoteApp(DEFAULT_REMOTE_FS, { getNodeError: boom });
  const res = await request(app).get('/api/fs?nodeId=pod-a');
  assert.equal(res.status, 500);
  assert.notEqual(res.body.reason, 'node_not_found');
  assert.equal(res.body.reason, 'browse_failed');
});

test('remote browsing reports a node that cannot host execution as node_not_browsable', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS, {
    pickExecutorError: new Error('Node pod-a cannot host execution'),
  });
  const res = await request(app).get('/api/fs?nodeId=pod-a');
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'node_not_browsable');
});

test('remote browsing reports a node without exposed_roots as node_not_browsable', async () => {
  const { app } = remoteApp(DEFAULT_REMOTE_FS, {
    node: { ...SSH_NODE, exposed_roots: null },
  });
  const res = await request(app).get('/api/fs?nodeId=pod-a');
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'node_not_browsable');
});

test('browsing without a nodeService still serves the control plane', async (t) => {
  const fsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'palantir-fsbrowse-'));
  t.after(() => fs.rm(fsRoot, { recursive: true, force: true }));
  const fsService = createFsService({ fsRoot }, { nodeExecutor: createLocalNodeExecutor() });
  const app = makeApp(fsService);

  assert.equal((await request(app).get('/api/fs')).status, 200);
  const remote = await request(app).get('/api/fs?nodeId=pod-a');
  assert.equal(remote.status, 501);
  assert.equal(remote.body.reason, 'node_not_browsable');
});
