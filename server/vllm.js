import { Buffer } from "node:buffer";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { aiComplete, aiCheck, aiInfo, AI_ENABLED, formatAiError } from "./ai.js";
import { vllmConfig as cfg } from "./config/vllm.js";
import { vllmPrompts as prompts } from "./config/prompt.js";

export const VLLM_ENABLED = AI_ENABLED;
export const vllmInfo = aiInfo;
export const checkVllmConnection = aiCheck;

const aiCall = (opts) => aiComplete({ maxTokens: cfg.tokens.image, ...opts });

export async function enrichMarkdown(
  markdown,
  images,
  { onProgress, onNote, visualPages } = {}
) {
  if (!markdown) return empty(markdown);

  const imageMap = new Map();
  for (const img of images || []) {
    if (!img?.filename || !img?.data) continue;
    const url = await toSafeImageUrl(img.data, img.mimeType);
    imageMap.set(img.filename, url);
    imageMap.set(normalizeImageRef(img.filename), url);
  }

  const targets = findTargets(markdown, imageMap, visualPages);
  if (!targets.length) {
    onProgress?.(1);
    return empty(markdown);
  }

  const results = new Array(targets.length).fill(null);
  let done = 0;
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  await mapWithLimit(targets, cfg.concurrency.enrich, async (t, idx) => {
    onNote?.(
      t.type === "image"
        ? `이미지 분석 ${idx + 1}/${targets.length}`
        : t.type === "page-visual"
          ? `차트/그림 분석 ${idx + 1}/${targets.length}`
          : `표 분석 ${idx + 1}/${targets.length}`
    );
    try {
      const analysis = await analyzeTarget(t, imageMap);
      if (analysis) {
        results[idx] = analysis;
        enriched++;
      } else {
        skipped++;
      }
    } catch (e) {
      console.warn(`[vllm] ${t.type} #${idx} failed:`, formatAiError(e));
      failed++;
    } finally {
      done++;
      onProgress?.(done / targets.length);
    }
  });

  // 끝에서부터 삽입해야 인덱스가 안 깨짐
  const insertions = targets
    .map((t, i) => ({ at: t.index + t.length, text: results[i] }))
    .filter((x) => x.text)
    .sort((a, b) => b.at - a.at);

  let out = markdown;
  for (const ins of insertions) {
    const oneLine = ins.text.replace(/\s+/g, " ").trim();
    const block = `\n\n> ${oneLine}\n`;
    out = out.slice(0, ins.at) + block + out.slice(ins.at);
  }

  return { markdown: out, enriched, skipped, failed, total: targets.length };
}

function empty(markdown) {
  return { markdown, enriched: 0, skipped: 0, failed: 0, total: 0 };
}

function findTargets(md, imageMap, visualPages) {
  const targets = [];
  const occupied = [];

  // 이미지 reference: ![alt](file) — kordoc 가 추출한 raster image 한정
  const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = imgRe.exec(md)) !== null) {
    const url = imageMap.get(m[2]) || imageMap.get(normalizeImageRef(m[2]));
    if (url) {
      targets.push({
        type: "image",
        index: m.index,
        length: m[0].length,
        alt: m[1],
        file: m[2],
        imageUrl: url,
      });
      occupied.push([m.index, m.index + m[0].length]);
    }
  }

  // 표 블록 — 인접한 `|` 라인 그룹화 (VLLM_TABLE_ANALYSIS=1 일 때만 분석 대상)
  if (cfg.features.tableAnalysis) {
    const tblRe = /(?:^[ \t]*\|.*\|[ \t]*\r?\n?)+/gm;
    while ((m = tblRe.exec(md)) !== null) {
      const text = m[0].replace(/\s+$/, "");
      const lineCount = text.split("\n").filter((l) => l.includes("|")).length;
      if (lineCount < 2) continue; // 너무 짧으면 표 아님
      // 인용 블록 (> ...) 안의 | 는 제외
      if (text.split("\n").every((l) => /^\s*>/.test(l))) continue;
      if (overlaps(m.index, m.index + m[0].length, occupied)) continue;
      targets.push({
        type: "table",
        index: m.index,
        length: m[0].length,
        text,
      });
    }
  }

  if (cfg.features.pageVisual) {
    targets.push(...findVisualPageTargets(md, visualPages, occupied));
  }
  return targets.sort((a, b) => a.index - b.index);
}

async function analyzeTarget(t, imageMap) {
  if (t.type === "image") {
    const url = t.imageUrl || imageMap.get(t.file) || imageMap.get(normalizeImageRef(t.file));
    if (!url) return null;
    return aiCall({
      image: url,
      prompt: prompts.imageAnalysis,
    });
  }
  if (t.type === "table") {
    let text = t.text;
    if (text.length > cfg.limits.tableChars) {
      // 표 너무 크면 머리 + 꼬리만
      const lines = text.split("\n");
      text =
        lines.slice(0, 10).join("\n") +
        `\n... (중략, 총 ${lines.length}행 중 18행 표시) ...\n` +
        lines.slice(-8).join("\n");
    }
    return aiCall({
      prompt: prompts.tableAnalysis,
      text,
      maxTokens: cfg.tokens.table,
    });
  }
  if (t.type === "page-visual") {
    const out = await aiCall({
      image: t.imageUrl,
      prompt: prompts.pageVisualAnalysis,
      text: prompts.pageVisualContext(t.context),
      maxTokens: cfg.tokens.pageVisual,
    });
    // 페이지에 분석할 시각자료가 없다고 판단되면 본문에 삽입하지 않는다 (거짓 블록 방지).
    if (!out || isNoVisualResponse(out)) return null;
    return out;
  }
  return null;
}

// kordoc OcrProvider: 텍스트 레이어 없는 PDF 페이지(PNG) → vision OCR → markdown.
export async function vllmOcrPage(pageImage, pageNumber, mimeType = "image/png") {
  try {
    const b64 = Buffer.from(pageImage).toString("base64");
    const url = `data:${mimeType};base64,${b64}`;
    const text = await aiCall({
      image: url,
      prompt: prompts.pdfOcrPage(pageNumber),
      maxTokens: cfg.tokens.ocr,
      temperature: 0.0,
      timeoutMs: cfg.timeouts.ocrMs,
    });
    return cleanOcrText(text);
  } catch (e) {
    console.warn(`[vllm-ocr] page ${pageNumber} failed:`, e?.message || e);
    return "";
  }
}

// 업로드된 이미지 1장 → AI vision OCR → markdown. (배치와 달리 실패 시 throw)
export async function ocrImageBuffer(arrayBuffer, mimeType = "image/png") {
  const url = await toSafeImageUrl(arrayBuffer, mimeType);
  const text = await aiCall({
    image: url,
    prompt: prompts.imageOcr,
    maxTokens: cfg.tokens.ocr,
    temperature: 0.0,
    timeoutMs: cfg.timeouts.ocrMs,
  });
  return cleanOcrText(text);
}

// vision 모델이 답을 코드펜스로 감쌀 때 그 펜스 줄만 제거.
function cleanOcrText(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  return t
    .replace(/^[ \t]*```[ \t]*(?:markdown|md)?[ \t]*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 일부 provider(gemini 등)는 bmp/gif/tiff 를 거부 → png/jpeg/webp 가 아니면 PNG 로 변환.
const AI_SAFE_IMAGE = /^image\/(png|jpe?g|webp)$/i;
async function toSafeImageUrl(data, mime = "image/png") {
  const buf = Buffer.from(data);
  if (AI_SAFE_IMAGE.test(mime)) return `data:${mime};base64,${buf.toString("base64")}`;
  try {
    const im = await loadImage(buf);
    const c = createCanvas(im.width, im.height);
    c.getContext("2d").drawImage(im, 0, 0);
    return `data:image/png;base64,${c.toBuffer("image/png").toString("base64")}`;
  } catch (e) {
    console.warn(`[vllm] image transcode 실패(${mime}):`, e?.message || e);
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
}

const VISUAL_LINE_RE =
  /(^|\n)([^\n]*(?:Figure|Fig\.|Chart|Graph|Table|그림|도표|차트|그래프|통계|추이|분포|비율|매출|실적)[^\n]*)/gi;
const VISUAL_CAPTION_RE =
  /(?:Figure|Fig\.|Chart|Graph|Table|그림|도표|차트|그래프|표)\s*\d+/i;

function findVisualPageTargets(md, visualPages, occupied) {
  if (!visualPages?.length) return [];

  const candidates = [];
  let m;
  while ((m = VISUAL_LINE_RE.exec(md)) !== null) {
    const lineStart = m.index + m[1].length;
    const line = m[2].trim();
    if (!line || overlaps(lineStart, lineStart + m[2].length, occupied)) continue;
    candidates.push({
      lineStart,
      length: m[2].length,
      line,
      isCaption: VISUAL_CAPTION_RE.test(line),
    });
  }

  candidates.sort((a, b) =>
    a.isCaption !== b.isCaption ? (a.isCaption ? -1 : 1) : a.lineStart - b.lineStart
  );

  const targets = [];
  const seenPages = new Set();
  for (const c of candidates) {
    const page = findPageForContext(c.line, visualPages);
    if (!page?.image || seenPages.has(page.page)) continue;
    if (page.image.length > cfg.limits.pageVisualImageKb * 1024) {
      console.warn(
        `[vllm] page-visual skip: page ${page.page} 이미지 ${Math.round(page.image.length / 1024)}KB > ${cfg.limits.pageVisualImageKb}KB`
      );
      seenPages.add(page.page);
      continue;
    }
    targets.push({
      type: "page-visual",
      index: c.lineStart,
      length: c.length,
      page: page.page,
      imageUrl: page.image,
      context: c.line,
    });
    seenPages.add(page.page);
  }

  return targets;
}

function findPageForContext(line, visualPages) {
  const needle = normalizeText(stripMdDecoration(line));
  if (needle.length < 8) return null;

  for (const probeLen of [60, 36, 20]) {
    const probe = needle.slice(0, probeLen);
    if (probe.length < 12) continue;
    for (const page of visualPages) {
      if (!page?.image) continue;
      if (pageFullText(page).includes(probe)) return page;
    }
  }
  return null;
}

function pageFullText(page) {
  return normalizeText((page?.blocks || []).map((b) => b?.content || "").join(" "));
}

function stripMdDecoration(line) {
  return String(line || "")
    .replace(/[>#*`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoVisualResponse(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  return (
    /\bNO_VISUAL\b/i.test(t) ||
    /포함되어\s*있지\s*않/.test(t) ||
    /존재하지\s*않/.test(t) ||
    /불가능/.test(t) ||
    /확인할?\s*수\s*없/.test(t) ||
    /기술할?\s*수\s*없/.test(t)
  );
}

function normalizeImageRef(ref) {
  try {
    const noHash = String(ref || "").split("#")[0].split("?")[0];
    return decodeURIComponent(noHash.split(/[\\/]/).pop() || noHash);
  } catch {
    return String(ref || "");
  }
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function overlaps(start, end, ranges) {
  return ranges.some(([a, b]) => start < b && end > a);
}

async function mapWithLimit(items, limit, worker) {
  const queue = items.map((it, idx) => ({ it, idx }));
  const n = Math.min(limit, queue.length);
  const runners = Array.from({ length: n }, async () => {
    while (queue.length) {
      const { it, idx } = queue.shift();
      await worker(it, idx);
    }
  });
  await Promise.all(runners);
}

// PDF 페이지 렌더. pdfjs-dist+canvas 는 이 환경에서 깨져 mupdf 사용. pageFilter=null 이면 전체.
async function renderPdfPages(arrayBuffer, pageFilter = null, scale = cfg.render.ocrScale) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(arrayBuffer), "application/pdf");
  const pageCount = doc.countPages();
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    if (pageFilter && !pageFilter.has(i)) continue;
    try {
      const page = doc.loadPage(i - 1);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB);
      pages.push({ page: i, png: Buffer.from(pix.asPNG()) });
    } catch (e) {
      console.warn(`[render] page ${i} failed:`, e?.message || e);
    }
  }
  return { pageCount, pages };
}

// 스캔본(IMAGE_BASED_PDF) fallback: 전 페이지 렌더 → vllmOcrPage → markdown 합성.
export async function ocrPdfBuffer(arrayBuffer, { onProgress, onPage } = {}) {
  const { pageCount, pages } = await renderPdfPages(arrayBuffer, null);
  const texts = new Array(pages.length).fill("");
  let okCount = 0;
  let done = 0;

  await mapWithLimit(pages, cfg.concurrency.ocr, async ({ page, png }, idx) => {
    onPage?.(page, pageCount);
    const clean = (await vllmOcrPage(png, page, "image/png")).trim();
    if (clean) {
      texts[idx] = clean;
      okCount++;
    }
    onProgress?.(++done / (pages.length || 1));
  });

  const sections = pages
    .map(({ page }, idx) =>
      texts[idx] ? (pageCount > 1 ? `## 페이지 ${page}\n\n${texts[idx]}` : texts[idx]) : null
    )
    .filter(Boolean);

  return { markdown: sections.join("\n\n---\n\n"), pageCount, ocrPages: okCount };
}

// 2-page spread(펼침면): landscape 페이지 폭이 세로 페이지 폭의 ~2배면 펼침면으로 판정한다.
// 텍스트 신호로는 안 잡혀 페이지 기하로 감지. VLLM_SPREAD_SPLIT=0 으로 끔.

function median(nums) {
  const a = nums.filter((n) => n > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export async function detectSpreadPages(arrayBuffer) {
  const empty = { spreadPages: new Set(), pageCount: 0, portraitW: 0, dims: [] };
  if (!cfg.features.spreadSplit) return empty;
  let doc;
  try {
    const mupdf = await import("mupdf");
    doc = mupdf.Document.openDocument(new Uint8Array(arrayBuffer), "application/pdf");
  } catch (e) {
    console.warn("[spread] open 실패:", e?.message || e);
    return empty;
  }
  const pageCount = doc.countPages();
  const dims = [];
  for (let i = 0; i < pageCount; i++) {
    let w = 0, h = 0;
    try {
      const b = doc.loadPage(i).getBounds();
      const a = Array.isArray(b) ? b : [b.x0, b.y0, b.x1, b.y1];
      w = a[2] - a[0];
      h = a[3] - a[1];
    } catch { /* ignore */ }
    dims.push({ page: i + 1, w, h });
  }
  const portraitW = median(dims.filter((d) => d.w > 0 && d.w <= d.h * 1.05).map((d) => d.w));
  const spreadPages = new Set();
  for (const d of dims) {
    if (!(d.w > 0 && d.h > 0) || d.w <= d.h * 1.15) continue; // landscape 만 후보
    const isSpread = portraitW
      ? d.w / portraitW >= 1.6 && d.w / portraitW <= 2.4 // ≈ 세로폭 2배 = 두 쪽
      : d.w / d.h >= 1.25 && d.w / d.h <= 1.6; // 기준 없으면 A-계열 2-up 비율
    if (isSpread) spreadPages.add(d.page);
  }
  return { spreadPages, pageCount, portraitW, dims };
}

async function splitPngHalves(png) {
  const img = await loadImage(png);
  const W = img.width, H = img.height;
  const halfW = Math.floor(W / 2);
  const crop = (sx, sw) => {
    const c = createCanvas(sw, H);
    c.getContext("2d").drawImage(img, sx, 0, sw, H, 0, 0, sw, H);
    return c.toBuffer("image/png");
  };
  return [crop(0, halfW), crop(halfW, W - halfW)];
}

export async function ocrSelectedPdfPages(arrayBuffer, pageNumbers, { onPage, spreadPages } = {}) {
  const want = new Set((pageNumbers || []).filter((n) => n > 0));
  if (!want.size) return new Map();
  const spreads = spreadPages instanceof Set ? spreadPages : new Set(spreadPages || []);
  const { pages } = await renderPdfPages(arrayBuffer, want);

  const units = [];
  for (const { page, png } of pages) {
    if (spreads.has(page)) {
      try {
        const [left, right] = await splitPngHalves(png);
        units.push({ page, half: 0, png: left });
        units.push({ page, half: 1, png: right });
        continue;
      } catch (e) {
        console.warn(`[spread] page ${page} split 실패 → 통짜 OCR:`, e?.message || e);
      }
    }
    units.push({ page, half: 0, png });
  }

  const partial = new Map(); // page -> { 0: leftText, 1: rightText }
  let done = 0;
  await mapWithLimit(units, cfg.concurrency.ocr, async (u) => {
    const text = (await vllmOcrPage(u.png, u.page, "image/png")).trim();
    onPage?.(++done, units.length, u.page);
    if (!partial.has(u.page)) partial.set(u.page, {});
    partial.get(u.page)[u.half] = text;
  });

  const texts = new Map();
  for (const { page } of pages) {
    if (texts.has(page)) continue;
    const ph = partial.get(page) || {};
    const merged = [ph[0], ph[1]].filter(Boolean).map((s) => s.trim()).join("\n\n");
    if (merged) texts.set(page, merged);
  }
  return texts;
}
