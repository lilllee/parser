# OCR 파이프라인 개선 작업 계획서 — anchor 기반 selective vision reflow

> 작성일: 2026-06-22
> 범위: `server/` OCR/문서파싱 파이프라인 (백엔드 우선)
> 근거: 두 차례 AI 교차분석 + 실제 코드 정밀조사(6 에이전트 병렬) + 적대적 검증
> 전략 한 줄 정의: **anchor 기반 selective vision reflow + 검증 retry + Markdown only**

---

## 0. 배경과 목표

### 0.1 무엇을 만드는가 (LlamaParse의 재정의)

```
LlamaParse처럼 한다
 = JSON/items/assets를 다 만든다           ❌ (후순위)
 = 최종 Markdown 품질을 위해 parser + VLM + 검증/재시도를
   페이지 단위로 조합한다                    ✅ (이번 목표)
```

최종 산출물은 **Markdown 하나**다. `items.json / metadata.json / assets` 같은 전체 플랫폼 출력은 우선순위 낮춤. 단, **차트/그림 해설은 Markdown 안에 반드시 들어가야 한다**(JSON chart item은 불필요).

### 0.2 핵심 진단 (두 분석의 수렴점)

현재 파이프라인은 이미 **Marker식 하이브리드**(kordoc 먼저 → 깨진 페이지만 vision reflow)를 레퍼런스보다 깊게 구현했다. 진짜 비어 있는 한 가지:

> **"틀릴 걸 알면서 입력엔 안 주고, 끝나고 야단치는 구조."**
> kordoc 텍스트레이어(숫자·철자 정확)를 손에 쥐고도 **사후 검증 경고(`NUMERIC_MISMATCH`)에만 쓰고, 생성 입력(anchor)으로는 안 넣는다.**

이것이 P0이며, 이번 계획의 중심이다.

### 0.3 채택하지 않는 것

- **olmOCR식 front-matter**(`has_table`/`rotation`/`confidence`를 모델이 자기보고): 이 구조엔 부적합.
  - 라우팅은 OCR **이전**에 결정론적으로 함(`detect.js`) → 모델 사후 자기보고는 타이밍이 안 맞음.
  - 표 깨짐 판정은 결정론적 `hasBrokenTable`이 더 신뢰됨. 메모리 원칙 "구조는 problemTotal로 판단 금지"와도 정렬.
  - front-matter는 최종 Markdown 오염 위험만 추가.
  - → 살릴 가치가 있는 건 `rotation` 뿐인데, 그것도 결정론적 픽셀 감지가 더 낫다(P2).
- 단, 내부 라우팅/결정 신호는 **버리지 말고 metadata 로그**로만 남긴다(P2-B). **최종 Markdown엔 절대 넣지 않는다.**

---

## 1. 우선순위 요약

| 우선 | 항목 | 효과 | 작업량 | 핵심 리스크 |
|---|---|---|---|---|
| **P0** | kordoc 텍스트를 OCR 입력 anchor로 주입 (reflow 우선) | 숫자 오독을 **발생 단계에서 차단** | M | anchor가 나쁜 텍스트레이어일 때 오염 / 베끼기 |
| **P0.5** | `NUMERIC_MISMATCH` 경고 → 조건부 재시도(accept/rollback) | 검증 루프를 닫음 | M | accept 기준 느슨하면 환각 유입 |
| **P1** | "페이지 N / 총 M" 주입 | 마지막/이어짐 판단 단서 | **S** | 거의 없음(baseline diff만) |
| **P1.5** | 선택 reflow 페이지도 chart enrich 대상 포함 | 차트 해설 누락 구멍 메움 | M | `## 페이지 N` 앵커 부재(함정) |
| **P2** | 회전 감지 + 결정 로그 + env 일원화 + 테스트/문서 | 인프라/관측성 | M | 회전 오보정(전 페이지 붕괴) |

> 다른 AI 권고 순서와 일치: `front-matter 버림 → items/json 후순위 → anchor → page N/M → numeric retry → reflow chart enrich → rotation(샘플 생기면)`.

---

## 2. 적대적 검증이 확정한 설계 결정 (필독)

개별 항목 구현 전에 **반드시** 아래 결정을 먼저 반영한다. 독립적으로 손대면 시그니처 충돌·중복 Map·병합 깨짐이 발생한다.

### 2.1 시그니처 충돌 → 통합 시그니처

`vllmOcrPageStrict`를 **P0(anchorText)와 P1(pageTotal)이 동시에** 건드린다. 현재 위치 인자가 이미 5개라 각자 추가하면 7개가 되어 7개 호출부 전부 `undefined` 자리채움이 필요하다. → **꼬리 인자를 옵션 객체로 전환하고 P0+P1을 한 번에 착지.**

```js
// server/vllm.js — 최종 통합 시그니처
async function vllmOcrPageStrict(
  pageImage, pageNumber, mimeType = "image/png",
  { samplingOverride = null, extraInstruction = "", anchorText = "", pageTotal = null } = {}
)
// 내부:
//   prompt = prompts.pdfOcrUser(pageNumber, pageTotal) + (extraInstruction ? `\n${extraInstruction}` : "")
//   text   = anchorText ? prompts.pdfOcrAnchor(truncateAnchor(anchorText)) : undefined

async function ocrPageAdaptive(renderer, pageNum, expectedTables = 0, anchorText = "", pageTotal = null)
async function ocrPageGlobalView(png, pageNum, anchorText = "", pageTotal = null)
async function ocrPageTiled(png, pageNum, pageTotal = null)   // ← 타일엔 anchor 미전달(영역 불일치)

// ocrSelectedPdfPages / ocrPdfBuffer: anchorByPage 와 kordocByPage 를 따로 만들지 말고 하나로 병합
export async function ocrSelectedPdfPages(arrayBuffer, pageNumbers,
  { onPage, spreadPages, expectedTables, kordocByPage, onWarning } = {})
export async function ocrPdfBuffer(arrayBuffer,
  { onProgress, onPage, collectVisuals = true, kordocByPage, onWarning } = {})
```

- **`kordocByPage: Map<page, string>` 하나**가 anchor(OCR 전, 펼침면 제외)와 numeric repair/verify(OCR 후) **둘 다**에 쓰인다. `anchorByPage`를 따로 만들지 말 것(데이터 동일 + drift 위험).

### 2.2 `pageTotal`은 체인으로 흘리지 말고 내부에서 읽는다

`ocrPdfBuffer`(`renderer.pageCount`, vllm.js:939)와 `ocrSelectedPdfPages`(자체 renderer, vllm.js:1078) **둘 다 문서 총 페이지 M을 이미 로컬 보유**한다. convert.js에서 넘길 필요 없음. 단 reflow의 M은 `want.length`(선택 페이지 수)가 아니라 **`renderer.pageCount`(문서 전체)** 여야 한다.

### 2.3 anchor/total/repair는 전부 user 메시지로 (prefix cache 불변)

- `pdfOcrSystem`은 **byte 동일 유지**(vllm.js:470 주석 — system=공통지시문 prefix cache).
- `ai.js:84-87`: `supportsSystem`(vllm/openai)만 system 별도 전송, 나머지는 prompt 앞에 병합. → anchor를 system에 넣으면 페이지마다 캐시 깨짐.
- **모든 가변값(pageNumber, pageTotal, anchorText, repair 지시)은 user 측.**

### 2.4 provider별 text 슬롯 동작 (테스트 시 주의)

`text` 파라미터는 전 provider에서 user 메시지에 도달하지만 형태가 다르다:
- **별도 `{type:text}` 블록**: vllm(`providers.js:36`), openai(75), codex(159)
- **`${prompt}\n\n${text}` 병합**: gemini(126), anthropic(188), bedrock(277), claude-cli(370), codex-cli(457)

→ 결론(anchor가 user에 도달)은 모든 provider에서 성립. 단 "3블록 순서" 단위테스트는 vllm/openai/codex 한정으로 작성.

### 2.5 CLI provider는 temperature만 전달됨

`ai.js:92` CLI `complete` 경로는 `{prompt,text,image,maxTokens,temperature,timeoutMs}`만 전달(topP/penalty 드롭). repair는 `temperature:0`만 쓰므로 문제없음. 단 향후 repair 샘플링을 temperature 외로 확장하면 claude-cli/codex-cli/bedrock에선 무효.

### 2.6 env 토글을 측정보다 먼저 착지

anchor·numeric-repair·page-N/M는 OCR 입출력을 바꿔 `acc_tmp/measure.mjs`의 결정성(temp 0) baseline을 이동시킨다. → **각 기능에 `=0`이면 legacy와 byte-identical로 되돌아가는 토글**을 먼저 머지하고 A/B 측정.

---

## 3. 항목별 상세 계획

### P0 — kordoc 텍스트를 OCR 입력 anchor로 주입

**목표.** vllm OCR이 이미지뿐 아니라 "참고용 텍스트레이어 anchor"를 user 메시지로 함께 받는다. 이미지가 유일한 시각 근거, anchor는 숫자/철자/읽기순서 보조.

**현재 상태(근거).**
- `vllm.js:471-484` `vllmOcrPageStrict`는 image+system+user만 보내고 `aiCall`의 `text` 슬롯을 비워둠. → 주입 지점은 이미 전 provider에 배선됨(§2.4).
- 페이지별 kordoc 텍스트는 이미 산출됨: reflow는 `convert.js:334-338` `blocksByPage` + `blocksToMarkdown`, force_ocr 검증은 `convert.js:159-165`.
- 스캔(`IMAGE_BASED_PDF`)은 `result.blocks=[]`(convert.js:260-270) → 텍스트레이어 없어 anchor 불가(무해).

**변경.**
1. `server/config/prompt.js` — 신규 헬퍼 `pdfOcrAnchor(anchorText)` (user용). 규칙 4종:
   - (1) 이미지가 유일 시각 근거, anchor는 숫자/철자/읽기순서 보조
   - (2) anchor에 있어도 이미지에 안 보이면 출력 금지(환각 금지)
   - (3) 충돌 시 이미지 우선, **숫자는 보수적으로 이미지 우선**
   - (4) anchor를 그대로 베끼지 말 것
   - injection 방어는 `commonSystemPrompt`(prompt.js:4-9)가 이미 커버.
2. `server/vllm.js` — `vllmOcrPageStrict` 옵션 객체화(§2.1), `text: anchorText ? prompts.pdfOcrAnchor(truncateAnchor(anchorText)) : undefined`.
3. `server/vllm.js` — `truncateAnchor()` + cap 상수 신설. **tiered 압축**:
   - 1순위 native text 통짜(cap 내), 2순위 표 구분행/`<table>` 주변, 3순위 숫자/헤더/고유명사 라인 우선 보존
   - 초과 시 머리+꼬리 절단 + `…(중략)…`
   - 베끼기 리스크 줄이려 cap 보수적(`VLLM_OCR_ANCHOR_MAX_CHARS`, 기본 2000).
4. `server/vllm.js` — `ocrPageAdaptive`(4번째 `anchorText`)가 정상(770)·재시도(800)·`ocrPageGlobalView`(780/823)로 전파. **타일(`ocrPageTiled`)·펼침면 반쪽(1106/1112)엔 미전달**(영역 불일치).
5. `server/convert.js` reflow(415-420) — `targets` 산출(396) 직후 `kordocByPage` 빌드(펼침면 제외, 길이≥20자), 옵션으로 전달:
   ```js
   const kordocByPage = new Map();
   if (cfg.features.ocrAnchor) for (const pn of targets) {
     if (spreadForOcr.has(pn)) continue;
     const a = blocksToMarkdown(blocksByPage.get(pn) || []);
     if (a && a.trim().length >= 20) kordocByPage.set(pn, a);
   }
   ```

**위험.**
- **나쁜 텍스트레이어 오염**: reflow 대상은 정의상 kordoc 결함(`convert.js:389` deficient) 페이지라 anchor 품질이 가장 낮을 위험. 완화: anchor를 "숫자/철자/읽기순서 보조"로만 한정 + 충돌 시 이미지 우선 + 결함 유형별 on/off 검토(예: `NOSPACE_RUN` 페이지는 anchor 제외 고려).
- **베끼기(copy-through)**: 통짜 주입 시 모델이 anchor를 그대로 출력. 완화: 보수적 cap + 베끼기 금지 문구 + greedy(temp0).
- **invisible strip 타이밍**: reflow `blocksByPage`는 invisible 정리 **후** `result.blocks`라 안전. force_ocr `kByPage`는 `kordocBuf` 재파싱이라 미적용 → force_ocr에 anchor 쓰면 strip 선행 필수(§P0 force_ocr).

**테스트.**
- 단위: `pdfOcrAnchor`가 `[anchor 시작]/[anchor 끝]`+규칙 포함; `truncateAnchor` cap 경계.
- 단위: `kordocByPage` 주입 시 `vllmOcrPageStrict`가 `anchorText` 수신(mock), 미주입 시 `text` 미전달(byte 동일).
- 실측: `acc_tmp/measure.mjs` 3지표(problemTotal/숫자 missing/완전성)를 `VLLM_OCR_ANCHOR=1` vs `=0` A/B. **숫자 missing 감소(목표), 완전성·problemTotal 비퇴행.** 메모리 "숫자는 천장(0 missing)" 회귀 확인.
- 음성 케이스: 띄어쓰기 소실 anchor 주입 페이지에서 한글 무공백 뭉침 증가 모니터.

**env.** `VLLM_OCR_ANCHOR`(기본 1/on, `=0`이면 legacy), `VLLM_OCR_ANCHOR_MAX_CHARS`(기본 2000).

**작업량.** M. (배관은 가벼움 — text 슬롯 기배선. 비용 대부분은 tiered truncation + 오염/베끼기 실측 튜닝.)

---

### P0.5 — `NUMERIC_MISMATCH` 경고 → 조건부 재시도(accept/rollback)

**목표.** 숫자 불일치 페이지를 kordoc 숫자를 콕 집은 보정 프롬프트로 vision 재호출 → 재검증 → 좋아지면 채택, 나빠지면 rollback.

**현재 상태(근거).**
- `comparePageNumbers(kordocText, visionText)` = `postprocess.js:486`, 반환 `{kordocNumbers, missing, extra, ok, unverified}`. 유의숫자=소수점/콤마/3자리+(487), `ok=missing.length===0`(515), kcount=0이면 `unverified`(500). 오독(2,306→2,308)은 missing+extra 동시 검출.
- 숫자검증은 **force_ocr 경로(convert.js:151-187)에만** 존재, 재시도 없이 경고만. **reflow 경로엔 검증 자체가 없음.**
- 표/반복 재시도(`ocrPageAdaptive` TABLE_MAX_RETRY, vllm.js:320/791/792-813)는 "구조 결함" 레이어 → numeric repair("전사 완료 후 숫자 대조")와 별 레이어라 공존.
- `convert.js:166`은 `r.pageTexts`(postprocess 전 raw)로 비교 → raw vision vs raw kordoc, 안전.

**변경.**
1. `server/config/prompt.js` — `pdfOcrNumericRepair(kordocNumbers)` 신설(`pdfOcrRepeatRetry` 뒤). 내용: kordoc 유의숫자 목록을 검증기준으로 제시 + (a)보이면 정확히 포함, (b)안 보이면 만들지 말 것(환각금지), (c)글자/표구조/한글 임의변경 금지, (d)출력은 수정 OCR markdown(HTML 표)만. 기존 `extraInstruction` 파라미터로 주입(새 파라미터 불필요).
2. `server/vllm.js` `ocrSelectedPdfPages` — `kordocByPage` 보유 시 통짜 페이지 OCR 직후(1086 부근) `comparePageNumbers` → `missing≥임계`면 `NUMERIC_REPAIR_MAX`(기본 1)회까지 `vllmOcrPageStrict(..., {samplingOverride:{temperature:0}, extraInstruction: prompts.pdfOcrNumericRepair(missing)})` 재호출 → 재검증. **accept 조건: missing 수 엄격 감소 AND extra 폭증 없음.** 아니면 rollback. 펼침면 제외. 남은 mismatch는 `onWarning`으로 표면화.
3. `server/postprocess.js` — accept/rollback 판정용 미스매치 수 비교는 `comparePageNumbers().missing.length` 인라인 또는 작은 헬퍼.
4. `server/convert.js` reflow(415) — `kordocByPage`(P0와 **공유**) + `onWarning` 전달. (reflow는 이미 `result.blocks` 보유 → 추가 parse 불필요.)
5. `server/convert.js` force_ocr — §2.7 단일 리팩터로 처리(verify를 enrich 앞으로, repair 삽입).

**force_ocr 단일 리팩터(§2.7).** P0(anchor)와 P0.5(repair)가 force_ocr 경로에서 얽힘 → **한 번에**:
```
parse(kordocBuf) → invisible strip → kordocByPage 빌드
  → ocrPdfBuffer(anchor 적용) → numeric repair(accept/rollback) → postprocess → enrich
```
parse/verify를 두 번 옮기지 말 것. (force_ocr anchor 적용 여부는 §4 결정 필요 — 미적용이면 repair만.)

**위험.**
- kordoc 숫자 자체 오염 → vision을 틀린 숫자로 끌어내림. 완화: invisible strip 선행 + 보수적 accept(missing 감소 AND extra 비폭증).
- accept 느슨 → 환각으로 missing만 줄이고 사실오류 증가. 완화: "안 보이면 만들지 말 것" 명시 + extra 증가량 상한.
- 재시도 폭주/비용: `NUMERIC_REPAIR_MAX`(기본 1) + 트리거 임계 + 펼침면 제외.
- force_ocr repair를 enrich 후에 넣으면 합본 충돌 → enrich 이전 배치.
- `## 페이지 N` 합본 규약(vllm.js:969-977) 의존 → `pageTexts` 갱신 후 재합성은 헬퍼 1곳으로.

**테스트.**
- 단위: `pdfOcrNumericRepair(['2306','1383720'])`가 숫자목록+환각금지 포함.
- 단위: accept(missing↓)/rollback(불변·증가·extra폭증) 판정.
- 단위: `kordocByPage` 주입 시 repair 1회 재호출(mock), 펼침면 미호출.
- 실측: `measure.mjs`(force_ocr & hybrid)에서 페이지별 missing 총합 감소 + problemTotal 비악화. 인구동향 류 숫자 오독 사례 검증.
- 환각 가드: kordoc에만 있고 페이지엔 없는 숫자 주입 시 vision이 추가 안 하고 rollback.
- `VLLM_OCR_NUMERIC_REPAIR=0`이면 경고-only legacy와 byte 동일.

**env.** `VLLM_OCR_NUMERIC_REPAIR`(기본 1), `VLLM_OCR_NUMERIC_REPAIR_MAX`(기본 1), `VLLM_OCR_NUMERIC_REPAIR_MIN_MISMATCH`(기본 2, 보수적).

**작업량.** M.

---

### P1 — "페이지 N / 총 M" 주입

**목표.** OCR user 프롬프트에 문서 총 페이지 M을 추가해 마지막/이어짐 판단 단서 제공.

**현재 상태(근거).** `pdfOcrUser(pageNumber)`(prompt.js:121-123)에 M 없음. `pdfOcrTileUser`는 타일 X/Y만 있음. M 소스는 `renderer.pageCount`로 양 진입점에 이미 존재(§2.2).

**변경.**
1. `prompt.js` — `pdfOcrUser(pageNumber, pageTotal)`. `pageTotal`이 유효할 때만 `페이지 N / 총 M 이미지입니다…`, 아니면 기존 문구(회귀 무해).
2. `vllm.js` — §2.1 옵션 객체로 `pageTotal` 수신. `ocrPageAdaptive`가 `renderer.pageCount`를 잡아 정상(770)·재시도(800)·globalView(780/823)로 전달. `ocrSelectedPdfPages`는 `renderer.pageCount`(1078)로 펼침면 호출(1106/1112)에 전달.
3. **타일 중복 처리**: 타일 경로는 `pageTotal=0`(또는 null)을 넘겨 페이지 N 중복 노출 회피, 타일 X/Y만 유지(권장).

**위험.** 거의 없음. greedy라도 user 바이트 변경으로 baseline diff 발생(품질저하 아님). M 혼동 방지(타일에 M 미노출), reflow M=`renderer.pageCount`(want.length 아님).

**테스트.** `pdfOcrUser(3,10)`에 "총 10" 포함 / `pdfOcrUser(2)`·`(1,1)`은 미포함. reflow 일부 페이지에서 M=문서 total 확인. 단일 이미지(`imageOcrUser`) 불변. measure 비퇴행.

**env.** 없음(또는 형식 토글 불필요).

**작업량.** **S.** (P1은 §2.1 옵션 객체 리팩터를 강제하므로 P0와 같은 PR로 착지 권장.)

---

### P1.5 — 선택 reflow 페이지를 chart enrich(page-visual) 대상에 포함

**목표.** 일반 kordoc 경로의 reflow/차트단서 페이지도 enrich가 차트 해설을 달도록 한다(현재 구멍).

**현재 상태(근거).**
- `convert.js:229` `let visualPages = []`. 스캔/force_ocr만 채움(`convert.js:258`/`145`). **reflow 경로(312-449)는 visualPages를 안 채움** → enrich page-visual target 0개.
- force_ocr/스캔은 `ocrPdfBuffer`(vllm.js:953-960)가 `VISUAL_CUE_RE` 페이지를 `VISUAL_RENDER_FACTOR`로 렌더해 모음.
- **핵심 함정**: `findVisualPageTargets` 폴백 `anchorIndexForPage`(vllm.js:629)는 `"## 페이지 N"` 마커에 의존하는데, **일반/reflow markdown엔 그 헤딩이 없다**(그 규약은 `ocrPdfBuffer`에만 존재) → 폴백 항상 null. 캡션 매칭(`findPageForContext`)만 남음.
- 무해성: page-visual은 `isNoVisualResponse`면 폐기(skipped++) → 비차트 페이지 잘못 모아도 무해(비용만).

**변경.**
1. 차트단서 페이지 이미지 회수 — **두 안 중 택1(§4 결정 필요)**:
   - **(A)** `ocrSelectedPdfPages`가 OCR한 reflow 페이지에 한해 이미지 회수(캡슐화·변경 작음, 단 차트 페이지가 reflow 대상 아니면 누락).
   - **(B, 권장)** `convert.js`에서 `blocksByPage` 전 페이지에 `VISUAL_CUE_RE` 적용 → `rawBackup.slice(0)`로 `openPdfRenderer` 한 번 더 열어 차트단서 페이지를 `VISUAL_RENDER_FACTOR`로 렌더해 `visualPages`에 모음(force_ocr와 동등 커버리지). `VISUAL_*` const export 필요.
2. **텍스트 기반 앵커 폴백**: `anchorIndexForPage`를 `page.blocks[0].content` 앞부분(정규화 N자)을 md 본문에서 찾는 폴백으로 보강(현행 `## 페이지 N` 병행/대체). 모을 때 `blocks:[{content: 해당 페이지 텍스트}]` 반드시 채움.
3. 펼침면은 enrich 입력 부적합 → collect 제외. `VISUAL_PAGE_CAP`(30)·KB 상한 재사용.

**위험.** 앵커 폴백 없으면 visualPages를 채워도 target 0(최대 함정). 과수집(`VISUAL_CUE_RE`의 매출/추이 등 흔함) → 보수적 단서로 좁히기 검토. 반환형 변경 시 호출부/테스트 깨짐 → out 파라미터 방식 권장.

**테스트.** 차트단서 텍스트PDF(reflow X)에서 변경 전 0 → 후 차트 해설 삽입. reflow=차트 동시 페이지 dedup. `findVisualPageTargets` 단위(헤딩 없는 md + 텍스트 폴백). 비차트 NO_VISUAL 폐기 무해. CAP/KB 상한.

**작업량.** M.

---

### P2 — 회전 감지 + 결정 로그 + env 일원화 + 테스트/문서

**A) 회전(조건부, 보류 권장).**
- `openPdfRenderer`(vllm.js:709)·`detectSpreadPages`(1014)는 `getBounds`만 읽음. 회전/스큐 보정 0건.
- mupdf `Page.rotation`/`/Rotate` API 존재 여부 **미확인(실측 필요)**.
- **기본 OFF**(`VLLM_OCR_AUTOROTATE=0`). 회전 샘플 PDF 확보 전엔 메타만 읽어 결정 로그에 `reasons:['rotated:90']` 기록, 픽셀 보정은 보류. (오보정 시 정방향 정부문서 전 페이지 붕괴.)

**B) 결정 로그(metadata only — Markdown 미포함).**
- 발견된 버그: `reflowInfo`가 계산(convert.js:435)·로그(479)만 되고 **return metadata에서 누락**(487). → return에 `reflowInfo`, `ocrInfo`, 신규 `pageRoutes` 포함.
- `verification` 위치 불일치: 코드는 `metadata.verification`(convert.js:201), `openapi.js:249`는 top-level → 한쪽으로 일원화(소비자 `/review`가 어디서 읽는지 확인 후).
- `pageRoutes`: `{page, route:'reflow|keep', reasons:[…], retry, warnings}`를 reflow 결정 시 누적(현재 산발 `console.log`를 구조화). `index.js:63`이 `{ok, ...result}` spread라 top-level 필드는 자동 응답 포함. `eval.js:237`에도 보존(회귀 추적).
- **Markdown엔 절대 새지 않게**(RAG 오염 방지) — `cleaned`만 유지.

**C) env 일원화.** `config/vllm.js`(Object.freeze + `process.env.X||기본`)에 신규 훅 집중. 선택: 분산 상수(`VISUAL_RENDER_FACTOR`:556, `VISUAL_PAGE_CAP`:558, `TABLE_MAX_RETRY`:320, `SPREAD_TEXT_MIN` convert.js:357) 흡수(순환참조 주의) — **별도 정리 PR 권장.**

**D) 테스트(신규/확장).**
- 기존: `*.test.mjs`(vLLM 무의존), 코퍼스 평가(`accuracy.mjs`/`fidelity.mjs`/`measure.mjs`).
- 신규: `tests/page-info.test.mjs`(comparePageNumbers 경계), `tests/anchor.test.mjs`(anchorIndexForPage/findVisualPageTargets 폴백), `tests/route-info.test.mjs`(reflowInfo/pageRoutes는 응답에 포함·markdown엔 부재).
- 확장: `tests/reflow.test.mjs`(expectedTables/광폭표 제외/표깨짐 폐기 결정 순수함수 추출 후 케이스), `tests/postprocess.test.mjs`(comparePageNumbers + accept/rollback).
- `detect.test.mjs`는 `D:/workspace/file` 실파일 의존 → 신규는 무의존 순수 단위로(CI 안정).

**E) 문서(갱신 — 정정).**
> ⚠️ 조사 에이전트는 `pipeline.md`/`README.md`가 없다고 보고했으나 **ground truth(`git ls-files`)상 둘 다 루트에 존재**. → "신규 생성"이 아니라 **갱신**.
- `pipeline.md`: anchor 단계, numeric repair 루프, reflow chart enrich, metadata 계약(reflowInfo/verification/pageRoutes), 신규 env 표 반영.
- `README.md`: 신규 env, force_ocr/anchor 토글, 테스트 실행 요약.
- `openapi.js`(233-263 ConvertResult): `reflowInfo`/`pageRoutes`/`verification` 스키마 동기화.

**env.** `VLLM_OCR_AUTOROTATE`(기본 0), `VLLM_EMIT_ROUTES`(기본 1).

**작업량.** M.

---

## 4. 착수 전 결정 필요 (사용자 판단)

| # | 결정 | 권장 |
|---|---|---|
| D1 | **force_ocr에 anchor 적용?** (A: 적용+parse 선행 / B: reflow만, force_ocr는 repair만) | **B 먼저**(변경·리스크 최소), 안정 후 A |
| D2 | **anchor 기본 모드**: native 통짜(cap 내) vs 처음부터 숫자/헤더 압축 | 통짜+cap 2000 시작, 오염 보이면 압축 |
| D3 | **numeric repair 트리거 임계** missing 수 | 2 (1은 노이즈 가능) |
| D4 | **P1.5 범위**: (A) reflow 페이지만 vs (B) 전 페이지 차트단서 별도 렌더 | **B**(차트 누락 방지) |
| D5 | **회전**: 메타만 로깅 vs 완전 보류 | 보류(샘플 생기면 A) |
| D6 | **page N/M 문구** 형식 | `페이지 N / 총 M 이미지입니다` (한국어) |
| D7 | **§2.1 옵션 객체 리팩터** 수용? | 수용(미수용 시 고정 위치 인자 + 7 호출부 일괄) |
| D8 | **config 분산 상수 흡수(P2-C)** 이번 범위 포함? | 별도 PR로 분리 |

---

## 5. 권장 PR 분해 (구현 순서)

> 원칙: 시그니처를 공유하는 항목은 한 PR로(§2.1/§2.7). env 토글은 측정보다 먼저(§2.6).

1. **PR1 — 배관 + P1 (S)**
   `vllmOcrPageStrict` 옵션 객체화(§2.1) + `ocrPageAdaptive/GlobalView/Tiled` 시그니처 통일 + `pdfOcrUser(N,M)` + `renderer.pageCount` 내부 사용 + **전 env 토글 골격**(`=0`이면 legacy byte-identical). 7 호출부(490,770,800,823,852,1106,1112) 일괄 이전. measure baseline 재확보.

2. **PR2 — P0 anchor(reflow) (M)**
   `pdfOcrAnchor` + `truncateAnchor` + `kordocByPage`(reflow, 펼침면 제외) + anchor 주입. `VLLM_OCR_ANCHOR` A/B 측정.

3. **PR3 — P0.5 numeric repair(reflow) (M)**
   `pdfOcrNumericRepair` + `comparePageNumbers` 재사용 + accept/rollback을 `ocrSelectedPdfPages`에 (PR2의 `kordocByPage` 재사용).

4. **PR4 — force_ocr 단일 리팩터 (M)** *(D1=A 선택 시)*
   parse→invisible strip→`kordocByPage`→`ocrPdfBuffer`(anchor)→repair→enrich 순서 재배치(§2.7). D1=B면 repair만.

5. **PR5 — P1.5 chart enrich(reflow) (M)**
   visualPages 수집(D4 안) + `anchorIndexForPage` 텍스트 폴백.

6. **PR6 — P2 + 횡단 (M)**
   `reflowInfo`/`pageRoutes` metadata 노출 + `verification` 위치 일원화 + 결정 로그 구조화 + 테스트 4종 + `pipeline.md`/`README.md`/`openapi.js` 갱신. (회전은 보류/메타만, config 흡수는 별도.)

---

## 6. 핵심 파일 인덱스

| 파일 | 역할 | 주요 라인 |
|---|---|---|
| `server/config/prompt.js` | 모든 프롬프트 | pdfOcrUser:121, pdfOcrSystem:65, retry:129/143 |
| `server/vllm.js` | OCR 엔진 | vllmOcrPageStrict:471, ocrPageAdaptive:746, ocrSelectedPdfPages:1073, ocrPdfBuffer:937, findVisualPageTargets:560, anchorIndexForPage:629 |
| `server/convert.js` | 파이프라인 | force_ocr:118-205, 검증:151-187, reflow:312-449, return:485 |
| `server/postprocess.js` | 후처리/검증 | comparePageNumbers:486 |
| `server/providers.js` | provider 추상화 | text 슬롯 build (vllm:35, anthropic:188, bedrock:277) |
| `server/ai.js` | aiComplete | system 분기:84, CLI complete:92 |
| `server/config/vllm.js` | env 훅 | render:27, features:42 |
| `server/openapi.js` | 출력 계약 | ConvertResult:233-263, verification:249 |
| `acc_tmp/measure.mjs` | 3지표 회귀 측정 | comparePageNumbers:10 |

---

## 6.5. 구현 현황 (2026-06-22 · 확정 D1–D8 반영)

| 항목 | 상태 | 메모 |
|---|---|---|
| **P0** anchor 주입(reflow) | ✅ 완료 | `pdfOcrAnchor`/`truncateAnchor`/`kordocByPage`. D2: 펼침면+`NOSPACE_RUN` 제외 |
| **P1** 페이지 N/총 M | ✅ 완료 | `pdfOcrUser(n,m)`, `renderer.pageCount` 내부 사용, 옵션객체 통일(D7) |
| **P0.5** numeric repair(reflow) | ✅ 완료 | `pdfOcrNumericRepair`+`acceptNumericRepair`. D3: 임계 2 / MAX 1 |
| **P1.5** 차트 enrich(reflow, D4=B) | ✅ 완료 | `collectChartVisualPages`(전 페이지 cue) + `anchorIndexForPage` 텍스트 폴백 |
| **P2** reflowInfo metadata 반환 | ✅ 완료 | 계산만 되고 누락되던 버그 수정 + `ocr`/`enrich` 동봉 |
| **P2** force_ocr 검증 보강 | ✅ 완료 | D1=B: anchor 미적용, 검증 kordoc에 invisible-strip 적용(거짓 mismatch↓). 경고 유지(repair 승격 안 함) |
| 문서(pipeline.md/README/.env.example/plan) | ✅ 완료 | 신규 env·단계 반영 |
| 테스트 `tests/anchor.test.mjs` | ✅ 완료 | 31 케이스(프롬프트/truncate/accept/anchor 폴백) + npm test 등록 |
| **P2** rotation (D5) | ⏸ 보류 | mupdf API 미확인 + 샘플 0건. 샘플 확보 시 재개 |
| **P2** pageRoutes 구조화 로그 / openapi verification 위치 일원화 | ⏸ 보류 | 관측은 `onWarning`(NUMERIC_REPAIR/MISMATCH)+`reflowInfo`로 충족. 필요 시 후속 |
| config 분산 상수 흡수 (D8) | ⏸ 별도 PR | 순환참조 위험 — 범위 분리 |

**신규 함수/시그니처(최종):**
- `vllmOcrPageStrict(img, n, mime, { samplingOverride, extraInstruction, anchorText, pageTotal })` — 옵션객체(D7)
- `ocrPageAdaptive(renderer, n, expectedTables, anchorText)` · `ocrPageGlobalView(png, n, anchorText, pageTotal)`
- `ocrSelectedPdfPages(buf, pages, { …, kordocByPage, onWarning })` — anchor+repair 공용 단일 Map
- `collectChartVisualPages(buf, pageTextByPage, { exclude })` · `acceptNumericRepair`/`anchorIndexForPage`/`truncateAnchor`(export, 테스트용)
- 프롬프트: `pdfOcrUser(n,m)`, `pdfOcrAnchor`, `pdfOcrNumericRepair`

---

## 7. 성공 기준 (DoD)

- [ ] `VLLM_OCR_ANCHOR=0`/`VLLM_OCR_NUMERIC_REPAIR=0`/page-N-off에서 **legacy와 byte-identical** 출력(회귀 안전망).
- [ ] anchor on: `measure.mjs` 숫자 missing **감소**, 완전성·problemTotal **비퇴행**(메모리 "숫자는 천장(0 missing)" 유지).
- [ ] numeric repair: 환각 가드 통과(없는 숫자 추가 안 함, rollback 동작).
- [ ] reflow 차트 페이지에 해설(인용/표) 삽입 확인.
- [ ] `reflowInfo`/`pageRoutes`가 응답 metadata에 포함되고 **최종 Markdown엔 부재**.
- [ ] 신규/확장 테스트 그린(`node tests/*.test.mjs`).
