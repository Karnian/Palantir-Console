'use strict';

const crypto = require('node:crypto');
const {
  BadRequestError,
  ConflictError,
  NotFoundError,
} = require('../utils/errors');

const ACTIVE_INVOCATION_STATUSES = new Set(['pending', 'claimed', 'delivering', 'running']);
const TERMINAL_INVOCATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'uncertain']);
const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DEFAULT_TIMEZONE = 'UTC';
const MAX_PROMPT_LENGTH = 12000;

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
    rule,
  };
}

function createOperatorScheduleService(db, { eventBus, runService, logger } = {}) {
  const log = logger || ((message) => console.warn(`[operator-schedule] ${message}`));
  const stmts = {
    getInstance: db.prepare('SELECT * FROM operator_instances WHERE id = ?'),
    getProject: db.prepare('SELECT * FROM projects WHERE id = ?'),
    getPrimaryRef: db.prepare("SELECT project_id FROM operator_codebase_refs WHERE instance_id = ? AND role = 'primary' LIMIT 1"),
    getRef: db.prepare('SELECT role FROM operator_codebase_refs WHERE instance_id = ? AND project_id = ? LIMIT 1'),
    list: db.prepare(`
      SELECT * FROM operator_schedules
      WHERE operator_instance_id = ? AND archived_at IS NULL
      ORDER BY created_at DESC, id DESC
    `),
    get: db.prepare('SELECT * FROM operator_schedules WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO operator_schedules (
        id, operator_instance_id, name, prompt, codebase_project_id,
        rule_json, timezone, enabled, next_fire_at, max_runs_per_day
      ) VALUES (
        @id, @operator_instance_id, @name, @prompt, @codebase_project_id,
        @rule_json, @timezone, @enabled, @next_fire_at, @max_runs_per_day
      )
    `),
    update: db.prepare(`
      UPDATE operator_schedules
         SET name=@name, prompt=@prompt, codebase_project_id=@codebase_project_id,
             rule_json=@rule_json, timezone=@timezone, enabled=@enabled,
             next_fire_at=@next_fire_at, max_runs_per_day=@max_runs_per_day,
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
    activeInvocation: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE schedule_id=? AND status IN ('pending','claimed','delivering','running')
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
    listInvocations: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE schedule_id=?
      ORDER BY scheduled_for DESC, created_at DESC
      LIMIT ?
    `),
    getInvocation: db.prepare('SELECT * FROM operator_invocations WHERE id=?'),
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
    runningByManager: db.prepare(`
      SELECT * FROM operator_invocations
      WHERE manager_run_id=? AND status='running'
      ORDER BY started_at DESC LIMIT 1
    `),
    completeInvocation: db.prepare(`
      UPDATE operator_invocations
         SET status=?, last_error=?, completed_at=datetime('now'), updated_at=datetime('now')
       WHERE id=? AND status='running'
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
    recoverClaimed: db.prepare(`
      UPDATE operator_invocations
         SET status='pending', claim_token=NULL, locked_at=NULL, run_after=?,
             waiting_reason='recovered_claim', updated_at=datetime('now')
       WHERE status='claimed'
    `),
    markDeliveryUncertain: db.prepare(`
      UPDATE operator_invocations
         SET status='uncertain', waiting_reason='restart_delivery_uncertain',
             completed_at=datetime('now'), updated_at=datetime('now')
       WHERE status IN ('delivering','running')
    `),
  };

  function emit(kind, schedule, invocation) {
    if (!eventBus) return;
    try {
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
    return row;
  }

  function primaryProjectId(instanceId) {
    return stmts.getPrimaryRef.get(instanceId)?.project_id || null;
  }

  function assertMappedProject(instanceId, projectId, { requirePrimary = false } = {}) {
    const primary = primaryProjectId(instanceId);
    if (!primary) throw new ConflictError('Operator must have a primary folder before a schedule can be registered');
    const target = projectId || primary;
    const project = stmts.getProject.get(target);
    if (!project) throw new NotFoundError(`Project not found: ${target}`);
    if (Number(project.pm_enabled) === 0) throw new ConflictError(`Project ${target} is disabled`);
    const ref = stmts.getRef.get(instanceId, target);
    if (!ref) throw new ConflictError(`Project ${target} is not mapped to Operator ${instanceId}`);
    if (requirePrimary && ref.role !== 'primary') throw new ConflictError('A primary folder is required');
    return { project, primaryProjectId: primary, role: ref.role };
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
    };
    stmts.insert.run(row);
    const schedule = getSchedule(row.id);
    emit('schedule_changed', schedule, null);
    return schedule;
  }

  function updateSchedule(id, input = {}, now = new Date()) {
    const current = getSchedule(id);
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
    const projectId = input.codebase_project_id === undefined ? current.codebase_project_id : input.codebase_project_id;
    const mapped = assertMappedProject(current.operator_instance_id, projectId || null);
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
    });
    if (info.changes !== 1) throw new ConflictError('Schedule changed; reload and retry');
    if (!enabled) stmts.cancelPending.run(id);
    const schedule = getSchedule(id);
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
        throw new ConflictError('Schedule already has an active or duplicate invocation');
      }
      throw err;
    }
    return stmts.getInvocation.get(invocation.id);
  }

  function runNow(id, now = new Date()) {
    const schedule = getSchedule(id);
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

  function advancePastNow(schedule, now) {
    let cursor = new Date(schedule.next_fire_at);
    let scheduledFor = null;
    let guard = 0;
    while (cursor && cursor.getTime() <= now.getTime()) {
      scheduledFor = cursor;
      cursor = nextFireForRule(schedule.rule, schedule.timezone, cursor);
      guard += 1;
      if (guard > 10000) throw new Error(`schedule ${schedule.id} advance guard exceeded`);
    }
    return { scheduledFor, next: cursor };
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
          const { scheduledFor, next } = advancePastNow(fresh, now);
          if (!scheduledFor) return null;
          const nextEnabled = fresh.rule.kind === 'once' ? 0 : 1;
          stmts.updateNextFire.run(next ? next.toISOString() : null, nextEnabled, fresh.id, fresh.revision);
          if (stmts.activeInvocation.get(fresh.id)) return null; // coalesce while an earlier turn is active
          const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          if (Number(stmts.countRecent.get(fresh.id, since)?.count || 0) >= fresh.max_runs_per_day) return null;
          return insertInvocationFromSchedule(fresh, {
            source: 'scheduled',
            scheduledFor: scheduledFor.toISOString(),
            runAfter: nowIso,
          });
        })();
        if (result) {
          created.push(result);
          emit('invocation_status', parseSchedule(stmts.get.get(result.schedule_id)), result);
        }
      } catch (err) {
        if (!(err instanceof ConflictError)) log(`materialize ${raw.id}: ${err.message}`);
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
    })();
  }

  function releaseClaim(id, token, { waitingReason, error, delayMs = 30000 } = {}) {
    const runAfter = new Date(Date.now() + Math.max(1000, Number(delayMs) || 30000)).toISOString();
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

  function completeByManagerRun(managerRunId, success, error = null) {
    const running = stmts.runningByManager.get(managerRunId);
    if (!running) return null;
    const status = success ? 'completed' : 'failed';
    const info = stmts.completeInvocation.run(status, error ? String(error).slice(0, 2000) : null, running.id);
    if (info.changes !== 1) return null;
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

  function recoverAfterRestart(now = new Date()) {
    const pending = stmts.recoverClaimed.run(now.toISOString()).changes;
    const uncertain = stmts.markDeliveryUncertain.run().changes;
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
    archiveSchedule,
    archiveForProjectDeletion,
    notifySchedulesChanged,
    runNow,
    listInvocations,
    materializeDue,
    claimNext,
    releaseClaim,
    markDelivering,
    markRunning,
    failClaim,
    cancelClaim,
    markClaimUncertain,
    completeByManagerRun,
    recoverAfterRestart,
    getInvocationContext,
  };
}

module.exports = {
  ACTIVE_INVOCATION_STATUSES,
  TERMINAL_INVOCATION_STATUSES,
  MIN_INTERVAL_MINUTES,
  normalizeRule,
  normalizeTimezone,
  nextFireForRule,
  createOperatorScheduleService,
};
