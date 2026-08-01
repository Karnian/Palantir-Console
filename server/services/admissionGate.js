'use strict';

/**
 * Synchronous admission boundary for worker spawns.
 *
 * enter() deliberately does not return a Promise: checking the closed flag and
 * registering the deferred ticket must happen in one JavaScript turn so close()
 * cannot miss an admitted spawn in its in-flight snapshot.
 */
function createAdmissionGate({ startsClosed = false } = {}) {
  let closed = Boolean(startsClosed);
  const inFlight = new Set();

  function enter() {
    if (closed) return null;

    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    let resolved = false;
    const ticket = {
      promise,
      resolve() {
        if (resolved) return;
        resolved = true;
        inFlight.delete(ticket);
        settle();
      },
    };
    inFlight.add(ticket);
    return ticket;
  }

  function close() {
    closed = true;
    return snapshot();
  }

  function open() {
    closed = false;
  }

  function isClosed() {
    return closed;
  }

  function snapshot() {
    return Array.from(inFlight, (ticket) => ticket.promise);
  }

  function inFlightCount() {
    return inFlight.size;
  }

  return {
    enter,
    close,
    open,
    isClosed,
    snapshot,
    inFlightCount,
  };
}

module.exports = { createAdmissionGate };
