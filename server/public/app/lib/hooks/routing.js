// hooks/routing.js — hash routing primitives.

import { useState, useEffect } from '../../../vendor/hooks.module.js';

// Operator roster is the default landing view when the user opens the
// app with no hash. Manager remains a first-class route for Master-card
// access and operator deep links, but it is no longer top-level nav chrome.
//
// Users with a bookmarked hash (e.g. #board, #dashboard) are unaffected:
// `location.hash.slice(1)` returns the existing hash as-is. Only the
// empty-hash case lands on the Operator roster.
const DEFAULT_ROUTE = 'operator';

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
