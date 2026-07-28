function parseClaudeStreamJsonOutput(rawOutput) {
  const raw = String(rawOutput || '');
  const events = [];
  const assistantTexts = [];
  let result = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    events.push(event);

    if (event.type === 'assistant' && event.message) {
      const content = Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
          assistantTexts.push(block.text);
        }
      }
      if (event.message.usage) {
        inputTokens += Number(event.message.usage.input_tokens) || 0;
        outputTokens += Number(event.message.usage.output_tokens) || 0;
      }
    }

    if (event.type === 'result') {
      result = event;
      if (event.usage) {
        inputTokens = Number(event.usage.input_tokens) || inputTokens;
        outputTokens = Number(event.usage.output_tokens) || outputTokens;
      }
      if (event.total_cost_usd != null) {
        costUsd = Number(event.total_cost_usd) || 0;
      }
    }
  }

  const resultText = typeof result?.result === 'string' ? result.result : '';
  let text = assistantTexts.join('\n');
  if (resultText && !text.includes(resultText)) {
    text = text ? `${text}\n${resultText}` : resultText;
  }

  return {
    recognized: events.length > 0,
    events,
    result,
    text,
    usage: { inputTokens, outputTokens, costUsd },
  };
}

module.exports = { parseClaudeStreamJsonOutput };
