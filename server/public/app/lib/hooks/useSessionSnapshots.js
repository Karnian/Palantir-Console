import { useEffect, useRef, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';
import { snapshotCards, loadSessionSnapshots } from '../workBoard.js';

const emptyPanelLoad = () => ({ entries: [], snapshots: [], failures: [], done: 0, total: 0, rev: null });

export function useSessionSnapshots(onData) {
  const [load, setLoad] = useState(emptyPanelLoad);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const current = ++generation.current;
    setLoad(emptyPanelLoad()); setLoading(true); setError(false);
    onData?.({ cards: [], rev: null });
    loadSessionSnapshots(apiFetch, controller.signal, next => {
      if (!controller.signal.aborted && generation.current === current) {
        setLoad(next);
        onData?.({ cards: next.snapshots.flatMap(snapshotCards), rev: next.rev });
      }
    }).catch(() => {
      if (!controller.signal.aborted && generation.current === current) {
        setLoad(emptyPanelLoad()); setError(true); onData?.({ cards: [], rev: null });
      }
    }).finally(() => {
      if (!controller.signal.aborted && generation.current === current) setLoading(false);
    });
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => { generation.current++; controller.abort(); clearInterval(timer); };
  }, [revision]);
  return { load, loading, error, now, reload: () => setRevision(value => value + 1) };
}
