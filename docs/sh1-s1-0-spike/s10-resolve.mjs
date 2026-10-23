import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
const cwd = process.argv[2];
const r = await resolveSettings({ cwd });
console.log('effective.env keys:', Object.keys(r.effective.env || {}));
console.log('effective.apiKeyHelper:', r.effective.apiKeyHelper);
console.log('provenance env/apiKeyHelper/hooks:', JSON.stringify({ env: r.provenance.env, apiKeyHelper: r.provenance.apiKeyHelper, hooks: r.provenance.hooks }));
console.log('hook events:', Object.keys(r.effective.hooks || {}));
console.log('sources:', r.sources.map((s) => `${s.source}${s.path ? ':' + s.path.replace(process.env.HOME, '~') : ''}`).join(' | '));
