// NAV_ITEMS — shared navigation item array.
// Extracted from app.js to break the circular dependency between app.js
// and CommandPalette.js (app.js imports CommandPalette, CommandPalette
// needs NAV_ITEMS).
//
// Phase K-1a (2026-04-27): `label` reads from `NAV_LABELS` in
// `app/lib/copy.js` so a future locale flip touches one file. The
// hash + icon stay route-shaped here.

import { NAV_LABELS } from './copy.js';

export const NAV_ITEMS = [
  { hash: 'dashboard',   icon: '◉', label: NAV_LABELS.dashboard },
  { hash: 'manager',     icon: '✦', label: NAV_LABELS.manager },
  { hash: 'board',       icon: '▒', label: NAV_LABELS.board },
  { hash: 'projects',    icon: '▣', label: NAV_LABELS.projects },
  { hash: 'agents',      icon: '⚙', label: NAV_LABELS.agents },
  { hash: 'skills',      icon: '♢', label: NAV_LABELS.skills },
  { hash: 'presets',     icon: '❖', label: NAV_LABELS.presets },
  { hash: 'mcp-servers', icon: '⦿', label: NAV_LABELS['mcp-servers'] },
];
