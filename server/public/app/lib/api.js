// Thin JSON API client used by every page-level data hook in app.js.
//
// Auth model (post PR1 / NEW-S1):
//   - If the server has PALANTIR_TOKEN configured, browsers authenticate via
//     an HttpOnly `palantir_token` cookie set by POST /api/auth/login. Once
//     the cookie is present, fetch() and EventSource() both carry it
//     automatically (same-origin) — the only way SSE can work under auth,
//     because EventSource cannot send custom headers.
//   - The token is obtained via the standalone /login.html page. We do NOT
//     accept a `?token=` query parameter here: Codex PR1 review flagged
//     that as a blocker because the very first document request still
//     carries the token in the URL, which leaks into reverse proxy access
//     logs and (without Referrer-Policy) potentially into Referer headers
//     to third-party font hosts. login.html uses a POST form so the token
//     never appears in any URL.
//   - CLI / tests / any non-browser consumer can still use the classic
//     `Authorization: Bearer <tok>` header — the server middleware accepts
//     either path.
//
// Intentionally NOT bundled with `apiFetchWithToast`: that wrapper depends
// on the toast state, which lives in app.js. Pulling toast into a module
// is a separate refactor.

function redirectToLogin() {
  // Preserve where the user was trying to go so we can deep-link them back.
  const here = location.pathname + location.search + location.hash;
  const next = encodeURIComponent(here);
  location.replace(`/login.html?next=${next}`);
}

export async function apiFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const res = await fetch(url, { headers, credentials: 'same-origin', ...opts });
  // Auth failures → bounce to login. We check the status BEFORE trying to
  // parse JSON, because middleware may respond with { error } HTML in some
  // proxy setups.
  if (res.status === 401 || res.status === 403) {
    // Skip the redirect for the auth endpoints themselves (login/logout)
    // so login.html can handle its own error display.
    if (!url.startsWith('/api/auth/')) {
      redirectToLogin();
      // Still throw so the caller's catch runs and the page stops trying
      // to render stale data before the navigation actually happens.
      throw new Error('Not authenticated');
    }
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`Request failed: ${res.status}`); }
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}
