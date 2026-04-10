// EmptyState — minimal empty-state widget. Extracted from the legacy
// app.js monolith as part of P3-2 (ESM phase 2).
//
import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

export function EmptyState({ icon, text, sub }) {
  return html`
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${text}</div>
      ${sub && html`<div class="empty-state-sub">${sub}</div>`}
    </div>
  `;
}
