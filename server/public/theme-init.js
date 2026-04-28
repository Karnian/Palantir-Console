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
  // K-2d (Codex r1 P2): mobile browser chrome color also tracks the
  // active theme. The two media-scoped <meta name="theme-color"> tags
  // in index.html only follow the OS preference; explicit toggle
  // wouldn't update them and the user would see e.g. dark CSS with
  // light mobile chrome on a light-OS device. We patch the active
  // value here on first paint when an explicit override is loaded.
  function applyThemeColor(mode) {
    var color = mode === 'light' ? '#fafafa' : '#09090b';
    var nodes = document.querySelectorAll('meta[name="theme-color"]');
    if (!nodes || nodes.length === 0) return;
    // Replace the two media-scoped tags with a single unscoped one
    // so neither the dark nor light media query overrides the
    // explicit choice. Removing media beats setContent because Safari
    // ignores theme-color on a tag whose media doesn't match.
    for (var i = nodes.length - 1; i >= 0; i--) nodes[i].parentNode.removeChild(nodes[i]);
    var meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', color);
    document.head.appendChild(meta);
  }

  try {
    var v = window.localStorage && window.localStorage.getItem('palantir.theme');
    if (v === 'light' || v === 'dark') {
      document.documentElement.setAttribute('data-theme', v);
      applyThemeColor(v);
    }
  } catch (e) {
    /* localStorage unavailable — leave default theme */
  }
})();
