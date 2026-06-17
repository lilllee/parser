# 문서 변환 전체 파이프라인

현재 코드 기준으로 파일이 Markdown으로 변환되고 `/review`에서 검수 결과로 저장되는 흐름을 정리한다.

핵심 원칙은 **로컬 구조 파싱(kordoc)을 먼저 수행하고, 로컬 파싱만으로 부족한 경우에만 AI vision/OCR을 보조로 호출**하는 방식이다.

코드 기준:

- API 진입점: `server/index.js`
- 변환 파이프라인: `server/convert.js`
- PDF 문제 페이지 감지: `server/detect.js`, `server/config/detect.js`
- AI/OCR/enrich 처리: `server/vllm.js`, `server/ai.js`, `server/providers.js`
- PDF 보이지 않는 텍스트 제거: `server/invisible.js`
- Markdown 후처리: `server/postprocess.js`, `server/config/corrections.js`
- 검수 화면/배치 실행: `server/eval.js`, `review/app.js`

---

## 1. 진입점

### 1.1 단일 변환 API

| 항목 | 내용 |
|---|---|
| Swagger/API | `POST /api/convert` |
| 요청 형식 | `multipart/form-data` |
| 필수 필드 | `file` |
| 선택 필드 | `provider`, `model`, `api_key`, `base_url`, `url`, `region`, `profile` 등 provider별 설정 |
| 성공 응답 | `{ ok, markdown, metadata, pageCount, elapsedMs }` |
| 실패 응답 | `{ ok:false, error, code, elapsedMs }` |

흐름:

```text
multipart 요청
  -> file arrayBuffer 추출
  -> resolveAiConfig(body)
  -> runConvert(arrayBuffer, filename, {}, aiConfig)
  -> elapsedMs 포함해서 JSON 응답
```

### 1.2 검수 화면 `/review`

`/review`는 여러 문서와 여러 provider/model 조합을 반복 실행하고 결과를 저장하는 검수용 UI다.

주요 API:

| API | 역할 |
|---|---|
| `GET /api/eval/providers` | 사용 가능한 provider와 Bedrock 고정 모델 목록 조회 |
| `GET /api/eval/files` | 검수 파일 목록 조회 |
| `POST /api/eval/upload` | 검수 문서 업로드 |
| `POST /api/eval/files/clear` | 검수 파일 목록 초기화 |
| `POST /api/eval/cache/clear` | Golden/결과 캐시 초기화 |
| `GET /api/eval/source` | Golden 패널에서 원본 파일 표시 |
| `GET /api/eval/golden` | Golden 데이터 조회, 기본값은 원본 뷰어 |
| `POST /api/eval/check` | provider/model 연결 사전 점검 |
| `POST /api/eval/run` | 단일 파일 + 단일 provider 실행 |
| `POST /api/eval/batch` | 여러 파일 + 여러 provider 실행 |
| `GET /api/eval/result.md` | 변환 결과 Markdown 다운로드 |
| `POST /api/eval/judgement` | 사람이 검수한 점수/메모 저장 |
| `GET /api/eval/export.csv` | 결과/검수 점수 CSV 내보내기 |

`/review`에서 실행해도 실제 변환은 결국 `runConvert()`를 탄다.
다만 검수 기록에는 `elapsedMs`, `aiCalls`, `aiFailures`, `quality`, `metrics`가 추가로 저장된다.

---

## 2. 전체 흐름 요약

```text
업로드 파일
  |
  v
[0] 요청별 AI provider 설정 해석
  |
  +-- 이미지 파일인가?
  |     |
  |     +-- 예
  |     |    -> AI vision OCR 필수
  |     |    -> ocrImageBuffer
  |     |    -> postprocessMarkdown
  |     |    -> 응답
  |     |
  |     +-- 아니오
  |
  v
[1] kordoc parse
  |
  +-- 성공
  |     |
  |     +-- PDF blocks 있음?
  |     |     |
  |     |     +-- 예
  |     |          -> mupdf 기반 보이지 않는 흰색 텍스트 제거
  |     |
  |     +-- PDF이고 AI 사용 가능하고 blocks 있음?
  |     |     |
  |     |     +-- 예
  |     |     |    -> 망가진 페이지/펼침면/kordoc needsOcr 페이지 감지
  |     |     |    -> 대상 페이지가 있으면 선택 페이지 AI OCR reflow
  |     |     |    -> OCR 표가 계속 깨지면 해당 페이지는 kordoc 원본 유지
  |     |     |
  |     |     +-- 아니오
  |     |          -> reflow 없음
  |     |
  |     v
  |   postprocessMarkdown
  |     |
  |     +-- AI 사용 가능?
  |           |
  |           +-- 예
  |           |    -> enrichMarkdown
  |           |    -> 이미지/표/page visual target이 있을 때만 AI 호출
  |           |
  |           +-- 아니오
  |                -> enrich 생략
  |
  +-- 실패 또는 이미지 기반 PDF 판정 + AI 사용 가능
  |     |
  |     +-- 전체 페이지 AI OCR fallback
  |     +-- ocrPdfBuffer
  |     +-- postprocessMarkdown
  |     +-- enrichMarkdown
  |     +-- 응답
  |
  +-- 실패
        |
        +-- 에러 응답
```

---

## 2.1 완료 처리의 의미와 경계

변환 성공은 **입력으로 들어온 파일의 페이지들을 처리했다**는 뜻이다.
입력 PDF 자체가 원문 일부만 잘라낸 청크라면, 변환기는 그 청크가 원문 장/조문/표의 중간에서 끝났는지까지 자동으로 실패 처리하지 않는다.

예:

- `2026년 경기도 보육사업 안내-163-166.pdf`는 4쪽짜리 입력 파일이다.
- 마지막 4쪽은 원본 렌더와 PDF 텍스트 레이어 모두 `제2조(도지사의 책무) ... <개정 2013.4.4.>`에서 끝난다.
- 따라서 변환 결과가 그 지점에서 끝나는 것은 파서가 하단을 누락한 것이 아니라, 입력 PDF 청크 자체가 그 지점에서 끝나는 경우다.

운영상 주의:

- 원문 전체성을 보장하려면 PDF 분할/청크 생성 단계에서 페이지 overlap 또는 다음 페이지 연결 검사를 둬야 한다.
- 현재 파싱 파이프라인은 “주어진 파일 내부의 추출 품질”을 보정한다.
- “원문이 중간에서 잘렸는지”는 upstream 청크 경계 검수 또는 별도 품질 경고로 다루는 것이 맞다.

청크 경계 완전성 경고(`detectBoundaryIssues`, `tests/quality.mjs`)는 결정론적으로 다음을 감지해 `onWarning` 으로 표면화하고, `/review` 의 `quality.boundary` 에 기록한다(변환 실패는 아니며 `problemTotal` 에는 합산하지 않음):

- `INCOMPLETE_TAIL` — 마지막 줄이 조사/접속어미·쉼표·콜론·열린 괄호로 끝남(문장 미완)
- `UNCLOSED_TABLE` — HTML `<table>` 개폐 불일치(표가 끝에서 잘림)
- `STATUTE_CUTOFF` — “다음 각 호” 뒤 목록 없음, 또는 조/항/호 머리만 있고 본문 없이 끝남
- `PAGE_RANGE_CHUNK` — 파일명이 `...-N-M.ext`(M≥N) 페이지 구간 청크 패턴

---

## 3. AI 호출이 필요 없을 때

아래 경로는 모델 호출 없이 처리될 수 있다.

| 상황 | 처리 | 실제 AI 호출 |
|---|---|---|
| 텍스트 레이어가 정상인 PDF | `kordoc.parse` -> `postprocessMarkdown` | 없음 |
| HWP/HWPX/HWPML/DOCX/XLSX/XLS/TXT/MD 등 일반 문서 | `kordoc.parse` -> `postprocessMarkdown` | 없음 |
| PDF지만 망가진 페이지/펼침면 감지 결과가 0개 | 선택 reflow 없이 kordoc 결과 사용 | 없음 |
| 문서에 분석할 이미지가 없고 표 분석도 꺼져 있음 | `enrichMarkdown`가 호출되어도 target 0개라 즉시 종료 | 없음 |
| AI provider 미설정 상태의 일반 문서 | parse progress를 0~1로 잡고 AI 단계 전체 생략 | 없음 |
| `/review` Golden 패널 기본 표시 | 원본 PDF/image/file viewer 표시 | 없음 |

중요한 구분:

| 상태 | 의미 |
|---|---|
| AI provider enabled | 해당 요청에서 AI 호출이 가능한 설정이라는 뜻 |
| 실제 AI 호출 발생 | 내부에서 `aiComplete()`가 실행됐다는 뜻 |

따라서 provider가 켜져 있어도 OCR/reflow/enrich 대상이 없으면 `aiCalls`는 0일 수 있다.

---

## 4. AI 호출이 필요한 때

### 4.1 이미지 파일 OCR

대상 확장자:

```text
png, jpg, jpeg, webp, gif, bmp, tif, tiff
```

이미지 파일은 kordoc을 거치지 않고 바로 AI vision OCR로 처리한다.

```text
image file
  -> imageMimeFromName
  -> AI enabled 확인
  -> ocrImageBuffer
  -> postprocessMarkdown
  -> { markdown, metadata: { source: "image-ocr", mimeType }, pageCount: 1 }
```

AI provider가 꺼져 있으면 `AI_REQUIRED` 에러가 발생한다.

### 4.2 텍스트 레이어 없는 PDF

다음 중 하나면 스캔본/이미지 기반 PDF로 본다.

- `kordoc.parse()`가 실패하고 `result.code === "IMAGE_BASED_PDF"`
- `result.fileType === "pdf"`이고 `result.isImageBased === true`이며 `blocks`가 비어 있음

AI 사용 가능:

```text
IMAGE_BASED_PDF
  -> mupdf로 전체 페이지 PNG 렌더링
  -> 페이지별 AI OCR
  -> "## 페이지 N" 섹션으로 합성
  -> postprocessMarkdown
  -> enrichMarkdown
```

AI 사용 불가:

```text
IMAGE_BASED_PDF
  -> kordoc 변환 실패
  -> 에러 응답
```

### 4.3 PDF 선택 페이지 reflow

kordoc이 성공했더라도 일부 페이지의 레이아웃이나 텍스트가 망가진 경우, 해당 페이지만 AI OCR로 다시 읽어서 기존 block을 교체한다.

조건:

- AI provider 사용 가능
- 전체 OCR fallback 경로가 아님
- `result.fileType === "pdf"`
- `result.blocks`가 존재

대상 페이지 선별:

| 감지 함수 | 잡는 케이스 |
|---|---|
| `detectMangledPages(blocks, pageCount)` | 가짜 표, 숫자표 붕괴, paragraph 안 pipe 표, 한국어 띄어쓰기 소실, 글리프 노이즈, 차트 축눈금 잔해, 숫자 단락 흩어짐, 저밀도 페이지, 개정 대비표 |
| `detectSpreadPages(rawBackup, blocks)` | 한 PDF 페이지 안에 좌우 두 쪽이 들어간 포켓북/펼침면 |
| `result.pageQuality[].needsOcr` | kordoc 품질 판정상 OCR이 필요한 페이지 |

`detectMangledPages()`가 표에서 보는 주요 신호:

- 병합 구조가 없는 표에서 긴 산문 셀이 반복되는 가짜 표
- 한 셀에 숫자 여러 열이 붙은 값 뭉침
- 쉼표 금액이 구분자 없이 붙은 금액 뭉침
- 단위와 값이 한 셀에 붙은 단위 뭉침
- 한 셀에 여러 줄 문단이 과도하게 들어간 셀 뭉침
- 좌우 컬럼이 중복된 비교표
- 정상 HTML 병합 표는 느슨한 오탐 신호에서 면제하되, 값 뭉침 같은 강한 신호는 그대로 감지

처리:

```text
targets = mangled pages + spread pages
  -> 대상 페이지별 kordoc 표 개수(expectedTables) 수집
  -> ocrSelectedPdfPages(rawBackup, targets, { spreadPages, expectedTables })
  -> reflowBlocksWithOcr
  -> blocksToMarkdown
```

펼침면 페이지는 좌/우 반쪽으로 잘라 왼쪽, 오른쪽 순서로 OCR한 뒤 합친다.

OCR 결과 검증:

- `hasBrokenTable()`이 Markdown 표 칸 수 불일치, `rowspan/colspan` 텍스트 누출, HTML 표 유효 열 수 불일치, 빈 `<th>`로 병합 헤더를 때운 패턴을 잡는다.
- 대상 페이지에 기대 표 개수가 있으면 OCR 결과의 표 개수가 부족한 경우도 실패로 본다.
- 깨진 표가 감지되면 최대 2회 표 전용 retry prompt로 재시도한다.
- 재시도 후에도 표가 깨졌고 kordoc 원본 페이지 블록이 있으면 OCR 결과를 폐기하고 kordoc 출력을 유지한다.
- kordoc 원본 블록이 없는 페이지는 OCR이 유일한 결과이므로 OCR 결과를 유지한다.

### 4.4 Markdown enrich

후처리된 Markdown에서 분석 대상이 발견되면 AI를 호출해 설명을 삽입한다.

| 대상 | 기본 동작 | AI 호출 조건 |
|---|---|---|
| Markdown 이미지 reference | kordoc이 추출한 raster 이미지와 매칭되면 분석 | AI enabled + 이미지 target 존재 |
| Markdown 표 | 기본 비활성 | `VLLM_TABLE_ANALYSIS=1` + 표 target 존재 |
| page visual (그림/차트 해설) | 스캔본 OCR·이미지 파일 경로에서 OCR이 렌더한 페이지 이미지를 enrich 입력으로 공급 | `VLLM_PAGE_VISUAL !== "0"` + 차트/그림 단서 페이지 존재(스캔본은 최대 `VLLM_VISUAL_PAGE_CAP`=30p) |

> 역할 분담: OCR 프롬프트는 **전사만** 한다(차트 값 라벨은 표로 변환하되 "> " 인용 분석은 붙이지 않음).
> 그림/차트의 서술형 해설은 이후 `enrichMarkdown`의 page-visual 단계가 담당한다. 그래서 스캔본/이미지
> OCR 경로는 OCR이 렌더한 페이지 이미지를 `visualPages`로 enrich에 넘긴다. (텍스트 PDF 선택 reflow
> 페이지는 아직 page-visual 입력을 공급하지 않음 — 해당 페이지 차트는 표 전사만 남고 해설은 생략될 수 있음.)

삽입 형식:

- 일반 분석문은 인용 블록으로 삽입
- 분석 결과에 Markdown/HTML 표가 있으면 표는 보존하고 산문만 인용 처리

### 4.5 `/review` provider 연결 점검

`/review`에서 실행 전 `/api/eval/check`를 호출하면 `aiPing()`으로 provider/model 접근 가능 여부를 확인한다.

이 호출은 문서 변환 자체는 아니지만, 실제 provider에 짧은 요청을 보내므로 AI/API 호출에 포함된다.
Bedrock 다중 모델 실행 시에는 선택된 Bedrock 모델마다 사전 점검이 수행될 수 있다.

---

## 5. 단계별 상세

### [0] AI provider 설정

`resolveAiConfig()`는 요청 form/body와 `.env` 기본값을 합쳐 요청별 AI 설정을 만든다.

지원 provider:

| provider | 주요 설정 |
|---|---|
| `vllm` | `url`, `model`, `thinking` |
| `openai` | `api_key`, `model`, `base_url` |
| `gemini` | `api_key`, `model`, `base_url` |
| `anthropic` | `api_key`, `model`, `base_url`, `version` |
| `bedrock` | `region`, `model`, `profile`, `access_key_id`, `secret_access_key`, `session_token` |
| `claude_cli` | `model` |
| `codex_cli` | `model` |

`withAiConfig()`가 AsyncLocalStorage에 요청별 설정을 올려두기 때문에 내부의 `aiComplete()` 호출은 모두 같은 요청 provider를 사용한다.

### [1] kordoc parse

비이미지 파일은 먼저 `kordoc.parse(arrayBuffer)`로 구조 파싱한다.

주요 출력:

```js
{
  success,
  markdown,
  blocks,
  metadata,
  images,
  warnings,
  fileType,
  pageCount,
  code
}
```

용도:

| 값 | 사용처 |
|---|---|
| `markdown` | 기본 변환 결과 |
| `blocks` | PDF 문제 페이지 감지, OCR reflow 후 block 재구성 |
| `images` | Markdown 이미지 enrich target 매칭 |
| `warnings` | 변환 경고 전파 |
| `fileType`, `pageCount` | PDF reflow 조건 판단 및 결과 응답 |
| `code` | `IMAGE_BASED_PDF` fallback 판단 |

구현상 `kordoc.parse()`가 입력 `arrayBuffer`를 detach할 수 있어서, OCR fallback/reflow용으로 `rawBackup = arrayBuffer.slice(0)`를 먼저 만들어 둔다.

PDF이고 `blocks`가 있으면 reflow 감지 전에 `collectInvisibleText()` / `stripInvisibleFromBlocks()`를 실행한다.
이 단계는 PDF 텍스트 레이어에는 있지만 실제 렌더에서는 보이지 않는 흰색 글자 등을 제거한다.
단순히 글자색만 보지 않고 mupdf 렌더 픽셀의 어두운 배경 비율을 같이 확인해, 어두운 막대 위 흰색 차트 라벨처럼 실제로 보이는 텍스트는 보존한다.

### [2] OCR fallback

스캔본 PDF 전체를 처리하는 경로다.

```text
ocrPdfBuffer
  -> openPdfRenderer
  -> 페이지별 renderPage
  -> ocrPageAdaptive
  -> vllmOcrPageStrict
  -> aiComplete
```

특징:

- mupdf로 페이지를 PNG로 렌더링한다.
- `VLLM_OCR_CONCURRENCY` 한도 내에서 페이지별 OCR을 수행한다.
- OCR context overflow가 발생하면 렌더 배율을 낮춰 재시도한다.
- AI 응답이 `max_tokens`에서 잘렸다고 판단되면 `AI_MAX_TOKENS_CAP`까지 토큰 한도를 늘려 재시도한다.
- 빈 OCR 결과 페이지는 제외한다.
- 결과는 `## 페이지 N` 섹션과 `---` 구분선으로 합친다.

### [3] 선택 reflow

문제 페이지를 감지한 뒤 해당 페이지 OCR 결과로 기존 block을 교체한다.

```text
collectInvisibleText / stripInvisibleFromBlocks
  -> detectMangledPages / detectSpreadPages / pageQuality.needsOcr
  -> expectedTables 산정
  -> ocrSelectedPdfPages
  -> hasBrokenTable / 표 개수 검증
  -> 필요 시 표 전용 retry
  -> 깨진 OCR 표는 kordoc 원본 유지
  -> reflowBlocksWithOcr
  -> blocksToMarkdown
```

`reflowBlocksWithOcr()`는 OCR Markdown을 빈 줄 기준으로 나눠 paragraph block 여러 개로 넣는다.
최종 Markdown은 자연스럽게 이어지지만, 이후 RAG 청킹 같은 block 소비자는 페이지 통짜 텍스트보다 더 작은 단위를 얻을 수 있다.

### [4] 후처리

`postprocessMarkdown()`는 AI 호출 없이 문자열을 정리한다.

- OCR 후보정 사전 적용
- 합자 잔재 복원
- PDF 텍스트 레이어의 `㎡` 위첨자 추출 순서 보정
- 알려진 과분할 표를 결정론적으로 정규화
- 빈 대괄호 잔재 제거
- 단독 페이지 번호 줄 제거
- 반복 머리말/꼬리말 제거
- 번호형 heading 정규화
- `Figure/Fig/Table/그림/표` 캡션을 인용 블록으로 강조
- 페이지 경계로 끊긴 동일 머리글 파이프 표 병합
- 과도한 빈 줄 축소

반복 머리말/꼬리말 제거의 예외:

- `(단위: 천원)`처럼 표 단위 표기는 반복돼도 본문 정보로 보존한다.
- `(일부개정) 2011-01-10 조례 제 4126호`처럼 조례 제·개정 이력은 숫자만 바뀌는 짧은 반복 줄이어도 본문으로 보존한다.

알려진 과분할 표 정규화 예:

- `어린이집 보육료 및 가정양육 지원`
- `처우개선비 지원`

이런 표는 kordoc이 병합 구조를 HTML로 보존했지만 열을 과도하게 쪼갠 경우, 원문에서 검증한 의미 단위 HTML 표로 바꾼다.

### [5] enrich

`enrichMarkdown()`는 먼저 target을 찾는다.
target이 0개면 바로 반환하고 AI 호출은 발생하지 않는다.

실패 처리:

- target 하나가 실패해도 전체 변환은 계속 진행한다.
- 실패 target은 warning 로그와 `failed` 통계로 남는다.
- `/api/convert` 응답에는 enrich 통계가 직접 포함되지 않는다.
- `/review` 결과에는 전체 `aiCalls`, `aiFailures`가 저장된다.

---

## 6. AI 호출 경로 한눈에 보기

| 단계 | 함수 | 호출 함수 | 호출 수 |
|---|---|---|---|
| 이미지 파일 OCR | `ocrImageBuffer` | `aiComplete` | 이미지 1회 |
| 스캔본 PDF 전체 OCR | `ocrPdfBuffer` -> `ocrPageAdaptive` | `aiComplete` | PDF 페이지 수만큼 |
| 선택 reflow OCR | `ocrSelectedPdfPages` | `aiComplete` | 일반 페이지 1회, 펼침면 페이지 2회, 표 깨짐 retry 시 추가 호출 |
| 이미지 enrich | `enrichMarkdown` -> `analyzeTarget(image)` | `aiComplete` | 이미지 target 수만큼 |
| 표 enrich | `analyzeTarget(table)` | `aiComplete` | 표 target 수만큼, `VLLM_TABLE_ANALYSIS=1`일 때만 |
| page visual enrich | `analyzeTarget(page-visual)` | `aiComplete` | 스캔본/이미지 OCR 시 차트·그림 단서 페이지 수만큼(전사는 OCR, 해설은 enrich 분담) |
| provider 사전 점검 | `aiPing` | `aiComplete` 또는 provider `complete` | 점검 provider/model마다 1회 |

AI 호출 실패 처리:

| 경로 | 실패 시 처리 |
|---|---|
| 이미지 파일 OCR | 변환 실패 |
| 스캔본 PDF 페이지 OCR | 해당 페이지 빈 결과 처리, 문서 전체는 계속 |
| 선택 reflow OCR | 호출 실패 또는 표 깨짐 지속 시 kordoc 원본이 있으면 원본 유지 |
| enrich | 실패 target만 건너뛰고 변환 계속 |
| `/api/eval/check` | 해당 provider/model 실행 전 실패로 표시 |

---

## 7. `/review` 검수 파이프라인

### 7.1 파일 준비

```text
사용자 파일 선택/업로드
  -> /api/eval/upload
  -> tests/file 또는 EVAL_CORPUS_DIR에 저장
  -> /api/eval/files 목록 갱신
```

파일 목록 초기화:

```text
/api/eval/files/clear
  -> corpus 파일 삭제
  -> golden/result cache도 함께 정리
```

캐시만 초기화:

```text
/api/eval/cache/clear
  -> tests/_golden 삭제
  -> tests/_eval 삭제
  -> review-server.log는 보존
```

### 7.2 Golden 패널

현재 기본 Golden은 변환된 텍스트가 아니라 원본 파일 뷰어다.

| 원본 형식 | Golden 표시 |
|---|---|
| PDF | PDF viewer |
| 이미지 | 이미지 그대로 표시 |
| TXT/MD | 원문 텍스트 |
| 기타 문서 | 파일 링크 |

Golden Markdown을 사람이 별도로 저장한 경우에만 자동 metrics 계산 대상이 된다.
기본 원본 뷰어 상태는 `scorable:false`라 자동 정확도 점수 계산에서 제외된다.

### 7.3 모델 실행

```text
선택 파일들
  x
선택 provider/model들
  -> /api/eval/batch
  -> 파일별/모델별 runEval 반복
  -> runConvert 실행
  -> 결과 JSON 저장
```

각 결과에는 다음 값이 저장된다.

| 값 | 의미 |
|---|---|
| `file` | 원본 파일명 |
| `provider` | 실행 provider 또는 `bedrock:<key>` |
| `docType` | 문서 유형 |
| `createdAt` | 실행 시각 |
| `ok` | 성공 여부 |
| `elapsedMs` | 소요 시간 |
| `aiCalls` | 변환 중 실제 AI 호출 횟수 |
| `aiFailures` | AI 호출 실패 횟수 |
| `markdown` | 변환된 Markdown |
| `metadata`, `pageCount` | 변환 메타데이터 |
| `quality` | Markdown 자체 품질 검사 결과 |
| `metrics` | scorable Golden이 있을 때 자동 비교 점수 |

### 7.4 Bedrock 다중 모델 실행

검수 UI에서 `bedrock`을 선택하면 서버가 허용한 Bedrock 모델 목록 중 체크된 모델을 `bedrock:<key>` provider로 확장한다.

현재 고정 모델 목록:

| key | label | vision |
|---|---|---|
| `claude-3-haiku` | Claude 3 Haiku | 가능 |
| `claude-3-5-haiku` | Claude 3.5 Haiku | 텍스트 전용 |
| `claude-3-5-sonnet` | Claude 3.5 Sonnet v2 | 가능 |
| `claude-3-7-sonnet` | Claude 3.7 Sonnet | 가능 |
| `nova-micro` | Nova Micro | 텍스트 전용 |
| `nova-lite` | Nova Lite | 가능 |
| `nova-pro` | Nova Pro | 가능 |
| `llama-3-1-8b` | Llama 3.1 8B | 텍스트 전용 |
| `llama-3-3-70b` | Llama 3.3 70B | 텍스트 전용 |

서버는 `BEDROCK_REGION` 또는 `AWS_REGION` 기준으로 해당 리전에서 쓸 수 있는 inference profile ID를 고른다.
리전에서 제공되지 않는 모델은 UI에서 비활성화되거나 `/api/eval/check` 단계에서 실패한다.

주의:

- `vision:false` 모델은 이미지 입력이 필요한 OCR/reflow/image enrich에서 실패할 수 있다.
- 텍스트 레이어가 정상인 일반 문서는 AI 호출이 0일 수 있으므로 vision 모델이 아니어도 결과가 나올 수 있다.
- 이미지 OCR, 스캔본 PDF OCR, 선택 reflow가 필요한 문서는 vision 지원 모델을 써야 한다.

### 7.5 결과 확인과 추출

```text
결과 선택
  -> Golden 원본과 변환 Markdown 나란히 확인
  -> Diff/metrics/quality 확인
  -> 사람이 정확도 점수와 오류 유형 저장
  -> 필요 시 result.md 다운로드
  -> CSV export
```

---

## 8. 주요 설정값

| 변수 | 기본 | 의미 |
|---|---:|---|
| `AI_PROVIDER` | `vllm` | 기본 AI provider |
| `AI_TIMEOUT_MS` | `60000` | 일반 AI 호출 타임아웃 |
| `AI_RETRY` | `1` | 재시도 횟수 |
| `AI_MAX_TOKENS_CAP` | `8192` | 잘림 재시도 시 max token 상한 |
| `VLLM_URL` | 빈 값 | vLLM/OpenAI 호환 endpoint |
| `VLLM_MODEL` | `qwen` | vLLM 모델명 |
| `VLLM_DISABLED` | `0` 취급 | `1`이면 vLLM 비활성 |
| `VLLM_THINKING` | `0` 취급 | vLLM `enable_thinking` |
| `VLLM_CONCURRENCY` | `3` | enrich 동시성 |
| `VLLM_OCR_CONCURRENCY` | `3` | OCR 동시성 |
| `VLLM_OCR_TIMEOUT_MS` | `240000` | OCR 1건 타임아웃 |
| `VLLM_OCR_RENDER_SCALE` | `2` | PDF 렌더 배율 |
| `VLLM_OCR_MAX_LONG_SIDE` | `2200` | 렌더 이미지 긴 변 상한 |
| `VLLM_SPREAD_SPLIT` | on | `0`이면 펼침면 분할 감지/처리 비활성 |
| `VLLM_TABLE_ANALYSIS` | off | `1`이면 Markdown 표 enrich 활성 |
| `VLLM_PAGE_VISUAL` | on | `0`이면 page visual enrich 비활성 |
| `VLLM_PAGE_VISUAL_MAX_KB` | `4000` | page visual 이미지 크기 상한 |
| `BEDROCK_REGION` / `AWS_REGION` | `us-east-1` fallback | Bedrock 호출 리전 |
| `BEDROCK_MODEL` | Claude 3.5 Sonnet v2 fallback | 단일 Bedrock 기본 모델 |
| `BEDROCK_PROFILE` / `AWS_PROFILE` | 빈 값 | AWS profile 인증 |
| `BEDROCK_ACCESS_KEY_ID` / `AWS_ACCESS_KEY_ID` | 빈 값 | 명시 AWS access key |
| `BEDROCK_SECRET_ACCESS_KEY` / `AWS_SECRET_ACCESS_KEY` | 빈 값 | 명시 AWS secret key |
| `CLAUDE_CLI_MODEL` | `sonnet` | Claude CLI 기본 모델 |
| `CODEX_MODEL` | 빈 값 | Codex CLI 모델, 빈 값이면 CLI 기본 설정 사용 |

참고:

- `server/vllm.js`라는 파일명은 legacy 성격이 강하다.
- 실제 모델 호출은 `server/ai.js`의 provider 추상화를 거친다.
- 그래서 같은 OCR/enrich 경로를 vLLM, Gemini, Bedrock, Claude CLI, Codex CLI 등으로 실행할 수 있다.

---

## 9. 최종 출력

### 9.1 `/api/convert` 성공

```jsonc
{
  "ok": true,
  "markdown": "# 제목\n\n본문...",
  "metadata": {
    "pageCount": 12
  },
  "pageCount": 12,
  "elapsedMs": 1234
}
```

### 9.2 `/api/convert` 실패

```jsonc
{
  "ok": false,
  "error": "에러 메시지",
  "code": "AI_REQUIRED",
  "elapsedMs": 1234
}
```

### 9.3 `/review` 결과

`/review`의 결과 JSON은 내부 저장용이라 Markdown 본문까지 포함한다.
목록 API에서는 응답 크기를 줄이기 위해 `markdown`을 제외한 메타데이터만 내려준다.

```jsonc
{
  "id": "2026-06-11T00-00-00-000Z__vllm__sample",
  "file": "sample.pdf",
  "provider": "vllm",
  "docType": "pdf-single",
  "ok": true,
  "elapsedMs": 1234,
  "aiCalls": 2,
  "aiFailures": 0,
  "pageCount": 12,
  "quality": {},
  "metrics": null
}
```

---

## 10. 운영 판단 기준

AI 없이 충분한 경우:

- 텍스트 PDF, DOCX, HWPX, XLSX처럼 구조 텍스트가 잘 추출되는 문서
- 차트/이미지 설명이 꼭 필요하지 않은 변환
- 속도와 비용이 우선인 대량 변환
- `/review`에서 원본만 Golden으로 띄워 육안 검수하는 경우

AI를 켜야 하는 경우:

- 이미지 파일을 Markdown으로 옮겨야 하는 경우
- 스캔본 PDF 또는 텍스트 레이어 없는 PDF
- PDF 안의 2단 컬럼, 펼침면, 포켓북, 통계표, 한국어 띄어쓰기 소실이 자주 보이는 경우
- 문서 내 그림/차트/스크린샷 설명까지 Markdown에 넣어야 하는 경우
- Bedrock/Gemini/Claude/Codex/vLLM 모델별 OCR 품질을 비교해야 하는 경우

현재 설계상 권장 경로는 **항상 kordoc으로 먼저 빠르게 파싱하고, 필요한 페이지만 AI로 보정**하는 방식이다.
