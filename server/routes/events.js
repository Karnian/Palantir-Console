const express = require('express');

function createEventsRouter({ eventBus }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Flush headers immediately so EventSource clients transition to OPEN
    // even before the first event fires. Without this, Node buffers the
    // status line + headers until the first body write, which meant a
    // fresh connection could sit in CONNECTING for up to the 30s heartbeat
    // interval on quiet servers. Also makes integration tests reliable.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // PR3a / ADD-3: send the server_session_id as the very first SSE
    // frame. The client caches this; if it ever sees a DIFFERENT
    // server_session_id (e.g. after a silent reconnect to a restarted
    // server) it does a full reload — its replay cursor is stale
    // because the new process's eventId counter started at 0 and any
    // events from the old process are gone.
    if (eventBus.serverSessionId) {
      safeWrite(`event: server_session\ndata: ${JSON.stringify({ server_session_id: eventBus.serverSessionId })}\n\n`);
    }

    function safeWrite(data) {
      try {
        if (!res.writableEnded) res.write(data);
      } catch {
        // Client disconnected — cleanup will happen via 'close' event
      }
    }

    // IMPORTANT: Subscribe FIRST, then replay — eliminates the gap
    // where events emitted between replay and subscribe would be lost.
    const seenIds = new Set();

    const unsubscribe = eventBus.subscribe((event) => {
      seenIds.add(event.id);
      safeWrite(`id: ${event.id}\nevent: ${event.channel}\ndata: ${JSON.stringify(event.data)}\n\n`);
    });

    // Replay missed events if Last-Event-ID header is present
    const lastEventId = Number(req.headers['last-event-id'] || 0);
    if (lastEventId > 0) {
      const missed = eventBus.replayFrom(lastEventId);
      for (const event of missed) {
        if (!seenIds.has(event.id)) {
          safeWrite(`id: ${event.id}\nevent: ${event.channel}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      }
    }
    seenIds.clear(); // free memory — dedup only needed during replay window

    // Heartbeat every 30s to keep connection alive. Also re-sends the
    // server_session_id as an SSE comment so a client that missed the
    // initial `server_session` event (race on reconnect) still gets it
    // on the next tick without waiting for the next real event.
    const heartbeat = setInterval(() => {
      if (eventBus.serverSessionId) {
        safeWrite(`: heartbeat server_session=${eventBus.serverSessionId}\n\n`);
      } else {
        safeWrite(': heartbeat\n\n');
      }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}

module.exports = { createEventsRouter };
