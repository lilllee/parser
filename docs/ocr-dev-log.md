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

## 2026-06-23 — 독립 측정(Excel 리포트)로 "PDF=Paddle 우세" 확정

사용자 제공 측정 리포트 2종(`parsing_comparison_report.xlsx`, `population_parsing_comparison_report.xlsx`)
— 페이지별 Token/Numeric F1 + 표 구조 점수 하베스트(내 measure.mjs 보다 정밀). **결론: PDF 파싱은 Paddle 우세 확정.**

| 문서 | VLLM 종합 | Paddle 종합 | 핵심 |
|---|---:|---:|---|
| source.pdf(3p, 표중심) | 71.74 | **94.07** | 표 구조 압승(p.20 운영시간 45→90, p.21 비교표 25→95), 표검출 3→5 |
| 인구동향 5-10 | 75.2 | **95.8** | coverage 0.83→1.0, bad_pages 3→1, numericF1 0.74→0.95 |
| 인구동향 45-50 | 62.5 | **74.4** | coverage 0.67→1.0(VLLM 페이지 2개 통째 누락) |

**확정/뉘앙스:**
- **Paddle 가 거의 전 항목 우세** — 특히 표 구조/병합(VLLM 약점)과 **page coverage**(VLLM 은 페이지를 통째 누락: 5-10 p2, 45-50 p2·p3 present=False). → `OCR_BACKEND=paddle` 결정(이미 적용) 독립 측정으로 뒷받침됨.
- **숫자 게이트의 가치 재확인(필수)**: Paddle 도 완벽 아님 — 인구동향 45-50 **p.4 token_f1 0.12**(1/4분기 헤더를 표로 오인식), 45-50 p.1 박스글리프(ㅁㅁㅁ). 우리 numeric 게이트(kordoc 대조 불일치→폐기·kordoc 폴백)가 정확히 이런 페이지를 잡는다. **Paddle 무지성 신뢰 금물**이라는 서버팀 경고와 정합.
- **Number precision 주의(측정 아티팩트)**: source.pdf 에서 Paddle Number precision 79.35 vs VLLM 100, Number F1 도 Paddle 87.95 < VLLM 91.18. 리포트 주석: **Paddle HTML 표 속성(colspan/rowspan 등) 숫자가 number 추출에 누출**돼 false positive. 즉 데이터 손상이 아니라 지표 잡음(우리 comparePageNumbers 는 유의숫자 3자리+ 필터라 colspan="2" 류는 대부분 제외 — 영향 작음). 그래도 number 추출 시 HTML 속성 strip 권장.
- VLLM 이 이긴 유일 항목: source.pdf "OCR 노타/페이지 정리"(90 vs 80) — Paddle 이 그림 캡션·VOICEYE·머리글 노타를 더 끌어옴(잡음). 사소.

→ **종합: 사용자 가설("PDF는 Paddle 이 제일 낫다") 맞음.** 우리 방향(reflow 기본 paddle + 숫자게이트 + kordoc 폴백)이 정답. 활성화는 **명시적 `OCR_BACKEND=paddle` env**(이미 `.env` 적용)로 유지.
- ⚠ **코드 기본값(config)을 paddle 로 바꾸지 말 것 (현 상태)**: `convert.js` 의 게이트 map 빌드가 `process.env.OCR_BACKEND === "paddle"` 를 직접 보는데, config 기본만 paddle 로 바꾸면 env 미설정 시 cfg.features.ocrBackend=paddle 인데 게이트 map 은 안 만들어져 **무게이트 Paddle** 이 된다. 코드 기본 전환하려면 먼저 convert.js 가 cfg.features.ocrBackend 를 읽도록 단일화(backlog).

## 2026-06-23 — Paddle API 업데이트 검토(`/parse_rich` 신규) + 판단

서버팀 API 문서 갱신. 라이브 확인(`/openapi.json`): `/api/v1/parse`, **`/api/v1/parse_rich`**,
`/api/v1/parse_rich_stream`, `/api/v1/ocr` 모두 배포됨.

**신규 `/api/v1/parse_rich`** = 서버측 2-pass: Paddle(1차 영역 텍스트) → **Qwen-VL(2차, 페이지이미지+1차텍스트)**
로 장식제목 교정·아이콘/일러스트 설명·마크다운 재구성. 포스터/인포그래픽용("LlamaParse급"). 느림(~수십초/page,
122B). `markdown_rich`+`image_b64` 반환. server env `QWEN_URL`(:8000/v1)·`QWEN_MODEL`(qwen3.5-122b) — 서버팀도 우리와 같은 모델 ID 수정 반영됨. SSE: `/parse_rich_stream`.

**`/api/v1/ocr` 컨텍스트 한도 명확화**: 서버 컨텍스트 **8192 tok**(`--max-num-seqs 256`) → `(이미지토큰+max_tokens) ≤ 8192`, 초과 시 **HTTP 400**. dense 페이지는 `/parse`(영역 크롭이라 무관) 권장.

**판단(중요):**
- **우리 통합 무영향** — `/parse`(clean_html/drop_images/dpi) 계약 그대로. Phase 0/1 코드 변경 불필요.
- **`/parse_rich` 는 문서(보고서/표) 경로에 쓰지 말 것.** 이유: ① 122B 를 페이지마다 다시 태워 **방금 벗어난 decode 병목 재유입**, ② kordoc(숫자 ground-truth) 우회 + Qwen 이 전 페이지를 재작성 → **숫자 변조 위험 + 우리 numeric 게이트 무력화.** 우리는 이미 "Paddle 구조 + Qwen enrich"를 **client 측에서 선택적·숫자안전하게** 한다(차트 페이지만, kordoc 게이트). 문서엔 우리 오케스트레이션이 우월.
- **`/parse_rich` 의 진짜 자리 = 이미지 파일 입력(포스터/인포그래픽/스크린샷).** 이미지 파일은 애초에 kordoc 이 없어(게이트 손실 없음) Paddle 단독이 약한 장식폰트/아이콘을 Qwen 보강이 메운다. 현재 이미지 파일은 `ocrImageBuffer`(서버 A Qwen-vision, 느림)로 감 → **이미지 경로를 Paddle `/parse`(일반) 또는 `/parse_rich`(포스터)로 라우팅하는 것이 다음 후속 후보.**
- **8192 한도**: 우리 통합 경로는 `/parse`(크롭)만 써서 무관. 단 `/ocr`·`:8118` raw 를 직접 쓰면 `image+max_tokens ≤ 8192` 준수(서버 A 122B OCR 은 :8000·32768 라 별개).

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

## 2026-06-23 — ⚠ 서버 A model id 변경 발견(404) + Phase 3 벤치 결과

**enrich 0/5 의 진짜 원인은 타임아웃이 아니라 404였다.** 벤치 돌리니 모든 Qwen 호출이
`model Intel/Qwen3.5-122B-A10B-int4-AutoRound does not exist (404)`. 서버 A 재배포로 `/v1/models`
실제 id 가 **`qwen3.5-122b`** 로 바뀜. → `.env`/providers.js/.env.example VLLM_MODEL 갱신(commit e7788f3).
(enrich 타임아웃 분리 d0bc880 도 유효 — 모델 살아난 뒤 122B vision 이 60s 넘으므로.)
- **교훈: Qwen 호출 실패 시 1순위로 서버 `/v1/models` 실제 id 와 VLLM_MODEL 일치 점검.**
- **함정: `ai.js loadLocalEnv()` 의 PRIORITY 정규식(`VLLM_|AI_|OPENAI_|...`)이 .env 값으로 inline env 를 덮어쓴다.** 그래서 `VLLM_PAGE_VISUAL=0 node ...` 인라인이 .env 의 `VLLM_PAGE_VISUAL=1` 에 무시됨(벤치 enrich 격리 실패 — 대신 enrich-on 으로 측정됨). 런타임 오버라이드하려면 .env 를 고치거나 PRIORITY 밖 키를 쓸 것.

**Phase 3 벤치(모델ID 수정 후, enrich on, reflow 발생 2문서):**

| 문서 | 백엔드 | 시간 | md자 | problemTotal | enrich | kordoc숫자 missing | extra |
|---|---|---:|---:|---:|---|---:|---:|
| 인구동향(933숫자) | qwen | **331s** | 19848 | 0 | 5/5 | **0** | 83 |
| 인구동향 | **paddle** | **54s** | 18638 | 0 | 5/5 | **0** | 37 |
| 입양실무(비교표) | qwen | 193s | 15090 | 2 | (skip) | 1 | 2 |
| 입양실무 | **paddle** | **54s** | 12746 | 2 | (skip) | 1 | 2 |

**판정:**
- **Paddle OCR 3.6~6배 빠름** (인구동향 331→54s, 입양 193→54s) — 122B decode 병목 해소 확인.
- **품질 동등**: problemTotal 동일(0/0, 2/2), **kordoc 숫자 missing 동일(0, 1)** → 숫자 손실 없음. 숫자 게이트가 작동(missing 0 = Paddle 표가 kordoc 숫자 보존).
- enrich **5/5 정상화**(이전 0/5 = 404). 모델ID+타임아웃 수정 합작.
- 미해명(낮음): 인구동향 extra 가 qwen 83 vs paddle 37 — qwen 이 kordoc 밖 숫자(차트 내부 등)를 더 전사했거나 환각. missing=0 이라 손실은 아님. 출력 직접 diff 로 후속 확인 권장.

**결정: reflow OCR 기본을 paddle 로 전환(.env `OCR_BACKEND=paddle`).** 근거 = 4~6배 속도 + 측정 품질 무회귀 + 숫자게이트 폴백(불일치 시 kordoc 유지)이라 하방 제한. 단 **표본 2문서**라 코드 기본값은 qwen 유지(되돌리기 1줄). 확대 코퍼스 + extra diff 후 코드 기본 전환 검토.

## 벤치 결과 (위 표 참조)

---

## 다음 할 일 (백로그)

- [x] ~~Phase 3 벤치 → OCR_BACKEND default 판단~~ → **paddle 채택, `.env OCR_BACKEND=paddle` 활성화**(코드 기본은 qwen 유지).
- [ ] **OCR_BACKEND 단일 소스화**: convert.js 가 게이트 map 빌드에서 `process.env.OCR_BACKEND` 를 직접 보는 것을 `cfg.features.ocrBackend` 로 통일 → 그 후에야 코드 기본값을 paddle 로 안전 전환 가능.
- [x] ~~extra 숫자 (qwen 83 vs paddle 37)~~ → 독립 측정으로 규명: Paddle HTML 표 속성(colspan 등) 숫자 누출 = 측정 아티팩트(데이터 손상 아님). number 추출 시 HTML strip 권장.
- [ ] Phase 2: force_ocr 경로 `/parse(전체 PDF)` 결선. **부분 가능**: 지금도 `provider=paddle_parse`(document-parser)로 파일 통째 /parse 호출 가능 — forceOcr 플래그 경로에 자동 연결은 미구현.
- [ ] **이미지 파일 경로(`ocrImageBuffer`) → Paddle 라우팅** (신규 후보, 효과 큼): 현재 이미지 파일은 서버 A Qwen-vision(느림). 일반 이미지→`/parse`, 포스터/인포그래픽→`/parse_rich`(서버측 2-pass). kordoc 없는 입력이라 numeric 게이트 손실 없음.
- [ ] Paddle 셀 `\n`/style 잔여 정규화(서버 clean_html 로 대부분 해소 — 잔여만 postprocess).
- [ ] rotation: 회전 샘플 확보되면 재개.
- [ ] /parse 직렬 처리량 병목 시 서버 replica 스케일 요청(목표 동시문서수 측정 후).
- [ ] (관측성) `VLLM_PAGE_VISUAL=0` 같은 VLLM_ 키 런타임 오버라이드가 loadLocalEnv PRIORITY 에 막힘 — 측정 격리 필요 시 .env 직접 편집 or PRIORITY 예외 검토.
