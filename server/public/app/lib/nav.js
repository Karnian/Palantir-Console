// NAV_ITEMS — shared navigation item array.
// Extracted from app.js to break the circular dependency between app.js
// and CommandPalette.js (app.js imports CommandPalette, CommandPalette
// needs NAV_ITEMS).

export const NAV_ITEMS = [
  { hash: 'dashboard', icon: '◉', label: 'Dashboard' },
  { hash: 'manager',   icon: '✦', label: 'Manager' },
  { hash: 'board',     icon: '▒', label: 'Task Board' },
  { hash: 'projects',  icon: '▣', label: 'Projects' },
  { hash: 'agents',    icon: '⚙', label: 'Agents' },
  { hash: 'skills',    icon: '♢', label: 'Skill Packs' },
  { hash: 'presets',   icon: '❖', label: 'Presets' },
  { hash: 'mcp-servers', icon: '⦿', label: 'MCP Servers' },
];
