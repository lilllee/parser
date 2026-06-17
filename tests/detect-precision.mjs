// reflow 감지 정밀도: 코퍼스를 kordoc 파싱 → 어떤 페이지가 어떤 신호로 flag 됐는지 분해.
// AI 불필요(빠름) — server/config/detect.js 임계값 튜닝/과트리거 점검용.
//   node tests/detect-precision.mjs [dir=tests/file]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "kordoc";
import {
  isProseFakeTable,
  isGarbledDataTable,
  isPipeTableParagraph,
  hasBrokenKoreanSpacing,
  glyphNoiseScore,
  detectMangledPages,
} from "../server/detect.js";
import { detectSpreadPages } from "../server/vllm.js";
import { detectConfig } from "../server/config/detect.js";

const dir = process.argv[2] || "tests/file";
const SUPPORTED = /\.(pdf|hwp|hwpx|hwpml|docx|xlsx|xls)$/i;
const files = readdirSync(dir).filter((f) => SUPPORTED.test(f)).sort();
console.log(`[detect-precision] dir=${dir} files=${files.length}\n`);

for (const f of files) {
  const buf = readFileSync(join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let r;
  try {
    r = await parse(ab.slice(0));
  } catch (e) {
    console.log(`❌ ${f}: ${e.message}`);
    continue;
  }
  if (!r.success) {
    console.log(`⚠️  ${f}: ${r.code}`);
    continue;
  }

  const sig = { prose: new Set(), garbled: new Set(), pipe: new Set(), space: new Set(), glyph: new Map() };
  for (const b of r.blocks || []) {
    if (!b.pageNumber) continue;
    if (b.type === "table" && isProseFakeTable(b.table)) sig.prose.add(b.pageNumber);
    else if (b.type === "table" && isGarbledDataTable(b.table)) sig.garbled.add(b.pageNumber);
    else if (isPipeTableParagraph(b)) sig.pipe.add(b.pageNumber);
    else if (hasBrokenKoreanSpacing(b)) sig.space.add(b.pageNumber);
    const g = glyphNoiseScore(b);
    if (g) sig.glyph.set(b.pageNumber, (sig.glyph.get(b.pageNumber) || 0) + g);
  }
  const glyphPages = [...sig.glyph].filter(([, c]) => c >= detectConfig.glyphNoise.pageThreshold).length;
  const mangled = detectMangledPages(r.blocks);
  let spreads = new Set();
  if (r.fileType === "pdf") {
    try { ({ spreadPages: spreads } = await detectSpreadPages(ab.slice(0))); } catch { /* ignore */ }
  }
  const pages = r.pageCount || Math.max(0, ...(r.blocks || []).map((b) => b.pageNumber || 0));

  console.log(
    `📄 ${f.slice(0, 42)} [${r.fileType}] ${pages}p · flag ${mangled.length}` +
    ` (prose ${sig.prose.size} garbled ${sig.garbled.size} pipe ${sig.pipe.size} space ${sig.space.size} glyph ${glyphPages})` +
    ` · spread ${spreads.size}`
  );
}
