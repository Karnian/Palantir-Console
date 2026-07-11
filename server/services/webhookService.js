'use strict';

const http = require('node:http');
const https = require('node:https');

const { assertSafeUrl } = require('./ssrf');

const WEBHOOK_TIMEOUT_MS = 5000;
const WEBHOOK_TEXT_CAP = 200;

function cap(value) {
  // Absent fields stay null in the payload rather than the literal
  // string "undefined"/"null" reaching the external webhook.
  if (value == null) return null;
  return String(value).slice(0, WEBHOOK_TEXT_CAP);
}

function buildPayload(event, now) {
  const data = event.data || {};
  const run = data.run || {};
  const kind = event.channel === 'run:needs_input' ? 'needs_input' : 'failed';
  return {
    event: kind,
    run_id: data.runId ?? run.id,
    task_id: data.task_id ?? run.task_id ?? null,
    project_id: data.project_id ?? run.project_id ?? null,
    node_id: data.node_id ?? run.node_id ?? null,
    status: data.to_status ?? run.status ?? kind,
    reason: cap(data.reason),
    agent: cap(run.agent_name || run.agent_profile_id),
    server_ts: now(),
  };
}

// G3: a goal outbox effect (goal:exhausted | goal:error). The payload is emitted
// by the verdict reconciler and carries a STABLE idempotency_key so a receiver
// deduplicates across at-least-once re-drives (reboot / crash before 'sent').
function buildGoalPayload(event, now) {
  const data = event.data || {};
  const kind = event.channel === 'goal:error' ? 'goal_error' : 'goal_exhausted';
  return {
    event: kind,
    run_id: data.run_id ?? null,
    task_id: data.task_id ?? null,
    project_id: data.project_id ?? null,
    node_id: data.node_id ?? null,
    status: cap(data.verdict),
    reason: cap(data.reason),
    attempt: Number.isFinite(Number(data.attempt)) ? Number(data.attempt) : null,
    idempotency_key: cap(data.idempotency_key) ?? `${data.run_id}:${event.channel}`,
    server_ts: now(),
  };
}

function normalizePostResult(result) {
  if (!result) return { ok: true, status: 200 };
  if (result.ok === true) return { ok: true, status: result.status };
  if (typeof result.status === 'number' && result.status >= 200 && result.status < 300) {
    return { ok: true, status: result.status };
  }
  return {
    ok: false,
    reason: result.reason || 'webhook_error',
    status: result.status,
    message: result.message,
  };
}

function issuePostRequest({
  urlStr,
  hostname,
  ip,
  family,
  port,
  body,
  headers,
  timeoutMs = WEBHOOK_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      resolve({ ok: false, reason: 'invalid_url' });
      return;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const reqOpts = {
      method: 'POST',
      host: hostname,
      port: Number(port) || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers,
      timeout: timeoutMs,
      lookup: (_host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    };
    if (isHttps) reqOpts.servername = hostname;

    let req;
    try {
      req = transport.request(reqOpts, (res) => {
        res.resume();
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          settle({ ok: false, reason: 'redirect_blocked', status, ip });
          return;
        }
        if (status >= 200 && status < 300) {
          settle({ ok: true, status });
          return;
        }
        if (status >= 400 && status < 500) {
          settle({ ok: false, reason: 'webhook_4xx', status, ip });
          return;
        }
        if (status >= 500) {
          settle({ ok: false, reason: 'webhook_5xx', status, ip });
          return;
        }
        settle({ ok: false, reason: 'webhook_http_status', status, ip });
      });
    } catch (err) {
      settle({ ok: false, reason: 'network_error', message: err.message, ip });
      return;
    }

    req.on('timeout', () => {
      req.destroy();
      settle({ ok: false, reason: 'timeout', ip });
    });
    req.on('error', (err) => {
      const code = err && err.code;
      if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        settle({ ok: false, reason: 'timeout', ip });
      } else if (code === 'ECONNREFUSED') {
        settle({ ok: false, reason: 'connect_refused', ip });
      } else {
        settle({ ok: false, reason: 'network_error', message: err.message, ip, errCode: code || null });
      }
    });
    req.write(body);
    req.end();
  });
}

function createWebhookService({
  eventBus,
  runService,
  webhookUrl,
  allowPrivate = false,
  postImpl,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  if (!webhookUrl) {
    return { stop() {} };
  }
  if (!eventBus || typeof eventBus.subscribe !== 'function') {
    return { stop() {} };
  }

  const issue = typeof postImpl === 'function' ? postImpl : issuePostRequest;
  let warnedHttp = false;
  let stopped = false;

  function warn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(message);
    } catch { /* ignore logger failures */ }
  }

  function addRunEvent(runId, eventType, payload) {
    if (!runService || typeof runService.addRunEvent !== 'function' || !runId) return;
    try {
      runService.addRunEvent(runId, eventType, JSON.stringify(payload));
    } catch { /* DELETE race or closed DB must not affect run flow */ }
  }

  function recordSent(payload, result) {
    addRunEvent(payload.run_id, 'webhook:sent', {
      event: payload.event,
      status: result.status ?? null,
    });
  }

  function recordError(payload, error) {
    addRunEvent(payload.run_id, 'webhook:error', {
      event: payload.event,
      reason: error.reason || 'webhook_error',
      ...(error.status != null ? { status: error.status } : {}),
      ...(error.message ? { message: cap(error.message) } : {}),
    });
    warn(`[webhook] ${payload.event} notification failed for run=${payload.run_id}: ${error.reason || 'webhook_error'}`);
  }

  async function send(payload) {
    try {
      let resolved;
      try {
        resolved = await assertSafeUrl(webhookUrl, { allowPrivate });
      } catch (err) {
        recordError(payload, {
          reason: 'ssrf_blocked',
          message: err && err.message,
        });
        return;
      }

      const url = new URL(resolved.url);
      if (url.protocol === 'http:' && !warnedHttp) {
        warnedHttp = true;
        warn('[webhook] PALANTIR_WEBHOOK_URL is http:, not https:; sending without transport encryption');
      }

      const body = JSON.stringify(payload);
      const headers = {
        Host: resolved.hostname,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'PalantirConsole-Webhook/1.0',
      };

      let postResult;
      try {
        postResult = await issue({
          urlStr: resolved.url,
          hostname: resolved.hostname,
          ip: resolved.ip,
          family: resolved.family,
          port: resolved.port,
          body,
          payload,
          headers,
          timeoutMs: WEBHOOK_TIMEOUT_MS,
        });
      } catch (err) {
        postResult = {
          ok: false,
          reason: 'network_error',
          message: err && err.message,
        };
      }

      const result = normalizePostResult(postResult);
      if (result.ok) {
        recordSent(payload, result);
        return;
      }
      recordError(payload, result);
    } catch (err) {
      recordError(payload, {
        reason: 'webhook_error',
        message: err && err.message,
      });
    }
  }

  const unsubscribe = eventBus.subscribe((event) => {
    try {
      if (stopped) return;
      // G3: goal terminal outcomes notify via their dedicated outbox effects
      // (idempotency-keyed, exactly-once-effect), NOT via the generic
      // run:ended(failed) path — else a mid-retry attempt failure would fire a
      // premature "failed" webhook. These carry no `run` object (payload is the
      // whitelisted effect fields).
      if (event.channel === 'goal:exhausted' || event.channel === 'goal:error') {
        if (!event.data || !event.data.run_id) return;
        void send(buildGoalPayload(event, now)).catch(() => {});
        return;
      }
      if (event.channel !== 'run:needs_input' && event.channel !== 'run:ended') return;
      if (event.channel === 'run:ended' && event.data?.to_status !== 'failed') return;
      const run = event.data?.run;
      if (!run || run.is_manager) return;
      // A goal-active run's failure is a verdict-loop concern (retry/exhausted/
      // error) — suppress the generic failed webhook; goal:exhausted/goal:error
      // carry the terminal notification instead.
      if (run.goal_active) return;
      void send(buildPayload(event, now)).catch(() => {});
    } catch (err) {
      warn(`[webhook] subscriber failed: ${err && err.message}`);
    }
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch { /* ignore */ }
    },
  };
}

module.exports = {
  createWebhookService,
  issuePostRequest,
  _buildPayload: buildPayload,
  _buildGoalPayload: buildGoalPayload,
  _cap: cap,
  WEBHOOK_TIMEOUT_MS,
};
