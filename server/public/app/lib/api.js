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
  // `allowAppForbidden` — opt in to distinguishing an APPLICATION 403 from an
  // auth 403 (task_85d43f96). /api/fs answers 403 for "that path is outside
  // the node's exposed_roots" and "permission denied on the node", which the
  // directory picker has to render in place; bouncing the operator to the
  // login page for a mistyped path would be nonsense. The discriminator is
  // the machine-readable `reason` field: the auth middleware rejects before
  // any route runs, so an auth 403 can never carry one. Stripped here so it
  // never reaches fetch().
  // `headers` must be pulled out of the rest object too. It used to stay in
  // `fetchOpts`, and because that spread comes AFTER `headers:` below, a caller
  // that passed any custom header replaced the merged object wholesale and lost
  // `Content-Type: application/json`. express.json() then skipped the body, so
  // the route saw `{}` — POST /api/conversations/:id/message answered 400
  // "text or images is required" for every message sent from the Manager chat
  // (its Idempotency-Key was the only custom header in the app).
  // Normalize through Headers rather than object spread: HeaderInit is also
  // allowed to be a Headers instance or an array of tuples, and header names
  // are case-insensitive — a caller passing `content-type` must REPLACE the
  // default, not end up combined with it as `application/json, text/plain`.
  const { allowAppForbidden = false, headers: callerHeaders, ...fetchOpts } = opts;
  const headers = new Headers(callerHeaders || undefined);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, { credentials: 'same-origin', ...fetchOpts, headers });
  // Auth failures → bounce to login. We normally check the status BEFORE
  // trying to parse JSON, because middleware may respond with { error } HTML
  // in some proxy setups; the opt-in path above has to peek at the body first.
  let data;
  let parsed = false;
  if (res.status === 401 || res.status === 403) {
    if (allowAppForbidden) {
      try { data = await res.json(); parsed = true; } catch { /* unparseable ⇒ treat as auth */ }
    }
    const appDenial = res.status === 403
      && parsed
      && data
      && typeof data.reason === 'string'
      && data.reason.trim().length > 0;
    // Skip the redirect for the auth endpoints themselves (login/logout)
    // so login.html can handle its own error display.
    if (!appDenial && !url.startsWith('/api/auth/')) {
      redirectToLogin();
      // Still throw so the caller's catch runs and the page stops trying
      // to render stale data before the navigation actually happens.
      throw new Error('Not authenticated');
    }
  }
  if (!parsed) {
    try { data = await res.json(); }
    catch {
      const err = new Error(`Request failed: ${res.status}`);
      err.status = res.status;
      throw err;
    }
  }
  if (!res.ok) {
    // Preserve status + parsed body so callers can map specific failures to
    // friendly messages (e.g. ProjectsView 409/400/502 warm errors,
    // repoPreflightMessage reason codes). Message stays backward-compatible.
    const err = new Error(data.error || `Request failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    if (data && data.reason !== undefined) err.reason = data.reason;
    throw err;
  }
  return data;
}
