// hooks/routing.js — hash routing primitives.

import { useState, useEffect } from '../../../vendor/hooks.module.js';

// Attention Dashboard is the default landing view when the user opens the
// app with no hash — a control hub's first screen should answer "does
// anything need me right now" before "what's actively running" (user
// decision, superseding PR #338's operator-centric default). Operator
// roster and Manager remain first-class routes, just not the landing one.
//
// Users with a bookmarked hash (e.g. #board, #operator) are unaffected:
// `location.hash.slice(1)` returns the existing hash as-is. Only the
// empty-hash case lands on the Attention Dashboard.
const DEFAULT_ROUTE = 'dashboard';

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
