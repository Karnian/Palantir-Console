// hooks/index.js — barrel re-export for backward compatibility.
// All consumers that imported from './hooks.js' continue to work
// after the thin re-exporter in hooks.js forwards here.

export { useRoute, navigate } from './routing.js';
export { useEscape } from './utils.js';
export { sseBroker, useSSE } from './sse.js';
export { useTasks, useRuns, useProjects, useClaudeSessions, useAgents } from './data.js';
export { useConversation } from './conversation.js';
export { useDispatchAudit } from './dispatch.js';
export { useManagerLifecycle } from './manager.js';
