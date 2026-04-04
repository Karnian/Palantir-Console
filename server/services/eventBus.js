const { EventEmitter } = require('node:events');

function createEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);

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

  return { emit, subscribe, replayFrom };
}

module.exports = { createEventBus };
