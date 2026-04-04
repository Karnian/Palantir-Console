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

    // Heartbeat every 30s to keep connection alive
    const heartbeat = setInterval(() => {
      safeWrite(': heartbeat\n\n');
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
