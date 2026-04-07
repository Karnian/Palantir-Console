// Markdown rendering with sanitization. Depends on the `marked` and
// `DOMPurify` globals injected by the CDN <script> tags in index.html.
// When either lib hasn't loaded (e.g. test fixtures, blocked CDN), we fall
// back to a literal HTML-escape so callers always get a string they can
// safely set via `dangerouslySetInnerHTML`.

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
