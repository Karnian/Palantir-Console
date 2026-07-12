'use strict';

// G2 §6 — Goal mode activation gate.
//
// Goal features rely on a spoof-proof human/Operator actor split (the R4
// remember contract): human = PALANTIR_TOKEN via cookie, Operator = a SEPARATE
// PALANTIR_PM_TOKEN via bearer. If the Operator is handed the shared
// PALANTIR_TOKEN, it could send that as a cookie and impersonate a human — so
// the cookie-only gates that authorize a command verify_check would be
// spoofable. Therefore goal mode is DISABLED (fail-closed) unless a distinct
// PALANTIR_PM_TOKEN is configured. `goalFeatureActive()` is the single boundary
// every goal behavior gates on; when false, the server is byte-identical to a
// pre-goal deployment.

function pickEnv(e) { return e || process.env; }

function goalModeEnabled(e) {
  return pickEnv(e).PALANTIR_GOAL_MODE === '1';
}

// A separated PM token is present, non-empty, and NOT equal to the human token.
function pmTokenSeparated(e) {
  const env = pickEnv(e);
  const pm = env.PALANTIR_PM_TOKEN;
  return typeof pm === 'string' && pm.length > 0 && pm !== env.PALANTIR_TOKEN;
}

// Goal features are active ONLY when the mode is on AND the PM token is
// separated. Non-active → no goal behavior changes anywhere.
function goalFeatureActive(e) {
  return goalModeEnabled(e) && pmTokenSeparated(e);
}

// Boot diagnostic: describe the goal-mode state (and warn on fail-closed).
// Returns null when goal mode was not requested at all.
function goalModeDiagnostic(e) {
  if (!goalModeEnabled(e)) return null;
  if (pmTokenSeparated(e)) {
    return { active: true, message: '[goal] PALANTIR_GOAL_MODE=1 and PALANTIR_PM_TOKEN separated — goal features ACTIVE.' };
  }
  return {
    active: false,
    message: '[goal] PALANTIR_GOAL_MODE=1 but PALANTIR_PM_TOKEN is not separated from PALANTIR_TOKEN — goal features DISABLED (fail-closed, §6). Set a distinct PALANTIR_PM_TOKEN to enable.',
  };
}

// G3c §5k-4: the Gate 1.5 judge is a SEPARATE opt-in flag on top of goal mode
// (PALANTIR_MEMORY_DISTILL precedent). Default OFF. Per-task activation
// (tasks.goal_judge_enabled) is checked at the call site.
function goalJudgeActive(e) {
  return goalFeatureActive(e) && pickEnv(e).PALANTIR_GOAL_JUDGE === '1';
}

module.exports = { goalModeEnabled, pmTokenSeparated, goalFeatureActive, goalJudgeActive, goalModeDiagnostic };
