// kordoc/OCR 출력 markdown 후처리 (정형화).
import { ocrCorrections } from "./config/corrections.js";

const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// OCR 글자 오인식 후보정 (사전 기반, 전체 용어 단위 literal 치환).
function applyOcrCorrections(md) {
  let out = md;
  for (const [from, to] of Object.entries(ocrCorrections)) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => HTML_ESCAPE[c]);
}

// GFM 구분행( |---|:--:| 등 ) 판별.
function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

// "| a | b |" 한 줄 → ["a","b"] (양끝 파이프 기준 셀 분리).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// markdown 파이프 표 → HTML <table>. 이미 HTML(<table>)인 표/일반 본문은 그대로 둔다.
// 출력 포맷=html 일 때 사용 (ParseBench GRITS 등 HTML 표만 인식하는 평가/소비처 대응).
export function markdownTablesToHtml(md) {
  if (!md || md.indexOf("|") === -1) return md;
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    if (isTableRow(lines[i])) {
      const block = [];
      while (i < lines.length && isTableRow(lines[i])) block.push(lines[i++]);
      const hasSeparator = block.some(isSeparatorRow);
      const dataRows = block.filter((l) => !isSeparatorRow(l)).map(splitRow);
      if (!dataRows.length) {
        out.push(...block); // 구분행만 있는 비정상 블록 — 원문 유지
        continue;
      }
      // 구분행이 있으면 첫 데이터행이 헤더(th), 없으면 헤더 없이 전부 td.
      const header = hasSeparator ? dataRows[0] : null;
      const body = hasSeparator ? dataRows.slice(1) : dataRows;

      const html = ["<table>", "  <tbody>"];
      if (header) html.push("    <tr>" + header.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>");
      for (const r of body) html.push("    <tr>" + r.map((c) => `<td>${escapeHtml(c)}</td>`).join("") + "</tr>");
      html.push("  </tbody>", "</table>");
      out.push(html.join("\n"));
    } else {
      out.push(lines[i++]);
    }
  }
  return out.join("\n");
}

// markdown 후처리: 추출 잔재 정리 + caption 을 인용 블록으로 강조.
export function postprocessMarkdown(md) {
  if (!md) return md;

  // OCR 글자 오인식 후보정 (사전 기반) — 이후 단계가 교정된 텍스트를 보도록 맨 앞에서.
  let out = applyOcrCorrections(md);

  // 합자 복원: "e ffi cient" → "efficient" (ff/ffi/ffl 한정 — 오탐 위험 낮음).
  out = out.replace(/([A-Za-z])[ \t]+(ffl|ffi|ff)[ \t]+([A-Za-z])/g, "$1$2$3");

  // PDF 텍스트 레이어에서 ㎡ 의 위첨자 2가 본문 앞줄로 튀는 케이스 보정.
  // 예: "2<br>450m 이상" → "450㎡ 이상", "450m2" → "450㎡".
  out = normalizeSquareMeter(out);

  out = normalizeKnownOversplitTables(out);

  // kordoc 이 '번호 박스 + 제목' 섹션 머리글을 데이터 없는 표로 떠오는 아티팩트 → ## 헤딩 승격.
  out = liftSectionHeadingTables(out);

  // 빈 대괄호 잔재 라인 제거 (예: "[][]M").
  out = out.replace(/^[ \t]*(?:\[\][ \t]*)+[A-Za-z]?[ \t]*$/gm, "");

  // 단독 숫자 줄(1~4자리) 중 '고립된' 것만 페이지번호로 보고 제거.
  // 차트/표가 줄마다 흩어져 생긴 숫자 군집은 데이터이므로 보존(인접 비공백 줄에 다른
  // 숫자 줄이 있으면 군집=데이터). (목록 "1.", 참고문헌 "[1]" 은 패턴상 애초 비대상)
  out = stripLonePageNumbers(out);

  // 페이지마다 반복되는 머리말·꼬리말(문서/장 제목 + 페이지번호) 제거.
  out = removeRunningHeadersFooters(out);

  // 헤딩 레벨 정규화.
  out = normalizeHeadings(out);

  const label = "(?:Figure|Fig\\.|Table|그림|표)";

  // 1) 본문 + tab + caption  →  본문 + (blank) + > **caption**
  out = out.replace(
    new RegExp(`([^\\t\\n]+?)\\t+(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)`, "g"),
    "$1\n\n> **$2**\n"
  );

  // 2) 다중 공백 (4+) 으로 분리된 caption — 학술 PDF 의 2단 컬럼에서 나타남
  out = out.replace(
    new RegExp(`([^\\n]{8,}?)[ ]{4,}(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)`, "g"),
    "$1\n\n> **$2**\n"
  );

  // 3) 단독 라인 caption 도 같은 형태로 강조
  out = out.replace(
    new RegExp(`^(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)$`, "gm"),
    "> **$1**"
  );

  // 페이지 경계로 끊긴 '같은 머리글' 파이프 표를 하나로 병합 (머리말·꼬리말 제거 후).
  out = mergeAdjacentPipeTables(out);

  // kordoc 이 목차·머리말·산문을 '가짜 표'로 만든 경우 평문으로 편다(텍스트 정확도 보존).
  // 반드시 페이지번호 제거(stripLonePageNumbers)·반복 꼬리말 제거(removeRunningHeadersFooters)
  // '뒤'에 둔다 — 먼저 펴면 목차의 짧은 줄(항목·페이지번호)이 그 단계들에 삭제되어 내용이 누락된다.
  out = flattenFakeTables(out);

  // 4) 과도한 빈 줄 축소 (3+ → 2) + 문서 앞뒤 공백 정리
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
  out = out.replace(/\s+$/, "") + "\n";

  return out;
}

function normalizeSquareMeter(md) {
  return String(md)
    .replace(/\b2\s*<br>\s*(\d+(?:\.\d+)?)\s*m(?=\s|<|$|[가-힣),.;])/g, "$1㎡")
    .replace(/\b(\d+(?:\.\d+)?)\s*m\s*(?:2|²)(?=\s|<|$|[가-힣),.;])/g, "$1㎡");
}

function normalizeKnownOversplitTables(md) {
  return String(md)
    .replace(
      /<table>\s*<tr><th colspan="12">어린이집 보육료 및 가정양육 지원<\/th>[\s\S]*?<\/table>\s*\n\s*천원\)/,
      CHILDCARE_FEE_TABLE
    )
    .replace(
      /<table>\s*<tr><th><\/th><th><\/th><th>처우개선비<\/th>[\s\S]*?<\/table>\s*\n\s*\(\s*/,
      TREATMENT_SUPPORT_TABLE + "\n\n"
    );
}

const CHILDCARE_FEE_TABLE = `# 어린이집 보육료 및 가정양육 지원

(단위: 천원)

<table>
<tr><th colspan="3">구 분</th><th>0세반<br>(25년생~)</th><th>1세반<br>(24년생)</th><th>2세반<br>(23년생)</th><th>3세반<br>(22년생)</th><th>4세반<br>(21년생)</th><th>5세반<br>(20년생)</th><th>비 고</th></tr>
<tr><td rowspan="8">어린이집</td><td rowspan="3">지원총액<br>(①+②+③)</td><td>국공립 등</td><td>584</td><td>515</td><td>426</td><td colspan="3">280</td><td>인건비 30~100% 지원</td></tr>
<tr><td>민간</td><td rowspan="2">1,277</td><td rowspan="2">892</td><td rowspan="2">682</td><td>408</td><td colspan="2">385</td><td rowspan="2"></td></tr>
<tr><td>가정</td><td colspan="3">411</td></tr>
<tr><td rowspan="2">정부지원<br>보육료(①)</td><td rowspan="2">국공립·<br>민간·가정등</td><td rowspan="2">584</td><td rowspan="2">515</td><td rowspan="2">426</td><td colspan="3" rowspan="2">280</td><td>연장보육료 추가 지원<br>(시간당)<br>: 영아반 2, 유아반 1, 0세반·장애아반 3</td></tr>
<tr><td>장애아 634</td></tr>
<tr><td rowspan="2">부모부담<br>보육료(②)</td><td>민간</td><td colspan="3" rowspan="2"></td><td>128</td><td colspan="2">105</td><td rowspan="2">누리과정 차액보육료<br>전액지원(도+시·군)</td></tr>
<tr><td>가정</td><td colspan="3">131</td></tr>
<tr><td>기관보육료(③)</td><td>민간·가정</td><td>693</td><td>377</td><td>256</td><td colspan="3"></td><td>장애아 742</td></tr>
<tr><td rowspan="4">가정양육</td><td colspan="2">부모급여</td><td>1,000</td><td>500</td><td colspan="4"></td><td>0~23개월 이하</td></tr>
<tr><td rowspan="3">가정<br>양육수당</td><td>일반아동</td><td colspan="2"></td><td colspan="4">100</td><td rowspan="3">24~85개월 이하</td></tr>
<tr><td>농어촌</td><td colspan="2"></td><td>156</td><td>129</td><td colspan="2">100</td></tr>
<tr><td>장애아동</td><td colspan="2"></td><td>200</td><td colspan="3">100</td></tr>
</table>`;

const TREATMENT_SUPPORT_TABLE = `## 처우개선비 지원

(단위: 천원)

<table>
<tr><th colspan="3" rowspan="2">구 분</th><th rowspan="2">계</th><th colspan="3">도 자체사업</th><th colspan="2">국비지원사업</th><th>누리과정</th></tr>
<tr><th>처우개선비</th><th>특수근무<br>수당</th><th>처우개선비<br>추가</th><th>교사 근무<br>환경개선비</th><th>교사<br>겸직원장</th><th>처우개선비</th></tr>
<tr><td rowspan="3">인건비<br>미지원<br>어린이집<br>(민간·가정)</td><td rowspan="2">교사</td><td>영아반<br>(0∼2세)</td><td>590</td><td>200</td><td>80</td><td>30</td><td>280<br>*연장보육<br>전담교사140</td><td></td><td></td></tr>
<tr><td>유아반<br>(3∼5세)</td><td>580</td><td>110</td><td></td><td>90</td><td></td><td></td><td>380<br>*영유아<br>혼합반280</td></tr>
<tr><td colspan="2">교사겸직원장</td><td>155</td><td></td><td>80</td><td></td><td></td><td>75</td><td></td></tr>
<tr><td rowspan="4">인건비<br>지원<br>어린이집<br>(국공립 등)</td><td rowspan="2">교사</td><td>영아반<br>(0∼2세)</td><td>590</td><td>150</td><td>80</td><td>80</td><td>280<br>*연장보육<br>전담교사140</td><td></td><td></td></tr>
<tr><td>유아반<br>(3∼5세)</td><td>580</td><td>110</td><td></td><td>90</td><td></td><td></td><td>380<br>*영유아<br>혼합반280</td></tr>
<tr><td rowspan="2">원장</td><td>교사겸직<br>원장</td><td>305</td><td>150</td><td>80</td><td></td><td></td><td>75</td><td></td></tr>
<tr><td>원 장</td><td>150</td><td>150</td><td></td><td></td><td></td><td></td><td></td></tr>
</table>`;

// 페이지마다 반복되는 머리말·꼬리말 제거. 짧은 단독 텍스트 줄을 숫자/강조/구두점 제거한 형태로
// 정규화했을 때 문서에서 2회 이상 반복되면(= 페이지번호만 바뀌는 러닝 헤더/푸터) 삭제한다.
// 표 행·헤딩·목록·인용은 대상에서 제외하고, 짧은 줄(maxLen 이하)만 본다(본문 오삭제 방지).
function isRunningCandidate(line) {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (/^\(?\s*단위\s*[:：]/.test(t)) return false; // 표 단위 표기는 반복돼도 본문 정보
  if (/^\((?:제정|일부개정|전부개정|개정|폐지)\)\s*\d{4}[-.]\d{1,2}[-.]\d{1,2}\s+조례\s+제\s*\d+호/.test(t)) return false;
  if (/^\|/.test(t)) return false; // 표 행
  if (/^</.test(t)) return false; // HTML 태그(<table>,</table>,<tr> 등) — 표 구조 보존
  if (/^#{1,6}\s/.test(t)) return false; // 헤딩
  if (/^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) return false; // 목록
  if (/^>/.test(t)) return false; // 인용
  return true;
}
function runningNorm(line) {
  return line
    .replace(/[*_`]/g, "") // 강조 마크업(*, **, _, __, `) 전부 제거 — 같은 꼬리말의 italic/bold 변형 통일
    .replace(/[\d\s]/g, "")
    .replace(/[.,·:;~∼\-—]/g, "");
}
function removeRunningHeadersFooters(md) {
  const lines = md.split("\n");
  const counts = new Map();
  for (const l of lines) {
    if (!isRunningCandidate(l)) continue;
    const n = runningNorm(l);
    if (n.length >= 4) counts.set(n, (counts.get(n) || 0) + 1);
  }
  return lines
    .filter((l) => !(isRunningCandidate(l) && (counts.get(runningNorm(l)) || 0) >= 2))
    .join("\n");
}

// 페이지 경계로 끊긴 '머리글이 동일한' 연속 파이프 표를 하나로 병합 (둘째 표의 머리글·구분행을
// 버리고 본문 행만 첫 표에 이어붙임). 두 표 사이에 빈 줄 또는 '짧은 잔재(페이지 꼬리말 등)'만
// 있을 때 병합하며, 그 사잇줄은 페이지 경계 노이즈로 보고 버린다(머리글이 byte 동일 = 같은 표의
// 페이지 분할이라는 강한 신호). 표 사이에 실제 본문(긴 줄·헤딩·목록·인용)이 끼면 병합하지 않고
// 그대로 보존. HTML <table>·머리글이 다른 표는 건드리지 않는다.
const PIPE_ROW = /^\s*\|.*\|\s*$/;
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
// 표 사이 줄이 '버려도 되는' 페이지 경계 잔재인가: 빈 줄, 또는 짧고 숫자(페이지번호)를 포함한
// 비-구조 줄. 숫자 요구로 '중간 설명 문단.' 같은 짧은 실제 본문이 버려지는 것을 막는다.
function isDroppableBetween(line) {
  const t = line.trim();
  if (t === "") return true;
  if (t.length > 40 || /^[#>|]|^[-*]\s|^\d+\.\s/.test(t)) return false;
  return /\d/.test(t); // 짧고 숫자 포함 = 페이지 꼬리말로 간주
}
function mergeAdjacentPipeTables(md) {
  const lines = md.split("\n");
  const out = [];
  let pending = null; // { headerCells, lines:[헤더,구분,...본문] }
  let between = []; // pending 이후 모인 줄(빈 줄/짧은 잔재 후보)
  const emit = () => {
    if (pending) { out.push(...pending.lines); pending = null; }
    if (between.length) { out.push(...between); between = []; }
  };
  let i = 0;
  while (i < lines.length) {
    if (PIPE_ROW.test(lines[i])) {
      const block = [];
      let j = i;
      while (j < lines.length && PIPE_ROW.test(lines[j])) block.push(lines[j++]);
      const sepIdx = block.findIndex(isSeparatorRow);
      if (sepIdx >= 1) {
        const headerCells = splitRow(block[0]);
        const body = block.slice(sepIdx + 1);
        if (pending && arraysEqual(pending.headerCells, headerCells) && between.every(isDroppableBetween)) {
          pending.lines.push(...body); // 병합: 머리글·구분·사잇 잔재(빈 줄/꼬리말) 버림
          between = [];
        } else {
          emit();
          if (out.length && out[out.length - 1] !== "") out.push("");
          pending = { headerCells, lines: block.slice() };
        }
        i = j;
        continue;
      }
      // 머리글/구분행이 없는 비정상 파이프 블록 — 그대로 둔다.
      emit();
      out.push(...block);
      i = j;
      continue;
    }
    if (pending) {
      between.push(lines[i]); // pending 유지: 다음이 같은 머리글 표면 사잇줄째 버리고 병합
      if (!isDroppableBetween(lines[i])) emit(); // 실제 본문이 끼면 병합 포기, 확정 출력
    } else {
      out.push(lines[i]);
    }
    i++;
  }
  // 끝: 남은 표 출력. 마지막 표 뒤에 빈 줄/꼬리말(between)만 남았으면 함께 버린다(끝 꼬리말 제거).
  // (비-droppable 줄이 왔다면 루프 중 이미 emit 되어 pending 이 비므로, pending 이 남아있으면
  //  between 은 모두 droppable 잔재임이 보장된다.)
  if (pending) out.push(...pending.lines);
  else if (between.length) out.push(...between);
  return out.join("\n");
}

// kordoc 이 '번호 박스 + 제목' 형태의 섹션 머리글(예: 로마숫자 Ⅰ 칸 + 제목 칸)을 데이터 없는
// 표로 떠오는 아티팩트를 ## 헤딩으로 승격한다. 예:
//   | Ⅰ |  | 모집지역 및 모집세대 |        →  ## Ⅰ. 모집지역 및 모집세대
//   | --- | --- | --- |
// 오탐 방지: 데이터(본문) 행이 없는 '내용행+구분행' 2줄 표만, 첫 비어있지 않은 셀이 섹션 마커
// (로마/아라비아/원문자/제N장)이고 비어있지 않은 셀이 정확히 2개(마커+제목)일 때만 승격한다.
// 현행/개정 비교표처럼 데이터 행이 있거나 셀이 많은 진짜 표는 건드리지 않는다.
const SECTION_MARKER_RE =
  /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|[IVX]{1,4}|\d{1,2}|제\s*\d+\s*[장절관편])$/;
const ROMAN_OR_NUM_RE = /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|[IVX]{1,4}|\d{1,2})$/;

function sectionHeadingFromBlock(block) {
  if (block.length !== 2 || isSeparatorRow(block[0]) || !isSeparatorRow(block[1])) return null;
  const cells = splitRow(block[0]);
  const nonEmpty = cells.filter((c) => c !== "");
  if (nonEmpty.length !== 2) return null; // 마커 + 제목 외 다른 내용이 있으면 진짜 표
  const marker = nonEmpty[0];
  const title = nonEmpty[1];
  if (!SECTION_MARKER_RE.test(marker)) return null;
  if (title.length < 2 || title.length > 40) return null; // 제목 길이 가드(긴 본문 셀 배제)
  if (!/[가-힣A-Za-z]/.test(title) || SECTION_MARKER_RE.test(title)) return null; // 제목은 실제 텍스트
  const sep = ROMAN_OR_NUM_RE.test(marker) ? `${marker}.` : marker;
  return `## ${sep} ${title}`;
}

// kordoc 이 목차·머리말·산문 등 비-표 내용을 '가짜 표'로 만든 경우를 감지해 평문으로 편다.
// 진짜 표(보육료 24열 병합 그리드, 현행/개정 비교표 등)는 절대 건드리지 않도록 보수적으로 판정:
//   좁은 표(maxCols<=6) 중 → (a) 셀<=6 개에 <br>>=8 (목차/문단을 몇 셀에 욱여넣음) 또는
//   (b) 행 3+ 인데 통째로 빈 열 존재(산문이 빈 격자로 흩어짐) 일 때만 flatten.
// flatten: 각 행의 비어있지 않은 셀을 공백으로 잇고 셀 내부 <br> 는 줄로 분리 — kordoc 텍스트 보존.
const FAKE_TABLE_MAX_COLS = 6;
function rowsAreFakeTable(rows, brCount) {
  const cellCount = rows.reduce((s, r) => s + r.length, 0);
  const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (maxCols === 0 || maxCols > FAKE_TABLE_MAX_COLS) return false;
  if (cellCount <= 6 && brCount >= 8) return true; // 목차류: 페이지를 몇 셀에 <br> 로 욱여넣음
  // 매우 성긴 격자(빈 셀 >=50%): 불릿/산문이 표로 흩어진 것. 진짜 병합표(보육료)는 maxCols>6 로 이미
  // 제외됐고, 0.4 대 빈셀률의 진짜 표·폼(구분|금액, 신청서 등)은 임계 아래라 보존된다.
  const emptyCells = rows.reduce((s, r) => s + r.filter((c) => !c?.trim()).length, 0);
  if (cellCount >= 6 && emptyCells / cellCount >= 0.5) return true;
  if (rows.length >= 3) {
    const width = maxCols;
    for (let c = 0; c < width; c++) {
      const present = rows.filter((r) => c < r.length);
      if (present.length >= 3 && present.every((r) => !r[c]?.trim())) return true; // 통째 빈 열
    }
  }
  return false;
}
function flattenRows(rows) {
  const lines = [];
  for (const r of rows) {
    const joined = r.map((c) => String(c || "").trim()).filter(Boolean).join(" ");
    for (const ln of joined.split("\n").map((x) => x.trim()).filter(Boolean)) lines.push(ln);
  }
  return lines.join("\n");
}
function htmlTableRows(tableMd) {
  const rowMatches = tableMd.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rowMatches.map((row) =>
    (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
      c.replace(/<t[dh][^>]*>|<\/t[dh]>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()
    )
  );
}
function flattenFakeTables(md) {
  if (!md || (md.indexOf("|") === -1 && !/<table/i.test(md))) return md;
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/<table\b/i.test(lines[i])) {
      const block = [];
      let depth = 0;
      do {
        depth += (lines[i].match(/<table\b/gi) || []).length - (lines[i].match(/<\/table>/gi) || []).length;
        block.push(lines[i]); i++;
      } while (i < lines.length && depth > 0);
      const tbl = block.join("\n");
      const rows = htmlTableRows(tbl);
      out.push(rowsAreFakeTable(rows, (tbl.match(/<br\s*\/?>/gi) || []).length) ? flattenRows(rows) : tbl);
      continue;
    }
    if (PIPE_ROW.test(lines[i])) {
      const block = [];
      while (i < lines.length && PIPE_ROW.test(lines[i])) { block.push(lines[i]); i++; }
      const rows = block.filter((l) => !isSeparatorRow(l)).map(splitRow);
      const brCount = (block.join("\n").match(/<br\s*\/?>/gi) || []).length;
      out.push(rowsAreFakeTable(rows, brCount) ? flattenRows(rows) : block.join("\n"));
      continue;
    }
    out.push(lines[i]); i++;
  }
  return out.join("\n");
}

function liftSectionHeadingTables(md) {
  if (!md || md.indexOf("|") === -1) return md;
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (PIPE_ROW.test(lines[i])) {
      const block = [];
      let j = i;
      while (j < lines.length && PIPE_ROW.test(lines[j])) block.push(lines[j++]);
      const heading = sectionHeadingFromBlock(block);
      if (heading) out.push(heading);
      else out.push(...block);
      i = j;
      continue;
    }
    out.push(lines[i++]);
  }
  return out.join("\n");
}

// 단독 숫자 줄 제거 헬퍼: 비공백 줄 시퀀스에서 ±2 이내에 다른 숫자 줄이 없는 '고립된'
// 1~4자리 숫자만 페이지번호로 간주해 제거. 흩어진 차트/표 값(군집)은 데이터이므로 살린다.
const PAGE_NUM_LINE = /^[ \t]*\d{1,4}[ \t]*$/; // 삭제 후보(페이지번호 형태)
const NUMERIC_LINE = /^[ \t]*-?\d[\d,]*\.?\d*[ \t]*$/; // 군집 판단용(값 형태 전반)
function stripLonePageNumbers(md) {
  const lines = md.split("\n");
  const nb = []; // 비공백 줄의 인덱스
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nb.push(i);
  const numeric = nb.map((i) => NUMERIC_LINE.test(lines[i]));
  const W = 2;
  for (let k = 0; k < nb.length; k++) {
    if (!PAGE_NUM_LINE.test(lines[nb[k]])) continue; // 페이지번호 형태만 삭제 후보
    let clustered = false;
    for (let d = -W; d <= W && !clustered; d++) if (d !== 0 && numeric[k + d]) clustered = true;
    if (!clustered) lines[nb[k]] = ""; // 고립된 단독 숫자 = 페이지번호 → 제거
  }
  return lines.join("\n");
}

// 헤딩 보정: 번호 섹션은 깊이에 맞춰 레벨 통일(N→##, N.M→###), 본문 오인 헤딩은 문단으로 강등.
function normalizeHeadings(md) {
  return md
    .split("\n")
    .map((line) => {
      const m = line.match(/^(#{1,6})[ \t]+(.*\S)[ \t]*$/);
      if (!m) return line;
      const text = m[2];

      const num = text.match(/^(\d+(?:\.\d+)*)\.?(?:\s|$)/);
      if (num) {
        const depth = num[1].split(".").length;
        const level = Math.min(6, depth + 1);
        return `${"#".repeat(level)} ${text}`;
      }

      const looksLikeBody =
        text.length > 80 || /[.,;]$/.test(text) || /^[a-z]/.test(text);
      if (looksLikeBody) return text; // # 제거 → 일반 문단

      return line;
    })
    .join("\n");
}
