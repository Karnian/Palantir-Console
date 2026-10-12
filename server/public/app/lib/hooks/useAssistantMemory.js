import { useCallback, useEffect, useRef, useState } from '../../../vendor/hooks.module.js';
import { apiFetch } from '../api.js';
const MEMORY_BASE = '/api/session-hub/memory';
const emptyAssistantMemory = () => ({ memories: [], proposals: [], pending_count: 0 });
export function useAssistantMemory({ enabled = true, refreshKey } = {}) {
  const [data, setData] = useState(emptyAssistantMemory);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const session = useRef(null);
  const reload = useCallback(async () => {
    const context = session.current;
    if (!context) return;
    const sequence = ++context.sequence;
    setLoading(true);
    try {
      const value = await apiFetch(MEMORY_BASE, { signal: context.controller.signal, allowAppForbidden: true });
      if (session.current === context && sequence === context.sequence) {
        setData({ ...value, memories: value.memories || [], proposals: value.proposals || [] }); setError('');
      }
    } catch {
      if (session.current === context && sequence === context.sequence) setError('기억을 읽지 못했습니다.');
    } finally {
      if (session.current === context && sequence === context.sequence) setLoading(false);
    }
  }, []);
  useEffect(() => {
    setData(emptyAssistantMemory()); setError(''); setNotice(''); setBusy(false); setLoading(false);
    if (!enabled) return;
    const context = { sequence: 0, controller: new AbortController(), pending: false };
    session.current = context;
    return () => { session.current = null; context.controller.abort(); };
  }, [enabled, reload]);
  useEffect(() => { if (enabled) void reload(); }, [enabled, refreshKey, reload]);
  const mutate = async (path, method, body, success) => {
    const context = session.current;
    if (!context || context.pending) return false;
    context.pending = true; setBusy(true); setError(''); setNotice('');
    // An older list must not overwrite the post-mutation reload.
    context.sequence++;
    try {
      await apiFetch(`${MEMORY_BASE}${path}`, { method, body: JSON.stringify(body),
        signal: context.controller.signal, allowAppForbidden: true });
      if (session.current !== context) return false;
      await reload();
      if (session.current === context) setNotice(success);
      return true;
    } catch (err) {
      if (session.current !== context) return false;
      if (err.status === 409) {
        await reload();
        if (session.current === context) setNotice('기억이 바뀌었습니다. 다시 확인해 주세요.');
      } else setError('기억을 저장하지 못했습니다.');
      return false;
    } finally {
      context.pending = false;
      if (session.current === context) setBusy(false);
    }
  };
  const decide = (proposal, decision) => mutate(`/proposals/${encodeURIComponent(proposal.id)}/decision`, 'POST',
    { decision, revision: proposal.revision, content_hash: proposal.content_hash },
    decision === 'approve' ? '기억했습니다.' : '제안을 거절했습니다.');
  return { data, loading, busy, notice, error, reload, decide, mutate };
}
