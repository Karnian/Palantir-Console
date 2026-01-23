const fs = require('fs/promises');

function createMessageService(storage) {
  function truncateText(text, limit = 1200) {
    if (typeof text !== 'string') return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n... [truncated]`;
  }

  function summarizeToolInput(input) {
    if (!input) return '';
    if (typeof input === 'string') return input;
    if (typeof input !== 'object') return String(input);
    if (input.command) return input.command;
    if (input.filePath) return input.filePath;
    if (input.path) return input.path;
    if (input.url) return input.url;
    if (input.query) return input.query;
    try {
      return JSON.stringify(input);
    } catch (error) {
      return '';
    }
  }

  function formatToolPart(part) {
    const toolName = part.tool || 'tool';
    const title = part.state?.title || part.state?.metadata?.description || '';
    const header = title ? `[tool:${toolName}] ${title}` : `[tool:${toolName}]`;
    const inputLine = summarizeToolInput(part.state?.input);
    const outputSource = part.state?.metadata?.preview || part.state?.output || part.state?.metadata?.output || '';
    const output = truncateText(outputSource);

    const lines = [header];
    if (inputLine) lines.push(`input: ${inputLine}`);
    if (output) lines.push(`output:\n${output}`);
    return lines.join('\n');
  }

  function mergeParts(parts) {
    return parts
      .map((part) => {
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        if (part.type === 'reasoning' && typeof part.text === 'string' && part.text.trim()) {
          return part.text;
        }
        if (part.type === 'tool') {
          return formatToolPart(part);
        }
        return '';
      })
      .filter((chunk) => chunk && chunk.trim())
      .join('\n\n');
  }

  function sortByCreated(a, b) {
    const aTime = a?.time?.created || 0;
    const bTime = b?.time?.created || 0;
    return aTime - bTime;
  }

  async function loadSessionMessages(sessionId, limit = 200) {
    const metas = await storage.getMessageMetas(sessionId);
    metas.sort(sortByCreated);
    const slice = metas.slice(Math.max(0, metas.length - limit));
    const messages = [];

    for (const meta of slice) {
      const parts = await storage.loadMessageParts(meta.id);
      const content = mergeParts(parts);
      messages.push({
        id: meta.id,
        sessionId: meta.sessionID,
        role: meta.role,
        createdAt: meta?.time?.created || null,
        completedAt: meta?.time?.completed || null,
        agent: meta.agent || meta.mode || null,
        providerId: meta.providerID || meta.model?.providerID || null,
        modelId: meta.modelID || meta.model?.modelID || null,
        path: meta.path || null,
        content
      });
    }

    return messages;
  }

  async function resolveCwd(sessionDir) {
    if (!sessionDir) return process.cwd();
    try {
      await fs.access(sessionDir);
      return sessionDir;
    } catch (error) {
      return process.cwd();
    }
  }

  return {
    loadSessionMessages,
    resolveCwd
  };
}

module.exports = { createMessageService };
