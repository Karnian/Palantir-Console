/**
 * Gemini provider adapter — current stub.
 *
 * Real Gemini usage requires GCP quota APIs that we don't wire up here yet,
 * so this returns a structured fallback envelope. The shape MUST match the
 * canonical provider envelope so the front-end and contract tests can rely
 * on the same fields across providers.
 */

function nowIso() {
  return new Date().toISOString();
}

async function fetchGeminiUsage(apiKey) {
  if (!apiKey) {
    return {
      id: 'google',
      name: 'gemini',
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'GEMINI_API_KEY not set' }],
      updatedAt: nowIso(),
    };
  }

  return {
    id: 'google',
    name: 'gemini',
    limits: [{
      label: 'usage',
      remainingPct: null,
      resetAt: null,
      errorMessage: 'Gemini usage requires GCP quota APIs',
    }],
    updatedAt: nowIso(),
  };
}

module.exports = { fetchGeminiUsage };
