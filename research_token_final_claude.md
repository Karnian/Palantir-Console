# LLM 토큰 비용 절감 — 최종 통합 실행 계획

> 작성일: 2026-04-06
> 기반 문서: provider, customer, benchmark_claude, benchmark_codex, review_claude, review_codex
> 가격 기준: 공식 벤더 문서 (2026-04-06 확인)
> 작성 원칙: provider + customer를 골격, benchmark_codex를 정량 근거, benchmark_claude는 보조 아이디어 풀

---

## Executive Summary

6개 리서치 문서의 핵심 결론은 일관된다:

1. **절감 우선순위**: 캐싱 → 배치 → 모델 라우팅 → 프롬프트/컨텍스트 최적화 → Fine-tuning → 선택적 셀프호스팅
2. **고객 제품 전략**: 가시성 + 예산 통제 + 단순한 모델 선택 + 자동 최적화 조합
3. **조합 적용 시 원래 대비 75-90% 절감** 가능 (Phase 전체 완료 기준)

다만 원본 문서 간 가격/모델명 충돌이 존재했으며, 본 문서에서 공식 출처 기준으로 정리 완료했다. 특히 benchmark_claude 문서의 Opus 4.6 가격($15/$75)은 공식 가격($5/$25)과 3배 차이가 있어 해당 문서 기반 비용 추정은 전면 교정했다.

**즉시 실행으로 40-60% 절감, 6개월 내 75-90% 절감 달성이 현실적 목표다.**

---

## 1. 공식 가격 기준표 (Official Rate Card)

> as_of_date: 2026-04-06
> 단위: USD / 1M tokens

### 1.1 Anthropic Claude

| 모델 | Input | Output | Cache Write (5분) | Cache Write (1시간) | Cache Hit | Batch Input | Batch Output |
|------|------:|-------:|------------------:|-------------------:|---------:|------------:|-------------:|
| Opus 4.6 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 | $2.50 | $12.50 |
| Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 | $1.50 | $7.50 |
| Haiku 4.5 | $1.00 | $5.00 | $1.25 | $2.00 | $0.10 | $0.50 | $2.50 |

- 출처: [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Cache hit = base input의 0.1x (90% 할인)
- Batch = 표준 가격의 50% 할인
- **Batch + Cache hit 최대 95% 절감** (상한 시나리오, 현실 기대치는 워크로드 의존)

### 1.2 OpenAI GPT

| 모델 | Input | Cached Input | Output | Batch Input | Batch Output |
|------|------:|-------------:|-------:|------------:|-------------:|
| GPT-4.1 | $2.00 | $0.50 | $8.00 | $1.00 | $4.00 |
| GPT-4.1 mini | $0.40 | $0.10 | $1.60 | $0.20 | $0.80 |
| GPT-4.1 nano | $0.10 | $0.025 | $0.40 | $0.05 | $0.20 |

- 출처: [OpenAI GPT-4.1 Pricing](https://openai.com/index/gpt-4-1/)
- Cached input = 75% 할인, Batch = 50% 할인

### 1.3 Google Gemini

| 모델 | Input | Cached Input | Output | Batch Input | Batch Output |
|------|------:|-------------:|-------:|------------:|-------------:|
| Gemini 2.5 Pro | $1.25 | $0.125 | $10.00 | $0.625 | $5.00 |
| Gemini 2.5 Flash | $0.30 | $0.03 | $2.50 | $0.15 | $1.25 |
| Gemini 2.5 Flash-Lite | $0.10 | $0.01 | $0.40 | $0.05 | $0.20 |

- 출처: [Google Gemini Pricing](https://ai.google.dev/pricing)

### 1.4 DeepSeek

| 모델 | Input (miss) | Input (hit) | Output |
|------|-------------:|------------:|-------:|
| V3.2 non-thinking | $0.27 | $0.07 | $1.10 |
| V3.2 thinking (reasoner) | $0.55 | $0.14 | $2.19 |

- 출처: [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/)

### 1.5 가격 충돌 해소 기록

| 항목 | benchmark_claude 기재 | 실제 공식 가격 | 판정 |
|------|----------------------|--------------|------|
| **Opus 4.6** | $15/$75 | $5/$25 | **3배 오류** — provider, benchmark_codex, 공식 문서 모두 $5/$25 |
| **GPT 모델명** | GPT-5.2, GPT-5.3 Codex | GPT-4.1 계열 | **미발표 모델명** — GPT-4.1이 2026-04 기준 최신 |
| **Gemini** | Gemini 3.1 Pro ($2/$12) | Gemini 2.5 Pro ($1.25/$10) | **세대 혼동** — 3.1 Pro는 미확인 |
| **DeepSeek V3.2** | $0.14/$0.28 | $0.27/$1.10 | **cache hit/miss 혼동 또는 구버전** |
| **DeepSeek V4** | $0.30/$0.50 | 미발표 | **존재하지 않는 모델** |

> 본 문서의 모든 비용 계산은 위 공식 가격표를 기준으로 한다. benchmark_claude의 가격 데이터는 사용하지 않는다.

### 1.6 가격 버전 관리 정책 (신규)

| 항목 | 규칙 |
|------|------|
| rate_card_version | `YYYY-MM-DD` 기준일 + 벤더별 source_url 필수 기재 |
| 갱신 주기 | 월 1회 공식 가격 페이지 확인, 변경 시 즉시 갱신 |
| billing_snapshot | 고객 청구 시점의 가격으로 정산 (변경 전 요청은 이전 가격 적용) |
| 내부 비용 계산 | 항상 최신 rate_card 기준, 과거 분석 시 해당 시점 rate_card 사용 |
| 변경 알림 | 가격 변경 발생 시 고객에게 7일 전 사전 고지 |

---

## 2. 비용 절감 레버 (Cost Levers)

### 2.1 레버별 절감 효과 및 우선순위

| 우선순위 | 레버 | 예상 절감 | 구현 난이도 | 근거 |
|---------|------|-----------|------------|------|
| **1** | Prompt Caching (네이티브) | input 최대 90% | 낮음 | provider §2.1, Care Access 사례 86% [S5] |
| **2** | Batch API (비실시간) | 해당 작업 50% | 낮음 | provider §5.1, 3사 모두 50% 할인 |
| **3** | 모델 라우팅 (규칙 기반) | 전체 40-60% | 낮음-중간 | provider §3 시뮬레이션 |
| **4** | 프롬프트 최적화 | input 15-30% | 낮음 | provider §1 |
| **5** | Output 길이 제한 | output 30-50% | 낮음 | max_tokens + structured output |
| **6** | 대화 요약 + 슬라이딩 윈도우 | input 60-85% | 중간 | provider §4.1 |
| **7** | RAG 도입/최적화 | input 90-97% | 높음 | provider §4.3 |
| **8** | Fine-tuning | 프롬프트 토큰 최대 80% | 높음 | Indeed 사례 [S6] |
| **9** | Semantic Cache | hit 시 100% | 높음 | Redis LangCache ~73% 절감 사례 |
| **10** | 멀티벤더 라우팅 | 전체 30-50% 추가 | 중간-높음 | 저가 모델 혼합 |
| **11** | 셀프호스팅 (조건부) | 60-80% | 매우 높음 | codex §4 논문 기반 |

### 2.2 조합 시나리오 (Sonnet 4.6 기준, 월 $10,000 출발)

```
1단계 (즉시):  Prompt Caching → input 90% 절감
               → 월 ~$7,000 (30% 절감)

2단계 (1-2주): 모델 라우팅 (70% Haiku / 25% Sonnet / 5% Opus)
               → 월 ~$3,500 (65% 누적)

3단계 (1-2주): 비실시간 30% Batch 전환 (50% 할인)
               → 월 ~$3,000 (70% 누적)

4단계 (1-2월): 컨텍스트 관리 + 프롬프트 최적화 + Output 제한
               → 월 ~$2,000-2,400 (75-80% 누적)

5단계 (3-6월): Fine-tuning + Semantic Cache + 멀티벤더
               → 월 ~$1,000-1,500 (85-90% 누적)
```

### 2.3 Output 비용 강조 (review_claude 지적 반영)

> "비용이 터지는 건 보통 input보다 output이다" — benchmark_codex

| 모델 | Output/Input 비율 | 의미 |
|------|----------------:|------|
| Sonnet 4.6 | 5.0x | output이 input보다 5배 비쌈 |
| GPT-4.1 | 4.0x | output이 input보다 4배 비쌈 |
| Gemini 2.5 Pro | 8.0x | output이 input보다 8배 비쌈 |

**따라서 Output 제어가 Input 절감만큼 중요하다:**
- `max_tokens` 적극 설정
- Structured output (JSON schema) 사용
- "3줄 요약", "표로만" 등 출력 포맷 명시
- Tool 응답에서 불필요한 서술 억제

### 2.4 Batch + Cache 중첩 할인 주의사항 (review_codex 지적 반영)

provider 문서는 "Batch + Cache = 95% 절감"을 일반 기대값처럼 제시했으나:

- Batch 내 cache hit는 **best-effort**이며 트래픽 패턴에 따라 30~98% 변동
- **95%는 상한 시나리오**이지 기본 기대치가 아님
- 현실적 기대: Batch 50% + Cache hit 일부 → **60-80% 절감**이 보수적 추정

---

## 3. 고객 제품 기능 (Customer-Facing Features)

### 3.1 제품 패키징

| 패키지 | 포함 기능 | 대상 | Phase |
|--------|----------|------|-------|
| **Cost Visibility** | 대시보드, 리포트, 예측선, CSV/API export | 모든 고객 (무료) | 1-2 |
| **Cost Control** | 예산 한도, 알림, 자동 차단, 모델 선택 | 비용 민감 고객 | 1-2 |
| **Cost Optimizer** | 캐시 할인, 자동 요약, 모델 자동선택, Batch 전환 | 대량 사용 고객 | 2-3 |
| **Enterprise Governance** | 팀별 할당, 승인 흐름, chargeback, audit | 대기업 | 3-5 |

### 3.2 사용량 대시보드

**상단 KPI 카드 (4개):**
- 오늘 비용 / 이번 달 누적 / 월말 예상 / 캐시 절감액

**중단 차트:**
- 일자별 비용/토큰 추이 (라인차트)
- 모델별/기능별/팀별 사용량 (스택 바차트)

**우측 인사이트 패널:**
- 절감 추천 카드 3개 ("문서 요약 기능이 비용의 48% 차지", "캐시 히트율이 30%로 낮음")

**데이터 분해 축:**
- input / output / cached / reasoning 토큰 분리 표시
- 기능별 attribution (챗, 검색, 문서분석, 에이전트)
- 사용자/팀/프로젝트별 drill-down

### 3.3 예산 통제

**4단계 정책:**

| 단계 | 동작 | 트리거 |
|------|------|--------|
| 1 | 알림만 (Slack/Email) | 예산 50%, 80% 도달 |
| 2 | 고비용 모델 사용 금지 | 예산 90% 도달 |
| 3 | 관리자 승인 필요 | 예산 100% 도달 |
| 4 | 자동 차단 | hard limit 초과 |

**계층별 제어:**
- 전체 서비스 → 테넌트/고객별 → 팀별 → 사용자별 → 기능별

### 3.4 모델 선택 UX

**2단 구조:**
1. 기본 UI: `빠름(Fast)` / `균형(Balanced)` / `고품질(Premium)`
2. 고급 설정: 실제 모델명, 예상 단가, 컨텍스트 길이

**자동 최적화:**
- 기본값은 `균형`으로 설정
- 불만족 시 `고품질`로 재실행 UX 제공
- 조직 정책으로 특정 워크스페이스는 저가 모델만 허용 가능

### 3.5 캐시 할인 고객 노출

**추천 방안:**
1. 청구서에서 `uncached input`, `cached input`, `output` 분리 표시
2. 대시보드에 `캐시 절감액`과 `캐시 히트율` 표시
3. 캐시 친화적 템플릿/SDK에서 정적 prefix를 앞에 두도록 유도

**마진 방어 규칙 (신규):**
- 벤더 캐시 할인의 고객 환원 비율: 벤더 절감액의 70% 환원, 30% 마진 확보
- 엔터프라이즈 계약: 월 hit ratio 60% 이상 고객에게 추가 5% 할인
- 마진 하한: 고객 환원 후에도 최소 15% gross margin 유지

### 3.6 토큰 절약 자동화 (기본값)

| 우선순위 | 자동화 항목 | 효과 | 주의사항 |
|---------|-----------|------|---------|
| 높음 | 대화 자동 요약 | input 60-85% 절감 | hallucination 위험, 원문 복원 경로 필수 |
| 높음 | RAG top-k 축소 + rerank | 컨텍스트 90%+ 절감 | 관련성 임계값 튜닝 필요 |
| 높음 | 정적 prefix 캐시 최적화 | 캐시 히트율 개선 | 내부 재배열, 고객 투명성 불필요 |
| 중간 | 출력 길이 자동 제한 | output 20-40% 절감 | 품질 훼손 낮음 |
| 중간 | 모델 자동 다운그레이드 | 전체 30-50% 절감 | 오판 시 CS 이슈, 옵트아웃 제공 |
| 중간 | 비동기 작업 Batch 전환 | 50% 절감 | 지연 허용 범위 합의 필요 |

**운영 원칙:**
- 모든 자동화에 **feature flag** 필수
- 품질 저하 감지 시 즉시 해제 가능
- 자동 다운그레이드는 민감 업무에서 옵트아웃 제공

---

## 4. 운영 모델 및 로드맵 (Phase 0-5)

### Phase 0: 기준선 정리 (1주)

**목표:** 가격/데이터 기준을 하나로 통일

| # | 작업 | 산출물 |
|---|------|--------|
| 0-1 | 공식 벤더 가격 기준표를 별도 `rate_card`로 분리 | rate_card.json (as_of_date, source_url, billing_unit 포함) |
| 0-2 | usage event schema 정규화 설계 | normalized_usage_events 스키마 |
| 0-3 | 현재 비용 baseline 측정 | baseline_report (모델별, 기능별, 일별) |
| 0-4 | 품질 golden set 구축 (회귀 방지용) | golden_test_cases (작업유형별 50개) |

**Usage Schema 정규화 (신규 — review_codex 누락 지적 반영):**

```json
{
  "event_id": "uuid",
  "timestamp": "ISO8601",
  "vendor": "anthropic|openai|google|deepseek",
  "model": "claude-sonnet-4-6",
  "input_tokens": 2095,
  "output_tokens": 503,
  "cached_input_tokens": 2095,
  "reasoning_tokens": 0,
  "input_cost_usd": 0.00629,
  "output_cost_usd": 0.00755,
  "cache_savings_usd": 0.00567,
  "batch": false,
  "tenant_id": "org-123",
  "feature": "chat|search|document|agent",
  "rate_card_version": "2026-04-06"
}
```

**KPI:**
- rate_card 갱신 latency (벤더 변경 후 반영까지 시간) — 목표: < 24시간
- usage event 누락률 — 목표: < 0.1%

---

### Phase 1: 즉시 절감 (1-2주)

**목표:** 제품 품질을 거의 건드리지 않고 바로 절감

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 1-1 | Anthropic Prompt Caching 활성화 | input 비용 최대 90% | 낮음 |
| 1-2 | 비실시간 작업 Batch API 전환 | 해당 작업 50% | 낮음 |
| 1-3 | 시스템 프롬프트 리팩토링 (불필요 지시 제거, 구조화) | input 15-30% | 낮음 |
| 1-4 | max_tokens 설정 + structured output 적용 | output 30-50% | 낮음 |
| 1-5 | 미사용 Tool 정의 제거 | input 5-10% | 낮음 |

**Prompt Caching 구현 주의사항 (review_codex 지적 반영):**
- provider 문서의 top-level `cache_control` 예시는 과도하게 단순화됨
- 실제로는 `tools`, `system`, `messages` 내 **content block에 cache_control breakpoint**를 설정하는 방식
- 캐시 최소 토큰: Opus/Haiku 4,096 / Sonnet 4.6 2,048

**KPI:**
- `input_tokens/request` — 목표: baseline 대비 30% 감소
- `output_tokens/request` — 목표: baseline 대비 40% 감소
- `cache_hit_rate` — 목표: > 50%
- `batch_ratio` (비실시간 작업 중 batch 비율) — 목표: > 80%
- **Phase 1 예상 효과: 기준 비용 대비 40-60% 절감**

---

### Phase 2: 가시화와 통제 (2-4주)

**목표:** 고객과 운영팀이 비용을 통제 가능하게 만든다

| # | 작업 | 효과 | 난이도 |
|---|------|------|--------|
| 2-1 | 사용량 대시보드 기본형 (KPI 4개 + 추이 차트) | 가시성 확보 | 중간 |
| 2-2 | 월 예산 한도 + soft/hard limit + 알림 | 비용 사고 방지 | 중간 |
| 2-3 | 이상치 탐지 (시간당 3σ 초과, 단일 요청 $1+) | 비정상 비용 방지 | 중간 |
| 2-4 | 고객-facing 캐시 절감액 표시 | 고객 신뢰 | 낮음 |
| 2-5 | 모니터링 체계 구축 (Helicone 또는 자체) | 최적화 근거 | 중간 |
| 2-6 | 프롬프트 템플릿 라이브러리 + 짧게 쓰기 가이드 | input 10-20% 절감 | 낮음 |

**KPI:**
- `budget_overrun_count` (월 예산 초과 건수) — 목표: 0건
- `cost_variance_per_tenant` — 목표: 예측 대비 ±15% 이내
- `anomaly_detection_latency` (이상 감지까지 시간) — 목표: < 5분
- `savings_recommendation_ctr` (절감 추천 클릭률) — 목표: > 20%

---

### Phase 3: 자동 최적화 (1-2개월)

**목표:** 시스템이 기본적으로 싸게 동작하게 만든다

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 3-1 | 규칙 기반 모델 라우팅 (Haiku/Sonnet/Opus 3티어) | 전체 40-50% | 중간 |
| 3-2 | Fast/Balanced/Premium 고객 선택 UX | 간접 (고객 자율 절감) | 중간 |
| 3-3 | 대화 자동 요약 + 슬라이딩 윈도우 | input 60-85% | 중간 |
| 3-4 | 캐시 절감액/히트율 대시보드 + 청구서 분리 | 간접 (인센티브) | 중간 |
| 3-5 | 자동 모델 다운그레이드 (저위험 작업) | 전체 20-30% 추가 | 중간 |

**라우팅 비용 시뮬레이션 (월 1,000만 요청, 평균 1K input + 500 output 기준):**

| 전략 | Haiku % | Sonnet % | Opus % | 월 비용 | Sonnet 단일 대비 절감 |
|------|---------|----------|--------|---------|---------------------|
| Sonnet 단일 | 0% | 100% | 0% | $10,500 | — |
| 기본 라우팅 | 60% | 35% | 5% | $5,275 | ~50% |
| 최적 라우팅 | 70% | 25% | 5% | $4,375 | ~58% |
| 극단적 라우팅 | 80% | 18% | 2% | $3,340 | ~68% |

**품질 회귀 방지 체계 (신규 — 양 리뷰 공통 누락 보완):**

| 항목 | 방법 |
|------|------|
| Golden set eval | 작업유형별 50개 테스트 케이스, 라우팅/요약/캐시 변경 시 자동 실행 |
| Offline eval pipeline | 주 1회 전체 eval, 품질 점수 5% 이상 하락 시 자동 롤백 |
| Rollback 조건 | quality_score < threshold OR error_rate > 5% → 이전 설정 복원 |
| Feature flag | 모든 최적화에 개별 flag, 고객/테넌트 단위 on/off |
| A/B test | 새 최적화 도입 시 10% 트래픽으로 canary 배포, 1주 관찰 후 전체 적용 |

**KPI:**
- `quality_acceptance_rate` — 목표: baseline 대비 95% 이상 유지
- `fallback_to_premium_rate` (저가 모델 → 상위 모델 에스컬레이션 비율) — 목표: < 15%
- `resolved_cost_per_request` — 목표: Phase 1 대비 추가 30% 감소
- `routing_accuracy` (라우팅 적정성) — 목표: > 85%

---

### Phase 4: 구조적 최적화 (3-6개월)

**목표:** 장기적으로 비용 하한(cost floor)을 더 낮춘다

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 4-1 | ML 분류기 기반 지능형 라우팅 | 전체 50-65% | 높음 |
| 4-2 | RAG 파이프라인 도입/최적화 | input 90-97% | 높음 |
| 4-3 | Semantic Cache 도입 | hit 시 100% | 높음 |
| 4-4 | 반복 작업 Fine-tuning (Indeed 패턴) | 프롬프트 80% 절감 | 높음 |
| 4-5 | 멀티벤더 전략 (저가 모델 혼합) | 전체 30-50% 추가 | 중간-높음 |
| 4-6 | 조직별 정책 엔진 + chargeback | 거버넌스 | 높음 |
| 4-7 | 캐시 히트율 기반 고객 리워드/할인 | 고객 충성 | 중간 |

**Fine-tuning 적용 기준:**
- 동일 포맷 작업이 월 10만+ 건 반복
- 현재 few-shot 예시가 프롬프트의 50% 이상 차지
- Indeed 사례: fine-tuning으로 프롬프트 토큰 80% 절감, 월 처리량 100만→2,000만 [S6]

**KPI:**
- `repeated_workflow_cost_delta` — 목표: fine-tuning 전 대비 60% 절감
- `fine_tuning_roi` — 목표: 3개월 내 학습 비용 회수
- `semantic_cache_hit_rate` — 목표: 반복 워크로드 > 40%
- `net_margin_after_discount` — 목표: > 15%

---

### Phase 5: 선택적 셀프호스팅 (6개월+, 조건부)

**진입 조건:**
- 월 토큰 처리량 50M+ (codex 기준) 또는 500M+ (보수적 기준)
- 민감데이터/데이터 주권/지역 규제 요구
- 특정 task에서 소형~중형 오픈모델로 quality bar 충족

**셀프호스팅 손익분기 (논문 [S8] 기반):**

| 오픈모델 | vs Opus 4.6 | vs Sonnet 4.6 | vs GPT-4.1 |
|---------|------------:|-------------:|----------:|
| EXAONE 4.0 32B | 0.3개월 | 1.4개월 | ~2개월 |
| Qwen3-30B | 0.3개월 | 1.6개월 | ~2.5개월 |
| Llama 3.3 70B | 2.3개월 | 11.4개월 | ~18개월 |
| Qwen3-235B | 4.3개월 | 21.8개월 | ~34개월 |

**판단 기준:**

| 월 처리량 | 권장 | 이유 |
|----------|------|------|
| < 10M tokens | API 전용 | 인프라 비용이 API보다 높음 |
| 10M-50M | 하이브리드 검토 | 소형 모델(30B급)만 손익분기 가능 |
| 50M+ | 선택적 셀프호스팅 | 소형/중형 모델 경제성 확보 |
| 500M+ | 적극 셀프호스팅 | 대형 모델도 경제성 가능 |

**운영 원칙:**
- Default는 managed API, 셀프호스팅은 예외적 워크로드에만
- 피크/버스트 트래픽은 API를 오버플로 버퍼로 활용
- 숨겨진 비용 고려: 엔지니어링 인건비(TCO의 45-55%), DevOps 운영, 모니터링

**KPI:**
- `self_hosting_cost_per_token` vs `api_cost_per_token` — 목표: 40%+ 절감
- `self_hosting_uptime` — 목표: > 99.5%
- `gpu_utilization` — 목표: > 70%

---

## 5. 벤치마크 및 사례 (Benchmarks & Case Studies)

### 5.1 성능/비용 효율 비교 (논문 [S8] 기반)

> 가정: 1M input + 0.2M output workload, blended API cost

| 모델 | 벤치마크 평균 | blended cost | 효율 점수 | 해석 |
|------|-------------|-------------|----------|------|
| Gemini 2.5 Pro | 86.85 | $3.25 | 26.72 | 최고 가성비 |
| GPT-5 | 84.68 | $3.25 | 26.05 | Gemini과 유사한 효율 |
| Opus 4.6 | ~76 (추정) | $10.00 | ~7.6 | 최고급 reasoning 전용 |
| Sonnet 4.6 | ~73 (추정) | $6.00 | ~12.2 | 범용 production |

> benchmark_claude의 효율 점수(DeepSeek V3.2: 310.86 등)는 가격 오류($0.14/$0.28)에 기반하여 신뢰 불가. 위 표는 codex 문서의 공식 가격 기반 계산을 사용.

### 5.2 검증된 기업 사례

| 기업 | 전략 | 절감 수치 | 출처 |
|------|------|----------|------|
| **Care Access** | Amazon Bedrock prompt caching | 비용 86% 절감, 처리속도 66% 향상 | AWS 공식 [S5] |
| **Indeed** | GPT-3.5 Turbo fine-tuning | 프롬프트 토큰 80% 절감, 월 100만→2,000만 메시지 | OpenAI 공식 [S6] |
| **Forethought** | SageMaker MME + serverless | 비용 66-80% 절감 | AWS 공식 [S7] |
| **Zenken** | ChatGPT Enterprise 전사 도입 | 연간 외주비 5,000만엔 절감 | OpenAI 공식 [S10] |

**사례에서 추출되는 공통 원칙:**
1. 절감은 모델 교체보다 **구조 변경**(캐시, 프롬프트 축소, 배치)에서 더 크게 나온다
2. 장문 컨텍스트가 있는 서비스는 **캐싱 우선순위가 가장 높다** (최대 86%)
3. 비용 지표는 토큰만 보면 불충분 — cache hit rate, 평균 input/output 길이, GPU utilization 함께 관찰

> benchmark_claude의 Duolingo, UC Berkeley/Canva 사례는 공개 수치가 제한적이나 보조 참고로는 유용. UC Berkeley 연구는 지능형 라우팅으로 85% 비용 절감, GPT-4 성능의 95% 유지를 보고.

### 5.3 산업별 비용 특성

| 산업 | 비용이 커지는 지점 | 우선 적용 레버 |
|------|-------------------|--------------|
| 고객지원/헬프데스크 | 긴 히스토리, RAG 컨텍스트, 높은 QPS | 캐싱, 요약, FAQ semantic cache, 소형 모델 라우팅 |
| SW 개발/코딩 보조 | output 길이, 고성능 모델 사용 빈도 | tiered routing, 난도 분류, max output 제한 |
| 헬스케어/금융 | 규제, 데이터 주권, region premium | regional endpoint, hybrid/local inference |
| 세일즈/지식업무 | 반복 조사/요약/번역 | fine-tuning, 표준 템플릿, 업무 재설계 |
| 이커머스 | 대량 반복 (상품 설명, 검색) | 셀프호스팅/경량 모델, Batch API |

### 5.4 비용 최적화 성숙도 모델 (benchmark_claude 차용)

```
Level 1: 기본           → 단일 모델, 최적화 없음
Level 2: 프롬프트 최적화  → 프롬프트 압축, output 제한          (30-40% 절감)
Level 3: 모델 티어링     → 작업별 모델 분배, 배치 처리          (60-70% 절감)
Level 4: 인프라 최적화    → 캐싱, RAG 최적화, fine-tuning       (70-80% 절감)
Level 5: 하이브리드      → 셀프호스팅 + API, 자동 라우팅        (80-90% 절감)
```

---

## 6. Codex 리뷰 지적사항 교차검증

> 대상: research_token_review_codex.md의 주요 지적에 대한 동의/반박

### 6.1 가격/모델 정합성 지적

| # | Codex 리뷰 지적 | 판정 | 코멘트 |
|---|-----------------|------|--------|
| 1 | Opus 4.6가 $15/$75로 오기 | **동의** | 공식 가격 $5/$25. benchmark_claude의 가장 심각한 오류. 효율 계산 전체에 전파됨 |
| 2 | GPT-5.2, GPT-5.3 Codex는 미발표 모델 | **동의** | GPT-4.1이 2026-04 기준 확인 가능한 최신. GPT-5는 존재하나 5.2/5.3은 미확인 |
| 3 | Gemini 3.1 Pro는 비공식 | **동의** | 공식은 Gemini 2.5 계열. 3.1 Pro는 확인 불가 |
| 4 | DeepSeek V3.2 가격이 cache hit/miss 혼동 | **동의** | Codex 문서의 $0.27(miss)/$0.07(hit)이 공식 API 문서와 일치 |
| 5 | DeepSeek V4는 존재하지 않음 | **동의** | 2026-04 기준 V3.2가 최신, V4는 미발표 |

### 6.2 구조/전략 지적

| # | Codex 리뷰 지적 | 판정 | 코멘트 |
|---|-----------------|------|--------|
| 6 | Batch+Cache 95%를 일반 기대치처럼 제시 | **동의** | 95%는 상한. provider 문서도 "최대"를 명시했으나 맥락상 기본 기대값으로 읽힘. 본 문서에서 보수적 추정(60-80%)으로 교정 |
| 7 | prompt caching 구현 예시가 부정확 | **동의** | 공식 문서는 content block 내 breakpoint 방식. top-level cache_control은 과도한 단순화 |
| 8 | RAG 비용에 OpenAI ada-002 혼용 | **동의** | Anthropic 관점 문서에서 OpenAI 임베딩 비용 인용은 부적절. 벤더별 분리 필요 |
| 9 | 가격 버전 관리 체계 누락 | **동의** | 벤더 가격은 자주 변경됨. rate_card_version + effective_date 관리 필수. Phase 0에 반영 |
| 10 | 품질 회귀 방지 체계 누락 | **동의** | golden set, offline eval, rollback 조건, feature flag 모두 필수. Phase 3에 반영 |
| 11 | usage schema 정규화 누락 | **동의** | 벤더마다 usage 필드가 다름 (cached, reasoning 등). normalized_usage_events 설계 필요. Phase 0에 반영 |
| 12 | 비토큰 비용(Vector DB, embedding) 미반영 | **부분 동의** | AWS 사례에서 소규모 서비스의 Vector DB가 비용의 50% 차지 가능. 다만 LLM 토큰 비용 절감이 본 문서의 주제이므로, 비토큰 비용은 별도 문서로 분리하는 것이 적절 |
| 13 | 과금 정책과 할인 정책의 연결 부재 | **동의** | 마진 방어 규칙, 엔터프라이즈 예외 계약 필요. §3.5에 마진 방어 규칙 신규 추가 |
| 14 | 실험 설계(A/B, canary) 누락 | **동의** | Phase 3에 canary 배포 + golden set eval 체계 반영 |

### 6.3 benchmark_claude 평가에 대한 코멘트

Codex 리뷰는 benchmark_claude를 **C등급**으로 평가했다. 이에 대해:

- **등급 자체는 적절**: 핵심 가격 데이터 오류, 미발표 모델명, 2차 출처 의존은 벤치마크 문서로서 치명적
- **다만 살릴 수 있는 부분**: 비용 최적화 성숙도 모델(Level 1-5), 산업별 사용 사례 매핑, 즉시 적용 체크리스트는 유용 → 본 문서 §5.3, §5.4에 반영
- **Claude 리뷰(review_claude)도 같은 문제를 지적**: 두 리뷰의 교차검증 결과 일치하므로 신뢰도 높음

### 6.4 추가 관점 (양 리뷰 모두에서 누락)

| 항목 | 중요도 | 본 문서 반영 |
|------|--------|------------|
| Extended thinking/reasoning 토큰 과금 | 높음 | 미반영 — 별도 리서치 필요 |
| Agent/Tool use 다중 호출 비용 폭증 | 높음 | 미반영 — 에이전트 비용 모델 별도 설계 필요 |
| 한국 시장 특수성 (데이터 주권, 원화 결제) | 높음 | 미반영 — 국내 운영 시 별도 고려 |
| 멀티모달(이미지/오디오) 비용 구조 | 중간 | 미반영 — 텍스트 외 모달리티 별도 분석 |
| Rate limit과 비용의 상호작용 | 중간 | 미반영 — 높은 RPM에서의 throttling 영향 분석 필요 |

---

## 7. 셀프호스팅 판단 기준

### 7.1 의사결정 플로우차트

```
월 토큰 처리량 확인
  |-- < 10M tokens/월 → API 전용 (최적화에 집중)
  |-- 10M~50M → 민감데이터/규제 요구 있는가?
  |    |-- Yes → 소형 오픈모델(30B급) 하이브리드 검토
  |    +-- No  → API 전용 (비용 최적화로 충분)
  |-- 50M~500M → 워크로드 중 저복잡도 비율은?
  |    |-- > 60% → 소형~중형 모델 셀프호스팅 + API fallback
  |    +-- < 60% → API + 라우팅 최적화
  +-- 500M+ → 적극 셀프호스팅 (대형 모델도 경제성)
```

### 7.2 셀프호스팅 숨겨진 비용

| 항목 | TCO 비중 | 설명 |
|------|---------|------|
| **엔지니어링 인건비** | 45-55% | 최대 비용. 셋업 20-40시간, 유지보수 월 5-10시간 |
| GPU 임대/구매 | 30-40% | H100 월 $2,000-$3,500 |
| DevOps 운영 | 5-10% | 모니터링, 보안 패치, 인시던트 대응 |
| 모델 가중치 다운로드 | 2-5% | 일회성 |

### 7.3 하이브리드 운영 원칙

- **개발/테스트/저용량**: 상용 API (유연성, 초기 비용 없음)
- **고용량 프로덕션**: 사용 패턴 확립 후 셀프호스팅 전환
- **피크/버스트**: API를 오버플로 버퍼로 활용
- **Default는 항상 managed API**, 셀프호스팅은 검증된 예외

---

## 부록

### A. 문서별 신뢰도 등급 및 활용 가이드

| 문서 | 등급 | 활용 범위 |
|------|------|----------|
| provider | B+ | 운영 절감 레버, 우선순위 — 가격/구현 예시는 교정 후 사용 |
| customer | A- | 제품 기능 설계, 패키징, 고객 UX — 정량 근거는 codex로 보완 |
| benchmark_claude | C | 아이디어 풀(성숙도 모델, 산업별 분류) — **가격/벤치마크는 사용 금지** |
| benchmark_codex | A | 정량 근거, 기업 사례, 셀프호스팅 분석 — 가격은 공식 출처 직접 인용 |
| review_claude | A | 크로스 리뷰 — codex 리뷰와 지적사항 일치, 통합 실행 계획 초안 유용 |
| review_codex | A | 크로스 리뷰 — 가격 버전 관리, 품질 회귀 방지, usage schema 등 핵심 누락 지적 |

### B. 출처 매트릭스

| 코드 | 출처 | 유형 |
|------|------|------|
| [S1] | [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | 공식 문서 |
| [S2] | [OpenAI GPT-4.1](https://openai.com/index/gpt-4-1/) | 공식 발표 |
| [S3] | [Google Gemini Pricing](https://ai.google.dev/pricing) | 공식 문서 |
| [S4] | [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | 공식 문서 |
| [S5] | [Care Access — Bedrock Caching](https://aws.amazon.com/blogs/machine-learning/how-care-access-achieved-86-data-processing-cost-reductions-and-66-faster-data-processing-with-amazon-bedrock-prompt-caching/) | AWS 공식 사례 |
| [S6] | [Indeed — Fine-tuning](https://openai.com/index/introducing-improvements-to-the-fine-tuning-api-and-expanding-our-custom-models-program/) | OpenAI 공식 사례 |
| [S7] | [Forethought — SageMaker](https://aws.amazon.com/blogs/machine-learning/how-forethought-saves-over-66-in-costs-for-generative-ai-models-using-amazon-sagemaker/) | AWS 공식 사례 |
| [S8] | [Pan et al., On-Premise LLM Deployment](https://arxiv.org/abs/2509.18101) | arXiv 논문 |
| [S9] | [AWS — GenAI Cost Optimization](https://aws.amazon.com/blogs/machine-learning/optimizing-costs-of-generative-ai-applications-on-aws/) | AWS 공식 가이드 |
| [S10] | [Zenken — ChatGPT Enterprise](https://openai.com/index/zenken/) | OpenAI 공식 사례 |
| [S11] | [Menlo Ventures — Enterprise AI 2025](https://menlovc.com/wp-content/uploads/2025/12/menlo_ventures_enterprise_ai_report-2025-121925.pdf) | 리서치 리포트 |
| [S12] | [Altman Solon — Cloud & GenAI Survey](https://www.altmansolon.com/hubfs/Cowen-Cloud-Generative-AI-Survey-2025.pdf) | 리서치 리포트 |

### C. 후속 리서치 필요 항목

| 항목 | 중요도 | 이유 |
|------|--------|------|
| Extended thinking/reasoning 토큰 비용 모델 | 높음 | Claude extended thinking, o-series thinking 토큰은 별도 과금, output의 수배 가능 |
| Agent/Tool use 다중 호출 비용 패턴 | 높음 | tool 정의 오버헤드(300-700토큰/tool), 에이전트 루프의 비용 폭증 위험 |
| 한국 시장 운영 모델 | 높음 | 데이터 주권, 원화 결제, 국내 클라우드(NCP, KT Cloud) 연동 |
| 멀티모달 비용 구조 | 중간 | 이미지/오디오/비디오 토큰은 텍스트와 과금 구조 상이 |
| 가격 하락 추세 활용 계약 전략 | 중간 | 2025-2026 가격 ~80% 하락, 커밋먼트 시점/재협상 주기 최적화 |
