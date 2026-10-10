import { useEffect, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';
import { startObserveEntry } from '../workBoard.js';

export function useObserveEntry() {
  const [entry, setEntry] = useState({ activation: 'pending', loading: !location.hash });
  useEffect(() => startObserveEntry({
    request: apiFetch,
    getHash: () => location.hash,
    navigate: hash => { location.hash = hash; },
    subscribe: listener => {
      window.addEventListener('hashchange', listener);
      return () => window.removeEventListener('hashchange', listener);
    },
    publish: setEntry,
  }), []);
  return entry;
}
