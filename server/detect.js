// reflow(OCR 재추출) 대상 페이지 선별. index.js 와 tests 가 공유하는 감지 로직.
import { detectConfig as cfg } from "./config/detect.js";

// 2단 산문이 가짜 표(긴 산문이 셀에 들어참)로 뭉개진 경우.
export function isProseFakeTable(table) {
  if (!table?.cells) return false;
  const nonEmpty = table.cells
    .flat()
    .map((c) => (c?.text || "").trim())
    .filter((t) => t.length > 0);
  if (nonEmpty.length < cfg.proseFakeTable.minCells) return false;
  const lens = nonEmpty.map((t) => t.length);
  const avgLen = lens.reduce((s, v) => s + v, 0) / lens.length;
  const longRatio = lens.filter((l) => l > cfg.proseFakeTable.longCellLen).length / lens.length;
  return (table.rows || 0) >= cfg.proseFakeTable.minRows
    && avgLen >= cfg.proseFakeTable.avgCellLen
    && longRatio >= cfg.proseFakeTable.longCellRatio;
}

// kordoc legacy 컬럼 경로가 2단 컬럼을 paragraph 텍스트 안에 pipe표로 박은 경우.
export function isPipeTableParagraph(block) {
  if (block.type !== "paragraph" || !block.text) return false;
  return (block.text.match(/^[ \t]*\|.*\|[ \t]*$/gm) || []).length >= cfg.pipeTableParagraph.minPipeLines;
}

// 숫자 표가 구조적으로 망가진 경우(한 셀에 숫자 10개+ 뭉침 / 열 3+ & 빈셀 ≥0.5).
export function isGarbledDataTable(table) {
  if (!table?.cells) return false;
  const texts = table.cells.flat().map((c) => (c?.text || "").trim());
  const total = texts.length || 1;
  const emptyRatio = texts.filter((t) => !t).length / total;
  const maxNumTokens = Math.max(
    0,
    ...texts.map((t) => (t.match(/-?\d[\d,]*\.?\d*/g) || []).length)
  );
  return maxNumTokens >= cfg.garbledDataTable.maxNumTokens
    || ((table.cols || 0) >= cfg.garbledDataTable.minCols && emptyRatio >= cfg.garbledDataTable.emptyRatio);
}

// 한국어 띄어쓰기 소실(공백 없는 한글+구두점 25자+) — kordoc 이 공백을 흘린 신호.
export function hasBrokenKoreanSpacing(block) {
  let t = block.text || "";
  if (!t && block.table?.cells) {
    t = block.table.cells.flat().map((c) => c?.text || "").join(" ");
  }
  return /[가-힣][가-힣,()·]{24,}/.test(t);
}

// 아이콘/글리프 깨짐(¤ª, T_ 등) 노이즈 점수 — 매뉴얼/스크린샷 PDF reflow 신호.
export function glyphNoiseScore(block) {
  const t = block.text || "";
  if (!t) return 0;
  const weird = (t.match(/[ªº¤¡¦¨]/g) || []).length;
  const iconPrefix = (t.match(/(?:^|[\s>])[A-Za-z]_(?=[\s가-힣])/g) || []).length;
  return weird + iconPrefix;
}

// 차트 축눈금 잔해: "0% 10% 20% 30%…"(%눈금 4개+) 또는 한 줄이 통째로
// "80 70 60 50 40…"(1~3자리 숫자 5개+)인 경우 — kordoc 이 차트를 텍스트로 흩뿌린 신호.
export function hasAxisTickRun(block) {
  let t = block.text || "";
  if (!t && block.table?.cells) t = block.table.cells.flat().map((c) => c?.text || "").join("\n");
  if (!t) return false;
  const pctRun = new RegExp(`(?:\\d{1,3}\\s*%\\s+){${cfg.chartArtifact.percentTickMin - 1},}\\d{1,3}\\s*%`);
  if (pctRun.test(t)) return true;
  const numRun = new RegExp(`^\\s*(?:\\d{1,3}\\s+){${cfg.chartArtifact.numberTickMin - 1},}\\d{1,3}\\s*$`, "m");
  return numRun.test(t);
}

// 원형/막대 차트 라벨이 표 셀 하나에 뭉친 경우 ("48.9% 23.7% 41.6%" 한 셀).
// 정상 예산표도 "균특 50%, 도비 25%, 시군비 25%"처럼 한 셀에 %가 여럿 들어가므로,
// 퍼센트값을 걷어낸 뒤 남는 텍스트가 거의 없는 값-라벨 뭉침만 차트 잔해로 본다.
const PERCENT_TOKEN = /\d+(?:\.\d+)?\s*%/g;
function isPercentValueCluster(text) {
  const raw = String(text || "");
  const tokens = raw.match(PERCENT_TOKEN) || [];
  if (tokens.length < cfg.chartArtifact.cellPercentTokens) return false;
  const rest = raw
    .replace(PERCENT_TOKEN, "")
    .replace(/[()\[\],.:;%~∼\-–—/\\\s]/g, "")
    .trim();
  const letters = rest.match(/[A-Za-z가-힣]/g) || [];
  return letters.length <= 2;
}
export function isPercentCramTable(table) {
  if (!table?.cells) return false;
  return table.cells.flat().some((c) => {
    return isPercentValueCluster(c?.text || "");
  });
}

// 좌우 컬럼이 거의 같은 비교표(현행/개정·전/후 등). kordoc 은 이런 3단(쪽|현행|개정) 표를
// 2단으로 뭉개고 행을 잘게 쪼개 페이지번호를 본문 셀에 섞어 신뢰도가 낮다. 한 행에서(공백
// 제거 후) minCellLen 자 이상인 두 셀이 같거나 한쪽이 다른 쪽을 포함하면 '중복 행'으로 보고,
// 비교 가능한 행의 절반 이상이 중복이면 비교표로 판정. (정상 표는 열마다 값이 달라 안 걸림)
export function isDuplicateColumnTable(table) {
  if (!table?.cells || (table.cols || 0) < 2) return false;
  let dup = 0, comparable = 0;
  for (const row of table.cells) {
    const texts = (row || [])
      .map((c) => (c?.text || "").replace(/\s+/g, ""))
      .filter((t) => t.length >= cfg.dupColumnTable.minCellLen);
    if (texts.length < 2) continue;
    comparable++;
    let found = false;
    for (let i = 0; i < texts.length && !found; i++) {
      for (let j = i + 1; j < texts.length && !found; j++) {
        if (texts[i] === texts[j] || texts[i].includes(texts[j]) || texts[j].includes(texts[i])) found = true;
      }
    }
    if (found) dup++;
  }
  return comparable >= cfg.dupColumnTable.minRows && dup / comparable >= cfg.dupColumnTable.dupRatio;
}

// 단위 열이 값 열과 한 셀에 뭉친 표. kordoc 이 '단위 | 실적 | 목표' 열을 분리하지 못해 한 셀에
// '명 1,180 1,109' / '% 46 50' 처럼 단위+값들을 뭉친 신호 — 정상 표는 단위와 값이 별도 셀이다.
// (단위 단어 바로 뒤에 숫자가 붙은 셀이 minCells 개 이상이면 망가진 표.)
const UNIT_JAM = /(?:^|\s)(?:개소|명|반|건수|가구|개반|건|곳|원|천원|백만원|시간|일|회|%)\s+-?\d/;
export function hasUnitJammedCells(table) {
  if (!table?.cells) return false;
  let jammed = 0;
  for (const row of table.cells) {
    for (const c of row || []) {
      if (UNIT_JAM.test(c?.text || "")) jammed++;
    }
  }
  return jammed >= cfg.unitJam.minCells;
}

// 한 셀에 여러 줄(문단/구간)이 통째로 뭉친 표 — kordoc 이 칸 구조를 잃고 본문을 셀 하나에
// 욱여넣은 신호(비대칭 비교표·복잡 레이아웃에서 흔함). 정상 데이터표 셀은 길어도 줄바꿈이
// 거의 없으므로 '셀 안 줄수'로 판정(글자수가 아니라 — 통계표엔 줄바꿈 없는 긴 셀이 정상).
export function isCrammedCellTable(table) {
  if (!table?.cells || (table.cols || 0) > cfg.crammedCell.maxCols) return false;
  for (const row of table.cells) {
    for (const c of row || []) {
      const t = (c?.text || "").trim();
      if (t && (t.match(/\n/g) || []).length + 1 >= cfg.crammedCell.minLines) return true;
    }
  }
  return false;
}

// 개정 대비표(현행/개정 비교) 페이지. 좌우 2단 비교 레이아웃은 내용이 비대칭(한쪽 빈칸/삽입)
// 이면 isDuplicateColumnTable 로 안 잡히지만, '현행'·'개정' 머리글은 페이지마다 반복되므로
// 이를 신호로 페이지 단위 vision 재추출. 본문 우연 동시등장 오탐을 줄이려 짧은 블록 또는 표
// 머리글 행 셀에서만 마커를 인정한다.
export function detectRevisionComparisonPages(blocks) {
  const byPage = new Map(); // page -> { hyun, gae }
  const mark = (pn, key) => {
    const e = byPage.get(pn) || { hyun: false, gae: false };
    e[key] = true;
    byPage.set(pn, e);
  };
  const scan = (pn, t) => {
    if (!t) return;
    if (/현\s*행/.test(t)) mark(pn, "hyun");
    if (/개\s*정/.test(t)) mark(pn, "gae");
  };
  for (const b of blocks || []) {
    if (!b.pageNumber) continue;
    if (b.type === "table") {
      for (const c of b.table?.cells?.[0] || []) scan(b.pageNumber, c?.text); // 머리글 행
    } else if ((b.text || "").length <= cfg.revisionTable.maxMarkerLen) {
      scan(b.pageNumber, b.text);
    }
  }
  const pages = new Set();
  for (const [pn, e] of byPage) if (e.hyun && e.gae) pages.add(pn);
  return pages;
}

// 블록의 텍스트 글자수 (표는 셀 텍스트 합산).
function blockChars(b) {
  if (b.text) return b.text.length;
  if (b.table?.cells) {
    return b.table.cells.flat().reduce((s, c) => s + (c?.text || "").length, 0);
  }
  return 0;
}

// 저밀도 페이지(1-based Set): 블록이 아예 없거나(전면 이미지/부분 스캔) 글자수가
// 문서 중앙값 대비 극단적으로 적은 페이지 — kordoc 이 사실상 추출 실패한 페이지.
export function detectLowDensityPages(blocks, pageCount = 0) {
  const chars = new Map(); // page -> chars
  for (const b of blocks || []) {
    if (!b.pageNumber) continue;
    chars.set(b.pageNumber, (chars.get(b.pageNumber) || 0) + blockChars(b));
  }
  const counts = [...chars.values()].filter((n) => n > 0).sort((a, b) => a - b);
  if (!counts.length) return new Set(); // 텍스트가 전혀 없으면 IMAGE_BASED_PDF 경로 소관
  const mid = Math.floor(counts.length / 2);
  const median = counts.length % 2 ? counts[mid] : (counts[mid - 1] + counts[mid]) / 2;

  const pages = new Set();
  for (let pn = 1; pn <= pageCount; pn++) {
    const n = chars.get(pn) || 0;
    if (n === 0) pages.add(pn); // 블록 0개 = kordoc 이 아무것도 못 읽음
    else if (n < median * cfg.lowDensity.medianRatio && n <= cfg.lowDensity.maxChars) pages.add(pn);
  }
  return pages;
}

// 차트/표가 단락으로 흩어져 '숫자만 있는 블록'이 한 페이지에 여럿(임계 이상) — kordoc 이
// 표/차트 구조를 잃고 값을 개별 단락으로 흩뿌린 신호(정수 라벨 차트가 대표). 정상 표는
// 값이 셀(table 블록) 안에 있으므로 여기 안 걸린다.
export function detectScatteredNumberPages(blocks) {
  const byPage = new Map();
  for (const b of blocks || []) {
    if (!b.pageNumber || b.type === "table") continue;
    if (/^\s*-?\d{1,4}\s*$/.test(b.text || "")) {
      byPage.set(b.pageNumber, (byPage.get(b.pageNumber) || 0) + 1);
    }
  }
  const pages = new Set();
  for (const [pn, c] of byPage) if (c >= cfg.scatteredNumbers.minLoneBlocks) pages.add(pn);
  return pages;
}

// kordoc 가 병합 구조를 잡아 HTML 로 렌더하는 표(colSpan/rowSpan>1 셀 보유).
export function isStructuredTable(table) {
  return (table?.cells || []).some((row) => (row || []).some((c) => (c?.colSpan > 1) || (c?.rowSpan > 1)));
}

// 한 셀에 공백으로 구분된 숫자가 3개 이상 연달아 — 여러 열 값이 한 셀에 뭉친 신뢰 신호.
// 예: '3.6 6.8 7.3 8.1', '238,317 254,457 21,112'. (콤마는 천단위, 토큰 구분은 공백)
const JAMMED_NUMS = /(?:^|\s)-?\d[\d,]*(?:\.\d+)?\s+-?\d[\d,]*(?:\.\d+)?\s+-?\d[\d,]*(?:\.\d+)?(?:\s|$)/;
export function hasJammedNumberCell(table) {
  return (table?.cells || []).some((row) => (row || []).some((c) => JAMMED_NUMS.test(c?.text || "")));
}

// 쉼표 단위 숫자 두 개가 구분자 없이 붙은 경우. 예: "6,167,500990,000",
// "1,580,00050,000". kordoc 이 두 행의 금액을 한 셀에 합치면 중간 comma group 이 4자리
// 이상으로 길어져 정상 천단위 표기와 구분된다.
const GLUED_COMMA_NUM = /\d{1,3}(?:,\d{3})*,\d{4,}(?:,\d{3})+/;
export function hasGluedCommaNumberCell(table) {
  return (table?.cells || []).some((row) => (row || []).some((c) => GLUED_COMMA_NUM.test(c?.text || "")));
}

// 표가 망가졌는가(vision 재추출 필요).
// - 신뢰 신호(중복컬럼·셀뭉침·단위뭉침·값뭉침)는 구조와 무관하게 항상 본다(병합 표라도 값이
//   뭉쳤으면 망가진 것 — 인구동향 p6 사례).
// - 느슨한 휴리스틱(prose/garbled/percentCram)은 '구조 보존 표(HTML 병합)'에는 면제한다 —
//   좋은 kordoc HTML 표가 %주석·병합 빈셀 때문에 오탐돼 vision 으로 가 깨지는 걸 막는다.
export function isMangledTable(table) {
  if (!table?.cells) return false;
  if (
    isDuplicateColumnTable(table) ||
    isCrammedCellTable(table) ||
    hasUnitJammedCells(table) ||
    hasJammedNumberCell(table) ||
    hasGluedCommaNumberCell(table)
  ) return true;
  if (isStructuredTable(table)) return false;
  return isProseFakeTable(table) || isGarbledDataTable(table) || isPercentCramTable(table);
}

// 망가진 페이지 번호(1-based) 오름차순, 중복 제거. pageCount 를 주면 저밀도 신호도 포함.
export function detectMangledPages(blocks, pageCount = 0) {
  const pages = new Set();
  const glyphByPage = new Map();
  for (const b of blocks || []) {
    if (!b.pageNumber) continue;
    if (b.type === "table" && isMangledTable(b.table)) {
      pages.add(b.pageNumber);
    } else if (isPipeTableParagraph(b) || hasBrokenKoreanSpacing(b)) {
      pages.add(b.pageNumber);
    }
    if (hasAxisTickRun(b)) pages.add(b.pageNumber);
    const g = glyphNoiseScore(b);
    if (g) glyphByPage.set(b.pageNumber, (glyphByPage.get(b.pageNumber) || 0) + g);
  }
  for (const [pn, count] of glyphByPage) if (count >= cfg.glyphNoise.pageThreshold) pages.add(pn);
  for (const pn of detectScatteredNumberPages(blocks)) pages.add(pn);
  for (const pn of detectRevisionComparisonPages(blocks)) pages.add(pn);
  if (pageCount > 0) for (const pn of detectLowDensityPages(blocks, pageCount)) pages.add(pn);
  return [...pages].sort((a, b) => a - b);
}
