// ML PR3a: sanitize distilled memory content before it becomes an active item.
//
// The distiller output is NOT trusted: it is generalized from candidate raw
// signals (which may carry leaked secrets) and, once active, is injected into
// the PM's user-payload. So both the INPUT redaction (done when candidates are
// captured) AND this OUTPUT pass are required (Codex BLOCKER ④ — input-only
// redaction is insufficient because the LLM can echo/transform a secret, and a
// crafted candidate could try to smuggle instructions into the memory block).
//
// Two distinct dispositions:
//   - secrets  -> REDACTED in place (content survives, marked redacted)
//   - injection-> REJECTED (content dropped; never promoted)
// Plus length floor/ceiling. Deterministic, no external deps.

const REDACTION_VERSION = 1;
const DEFAULT_MAX_LEN = 500;
const HARD_MAX_LEN = 2000;   // absolute ceiling — caller maxLen is clamped to this
const MIN_LEN = 8;
const REDACTED = '[REDACTED]';

// Secret patterns -> redact. Ordered most-specific first so a token assignment
// is masked as a unit before a generic long-hex catch-all sees its value.
// Values may be quoted (`KEY="..."`). The matcher captures the FULL quoted span
// (including inner whitespace) or an unquoted non-space run. The prior
// `["']?[^\s"']{4,}["']?` stopped at the first inner space, leaking the rest of
// a multi-word secret like `password="correct horse battery staple"` (Codex
// follow-up BLOCKER).
const VALUE = `(?:"[^"]*"|'[^']*'|[^\\s"']{4,})`;
const SECRET_PATTERNS = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, // PEM block
  /\bAKIA[0-9A-Z]{16}\b/g,                                  // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                        // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,                      // Slack token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,                   // OpenAI sk- / sk-proj-
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,                     // Bearer header
  // lowercase keyword assignment (api_key: v / token = v / password=v)
  new RegExp(`\\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)\\b\\s*[:=]\\s*${VALUE}`, 'gi'),
  // UPPER_SNAKE env-var names ending in a secret-ish word (AWS_SECRET_ACCESS_KEY=,
  // MY_SERVICE_TOKEN=, DB_PASSWORD=). Case-sensitive on purpose; lowercase is
  // covered above. API excluded (too many false-positive var names).
  new RegExp(`\\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\\s*[:=]\\s*${VALUE}`, 'g'),
  /\b[0-9a-fA-F]{32,}\b/g,                                  // long hex (md5/sha/raw key)
];

// Injection patterns -> reject the whole content. Conservative: only clear
// instruction-override / role-injection shapes (a false positive merely drops a
// candidate, which is the safe direction). Role markers anchor to line-start OR
// buffer-start (Codex BLOCKER 2: the prior `\n`-only anchor missed a leading
// `System: ...`).
const INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|context|messages?)/i,
  /disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  /you\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bnew\s+(?:system\s+prompt|instructions?)\b/i,
  /(?:^|[\r\n])\s*(?:Human|Assistant|System)\s*:/i,         // chat role injection
  /<\/?(?:system|instructions?|im_start|im_end)\b[^>]*>/i,  // role/control markers
];

function redactSecrets(text) {
  let out = text;
  let redacted = false;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return REDACTED;
    });
  }
  return { text: out, redacted };
}

function detectInjection(text) {
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// Returns { ok, content, redacted, redactionVersion, reasons[] }.
// ok=false => do not promote.
function sanitizeProposalContent(raw, { maxLen = DEFAULT_MAX_LEN } = {}) {
  const reasons = [];
  if (typeof raw !== 'string') {
    return { ok: false, content: null, redacted: false, redactionVersion: REDACTION_VERSION, reasons: ['not_string'] };
  }
  // Clamp maxLen defensively: a caller-supplied NaN / non-finite / huge value
  // must not disable truncation and let unbounded content reach the DB (Codex
  // follow-up SERIOUS).
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? Math.min(Math.floor(maxLen), HARD_MAX_LEN) : DEFAULT_MAX_LEN;
  // Injection is checked on the ORIGINAL text (before redaction could mask a
  // marker) and rejects outright.
  if (detectInjection(raw)) {
    return { ok: false, content: null, redacted: false, redactionVersion: REDACTION_VERSION, reasons: ['injection'] };
  }
  const { text: redactedText, redacted } = redactSecrets(raw);
  // Collapse runs of whitespace/newlines to keep the memory block compact and
  // deny multi-line role-marker tricks a second avenue.
  let content = redactedText.replace(/\s+/g, ' ').trim();
  if (content.length > cap) {
    content = content.slice(0, cap).trim();
    reasons.push('truncated');
  }
  if (content.length < MIN_LEN) {
    return { ok: false, content: null, redacted, redactionVersion: REDACTION_VERSION, reasons: ['too_short'] };
  }
  // If redaction ate the whole thing into mostly placeholders, drop it.
  if (content.replace(new RegExp(REDACTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '').trim().length < MIN_LEN) {
    return { ok: false, content: null, redacted, redactionVersion: REDACTION_VERSION, reasons: ['mostly_redacted'] };
  }
  return { ok: true, content, redacted, redactionVersion: REDACTION_VERSION, reasons };
}

module.exports = {
  REDACTION_VERSION,
  sanitizeProposalContent,
  redactSecrets,
  detectInjection,
};
