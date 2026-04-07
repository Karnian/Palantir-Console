// Palantir Console — module entry.
//
// Phase 4 (frontend ESM split) is being introduced incrementally. This file is
// the new ES-module entry point: it pulls Preact + hooks + htm via the vendor
// ESM bundles, exposes them on window globals (the same names app.js already
// uses — `preact`, `preactHooks`, `htm`), then loads the legacy app.js bundle
// as a classic script. The bridge lets us migrate helpers/hooks/components
// out of app.js into ES modules one at a time without rewriting the whole
// 3800-line file in a single commit.
//
// We deliberately use fully relative paths instead of an import map. The
// existing CSP (`script-src 'self'`) refuses any inline `<script>`, including
// `<script type="importmap">`, so an inline importmap would either need a
// hash entry per change or `'unsafe-inline'`. The bare `"preact"` specifier
// inside vendor/hooks.module.js was rewritten to a relative path for the
// same reason — see the patch comment in that file.

import * as preactNs from '../vendor/preact.module.js';
import * as preactHooksNs from '../vendor/hooks.module.js';
import htmFactory from '../vendor/htm.module.js';

import { formatDuration, formatTime, timeAgo } from './lib/format.js';
import { renderMarkdown } from './lib/markdown.js';
import { apiFetch } from './lib/api.js';

// Re-expose the same globals app.js currently consumes. The shape mirrors
// the UMD bundles (window.preact, window.preactHooks, window.htm).
window.preact = preactNs;
window.preactHooks = preactHooksNs;
window.htm = htmFactory;

// Helpers extracted out of app.js into ES modules. We bridge them onto
// window so the legacy app.js (still a classic script) can keep using the
// same identifiers without changing every call site. As more of app.js
// migrates to ES modules, these bridges become straight imports.
window.formatDuration = formatDuration;
window.formatTime = formatTime;
window.timeAgo = timeAgo;
window.renderMarkdown = renderMarkdown;
window.apiFetch = apiFetch;

// Load app.js as a classic script after the globals are in place. We use a
// dynamic <script> tag (rather than `import './app.js'`) because app.js is
// still a non-module bundle that relies on top-level globals. Once helpers
// and hooks are extracted into modules, app.js itself will become a module
// and this loader can be deleted.
const legacy = document.createElement('script');
legacy.src = './app.js';
legacy.defer = false; // module script already runs after DOMContentLoaded
document.head.appendChild(legacy);
