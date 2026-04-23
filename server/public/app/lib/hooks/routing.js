// hooks/routing.js — hash routing primitives.

import { useState, useEffect } from '../../../vendor/hooks.module.js';

// R2-C.3 (stretch): Manager is now the default landing view when the
// user opens the app with no hash. Dashboard is still a first-class
// destination — navigable via the sidebar or directly via #dashboard —
// but the first-touch surface now matches the spec's core thesis
// ("chat-first orchestration, attention routing > read-only viewer").
//
// Users with a bookmarked hash (e.g. #board, #dashboard) are unaffected:
// `location.hash.slice(1)` returns the existing hash as-is. Only the
// empty-hash case lands on Manager.
const DEFAULT_ROUTE = 'manager';

export function useRoute() {
  const getHash = () => location.hash.slice(1) || DEFAULT_ROUTE;
  const [route, setRoute] = useState(getHash);
  useEffect(() => {
    const onHash = () => setRoute(getHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

export function navigate(hash) {
  location.hash = hash;
}
