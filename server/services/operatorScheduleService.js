'use strict';

const crypto = require('node:crypto');
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} = require('../utils/errors');
const {
  MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
  normalizeTerminalError,
  findPersistedTerminalEvent,
} = require('./terminalEventReconciliation');
const { validateSpec, canonicalSpecHash } = require('./verifyCheckService');

const ACTIVE_INVOCATION_STATUSES = new Set(['pending', 'claimed', 'delivering', 'running']);
const TERMINAL_INVOCATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_TIMEZONE = 'UTC';
const MISFIRE_POLICIES = new Set(['coalesce_latest', 'skip']);
const MAX_PROMPT_LENGTH = 12000;
const MIN_EXPIRY_AGE_MS = 24 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;
const RUNNING_RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;
const PRECHECK_DEADLINE_MS = 15 * 60 * 1000;
const PRECHECK_RETRY_BASE_MS = 60 * 1000;
const PRECHECK_RETRY_CAP_MS = 15 * 60 * 1000;
const PRECHECK_RETRY_JITTER_RATIO = 0.2;

function retryDelayMs(attempts, random = Math.random) {
  const exponent = Math.max(0, Math.min(30, Number(attempts || 1) - 1));
  const nominal = Math.min(PRECHECK_RETRY_CAP_MS, PRECHECK_RETRY_BASE_MS * (2 ** exponent));
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  const jittered = nominal * (
    1 - PRECHECK_RETRY_JITTER_RATIO + (2 * PRECHECK_RETRY_JITTER_RATIO * sample)
  );
  return Math.min(PRECHECK_RETRY_CAP_MS, Math.round(jittered));
}

function nonEmptyString(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`${name} is required`);
  }
  const trimmed = value.trim();
  if (maxLength && trimmed.length > maxLength) {
    throw new BadRequestError(`${name} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

function normalizeTimezone(value) {
  const timezone = value == null || value === '' ? DEFAULT_TIMEZONE : nonEmptyString(value, 'timezone', 100);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new BadRequestError(`Invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function normalizeAt(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new BadRequestError('rule.at must be HH:mm');
  }
  return value;
}

function normalizeEnabled(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new BadRequestError('enabled must be boolean or 0|1');
}

function normalizeGraceSeconds(value, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestError('grace_seconds must be a non-negative integer or null');
  }
  return value;
}

function normalizeMisfirePolicy(value, fallback = 'coalesce_latest') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !MISFIRE_POLICIES.has(value)) {
    throw new BadRequestError('misfire_policy must be one of coalesce_latest|skip');
  }
  return value;
}

function normalizeRule(input) {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new BadRequestError('rule must be valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('rule must be an object');
  }
  const kind = value.kind;
  if (kind === 'once') {
    const at = nonEmptyString(value.at, 'rule.at', 80);
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new BadRequestError('rule.at must be an ISO timestamp');
    return { kind, at: date.toISOString() };
  }
  if (kind === 'interval') {
    const minutes = Number(value.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      throw new BadRequestError(`rule.minutes must be an integer between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`);
    }
    return { kind, minutes };
  }
  if (kind === 'daily' || kind === 'weekdays') {
    return { kind, at: normalizeAt(value.at) };
  }
  if (kind === 'weekly') {
    const weekday = Number(value.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new BadRequestError('rule.weekday must be an integer between 1 (Monday) and 7 (Sunday)');
    }
    return { kind, weekday, at: normalizeAt(value.at) };
  }
  throw new BadRequestError('rule.kind must be one of once|interval|daily|weekdays|weekly');
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

function localDatePlusDays(parts, days) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function sameWallMinute(actual, target) {
  return actual.year === target.year
    && actual.month === target.month
    && actual.day === target.day
    && actual.hour === target.hour
    && actual.minute === target.minute;
}

function timezoneOffsetMinutes(date, timezone) {
  const actual = zonedParts(date, timezone);
  const represented = Date.UTC(
    actual.year,
    actual.month - 1,
    actual.day,
    actual.hour,
    actual.minute,
    actual.second || 0,
  );
  return Math.round((represented - date.getTime()) / 60000);
}

// Convert an IANA-zone wall clock to UTC. Sampling nearby offsets finds both
// sides of DST transitions. Ambiguous fall-back times choose the first
// occurrence (one fire per local date). For a spring-forward gap, choose the
// first representable wall minute after the requested time on that date.
function wallClockToUtc(parts, timezone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  const offsets = new Set();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(timezoneOffsetMinutes(new Date(target + hours * 60 * 60 * 1000), timezone));
  }
  const exact = [];
  for (const offset of offsets) {
    const candidate = new Date(target - offset * 60 * 1000);
    if (sameWallMinute(zonedParts(candidate, timezone), parts)) exact.push(candidate);
  }
  if (exact.length > 0) {
    exact.sort((a, b) => a.getTime() - b.getTime());
    return exact[0];
  }

  // Gap path only (normally 60 minutes once per year): bounded minute search
  // avoids guessing an offset and accidentally firing before the requested
  // wall time.
  const targetWallMinute = parts.hour * 60 + parts.minute;
  let fallback = null;
  let fallbackWallMinute = Infinity;
  for (let delta = -15 * 60; delta <= 15 * 60; delta += 1) {
    const candidate = new Date(target + delta * 60 * 1000);
    const actual = zonedParts(candidate, timezone);
    if (actual.year !== parts.year || actual.month !== parts.month || actual.day !== parts.day) continue;
    const actualWallMinute = actual.hour * 60 + actual.minute;
    if (actualWallMinute <= targetWallMinute || actualWallMinute > fallbackWallMinute) continue;
    if (actualWallMinute < fallbackWallMinute || !fallback || candidate < fallback) {
      fallback = candidate;
      fallbackWallMinute = actualWallMinute;
    }
  }
  return fallback;
}

function nextFireForRule(ruleInput, timezoneInput, afterInput = new Date()) {
  const rule = normalizeRule(ruleInput);
  const timezone = normalizeTimezone(timezoneInput);
  const after = afterInput instanceof Date ? afterInput : new Date(afterInput);
  if (!Number.isFinite(after.getTime())) throw new BadRequestError('after must be a valid timestamp');

  if (rule.kind === 'once') {
    const at = new Date(rule.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  if (rule.kind === 'interval') {
    return new Date(after.getTime() + rule.minutes * 60 * 1000);
  }

  const [hour, minute] = rule.at.split(':').map(Number);
  const base = zonedParts(after, timezone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = localDatePlusDays(base, offset);
    const weekday = ((new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7) + 1;
    if (rule.kind === 'weekdays' && weekday > 5) continue;
    if (rule.kind === 'weekly' && weekday !== rule.weekday) continue;
    const candidate = wallClockToUtc({ ...date, hour, minute }, timezone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error(`unable to calculate next fire for ${rule.kind}`);
}

function parseSchedule(row) {
  if (!row) return null;
  let rule = null;
  try { rule = JSON.parse(row.rule_json); } catch { rule = null; }
  return {
    ...row,
    enabled: Number(row.enabled) === 1,
    revision: Number(row.revision),
    max_runs_per_day: Number(row.max_runs_per_day),
    consecutive_failures: Number(row.consecutive_failures),
    consecutive_precheck_errors: Number(row.consecutive_precheck_errors),
    attempts: row.active_invocation_id ? Number(row.attempts) : null,
    rule,
  };
}

function createOperatorScheduleService(db, { eventBus, runService, logger } = {}) {
  const log = logger || ((message) => console.warn(`[operator-schedule] ${message}`));
  const sqliteRejectedTerminalCursors = new Map();
  const stmts = {
    getInstance: db.prepare('SELECT * FROM operator_instances WHERE id = ?'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    getPrimaryRef: db.prepare("SELECT project_id FROM operator_codebase_refs WHERE instance_id = ? AND role = 'primary' LIMIT 1"),
    getRef: db.prepare('SELECT role FROM operator_codebase_refs WHERE instance_id = ? AND project_id = ? LIMIT 1'),
    list: db.prepare(`
      SELECT os.*,
             oi.id AS active_invocation_id,
             oi.status AS active_invocation_status,
             oi.waiting_reason,
             oi.attempts
        FROM operator_schedules os
        LEFT JOIN operator_invocations oi
          ON oi.schedule_id=os.id
         AND oi.status IN ('pending','claimed','delivering','running')
       WHERE os.operator_instance_id = ? AND os.archived_at IS NULL
       ORDER BY os.created_at DESC, os.id DESC
    `),
    get: db.prepare(`
      SELECT os.*,
             oi.id AS active_invocation_id,
             oi.status AS active_invocation_status,
             oi.waiting_reason,
             oi.attempts
        FROM operator_schedules os
        LEFT JOIN operator_invocations oi
          ON oi.schedule_id=os.id
         AND oi.status IN ('pending','claimed','delivering','running')
       WHERE os.id=?
    `),
    insert: db.prepare(`
      INSERT INTO operator_schedules (
        id, operator_instance_id, name, prompt, codebase_project_id,
        rule_json, timezone, enabled, next_fire_at, max_runs_per_day,
        grace_seconds, misfire_policy
      ) VALUES (
        @id, @operator_instance_id, @name, @prompt, @codebase_project_id,
        @rule_json, @timezone, @enabled, @next_fire_at, @max_runs_per_day,
        @grace_seconds, @misfire_policy
      )
    `),
    update: db.prepare(`
      UPDATE operator_schedules
         SET name=@name, prompt=@prompt, codebase_project_id=@codebase_project_id,
             rule_json=@rule_json, timezone=@timezone, enabled=@enabled,
             next_fire_at=@next_fire_at, max_runs_per_day=@max_runs_per_day,
             grace_seconds=@grace_seconds, misfire_policy=@misfire_policy,
             revision=revision+1, updated_at=datetime('now')
       WHERE id=@id AND revision=@expected_revision AND archived_at IS NULL
    `),
    updatePrecheck: db.prepare(`
      UPDATE operator_schedules
         SET precheck_verify_check_id=@check_id,
             revision=revision+1, updated_at=datetime('now')
       WHERE id=@id AND revision=@expected_revision AND archived_at IS NULL
    `),
    archive: db.prepare(`
      UPDATE operator_schedules
         SET enabled=0, next_fire_at=NULL, archived_at=datetime('now'),
             revision=revision+1, updated_at=datetime('now')
       WHERE id=? AND archived_at IS NULL
    `),
    schedulesForProjectDeletion: db.prepare(`
      SELECT id FROM operator_schedules
      WHERE archived_at IS NULL
        AND (
          codebase_project_id=@project_id
          OR operator_instance_id IN (
            SELECT instance_id FROM operator_codebase_refs
            WHERE project_id=@project_id AND role='primary'
          )
        )
      ORDER BY id
    `),
    cancelForProjectDeletion: db.prepare(`
      UPDATE operator_invocations
         SET status='cancelled', claim_token=NULL, locked_at=NULL,
             waiting_reason='project_deleted', completed_at=datetime('now'), updated_at=datetime('now')
       WHERE status IN ('pending','claimed','delivering','running')
         AND schedule_id IN (
           SELECT id FROM operator_schedules
           WHERE codebase_project_id=@project_id
              OR operator_instance_id IN (
                SELECT instance_id FROM operator_codebase_refs
                WHERE project_id=@project_id AND role='primary'
              )
         )
    `),
    archiveForProjectDeletion: db.prepare(`
      UPDATE operator_schedules
         SET enabled=0, next_fire_at=NULL, archived_at=datetime('now'),
             revision=revision+1, updated_at=datetime('now')
       WHERE archived_at IS NULL
         AND (
           codebase_project_id=@project_id
           OR operator_instance_id IN (
             SELECT instance_id FROM operator_codebase_refs
             WHERE project_id=@project_id AND role='primary'
           )
         )
    `),
    cancelPending: db.prepare(`
      UPDATE operator_invocations
         SET status='cancelled', claim_token=NULL, locked_at=NULL,
             waiting_reason='schedule_disabled', completed_at=datetime('now'), updated_at=datetime('now')
       WHERE schedule_id=? AND status IN ('pending','claimed')
    `),
    dueSchedules: db.prepare(`
      SELECT * FROM operator_schedules
      WHERE enabled=1 AND archived_at IS NULL AND next_fire_at IS NOT NULL AND next_fire_at <= ?
      ORDER BY next_fire_at ASC, id ASC
      LIMIT ?
    `),
    activeInvocationForOperator: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE operator_instance_id=? AND status IN ('pending','claimed','delivering','running')
      LIMIT 1
    `),
    updateNextFire: db.prepare(`
      UPDATE operator_schedules
         SET next_fire_at=?, enabled=?, updated_at=datetime('now')
       WHERE id=? AND revision=? AND archived_at IS NULL
    `),
    countRecent: db.prepare(`
      SELECT COUNT(*) AS count FROM operator_invocations
      WHERE schedule_id=? AND scheduled_for >= ?
        -- The daily cap counts accepted executions, not superseded, skipped,
        -- or expired terminal records.
        AND status NOT IN ('cancelled')
    `),
    insertInvocation: db.prepare(`
      INSERT INTO operator_invocations (
        id, schedule_id, operator_instance_id, schedule_revision, source,
        prompt_snapshot, codebase_project_id, rule_snapshot_json,
        scheduled_for, status, run_after
      ) VALUES (
        @id, @schedule_id, @operator_instance_id, @schedule_revision, @source,
        @prompt_snapshot, @codebase_project_id, @rule_snapshot_json,
        @scheduled_for, 'pending', @run_after
      )
    `),
    insertTerminalInvocation: db.prepare(`
      INSERT INTO operator_invocations (
        id, schedule_id, operator_instance_id, schedule_revision, source,
        prompt_snapshot, codebase_project_id, rule_snapshot_json,
        scheduled_for, status, run_after, waiting_reason, completed_at
      ) VALUES (
        @id, @schedule_id, @operator_instance_id, @schedule_revision, @source,
        @prompt_snapshot, @codebase_project_id, @rule_snapshot_json,
        @scheduled_for, 'cancelled', @run_after, @waiting_reason, datetime('now')
      )
    `),
    invocationForOccurrence: db.prepare(`
      SELECT * FROM operator_invocations
       WHERE schedule_id=? AND scheduled_for=?
       LIMIT 1
    `),
    listInvocations: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE schedule_id=?
      ORDER BY scheduled_for DESC, created_at DESC
      LIMIT ?
    `),
    getVerifyCheck: db.prepare('SELECT * FROM verify_checks WHERE id=?'),
    occurrenceForScheduleAt: db.prepare(`
      SELECT * FROM operator_schedule_occurrences
       WHERE schedule_id=? AND scheduled_for=?
       LIMIT 1
    `),
    getOccurrence: db.prepare('SELECT * FROM operator_schedule_occurrences WHERE id=?'),
    getOwnedOccurrence: db.prepare(`
      SELECT * FROM operator_schedule_occurrences
       WHERE id=? AND status='prechecking' AND claim_token=?
    `),
    listOccurrences: db.prepare(`
      SELECT * FROM operator_schedule_occurrences
       WHERE schedule_id=?
       ORDER BY scheduled_for DESC, created_at DESC
       LIMIT ?
    `),
    supersedeInflightOccurrences: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='superseded', outcome_reason='newer_occurrence',
             claim_token=NULL, leased_until=NULL,
             finished_at=?, updated_at=?
       WHERE schedule_id=? AND status IN ('pending','prechecking')
       RETURNING *
    `),
    insertOccurrence: db.prepare(`
      INSERT INTO operator_schedule_occurrences (
        id, schedule_id, operator_instance_id, scheduled_for, schedule_revision,
        precheck_verify_check_id, precheck_check_id_snapshot, precheck_check_name,
        precheck_kind, precheck_spec_hash, precheck_node_id,
        precheck_workspace_generation, status, outcome_reason,
        next_attempt_at, deadline_at, finished_at, updated_at
      ) VALUES (
        @id, @schedule_id, @operator_instance_id, @scheduled_for, @schedule_revision,
        @precheck_verify_check_id, @precheck_check_id_snapshot, @precheck_check_name,
        @precheck_kind, @precheck_spec_hash, @precheck_node_id,
        @precheck_workspace_generation, @status, @outcome_reason,
        @next_attempt_at, @deadline_at, @finished_at, @updated_at
      )
    `),
    dueOccurrence: db.prepare(`
      SELECT * FROM operator_schedule_occurrences
       WHERE status='pending'
         AND next_attempt_at <= ?
         AND deadline_at > ?
       ORDER BY next_attempt_at ASC, scheduled_for ASC, id ASC
       LIMIT 1
    `),
    claimOccurrence: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='prechecking', claim_token=?, leased_until=?,
             attempts=attempts+1, started_at=COALESCE(started_at, ?), updated_at=?
       WHERE id=?
         AND status='pending'
         AND next_attempt_at <= ?
         AND deadline_at > ?
    `),
    releaseOccurrence: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='pending', claim_token=NULL, leased_until=NULL,
             next_attempt_at=?, updated_at=?
       WHERE id=? AND status='prechecking' AND claim_token=?
    `),
    finishOccurrence: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status=@status, outcome_reason=@outcome_reason,
             evaluator=@evaluator, detail_json=@detail_json,
             invocation_id=@invocation_id, claim_token=NULL, leased_until=NULL,
             finished_at=@finished_at, updated_at=@finished_at
       WHERE id=@id AND status='prechecking' AND claim_token=@claim_token
    `),
    recoverLeasedOccurrences: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='pending', claim_token=NULL, leased_until=NULL,
             next_attempt_at=@now, updated_at=@now
       WHERE status='prechecking'
         AND leased_until <= @now
         AND deadline_at > @now
       RETURNING *
    `),
    expirePrecheckingOccurrences: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='precheck_unavailable', outcome_reason='deadline_exceeded',
             claim_token=NULL, leased_until=NULL, finished_at=@now, updated_at=@now
       WHERE status='prechecking' AND deadline_at <= @now
       RETURNING *
    `),
    expirePendingOccurrences: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='precheck_unavailable', outcome_reason='deadline_exceeded',
             claim_token=NULL, leased_until=NULL, finished_at=@now, updated_at=@now
       WHERE status='pending' AND deadline_at <= @now
       RETURNING *
    `),
    // Release-time expiry: same terminal transition, but fenced on the caller's
    // ownership so a stale worker can never expire a row a newer claimant owns.
    // The deadline decision itself lives in releaseOccurrence (it also covers the
    // "backoff would overshoot the deadline" case, which a `deadline_at <= now`
    // predicate here would silently refuse to apply).
    expireOwnedOccurrence: db.prepare(`
      UPDATE operator_schedule_occurrences
         SET status='precheck_unavailable', outcome_reason='deadline_exceeded',
             claim_token=NULL, leased_until=NULL, finished_at=@now, updated_at=@now
       WHERE id=@id AND status='prechecking' AND claim_token=@token
    `),
    getInvocation: db.prepare('SELECT * FROM operator_invocations WHERE id=?'),
    cancelSuperseded: db.prepare(`
      UPDATE operator_invocations
         SET status='cancelled', claim_token=NULL, locked_at=NULL,
             waiting_reason='superseded', completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?
         AND source='scheduled'
         AND status IN ('pending','claimed')
         AND scheduled_for < ?
    `),
    expiryCandidates: db.prepare(`
      SELECT * FROM operator_invocations
       WHERE attempts >= 1
         AND (
           status='pending'
           OR (
             status='claimed'
             AND (locked_at IS NULL OR locked_at <= ?)
           )
         )
       ORDER BY scheduled_for ASC, id ASC
    `),
    expireInvocation: db.prepare(`
      UPDATE operator_invocations
         SET status='cancelled', claim_token=NULL, locked_at=NULL,
             waiting_reason='expired', completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=?
         AND attempts >= 1
         AND (
           status='pending'
           OR (
             status='claimed'
             AND (locked_at IS NULL OR locked_at <= ?)
           )
         )
    `),
    dueInvocation: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE status='pending' AND run_after <= ?
      ORDER BY run_after ASC, scheduled_for ASC, id ASC
      LIMIT 1
    `),
    claimInvocation: db.prepare(`
      UPDATE operator_invocations
         SET status='claimed', claim_token=?, locked_at=?, waiting_reason=NULL,
             attempts=attempts+1, updated_at=datetime('now')
       WHERE id=? AND status='pending' AND run_after <= ?
    `),
    releaseClaim: db.prepare(`
      UPDATE operator_invocations
         SET status='pending', claim_token=NULL, locked_at=NULL, run_after=?,
             waiting_reason=?, last_error=?, updated_at=datetime('now')
       WHERE id=? AND status IN ('claimed','delivering') AND claim_token=?
    `),
    markDelivering: db.prepare(`
      UPDATE operator_invocations
         SET status='delivering', waiting_reason=NULL, last_error=NULL, updated_at=datetime('now')
       WHERE id=? AND status='claimed' AND claim_token=?
    `),
    markRunning: db.prepare(`
      UPDATE operator_invocations
         SET status='running', manager_run_id=?, claim_token=NULL, locked_at=NULL,
             waiting_reason=NULL, last_error=NULL, started_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status='delivering' AND claim_token=?
    `),
    markClaimFailed: db.prepare(`
      UPDATE operator_invocations
         SET status='failed', claim_token=NULL, locked_at=NULL, waiting_reason=NULL,
             last_error=?, completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status IN ('claimed','delivering') AND claim_token=?
    `),
    cancelClaim: db.prepare(`
      UPDATE operator_invocations
         SET status='cancelled', claim_token=NULL, locked_at=NULL,
             waiting_reason=?, last_error=?, completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status IN ('claimed','delivering') AND claim_token=?
    `),
    uncertainClaim: db.prepare(`
      UPDATE operator_invocations
         SET status='uncertain', claim_token=NULL, locked_at=NULL,
             waiting_reason='delivery_uncertain', last_error=?,
             completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status IN ('claimed','delivering') AND claim_token=?
    `),
    runningByInvocation: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE id=? AND manager_run_id=? AND status='running'
    `),
    completeInvocation: db.prepare(`
      UPDATE operator_invocations
         SET status=?, last_error=?, completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND manager_run_id=? AND status='running'
    `),
    runningInvocationsForTerminalReconciliation: db.prepare(`
      SELECT id AS invocation_id, manager_run_id
      FROM operator_invocations
      WHERE status='running' AND manager_run_id IS NOT NULL
      ORDER BY started_at ASC, id ASC
    `),
    // Correlate before the bounded scan so unrelated and non-terminal events
    // consume no JavaScript parsing budget. Merge-patching into an empty object
    // is a fast prefilter that preserves later duplicate correlation values;
    // the nested scans remain authoritative because merge patch may combine
    // repeated objects. Oldest-first ordering preserves the live CAS contract.
    persistedTerminalEvents: db.prepare(`
      SELECT id, event_type, payload_json
      FROM run_events
      WHERE run_id=?
        AND event_type IN ('mgr.turn_completed','mgr.turn_failed')
        AND json_extract(
              json_patch(
                '{}',
                CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END
              ),
              '$.data.invocationId'
            )=?
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT value, type
            FROM json_each(
              CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END
            )
            WHERE key='data'
            ORDER BY id DESC
            LIMIT 1
          ) AS parsed_data
          WHERE parsed_data.type='object'
            AND 1 = (
              SELECT member.type='text' AND member.value=?
              FROM json_each(parsed_data.value) AS member
              WHERE member.key='invocationId'
              ORDER BY member.id DESC
              LIMIT 1
            )
            AND 'true' = (
              SELECT member.type
              FROM json_each(parsed_data.value) AS member
              WHERE member.key='terminal'
              ORDER BY member.id DESC
              LIMIT 1
            )
        )
      ORDER BY id ASC
      LIMIT ?
    `),
    // SQLite's JSON parser rejects otherwise valid JSON beyond its nesting
    // limit. The correlation literal drops ordinary unrelated history before
    // the authoritative parse. The cursor advances the bounded fallback across
    // ticks, while the SQL terminal id remains an exclusive upper bound so a
    // later SQL-valid event cannot overtake an earlier rejected completion.
    sqliteRejectedTerminalEvents: db.prepare(`
      SELECT id, event_type, payload_json
      FROM run_events
      WHERE run_id=?
        AND event_type IN ('mgr.turn_completed','mgr.turn_failed')
        AND json_valid(payload_json)=0
        AND instr(payload_json, ?)>0
        AND (? IS NULL OR id>?)
        AND (? IS NULL OR id < ?)
      ORDER BY id ASC
      LIMIT ?
    `),
    resetFailures: db.prepare(`
      UPDATE operator_schedules SET consecutive_failures=0, updated_at=datetime('now') WHERE id=?
    `),
    incrementFailures: db.prepare(`
      UPDATE operator_schedules
         SET consecutive_failures=consecutive_failures+1,
             enabled=CASE WHEN consecutive_failures+1 >= 3 THEN 0 ELSE enabled END,
             next_fire_at=CASE WHEN consecutive_failures+1 >= 3 THEN NULL ELSE next_fire_at END,
             updated_at=datetime('now')
       WHERE id=?
    `),
    resetPrecheckErrors: db.prepare(`
      UPDATE operator_schedules
         SET consecutive_precheck_errors=0, updated_at=datetime('now')
       WHERE id=?
    `),
    incrementPrecheckErrors: db.prepare(`
      UPDATE operator_schedules
         SET consecutive_precheck_errors=consecutive_precheck_errors+1,
             enabled=CASE WHEN consecutive_precheck_errors+1 >= 3 THEN 0 ELSE enabled END,
             next_fire_at=CASE WHEN consecutive_precheck_errors+1 >= 3 THEN NULL ELSE next_fire_at END,
             updated_at=datetime('now')
       WHERE id=?
    `),
    recoverClaimed: db.prepare(`
      UPDATE operator_invocations
         SET status='pending', claim_token=NULL, locked_at=NULL, run_after=?,
             waiting_reason='recovered_claim', updated_at=datetime('now')
       WHERE status='claimed'
    `),
    // The unconditional restart backstop. Every ACTIVE status that crossed the
    // external delivery window is released here, NOT just 'delivering'.
    //
    // A restart kills the adapter child, so an in-flight turn is definitively
    // gone — `uncertain` records "we do not know the outcome", it does not
    // cancel anything. Narrowing this to 'delivering' and leaving 'running' to
    // evidence-based recovery (a terminal manager run, or a queue row carrying
    // one of two specific terminal_reasons) is not safe: the evidence can be
    // absent (no queue row at all — migration 071 does not backfill) or wear a
    // different reason, and the per-Operator active UNIQUE index then blocks
    // that Operator's every later invocation, permanently, across restarts.
    //
    // Evidence-based classification still runs FIRST (see recoverAfterRestart)
    // so a recoverable outcome keeps its precise status/waiting_reason; this
    // statement only catches whatever is left.
    markDeliveryUncertain: db.prepare(`
      UPDATE operator_invocations
         SET status='uncertain', claim_token=NULL, locked_at=NULL,
             waiting_reason='restart_delivery_uncertain',
             completed_at=datetime('now'), updated_at=datetime('now')
       WHERE status IN ('delivering','running')
    `),
    terminalRunningCandidates: db.prepare(`
      SELECT i.*,
             COALESCE(r.status, 'missing') AS manager_run_status,
             CASE
               WHEN r.id IS NULL OR r.status IN ('completed','failed','cancelled','stopped')
                 THEN 'manager_run_terminal'
               ELSE COALESCE((
                 SELECT q.terminal_reason
                   FROM manager_message_queue q
                  WHERE q.adapter_invocation_id=i.id
                    AND q.status='failed'
                    AND q.terminal_reason IN (
                      'restart_delivery_uncertain',
                      'session_ended_during_processing'
                    )
                  ORDER BY q.sequence ASC
                  LIMIT 1
               ), 'restart_delivery_uncertain')
             END AS reconcile_reason
        FROM operator_invocations i
        LEFT JOIN runs r ON r.id=i.manager_run_id
       WHERE i.status='running'
         AND julianday(COALESCE(i.started_at, i.updated_at, i.created_at)) <= julianday(?)
         AND (
           r.id IS NULL
           OR r.status IN ('completed','failed','cancelled','stopped')
           OR EXISTS (
             SELECT 1
              FROM manager_message_queue q
             WHERE q.adapter_invocation_id=i.id
                AND q.status='failed'
                AND q.terminal_reason IN (
                  'restart_delivery_uncertain',
                  'session_ended_during_processing'
                )
           )
         )
       ORDER BY COALESCE(i.started_at, i.updated_at, i.created_at) ASC, i.id ASC
    `),
    markTerminalRunningUncertain: db.prepare(`
      UPDATE operator_invocations
         SET status='uncertain', waiting_reason=?,
             last_error=?, completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status='running'
         AND (
           manager_run_id IS NULL
           OR EXISTS (
             SELECT 1 FROM runs
              WHERE runs.id=operator_invocations.manager_run_id
                AND runs.status IN ('completed','failed','cancelled','stopped')
           )
           OR EXISTS (
             SELECT 1
              FROM manager_message_queue q
             WHERE q.adapter_invocation_id=operator_invocations.id
                AND q.status='failed'
                AND q.terminal_reason IN (
                  'restart_delivery_uncertain',
                  'session_ended_during_processing'
                )
           )
         )
    `),
  };

  function emit(kind, schedule, invocation, occurrence = null) {
    if (!eventBus) return;
    try {
      if (kind === 'occurrence_status') {
        eventBus.emit('operator:schedule', {
          kind,
          schedule_id: schedule?.id || occurrence?.schedule_id || null,
          operator_instance_id: schedule?.operator_instance_id || occurrence?.operator_instance_id || null,
          invocation_id: occurrence?.invocation_id || null,
          status: occurrence?.status || null,
          occurrence_id: occurrence?.id || null,
          occurrence_status: occurrence?.status || null,
        });
        return;
      }
      eventBus.emit('operator:schedule', {
        kind,
        schedule_id: schedule?.id || invocation?.schedule_id || null,
        operator_instance_id: schedule?.operator_instance_id || invocation?.operator_instance_id || null,
        invocation_id: invocation?.id || null,
        status: invocation?.status || null,
      });
    } catch { /* observability never blocks state */ }
  }

  function assertInstance(instanceId) {
    const id = nonEmptyString(instanceId, 'operator_instance_id', 200);
    const row = stmts.getInstance.get(id);
    if (!row) throw new NotFoundError(`Operator instance not found: ${id}`);
    if (row.archived_at) {
      const err = new ConflictError(`Operator instance is archived: ${id}`);
      err.code = 'OPERATOR_ARCHIVED';
      err.retryable = false;
      throw err;
    }
    return row;
  }

  function primaryProjectId(instanceId) {
    return stmts.getPrimaryRef.get(instanceId)?.project_id || null;
  }

  function assertMappedProject(instanceId, projectId, { requirePrimary = false } = {}) {
    const primary = primaryProjectId(instanceId);
    if (!primary) throw new ConflictError('Operator must have a primary folder before a schedule can be registered');
    const target = projectId || primary;
    const primaryProject = stmts.getProject.get(primary);
    if (!primaryProject) throw new ConflictError(`Operator primary project not found: ${primary}`);
    const project = stmts.getProject.get(target);
    if (!project) throw new NotFoundError(`Project not found: ${target}`);
    if (Number(project.pm_enabled) === 0) throw new ConflictError(`Project ${target} is disabled`);
    const ref = stmts.getRef.get(instanceId, target);
    if (!ref) throw new ConflictError(`Project ${target} is not mapped to Operator ${instanceId}`);
    if (requirePrimary && ref.role !== 'primary') throw new ConflictError('A primary folder is required');
    const primaryNodeId = primaryProject.node_id || 'local';
    const targetNodeId = project.node_id || 'local';
    if (targetNodeId !== primaryNodeId) {
      throw new ConflictError(
        `Scheduled folder must be on the Operator node (${primaryNodeId}); received ${targetNodeId}`,
      );
    }
    return { project, primaryProject, primaryProjectId: primary, role: ref.role };
  }

  function getSchedule(id) {
    const schedule = parseSchedule(stmts.get.get(id));
    if (!schedule) throw new NotFoundError(`Operator schedule not found: ${id}`);
    return schedule;
  }

  function listSchedules(instanceId) {
    assertInstance(instanceId);
    return stmts.list.all(instanceId).map(parseSchedule);
  }

  function createSchedule(instanceId, input = {}, now = new Date()) {
    assertInstance(instanceId);
    const mapped = assertMappedProject(instanceId, input.codebase_project_id || null);
    const name = nonEmptyString(input.name, 'name', 120);
    const prompt = nonEmptyString(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    const rule = normalizeRule(input.rule || input.rule_json);
    const timezone = normalizeTimezone(input.timezone);
    const enabled = normalizeEnabled(input.enabled, 1);
    const graceSeconds = normalizeGraceSeconds(input.grace_seconds, null);
    const misfirePolicy = normalizeMisfirePolicy(input.misfire_policy);
    const maxRuns = input.max_runs_per_day == null ? 24 : Number(input.max_runs_per_day);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 96) {
      throw new BadRequestError('max_runs_per_day must be an integer between 1 and 96');
    }
    const next = enabled ? nextFireForRule(rule, timezone, now) : null;
    if (enabled && !next) throw new BadRequestError('one-shot schedule must be in the future');
    const row = {
      id: `os_${crypto.randomUUID()}`,
      operator_instance_id: instanceId,
      name,
      prompt,
      codebase_project_id: mapped.project.id,
      rule_json: JSON.stringify(rule),
      timezone,
      enabled,
      next_fire_at: next ? next.toISOString() : null,
      max_runs_per_day: maxRuns,
      grace_seconds: graceSeconds,
      misfire_policy: misfirePolicy,
    };
    stmts.insert.run(row);
    const schedule = getSchedule(row.id);
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  const updateScheduleTx = db.transaction((id, input = {}, now = new Date()) => {
    const current = getSchedule(id);
    assertInstance(current.operator_instance_id);
    if (current.archived_at) throw new ConflictError('Archived schedules cannot be updated');
    const expectedRevision = Number(input.expected_revision);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new BadRequestError('expected_revision is required');
    }
    const name = input.name === undefined ? current.name : nonEmptyString(input.name, 'name', 120);
    const prompt = input.prompt === undefined ? current.prompt : nonEmptyString(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    const rule = input.rule === undefined && input.rule_json === undefined
      ? current.rule
      : normalizeRule(input.rule ?? input.rule_json);
    const timezone = input.timezone === undefined ? current.timezone : normalizeTimezone(input.timezone);
    const enabled = normalizeEnabled(input.enabled, Number(current.enabled));
    const graceSeconds = normalizeGraceSeconds(input.grace_seconds, current.grace_seconds);
    const misfirePolicy = normalizeMisfirePolicy(input.misfire_policy, current.misfire_policy);
    const projectId = input.codebase_project_id === undefined ? current.codebase_project_id : input.codebase_project_id;
    const mapped = assertMappedProject(current.operator_instance_id, projectId || null);
    if (
      mapped.project.id !== current.codebase_project_id
      && current.precheck_verify_check_id !== null
    ) {
      const check = stmts.getVerifyCheck.get(current.precheck_verify_check_id);
      if (
        !check
        || check.kind !== 'artifact'
        || check.created_by !== 'human'
        || check.project_id === null
        || check.project_id !== mapped.project.id
      ) {
        throw new ConflictError('Attached precheck is not valid for the requested project; detach it before changing projects');
      }
    }
    const maxRuns = input.max_runs_per_day === undefined ? current.max_runs_per_day : Number(input.max_runs_per_day);
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 96) {
      throw new BadRequestError('max_runs_per_day must be an integer between 1 and 96');
    }
    const next = enabled ? nextFireForRule(rule, timezone, now) : null;
    if (enabled && !next) throw new BadRequestError('one-shot schedule must be in the future');
    const info = stmts.update.run({
      id,
      expected_revision: expectedRevision,
      name,
      prompt,
      codebase_project_id: mapped.project.id,
      rule_json: JSON.stringify(rule),
      timezone,
      enabled,
      next_fire_at: next ? next.toISOString() : null,
      max_runs_per_day: maxRuns,
      grace_seconds: graceSeconds,
      misfire_policy: misfirePolicy,
    });
    if (info.changes !== 1) throw new ConflictError('Schedule changed; reload and retry');
    if (!enabled) stmts.cancelPending.run(id);
    return getSchedule(id);
  });

  function updateSchedule(id, input = {}, now = new Date()) {
    const schedule = updateScheduleTx.immediate(id, input, now);
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  function normalizeExpectedRevision(value) {
    const revision = Number(value);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new BadRequestError('expected_revision is required');
    }
    return revision;
  }

  const attachPrecheckTx = db.transaction((id, { checkId, expectedRevision } = {}) => {
    const schedule = getSchedule(id);
    if (schedule.archived_at) throw new ConflictError('Archived schedules cannot be updated');
    const revision = normalizeExpectedRevision(expectedRevision);
    if (schedule.revision !== revision) {
      throw new ConflictError('Schedule changed; reload and retry');
    }
    const normalizedCheckId = Number(checkId);
    if (!Number.isInteger(normalizedCheckId) || normalizedCheckId < 1) {
      throw new BadRequestError('check_id is required');
    }
    const check = stmts.getVerifyCheck.get(normalizedCheckId);
    if (!check) throw new NotFoundError(`verify_check not found: ${normalizedCheckId}`);
    if (check.kind !== 'artifact') {
      throw new BadRequestError('Only artifact checks can be attached as schedule prechecks');
    }
    if (check.project_id === null || check.project_id !== schedule.codebase_project_id) {
      throw new BadRequestError('check project_id must exactly match the schedule project_id');
    }
    if (check.created_by !== 'human') {
      throw new ForbiddenError('schedule precheck must be created by a human');
    }
    const info = stmts.updatePrecheck.run({
      id,
      check_id: check.id,
      expected_revision: revision,
    });
    if (info.changes !== 1) throw new ConflictError('Schedule changed; reload and retry');
    return getSchedule(id);
  });

  function attachPrecheck(id, { checkId, expectedRevision } = {}) {
    const schedule = attachPrecheckTx.immediate(id, { checkId, expectedRevision });
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  const detachPrecheckTx = db.transaction((id, { expectedRevision } = {}) => {
    const schedule = getSchedule(id);
    if (schedule.archived_at) throw new ConflictError('Archived schedules cannot be updated');
    const revision = normalizeExpectedRevision(expectedRevision);
    if (schedule.revision !== revision) {
      throw new ConflictError('Schedule changed; reload and retry');
    }
    const info = stmts.updatePrecheck.run({
      id,
      check_id: null,
      expected_revision: revision,
    });
    if (info.changes !== 1) throw new ConflictError('Schedule changed; reload and retry');
    return getSchedule(id);
  });

  function detachPrecheck(id, { expectedRevision } = {}) {
    const schedule = detachPrecheckTx.immediate(id, { expectedRevision });
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  function archiveSchedule(id) {
    const current = getSchedule(id);
    if (current.archived_at) return current;
    stmts.archive.run(id);
    stmts.cancelPending.run(id);
    const schedule = getSchedule(id);
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  // Called inside the same transaction that removes codebase refs and the
  // project row. Event emission is deliberately split out so a later project
  // delete failure cannot publish schedule state that was rolled back.
  function archiveForProjectDeletion(projectId) {
    const id = nonEmptyString(projectId, 'project_id', 200);
    const scheduleIds = stmts.schedulesForProjectDeletion.all({ project_id: id }).map((row) => row.id);
    if (scheduleIds.length === 0) return [];
    stmts.cancelForProjectDeletion.run({ project_id: id });
    stmts.archiveForProjectDeletion.run({ project_id: id });
    return scheduleIds;
  }

  function notifySchedulesChanged(scheduleIds) {
    for (const id of scheduleIds || []) {
      const schedule = parseSchedule(stmts.get.get(id));
      if (schedule) emit('schedule_changed', schedule, null);
    }
  }

  function insertInvocationFromSchedule(schedule, { source, scheduledFor, runAfter }) {
    const invocation = {
      id: `oinv_${crypto.randomUUID()}`,
      schedule_id: schedule.id,
      operator_instance_id: schedule.operator_instance_id,
      schedule_revision: schedule.revision,
      source,
      prompt_snapshot: schedule.prompt,
      codebase_project_id: schedule.codebase_project_id,
      rule_snapshot_json: schedule.rule_json,
      scheduled_for: scheduledFor,
      run_after: runAfter,
    };
    try {
      stmts.insertInvocation.run(invocation);
    } catch (err) {
      if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError('Operator already has an active invocation, or this schedule occurrence is duplicated');
      }
      throw err;
    }
    return stmts.getInvocation.get(invocation.id);
  }

  function insertTerminalInvocationFromSchedule(schedule, {
    source = 'scheduled',
    scheduledFor,
    runAfter,
    waitingReason,
  }) {
    const existing = stmts.invocationForOccurrence.get(schedule.id, scheduledFor);
    if (existing) return { invocation: existing, inserted: false };
    const invocation = {
      id: `oinv_${crypto.randomUUID()}`,
      schedule_id: schedule.id,
      operator_instance_id: schedule.operator_instance_id,
      schedule_revision: schedule.revision,
      source,
      prompt_snapshot: schedule.prompt,
      codebase_project_id: schedule.codebase_project_id,
      rule_snapshot_json: schedule.rule_json,
      scheduled_for: scheduledFor,
      run_after: runAfter,
      waiting_reason: waitingReason,
    };
    stmts.insertTerminalInvocation.run(invocation);
    return { invocation: stmts.getInvocation.get(invocation.id), inserted: true };
  }

  function runNow(id, now = new Date()) {
    const schedule = getSchedule(id);
    assertInstance(schedule.operator_instance_id);
    if (schedule.archived_at) throw new ConflictError('Archived schedules cannot run');
    assertMappedProject(schedule.operator_instance_id, schedule.codebase_project_id);
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    if (Number(stmts.countRecent.get(schedule.id, since)?.count || 0) >= schedule.max_runs_per_day) {
      throw new ConflictError('Schedule daily run limit reached');
    }
    const iso = now.toISOString();
    const invocation = insertInvocationFromSchedule(schedule, { source: 'manual_run_now', scheduledFor: iso, runAfter: iso });
    emit('invocation_status', schedule, invocation);
    return invocation;
  }

  function listInvocations(scheduleId, limit = 50) {
    getSchedule(scheduleId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    return stmts.listInvocations.all(scheduleId, bounded);
  }

  function listOccurrences(scheduleId, limit = 50) {
    getSchedule(scheduleId);
    const bounded = Math.max(1, Math.min(Number(limit) || 50, 200));
    return stmts.listOccurrences.all(scheduleId, bounded);
  }

  function workspaceGenerationForProject(project) {
    if (!project || project.source_type !== 'git') return null;
    return String(project.source_generation);
  }

  function specHashForCheck(check) {
    const spec = JSON.parse(check.spec_json);
    return canonicalSpecHash(validateSpec(check.kind, spec));
  }

  function occurrenceDeadline(now, scheduledFor, next, graceSeconds) {
    const candidates = [];
    if (next) candidates.push(next.getTime());
    if (graceSeconds !== null) {
      candidates.push(scheduledFor.getTime() + graceSeconds * 1000);
    }
    const deadlineMs = candidates.length > 0
      ? Math.min(...candidates)
      : now.getTime() + PRECHECK_DEADLINE_MS;
    return new Date(deadlineMs).toISOString();
  }

  function advancePastNow(schedule, now) {
    let cursor = new Date(schedule.next_fire_at);
    let scheduledFor = null;
    let skipped = 0;
    while (cursor && cursor.getTime() <= now.getTime()) {
      scheduledFor = cursor;
      cursor = nextFireForRule(schedule.rule, schedule.timezone, cursor);
      skipped += 1;
      if (skipped > 10000) throw new Error(`schedule ${schedule.id} advance guard exceeded`);
    }
    return { scheduledFor, next: cursor, skipped };
  }

  function recurrencePeriodMs(invocation) {
    if (invocation.source === 'manual_run_now') return null;
    let rule;
    try { rule = JSON.parse(invocation.rule_snapshot_json); } catch { return null; }
    if (!rule || rule.kind === 'once') return null;
    if (rule.kind === 'interval') return Number(rule.minutes) * 60 * 1000;
    if (rule.kind === 'daily') return 24 * 60 * 60 * 1000;
    // Use the longest gap in the rule so expiry remains conservative across
    // weekends. DST shifts are shorter than this whole-day safety margin.
    if (rule.kind === 'weekdays') return 3 * 24 * 60 * 60 * 1000;
    if (rule.kind === 'weekly') return 7 * 24 * 60 * 60 * 1000;
    return null;
  }

  function expiryAgeMs(invocation) {
    const period = recurrencePeriodMs(invocation);
    return Math.max(MIN_EXPIRY_AGE_MS, period ? 2 * period : 0);
  }

  function sweepExpired(now = new Date()) {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new BadRequestError('now must be a valid timestamp');
    const staleBefore = new Date(nowMs - CLAIM_LEASE_MS).toISOString();
    const expired = db.transaction(() => {
      const settled = [];
      for (const row of stmts.expiryCandidates.all(staleBefore)) {
        const scheduledMs = new Date(row.scheduled_for).getTime();
        if (!Number.isFinite(scheduledMs) || nowMs - scheduledMs <= expiryAgeMs(row)) continue;
        const info = stmts.expireInvocation.run(row.id, staleBefore);
        if (info.changes === 1) settled.push(stmts.getInvocation.get(row.id));
      }
      return settled;
    }).immediate();
    for (const invocation of expired) emit('invocation_status', null, invocation);
    return expired;
  }

  function materializeDue(now = new Date(), limit = 100) {
    const nowIso = now.toISOString();
    const rows = stmts.dueSchedules.all(nowIso, Math.max(1, Math.min(Number(limit) || 100, 500)));
    const created = [];
    for (const raw of rows) {
      try {
        const result = db.transaction(() => {
          const fresh = parseSchedule(stmts.get.get(raw.id));
          if (!fresh || !fresh.enabled || fresh.archived_at || !fresh.next_fire_at || fresh.next_fire_at > nowIso) return null;
          const { scheduledFor, next, skipped } = advancePastNow(fresh, now);
          if (!scheduledFor) return null;
          const nextEnabled = fresh.rule.kind === 'once' ? 0 : 1;
          stmts.updateNextFire.run(next ? next.toISOString() : null, nextEnabled, fresh.id, fresh.revision);
          const scheduledForIso = scheduledFor.toISOString();
          const changed = [];
          const beyondGrace = fresh.grace_seconds !== null
            && now.getTime() - scheduledFor.getTime() > fresh.grace_seconds * 1000;
          const skippedByPolicy = fresh.misfire_policy === 'skip' && skipped > 1;
          if (beyondGrace || skippedByPolicy) {
            const missed = insertTerminalInvocationFromSchedule(fresh, {
              scheduledFor: scheduledForIso,
              runAfter: nowIso,
              waitingReason: beyondGrace ? 'missed_grace' : 'missed_skip',
            });
            if (missed.inserted) changed.push(missed.invocation);
            return { invocation: null, changed };
          }
          // The daily cap is decided BEFORE touching the active invocation.
          // Superseding first and then returning on the cap commits the
          // cancellation without a replacement: the older occurrence is
          // destroyed, this one is never created, and the cursor has already
          // advanced past both. Reproduced with a capped schedule sharing an
          // Operator with a pending `once` — both occurrences vanished.
          const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          if (Number(stmts.countRecent.get(fresh.id, since)?.count || 0) >= fresh.max_runs_per_day) {
            const capped = insertTerminalInvocationFromSchedule(fresh, {
              scheduledFor: scheduledForIso,
              runAfter: nowIso,
              waitingReason: 'daily_cap_reached',
            });
            if (capped.inserted) changed.push(capped.invocation);
            return { invocation: null, changed };
          }
          if (fresh.precheck_verify_check_id !== null) {
            // R4: a duplicate occurrence must commit the cursor advance rather
            // than letting UNIQUE roll the whole transaction back forever.
            if (stmts.occurrenceForScheduleAt.get(fresh.id, scheduledForIso)) {
              return { invocation: null, changed, occurrences: [] };
            }
            const check = stmts.getVerifyCheck.get(fresh.precheck_verify_check_id);
            if (!check) {
              stmts.incrementPrecheckErrors.run(fresh.id);
              return { invocation: null, changed, occurrences: [], scheduleChanged: true };
            }
            const project = stmts.getProject.get(fresh.codebase_project_id);
            const occurrence = {
              id: `osocc_${crypto.randomUUID()}`,
              schedule_id: fresh.id,
              operator_instance_id: fresh.operator_instance_id,
              scheduled_for: scheduledForIso,
              schedule_revision: fresh.revision,
              precheck_verify_check_id: check.id,
              precheck_check_id_snapshot: check.id,
              precheck_check_name: check.name,
              precheck_kind: check.kind,
              precheck_spec_hash: specHashForCheck(check),
              precheck_node_id: project?.node_id || 'local',
              precheck_workspace_generation: workspaceGenerationForProject(project),
              status: 'pending',
              outcome_reason: null,
              next_attempt_at: nowIso,
              deadline_at: occurrenceDeadline(now, scheduledFor, next, fresh.grace_seconds),
              finished_at: null,
              updated_at: nowIso,
            };
            let healthError = false;
            if (check.created_by !== 'human') {
              occurrence.status = 'precheck_blocked';
              occurrence.outcome_reason = 'provenance_lost';
              healthError = true;
            } else if (check.kind !== 'artifact') {
              occurrence.status = 'precheck_blocked';
              occurrence.outcome_reason = 'unsupported_kind';
              healthError = true;
            } else if (check.project_id !== fresh.codebase_project_id) {
              occurrence.status = 'precheck_blocked';
              occurrence.outcome_reason = 'scope_mismatch';
              healthError = true;
            }
            const occurrences = occurrence.status === 'pending'
              ? stmts.supersedeInflightOccurrences.all(nowIso, nowIso, fresh.id)
              : [];
            if (occurrence.status !== 'pending') occurrence.finished_at = nowIso;
            stmts.insertOccurrence.run(occurrence);
            occurrences.push(stmts.getOccurrence.get(occurrence.id));
            if (healthError) stmts.incrementPrecheckErrors.run(fresh.id);
            return { invocation: null, changed, occurrences, scheduleChanged: healthError };
          }
          const active = stmts.activeInvocationForOperator.get(fresh.operator_instance_id);
          if (active) {
            const canSupersede = active.source === 'scheduled'
              && (active.status === 'pending' || active.status === 'claimed')
              && active.scheduled_for < scheduledForIso;
            if (canSupersede) {
              const info = stmts.cancelSuperseded.run(active.id, scheduledForIso);
              if (info.changes !== 1) {
                throw new ConflictError(`Active invocation changed before supersede: ${active.id}`);
              }
              changed.push(stmts.getInvocation.get(active.id));
            } else {
              const skipped = insertTerminalInvocationFromSchedule(fresh, {
                scheduledFor: scheduledForIso,
                runAfter: nowIso,
                waitingReason: 'operator_active_skipped',
              });
              if (skipped.inserted) changed.push(skipped.invocation);
              return { invocation: null, changed };
            }
          }
          const invocation = insertInvocationFromSchedule(fresh, {
            source: 'scheduled',
            scheduledFor: scheduledForIso,
            runAfter: nowIso,
          });
          return { invocation, changed };
        }).immediate();
        if (result) {
          for (const invocation of result.changed) emit('invocation_status', null, invocation);
          for (const occurrence of result.occurrences || []) {
            emit('occurrence_status', null, null, occurrence);
          }
          if (result.scheduleChanged) {
            emit('schedule_changed', parseSchedule(stmts.get.get(raw.id)), null);
          }
          if (result.invocation) {
            created.push(result.invocation);
            emit(
              'invocation_status',
              parseSchedule(stmts.get.get(result.invocation.schedule_id)),
              result.invocation,
            );
          }
        }
      } catch (err) {
        log(`materialize ${raw.id}: ${err.message}`);
      }
    }
    return created;
  }

  function claimNext(now = new Date()) {
    const nowIso = now.toISOString();
    return db.transaction(() => {
      const row = stmts.dueInvocation.get(nowIso);
      if (!row) return null;
      const token = crypto.randomUUID();
      const info = stmts.claimInvocation.run(token, nowIso, row.id, nowIso);
      if (info.changes !== 1) return null;
      return { ...stmts.getInvocation.get(row.id), claim_token: token };
    }).immediate();
  }

  function claimNextOccurrence(now = new Date()) {
    const nowIso = now.toISOString();
    const occurrence = db.transaction(() => {
      const row = stmts.dueOccurrence.get(nowIso, nowIso);
      if (!row) return null;
      const token = crypto.randomUUID();
      const leasedUntil = new Date(now.getTime() + CLAIM_LEASE_MS).toISOString();
      const info = stmts.claimOccurrence.run(
        token,
        leasedUntil,
        nowIso,
        nowIso,
        row.id,
        nowIso,
        nowIso,
      );
      if (info.changes !== 1) return null;
      return stmts.getOccurrence.get(row.id);
    }).immediate();
    if (occurrence) emit('occurrence_status', null, null, occurrence);
    return occurrence;
  }

  function releaseOccurrence(id, token, { now = new Date() } = {}) {
    const nowIso = now.toISOString();
    const outcome = db.transaction(() => {
      const owned = stmts.getOwnedOccurrence.get(id, token);
      if (!owned) return null;
      // §4.2: a retry past the deadline is not a retry. Returning it to `pending`
      // would produce a row the claim predicate (`deadline_at > now`) can never
      // pick up again and whose health cost is never counted — it would linger as
      // a zombie until a later sweep. Terminalize here, in the same transaction.
      const nextAttemptAt = new Date(now.getTime() + retryDelayMs(owned.attempts)).toISOString();
      // Expire when the deadline has passed OR when the backoff would land past
      // it. Checking only `now` leaves the same zombie one step removed: the row
      // parks as `pending`, and by the time `next_attempt_at` arrives the claim
      // predicate (`deadline_at > now`) can no longer be satisfied.
      if (owned.deadline_at <= nowIso || nextAttemptAt >= owned.deadline_at) {
        const info = stmts.expireOwnedOccurrence.run({ id, token, now: nowIso });
        if (info.changes !== 1) return null;
        stmts.incrementPrecheckErrors.run(owned.schedule_id);
        return { occurrence: stmts.getOccurrence.get(id), scheduleId: owned.schedule_id };
      }
      const info = stmts.releaseOccurrence.run(nextAttemptAt, nowIso, id, token);
      if (info.changes !== 1) return null;
      return { occurrence: stmts.getOccurrence.get(id), scheduleId: null };
    }).immediate();
    if (!outcome) return null;
    emit('occurrence_status', null, null, outcome.occurrence);
    if (outcome.scheduleId) emit('schedule_changed', parseSchedule(stmts.get.get(outcome.scheduleId)), null);
    return outcome.occurrence;
  }

  function finishOwnedOccurrence(
    occurrence,
    token,
    status,
    outcomeReason,
    invocationId,
    nowIso,
    evaluator = null,
    detailJson = null,
  ) {
    const info = stmts.finishOccurrence.run({
      id: occurrence.id,
      claim_token: token,
      status,
      outcome_reason: outcomeReason,
      evaluator,
      detail_json: detailJson,
      invocation_id: invocationId,
      finished_at: nowIso,
    });
    if (info.changes !== 1) return null;
    return stmts.getOccurrence.get(occurrence.id);
  }

  function commitPrecheck(occurrenceId, token, passed, {
    evaluatedSpecHash,
    evaluatedNodeId,
    evaluatedWorkspaceGeneration,
    evaluator = null,
    detail = null,
    now = new Date(),
  } = {}) {
    const nowIso = now.toISOString();
    let detailJson = null;
    if (detail !== null && detail !== undefined) {
      const candidate = JSON.stringify(detail);
      // The evaluator normally guarantees this bound. Keep the durable write
      // fail-closed if another caller bypasses it.
      detailJson = Buffer.byteLength(candidate, 'utf8') <= 2 * 1024
        ? candidate
        : JSON.stringify({ reason_code: 'detail_omitted' });
    }
    const result = db.transaction(() => {
      // Phase 1: loss of ownership is a complete no-op. In particular, an old
      // claimant may not terminalize a row that a newer claimant now owns.
      const occurrence = stmts.getOwnedOccurrence.get(occurrenceId, token);
      if (!occurrence) return null;

      const schedule = parseSchedule(stmts.get.get(occurrence.schedule_id));
      let terminalStatus = null;
      let reason = null;
      let health = null;

      // Phase 2: the order is the contract. Attachment uses the non-FK
      // snapshot and strict JS equality, which treats NULL as a real value.
      if (occurrence.deadline_at <= nowIso) {
        terminalStatus = 'precheck_unavailable';
        reason = 'deadline_exceeded';
        health = 'increment';
      } else if (!schedule
        || schedule.precheck_verify_check_id !== occurrence.precheck_check_id_snapshot) {
        terminalStatus = 'superseded';
        reason = 'attachment_changed';
      } else if (schedule.revision !== Number(occurrence.schedule_revision)) {
        terminalStatus = 'superseded';
        reason = 'schedule_revision_changed';
      } else {
        const check = stmts.getVerifyCheck.get(occurrence.precheck_check_id_snapshot);
        if (check && check.created_by !== 'human') {
          terminalStatus = 'precheck_blocked';
          reason = 'provenance_lost';
          health = 'increment';
        } else if (!check) {
          terminalStatus = 'precheck_blocked';
          reason = 'check_gone';
          health = 'increment';
        } else if (check.project_id !== schedule.codebase_project_id) {
          terminalStatus = 'precheck_blocked';
          reason = 'scope_mismatch';
          health = 'increment';
        } else if (check.kind !== occurrence.precheck_kind || check.kind !== 'artifact') {
          // Backstop only: migration 089 makes verify_checks.kind immutable, and
          // materialize already refuses a non-artifact precheck, so neither leg is
          // reachable through any supported path. It stays because "the evaluated
          // result belongs to the kind we contracted for" is the invariant the
          // artifact-only v1 rests on (§2.1) — a future writer must trip this,
          // not silently approve a command-shaped result.
          terminalStatus = 'precheck_blocked';
          reason = 'kind_changed';
          health = 'increment';
        } else {
          let currentSpecHash = null;
          try { currentSpecHash = specHashForCheck(check); } catch { /* corrupt rows fail closed */ }
          const evaluatedGeneration = evaluatedWorkspaceGeneration == null
            ? null
            : String(evaluatedWorkspaceGeneration);
          const project = stmts.getProject.get(schedule.codebase_project_id);
          const currentNodeId = project?.node_id || 'local';
          const currentGeneration = workspaceGenerationForProject(project);
          if (occurrence.precheck_spec_hash !== evaluatedSpecHash
            || occurrence.precheck_spec_hash !== currentSpecHash) {
            terminalStatus = 'superseded';
            reason = 'spec_changed';
          } else if (occurrence.precheck_node_id !== evaluatedNodeId
            || occurrence.precheck_node_id !== currentNodeId
            || occurrence.precheck_workspace_generation !== evaluatedGeneration
            || occurrence.precheck_workspace_generation !== currentGeneration) {
            terminalStatus = 'superseded';
            reason = 'workspace_changed';
          }
        }
      }

      const invocations = [];
      let invocationId = null;
      if (!terminalStatus && passed !== true) {
        terminalStatus = 'precheck_failed';
        reason = 'condition_not_met';
        health = 'reset';
      } else if (!terminalStatus) {
        terminalStatus = 'passed';
        health = 'reset';
        const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
        if (Number(stmts.countRecent.get(schedule.id, since)?.count || 0) >= schedule.max_runs_per_day) {
          reason = 'daily_cap_reached';
          const capped = insertTerminalInvocationFromSchedule(schedule, {
            scheduledFor: occurrence.scheduled_for,
            runAfter: nowIso,
            waitingReason: reason,
          });
          invocationId = capped.invocation.id;
          if (capped.inserted) invocations.push(capped.invocation);
        } else {
          const active = stmts.activeInvocationForOperator.get(schedule.operator_instance_id);
          if (active) {
            const canSupersede = active.source === 'scheduled'
              && (active.status === 'pending' || active.status === 'claimed')
              && active.scheduled_for < occurrence.scheduled_for;
            if (canSupersede) {
              const info = stmts.cancelSuperseded.run(active.id, occurrence.scheduled_for);
              if (info.changes !== 1) {
                throw new ConflictError(`Active invocation changed before supersede: ${active.id}`);
              }
              invocations.push(stmts.getInvocation.get(active.id));
            } else {
              reason = 'operator_active_skipped';
              const skipped = insertTerminalInvocationFromSchedule(schedule, {
                scheduledFor: occurrence.scheduled_for,
                runAfter: nowIso,
                waitingReason: reason,
              });
              invocationId = skipped.invocation.id;
              if (skipped.inserted) invocations.push(skipped.invocation);
            }
          }
          if (!invocationId) {
            const invocation = insertInvocationFromSchedule(schedule, {
              source: 'scheduled',
              scheduledFor: occurrence.scheduled_for,
              runAfter: nowIso,
            });
            invocationId = invocation.id;
            invocations.push(invocation);
          }
        }
      }

      const finished = finishOwnedOccurrence(
        occurrence,
        token,
        terminalStatus,
        reason,
        invocationId,
        nowIso,
        typeof evaluator === 'string' ? evaluator.slice(0, 80) : null,
        detailJson,
      );
      if (!finished) return null;
      if (health === 'increment') stmts.incrementPrecheckErrors.run(occurrence.schedule_id);
      if (health === 'reset') stmts.resetPrecheckErrors.run(occurrence.schedule_id);
      return { occurrence: finished, invocations, scheduleChanged: health !== null };
    }).immediate();

    if (!result) return null;
    for (const invocation of result.invocations) emit('invocation_status', null, invocation);
    emit('occurrence_status', null, null, result.occurrence);
    if (result.scheduleChanged) {
      emit('schedule_changed', parseSchedule(stmts.get.get(result.occurrence.schedule_id)), null);
    }
    return result.occurrence;
  }

  function sweepStaleOccurrences(now = new Date()) {
    const nowIso = now.toISOString();
    const result = db.transaction(() => {
      // Each transition carries its own complete CAS predicate in the UPDATE.
      const recovered = stmts.recoverLeasedOccurrences.all({ now: nowIso });
      const unavailable = [
        ...stmts.expirePrecheckingOccurrences.all({ now: nowIso }),
        ...stmts.expirePendingOccurrences.all({ now: nowIso }),
      ];
      for (const occurrence of unavailable) {
        stmts.incrementPrecheckErrors.run(occurrence.schedule_id);
      }
      return { recovered, unavailable };
    }).immediate();
    for (const occurrence of [...result.recovered, ...result.unavailable]) {
      emit('occurrence_status', null, null, occurrence);
    }
    for (const scheduleId of new Set(result.unavailable.map((row) => row.schedule_id))) {
      emit('schedule_changed', parseSchedule(stmts.get.get(scheduleId)), null);
    }
    return [...result.recovered, ...result.unavailable];
  }

  function releaseClaim(id, token, {
    waitingReason,
    error,
    delayMs = 30000,
    now = new Date(),
  } = {}) {
    const runAfter = new Date(now.getTime() + Math.max(1000, Number(delayMs) || 30000)).toISOString();
    const info = stmts.releaseClaim.run(runAfter, waitingReason || null, error ? String(error).slice(0, 2000) : null, id, token);
    if (info.changes !== 1) return null;
    const invocation = stmts.getInvocation.get(id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function markRunning(id, token, managerRunId) {
    const info = stmts.markRunning.run(managerRunId, id, token);
    if (info.changes !== 1) throw new ConflictError('Invocation claim was lost before delivery commit');
    const invocation = stmts.getInvocation.get(id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function markDelivering(id, token) {
    const info = stmts.markDelivering.run(id, token);
    if (info.changes !== 1) throw new ConflictError('Invocation claim was lost before delivery');
    const invocation = stmts.getInvocation.get(id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function failClaim(id, token, error) {
    const info = stmts.markClaimFailed.run(String(error || 'delivery failed').slice(0, 2000), id, token);
    if (info.changes !== 1) return null;
    const invocation = stmts.getInvocation.get(id);
    if (invocation.schedule_id) stmts.incrementFailures.run(invocation.schedule_id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function cancelClaim(id, token, reason, error = null) {
    const info = stmts.cancelClaim.run(
      reason || 'cancelled',
      error ? String(error).slice(0, 2000) : null,
      id,
      token,
    );
    if (info.changes !== 1) return null;
    const invocation = stmts.getInvocation.get(id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function markClaimUncertain(id, token, error = null) {
    const info = stmts.uncertainClaim.run(
      error ? String(error).slice(0, 2000) : null,
      id,
      token,
    );
    if (info.changes !== 1) return null;
    const invocation = stmts.getInvocation.get(id);
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function completeInvocation(invocationId, managerRunId, success, error = null) {
    const running = stmts.runningByInvocation.get(invocationId, managerRunId);
    if (!running) return null;
    const status = success ? 'completed' : 'failed';
    const info = stmts.completeInvocation.run(
      status,
      normalizeTerminalError(error),
      running.id,
      managerRunId,
    );
    if (info.changes !== 1) return null;
    sqliteRejectedTerminalCursors.delete(invocationId);
    if (running.schedule_id) {
      if (success) stmts.resetFailures.run(running.schedule_id);
      else stmts.incrementFailures.run(running.schedule_id);
    }
    const invocation = stmts.getInvocation.get(running.id);
    if (runService && typeof runService.addRunEvent === 'function') {
      try {
        runService.addRunEvent(managerRunId, success ? 'operator:schedule_completed' : 'operator:schedule_failed', JSON.stringify({
          invocation_id: invocation.id,
          schedule_id: invocation.schedule_id,
        }));
      } catch { /* annotate-only */ }
    }
    emit('invocation_status', null, invocation);
    return invocation;
  }

  function reconcilePersistedTerminalEvents({ drainSQLiteRejectedCandidates = false } = {}) {
    const reconciled = [];
    for (const row of stmts.runningInvocationsForTerminalReconciliation.all()) {
      const candidates = stmts.persistedTerminalEvents.all(
        row.manager_run_id,
        row.invocation_id,
        row.invocation_id,
        MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
      );
      const sqlTerminal = findPersistedTerminalEvent(candidates, row.invocation_id);
      let terminal;
      do {
        const cursor = sqliteRejectedTerminalCursors.get(row.invocation_id) ?? null;
        const sqliteRejectedCandidates = stmts.sqliteRejectedTerminalEvents.all(
          row.manager_run_id,
          JSON.stringify(row.invocation_id),
          cursor,
          cursor,
          sqlTerminal?.id ?? null,
          sqlTerminal?.id ?? null,
          MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES,
        );
        const sqliteRejectedTerminal = findPersistedTerminalEvent(
          sqliteRejectedCandidates,
          row.invocation_id,
        );
        if (sqliteRejectedTerminal) {
          sqliteRejectedTerminalCursors.delete(row.invocation_id);
          terminal = sqliteRejectedTerminal;
          break;
        }
        if (sqliteRejectedCandidates.length >= MAX_PERSISTED_TERMINAL_EVENT_CANDIDATES) {
          sqliteRejectedTerminalCursors.set(
            row.invocation_id,
            sqliteRejectedCandidates[sqliteRejectedCandidates.length - 1].id,
          );
          if (drainSQLiteRejectedCandidates) continue;
          break;
        }
        if (sqliteRejectedCandidates.length > 0) {
          sqliteRejectedTerminalCursors.set(
            row.invocation_id,
            sqliteRejectedCandidates[sqliteRejectedCandidates.length - 1].id,
          );
        }
        terminal = sqlTerminal;
        if (terminal) sqliteRejectedTerminalCursors.delete(row.invocation_id);
        break;
      } while (drainSQLiteRejectedCandidates);
      if (!terminal) continue;
      const success = terminal.event_type === 'mgr.turn_completed';
      const invocation = completeInvocation(
        row.invocation_id,
        row.manager_run_id,
        success,
        success ? null : (terminal.payload?.summaryText || 'manager turn failed'),
      );
      if (invocation) reconciled.push(invocation);
    }
    return reconciled;
  }

  function sweepTerminalRunning(
    now = new Date(),
    minAgeMs = RUNNING_RECONCILE_MIN_AGE_MS,
  ) {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new BadRequestError('now must be a valid timestamp');
    const configuredAgeMs = Number(minAgeMs);
    const ageMs = Number.isFinite(configuredAgeMs) && configuredAgeMs >= 0
      ? configuredAgeMs
      : RUNNING_RECONCILE_MIN_AGE_MS;
    const staleBefore = new Date(nowMs - ageMs).toISOString();
    const reconciled = db.transaction(() => {
      const settled = [];
      for (const row of stmts.terminalRunningCandidates.all(staleBefore)) {
        let error;
        if (row.reconcile_reason === 'restart_delivery_uncertain') {
          error = 'server restarted after scheduler delivery; turn completion correlation was lost';
        } else if (row.reconcile_reason === 'session_ended_during_processing') {
          error = 'manager session ended after scheduler delivery; turn completion could not be observed';
        } else {
          error = `manager run ended with status ${row.manager_run_status} before turn completion was observed`;
        }
        const info = stmts.markTerminalRunningUncertain.run(
          row.reconcile_reason,
          error,
          row.id,
        );
        if (info.changes === 1) settled.push(stmts.getInvocation.get(row.id));
      }
      return settled;
    }).immediate();
    for (const invocation of reconciled) emit('invocation_status', null, invocation);
    return reconciled;
  }

  function recoverAfterRestart(
    now = new Date(),
    runningStaleMs = RUNNING_RECONCILE_MIN_AGE_MS,
  ) {
    sweepStaleOccurrences(now);
    const pending = stmts.recoverClaimed.run(now.toISOString()).changes;
    // Order is the contract: most-informative first, unconditional backstop
    // last. Reversing it would release every 'running' row generically before
    // either reconciler could see it, throwing away the real outcome.
    //   1. a persisted terminal turn event  → the ACTUAL outcome (completed/failed)
    //   2. a provably dead manager run      → 'uncertain' + a specific reason
    //   3. anything still active            → 'uncertain' + restart_delivery_uncertain
    // Normal ticks keep JSON parsing bounded to one fallback page. Restart is
    // the last chance to consume those pages before the generic backstop makes
    // the invocation terminal, so it must drain the finite persisted history.
    reconcilePersistedTerminalEvents({ drainSQLiteRejectedCandidates: true });
    const uncertainRunning = sweepTerminalRunning(now, runningStaleMs).length;
    const uncertainDelivery = stmts.markDeliveryUncertain.run().changes;
    const uncertain = uncertainDelivery + uncertainRunning;
    return { pending, uncertain };
  }

  function getInvocationContext(id) {
    const invocation = stmts.getInvocation.get(id);
    if (!invocation) throw new NotFoundError(`Operator invocation not found: ${id}`);
    const instance = assertInstance(invocation.operator_instance_id);
    const mapped = assertMappedProject(instance.id, invocation.codebase_project_id || null);
    const schedule = invocation.schedule_id ? parseSchedule(stmts.get.get(invocation.schedule_id)) : null;
    return { invocation, instance, project: mapped.project, primaryProjectId: mapped.primaryProjectId, schedule };
  }

  return {
    listSchedules,
    getSchedule,
    createSchedule,
    updateSchedule,
    attachPrecheck,
    detachPrecheck,
    archiveSchedule,
    archiveForProjectDeletion,
    notifySchedulesChanged,
    runNow,
    listInvocations,
    listOccurrences,
    sweepExpired,
    materializeDue,
    claimNext,
    claimNextOccurrence,
    releaseOccurrence,
    commitPrecheck,
    sweepStaleOccurrences,
    releaseClaim,
    markDelivering,
    markRunning,
    failClaim,
    cancelClaim,
    markClaimUncertain,
    completeInvocation,
    reconcilePersistedTerminalEvents,
    sweepTerminalRunning,
    recoverAfterRestart,
    getInvocationContext,
  };
}

module.exports = {
  ACTIVE_INVOCATION_STATUSES,
  TERMINAL_INVOCATION_STATUSES,
  MIN_INTERVAL_MINUTES,
  MIN_EXPIRY_AGE_MS,
  CLAIM_LEASE_MS,
  RUNNING_RECONCILE_MIN_AGE_MS,
  PRECHECK_DEADLINE_MS,
  PRECHECK_RETRY_BASE_MS,
  PRECHECK_RETRY_CAP_MS,
  retryDelayMs,
  normalizeRule,
  normalizeTimezone,
  nextFireForRule,
  createOperatorScheduleService,
};
