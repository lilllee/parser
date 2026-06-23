# OCR 파이프라인 개발 채널 로그

> 목적: OCR/문서파싱 개선 작업의 결정·발견·함정을 시간순으로 남겨 **향후(특히 AI 에이전트) 재참조** 가능하게.
> 형식: 최신이 위. 각 항목 = 무엇을 왜 했고, 무엇을 발견했고, 다음은 뭔지.
> 관련 문서: [anchor 개선계획](ocr-anchor-improvement-plan.md) · [Paddle 통합계획](paddle-ocr-integration-plan.md) · [pipeline.md](../pipeline.md)

---

## 인프라 상수 (자주 까먹음)

| 서버 | 주소 | 역할 | 특성 |
|---|---|---|---|
| **A (LLM)** | `192.168.0.50:8000` (`VLLM_URL=.../v1/chat/completions`) | Qwen3.5-122B-A10B-int4 (vision) | **decode ~13.6 tok/s (느림)** · 고동시성 금물(과부하 abort) |
| **B (OCR) /parse** | `192.168.0.250:8500/api/v1/parse` | PaddleOCR-VL doc-parser | HTML표+bbox · **직렬(concurrency=1)** · ~5–6.5s/page · 무인증 |
| **B (OCR) raw** | `192.168.0.250:8500/api/v1/ocr`, `:8118/v1/chat/completions` | raw 라인 OCR | 고동시성 · **표 평문화(표엔 쓰지 말 것)** |

- `.env` 는 **gitignore**(`.env`,`.env.*`) — Bedrock 토큰 등 secrets 포함. 커밋은 `.env.example` 로.
- `.env` 자동 로드: `ai.js loadLocalEnv()` 가 import 시 `.env.local`/`.env` 로드(별도 `--env-file` 불필요).
- 측정 파일: `acc_tmp/` (untracked, gitignore 아님 — 커밋 staging 시 명시적으로 제외할 것). `measure.mjs`(3지표), `paddle_*probe.mjs`, `paddle_bench.mjs`.
- ⚠ Downloads 의 테스트 PDF 파일명이 수시로 바뀜(예: `2026년 3월 인구동향(5-10).pdf` → `2026년_3월_인구동향(5-10).pdf`). 하드코딩 주의.

---

## 2026-06-23 — enrich 타임아웃 수정 + Paddle 벤치

**enrich 0/N fail 원인 = 타임아웃.** Paddle e2e 에서 `enrich 0/5 fail` 관측 → 진단: enrich(차트해설)는
공용 `AI_TIMEOUT_MS`(기본 60s)를 쓰는데, 122B vision 이 maxTokens 1280 ≈ 90s+ 라 60s 에서 abort.
- 수정: `cfg.timeouts.enrichMs`(기본 240s, `VLLM_ENRICH_TIMEOUT_MS`) 추가 → `aiCall` 기본 timeout 으로
  주입. OCR 호출은 `timeoutMs: ocrMs` 를 명시하므로 그대로(우선). `server/config/vllm.js`, `server/vllm.js:13`.
- 교훈: **OCR 와 enrich 는 타임아웃 예산이 다르다.** 둘 다 느린 122B 라 공용 60s 는 enrich 에 치명적.

**Phase 3 벤치 진행 중**(`acc_tmp/paddle_bench.mjs`): OCR_BACKEND qwen vs paddle, enrich off 로 격리.
→ 결과는 아래 [벤치 결과] 에 추가.

## 2026-06-23 — Paddle 분리 서버 통합 (Phase 0/1) · commit 4ae92f9

신규 OCR 전용 서버 B 도입. **외부 AI 권고("OCR 서버 + LLM 서버 분리")를 실측으로 검증하며 통합.**

- **실측 발견(중요):**
  - `:8118` raw chat `"OCR:"` → 보육 표 페이지 42s, 8192tok 잘림, **표 평문화**(hasTable=false). → 표엔 부적합.
  - `:8500/api/v1/parse` → **HTML `<table>` colspan/rowspan 복원**, 단일 PNG 5s/page, 4p PDF 25.8s. → 표 OK.
  - 즉 "OCR 서버"가 둘(raw vs doc-parser). **표는 /parse 만.**
- **아키텍처 결정(삼각구도):** kordoc(숫자 ground-truth) + Paddle /parse(구조) + Qwen(차트해설). 122B 는 enrich 전용으로 강등 → decode 병목 해소.
- **구현:** `server/paddle.js`(직렬 큐 + /parse 클라이언트), `paddle-parse` provider(document-parser), `OCR_BACKEND=paddle` 시 reflow 페이지를 /parse(이미지)로 결선(`vllm.js paddleReflowPage`), **숫자 게이트**(kordoc 대조 통과분만 채택).
- **코드리뷰(20 에이전트) 확정 2건 반영:**
  - ① NOSPACE 페이지가 anchor map 에서 빠져 Paddle 게이트 ground-truth 까지 없어짐 → **게이트 map 분리**(`kordocGateByPage`, NOSPACE 포함). 가장 검증 필요한 결함 페이지에서 무검증 채택 방지.
  - ② Paddle 에 Qwen 튜닝 렌더 전송(품질변수) → `PADDLE_RENDER_FACTOR` 노브.
- **검증:** 단위 9 + 전체 그린(회귀 0, 기본 qwen). e2e 인구동향 reflow 6/6, HTML표, 게이트 통과.
- **서버팀 협의:** R1(clean_html: border/style 제거·셀\n→<br>, 파이프표 금지) / R2(drop_images) / R3(dpi) 서버측 반영 완료. **파이프표는 절대 불가**(우리 hasBrokenTable 이 결함 판정).
- **함정:** /parse 직렬 → 클라이언트 직렬 큐 필수. bbox 는 보낸 이미지 픽셀좌표(정규화 x/width). Paddle VLM 이라 구조 OK 여도 셀 숫자 틀릴 수 있음 → 숫자 게이트 필수.
- **미해결:** Phase 3 벤치(셀 숫자 정확도 — default 전환 전 필수), Phase 2 force_ocr 전체 /parse.

## 2026-06-22 — vLLM 동시성/렌더 하향 (과부하 abort 완화) · commit 096d988

`호반써밋 13p` 변환이 느리고 페이지 떼로 `aborted`. 원인 = **과부하 타임아웃**: 단일 느린 122B 에 OCR
동시성 8 + 페이지당 비용 증가(anchor/repair pull)로 서로 decode 예산 다투다 다 같이 60s/240s timeout.
- 수정(.env 런타임 + .env.example): `VLLM_(OCR_)CONCURRENCY 8→3`, `OCR_RENDER_SCALE 3→2`, `TABLE_RETRY 3→2`, `OCR_TIMEOUT_MS 240000→600000`. (코드 기본값은 이미 안전 — 문제는 .env 오버라이드였음.)
- 교훈: **느린 단일 122B 는 동시성↓ 가 처리량↑.** 많이 던지면 다 timeout 나 0개 완료. ← Paddle 오프로드의 직접 동기.

## 2026-06-21~22 — anchor + numeric-repair + page-info + chart-enrich · commit d4d3636

kordoc 텍스트레이어(숫자 정확)를 **사후 검증에만 쓰고 생성 입력엔 안 넣던** 구조를 개선. 확정 D1~D8 기반.
- **P0 anchor**(`VLLM_OCR_ANCHOR`): reflow OCR 에 kordoc 텍스트를 user 보조로 주입(이미지 우선·숫자보조). 펼침면·NOSPACE 제외(D2). prefix-cache 위해 system 불변, anchor 는 user.
- **P0.5 numeric repair**(`VLLM_OCR_NUMERIC_REPAIR`): 전사 후 kordoc 숫자 대조, 불일치 임계↑면 보정 재호출(accept=missing↓ AND extra 비폭증, 임계2/MAX1 — decode 병목 고려).
- **P1 페이지 N/M**(`VLLM_OCR_PAGE_INFO`): `vllmOcrPageStrict` 옵션객체화(P0/P1 시그니처 충돌 해소).
- **P1.5 차트 enrich**: kordoc 경로 차트 페이지도 `collectChartVisualPages` 로 렌더해 enrich(`anchorIndexForPage` 텍스트 폴백).
- **P2**: reflowInfo metadata 반환 버그 수정, force_ocr 검증에 invisible-strip.
- 보류: rotation(D5 — mupdf API 미확인+샘플0), pageRoutes, config 흡수(D8).
- 회귀 안전망: 모든 신규 env=0 → legacy byte-identical. `tests/anchor.test.mjs`(31).
- 교훈: front-matter(olmOCR식)는 이 구조에 부적합 — 라우팅은 OCR 전 결정론적(detect.js), 모델 자기보고는 타이밍 안 맞음. "구조는 problemTotal 로 판단 금지" 원칙과 정렬.

---

## 벤치 결과 (채워짐: 진행 중)

_(paddle_bench.mjs 완료 후 추가)_

---

## 다음 할 일 (백로그)

- [ ] Phase 3 벤치 결과로 OCR_BACKEND default 전환 판단(통과 시 paddle).
- [ ] Phase 2: force_ocr 경로 `/parse(전체 PDF)` 결선.
- [ ] Paddle 셀 `\n`/style 잔여 정규화(서버 clean_html 로 대부분 해소 — 잔여만 postprocess).
- [ ] rotation: 회전 샘플 확보되면 재개.
- [ ] /parse 직렬 처리량 병목 시 서버 replica 스케일 요청(목표 동시문서수 측정 후).
