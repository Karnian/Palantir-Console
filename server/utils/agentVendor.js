function resolveAgentVendor(command) {
  const cmd = String(command || '').toLowerCase();
  if (cmd.includes('claude')) return 'claude';
  if (cmd.includes('codex')) return 'codex';
  if (cmd.includes('gemini')) return 'gemini';
  return 'other';
}

module.exports = { resolveAgentVendor };
