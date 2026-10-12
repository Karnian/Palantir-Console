import { useEffect, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';
import { startObserveEntry } from '../workBoard.js';

export function useObserveEntry() {
  const [sessionHubActive, setSessionHubActive] = useState(false);
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
  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/health', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setSessionHubActive(data.sessionHubActive === true);
    }).catch(() => {});
    return () => controller.abort();
  }, []);
  return { ...entry, sessionHubActive };
}
