import { h } from '../../../vendor/preact.module.js';
import { useState, useEffect } from '../../../vendor/hooks.module.js';
import htm from '../../../vendor/htm.module.js';
import { OWNED_COPY } from '../../lib/copy.js';
import { renderMarkdown } from '../../lib/markdown.js';
import { ownedFullText } from './client.js';
import { parseOwnedJson } from './format.js';
const html = htm.bind(h);

function OwnedMessageBlock({ block }) {
  if (block.type === 'text') {
    return html`<div dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text || '') }} />`;
  }
  return html`
    <details>
      <summary>${OWNED_COPY.tools} ${block.name || block.tool_use_id || ''}</summary>
      <pre>${JSON.stringify(block, null, 2)}</pre>
    </details>
  `;
}

export function OwnedMessage({ event, sessionId, uncertain }) {
  const [content, setContent] = useState(event.json || (!event.truncated && parseOwnedJson(event.preview)));
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    if (!content) {
      ownedFullText(sessionId, 'event', event.seq).then(text => {
        if (active) setContent(parseOwnedJson(text));
      }, () => {
        if (active) setError(true);
      });
    }
    return () => {
      active = false;
    };
  }, [event.seq, sessionId]);

  const message = content?.message;
  if (!message) return html`<p>${error ? OWNED_COPY.fullError : OWNED_COPY.loading}</p>`;
  if (message.type === 'user') {
    const results = message.message?.content || [];
    if (!Array.isArray(results) || !results.some(result => result.type === 'tool_result')) return null;
  }
  const blocks = message.message?.content;
  let messageBody = html`
    <details><summary>${OWNED_COPY.tools}</summary><pre>${JSON.stringify(message, null, 2)}</pre></details>
  `;
  if (Array.isArray(blocks)) {
    messageBody = blocks.map(block => html`<${OwnedMessageBlock} block=${block} />`);
  }
  return html`
    <article class="owned-message">
      ${uncertain && message.type === 'result' && html`<strong>${OWNED_COPY.unattributed}</strong>`}
      ${messageBody}
    </article>
  `;
}
