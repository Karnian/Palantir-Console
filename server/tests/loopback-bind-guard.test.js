const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

// Guards the fix for the long-standing "race-y flake": a supertest request
// silently answered by an unrelated local process instead of the app under
// test. See scripts/loopback-bind-preload.cjs for the full mechanism.
//
// Requiring the preload here (rather than depending on `npm test` having passed
// --require) keeps this file meaningful when run directly with `node --test`,
// which is how the repo docs run single files. Under `npm test` the same
// resolved path is already in the module cache, so the patch is applied once.
require('../../scripts/loopback-bind-preload.cjs');

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...args, () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('hostless listen(0) binds loopback, not a wildcard address', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  t.after(() => close(server));
  await listen(server, 0);
  const addr = server.address();
  // The unpatched default is '::' (IPv6 any, dual-stack) — which is exactly
  // what lets an unrelated 127.0.0.1 listener steal our connections.
  assert.equal(addr.address, '127.0.0.1');
});

test('an explicit host is left alone', async (t) => {
  const server = http.createServer((_req, res) => res.end('ok'));
  t.after(() => close(server));
  await listen(server, 0, '0.0.0.0');
  assert.equal(server.address().address, '0.0.0.0');
});

test('a wildcard ephemeral bind is genuinely unsafe — the specific listener wins', async (t) => {
  // Deterministic demonstration of WHY the patch exists, rather than a
  // statistical argument from repeated runs.
  const squatter = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('auth required');
  });
  t.after(() => close(squatter));
  await listen(squatter, 0, '127.0.0.1');
  const port = squatter.address().port;

  const wildcard = http.createServer((_req, res) => res.end('app'));
  let bound = false;
  try {
    await listen(wildcard, port, '0.0.0.0');
    bound = true;
  } catch (err) {
    // Linux refuses the overlapping bind outright, which is the other safe
    // outcome: the collision cannot happen there. Either way a wildcard
    // ephemeral bind is not something a test server should be doing.
    assert.equal(err.code, 'EADDRINUSE');
  }
  t.after(() => (bound ? close(wildcard) : null));

  if (bound) {
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, out }));
      }).on('error', reject);
    });
    // The wildcard server is bound and listening, yet receives nothing: the
    // kernel delivers to the more specific socket.
    assert.equal(body.status, 401);
    assert.equal(body.out, 'auth required');
  }
});

test('the runner actually preloads the patch', () => {
  // Without this wiring the module above is dead code and supertest keeps
  // binding wildcard.
  const runner = fs.readFileSync(
    path.join(__dirname, '..', '..', 'scripts', 'run-tests.mjs'),
    'utf8',
  );
  // Strip line comments first: the block above the wiring names the preload
  // file, so matching raw text would keep passing after the wiring itself was
  // deleted. Assert the argv shape, not a mention of it.
  const wiring = runner.replace(/^\s*\/\/.*$/gm, '');
  assert.match(wiring, /'--require',\s*preload\b/);
  assert.match(wiring, /loopback-bind-preload\.cjs/);
});

test('patching preserves the net.Server.listen contract', async (t) => {
  // listen(port, backlog) and listen(options) must not be rewritten.
  const server = net.createServer();
  t.after(() => close(server));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, resolve);
  });
  assert.equal(server.address().address, '0.0.0.0');
});
