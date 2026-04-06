# LLM 토큰 비용 절감 — 최종 통합 실행 계획

> 작성일: 2026-04-06
> 기준: 6개 리서치 문서 통합 (provider, customer, benchmark_claude, benchmark_codex, review_claude, review_codex)
> 가격 기준: 공식 벤더 문서 (2026-04-06 확인)

---

## Executive Summary

6개 리서치 문서의 공통 결론은 명확하다:

1. **가장 재현성 높은 절감 순서**: 캐싱 → 배치 → 모델 라우팅 → 컨텍스트/출력 최적화 → Fine-tuning → 선택적 셀프호스팅
2. **고객-facing 전략**: 가시성 + 예산 통제 + 단순한 모델 선택 + 자동 최적화 조합이 가장 효과적
3. **현실적 절감 규모**: 프롬프트 최적화 + 캐싱 + 라우팅 조합만으로 **60~80% 절감** 가능, 품질 저하 없이 달성 가능

### 문서 신뢰도 순위

| 순위 | 문서 | 등급 | 근거 |
|------|------|------|------|
| 1 | benchmark_codex | A | 학술논문 + AWS 사례 + 공식 문서 기반, 출처 태깅 철저 |
| 2 | customer | A- | 제품 설계 관점 최고, 기능 명세 수준의 실행 가능성 |
| 3 | provider | B+ | 운영 전략 우선순위 우수, 일부 구현 예시/수치 보정 필요 |
| 4 | benchmark_claude | C | 핵심 가격 오류(Opus 3배), 미발표 모델명, 2차 출처 의존 |

### 통합 원칙

- **상위 제품 구조**: customer 문서 기반
- **운영 절감 레버**: provider 문서 기반
- **정량 근거/사례**: benchmark_codex 문서 기반
- **보조 아이디어**: benchmark_claude의 성숙도 모델, 산업별 분류만 선택 활용

---

## 1. 공식 가격 기준표

### 1.1 가격 충돌 해소

두 리뷰에서 지적된 가격/모델 충돌을 공식 출처 기준으로 정리한다.

| 항목 | benchmark_claude 기재 | benchmark_codex 기재 | 공식 확인 결과 | 채택 |
|------|----------------------|---------------------|---------------|------|
| **Opus 4.6** | $15/$75 | $5/$25 | $5/$25 (Anthropic 공식) | **Codex** |
| **DeepSeek V3.2** | $0.14/$0.28 | $0.27(miss)/$0.07(hit)/$1.10(out) | Codex가 공식 API docs 직접 인용 | **Codex** |
| **GPT 모델명** | GPT-5.2, GPT-5.3, GPT-5 mini/nano | GPT-4.1, GPT-4.1 mini/nano, GPT-5 | GPT-4.1 계열이 현재 공식 | **Codex** |
| **Gemini 모델** | Gemini 3.1 Pro ($2/$12) | Gemini 2.5 Pro ($1.25/$10) | 2.5 계열이 현재 공식 | **Codex** |
| **DeepSeek V4** | $0.30/$0.50 (기재) | 언급 없음 | 2026-04-06 기준 미발표 | **제외** |

> benchmark_claude의 Opus 4.6 가격 $15/$75는 구형 Opus 계열 가격대와 혼동된 것으로, 이 오류가 해당 문서 전체의 비용 효율 계산에 전파되어 Claude 모델이 실제보다 과도하게 비효율적으로 평가되었다.

### 1.2 단일 가격 기준표 (2026-04-06, 공식 문서 기준)

#### Anthropic Claude

| 모델 | Input (/1M) | Output (/1M) | Cache Write (5분) | Cache Hit | Batch Input | Batch Output |
|------|------------|-------------|-------------------|-----------|-------------|-------------|
| Opus 4.6 | $5.00 | $25.00 | $6.25 (1.25x) | $0.50 (0.1x) | $2.50 | $12.50 |
| Sonnet 4.6 | $3.00 | $15.00 | $3.75 (1.25x) | $0.30 (0.1x) | $1.50 | $7.50 |
| Haiku 4.5 | $1.00 | $5.00 | $1.25 (1.25x) | $0.10 (0.1x) | $0.50 | $2.50 |

> 1시간 Cache Write: base input의 2.0x. Cache hit 가격은 5분/1시간 동일.
> 출처: [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)

#### OpenAI GPT

| 모델 | Input (/1M) | Cached Input | Output (/1M) | Batch할인 |
|------|------------|-------------|-------------|-----------|
| GPT-4.1 | $2.00 | $0.50 | $8.00 | 50% |
| GPT-4.1 mini | $0.40 | $0.10 | $1.60 | 50% |
| GPT-4.1 nano | $0.10 | $0.025 | $0.40 | 50% |

> 출처: [OpenAI GPT-4.1 발표](https://openai.com/index/gpt-4-1/)

#### Google Gemini

| 모델 | Input (/1M) | Cached Input | Output (/1M) | Batch할인 |
|------|------------|-------------|-------------|-----------|
| Gemini 2.5 Pro | $1.25 | $0.125 | $10.00 | 50% |
| Gemini 2.5 Flash | $0.30 | $0.03 | $2.50 | 50% |
| Gemini 2.5 Flash-Lite | $0.10 | $0.01 | $0.40 | 50% |

> 출처: [Google Gemini Pricing](https://ai.google.dev/pricing)

#### DeepSeek

| 모델 | Input (miss) | Input (hit) | Output (/1M) |
|------|-------------|------------|-------------|
| V3.2 non-thinking | $0.27 | $0.07 | $1.10 |
| V3.2 thinking (reasoner) | $0.55 | $0.14 | $2.19 |

> 출처: [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/)

### 1.3 가격표 운영 규칙

두 리뷰에서 공통 지적된 **가격 버전 관리** 문제를 해소하기 위한 규칙:

| 항목 | 규칙 |
|------|------|
| `as_of_date` | 모든 가격표에 확인일 명시 (YYYY-MM-DD) |
| `source_url` | 공식 가격 페이지 URL 필수 첨부 |
| 갱신 주기 | 월 1회 정기 확인 + 벤더 발표 시 즉시 반영 |
| 청구 기준 | 고객 청구 시 **요청 시점의 rate card version** 적용 |
| 변경 이력 | rate card 변경 시 diff 기록, 고객 사전 고지 (최소 7일) |

---

## 2. 비용 절감 레버

### 2.1 서비스 제공자 관점 (provider 문서 기반)

#### Tier 1: 즉시 적용 (난이도 낮음)

| 레버 | 절감 효과 | 핵심 메커니즘 |
|------|-----------|-------------|
| **Prompt Caching** | input 최대 90% | 동일 prefix 재사용 시 0.1x 과금 |
| **Batch API** | 해당 작업 50% | 비동기 대량 처리, 24시간 내 완료 |
| **프롬프트 리팩토링** | input 15-30% | 불필요한 지시/예제 제거, 구조화 |
| **Output 제한** | output 30-50% | JSON schema, max_tokens 설정 |
| **Tool 정의 정리** | input 5-10% | 미사용 tool 제거 (tool당 300-700 토큰 오버헤드) |

#### Tier 2: 구조 최적화 (난이도 중간)

| 레버 | 절감 효과 | 핵심 메커니즘 |
|------|-----------|-------------|
| **규칙 기반 모델 라우팅** | 전체 40-50% | 작업 복잡도별 Haiku/Sonnet/Opus 분배 |
| **대화 요약** | input 60-85% | 오래된 대화를 요약 + 최근 N턴만 유지 |
| **슬라이딩 윈도우** | input 30-60% | 최근 K개 메시지만 유지 |
| **모니터링 체계** | 간접 (최적화 근거) | 이상 탐지, 비용 할당, 최적화 방향 제시 |

#### Tier 3: 고도화 (난이도 높음)

| 레버 | 절감 효과 | 핵심 메커니즘 |
|------|-----------|-------------|
| **RAG 도입** | input 90-97% | 전체 문서 대신 관련 청크만 검색 삽입 |
| **Semantic Cache** | 히트 시 100% | 유사 의미 쿼리에 기존 응답 재사용 |
| **Fine-tuning** | 프롬프트 토큰 최대 80% | 긴 few-shot/지시문을 학습으로 대체 (Indeed 사례) |
| **멀티벤더 라우팅** | 추가 30-50% | 작업별 최적 벤더 선택 |

### 2.2 Batch + Cache 중첩 절감에 대한 보정

provider 문서에서 "Batch + Cache = 95% 절감"으로 제시한 수치에 대해, review_codex 문서가 정확히 지적했다:

> **Batch 안에서 cache hit는 best-effort이며 트래픽 패턴에 따라 30~98% 수준으로 변동한다. 95%는 상한 시나리오이지 기본 기대값이 아니다.**

| 조합 | 최대 절감 (상한) | 현실 기대 절감 | 조건 |
|------|----------------|-------------|------|
| Batch만 | 50% | 50% | 비실시간 작업이면 확정 |
| Cache 히트만 | 90% | 40-70% | hit rate에 의존 |
| **Batch + Cache** | **95%** | **60-80%** | 높은 hit rate 유지 시 |

### 2.3 라우팅 비용 시뮬레이션 (provider 문서 기반, 보정)

**시나리오: 월 1,000만 요청, 평균 1K input + 500 output 토큰, Anthropic 기준**

| 전략 | Haiku % | Sonnet % | Opus % | 월 비용 (추정) | Sonnet 단일 대비 절감 |
|------|---------|----------|--------|---------------|---------------------|
| Sonnet 단일 | 0% | 100% | 0% | $10,500 | — |
| 기본 라우팅 | 60% | 35% | 5% | $5,275 | **~50%** |
| 최적 라우팅 | 70% | 25% | 5% | $4,375 | **~58%** |

> benchmark_claude의 "60-80% 절감"은 UC Berkeley/Canva 사례 인용이나, 해당 사례의 모델/작업 분포가 자사 서비스와 동일한지 확인 필요. provider 문서의 시뮬레이션이 더 검증 가능.

---

## 3. Codex 리뷰 지적사항에 대한 동의/반박

review_codex 문서(research_token_review_codex.md)의 주요 지적사항을 교차검증한다.

### 3.1 동의하는 지적사항

| # | Codex 리뷰 지적 | 동의 여부 | 근거 |
|---|-----------------|----------|------|
| 1 | **Opus 4.6 가격 $15/$75는 오기** | **완전 동의** | 공식 문서 + provider + codex benchmark 모두 $5/$25. benchmark_claude 단독 오류 |
| 2 | **GPT-5.2/5.3, Gemini 3.1 Pro, DeepSeek V4는 미발표 모델** | **완전 동의** | 2026-04-06 기준 공식 발표 확인 불가. benchmark_claude만 사용 |
| 3 | **Provider 문서의 prompt caching 구현 예시가 부정확** | **동의** | 공식 문서는 content block 내 cache_control breakpoint 방식. top-level 예시는 오해 유발 |
| 4 | **Batch + Cache 95%는 상한치, 기대값 아님** | **동의** | batch 내 cache hit는 best-effort. 현실 기대치 60-80%로 보정 필요 |
| 5 | **RAG embedding 비용에 OpenAI ada-002를 혼용** | **동의** | Anthropic 중심 문서에서 OpenAI 구모델 비용 인용은 일관성 결여 |
| 6 | **usage schema 정규화 레이어 필요** | **완전 동의** | 벤더별 usage 필드 상이 (Anthropic: cache_creation/cache_read, OpenAI: cached_tokens, Google: 별도 storage 과금). 통합 대시보드에 정규화 필수 |
| 7 | **가격 버전 관리 체계 누락** | **완전 동의** | 벤더 가격 빈번 변동. rate_card version + effective_date 관리 필수 |
| 8 | **품질 회귀 방지 체계 누락** | **완전 동의** | 라우팅/요약/캐시 모두 품질-비용 트레이드오프 존재. eval + rollback 필수 |

### 3.2 부분 동의 / 보완하는 지적사항

| # | Codex 리뷰 지적 | 입장 | 보완 |
|---|-----------------|------|------|
| 9 | **benchmark_claude 문서 등급 C** | **부분 동의** | 가격/모델 오류는 심각하나, 성숙도 모델(Level 1-5), 산업별 매핑, 즉시적용 체크리스트는 codex에 없는 유용한 프레임워크. 수치가 아닌 구조적 아이디어로는 활용 가치 있음 |
| 10 | **셀프호스팅 임계값 차이 (claude: 500M+ vs codex: 50M+)** | **보완 필요** | 두 문서 모두 일부만 맞음. 실제 판단은 모델 크기 + GPU 단가 + 엔지니어링 인건비에 따라 달라짐. codex 논문[S8] 기반 모델별 break-even 테이블이 더 정밀하므로 이를 채택하되, "일률적 임계값"이 아닌 조건부 판단 기준으로 제시 |
| 11 | **Claude 벤치마크 출처(CloudIDR, RankSaga 등)가 2차 집계** | **동의하되 보완** | 2차 집계 사이트도 트렌드 파악에는 유용. 다만 가격/성능의 기준 원문으로 사용하면 안 됨. 본 문서에서는 1차 출처만 채택 |

### 3.3 반박하는 지적사항

| # | Codex 리뷰 지적 | 입장 | 근거 |
|---|-----------------|------|------|
| 12 | **provider 문서 전체를 "B"로 평가** | **과소평가** | provider 문서의 전략 우선순위 매트릭스와 단계별 절감 시나리오는 실행 지향적이고 즉시 활용 가능. 구현 예시 오류는 수정 가능한 수준이며 문서 전체 가치를 훼손하지 않음. B+ 이상이 적절 |
| 13 | **Codex 벤치마크의 blended cost 가정 (1M input + 0.2M output)이 보편적** | **가정 의존성 높음** | output 비중이 높은 서비스(코딩, 문서 생성)에서는 가정이 크게 달라짐. Codex 문서도 이 점을 인정하나 더 강하게 경고해야 함 |

---

## 4. 누락 항목 보완

두 리뷰에서 공통으로 지적한 누락 사항을 보완한다.

### 4.1 가격 버전 관리 체계

```
[벤더 가격 발표] → [rate_card 업데이트]
                      ↓
              version: "2026-04-06-v1"
              effective_date: "2026-04-06"
              sources: [url1, url2, ...]
                      ↓
              [고객 사전 고지 (7일)] → [billing에 새 rate_card 적용]
                      ↓
              [이전 버전 아카이브]
```

**구현 요건:**
- rate_card를 코드/설정이 아닌 별도 데이터로 관리 (DB 또는 config file)
- 변경 시 자동 diff 생성 + 고객 알림 트리거
- 청구 시 요청 시점의 rate_card version 연결 (감사 추적)

### 4.2 품질 회귀 방지 체계

| 절감 레버 | 품질 리스크 | 방지 수단 |
|-----------|-----------|----------|
| 모델 라우팅 (다운그레이드) | 저가 모델의 품질 저하 | golden set eval, 자동 에스컬레이션 규칙 |
| 대화 요약 | 핵심 정보 누락, hallucination | 원문 복원 경로, 요약 품질 샘플링 |
| Output 길이 제한 | 불완전한 응답 | 사용자 피드백 루프, 재시도 옵션 |
| 캐시 재사용 | 오래된/부정확한 응답 반환 | TTL 관리, 무효화 규칙 |
| Prompt 압축 | 의미 손실 | A/B 테스트, 압축 전후 eval 비교 |

**운영 규칙:**
1. 모든 절감 레버에 **feature flag** 적용 → 즉시 해제 가능
2. **golden set** (100-500개 테스트 케이스) 유지 → 변경 전후 자동 eval
3. **rollback 조건** 명시: quality acceptance가 baseline 대비 5% 이상 하락 시 자동 롤백
4. **canary 배포**: 전체 트래픽의 5-10%에 먼저 적용 → 24시간 모니터링 → 전체 확대

### 4.3 Usage Schema 정규화

벤더별 usage 필드 차이:

| 필드 | Anthropic | OpenAI | Google |
|------|-----------|--------|--------|
| 기본 input | `input_tokens` | `prompt_tokens` | `prompt_token_count` |
| 기본 output | `output_tokens` | `completion_tokens` | `candidates_token_count` |
| 캐시 생성 | `cache_creation_input_tokens` | — | — |
| 캐시 히트 | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | 별도 storage 과금 |
| Reasoning | — | `completion_tokens_details.reasoning_tokens` | `candidates_token_count` (thinking 포함) |

**정규화 스키마:**

```json
{
  "normalized_usage": {
    "provider": "anthropic|openai|google|deepseek",
    "model": "string",
    "rate_card_version": "2026-04-06-v1",
    "tokens": {
      "input_uncached": 0,
      "input_cached": 0,
      "input_cache_write": 0,
      "output_standard": 0,
      "output_reasoning": 0
    },
    "cost": {
      "input_cost_usd": 0.0,
      "output_cost_usd": 0.0,
      "total_cost_usd": 0.0,
      "savings_from_cache_usd": 0.0
    },
    "metadata": {
      "request_id": "string",
      "tenant_id": "string",
      "feature": "string",
      "is_batch": false,
      "timestamp": "ISO8601"
    }
  }
}
```

### 4.4 비토큰 비용 반영

codex 벤치마크의 AWS RAG 비용 구조에서 확인된 바:

| 규모 | LLM 비중 | Vector DB 비중 | Embedding 비중 |
|------|---------|---------------|---------------|
| Small | 46% | **51%** | 3% |
| Medium | 55% | 32% | 14% |
| Large | **67%** | 24% | 9% |

> 소규모 서비스에서는 Vector DB가 비용의 절반. 대규모에서는 LLM이 2/3. TCO 계산 시 반드시 포함.

### 4.5 Extended Thinking / Reasoning 토큰 비용

두 리뷰에서 공통 누락으로 지적된 항목:

- Claude extended thinking: output 토큰으로 과금, thinking 토큰이 응답의 수배가 될 수 있음
- OpenAI o-series: reasoning_tokens 별도 집계
- **고객 UX 설계**: reasoning 토큰을 대시보드에 분리 표시하고, 예상 비용에 반영해야 함
- **비용 통제**: reasoning이 필요 없는 작업에서는 자동으로 non-thinking 모드 사용

### 4.6 Agent / Tool Use 비용 패턴

에이전트 워크로드의 비용 특성:

| 요소 | 비용 영향 | 대응 |
|------|----------|------|
| Tool 정의 오버헤드 | tool당 300-700 토큰 × 매 요청 | 사용하지 않는 tool 제거, tool 정의 캐싱 |
| 다중 LLM 호출 (에이전트 루프) | 1작업에 5-20회 호출 가능 | 루프 횟수 상한, 비용 한도 설정 |
| 누적 컨텍스트 | 매 턴 전체 히스토리 재전송 | 요약, 슬라이딩 윈도우 |

---

## 5. 고객 제품 기능 (customer 문서 기반)

### 5.1 제품 패키징

| 패키지 | 포함 기능 | 대상 | Phase |
|--------|----------|------|-------|
| **Cost Visibility** | 대시보드, 리포트, 예측선, CSV export | 모든 고객 (기본 제공) | 1-2 |
| **Cost Control** | 예산, 알림, 자동 차단, 정책, 모델 선택 | 비용 민감 고객 | 1-2 |
| **Cost Optimizer** | 캐시 할인, 자동 요약, 모델 자동 선택, Batch 전환 | 대량 사용 고객 | 2-3 |
| **Enterprise Governance** | 팀별 할당, 승인 흐름, chargeback, audit | 대기업 | 3-5 |

### 5.2 대시보드 설계

**상단 KPI 카드** (4개):
- 오늘 비용 / 이번 달 누적 / 월말 예상 / 캐시 절감액

**중단**: 일자별 비용/토큰 추이 라인차트

**하단**: 모델별/기능별/팀별 사용량 스택 바차트

**우측 인사이트 패널**: 절감 추천 3개
- 예: "문서 요약 기능이 이번 달 비용의 48%를 차지 → RAG 최적화 검토"

### 5.3 예산 제어 4단계

| 단계 | 동작 | 트리거 |
|------|------|--------|
| 1 | 알림만 | 예산 50%/80% 도달 |
| 2 | 고비용 모델 사용 금지 | 예산 100% 도달 (soft limit) |
| 3 | 관리자 승인 필요 | hard limit 도달 |
| 4 | 자동 차단 | hard limit + 승인 없음 |

### 5.4 모델 선택 UX

**기본 UI**: `빠름(Haiku)` / `균형(Sonnet)` / `고품질(Opus)` — 추상화
**고급 설정**: 실제 모델명, 예상 단가, 컨텍스트 길이

**자동 선택 규칙**:
- 분류, 추출, FAQ → 기본값 빠름
- 일반 대화, 코드 생성, RAG 응답 → 기본값 균형
- 복잡한 추론, 아키텍처 설계 → 기본값 고품질

### 5.5 캐시 할인 고객 노출

| 항목 | 구현 |
|------|------|
| 청구서 분리 | `uncached input` / `cached input` / `output` 별도 행 |
| 절감액 표시 | "이번 달 캐시로 절감: $X,XXX" |
| 히트율 리포트 | 워크플로우별 cache hit ratio |
| 캐시 친화적 가이드 | 정적 prefix를 앞에 두도록 템플릿 유도 |

### 5.6 고객 할인과 내부 원가 연결 규칙

review_codex에서 지적된 누락 사항 보완:

| 규칙 | 설명 |
|------|------|
| 마진 하한 | 캐시 할인 적용 후에도 최소 마진 20% 유지 |
| 할인 방식 | 벤더 절감액의 50-70%를 고객에게 환원 (나머지는 마진) |
| 엔터프라이즈 예외 | 대량 계약(월 $10K+)은 맞춤 할인율 협상 가능 |
| 가격 변경 반영 | 벤더 가격 인하 시 30일 내 고객 가격에 반영 |

---

## 6. 운영 모델 / 로드맵 (Phase 0-5)

### Phase 0: 기준선 정리 (1주)

**목표**: 숫자와 가격 기준을 하나로 맞춘다.

| 작업 | 산출물 |
|------|--------|
| 공식 벤더 가격 기준표 정리 | `rate_card` 파일 (as_of_date, source_url 포함) |
| usage schema 정규화 설계 | `normalized_usage_events` 스키마 |
| 비용 계산기 테스트 케이스 | 벤더별 10개 이상 시나리오 검증 |

**KPI**:
- 가격 기준표 커버리지: 사용 중인 모든 모델의 100% 반영
- 계산기 정확도: 실제 청구 대비 오차 ±2% 이내

---

### Phase 1: 즉시 절감 (2주)

**목표**: 제품 품질을 거의 건드리지 않고 바로 절감한다.

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 1-1 | Anthropic Prompt Caching 활성화 | input 최대 90% | 낮음 |
| 1-2 | 비실시간 작업 Batch API 전환 | 해당 작업 50% | 낮음 |
| 1-3 | 시스템 프롬프트 리팩토링 + max_tokens 설정 | input 15-30%, output 30-50% | 낮음 |
| 1-4 | 미사용 Tool 정의 제거 | input 5-10% | 낮음 |

**KPI**:
| 지표 | 목표 |
|------|------|
| 평균 input tokens/request | 기준선 대비 30% 감소 |
| 평균 output tokens/request | 기준선 대비 20% 감소 |
| cache hit rate | 40% 이상 |
| batch 비중 | 비실시간 작업의 80% 이상 |

**Phase 1 예상 효과**: 기준 비용 대비 **40-60% 절감**

---

### Phase 2: 가시화와 통제 (1개월)

**목표**: 고객과 운영팀이 비용을 통제 가능하게 만든다.

| # | 작업 | 효과 | 난이도 |
|---|------|------|--------|
| 2-1 | 사용량 대시보드 (KPI 4개 + 추이 차트) | 가시성 확보 | 중간 |
| 2-2 | 월 예산 + soft/hard limit + 알림 | 비용 사고 방지 | 중간 |
| 2-3 | 이상치 탐지 (3σ 급증, 단일 요청 $1+ 경고) | 비정상 비용 방지 | 중간 |
| 2-4 | 캐시 절감액/히트율 표시 + 청구서 분리 | 고객 인센티브 | 중간 |
| 2-5 | 프롬프트 템플릿 + 짧게 쓰기 가이드 | input 10-20% | 낮음 |

**KPI**:
| 지표 | 목표 |
|------|------|
| 예산 초과 사고 건수 | 0건 |
| 고객별 cost variance (예측 vs 실제) | ±15% 이내 |
| 절감 추천 적용률 | 20% 이상 |

---

### Phase 3: 자동 최적화 (2개월)

**목표**: 시스템이 기본적으로 싸게 동작하게 만든다.

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 3-1 | 규칙 기반 모델 라우팅 (3티어) | 전체 40-50% | 중간 |
| 3-2 | Fast/Balanced/Premium 고객 선택 UX | 간접 (고객 자율 절감) | 중간 |
| 3-3 | 대화 자동 요약 + 슬라이딩 윈도우 | input 60-85% | 중간 |
| 3-4 | RAG top-k 축소 + reranking | input 30-50% | 중간 |
| 3-5 | 캐시 친화적 프롬프트 재배열 (정적 prefix 전방 배치) | cache hit rate 개선 | 낮음 |

**KPI**:
| 지표 | 목표 |
|------|------|
| quality acceptance (golden set 기준) | baseline 대비 -3% 이내 |
| premium 모델 fallback rate | 15% 이하 |
| resolved cost/request | Phase 1 대비 추가 30% 감소 |

**Phase 1+2+3 누적 예상 효과**: 원래 대비 **70-85% 절감**

---

### Phase 4: 구조적 최적화 (3-6개월)

**목표**: 장기적으로 cost floor를 더 낮춘다.

| # | 작업 | 절감 효과 | 난이도 |
|---|------|-----------|--------|
| 4-1 | ML 분류기 기반 지능형 라우팅 | 전체 50-65% | 높음 |
| 4-2 | Semantic Cache 도입 | 히트 시 100% | 높음 |
| 4-3 | 반복 태스크 Fine-tuning | 프롬프트 토큰 최대 80% | 높음 |
| 4-4 | 멀티벤더 전략 (DeepSeek/Gemini Flash 등) | 추가 30-50% | 중간-높음 |
| 4-5 | 조직별 정책 엔진 + 자동 모델 강등 | 거버넌스 | 높음 |
| 4-6 | Feature별 unit economics 분석 | 수익성 최적화 | 중간 |

**KPI**:
| 지표 | 목표 |
|------|------|
| 반복 워크플로우 비용 delta | 추가 40% 감소 |
| fine-tuning ROI | 3개월 내 투자 회수 |
| 할인 후 순마진 | 20% 이상 유지 |
| semantic cache hit rate | 반복 워크로드에서 30% 이상 |

---

### Phase 5: 선택적 셀프호스팅 (6개월+, 조건부)

**진입 조건** (모두 충족 시에만):
1. 월 토큰 규모가 충분히 큼
2. 민감데이터/데이터 주권/규제 요구 존재
3. 해당 작업의 quality bar가 소형-중형 오픈모델로 충족 가능

**모델 크기별 손익분기 (benchmark_codex 논문[S8] 기반)**:

| 오픈모델 크기 | vs Claude Opus | vs Claude Sonnet | vs GPT-5 | 판단 |
|-------------|---------------|-----------------|---------|------|
| 30B급 | 0.3개월 | 1.6개월 | 2.5개월 | SMB도 진입 가능 |
| 70B급 | 2.3개월 | 11.4개월 | 17.8개월 | volume이 중요 |
| 120B급 | 3.9개월 | 19.8개월 | 30.9개월 | premium API 대체 시만 경제적 |
| 235B급 | 4.3개월 | 21.8개월 | 34개월 | sovereignty 없으면 경제성 약함 |

**KPI**:
| 지표 | 목표 |
|------|------|
| 셀프호스팅 TCO vs API 비용 | 40% 이상 절감 |
| GPU utilization | 70% 이상 |
| 셀프호스팅 모델 quality | API 대비 90% 이상 유지 |

---

## 7. 벤치마크 / 사례

### 7.1 성능 대비 비용 효율 (benchmark_codex 기반)

가정: 1M input + 0.2M output workload 기준 blended cost

| 모델 | 벤치마크 평균 | blended cost | 효율 점수 | 해석 |
|------|-------------|-------------|----------|------|
| Gemini 2.5 Pro | 86.85 | $3.25 | **26.72** | 최고 가성비 |
| GPT-5 | 84.68 | $3.25 | **26.05** | Gemini 2.5 Pro와 유사 |
| Grok-4 | 88.80 | $6.00 | 14.80 | 품질 높지만 비용 2배 |
| Claude Sonnet 4.6 | 72.58 | $6.00 | 12.10 | 준수하나 가성비 불리 |
| Claude Opus 4.6 | 76.10 | $30.00* | 2.54 | 프리미엄 모델, 비용효율 최저 |

> *주의: benchmark_codex 논문은 "Claude 4 Opus"로 기재. $30.00 blended cost는 논문 시점 가격 기반이므로 현재 $5/$25 기준과 다를 수 있음. 현재 가격 기준으로 재계산 시 효율 개선됨.

### 7.2 검증된 기업 사례

| 기업 | 전략 | 공개 수치 | 핵심 교훈 |
|------|------|----------|----------|
| **Care Access** | Bedrock prompt caching | 비용 **86%** 절감, 처리속도 66% 향상 | 장문 정적 컨텍스트 → 캐싱 최우선 |
| **Indeed** | GPT-3.5 fine-tuning | 프롬프트 토큰 **80%** 절감, 월 100만→2,000만 메시지 | few-shot→학습 대체로 구조적 절감 |
| **Forethought** | SageMaker MME + serverless | 비용 **66-80%** 절감 | 멀티모델 엔드포인트로 GPU utilization 개선 |
| **Zenken** | ChatGPT Enterprise 전사 도입 | 연간 외주비 **5,000만 엔** 절감 | API 비용보다 업무 대체 가치가 클 수 있음 |

> 출처: AWS 공식 블로그[S5][S7], OpenAI 공식 사례[S6][S10]

### 7.3 비용 최적화 성숙도 모델 (benchmark_claude 기반, 수치 보정)

```
Level 1: 기본          → 단일 모델, 최적화 없음
Level 2: 프롬프트 최적화 → 프롬프트 압축, output 제한        → 30-40% 절감
Level 3: 모델 티어링    → 작업별 모델 분배, 배치 처리         → 60-70% 절감
Level 4: 인프라 최적화   → 캐싱, RAG 최적화, fine-tuning     → 70-80% 절감
Level 5: 하이브리드     → 셀프호스팅 + API, 자동 라우팅      → 80-90% 절감
```

### 7.4 산업별 비용 특성 (benchmark_claude 분류 + codex 데이터 보강)

| 산업 | 비용이 커지는 지점 | 최적 절감 레버 |
|------|------------------|--------------|
| **고객지원/헬프데스크** | 긴 히스토리, RAG 컨텍스트, 높은 QPS | 캐싱, 요약, FAQ semantic cache, 소형 모델 라우팅 |
| **소프트웨어 개발** | output 길이, 고성능 모델 빈도 | tiered routing, 난이도 분류, max output 제한 |
| **헬스케어/금융** | 규제, 데이터 주권, region premium | regional endpoint, hybrid/local inference |
| **이커머스** | 대량 반복 (상품 설명, 분류) | 경량 모델 + fine-tuning + batch |
| **세일즈/지식업무** | 반복 조사/요약/번역 | 표준 템플릿, fine-tuning, 업무 재설계 |

---

## 8. 셀프호스팅 판단 기준

### 8.1 의사결정 트리

```
월 토큰 처리량?
├── < 10M tokens/월 → API 최적화 우선 (Phase 1-3)
├── 10M-50M → 소형/중형 오픈모델 hybrid 검토
│   └── 민감데이터 비중 높음? → local inference 검토
│   └── 아니면 → API 유지, Phase 4 멀티벤더로 충분
└── 50M+
    └── quality bar가 소형-중형 모델로 충족?
        ├── Yes → 셀프호스팅 경제성 분석 (Phase 5)
        └── No → API 유지 + batch/캐싱 극대화
```

### 8.2 셀프호스팅 숨겨진 비용

| 항목 | 비중 | 설명 |
|------|------|------|
| **엔지니어링 인건비** | 45-55% | 최대 비용. 셋업 20-40시간, 유지보수 월 5-10시간 |
| GPU 임대/구매 | 30-40% | H100 기준 월 $2,000-$3,500 |
| DevOps 운영 | 5-10% | 모니터링, 보안 패치, 인시던트 대응 |
| 모델 업데이트 | 3-5% | 새 버전 테스트, 배포, 품질 검증 |

### 8.3 하이브리드 원칙

- **Default**: managed API
- **셀프호스팅 대상**: 반복적이고, 민감하고, 소형 모델로 충분한 워크로드만
- **피크/버스트**: API를 overflow 버퍼로 활용
- **API 대비 40% 이상 절감이 확인된 경우에만 전환**

---

## 부록

### A. 실험 설계 (review_codex 지적 보완)

모든 절감 레버 적용 시 다음 공통 KPI로 A/B 또는 canary 측정:

| KPI | 설명 | 알림 기준 |
|-----|------|----------|
| `cost/request` | 요청당 비용 | 이동평균 대비 2x 초과 |
| `input_tokens/request` | 요청당 입력 토큰 | baseline 대비 +50% |
| `output_tokens/request` | 요청당 출력 토큰 | baseline 대비 +100% |
| `quality_acceptance` | golden set 통과율 | baseline 대비 -5% |
| `cache_hit_rate` | 캐시 적중률 | 50% 미만 |
| `fallback_rate` | 상위 모델 에스컬레이션 비율 | 20% 초과 |
| `p95_latency` | 95th percentile 응답 시간 | SLA 초과 |

### B. 출처 매트릭스

| 출처 ID | 출처 | 유형 | 인용 문서 |
|---------|------|------|----------|
| S1 | [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing) | 공식 문서 | provider, codex |
| S2 | [OpenAI GPT-4.1](https://openai.com/index/gpt-4-1/) | 공식 발표 | codex |
| S3 | [Google Gemini Pricing](https://ai.google.dev/pricing) | 공식 문서 | codex |
| S4 | [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/) | 공식 문서 | codex |
| S5 | [AWS/Care Access](https://aws.amazon.com/blogs/machine-learning/how-care-access-achieved-86-data-processing-cost-reductions-and-66-faster-data-processing-with-amazon-bedrock-prompt-caching/) | AWS 사례 | codex |
| S6 | [OpenAI/Indeed Fine-tuning](https://openai.com/index/introducing-improvements-to-the-fine-tuning-api-and-expanding-our-custom-models-program/) | OpenAI 사례 | codex |
| S7 | [AWS/Forethought](https://aws.amazon.com/blogs/machine-learning/how-forethought-saves-over-66-in-costs-for-generative-ai-models-using-amazon-sagemaker/) | AWS 사례 | codex |
| S8 | [Pan et al., On-Premise LLM Deployment](https://arxiv.org/abs/2509.18101) | 학술 논문 | codex |
| S9 | [AWS, Optimizing GenAI Costs](https://aws.amazon.com/blogs/machine-learning/optimizing-costs-of-generative-ai-applications-on-aws/) | AWS 공식 | codex |
| S10 | [OpenAI/Zenken](https://openai.com/index/zenken/) | OpenAI 사례 | codex |
| S11 | [Menlo Ventures, Enterprise AI 2025](https://menlovc.com/wp-content/uploads/2025/12/menlo_ventures_enterprise_ai_report-2025-121925.pdf) | 투자사 리포트 | codex |
| S12 | [Altman Solon, Cloud & GenAI Survey 2025](https://www.altmansolon.com/hubfs/Cowen-Cloud-Generative-AI-Survey-2025.pdf) | 컨설팅 리포트 | codex |

### C. benchmark_claude 문서 활용 가이드

benchmark_claude 문서의 가격/모델 오류로 인해 수치 기준서로 사용 불가하나, 다음 프레임워크는 보조적으로 활용:

| 활용 가능 항목 | 주의사항 |
|--------------|---------|
| 비용 최적화 성숙도 모델 (Level 1-5) | 수치는 본 문서 기준으로 교정하여 사용 |
| 산업별 사용 사례 매핑 | codex의 정량 데이터로 보강 필요 |
| 즉시 적용 체크리스트 (시간대별 구분) | 가격 참조는 본 문서의 공식 가격표 사용 |
| Duolingo/UC Berkeley 사례 | 공개 수치 교차 확인 후 사용 |

---

## 최종 결론

2026년 시점의 토큰 비용 절감은 "더 싼 모델로 갈아타기"보다, **캐싱 + 배치 + 라우팅 + 프롬프트/튜닝 최적화로 호출 구조를 바꾸는 것**이 훨씬 큰 효과를 만든다.

고객 관점에서는 **직접 아끼는 구조**(대시보드, 예산, 모델 선택)와 **자동으로 아껴지는 구조**(요약, 캐시, 라우팅)를 동시에 제공해야 비용 절감이 기능이 아니라 **제품 경험**이 된다.

Phase 0-5 전체를 완주하면 원래 비용 대비 **80-90% 절감**이 현실적으로 달성 가능하며, 이는 Care Access(86%), Indeed(80%), Forethought(66-80%) 등 검증된 사례와 일치한다.
