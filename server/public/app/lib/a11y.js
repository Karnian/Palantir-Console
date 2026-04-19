/**
 * Keyboard-accessible click props for non-button elements.
 * Spread onto a <div> or similar to make it operable via Enter/Space.
 */
export function clickableProps(handler) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: handler,
    onKeyDown: (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        handler(e);
      }
    },
  };
}
