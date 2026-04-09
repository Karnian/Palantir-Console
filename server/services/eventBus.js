const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

// PR3a / ADD-3: stable per-process id so clients can detect a server
// restart and trigger a full reload (their replay cursor is useless after
// a restart because the new process's eventId counter starts at 0). This
// is emitted via the SSE heartbeat and the initial connect frame, and
// `useSSE` compares it against the last one it saw — mismatch ⇒ reload.
function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

  const serverSessionId = crypto.randomUUID();

  let eventId = 0;
  const replayBuffer = [];
  const MAX_REPLAY = 200;

  function emit(channel, data) {
    eventId++;
    const event = { id: eventId, channel, data, timestamp: new Date().toISOString() };
    replayBuffer.push(event);
    if (replayBuffer.length > MAX_REPLAY) {
      replayBuffer.shift();
    }
    emitter.emit('event', event);
  }

  function subscribe(callback) {
    emitter.on('event', callback);
    return () => emitter.off('event', callback);
  }

  function replayFrom(lastEventId) {
    return replayBuffer.filter(e => e.id > lastEventId);
  }

  return { emit, subscribe, replayFrom, serverSessionId };
}

module.exports = { createEventBus };
