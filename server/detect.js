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

// 망가진 페이지 번호(1-based) 오름차순, 중복 제거.
export function detectMangledPages(blocks) {
  const pages = new Set();
  const glyphByPage = new Map();
  for (const b of blocks || []) {
    if (!b.pageNumber) continue;
    if (b.type === "table" && (isProseFakeTable(b.table) || isGarbledDataTable(b.table))) {
      pages.add(b.pageNumber);
    } else if (isPipeTableParagraph(b) || hasBrokenKoreanSpacing(b)) {
      pages.add(b.pageNumber);
    }
    const g = glyphNoiseScore(b);
    if (g) glyphByPage.set(b.pageNumber, (glyphByPage.get(b.pageNumber) || 0) + g);
  }
  for (const [pn, count] of glyphByPage) if (count >= cfg.glyphNoise.pageThreshold) pages.add(pn);
  return [...pages].sort((a, b) => a - b);
}
