// hooks/utils.js — UI utility hooks (useEscape).

const { useRef, useEffect } = window.preactHooks;

// Module-level stack so nested modals don't all react to the same Escape key.
// When two modals are open (e.g. ProjectDetailModal -> TaskDetailPanel on top),
// pressing Escape should only close the topmost one. We track each active
// useEscape registration in mount order; the handler short-circuits unless its
// own entry is at the top of the stack.
//
// IMPORTANT: the effect dep list intentionally OMITS `onClose`. Call sites
// usually pass a fresh inline arrow on every render, which would otherwise
// tear down and re-push the entry on every parent rerender (SSE reloads,
// minute tickers, etc.) and shuffle the stack — making Escape close the
// wrong modal layer. We read `onClose` through a ref so the registration
// lifetime stays bound to the modal's actual mount lifetime.
const _escapeStack = [];

export function useEscape(open, onClose) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const entry = { fire: () => onCloseRef.current?.() };
    _escapeStack.push(entry);
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (_escapeStack[_escapeStack.length - 1] !== entry) return;
      entry.fire();
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
      const idx = _escapeStack.indexOf(entry);
      if (idx >= 0) _escapeStack.splice(idx, 1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
