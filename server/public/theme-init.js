// Phase K-2c (2026-04-28): early theme bootstrap.
//
// Loaded synchronously in <head> BEFORE styles/tokens.css so the
// `[data-theme="..."]` selector resolves on the first paint and the
// page never flashes the default dark palette before swapping to
// light (FOUC).
//
// CSP-safe: lives at /theme-init.js and loads via `<script src>`.
// Inline `<script>` would require `'unsafe-inline'` in CSP, which we
// keep out of this codebase (PR1 self-host of marked / DOMPurify
// removed the last `unsafe-inline` need).
//
// Behavior:
//   - Reads `localStorage.palantir.theme` ∈ {'light', 'dark', 'system'}.
//   - 'light' / 'dark' → set `<html data-theme="...">`.
//   - 'system' OR missing OR unknown → no attribute, browser falls
//     back to either `:root` (dark default) today or, after K-2d,
//     `@media (prefers-color-scheme: light)` for light OS users.
//
// localStorage failures (private mode, disabled storage) are
// silently ignored — the user still sees the dark default.
(function () {
  try {
    var v = window.localStorage && window.localStorage.getItem('palantir.theme');
    if (v === 'light' || v === 'dark') {
      document.documentElement.setAttribute('data-theme', v);
    }
  } catch (e) {
    /* localStorage unavailable — leave default theme */
  }
})();
