'use strict';

// G1 — goal report parser (공통 모듈, spec §5c).
//
// A goal-enabled worker is asked (via the compiled prompt, §5b) to end its final
// message with a fenced block:
//
//   ```palantir-goal-report
//   { "goal_status": "done", "summary": "...", "blockers": ["..."] }
//   ```
//
// This module extracts and normalizes that block. It is the SINGLE parser
// implementation shared by every capture site (Claude result text, codex/tmux
// final output, and the harvest fallback re-parse).
//
// Contract (spec §5c): parsing failure is NOT a run failure — it is annotate-only.
// Every function here is total: it returns null on absence/garbage and NEVER
// throws. Callers persist the result as runs.goal_report or skip on null.

const FENCE_RE = /```palantir-goal-report[^\n]*\n([\s\S]*?)```/gi;

const MAX_SUMMARY_LEN = 4000;
const MAX_BLOCKER_LEN = 1000;
const MAX_BLOCKERS = 20;
const MAX_STATUS_LEN = 40;

function asTrimmedString(value, cap) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  return cap && t.length > cap ? t.slice(0, cap) : t;
}

// Normalize a parsed object into the fixed { goal_status, summary, blockers } shape.
// Unknown fields are dropped; missing fields become null / []. Returns null only
// when the payload is not an object at all.
function normalizeReport(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const goal_status = asTrimmedString(obj.goal_status, MAX_STATUS_LEN);
  const summary = asTrimmedString(obj.summary, MAX_SUMMARY_LEN);
  let blockers = [];
  if (Array.isArray(obj.blockers)) {
    blockers = obj.blockers
      .map((b) => asTrimmedString(b, MAX_BLOCKER_LEN))
      .filter(Boolean)
      .slice(0, MAX_BLOCKERS);
  }
  return { goal_status, summary, blockers };
}

/**
 * Extract + parse the LAST palantir-goal-report fenced block in `text`.
 * The last block wins: a multi-turn worker may print several; the final one
 * reflects its ending state. Returns the normalized report or null.
 * Never throws.
 */
function parseGoalReport(text) {
  if (typeof text !== 'string' || !text) return null;
  let lastBody = null;
  try {
    let m;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(text)) !== null) {
      if (typeof m[1] === 'string') lastBody = m[1];
      // Guard against a pathological zero-width match looping forever.
      if (m.index === FENCE_RE.lastIndex) FENCE_RE.lastIndex++;
    }
  } catch {
    return null;
  }
  if (lastBody == null) return null;
  let parsed;
  try {
    parsed = JSON.parse(lastBody.trim());
  } catch {
    return null;
  }
  return normalizeReport(parsed);
}

module.exports = { parseGoalReport, normalizeReport };
