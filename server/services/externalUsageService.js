const { AppError } = require('../utils/errors');

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function nowIso() {
  return new Date().toISOString();
}

function toRemainingPct({ utilization, usedCredits, limit }) {
  if (typeof utilization === 'number') {
    return Math.max(0, Math.min(100, 100 - utilization));
  }
  if (typeof usedCredits === 'number' && typeof limit === 'number' && limit > 0) {
    return Math.max(0, Math.min(100, 100 - (usedCredits / limit) * 100));
  }
  return null;
}

function parseResetAt(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value.replace('Z', '+00:00'));
    if (!Number.isNaN(parsed)) return new Date(parsed);
  }
  return null;
}

async function fetchAnthropicUsage(apiKey) {
  if (!apiKey) {
    return {
      id: 'anthropic',
      name: 'claude',
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'ANTHROPIC_API_KEY not set' }],
      updatedAt: nowIso()
    };
  }

  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AppError('Anthropic usage request failed', response.status, body.slice(0, 200));
  }

  const data = await response.json();
  const limits = [];

  if (data && typeof data === 'object') {
    Object.entries(data).forEach(([key, value]) => {
      if (!value || typeof value !== 'object') return;
      const remainingPct = toRemainingPct({
        utilization: value.utilization,
        usedCredits: value.used_credits,
        limit: value.monthly_limit
      });
      const resetAt = parseResetAt(value.resets_at);
      limits.push({ label: key, remainingPct, resetAt });
    });
  }

  if (!limits.length) {
    limits.push({
      label: 'usage',
      remainingPct: null,
      resetAt: null,
      errorMessage: 'No usage data found'
    });
  }

  return {
    id: 'anthropic',
    name: 'claude',
    limits,
    updatedAt: nowIso()
  };
}

async function fetchGeminiUsage(apiKey) {
  if (!apiKey) {
    return {
      id: 'google',
      name: 'gemini',
      limits: [{ label: 'usage', remainingPct: null, resetAt: null, errorMessage: 'GEMINI_API_KEY not set' }],
      updatedAt: nowIso()
    };
  }

  return {
    id: 'google',
    name: 'gemini',
    limits: [{
      label: 'usage',
      remainingPct: null,
      resetAt: null,
      errorMessage: 'Gemini usage requires GCP quota APIs'
    }],
    updatedAt: nowIso()
  };
}

module.exports = { fetchAnthropicUsage, fetchGeminiUsage };
