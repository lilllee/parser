# PaddleOCR-VL 분리 서버 통합 — 작업 계획서 + 첨언 (v2, doc-parser API 반영)

> 작성일: 2026-06-23 (v2 — 수정 가이드 `:8500` doc-parser API 반영)
> 대상: OCR 전용 Spark(서버 B)를 기존 LLM 서버 A(Qwen3.5-122B @ `192.168.0.50:8000`)와 분리
> 근거: 코드 실측 + **서버 B 라이브 probe 2종(raw chat + /parse)** + 공식 가이드(수정본)

---

## 0. 한 줄 결론 (v2)

**서버 B에 doc-parser HTTP API(`:8500/api/v1/parse`)가 배포되면서, "표 구조까지 빠르게"가 가능해졌다.**
이건 v1의 핵심 우려("raw chat은 표를 평문화")를 **정면 해결**한다 — 실측으로 확인.

- **`/api/v1/parse`** = 레이아웃 + **HTML `<table>`(colspan/rowspan) 복원** + 블록별 `bbox`. **실측: 보육 4p 25.8s(~6.5s/page), 4p 전부 표 복원.** ↔ 122B vision은 페이지당 ~40–60s + 과부하 abort.
- **`/api/v1/ocr`** = raw 라인 OCR(고동시성). 평문/이미지 빠른 전사용. **표는 평문화(실측: 보육 p2 42s/잘림/표소실).**

→ **개정 권고:** Paddle을 **PDF OCR/구조화의 1차 엔진**으로 승격하되 — kordoc(native 숫자 정확)을 **숫자 ground-truth spine**으로 유지하고, 기존 **numeric-repair 교차검증(P0.5)**으로 Paddle 표를 검증한다. **122B는 enrich(차트 해설)·판단 전용**으로 강등 → 지난 턴 decode 병목/abort의 구조적 해결.

⚠ **운영 제약(중요):** `/api/v1/parse`는 **사실상 직렬(concurrency=1, `_predict_lock` — 레이아웃 CPU 추론 비스레드세이프)**. PDF/페이지를 **동시에 쏘지 말고 순차/큐잉**. (`/ocr`만 고동시성)

---

## 1. 사실 확인 (실측 + 수정 가이드)

### 1.1 서버 B 두 계층
| 계층 | 주소 | 성격 | 동시성 |
|---|---|---|---|
| vLLM 원본 | `:8118/v1/chat/completions` | OpenAI 호환 raw VLM | ~35x 배치 |
| **doc-parser API** | **`:8500/api/v1/parse`** | 레이아웃+HTML표+bbox (PDF/이미지) | **직렬(1)** |
| | `:8500/api/v1/ocr` | raw 라인 OCR (이미지 1장) | 고동시성 |
| | `:8500/api/health`, `/docs` | 점검 | — |

- 인증 없음. 업로드 상한 **50MB**(초과 413). 에러는 HTTP 상태(502 vLLM, 500 파이프라인, 413 용량).
- `/parse` 응답: `{ page_count, elapsed_ms, pages:[{ index, width, height, markdown(HTML표), blocks:[{label, content, bbox:[x1,y1,x2,y2]}] }] }`. label 예: `paragraph_title/text/table/figure/chart/number/doc_title/vision_footnote`.

### 1.2 라이브 probe (동일 보육 병합표)
| 경로 | 결과 |
|---|---|
| `:8118` raw `"OCR:"` (p2) | 42s · 8192tok **finish=length(잘림)** · `hasTable=false` · **표 평문화** ❌ |
| **`:8500/api/v1/parse`** (4p PDF) | 25.8s · page_count 4 · **4p 전부 `<table>` colspan/rowspan 복원** · blocks+bbox ✅ |
| **`:8500/api/v1/parse`** (단일 PNG, p2) | **5.0s · page_count 1 · HTML 표 복원** · bbox는 보낸 이미지 dims(1190×1682) 기준 → `x/width` 정규화 안전 ✅ (= Phase 1 per-page 결선 검증) |

`/parse` 출력 예(p index1): `<td colspan="3">구 분</td> … <td rowspan="8">어린이집</td><td rowspan="3">지원총액\n(①+②+③)</td> …` — 실제 병합 구조 복원.

> 주의(미검증): **셀 값 정확도**(병합 위치·숫자)는 구조가 맞아 보여도 ground-truth 대비 벤치 필요. 셀 안 `\n` 리터럴 존재 → postprocess 처리 필요.

---

## 2. 현재 코드에서의 통합 지점

| 구조 | 내용 | 파일 |
|---|---|---|
| provider 2종 | **completer**(per-page `aiComplete`) vs **document-parser**(`kind:"document-parser"`, 파일 업로드, kordoc 우회) | [providers.js](server/providers.js) |
| 단일 provider/요청 | `resolveAiConfig`→`withAiConfig`(ALS). OCR·enrich 동일 provider | [ai.js](server/ai.js) |
| reflow 경로 | 깨진 페이지만 `ocrSelectedPdfPages`(`mapWithLimit` 병렬) → 블록 교체 | [convert.js](server/convert.js), [vllm.js](server/vllm.js) |
| MinerU 선례 | `documentParserConvert`(파일→md, kordoc 우회) | [convert.js:43](server/convert.js#L43) |
| 숫자 교차검증 | `comparePageNumbers`(kordoc vs OCR) + `numericRepairPage`(P0.5) | [postprocess.js](server/postprocess.js), [vllm.js](server/vllm.js) |

**핵심 매핑:**
- `/parse`는 **이미지도 받는다** → **렌더한 깨진 페이지 PNG를 /parse에 보내면 기존 per-page reflow 모델에 그대로 끼워진다**(단 동시성 1로 직렬).
- `/parse` 전체-PDF 호출은 **force_ocr/스캔 경로**(한 번에 전 페이지 구조화)에 매핑.
- `/ocr`(raw)는 평문/이미지 페이지 고속 전사.

---

## 3. 권장 아키텍처 (v2)

```
[입력 PDF] → kordoc parse (native 텍스트·숫자 spine, 무료)
   │
   ├─ 깨진/스캔/표 페이지 감지 (기존 detectMangledPages 등)
   │     └─ 해당 페이지 PNG → POST /api/v1/parse (직렬)  → HTML 표 + bbox
   │           └─ numeric cross-check (kordoc 숫자 ground-truth, 기존 P0.5)
   │                 └─ 통과: Paddle 결과 채택 / 실패: kordoc 또는 Qwen 폴백
   │
   ├─ 평문/이미지 페이지 → POST /api/v1/ocr (고동시성, 빠름)   [선택]
   │
   └─ 차트/그림 해설 enrich → 서버 A(Qwen)  ← 122B는 여기만 (저빈도)
```

**원칙:**
1. **kordoc-first 유지** — native 텍스트·숫자는 여전히 최고 정확. Paddle은 "구조가 깨진 페이지"를 구조화하는 역할.
2. **표/복잡 페이지 → `/parse`** (HTML 표). raw `/ocr`는 표에 쓰지 않는다(실측 후퇴).
3. **숫자 교차검증 = Paddle 표 채택의 유일한 게이트(필수, 선택 아님).** 서버팀 확인: PaddleOCR-VL은 VLM이라 구조(colspan/rowspan)는 완벽해 보여도 **셀 숫자·병합 위치가 틀릴 수 있다.** 따라서 `comparePageNumbers`(kordoc 숫자 ground-truth) **통과 시에만 Paddle 표 채택**, 실패 시 kordoc/Qwen 폴백. 벤치(Phase 3, 보육 24열·인구동향 933숫자) 전엔 무조건 신뢰 금지. anchor/numeric-repair 자산이 그대로 산다.
4. **122B = enrich 전용** — 전사를 Paddle로 오프로드 → 병목 해소. Qwen-vision OCR 경로는 **폴백**으로 보존.
5. **직렬 준수** — `/parse` 호출은 동시성 1(전용 큐). `/ocr`만 고동시성.

---

## 4. 작업 계획 (Phase별)

### Phase 0 — `/parse` document-parser provider + `/ocr` 백엔드 추가 (S~M)
- [providers.js](server/providers.js):
  - `paddleParse` — `kind:"document-parser"`, `parseDocument`가 파일 multipart → `/api/v1/parse` → `{markdown, pages, blocks}`. (MinerU 패턴 재사용)
  - (선택) `paddleOcr` completer — `/api/v1/ocr` (raw, 평문용) 또는 `:8118` chat
  - `ping` = `GET /api/health`
- env: `PADDLE_PARSE_URL`(`http://192.168.0.250:8500`), `PADDLE_OCR_URL`, `PADDLE_PARSE_CONCURRENCY=1`
- 검증: health + 보육/인구동향 /parse 1회

### Phase 1 — per-page reflow에 `/parse(이미지)` 결선 (M, 핵심)
- 렌더한 깨진 페이지 PNG → `/parse` → page.markdown(HTML 표)로 블록 교체
- **동시성 1 게이트**(전용 세마포어/큐 — `_predict_lock` 충돌·타임아웃 회피)
- 기존 검증 재사용: `hasBrokenTable`/`comparePageNumbers`/numeric-repair로 Paddle 결과 채택·폴백
- 기본 off 토글(`OCR_BACKEND=paddle|qwen`) → 회귀 0

### Phase 2 — force_ocr/스캔 경로를 `/parse(전체 PDF)`로 (M)
- force_ocr 시 전 페이지 `/parse` 한 번 → 구조화 markdown. 50MB 초과/대용량은 페이지 분할 업로드
- 숫자 교차검증(기존 force_ocr verify) 그대로

### Phase 3 — 벤치마크 + 라우팅 확정 (M)
- [acc_tmp/measure.mjs](acc_tmp/measure.mjs)에 **백엔드 축**(paddle-parse / qwen-vision / kordoc) — 3지표(problemTotal/숫자missing/완전성) + 속도
- 특히 **보육 24열 그리드 / 인구동향 933숫자**에서 Paddle HTML 표 셀 정확도 검증
- 결과로 페이지타입별 라우팅(표→/parse, 평문→/ocr, 숫자핵심→kordoc 우선) 확정

### Phase 4 — 후처리/포맷 정합 (S)
- `/parse` 산출 정합: 셀 내 `\n` 리터럴, `<table border=1 style=…>` 인라인 스타일 정규화 → 기존 `postprocessMarkdown`/표 정규화에 흡수

---

## 5. 리스크 / 주의

| 리스크 | 완화 |
|---|---|
| **`/parse` 직렬(concurrency=1)** | **하드 천장 아님** — 직렬 원인은 레이아웃 모델(CPU 비스레드세이프)이고 VLM(:8118)은 35x 배치. 처리량 필요 시 **:8500 API를 N replica 복제**(같은 :8118 공유, 각 replica는 레이아웃 모델 RAM만 추가)로 선형 확장. **당장은 전용 큐(직렬)**, 배치 처리량 병목 시 목표 동시문서수 전달 → 서버측 스케일 |
| 셀 값/병합 정확도 미검증 | Phase 3 벤치(특히 숫자). numeric cross-check로 1차 방어 |
| 대용량 PDF 50MB 한도(413) | 페이지 분할 업로드 또는 서버 `MAX_UPLOAD_MB`↑ |
| 셀 `\n`·인라인 style 오염 | Phase 4 postprocess |
| 서버 B 장애 | HTTP 상태 감지 → Qwen/kordoc 폴백(provider fallback) |
| kordoc 강점 상실 우려 | kordoc spine 유지 — Paddle은 '깨진 페이지'만 대체, 숫자는 kordoc 기준 |

---

## 6. 결정 필요 (사용자)

| # | 질문 | 권장 |
|---|---|---|
| Q1 | 1차 통합 형태: **per-page reflow에 /parse 결선(안전망 유지)** vs **document-parser로 전체 우회(MinerU식)** | per-page reflow(안전망 유지) |
| Q2 | `/parse` 직렬 — 단일 사용자/배치 위주인가? (처리량 설계 영향) | 확인 필요 |
| Q3 | 표 숫자 신뢰: Paddle 표 채택 기준을 kordoc numeric-check **통과 시에만**? | 예(보수적) |
| Q4 | `/ocr`(평문 고속) 경로도 이번에? vs `/parse`만 | /parse 먼저, /ocr는 평문 많으면 |

---

## 7. 첨언 — 외부 AI 권고 재평가 (v2)

- **v1 대비 입장 상향.** v1에선 "서버 B는 라인 OCR이라 표에서 후퇴"였으나, **`:8500/api/v1/parse` 배포로 그 한계가 해소**됐다. 이제 외부 AI의 "OCR 전용 서버 분리 + bbox/구조" 그림이 **실제로 성립**한다 — `/parse`가 HTML 표 + bbox를 빠르게 준다.
- **여전히 유효한 경고:** ① raw `/ocr`(=`:8118` chat)는 표 평문화 → 표에 쓰지 말 것. ② `/parse` **직렬** 제약은 외부 AI 권고("OCR 서버는 고속 병렬")와 어긋남 — 레이아웃 추론이 락이라 병렬 처리량은 제한적. 처리량 설계 시 반드시 반영.
- **이 프로젝트만의 정답:** 외부 AI는 "OCR→LLM 일방 파이프라인"을 그렸지만, 우리는 **kordoc(숫자 ground-truth) + Paddle/parse(구조) + Qwen(해설)** 의 **삼각 구도 + 숫자 교차검증**이 맞다. Paddle 표가 그럴듯해도 숫자는 kordoc로 검증해 채택 — 방금 만든 numeric-repair/anchor 자산이 그대로 산다.
- **즉시 효과:** 전사·구조화를 6.5s/page(단일 5s) Paddle로 옮기면 122B는 enrich만 → 지난 턴 동시성 8 abort 떼죽음이 구조적으로 사라진다. **속도와 표 품질을 동시에** 얻는 드문 케이스.

---

## 8. 서버팀 회신(v2 승인) 반영 + 우리 요청사항

서버팀이 v2를 승인하며 4건 정정/보강 → 계획 확정:

1. **`/parse` 직렬은 하드 천장 아님** — 레이아웃 모델(CPU) 직렬화일 뿐, VLM(:8118)은 35x 배치. **:8500 API replica 복제로 선형 확장 가능**. 당장은 전용 큐(직렬) 유지, 배치 처리량 병목 시 목표 동시문서수 전달. (§5 반영)
2. **셀 값 정확도 벤치 = 채택의 유일한 게이트(필수)** — kordoc numeric cross-check 통과 시에만 Paddle 표 채택. (§3 원칙 3 격상)
3. **bbox 좌표계** — bbox·width/height는 **렌더 이미지 픽셀 좌표**(PDF는 200 DPI 래스터; 이미지 업로드는 그 이미지 dims, 실측 확인). 정규화는 `x/width`. DPI는 서버 `PDF_DPI`로 조정 가능(정밀↑/속도↓).
4. **차트/후처리** — `/parse` 기본 `inline_images=false`라 markdown의 `<img src="imgs/..">`는 빈 참조 → **차트는 우리 Qwen enrich로 보내므로 무시**. 셀 `\n`·`<table border=1 style=…>` 정규화(Phase 4)는 서버측 옵션으로 대체 가능(서버 제안).

### 우리 → 서버팀 요청사항
| # | 요청 | 우선 | 비고 |
|---|---|---|---|
| R1 | **표 출력을 style-stripped 깨끗한 HTML로**(`colspan`/`rowspan` 유지, `border`/inline `style` 제거, 셀 내 줄바꿈은 `<br>`로 통일). **markdown 파이프표는 불가** — 우리 파이프라인은 병합셀 HTML 표준이고 파이프표는 `hasBrokenTable`이 결함으로 판정 | 높음 | opt-in 파라미터면 우리가 제어 |
| R2 | 빈 `<img>` 참조를 **출력에서 생략하는 옵션**(`inline_images=false`일 때) | 중 | 차트는 Qwen enrich 담당 → 빈 참조 불필요 |
| R3 | **per-request DPI 오버라이드**(dense 소형 한글 표용) | 낮음 | 기본 200 OK, 어려운 페이지만 ↑ |
| R4 | (있으면) **블록/셀 confidence** 반환 | 낮음 | numeric gate 보조용, 필수 아님 |
| R5 | replica 스케일 | 보류 | 단일 문서 인터랙티브 + /review 소규모 배치 → 현재 직렬 충분. 배치 병목 측정되면 동시문서수 전달 |

> 업로드 50MB·인증 없음은 현 상태로 충분(우리 문서 ≪ 50MB).

확정 방향(서버팀에 회신): **per-page reflow에 `/parse(이미지)` 결선 + 직렬 큐 준수 + 숫자 교차검증 게이트 필수**. R1(깨끗한 HTML 표) 적용해 주면 Phase 4 부담↓.

---

## 9. 구현 현황 (Phase 0/1 완료 · 2026-06-23)

서버팀 R1~R3 반영 완료 통보 후 착수. **Phase 0 + Phase 1 구현·검증 완료.**

| 항목 | 상태 | 내용 |
|---|---|---|
| Phase 0 | ✅ | `server/paddle.js`(신규 — `/api/v1/parse` 클라이언트 + **직렬 큐 `serialize`** + `paddleParsePageImage`/`paddleParseFile`/`paddleHealth`). `paddle-parse` document-parser provider(providers.js). `clean_html`/`drop_images`/`dpi` 폼 파라미터 사용 |
| Phase 1 | ✅ | `OCR_BACKEND=paddle` 시 reflow 페이지를 `/parse(이미지)`로 결선(`vllm.js paddleReflowPage` + `wholePage` 분기). **숫자 게이트**: kordoc 숫자와 대조해 불일치 임계↑면 폐기→kordoc 유지 |
| 회귀 안전 | ✅ | 기본 `OCR_BACKEND=qwen` + `PADDLE_PARSE_URL` 미설정 → paddle 미동작(기존과 동일). 전체 테스트 그린 |
| 코드리뷰 | ✅ | 적대적 리뷰(20 에이전트) 확정 2건 반영: **①게이트 ground-truth map 분리**(NOSPACE 페이지도 Paddle 게이트 적용 — anchor map과 별도) ②`PADDLE_RENDER_FACTOR` 노브(Qwen 튜닝 렌더↔Paddle 분리) |
| 테스트 | ✅ | `tests/paddle.test.mjs`(9 — endpoint 정규화/직렬 큐 순서/실패격리) + npm test 등록 |
| **라이브 e2e** | ✅ | 인구동향 `OCR_BACKEND=paddle`: **reflow 6/6, 41s, `hasHtmlTable=true`/`pipeTables=false`, 숫자게이트 6p 통과, 결정적 동일 출력** |

**시그니처/신규:**
- `paddle.js`: `paddleParsePageImage(png,opts)` · `paddleParseFile(buf,filename,mime,opts)` · `paddleHealth(url)` · `paddleEndpoint(base,path)` · `serialize(task)` · `PADDLE_PARSE_ENABLED()`
- `ocrSelectedPdfPages(..., { kordocByPage(anchor), kordocGateByPage(Paddle 게이트), ... })`
- env: `OCR_BACKEND`, `PADDLE_PARSE_URL`, `PADDLE_PARSE_TIMEOUT_MS`, `PADDLE_CLEAN_HTML`, `PADDLE_DROP_IMAGES`, `PADDLE_PARSE_DPI`, `PADDLE_RENDER_FACTOR`

**미해결/후속:**
- ⚠ e2e에서 **enrich(Qwen 차트해설) 0/5 fail** 관측 — 리뷰상 Paddle 코드 무관(서버 A/122B 호출 실패 추정, 지난 decode 병목과 동류). **별도 진단 필요**(이번 범위 밖).
- **Phase 3 벤치(필수 게이트)**: `OCR_BACKEND=paddle` vs qwen을 measure.mjs 3지표+속도로 — 특히 보육 24열·인구동향 933숫자 **셀 단위 정확도**. 통과 전 default 유지(qwen).
- force_ocr 경로 `/parse(전체 PDF)` 결선(Phase 2), 셀 `\n`/style 잔여 정규화(서버 R1 `clean_html`로 대부분 해소 — 잔여만).
