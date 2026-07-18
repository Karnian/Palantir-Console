// Login form handler. Extracted from an inline <script> in login.html because
// the app CSP is `script-src 'self'` (no 'unsafe-inline'/nonce) — the inline
// script was silently BLOCKED, so the form's submit listener never attached and
// clicking "Sign in" fell back to a native GET (`login.html?token=…`), which
// never authenticates. Serving it as a same-origin file satisfies the CSP,
// matching the rest of the app (theme-init.js, app/main.js, vendor/*).
//
// This page exists so the token NEVER appears in a URL, Referer header, or
// access log. The old ?token= bootstrap path was Codex-flagged as a blocker
// (PR1 review): even with history.replaceState cleanup, the first document
// request already hit reverse proxy logs with the token in the query string.
//
// We POST the token to /api/auth/login, which sets an HttpOnly cookie and then
// we redirect to /. Zero token exposure in URLs.
const form = document.getElementById('login');
const input = document.getElementById('token');
const btn = document.getElementById('submit');
const err = document.getElementById('err');

function showError(msg) {
  err.textContent = msg;
  err.classList.add('visible');
}

// Strict same-origin path whitelist for the post-login redirect.
// Codex PR1 R2 flagged the naive `location.replace(next)` as an
// open-redirect / script sink: `?next=javascript:...` would execute
// attacker JS in the app origin with the fresh auth cookie in scope.
// Acceptable shapes:
//   - "/"                              → root
//   - "/#dashboard"                    → root + hash
//   - "/any/path"                      → same-origin path
//   - "/path?foo=bar#hash"             → same-origin with query/hash
// Rejected (fall back to "/"):
//   - "javascript:...", "data:...", "vbscript:..." (any scheme)
//   - "//evil.example" (protocol-relative, network-authority)
//   - "https://evil.example/..." (absolute URL)
//   - anything that fails URL parsing relative to the current origin
function sanitizeNext(raw) {
  if (!raw || typeof raw !== 'string') return '/';
  if (!raw.startsWith('/')) return '/';       // must be absolute path
  if (raw.startsWith('//')) return '/';       // reject protocol-relative
  if (raw.startsWith('/\\')) return '/';      // reject backslash trick
  // Resolve against the current origin and make sure the result lives
  // on it. Any surprise (different host, non-http scheme) bounces to /.
  try {
    const u = new URL(raw, location.origin);
    if (u.origin !== location.origin) return '/';
    if (u.protocol !== location.protocol) return '/';
    // Reconstruct from the URL's parsed components. pathname always
    // starts with "/" after WHATWG normalization, so we cannot produce
    // a protocol-relative output — but belt and suspenders, explicitly
    // reject any result that does. Catches cases like
    // `/..//dashboard` that the regex allowlist above lets through
    // (Codex PR1 R3 suggestion #1 regression case).
    const out = u.pathname + u.search + u.hash;
    if (!out.startsWith('/') || out.startsWith('//')) return '/';
    return out;
  } catch {
    return '/';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.classList.remove('visible');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: input.value }),
      credentials: 'same-origin',
    });
    if (res.status === 204) {
      const raw = new URLSearchParams(location.search).get('next');
      location.replace(sanitizeNext(raw));
      return;
    }
    if (res.status === 404) {
      showError('Auth is not configured on this server.');
    } else if (res.status === 403) {
      showError('Invalid token.');
    } else {
      showError('Login failed (HTTP ' + res.status + ').');
    }
  } catch (e2) {
    showError('Network error: ' + (e2.message || 'unknown'));
  } finally {
    btn.disabled = false;
  }
});
