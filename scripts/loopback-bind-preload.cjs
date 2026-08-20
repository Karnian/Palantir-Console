'use strict';

// Test-only preload: pin a hostless ephemeral bind to loopback.
//
// WHY
// supertest binds its per-request server with `app.listen(0)`
// (supertest/lib/test.js:63) — no host, so Node binds the wildcard address
// (`::`, dual-stack) on a kernel-chosen ephemeral port. On macOS/BSD,
// SO_REUSEADDR lets that coexist with an existing `127.0.0.1:P` owned by an
// unrelated process, and the kernel delivers an incoming `127.0.0.1:P`
// connection to the MOST SPECIFIC listening socket — the other process. The
// request never reaches the app under test.
//
// Measured on the dev machine, all inside the ephemeral range: Tailscale's
// IPNExtension (127.0.0.1:52785), a VS Code helper (52593), Orca (60989). A
// supertest request that draws one of those ports comes back as
// `401 auth required` (Tailscale answers exactly that, with `tailscale-version`
// response headers) or as ECONNRESET, attributed to whichever test happened to
// draw the port. That is the shape of the long-standing "race-y flake": rare,
// never the same test twice, always green when the file runs alone.
//
// Binding to 127.0.0.1 makes the kernel choose a port that is free FOR THAT
// ADDRESS, so the collision cannot happen. Tests only ever talk to loopback.
//
// WHY THE INTERNAL CALL
// The obvious fix — `listen(0, '127.0.0.1')` — does not work here. Naming a
// host routes Node through `lookupAndListen()`, which defers the bind to a DNS
// callback (asynchronous even for an IP literal, and `options.lookup` is not
// honored by `listen`). supertest reads `app.address().port` SYNCHRONOUSLY in
// its constructor, so a deferred bind makes `address()` null and every request
// dies with "Cannot read properties of null (reading 'port')".
// `_setupListenHandle` is the same function `listenInCluster` calls once the
// lookup resolves; invoking it directly binds synchronously, which is exactly
// what the hostless path already does today.
//
// If a future Node removes or changes it, this falls back to the stock
// behaviour — and server/tests/loopback-bind-guard.test.js fails loudly rather
// than letting the flake return silently.

const net = require('node:net');
const cluster = require('node:cluster');

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  const [first, second] = args;
  // Only the hostless shapes supertest and the tests use: listen(0) and
  // listen(0, cb). Anything naming a host or passing options is left exactly as
  // written, so tests that assert on binding policy still assert on the real
  // thing.
  const hostless = first === 0 && (args.length === 1 || typeof second === 'function');
  const setup = this._setupListenHandle || this._listen2;

  if (hostless && !this._handle && cluster.isPrimary && typeof setup === 'function') {
    try {
      // Mirror Server.prototype.listen: the callback subscribes to 'listening'
      // before the handle is set up. _setupListenHandle emits it on nextTick.
      if (typeof second === 'function') this.once('listening', second);
      setup.call(this, '127.0.0.1', 0, 4, undefined, undefined, undefined);
      if (this.address()) return this;
      if (typeof second === 'function') this.removeListener('listening', second);
    } catch {
      if (typeof second === 'function') this.removeListener('listening', second);
    }
  }

  return originalListen.apply(this, args);
};
