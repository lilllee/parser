# Postprocess 전체 레퍼런스 (Paddle 서버 `postprocess.py` 정합용)

> 목적: 우리 프로젝트(parser_web_ui)에 적용되는 **모든 postprocess + 숫자 재검증** 로직을 한 곳에 정리.
> Paddle API 클라이언트 서버(`paddleocr-vl-client/webui/postprocess.py`)가 Qwen 재검증 등을 우리와
> 비슷하게 맞출 수 있도록 — 특히 **§4 숫자 교차검증**과 **§5 보정 accept/rollback**이 정합 핵심.
> 출처 코드: `server/postprocess.js`, `server/config/corrections.js`, `server/vllm.js`(숫자 게이트/보정),
> `server/config/prompt.js`(보정 프롬프트). 최신은 코드 기준(이 문서는 스냅샷).

---

## 0. 두 계층 + 적용 지점

| 계층 | 함수 | 적용 시점 |
|---|---|---|
| **A. 결정론적 문자열 후처리** | `postprocessMarkdown(md)` | kordoc/OCR/reflow 산출 md → **enrich 직전** 1회 |
| **B. 숫자 교차검증/보정** | `comparePageNumbers` + repair 루프/게이트 | reflow·force_ocr 중 (**Qwen 재검증 = 이 계층**) |
| (보조) enrich 출력 정리 | `formatInsertion` | LLM 해설 삽입 시 |
| (보조) 표 포맷 변환 | `markdownTablesToHtml` | 출력 포맷=html 일 때 |

핵심 철학: **kordoc 텍스트레이어 숫자 = ground-truth.** dense 표의 '구조'는 깨도 '숫자'는 정확하므로,
vision/Paddle 산출물의 숫자를 kordoc 숫자와 대조해 채택/폐기/보정한다.

---

## 1. `postprocessMarkdown(md)` — 결정론적 후처리 파이프라인 (실행 순서 고정)

순서가 중요(아래 주의 참조). 각 단계:

| # | 단계 | 동작 |
|---|---|---|
| 1 | `applyOcrCorrections` | OCR 오인식 사전 치환(§2). **맨 앞** — 이후 단계가 교정된 텍스트를 보게 |
| 2 | 합자(ligature) 복원 | `([A-Za-z])\s+(ffl\|ffi\|ff)\s+([A-Za-z])` → 붙임 (`e ffi cient`→`efficient`) |
| 3 | `normalizeSquareMeter` | `2<br>450m`/`450m2`/`450m²` → `450㎡` (㎡ 위첨자 추출 순서 보정) |
| 4 | `normalizeStrayGlyphsAndBullets` | 전보기호 `㋀-㋿`,`㍘-㍰` 제거 + 줄머리 `•●◦∙` → `- `. (`·` 가운뎃점은 한국어 나열구분자라 **보존**) |
| 5 | `normalizeKnownOversplitTables` | 알려진 과분할 표 2개(어린이집 보육료·처우개선비)를 **검증된 HTML 표로 하드 치환** |
| 6 | `liftSectionHeadingTables` | `\| Ⅰ \| \| 제목 \|` + 구분행(데이터 없는 2줄 표) → `## Ⅰ. 제목` 승격 |
| 7 | 빈 대괄호 제거 | `^(\[\])+[A-Za-z]?$` 라인 삭제 |
| 8 | `stripLonePageNumbers` | **고립된** 1~4자리 단독 숫자줄만 페이지번호로 제거. ±2줄 내 다른 숫자줄 있으면 군집(=데이터)로 **보존** |
| 9 | `removeRunningHeadersFooters` | 짧은(≤40자) 단독줄을 숫자/강조/구두점 제거해 정규화 후 **2회+ 반복 = 러닝헤더/푸터** 삭제. 예외: `(단위:…)`, 조례 제·개정 이력 |
| 10 | `normalizeHeadings` | `N`/`N.M` 번호 섹션 → 깊이맞춤 `##`/`###`. 본문오인 헤딩(>80자·`.,;`끝·소문자시작) → 문단 강등 |
| 11 | 캡션 강조 (3패턴) | `Figure\|Fig.\|Table\|그림\|표 N…` → `> **캡션**` (탭분리/4+공백분리/단독라인) |
| 12 | `mergeAdjacentPipeTables` | 페이지 경계로 끊긴 **머리글 byte-동일** 파이프표 병합(둘째 머리글·구분행·사잇 페이지꼬리말 버림) |
| 13 | `flattenFakeTables` | '가짜 표'(목차/산문을 격자에 욱여넣음)를 평문화(§3 판정) |
| 14 | `reflowSoftWrappedParagraphs` | 음절 중간 끊긴 문단 합치기(앞=한글로 끝+종결어미 아님+길이≥15, 뒤=한/숫자 시작+마커 아님 → 공백없이 직결) |
| 15 | 빈줄 축소 | `\n{3,}`→`\n\n`, 앞뒤 공백 trim |

**순서 주의(의존성):**
- 8(페이지번호 제거)·9(러닝헤더 제거)는 **13(flattenFakeTables) 앞**에 둔다. 먼저 펴면 목차의 짧은 줄(항목·페이지번호)이 8·9에서 삭제돼 내용 누락.
- 1(사전치환)은 맨 앞.

---

## 2. OCR 오인식 후보정 사전 (`config/corrections.js`)

- 방식: **전체 용어 단위 literal 치환**(단일 글자 금지 — 바른 단어 깨짐 방지). 비-단어 오인식만 등록(고신뢰).
- 빌트인:
  ```
  정보공개정구 → 정보공개청구   (청구↔정구)
  성분찰설     → 성본창설
  응아전담/응야전담 → 영아전담
  근거당       → 근저당
  ```
- 확장: env `VLLM_OCR_CORRECTIONS` 에 JSON `{"틀림":"맞음",...}` → 빌트인에 병합.
- **Paddle 서버 정합 팁:** Paddle-VL 오인식 패턴은 vision 모델과 다를 수 있으니, 같은 "비-단어 전체용어" 원칙으로 별도 사전을 쌓되 단일 글자 치환은 금지.

---

## 3. 표 결함 감지기 (라우팅 신호 — vision/Paddle 재추출 대상 선별)

후처리는 아니지만 같은 모듈. "이 표를 LLM 재검증/재추출할까" 판단에 쓰임:

| 함수 | 잡는 결함 |
|---|---|
| `hasBrokenTable` (vllm.js) | 형식 깨짐: 파이프표 칸수 불일치, `rowspan/colspan` 텍스트 누출, HTML 표 유효열수 불일치, 빈 `<th>`로 병합헤더 때움 |
| `hasCrammedTable` | 셀≤6개에 `<br>`≥8 (목차/문단을 몇 셀에 욱여넣음 — 정렬 복구 불가) |
| `looksLikeTocTable` | 데이터행 절반↑이 `N-N\|제N장 … 페이지번호` 패턴(목차가 표로 떠짐) |
| `hasSentenceStuffedTable` | 셀에 문장(증감 종결어·`…명으로`) 또는 `[그림 N]·[표 N]` 캡션이 박힘(형식 멀쩡·의미 깨짐) |
| `hasDuplicatedColumns` | 좌우 비교표에서 긴(≥20자) 동일내용이 인접 두 열에 2행+ 복제(한 열만 읽어 복제한 실패) |

> 우리 파이프라인은 이 신호가 뜨면 그 페이지를 vision/Paddle 재추출로 라우팅한다(`detectMangledPages`/reflow 게이트).
> **표는 HTML `<table>`(colspan/rowspan) 표준** — markdown 파이프표는 `hasBrokenTable`이 결함으로 본다.

---

## 4. ★ 숫자 교차검증 `comparePageNumbers` (Qwen 재검증의 핵심 알고리즘)

vision/Paddle 산출 텍스트의 숫자를 kordoc 텍스트레이어 숫자(ground-truth)와 대조. **이게 정합 1순위.**

**규칙:**
1. **유의숫자(significant)만 비교** — 페이지번호/리스트마커(1~2자리) 노이즈 배제:
   `유의 = 소수점 포함 OR 콤마 포함 OR (선행0 제거 후) 3자리 이상`
2. 추출 정규식 `\d[\d,]*(?:\.\d+)?` → 콤마 제거(`2,306`→`2306`) → 유의숫자만.
3. 양쪽을 **multiset(값→개수)** 으로.
4. `missing` = kordoc엔 있는데 vision에 부족한 만큼 = **vision 누락/오독**.
5. `extra` = vision엔 있는데 kordoc에 없는 만큼 = vision이 더 완전(kordoc 미추출)이거나 연도 등 = **정보로만**.
6. `ok = (missing 개수 == 0)`. **missing 기준만** — 오독(2,306→2,308)은 `missing[2306]+extra[2308]`로 자동 검출.
7. kordoc 유의숫자 0개(스캔 페이지) → `unverified=true`(검증 근거 없음, ok로 두되 표시).

**Python 의사코드 (postprocess.py 정합용):**
```python
import re
from collections import Counter

def page_numbers(text):
    """유의숫자만 추출(콤마 제거값). 콤마/소수점 판정은 원문(raw) 기준."""
    out = []
    for m in re.finditer(r"\d[\d,]*(?:\.\d+)?", text or ""):
        raw = m.group(0)
        s = raw.replace(",", "")
        if ("." in raw) or ("," in raw) or len(s.lstrip("0")) >= 3:
            out.append(s)
    return out
def compare_page_numbers(kordoc_text, vision_text):
    from collections import Counter
    k, v = Counter(page_numbers(kordoc_text)), Counter(page_numbers(vision_text))
    if sum(k.values()) == 0:
        return dict(kordoc_numbers=0, missing=[], extra=[], ok=True, unverified=True)
    missing = list((k - v).elements())   # kordoc 초과분 = vision 누락/오독
    extra   = list((v - k).elements())   # vision 초과분 = 정보
    return dict(kordoc_numbers=sum(k.values()), missing=missing, extra=extra,
                ok=(len(missing) == 0), unverified=False)
```
> JS 원본은 `s.includes(".") || /,/.test(s) || s.replace(/^0+/,"").length>=3` — 콤마는 **원문(raw)** 기준 판정. 위 파이썬도 raw로 판정해야 동일.

---

## 5. 숫자 보정 루프 (accept/rollback) — "Qwen 재검증" 본체

`comparePageNumbers`로 불일치가 임계 이상이면, **누락 숫자 목록을 콕 집어** vision을 재호출하고
**보수적으로만 채택**한다. (우리: `numericRepairPage` + `acceptNumericRepair`, vllm.js)

**흐름:**
1. `base = compare(kordoc, vision)`. `base.unverified` 또는 `len(base.missing) < MIN_MISMATCH(기본 2)` → 보정 안 함(원본 유지).
2. 최대 `MAX(기본 1)`회: 같은 페이지 이미지를 **보정 프롬프트**로 재호출(아래 §5.1). temperature=0.
3. 재호출 결과가 표 깨짐(`hasBrokenTable`)·반복붕괴(`hasDegenerateRepeat`)면 폐기(rollback).
4. `cmp = compare(kordoc, retry)`. **accept 조건**(아래) 만족 시에만 채택, 아니면 rollback.
5. 보정 적용 시 `NUMERIC_REPAIR` 경고, 실패 시 `NUMERIC_MISMATCH` 경고로 표면화(출력은 유지/폴백).

**★ accept 규칙 (`acceptNumericRepair`) — 환각 방지의 핵심:**
```python
def accept_numeric_repair(prev_missing, prev_extra, cmp):
    miss_drop  = prev_missing - len(cmp["missing"])   # 누락이 줄었나
    extra_rise = len(cmp["extra"]) - prev_extra        # 새 환각(extra)이 늘었나
    return miss_drop > 0 and extra_rise <= miss_drop   # 줄었고, 환각 증가가 감소폭 이내일 때만
```
즉 **missing이 엄격히 줄고, 새로 생긴 extra가 missing 감소폭을 넘지 않을 때만 채택.** 환각으로 숫자를
채워 missing만 줄이고 사실오류(extra)를 늘리는 것을 막는다.

### 5.1 보정 프롬프트 (`pdfOcrNumericRepair`)
재호출 시 system은 그대로, user에 아래를 덧붙임(kordocNumbers = 현재 missing 목록):
```
이전 전사에서 일부 숫자가 누락되거나 오독됐을 가능성이 있다. 이번에는 숫자 정확도를 최우선으로 다시 전사한다.
검증 기준 숫자(같은 페이지 텍스트레이어에서 추출): {목록}
규칙:
- 위 숫자가 페이지에 실제로 보이면, 그 값이 해당 표·문장·위치에 정확히 들어가도록 전사한다.
- 단, 목록에 있어도 페이지에서 보이지 않으면 만들어 넣지 않는다(환각 금지).
- 목록에 없지만 페이지에 보이는 숫자도 그대로 전사한다.
- 글자, 표 구조, 한글 텍스트는 임의로 바꾸지 않는다(숫자만 바로잡는다).
- 출력은 수정된 OCR markdown(표는 HTML <table>)만 한다.
```

### 5.2 env 훅
- `VLLM_OCR_NUMERIC_REPAIR`(기본 on) · `..._MAX`(기본 1) · `..._MIN_MISMATCH`(기본 2).
- decode 비용 큼 → 임계 보수적, 재시도 1회 고정.

---

## 6. Paddle 숫자 게이트 (재시도 없는 채택/폐기) — `paddleReflowPage`

Paddle `/parse` 산출(HTML 표)은 **재호출해도 같으므로 보정 루프 대신 게이트**:
- `cmp = compare(kordoc_gate_text, paddle_md)`.
- `missing >= MIN_MISMATCH(2)` 면 **Paddle 폐기 → kordoc 원본 유지**(`NUMERIC_MISMATCH` 경고).
- ground-truth(kordoc)는 **NOSPACE(무공백 뭉침) 페이지도 포함**(숫자 토큰만 보므로 무해, 가장 검증 필요한 페이지 누락 방지).
> 서버팀 확인: PaddleOCR-VL은 VLM이라 **구조(colspan/rowspan)는 완벽해 보여도 셀 숫자가 틀릴 수 있음** →
> 숫자 게이트가 채택 전 필수.

---

## 7. enrich(LLM 해설) 출력 후처리 — `formatInsertion`

차트/표 해설을 본문에 삽입하기 전 정리:
- `#` 헤딩 마커 평문화, 수평선(`---`/`***`/`___`) 줄 제거, `\n{3,}`→`\n\n`.
- 표(markdown `|…|` 또는 `<table>`) **있으면**: 표는 그대로 보존, 산문 줄만 `> ` 인용.
- 표 **없으면**: 전체를 한 줄 `> ` 인용(공백 정규화).
- 차트 값표 + 추세 해설 분담(전사=OCR/Paddle, 해설=LLM). 축 눈금으로 값 추정 금지.

---

## 8. 표 포맷 변환 `markdownTablesToHtml` (선택, 출력=html 일 때)

markdown 파이프표 → HTML `<table>`(구분행 있으면 첫 데이터행=`<th>`, 없으면 전부 `<td>`). 셀은 `&<>` 이스케이프.
HTML 표/일반 본문은 그대로. (GRITS 등 HTML 표만 인식하는 평가/소비처 대응.)

---

## 9. Paddle 서버 정합 체크리스트

Paddle 클라이언트 `postprocess.py`에서 우리와 맞출 우선순위:
1. **[필수] §4 `compare_page_numbers`** — kordoc(또는 동등 ground-truth) 숫자 대조. 유의숫자 규칙·multiset·missing기준 ok 동일하게.
2. **[필수] §5.1 보정 프롬프트 + §5 accept 규칙** — Qwen 재호출 시 "보이면 포함/안 보이면 환각금지" + `accept = missing↓ AND extra증가 ≤ missing감소`.
3. **[권장] §1 문자열 정리** 중 보편적인 것: 러닝헤더/푸터 제거(2회+ 반복), 고립 페이지번호 제거(군집 보존), 캡션 강조, 빈줄 축소.
4. **[권장] §3 표 결함 신호** — 표를 Qwen 재검증할지 판단(특히 `hasBrokenTable`= 파이프표/칸수불일치, 셀 숫자 게이트).
5. **[주의] 표는 HTML `<table>` 유지**(파이프표로 바꾸지 말 것), 셀 내 줄바꿈 `<br>`.

> 핵심 한 줄: **"숫자는 kordoc/텍스트레이어를 ground-truth로 교차검증하고, LLM 재호출은 '보이는 것만·환각금지' + missing이 실제로 줄 때만 채택"** — 이 규율을 양쪽이 동일하게 가져가면 정합된다.
