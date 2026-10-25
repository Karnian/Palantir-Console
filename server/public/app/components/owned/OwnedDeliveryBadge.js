import { h } from '../../../vendor/preact.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { ownedLabel } from './format.js';
const html = htm.bind(h);

export function OwnedDeliveryBadge({ delivery }) {
  const uncertain = delivery.state === 'unknown' || delivery.outcome === 'outcome_unknown';
  const status = delivery.state === 'unknown' ? OWNED_COPY.deliveryUnknown : ownedLabel(delivery.state);
  const outcome = delivery.outcome ? ` · ${ownedLabel(delivery.outcome)}` : '';
  const hasToolResult = ['tool_finished', 'tool_finished_error'].includes(delivery.reason);
  const toolResult = hasToolResult ? ` · ${ownedLabel(delivery.reason)}` : '';
  return html`<span class=${uncertain ? 'owned-unknown' : ''}>${status}${outcome}${toolResult}</span>`;
}
