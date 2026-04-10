// notifications.js — Browser notification + tab title pulse utilities.
// Extracted from server/public/app.js as part of P7-4 (ESM phase 6).
//
// No Preact/HTM dependencies — pure browser JS.
// Bridged onto window by main.js before app.js loads.

// ─────────────────────────────────────────────────────────────────────────────
// Browser Notifications
// ─────────────────────────────────────────────────────────────────────────────

let notificationPermissionRequested = false;

export function requestNotificationPermission() {
  if (notificationPermissionRequested) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    notificationPermissionRequested = true;
    Notification.requestPermission();
  }
}

export function showBrowserNotification(title, body) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: undefined });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab Title Pulse
// ─────────────────────────────────────────────────────────────────────────────

// v3 Phase 5: tab title pulse for priority alerts (spec §9.8 mandates
// "탭 타이틀 변경" as part of the priority-alert UX on top of OS
// notification). We briefly flip document.title to an alert string so
// an unfocused tab shows the new state in the browser tab strip, then
// restore the original title after a short window OR immediately on
// focus so the user isn't left with a dangling alert after they come
// back. A single-shot global timer is enough — overlapping alerts
// simply reset the window.
let _tabTitleOriginal = null;
let _tabTitleTimer = null;
let _tabTitleFocusHandler = null;

export function pulseTabTitle(alertText, durationMs = 20000) {
  if (typeof document === 'undefined') return;
  if (_tabTitleOriginal == null) {
    _tabTitleOriginal = document.title;
  }
  // If the tab is already focused, there's no point flipping the
  // title — the user is here. Skip.
  if (typeof document.hasFocus === 'function' && document.hasFocus()) {
    return;
  }
  document.title = alertText;
  clearTimeout(_tabTitleTimer);
  const restore = () => {
    if (_tabTitleOriginal != null) {
      document.title = _tabTitleOriginal;
      _tabTitleOriginal = null;
    }
    if (_tabTitleFocusHandler) {
      window.removeEventListener('focus', _tabTitleFocusHandler);
      _tabTitleFocusHandler = null;
    }
  };
  _tabTitleTimer = setTimeout(restore, durationMs);
  if (!_tabTitleFocusHandler) {
    _tabTitleFocusHandler = restore;
    window.addEventListener('focus', _tabTitleFocusHandler);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-request permission on first user interaction (module side-effect)
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  const requestOnce = () => {
    requestNotificationPermission();
    document.removeEventListener('click', requestOnce);
    document.removeEventListener('keydown', requestOnce);
  };
  document.addEventListener('click', requestOnce);
  document.addEventListener('keydown', requestOnce);
}
