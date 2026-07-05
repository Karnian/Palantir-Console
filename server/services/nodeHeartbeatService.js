function createNodeHeartbeatService({
  nodeService,
  intervalMs = 30000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onNodeRecovered,
  onReachableFlip,
}) {
  let timer = null;
  let running = false;
  const probeTimeoutMs = Math.max(1000, Math.min(intervalMs, 15000));

  function invokeHook(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      const maybePromise = fn(arg);
      if (maybePromise && typeof maybePromise.catch === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // Heartbeat hooks are advisory; probing must stay best-effort.
    }
  }

  async function runOnce() {
    if (running) return;
    running = true;
    try {
      const nodes = nodeService.listNodes();
      for (const node of nodes) {
        try {
          if (!node || node.kind !== 'ssh') continue;

          let executor;
          try {
            executor = nodeService.pickExecutor(node.id);
          } catch {
            continue;
          }

          try {
            // Probe with an ALLOWLISTED command. The remote executor's public
            // exec allowlist is ['git'] (P2 security fix), so `exec('true')`
            // would reject with COMMAND_NOT_ALLOWED and every ssh node would be
            // marked unreachable. `git --version` is allowlisted, cheap, needs
            // no repo, and doubles as a "pod has git" check (workers require
            // git). Confirmed on a real Raspberry Pi: 'true' → COMMAND_NOT_ALLOWED,
            // 'git --version' → exit 0.
            const res = await executor.exec('git', ['--version'], { timeoutMs: probeTimeoutMs });
            // NodeExecutor.exec RESOLVES on any genuine process exit — nonzero
            // included (only SSH transport 255 / spawn errors reject). So a pod
            // without git returns code 127 as a RESOLVED value; we must inspect
            // res.code, not merely "it didn't throw", or we'd mark such a node
            // reachable (Codex P3b review catch).
            if (!res || res.code !== 0) {
              throw new Error(`heartbeat probe (git --version) exited ${res && res.code}`);
            }
            const recovered = Number(node.reachable) !== 1;
            await nodeService.touchHeartbeat(node.id);
            if (recovered) {
              invokeHook(onReachableFlip, { nodeId: node.id, from: 0, to: 1 });
              invokeHook(onNodeRecovered, node.id);
            }
          } catch {
            const wasReachable = Number(node.reachable) === 1;
            try { await nodeService.setReachable(node.id, false); } catch { /* swallow */ }
            if (wasReachable) {
              invokeHook(onReachableFlip, { nodeId: node.id, from: 1, to: 0 });
            }
          }
        } catch {
          // Keep probing the remaining nodes even if one row is malformed.
        }
      }
    } catch {
      // The heartbeat loop is best-effort and must never reject.
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setIntervalFn(runOnce, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = { createNodeHeartbeatService };
