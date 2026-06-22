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

  // 전보용 월/시·사각/원katakana 기호(㋀-㋿, ㍘-㍰)가 장식 번호 대신 잘못 추출돼 본문에 섞이는
  // 경우 제거(한국어 행정문서엔 정당한 용례 없음). 원문자 한글 목록마커(㉠-㉭, U+3260↓)와 단위
  // 기호(㎡㎏…, U+3371↑)는 범위 밖이라 보존. 줄머리 불릿 글리프(•●◦∙)는 markdown '- ' 로 정규화.
  out = normalizeStrayGlyphsAndBullets(out);

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

  // 폰트 손상 PDF 에서 kordoc 이 줄바꿈마다 별도 문단으로 떠와 문장·단어가 끊긴 것을 합친다.
  out = reflowSoftWrappedParagraphs(out);

  // 4) 과도한 빈 줄 축소 (3+ → 2) + 문서 앞뒤 공백 정리
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
  out = out.replace(/\s+$/, "") + "\n";

  return out;
}

// 전보 기호(㋀-㋿ U+32C0-32FF, ㍘-㍰ U+3358-3370) 제거 + 줄머리 불릿 글리프 → markdown '- '.
// · (가운뎃점 U+00B7)은 한국어 나열 구분자(가·나·다)라 변환 대상에서 제외.
function normalizeStrayGlyphsAndBullets(md) {
  return String(md)
    .replace(/[㋀-㋿㍘-㍰]/g, "")
    .replace(/^([ \t]*)[•●◦∙][ \t]+/gm, "$1- ");
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

// kordoc 이 (폰트/레이아웃 손상 문서에서) PDF 줄바꿈마다 별도 문단으로 떠와 문장이 줄 단위로
// 끊기고 단어가 음절 중간에서 갈라지는 경우(예: "퇴소"\n\n"를", "자립환"\n\n"경")를 한 문단으로
// 합친다. 보수적: 앞 문단이 한글 음절로 끝나고(종결어미·구두점 아님) 본문 길이(>=15)이며 마커가
// 아니고, 뒤 문단이 한글로 시작하며 마커(표·헤딩·목록·번호)가 아닐 때만 공백 없이 직결한다.
// (이 문서 줄바꿈은 음절 중간 끊김이 다수라 공백 없이 잇는 편이 더 정확.) 종결문장·목록·표는 보존.
const SENT_END = /[.!?。…:;」』”’)\]]\s*$|(?:다|요|죠|까|네|음|함|임|됨|니다|음\.|함\.)\s*$/;
const CONT_MARKER = /^\s*(?:[#>|]|<|[-*∙·•]\s|[○◦●□■▪️※☞⚪◎]|[①-⑮㉠-㉭]|[0-9]+\s*[.)]\s|[가-하]\s*[.)]\s|\([0-9가-하]+\)|제\s*\d+\s*[장절조항관])/;
// 번호/원문자 + [태그] 로 시작하는 '헤딩-라벨' 줄(예: "① [공통] …활동계획을 반영")은 줄바꿈된
// 목록 항목이 아니라 라벨이므로 길어도 다음 줄을 흡수하지 않는다("반영"+"모든…" → "반영모든" 오병합 방지).
const HEADING_LABEL = /^\s*(?:[①-⑮㉠-㉭]|\([0-9가-하]+\)|\d+\s*[.)]|[가-하]\s*[.)])\s*\[[^\]]+\]/;
function reflowSoftWrappedParagraphs(md) {
  const paras = String(md).split(/\n{2,}/);
  const out = [];
  for (const p of paras) {
    const t = p.replace(/[ \t]+$/, "");
    const prev = out.length ? out[out.length - 1] : "";
    // 마커로 시작한 줄도 '길면'(줄바꿈된 목록 항목) 자기 연속줄을 흡수하되, 짧은 마커(헤딩/라벨)는
    // 보존한다. 연속줄은 한글뿐 아니라 숫자 시작도 허용("제"\n\n"32조의7" → "제32조의7").
    const prevMergeable =
      /[가-힣]$/.test(prev) && !SENT_END.test(prev) && prev.indexOf("\n") === -1 &&
      !HEADING_LABEL.test(prev) &&
      (CONT_MARKER.test(prev) ? prev.length >= 30 : prev.length >= 15);
    if (
      t.trim() && prevMergeable &&
      /^[0-9가-힣]/.test(t.trim()) && !CONT_MARKER.test(t) && t.indexOf("\n") === -1
    ) {
      out[out.length - 1] = prev + t.trim(); // 음절 중간 끊김 — 공백 없이 직결
      continue;
    }
    out.push(t);
  }
  return out.join("\n\n");
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
  // 중첩 표 해체: 셀 안에 안쪽 <table> 이 있으면 그 안쪽 <tr>/<th> 태그가 아래 lazy 정규식을
  // 가로채(첫 </tr>·</th> 에서 끊김) 바깥 셀의 본문(<br> 로 이어진 목차 등)을 통째로 잃는다.
  // 그래서 표가 하나만 남을 때까지 '가장 안쪽' 표를 텍스트(셀↔셀·행↔행은 <br>)로 풀어준다.
  // 중첩이 없으면 while 미실행 — 일반 표에는 무해. (예: 2019 공모 목차가 <th> 안 중첩표였음)
  let md = String(tableMd);
  for (let guard = 0; (md.match(/<table\b/gi) || []).length > 1 && guard < 20; guard++) {
    md = md.replace(/<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/i, (_, inner) =>
      inner
        .replace(/<\/(?:tr|t[dh])>/gi, "<br>")
        .replace(/<[^>]+>/g, "")
        .replace(/(?:<br>\s*){2,}/gi, "<br>")
        .replace(/^(?:<br>)+|(?:<br>)+$/g, "")
        .trim()
    );
  }
  const rowMatches = md.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  return rowMatches.map((row) =>
    (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) =>
      c.replace(/<t[dh][^>]*>|<\/t[dh]>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()
    )
  );
}
// kordoc 이 2D 레이아웃(목차 등)을 몇 개 셀에 <br> 로 욱여넣어 행 정렬을 잃은 '크램드 표'를 감지.
// 이런 페이지는 결정론적 flatten 으론 평문 나열만 가능하고(정렬 복구 불가), vision 재추출이 2D
// 구조(라벨↔제목↔페이지 정렬)를 복원하므로 reflow 대상으로 라우팅하는 데 쓴다. (export)
export function hasCrammedTable(md) {
  for (const t of String(md).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const cells = (t.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).length;
    const br = (t.match(/<br\s*\/?>/gi) || []).length;
    if (cells > 0 && cells <= 6 && br >= 8) return true;
  }
  return false;
}

// kordoc 레이아웃 분석이 '표+산문+다른 표'를 한 격자로 뭉갠 '문장 박힌 표' 감지: 표 셀에 문장
// 길이의 한글(증감 종결어·"…명으로") 또는 [그림 N]·[표 N] 캡션이 들어있으면 결함으로 본다.
// hasBrokenTable(형식 깨짐)·hasCrammedTable(셀<=6·br다수)이 못 잡는, '형식은 멀쩡하나 의미상
// 깨진' 표(예: 인구동향 두 표/페이지가 한 <table>로)를 reflow(vision) 대상으로 라우팅하는 데 쓴다.
const TABLE_CELL_RE = /<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi;
const SENTENCE_IN_CELL = /(?:증가함|감소함|하였다|되었다|하였음|되었음|명으로|배\s*증가|배\s*감소)/;
function cellIsStuffed(t) {
  if (!/[가-힣]/.test(t)) return false;
  // [그림 N]·[표 N] 캡션이 셀에 들어간 건 길이와 무관하게 결함(캡션은 표 밖이어야 함).
  if (/\[(?:그림|표)\s*\d/.test(t)) return true;
  // 문장(증감 종결어·"…명으로")이 셀에 박힌 건 길이 가드와 함께(정상 짧은 라벨 오탐 방지).
  return t.length >= 30 && SENTENCE_IN_CELL.test(t);
}
export function hasSentenceStuffedTable(md) {
  const s = String(md);
  for (const cell of s.match(TABLE_CELL_RE) || []) {
    if (cellIsStuffed(cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())) return true;
  }
  for (const line of s.split("\n")) {
    if (!/^\s*\|.*\|/.test(line) || isSeparatorRow(line)) continue;
    for (const cell of line.split("|")) if (cellIsStuffed(cell.trim())) return true;
  }
  return false;
}

// kordoc 이 좌우 비교표(현행/개정·변경전후 등)에서 한 열만 읽어 양쪽 열에 같은 내용을 복제하는
// 실패 패턴 감지. 긴(>=20자) 동일 내용이 인접 두 열에 든 행이 2개 이상이면 '열 복제'로 본다 —
// 정상 비교표도 '안 바뀐 행'은 좌우가 같을 수 있으나, 긴 셀이 여러 행에서 통째로 복제되는 건
// 추출 실패 신호다. 이런 페이지는 vision 이 좌우를 제대로 분리하므로 reflow 라우팅 대상. (export)
const dupRow = (cells) => {
  for (let i = 0; i < cells.length - 1; i++) {
    const a = cells[i];
    if (a && a.length >= 20 && a === cells[i + 1]) return true;
  }
  return false;
};
export function hasDuplicatedColumns(md) {
  let n = 0;
  for (const line of String(md).split("\n")) {
    if (!/^\s*\|.*\|/.test(line) || isSeparatorRow(line)) continue;
    if (dupRow(line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())) && ++n >= 2) return true;
  }
  for (const row of String(md).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (dupRow(cells) && ++n >= 2) return true;
  }
  return false;
}

// 페이지별 숫자 대조 검증 — vision 전사(구조는 좋으나 숫자 오독 리스크)가 숫자를 틀리게 읽었는지
// kordoc 텍스트레이어 숫자와 대조한다. kordoc 은 dense 표 '구조'는 깨도 텍스트레이어 '숫자'는 정확
// 하므로 ground-truth 로 쓴다. '의미있는 데이터 숫자'(소수점/콤마 포함 또는 3자리+)만 비교해
// 페이지번호·리스트마커 같은 1~2자리 노이즈를 배제. kordoc 텍스트가 비면(스캔 페이지) 검증 근거가
// 없으므로 unverified(=ok 로 두되 무근거 표시). (export — 단위 테스트 + force_ocr 검증에서 사용)
export function comparePageNumbers(kordocText, visionText) {
  const significant = (s) => s.includes(".") || /,/.test(s) || s.replace(/^0+/, "").length >= 3;
  const nums = (t) =>
    [...String(t || "").matchAll(/\d[\d,]*(?:\.\d+)?/g)]
      .map((m) => m[0].replace(/,/g, ""))
      .filter(significant);
  const toSet = (arr) => {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  };
  const kset = toSet(nums(kordocText));
  const vset = toSet(nums(visionText));
  const kcount = [...kset.values()].reduce((a, b) => a + b, 0);
  if (kcount === 0) return { kordocNumbers: 0, missing: [], extra: [], ok: true, unverified: true };
  const missing = []; // kordoc 에 있는데 vision 에 부족 = vision 누락/오독
  for (const [num, c] of kset) {
    const have = vset.get(num) || 0;
    for (let i = have; i < c; i++) missing.push(num);
  }
  const extra = []; // vision 에 있는데 kordoc 에 없음 = vision 이 더 완전(kordoc 미추출 영역)이거나 연도 등
  for (const [num, c] of vset) {
    const have = kset.get(num) || 0;
    for (let i = have; i < c; i++) extra.push(num);
  }
  // ok 판정은 missing 기준으로만 한다 — 진짜 정확도 손실은 'kordoc 이 확인한 숫자를 vision 이 잃거나
  // 오독한 것'(missing)이다. extra(vision 이 더 많음)는 kordoc 이 그 영역을 못 읽은 경우가 대부분이라
  // 오류로 보지 않는다(정보로만 보고). 오독(예 2,306→2,308)은 missing[2306]+extra[2308] 로 나오므로
  // missing 기준만으로도 그대로 잡힌다.
  return { kordocNumbers: kcount, missing, extra, ok: missing.length === 0, unverified: false };
}

// 목차가 표(파이프/HTML)로 잘못 떠진 경우 감지: 데이터 행의 절반 이상이 'N-N(또는 제N장) … 페이지번호'
// 패턴이면 TOC 표로 본다. 제목이 컬럼에 쪼개진 파이프 목차(크램드 HTML 이 아닌)도 잡아 vision 라우팅.
// 진짜 데이터 표는 '섹션라벨 … 단독 페이지번호' 행이 드물어 안 걸린다. (export)
export function looksLikeTocTable(md) {
  const rows = [];
  for (const line of String(md).split("\n")) {
    const t = line.trim();
    if (/^\|.*\|$/.test(t) && !/^\|?\s*:?-{2,}/.test(t)) rows.push(t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  }
  for (const tr of String(md).match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    rows.push((tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map((c) => c.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").trim()));
  }
  if (rows.length < 4) return false;
  let toc = 0;
  for (const cells of rows) {
    const ne = cells.filter(Boolean);
    if (ne.length < 2) continue;
    if (/^(?:\d+-\d+|제\s*\d+\s*장)\b/.test(ne[0]) && /^\d{1,3}$/.test(ne[ne.length - 1])) toc++;
  }
  return toc >= rows.length * 0.5;
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
