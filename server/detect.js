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
export function isPercentCramTable(table) {
  if (!table?.cells) return false;
  return table.cells.flat().some((c) => {
    const tokens = ((c?.text || "").match(/\d+(?:\.\d+)?\s*%/g) || []).length;
    return tokens >= cfg.chartArtifact.cellPercentTokens;
  });
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

// 망가진 페이지 번호(1-based) 오름차순, 중복 제거. pageCount 를 주면 저밀도 신호도 포함.
export function detectMangledPages(blocks, pageCount = 0) {
  const pages = new Set();
  const glyphByPage = new Map();
  for (const b of blocks || []) {
    if (!b.pageNumber) continue;
    if (b.type === "table" && (isProseFakeTable(b.table) || isGarbledDataTable(b.table) || isPercentCramTable(b.table))) {
      pages.add(b.pageNumber);
    } else if (isPipeTableParagraph(b) || hasBrokenKoreanSpacing(b)) {
      pages.add(b.pageNumber);
    }
    if (hasAxisTickRun(b)) pages.add(b.pageNumber);
    const g = glyphNoiseScore(b);
    if (g) glyphByPage.set(b.pageNumber, (glyphByPage.get(b.pageNumber) || 0) + g);
  }
  for (const [pn, count] of glyphByPage) if (count >= cfg.glyphNoise.pageThreshold) pages.add(pn);
  if (pageCount > 0) for (const pn of detectLowDensityPages(blocks, pageCount)) pages.add(pn);
  return [...pages].sort((a, b) => a - b);
}
