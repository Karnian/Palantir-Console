// NAV_ITEMS — shared navigation item array.
// Extracted from app.js to break the circular dependency between app.js
// and CommandPalette.js (app.js imports CommandPalette, CommandPalette
// needs NAV_ITEMS).
//
// Phase K-1a (2026-04-27): `label` reads from `NAV_LABELS` in
// `app/lib/copy.js` so a future locale flip touches one file. The
// hash + icon stay route-shaped here.
//
// Nav consolidation: top-level codebases live under the operator group.
// skills / presets / mcp-servers / specialist / operator-profiles are also
// collapsed into 2 tab groups:
//   - resources (#resources) — sub-tabs: nodes · skills · presets · mcp-servers
//   - operator  (#operator)  — sub-tabs: roster · codebases · profiles · specialist
// `NAV_SUB_ITEMS` exposes the canonical sub-entries for CommandPalette
// search. Number-key shortcuts still use only NAV_ITEMS.

import { NAV_LABELS } from './copy.js';

export const NAV_ITEMS = [
  { hash: 'dashboard',   icon: '◉', label: NAV_LABELS.dashboard },
  { hash: 'operator',    icon: '✸', label: NAV_LABELS.operator },
  { hash: 'board',       icon: '▒', label: NAV_LABELS.board },
  { hash: 'resources',   icon: '❖', label: NAV_LABELS.resources },
  { hash: 'memory',      icon: '◈', label: NAV_LABELS.memory },
];

// Sub-items for CommandPalette search — deep-linkable canonical hashes.
// Number-key shortcuts in CommandPalette are NOT wired to these
// (only NAV_ITEMS carries the numbered shortcuts).
export const NAV_SUB_ITEMS = [
  { hash: 'resources/nodes',       icon: '⬢', label: NAV_LABELS.nodes },
  { hash: 'resources/skills',      icon: '♢', label: NAV_LABELS.skills },
  { hash: 'resources/presets',     icon: '❖', label: NAV_LABELS.presets },
  { hash: 'resources/mcp-servers', icon: '⦿', label: NAV_LABELS['mcp-servers'] },
  { hash: 'operator/roster',       icon: '✸', label: NAV_LABELS['operator-roster'] },
  { hash: 'operator/codebases',    icon: '▣', label: NAV_LABELS['operator-codebases'] },
  { hash: 'operator/profiles',     icon: '⊙', label: NAV_LABELS['operator-profiles'] },
  { hash: 'operator/specialist',   icon: '✸', label: NAV_LABELS.specialist },
];
