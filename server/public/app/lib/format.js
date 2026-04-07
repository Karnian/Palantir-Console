// Pure date/duration formatters used by app.js. Extracted from the legacy
// monolith as part of the Phase 4 frontend split. No DOM, no globals, no fetch
// — safe to import from any module or test directly.

export function formatDuration(ms) {
  if (!ms || ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

// Accepts both numeric ms timestamps and ISO/SQLite datetime strings.
// SQLite emits 'YYYY-MM-DD HH:MM:SS' (no timezone) — we treat those as UTC,
// the same convention the server writes them in.
export function formatTime(ms) {
  if (!ms) return 'unknown';
  const d = typeof ms === 'string' ? new Date(ms.replace(' ', 'T') + 'Z') : new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString();
}

export function timeAgo(ms) {
  if (!ms) return '';
  const timestamp = typeof ms === 'string' ? new Date(ms.replace(' ', 'T') + 'Z').getTime() : ms;
  if (Number.isNaN(timestamp)) return '';
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
