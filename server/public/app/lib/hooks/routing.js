// hooks/routing.js — hash routing primitives.

const { useState, useEffect } = window.preactHooks;

export function useRoute() {
  const getHash = () => location.hash.slice(1) || 'dashboard';
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
