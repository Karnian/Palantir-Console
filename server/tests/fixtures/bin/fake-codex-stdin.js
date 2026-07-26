#!/usr/bin/env node
'use strict';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (args.includes('--bare')) {
    const candidateId = input.match(/candidateId=([^\s]+)/)?.[1] || 'missing';
    const secretKeys = Object.keys(process.env)
      .filter((key) => key.startsWith('PALANTIR_') && key.includes('TOKEN'))
      .sort();
    const contract = {
      argv: args,
      stdin: input,
      secretKeys,
      hasAuth: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    process.stdout.write(JSON.stringify([{
      candidateId,
      kind: 'heuristic',
      content: `CONTRACT:${JSON.stringify(contract)}`,
      confidence: 0.5,
      importance: 5,
    }]));
    return;
  }
  process.stdout.write(`${JSON.stringify({
    args,
    stdin: input,
  })}\n`);
});
