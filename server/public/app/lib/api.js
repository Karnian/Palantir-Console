// Thin JSON API client used by every page-level data hook in app.js.
//
// Pulls the auth token (if any) from `?token=` in the URL once at module
// load and forwards it as `Authorization: Bearer ...` on every request.
// Throws on non-2xx so callers can `try/catch` and surface errors via
// the toast system that still lives in app.js.
//
// Intentionally NOT bundled with `apiFetchWithToast`: that wrapper depends
// on the toast state, which lives in app.js. Pulling toast into a module
// is a separate refactor.

const _authToken = (() => {
  const params = new URLSearchParams(location.search);
  return params.get('token') || null;
})();

export async function apiFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (_authToken) headers['Authorization'] = `Bearer ${_authToken}`;
  const res = await fetch(url, { headers, ...opts });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}
