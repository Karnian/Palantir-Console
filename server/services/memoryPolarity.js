// server/services/memoryPolarity.js
//
// A2-④-a: polarity-loss gate — pure, zero external deps.
//
// Surface: R4 candidates that go through LLM distillation can have their
// polarity reversed (`X를 쓰지 마라` → `X를 써라`). This module detects
// single-negation signals in the REFERENCE (raw R4 content) and rejects
// distilled output when the negation is absent from the sanitized proposal.
//
// Scope (narrow, honest):
//   - Only catches: same-language, single explicit negation → zero negation
//     in distilled output.
//   - Does NOT catch: double negations, cross-language translation, implied
//     negation, conditional negation ("~않으면"), concessive ("~해도").
//   - These are FALSE NEGATIVES (safe direction — we accept a risky item
//     rather than discard a safe one). The comment boundary below and the
//     test suite's contract-set are the living documentation.
//
// Deployment notes:
//   - `summarizeR4ReferenceContent` is the SINGLE source of truth for
//     cap + whitespace-normalize applied to R4 raw.content. The gate
//     (memoryService) and the distiller (liveDistiller) both call this
//     function — not a shared constant — to guarantee identical text.
//   - `detectNegation` MUST NOT use substring matching. All patterns use
//     word-boundary or context-aware regex after exclude-token scrubbing.

'use strict';

// ---------------------------------------------------------------------------
// Reference content cap (shared with liveDistiller — must NOT diverge).
// ---------------------------------------------------------------------------
const R4_REFERENCE_CAP = 400; // chars; enough for a 1-2 sentence lesson

/**
 * summarizeR4ReferenceContent(content) → string
 *
 * Whitespace-normalise and cap raw.content from an R4 candidate.
 * This is the SINGLE canonical form used by:
 *   1. The polarity gate (promoteCandidatesBatchTx reference extraction)
 *   2. The distiller (liveDistiller.summarizeRaw R4 branch)
 * Both paths must call THIS function, not replicate the logic.
 */
function summarizeR4ReferenceContent(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\s+/g, ' ').trim().slice(0, R4_REFERENCE_CAP);
}

// ---------------------------------------------------------------------------
// Exclude tokens: known false-positive compounds that START with a negation
// morpheme but carry no negative meaning. Replace them with a placeholder
// BEFORE running any negation pattern — the excluded tokens then disappear
// from the text and the real negation patterns won't match them.
//
// Strategy: list explicit multi-character tokens that would otherwise trigger
// the Korean negation morphemes 안/못/비/미/불/없. After replacement the
// underlying morpheme is gone and pattern matching is clean.
// ---------------------------------------------------------------------------
const KO_EXCLUDE_TOKENS = [
  // 안- compounds (not negation)
  '보안', '안내', '안전', '안정', '안전성',
  // 미- compounds (not negation: 미들웨어, 미래 등 비-부정 용도)
  '미들웨어', '미래', '미팅', '미디어',
  // 비- compounds (not negation)
  '비동기', '비교', '비율', '비용', '비즈니스', '비트', '비전', '비공개',
  // 불- compounds (not negation, or "inevitably")
  '불러오기', '불러오다', '불구하고', '불가피', '불가피하게', '불가피한',
  // 관계없이 / 상관없이 / 문제없이 — idiomatic, no negation
  '관계없이', '상관없이', '문제없이', '차질없이', '관계없는',
  // 업데이트 — not negation
  '업데이트',
  // 못지않다 ("not inferior" = a POSITIVE comparison) — the 지않 substring would
  // otherwise trip KO_AUX_NEG and lossy-reject a positive lesson (Codex review BLOCKER).
  '못지않', '못지 않',
];

// Sort longest-first so a longer match wins over a prefix.
const KO_EXCLUDE_SORTED = KO_EXCLUDE_TOKENS.slice().sort((a, b) => b.length - a.length);

function scrubExcludes(text) {
  let t = text;
  for (const token of KO_EXCLUDE_SORTED) {
    // Replace all occurrences with a neutral placeholder (spaces preserve
    // boundary semantics for surrounding patterns).
    t = t.split(token).join(' ');
  }
  return t;
}

// ---------------------------------------------------------------------------
// Korean strong-negation patterns (applied AFTER exclude scrub).
// Each pattern is a RegExp that matches ONE negation instance.
// ---------------------------------------------------------------------------

// Auxiliary verb: ~지 않 / ~지 마 / ~지 말. The 않 branch EXCLUDES conditional
// (~않으면) and concessive (~않아도/~않더라도) endings: per plan v0.3 those are
// FALSE NEGATIVES (safe direction). Catching them would lossy-reject a normal
// conditional lesson — e.g. "통과하지 않으면 보류" distilled to "통과가 조건"
// loses the surface negation but NOT the polarity (Codex review BLOCKER).
const KO_AUX_NEG = /지\s*(?:않(?!\s*(?:으면|아도|어도|더라도))|마(?:라|세요|십시오)?|말)/g;

// Copula negation: 아니다 / 아닌 / 아님 / 아니라. The conjugation suffix is
// REQUIRED (no optional `?`) so non-negation words that merely start with 아니
// (e.g. 아니메 = "anime") don't false-match (Claude review). The `면` suffix
// (아니면 = "if not", conditional) is EXCLUDED — same false-negative rationale
// as the 않 branch above (Codex review BLOCKER).
const KO_ANIDA = /아니(?:다|라|며|었|고|지|하)|아닌|아님/g;

// 못 + whitespace + non-space (못 한다, 못 해, 못 씀) — must be standalone so the
// compound 잘못 ("mistake") doesn't false-match as 못+space (Claude review).
const KO_MOT = /(?:^|\s)못\s+\S/g;

// 안 + whitespace + non-space (안 한다, 안 됨, 안 써) — must be standalone
const KO_AN = /(?:^|\s)안\s+\S/g;

// Strong-negation single-word particles
const KO_PARTICLES = /금지|불가(?:능)?|불허|불필요|미지원|미구현|미사용|비권장|비허용|비활성/g;

// ---------------------------------------------------------------------------
// English strong-negation patterns.
// ---------------------------------------------------------------------------
// NOTE: n't contractions (don't/doesn't/won't/can't/isn't/…) are handled SOLELY
// by EN_NT_CONTRACTION below — listing them here too would double-count a single
// negation (count=2) and trip the double-negation guard, silently disabling the
// gate for every contracted English negation (Claude review SERIOUS).
const EN_NEG_WORDS = /\b(?:not|no|never|cannot|avoid|without|disallow|prohibit|forbid)\b/gi;
const EN_NT_CONTRACTION = /\b\w+n['’]t\b/gi;

// ---------------------------------------------------------------------------
// hasHangul: true when the text contains at least one Hangul syllable block.
// ---------------------------------------------------------------------------
const HANGUL_RE = /[가-힣]/;

/**
 * detectNegation(text) → { count: number, hasHangul: boolean }
 *
 * Returns the number of STRONG negation instances found in `text` and
 * whether the text contains Hangul syllables.
 *
 * CONTRACT (enforced by test suite):
 *   False-positive set (must all yield count === 0):
 *     보안, 안내, 안전, 미들웨어, 비동기, 비교, 불러오기,
 *     관계없이, 상관없이, 문제없이, 불가피, 업데이트
 *
 *   True-positive set (must all yield count >= 1):
 *     하지 않는다, 쓰지 마라, 사용하지 않음, 아님, 못 한다, 금지, 미지원
 */
function detectNegation(text) {
  if (typeof text !== 'string' || !text) return { count: 0, hasHangul: false };

  const hasHangul = HANGUL_RE.test(text);

  // 1. Scrub false-positive compound tokens first.
  const scrubbed = scrubExcludes(text);

  let count = 0;

  // 2. Korean patterns (only when Hangul is present)
  if (hasHangul) {
    count += (scrubbed.match(KO_AUX_NEG) || []).length;
    count += (scrubbed.match(KO_ANIDA) || []).length;
    count += (scrubbed.match(KO_MOT) || []).length;
    count += (scrubbed.match(KO_AN) || []).length;
    count += (scrubbed.match(KO_PARTICLES) || []).length;
  }

  // 3. English patterns (always — content may be mixed)
  count += (scrubbed.match(EN_NEG_WORDS) || []).length;
  count += (scrubbed.match(EN_NT_CONTRACTION) || []).length;

  return { count, hasHangul };
}

// ---------------------------------------------------------------------------
// polarityLost(reference, content) → boolean
//
// Returns true ONLY when:
//   - reference is a non-empty string (R4 path, same language)
//   - both texts are in the same language (hasHangul guard)
//   - reference has exactly ONE negation
//   - distilled content has ZERO negations
//
// Everything else → false (safe: do not reject).
// ---------------------------------------------------------------------------

/**
 * polarityLost(reference, content) → boolean
 *
 * @param {string|null} reference - summarized R4 raw.content (gate side)
 * @param {string}      content   - sanitized distilled proposal content
 */
function polarityLost(reference, content) {
  // 1. No reference → not an R4 candidate or raw.content missing → skip
  if (!reference) return false;

  const refNeg = detectNegation(reference);
  const contNeg = detectNegation(content);

  // 2. Language guard: if the language changed (한국어 ↔ 영어), count
  //    comparison is meaningless — different morpheme coverage.
  if (refNeg.hasHangul !== contNeg.hasHangul) return false;

  // 3. Double-negation guard: two negations in the reference mean we can't
  //    reliably determine the polarity (double negation = positive, or
  //    complex discourse). Leave it to the human-review slice (A2-④-b).
  if (refNeg.count >= 2) return false;

  // 4. Single-negation loss: reference has exactly ONE negation, the
  //    distilled output has ZERO → polarity was stripped → reject.
  if (refNeg.count === 1 && contNeg.count === 0) return true;

  return false;
}

module.exports = { detectNegation, polarityLost, summarizeR4ReferenceContent };
