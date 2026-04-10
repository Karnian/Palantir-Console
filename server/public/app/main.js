// Palantir Console — ESM bootstrapper.
//
// Configures the marked markdown renderer, then loads the app shell.
// All component and hook imports are handled by direct ES module imports
// within the dependency graph rooted at app.js.

import { configureMarked } from './lib/markdown.js';

// Apply marked's global options once at boot. window.marked is loaded
// via <script> tag in index.html before this module runs.
configureMarked();

// Load the app shell, which imports all components and hooks directly.
await import('../app.js');
