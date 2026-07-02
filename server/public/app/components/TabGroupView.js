// TabGroupView — sub-tab shell for grouped nav sections.
//
// Props:
//   groupHash  {string}  — the top-level hash, e.g. 'resources'
//   subRoute   {string}  — active sub-key, e.g. 'skills'
//   tabs       {Array}   — [{ key, label, render }]
//
// A11y: uses role="group" + aria-current="true" on the active button,
// mirroring the BoardModeTabs pattern in BoardView.js. We intentionally
// avoid role="tablist"/role="tab"/aria-controls because we only render the
// ACTIVE panel — inactive aria-controls targets would be absent from the DOM,
// producing invalid ARIA (axe aria-valid-attr-value). plain <button> elements
// get natural Enter/Space activation and natural Tab-order without any
// roving-tabindex contract.
//
// Deep-link navigation: clicking a tab calls navigate(`${groupHash}/${key}`),
// which the App routing useEffect resolves to the correct sub-route.

import { h } from '../../vendor/preact.module.js';
import htm from '../../vendor/htm.module.js';
const html = htm.bind(h);

import { navigate } from '../lib/hooks.js';

export function TabGroupView({ groupHash, subRoute, tabs }) {
  const activeTab = tabs.find(t => t.key === subRoute) || tabs[0];

  return html`
    <div class="tab-group-view" data-view=${groupHash}>
      <div
        class="sub-tabs"
        role="group"
        aria-label=${groupHash + ' navigation'}
      >
        ${tabs.map(t => html`
          <button
            key=${t.key}
            class=${'sub-tab' + (t.key === activeTab.key ? ' active' : '')}
            aria-current=${t.key === activeTab.key ? 'true' : undefined}
            onClick=${() => navigate(groupHash + '/' + t.key)}
          >${t.label}</button>
        `)}
      </div>
      <div class="sub-tab-panel">
        ${activeTab.render()}
      </div>
    </div>
  `;
}
