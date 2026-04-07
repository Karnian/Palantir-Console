// Markdown rendering with sanitization. Depends on the `marked` and
// `DOMPurify` globals injected by the CDN <script> tags in index.html.
// When either lib hasn't loaded (e.g. test fixtures, blocked CDN), we fall
// back to a literal HTML-escape so callers always get a string they can
// safely set via `dangerouslySetInnerHTML`.

// Single source of truth for marked's render flags. Exported so legacy paths
// (or future call sites) can use the same shape without duplicating it.
export const MARKDOWN_OPTIONS = { breaks: true, gfm: true };

// Idempotent: safe to call any number of times. main.js calls this once at
// boot so the global `marked` setting matches MARKDOWN_OPTIONS — that lets
// other call sites in app.js (legacy session renderers) call `marked.parse`
// without re-passing the options every time.
export function configureMarked() {
  if (window.marked && typeof window.marked.setOptions === 'function') {
    window.marked.setOptions(MARKDOWN_OPTIONS);
  }
}

export function renderMarkdown(text) {
  if (!text) return '';
  if (window.marked && window.DOMPurify) {
    const html = window.marked.parse(text, { breaks: true, gfm: true });
    return window.DOMPurify.sanitize(html);
  }
  // Fallback: escape HTML and convert newlines
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}
