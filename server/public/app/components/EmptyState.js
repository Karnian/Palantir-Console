// EmptyState — minimal empty-state widget. Extracted from the legacy
// app.js monolith as part of P3-2 (ESM phase 2).
//
// Module-time dependencies (preact, htm) are pulled from window because
// main.js is responsible for assigning them BEFORE this module is
// imported — same convention as DriftDrawer.js and RunInspector.js.

const { h } = window.preact;
const html = window.htm.bind(h);

export function EmptyState({ icon, text, sub }) {
  return html`
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${text}</div>
      ${sub && html`<div class="empty-state-sub">${sub}</div>`}
    </div>
  `;
}
