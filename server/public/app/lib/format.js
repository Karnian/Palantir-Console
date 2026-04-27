// Pure date/duration formatters used by app.js. Extracted from the legacy
// monolith as part of the Phase 4 frontend split. No DOM, no globals, no fetch
// — safe to import from any module or test directly.

// Accepts both ISO 8601 strings (e.g. '2026-04-27T12:34:56.000Z' from
// `new Date(...).toISOString()`) AND SQLite-shaped datetime strings
// ('YYYY-MM-DD HH:MM:SS', no timezone — server writes these as UTC).
//
// K-low-3 round 2 (Codex BLOCK): the previous implementation appended
// 'Z' unconditionally to every string, which silently broke proper ISO
// inputs (DriftDrawer normalizes via `new Date(row.created_at).toISOString()`
// before calling these helpers). We now route through the existing
// `Date` parser for already-zoned strings and only force the UTC suffix
// when the SQLite shape (no T/Z) is detected.
// Exported so other components can normalize the same SQLite/ISO/numeric
// inputs without re-rolling the parser. `formatTs` in McpTemplatesView
// used to inline a copy of this logic and broke on ISO Z input —
// callers should reuse this helper.
export function parseDate(value) {
  if (typeof value !== 'string') return new Date(value);
  if (/[TZ]/.test(value) || /[+-]\d\d:?\d\d$/.test(value)) {
    return new Date(value);
  }
  return new Date(value.replace(' ', 'T') + 'Z');
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) {
    const remMin = mins % 60;
    return remMin > 0 ? `${hrs}시간 ${remMin}분` : `${hrs}시간`;
  }
  if (mins > 0) return `${mins}분`;
  return `${secs}초`;
}

export function formatTime(ms) {
  if (!ms) return '알 수 없음';
  const d = parseDate(ms);
  if (Number.isNaN(d.getTime())) return '알 수 없음';
  return d.toLocaleString();
}

// K-low-3 (Codex BLOCK): timeAgo strings flipped to Korean so triage
// meta rows ('실행 중 · 5분 전') stop mixing with English ('5m ago').
// '방금' / 'N분 전' fragments stay short so they can drop into any
// caller's larger sentence without jarring length changes.
export function timeAgo(ms) {
  if (!ms) return '';
  const d = parseDate(ms);
  const timestamp = d.getTime();
  if (Number.isNaN(timestamp)) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  const days = Math.floor(hrs / 24);
  return `${days}일 전`;
}
