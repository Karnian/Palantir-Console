// EmptyState — minimal empty-state widget.
//
// API: { icon, text, sub } — use these names. `title`/`description`/`subtitle`
// aliases are accepted for callers that followed HTML5 <hgroup>-ish naming,
// but canonical shape is text/sub. Passing an unknown prop is silently
// ignored, so we normalise here to catch drift (aphrodite+codex review,
// 2026-04-24).
import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

export function EmptyState(props) {
  const icon = props.icon;
  const text = props.text ?? props.title;
  const sub = props.sub ?? props.description ?? props.subtitle;
  return html`
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-text">${text}</div>
      ${sub && html`<div class="empty-state-sub">${sub}</div>`}
    </div>
  `;
}
