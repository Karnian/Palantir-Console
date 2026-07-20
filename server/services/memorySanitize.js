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

const REDACTION_VERSION = 2;
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
  // Boundary handling (Codex SERIOUS): `\b` fails to fire between a token and a
  // `_`/alnum suffix (both word chars). FIXED-length tokens carry NO trailing
  // assertion — the exact-length body still matches and redacts (any extra suffix
  // is harmless over-redaction). VARIABLE-length ({n,}) tokens keep a negative
  // lookahead over their own alphabet so the greedy run redacts the full token
  // even when a `_`/alnum suffix follows.
  /\bAKIA[0-9A-Z]{16}/g,                                    // AWS access key id (fixed 20)
  /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,           // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,        // Slack token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g, // JWT
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,    // OpenAI sk- / sk-proj-
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,                     // Bearer header
  // lowercase keyword assignment (api_key: v / token = v / password=v)
  new RegExp(`\\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)\\b\\s*[:=]\\s*${VALUE}`, 'gi'),
  // UPPER_SNAKE env-var names ending in a secret-ish word (AWS_SECRET_ACCESS_KEY=,
  // MY_SERVICE_TOKEN=, DB_PASSWORD=). Case-sensitive on purpose; lowercase is
  // covered above. API excluded (too many false-positive var names).
  new RegExp(`\\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*\\s*[:=]\\s*${VALUE}`, 'g'),
  /\bAIza[0-9A-Za-z_-]{35}/g,                               // Google API key (fixed 39)
  /\bya29\.[0-9A-Za-z_-]{20,}(?![A-Za-z0-9_-])/g,          // Google OAuth token
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}(?![A-Za-z0-9])/g, // Stripe secret/restricted (pk_=publishable excluded)
  /\bnpm_[0-9A-Za-z]{36}/g,                                 // npm token (fixed 40)
  /\bglpat-[0-9A-Za-z_-]{20}/g,                             // GitLab PAT (fixed 26)
  // NOTE: `Basic <base64>` is NOT a regex here — a regex can't tell a real
  // credential (`abcdef:admin` -> all-letter base64) from a plain word, so it is
  // both under- and over-inclusive (Codex R4). It is validated by decoding below.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s:/@]+@/gi,         // conn-string user:pass@ (creds only)
  /\b[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g,                    // long hex (md5/sha/raw key)
];

// Basic-auth candidate: `Basic <token>`. Whether it redacts is decided by actually
// base64-decoding the token and checking for a printable `user:password` shape —
// so `Basic YWJjZGVmOmFkbWlu` (=abcdef:admin) redacts while `Basic responsibilities2`
// (not valid base64 creds) does not (Codex R4 BLOCKER: the digit-heuristic leaked
// all-letter creds and over-redacted plain words).
// `=*` (not `={0,2}`) tolerates non-canonical/over-padding — Node still decodes it
// and `looksLikeBasicCredentials` strips the padding before decoding (Codex R5).
// A low `{2,}` candidate floor is intentional — the decode check, not the length,
// filters non-credentials. `{2,}` is the arithmetic minimum: a lone `:` (empty
// user + empty password, valid per RFC 7617) is 1 byte -> base64 body `Og` (2
// chars). A 1-char body is impossible base64 (rejected by the %4 check). So the
// decode+colon check alone decides everything at/above this floor (Codex R6/R8/R9).
const BASIC_AUTH_RE = /\bBasic\s+([A-Za-z0-9+/]{2,}=*)(?![A-Za-z0-9+/])/gi;

function looksLikeBasicCredentials(token) {
  // Padding-tolerant (Codex R5: an unpadded or over-padded token still decodes to
  // the same credential). Reject only impossible base64 lengths, then validate at
  // the BYTE level.
  const unpadded = String(token).replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return false; // impossible base64 length
  let buf;
  try {
    buf = Buffer.from(unpadded, 'base64');
  } catch {
    return false;
  }
  if (buf.length < 1) return false;
  // Charset scope (Codex R9\u2013R12): Basic tokens carry NO charset declaration, so
  // perfectly validating an arbitrary-charset credential from raw bytes is
  // undecidable. We validate charset-AGNOSTICALLY at the byte level, which covers
  // the realistic universe of NON-STATEFUL ASCII-compatible encodings \u2014 UTF-8,
  // ISO-8859-1, Windows-1252, Shift-JIS, EUC-* \u2014 where the `:` separator is always
  // the ASCII byte 0x3A and printable content never uses C0/DEL bytes. High bytes
  // 0x80\u20130xFF are allowed (printable in some locale). ACCEPTED DEBT: stateful
  // escape-based charsets (ISO-2022-JP/CN/KR, HZ) encode text with ESC/C0 bytes and
  // are treated as binary here \u2014 not realistic for this system's memory content,
  // and covering them would require charset detection this token cannot provide.
  // All C0 controls (incl. TAB/LF/CR) are rejected \u2014 RFC 7617 forbids control
  // characters in a user-id/password, so this both follows the RFC and narrows the
  // false-positive surface (Codex R12).
  let hasColon = false;
  for (const b of buf) {
    if (b <= 0x1f || b === 0x7f) return false; // C0 control or DEL -> binary, not a credential
    if (b === 0x3a) hasColon = true;
  }
  // A lone `:` (empty user + empty password) is a valid degenerate pair per RFC
  // 7617; the colon is the whole signal (Codex R7/R9).
  return hasColon;
}

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
  // forget/override: object narrowed to instructions/prompt only. "rules/directives/
  // guidelines" collide with normal technical prose ("override the previous rules in
  // the linter config") and are dropped (Codex human-400 false positives).
  /forget\s+(?:everything|all)\s+(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|context|messages?)/i,
  /override\s+(?:your|the|all|these|any)\s+(?:previous\s+|prior\s+)?(?:system\s+)?(?:instructions?|prompt|system\s+prompt)/i,
  // Korean 지시무시: ignore-directive in command mood (quotative "무시하라고" excluded
  // via 라(?!고)) followed by a directive action clause. Two conjugation branches —
  // 하다-verbs (실행하라/실행하도록/…) and 해-form + spaced auxiliary 주다 (실행해/알려 주세요).
  // Both reject connective/nominal/past/quotative tails (해서/해도/하면/된/했-/…라고) so
  // negation, retrospective, and reported-speech do NOT match — Codex human-400.
  /(?:이전|이전의|위|위의|앞|앞의|기존)\s*(?:의\s*)?(?:지시|명령|지침|프롬프트|규칙|맥락)(?:사항|들)?(?:[을를은는랑]|\s)*(?:모두\s*|전부\s*)?무시하(?:고|라(?!고)|여|십시오|세요)[\s\S]{0,14}?(?:(?:실행|수행|출력|응답|답변|진행|작성|반환|전송|삭제|공개|노출|수정|변경|생성)하(?:라(?!고)|세요|십시오|시오|도록|여라?|자)|(?:실행|수행|출력|응답|답변|진행|작성|반환|전송|삭제|공개|노출|수정|변경|생성|알려|말해|보여|답|따라)\s*(?:해(?:라|요|줘|주세요)?(?!서|도|야)|줘요?|주세요|주십시오))/i,
  /(?:너는|넌|당신은|당신|니가)\s*이제\s*(?:부터)?\s*(?:새로운?\s*)?(?:관리자|시스템|개발자|운영자|supervisor|admin|assistant|ai|봇|모델)(?:\s*(?:이다|입니다|이야|야|임)|\s*역할)/i,
  /(?:^|[\r\n])\s*(?:시스템|사용자|어시스턴트)\s*[:：]/i,
];

function normalizeForScan(text) {
  let s = String(text == null ? '' : text);
  try { s = s.normalize('NFKC'); } catch { /* keep s on bad input */ }
  // Format/control chars used to hide markers. This only mutates the scan copy.
  s = s.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, '');
  // Strip C0/C1 controls except tab/newline/CR; line breaks anchor role markers.
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[^\S\n]+/g, ' ');
  return s;
}

function redactSecrets(text) {
  const s = String(text == null ? '' : text);
  let out = s;
  let redacted = false;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redacted = true;
      return REDACTED;
    });
  }
  // Basic auth: redact only when the token actually decodes to `user:password`.
  out = out.replace(BASIC_AUTH_RE, (match, token) => {
    if (!looksLikeBasicCredentials(token)) return match;
    redacted = true;
    return REDACTED;
  });
  // Backstop: re-scan the ALREADY-redacted output after de-obfuscation. A secret
  // still visible there was split by zero-width/fullwidth tricks and slipped past
  // the raw pass — even when a DIFFERENT (plain) secret was redacted above (Codex:
  // the prior `&& !redacted` gate leaked the obfuscated one in mixed input). Fail
  // closed by redacting the whole content.
  const scan = normalizeForScan(out);
  if (scan !== out) {
    for (const re of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(scan)) {
        re.lastIndex = 0;
        return { text: REDACTED, redacted: true };
      }
    }
    // The Basic candidate is validated by decoding, so it is not in SECRET_PATTERNS
    // and must be re-checked here too — otherwise `Ba​sic <creds>` / fullwidth
    // `Ｂａｓｉｃ` slip the raw pass and leak (Codex R5 BLOCKER).
    if (scanHasBasicCredential(scan)) {
      return { text: REDACTED, redacted: true };
    }
  }
  return { text: out, redacted };
}

function scanHasBasicCredential(text) {
  BASIC_AUTH_RE.lastIndex = 0;
  let match;
  while ((match = BASIC_AUTH_RE.exec(text)) !== null) {
    if (looksLikeBasicCredentials(match[1])) {
      BASIC_AUTH_RE.lastIndex = 0;
      return true;
    }
  }
  BASIC_AUTH_RE.lastIndex = 0;
  return false;
}

function detectInjection(text) {
  const raw = String(text == null ? '' : text);
  const scan = normalizeForScan(raw);
  for (const re of INJECTION_PATTERNS) {
    if (re.test(raw) || re.test(scan)) return true;
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
  normalizeForScan,
};
