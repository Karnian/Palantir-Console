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
  scanPem,                                                // PEM block
  // Boundary handling (Codex SERIOUS): `\b` fails to fire between a token and a
  // `_`/alnum suffix (both word chars). FIXED-length tokens carry NO trailing
  // assertion — the exact-length body still matches and redacts (any extra suffix
  // is harmless over-redaction). VARIABLE-length ({n,}) tokens keep a negative
  // lookahead over their own alphabet so the greedy run redacts the full token
  // even when a `_`/alnum suffix follows.
  /\bAKIA[0-9A-Z]{16}/g,                                    // AWS access key id (fixed 20)
  /\bgh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g,           // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,        // Slack token
  scanJwt,                                                // JWT
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,    // OpenAI sk- / sk-proj-
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,                     // Bearer header
  // lowercase keyword assignment (api_key: v / token = v / password=v)
  new RegExp(
    `\\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|token|password|passwd|pwd)` +
    `\\b\\s*[:=]\\s*${VALUE}`, 'gi'),
  new RegExp(`--(?:password|passwd|pwd)\\b\\s+${VALUE}`, 'gi'), // CLI password arguments
  // UPPER_SNAKE env-var names ending in a secret-ish word (AWS_SECRET_ACCESS_KEY=,
  // MY_SERVICE_TOKEN=, DB_PASSWORD=). Case-sensitive on purpose; lowercase is
  // covered above. API excluded (too many false-positive var names).
  scanUpperAssignment,
  /\bAIza[0-9A-Za-z_-]{35}/g,                               // Google API key (fixed 39)
  /\bya29\.[0-9A-Za-z_-]{20,}(?![A-Za-z0-9_-])/g,          // Google OAuth token
  /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}(?![A-Za-z0-9])/g, // Stripe secret/restricted (pk_=publishable excluded)
  /\bnpm_[0-9A-Za-z]{36}/g,                                 // npm token (fixed 40)
  /\bglpat-[0-9A-Za-z_-]{20}/g,                             // GitLab PAT (fixed 26)
  // NOTE: `Basic <base64>` is NOT a regex here — a regex can't tell a real
  // credential (`abcdef:admin` -> all-letter base64) from a plain word, so it is
  // both under- and over-inclusive (Codex R4). It is validated by decoding below.
  scanConnection,                                         // conn-string user:pass@ (creds only)
  /\b[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g,                    // long hex (md5/sha/raw key)
];

// A sticky run has one greedy end. Queries move forward; cache that end when
// several candidates reach the same run, so a failed suffix is never re-read.
function runEndReader(text, re) {
  let start = -1;
  let end = -1;
  return position => {
    if (position >= start && position <= end) return end;
    start = position;
    re.lastIndex = position;
    const match = re.exec(text);
    end = match ? re.lastIndex : position;
    return end;
  };
}

function scanPem(text, emit) {
  const begins = /-----BEGIN[A-Z ]*PRIVATE KEY-----/g;
  const ends = /-----END[A-Z ]*PRIVATE KEY-----/g;
  let begin;
  while ((begin = begins.exec(text)) !== null) {
    ends.lastIndex = begins.lastIndex;
    // The lazy body ends at the first complete END after the complete BEGIN.
    // No END here means all later BEGINs also fail; do not search that suffix again.
    if (!ends.exec(text)) break;
    if (emit(begin.index, ends.lastIndex)) return true;
    begins.lastIndex = ends.lastIndex; // resume exactly after the non-overlapping match
  }
  return false;
}

function scanJwt(text, emit) {
  const starts = /\beyJ[A-Za-z0-9_-]*/g;
  const secondEnd = runEndReader(text, /[A-Za-z0-9_-]+/y);
  const thirdEnd = runEndReader(text, /[A-Za-z0-9_-]+/y);
  let first;
  while ((first = starts.exec(text)) !== null) {
    const a = starts.lastIndex;
    if (a - first.index < 11 || text[a] !== '.') continue;
    const b = secondEnd(a + 1);
    if (b - a - 1 < 8 || text[b] !== '.') continue;
    const c = thirdEnd(b + 1);
    if (c - b - 1 < 8) continue;
    // Each segment ends at its full alphabet run, including the final lookahead.
    // On failure, inner eyJ starts share the same suffix and have a shorter body;
    // skip only this first run, leaving later segments available as new starts.
    if (emit(first.index, c)) return true;
    starts.lastIndex = c;
  }
  return false;
}

function scanConnection(text, emit) {
  const schemes = /\b[a-z][a-z0-9+.-]*/gi;
  const userEnd = runEndReader(text, /[^\s:/@]+/y);
  const passwordEnd = runEndReader(text, /[^\s:/@]+/y);
  let scheme;
  while ((scheme = schemes.exec(text)) !== null) {
    const a = schemes.lastIndex;
    if (text.slice(a, a + 3) !== '://') continue;
    const b = userEnd(a + 3);
    if (b === a + 3 || text[b] !== ':') continue;
    const c = passwordEnd(b + 1);
    if (c === b + 1 || text[c] !== '@') continue;
    // Inner scheme starts end at the same colon and have identical credentials.
    // A failure skips the scheme run only; credential text can still contain starts.
    if (emit(scheme.index, c + 1)) return true;
    schemes.lastIndex = c + 1;
  }
  return false;
}

function scanUpperAssignment(text, emit) {
  const names = /\b[A-Z][A-Z0-9_]*/g;
  const whitespaceEnd = runEndReader(text, /\s+/y);
  const unquotedEnd = runEndReader(text, /[^\s"']+/y);
  const missingQuote = new Set();
  let name;
  while ((name = names.exec(text)) !== null) {
    // The leading [A-Z] was already consumed in the old pattern: KEY alone
    // does not qualify. A keyword anywhere after that first letter does qualify.
    if (!/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?/.test(name[0].slice(1))) continue;
    let position = whitespaceEnd(names.lastIndex);
    if (text[position] !== ':' && text[position] !== '=') continue;
    position = whitespaceEnd(position + 1);
    const quote = text[position];
    let end;
    if (quote === '"' || quote === "'") {
      if (missingQuote.has(quote)) continue;
      const closing = text.indexOf(quote, position + 1);
      if (closing < 0) {
        missingQuote.add(quote); // all later openings of this quote also fail
        continue;
      }
      end = closing + 1; // empty and multiline quoted values are allowed
    } else {
      end = unquotedEnd(position);
      if (end - position < 4) continue;
    }
    // Consume VALUE only for a successful secret assignment. Otherwise resume
    // after the name, retaining nested candidates such as FOO="AKEY=wxyz".
    if (emit(name.index, end)) return true;
    names.lastIndex = end;
  }
  return false;
}

function replaceScanned(text, scanner, onRedaction) {
  const parts = [];
  let position = 0;
  scanner(text, (start, end) => {
    parts.push(text.slice(position, start), REDACTED);
    position = end;
    onRedaction();
    return false;
  });
  if (!parts.length) return text;
  parts.push(text.slice(position));
  return parts.join('');
}

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
  new RegExp(
    String.raw`forget\s+(?:everything|all)\s+(?:of\s+)?(?:the\s+)?` +
    String.raw`(?:previous|prior|above|earlier)\s+(?:instructions?|context|messages?)`, 'i'),
  new RegExp(
    String.raw`override\s+(?:your|the|all|these|any)\s+(?:previous\s+|prior\s+)?` +
    String.raw`(?:system\s+)?(?:instructions?|prompt|system\s+prompt)`, 'i'),
  // Korean 지시무시: ignore-directive in command mood (quotative "무시하라고" excluded
  // via 라(?!고)) followed by a directive action clause. Two conjugation branches —
  // 하다-verbs (실행하라/실행하도록/…) and 해-form + spaced auxiliary 주다
  // (실행해/알려 주세요).
  // Both reject connective/nominal/past/quotative tails (해서/해도/하면/된/했-/…라고) so
  // negation, retrospective, and reported-speech do NOT match — Codex human-400.
  new RegExp(
    String.raw`(?:이전|이전의|위|위의|앞|앞의|기존)\s*(?:의\s*)?` +
    String.raw`(?:지시|명령|지침|프롬프트|규칙|맥락)(?:사항|들)?` +
    String.raw`(?:[을를은는랑]|\s)*(?:모두\s*|전부\s*)?` +
    String.raw`무시하(?:고|라(?!고)|여|십시오|세요)[\s\S]{0,14}?` +
    String.raw`(?:(?:실행|수행|출력|응답|답변|진행|작성|반환|전송|삭제|` +
    String.raw`공개|노출|수정|변경|생성)하(?:라(?!고)|세요|십시오|시오|도록|여라?|자)|` +
    String.raw`(?:실행|수행|출력|응답|답변|진행|작성|반환|전송|삭제|공개|` +
    String.raw`노출|수정|변경|생성|알려|말해|보여|답|따라)\s*` +
    String.raw`(?:해(?:라|요|줘|주세요)?(?!서|도|야)|줘요?|주세요|주십시오))`, 'i'),
  new RegExp(
    String.raw`(?:너는|넌|당신은|당신|니가)\s*이제\s*(?:부터)?\s*` +
    String.raw`(?:새로운?\s*)?(?:관리자|시스템|개발자|운영자|supervisor|admin|` +
    String.raw`assistant|ai|봇|모델)(?:\s*(?:이다|입니다|이야|야|임)|\s*역할)`, 'i'),
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
  for (const pattern of SECRET_PATTERNS) {
    const onRedaction = () => {
      redacted = true;
      return REDACTED;
    };
    out = typeof pattern === 'function'
      ? replaceScanned(out, pattern, onRedaction)
      : out.replace(pattern, onRedaction);
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
    for (const pattern of SECRET_PATTERNS) {
      if (typeof pattern === 'function') {
        if (pattern(scan, () => true)) return { text: REDACTED, redacted: true };
      } else {
        pattern.lastIndex = 0;
        const found = pattern.test(scan);
        pattern.lastIndex = 0;
        if (found) return { text: REDACTED, redacted: true };
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
