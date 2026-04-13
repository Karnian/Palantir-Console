// NAV_ITEMS — shared navigation item array.
// Extracted from app.js to break the circular dependency between app.js
// and CommandPalette.js (app.js imports CommandPalette, CommandPalette
// needs NAV_ITEMS).

export const NAV_ITEMS = [
  { hash: 'dashboard', icon: '\u25C9', label: 'Dashboard' },
  { hash: 'manager',   icon: '\u2726', label: 'Manager' },
  { hash: 'board',     icon: '\u2592', label: 'Task Board' },
  { hash: 'projects',  icon: '\u25A3', label: 'Projects' },
  { hash: 'agents',    icon: '\u2699', label: 'Agents' },
  { hash: 'skills',    icon: '\u2662', label: 'Skill Packs' },
];
