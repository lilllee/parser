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
    out = out.slice(0, ins.at) + formatInsertion(ins.text) + out.slice(ins.at);
  }

  return { markdown: out, enriched, skipped, failed, total: targets.length };
}

// 분석 응답 → 삽입 블록. 응답에 표(markdown |…| / HTML <table>)가 있으면 표는 그대로
// 살리고 산문 줄만 "> " 인용으로 감싼다. 표가 없으면 기존처럼 한 줄 인용.
// (export 는 단위 테스트용)
export function formatInsertion(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (!/^\s*\|.+\|/m.test(t) && !/<table[\s>]/i.test(t)) {
    return `\n\n> ${t.replace(/\s+/g, " ")}\n`;
  }
  const blocks = [];
  let prose = [];
  let table = [];
  let inHtmlTable = false;
  const flushProse = () => {
    const s = prose.join(" ").replace(/\s+/g, " ").trim();
    if (s) blocks.push(`> ${s}`);
    prose = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push(table.join("\n"));
    table = [];
  };
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    const opensHtml = /<table[\s>]/i.test(line);
    if (inHtmlTable || opensHtml || line.startsWith("|")) {
      flushProse();
      table.push(raw.trimEnd());
      if (opensHtml) inHtmlTable = true;
      if (/<\/table>/i.test(line)) inHtmlTable = false;
    } else if (!line) {
      flushProse();
      flushTable();
    } else {
      flushTable();
      prose.push(line);
    }
  }
  flushProse();
  flushTable();
  return `\n\n${blocks.join("\n\n")}\n`;
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

// 추출(OCR) 호출용 샘플링. 전사 충실도를 위해 저온(temp 0.1)을 쓴다 — 낮을수록 결정적이라
// 같은 토큰(<br>·개행)을 무한 반복하는 degeneration 위험이 있지만, 이는 repetition_penalty(등장
// 토큰에 '일정' 페널티)가 막는다 — temp 0.1 + rep 1.1 조합은 degeneration 없음을 실측 확인.
// rep 은 횟수 비례가 아니라, 현행/개정처럼 내용이 길게 반복되는 비교 문서에서 단어 치환
// 드리프트를 일으키지 않는다. (frequency_penalty 는 횟수 비례라 반복 문서에서 드리프트 →
// 기본 0. presence_penalty 도 전사 충실도 저해 우려로 0.) 모두 env 로 모델별 튜닝 가능.
const OCR_SAMPLING = Object.freeze({
  temperature: Number(process.env.VLLM_OCR_TEMPERATURE ?? 0.1),
  topP: Number(process.env.VLLM_OCR_TOP_P ?? 1.0),
  presencePenalty: Number(process.env.VLLM_OCR_PRESENCE_PENALTY ?? 0),
  repetitionPenalty: Number(process.env.VLLM_OCR_REPETITION_PENALTY ?? 1.1),
  frequencyPenalty: Number(process.env.VLLM_OCR_FREQUENCY_PENALTY ?? 0),
});

// 페이지 OCR 본체 — 실패 시 throw (호출부에서 스케일 재시도 등 판단).
// 공통 지시문은 system 으로(byte 동일 → prefix cache), 페이지 번호 등 가변값은 user 로.
async function vllmOcrPageStrict(pageImage, pageNumber, mimeType = "image/png") {
  const b64 = Buffer.from(pageImage).toString("base64");
  const url = `data:${mimeType};base64,${b64}`;
  const text = await aiCall({
    image: url,
    system: prompts.pdfOcrSystem,
    prompt: prompts.pdfOcrUser(pageNumber),
    maxTokens: cfg.tokens.ocr,
    ...OCR_SAMPLING,
    timeoutMs: cfg.timeouts.ocrMs,
  });
  return cleanOcrText(text);
}

// kordoc OcrProvider: 텍스트 레이어 없는 PDF 페이지(PNG) → vision OCR → markdown.
// (배치 안전용 — 실패를 삼키고 "" 반환. 페이지 하나 실패가 문서 전체를 죽이지 않게.)
export async function vllmOcrPage(pageImage, pageNumber, mimeType = "image/png") {
  try {
    return await vllmOcrPageStrict(pageImage, pageNumber, mimeType);
  } catch (e) {
    console.warn(`[vllm-ocr] page ${pageNumber} failed:`, e?.message || e);
    return "";
  }
}

// vLLM 컨텍스트(이미지 토큰) 초과 — 같은 이미지를 다시 보내도 실패하므로 스케일을 낮춰야 한다.
function isContextOverflow(e) {
  return e?.status === 400 && /context|token|length|too large/i.test(e?.message || "");
}

// 업로드된 이미지 1장 → AI vision OCR → markdown. (배치와 달리 실패 시 throw)
export async function ocrImageBuffer(arrayBuffer, mimeType = "image/png") {
  const url = await toSafeImageUrl(arrayBuffer, mimeType);
  const text = await aiCall({
    image: url,
    system: prompts.imageOcrSystem,
    prompt: prompts.imageOcrUser,
    maxTokens: cfg.tokens.ocr,
    ...OCR_SAMPLING,
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

// PDF 렌더 핸들 (lazy). pdfjs-dist+canvas 는 이 환경에서 깨져 mupdf 사용.
// 페이지를 미리 전부 렌더하지 않고 worker 가 필요할 때 한 장씩 렌더한다(대형 스캔본 메모리 스파이크 방지).
// scaleFactor 는 컨텍스트 초과 시 재시도용 축소 배율(1 = 기본).
async function openPdfRenderer(arrayBuffer) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(new Uint8Array(arrayBuffer), "application/pdf");
  const pageCount = doc.countPages();
  return {
    pageCount,
    renderPage(pageNum, scaleFactor = 1) {
      const page = doc.loadPage(pageNum - 1);
      // 페이지 크기에 맞춰 유효 스케일 산출: 긴 변이 ocrMaxLongSidePx 를 넘지 않게 자동 축소.
      let w = 0, h = 0;
      try {
        const b = page.getBounds();
        const a = Array.isArray(b) ? b : [b.x0, b.y0, b.x1, b.y1];
        w = a[2] - a[0];
        h = a[3] - a[1];
      } catch { /* bounds 실패 시 기본 스케일 사용 */ }
      const longSide = Math.max(w, h);
      const capped = longSide > 0
        ? Math.min(cfg.render.ocrScale, cfg.render.ocrMaxLongSidePx / longSide)
        : cfg.render.ocrScale;
      const scale = Math.max(0.5, capped * scaleFactor);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB);
      return Buffer.from(pix.asPNG());
    },
  };
}

// 렌더 → OCR 1页. 컨텍스트 초과(400)면 0.7배로 줄여 1회 재시도. 그 외 실패는 "" (페이지 단위 격리).
async function ocrPageAdaptive(renderer, pageNum) {
  for (const factor of [1, 0.7]) {
    let png;
    try {
      png = renderer.renderPage(pageNum, factor);
    } catch (e) {
      console.warn(`[render] page ${pageNum} failed:`, e?.message || e);
      return "";
    }
    try {
      return await vllmOcrPageStrict(png, pageNum, "image/png");
    } catch (e) {
      if (factor === 1 && isContextOverflow(e)) {
        console.warn(`[vllm-ocr] page ${pageNum} 컨텍스트 초과 — 0.7배 축소 재시도`);
        continue;
      }
      console.warn(`[vllm-ocr] page ${pageNum} failed:`, e?.message || e);
      return "";
    }
  }
  return "";
}

// 스캔본(IMAGE_BASED_PDF) fallback: 전 페이지 lazy 렌더 → OCR → markdown 합성.
export async function ocrPdfBuffer(arrayBuffer, { onProgress, onPage } = {}) {
  const renderer = await openPdfRenderer(arrayBuffer);
  const pageCount = renderer.pageCount;
  const pageNums = Array.from({ length: pageCount }, (_, i) => i + 1);
  const texts = new Array(pageCount).fill("");
  let okCount = 0;
  let done = 0;

  await mapWithLimit(pageNums, cfg.concurrency.ocr, async (page, idx) => {
    onPage?.(page, pageCount);
    const clean = (await ocrPageAdaptive(renderer, page)).trim();
    if (clean) {
      texts[idx] = clean;
      okCount++;
    }
    onProgress?.(++done / (pageCount || 1));
  });

  const sections = pageNums
    .map((page, idx) =>
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

// 페이지별 블록 분포(중앙 접지선 48~52% 기준) — 펼침면/단일 가로 페이지 판별 증거.
// 진짜 펼침면: 좌우가 독립 레이아웃 → 횡단 비율이 낮고(≤0.35) 양쪽 모두에 블록이 있다.
// A4 가로 단일(공고문 등): 전폭 표/문단이 많아 횡단 비율 0.7+, 혹은 콘텐츠가 한쪽에 쏠림.
function spreadEvidence(blocks, dims) {
  const widthByPage = new Map(dims.map((d) => [d.page, d.w]));
  const stats = new Map(); // page -> { total, cross, left, right, fullWidth }
  for (const b of blocks || []) {
    if (!b.pageNumber || !b.bbox) continue;
    const W = widthByPage.get(b.pageNumber);
    if (!W) continue;
    const row = stats.get(b.pageNumber) || { total: 0, cross: 0, left: 0, right: 0, fullWidth: 0 };
    row.total++;
    const x0 = b.bbox.x, x1 = b.bbox.x + b.bbox.width;
    if (x0 < W * 0.48 && x1 > W * 0.52) row.cross++;
    else if (x1 <= W * 0.52) row.left++;
    else row.right++;
    // 페이지 폭의 10%~90% 를 가로지르는 전폭 블록 — 진짜 펼침면에는 물리적으로 불가능
    // (두 물리 페이지에 걸친 표/문단은 없음). 단일 가로 페이지의 결정적 증거.
    if (x0 < W * 0.1 && x1 > W * 0.9) row.fullWidth++;
    stats.set(b.pageNumber, row);
  }
  return stats;
}

export async function detectSpreadPages(arrayBuffer, blocks = null) {
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
  // 세로 기준 페이지가 없을 때(전부 가로형): A4 가로 단일(비율 1.41)과 A4 세로 2쪽
  // 펼침면(비율 1.41)은 기하만으로 구분 불가 → 블록 증거가 펼침면을 지지할 때만 인정.
  // 오탐(단일 가로 공고문을 반 가르기)이 미탐보다 훨씬 치명적이므로 보수적으로 판단한다.
  const evidence = portraitW ? null : spreadEvidence(blocks, dims);
  const spreadPages = new Set();
  for (const d of dims) {
    if (!(d.w > 0 && d.h > 0) || d.w <= d.h * 1.15) continue; // landscape 만 후보
    let isSpread;
    if (portraitW) {
      isSpread = d.w / portraitW >= 1.6 && d.w / portraitW <= 2.4; // ≈ 세로폭 2배 = 두 쪽
    } else {
      const ev = evidence?.get(d.page);
      isSpread =
        d.w / d.h >= 1.25 && d.w / d.h <= 1.6 // A-계열 2-up 비율
        && !!ev && ev.cross / ev.total <= 0.35 // 중앙 횡단 블록이 적고
        && ev.left >= 1 && ev.right >= 1 // 좌우 양쪽에 독립 콘텐츠가 있고
        && ev.fullWidth === 0; // 전폭 블록이 하나라도 있으면 단일 가로 페이지
    }
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
  const want = [...new Set((pageNumbers || []).filter((n) => n > 0))].sort((a, b) => a - b);
  if (!want.length) return new Map();
  const spreads = spreadPages instanceof Set ? spreadPages : new Set(spreadPages || []);
  const renderer = await openPdfRenderer(arrayBuffer);
  const totalUnits = want.reduce((s, p) => s + (spreads.has(p) ? 2 : 1), 0);

  const texts = new Map(); // page -> merged markdown
  let done = 0;
  await mapWithLimit(want, cfg.concurrency.ocr, async (page) => {
    // 일반 페이지(또는 분할 실패 fallback): 통짜 OCR.
    const wholePage = async () => {
      const t = (await ocrPageAdaptive(renderer, page)).trim();
      onPage?.(++done, totalUnits, page);
      if (t) texts.set(page, t);
    };

    if (!spreads.has(page)) return wholePage();

    // 펼침면: 한 번 렌더해 반으로 가르고 좌→우 순차 OCR (전역 동시성 한도 준수).
    let halves = null;
    try {
      halves = await splitPngHalves(renderer.renderPage(page));
    } catch (e) {
      console.warn(`[spread] page ${page} split 실패 → 통짜 OCR:`, e?.message || e);
    }
    if (!halves) return wholePage();

    const parts = [];
    for (let h = 0; h < 2; h++) {
      let text = "";
      try {
        text = await vllmOcrPageStrict(halves[h], page, "image/png");
      } catch (e) {
        if (isContextOverflow(e)) {
          console.warn(`[vllm-ocr] page ${page} half ${h} 컨텍스트 초과 — 0.7배 축소 재시도`);
          try {
            const smaller = await splitPngHalves(renderer.renderPage(page, 0.7));
            text = await vllmOcrPageStrict(smaller[h], page, "image/png");
          } catch (e2) {
            console.warn(`[vllm-ocr] page ${page} half ${h} failed:`, e2?.message || e2);
          }
        } else {
          console.warn(`[vllm-ocr] page ${page} half ${h} failed:`, e?.message || e);
        }
      }
      parts.push(String(text || "").trim());
      onPage?.(++done, totalUnits, page);
    }
    const merged = parts.filter(Boolean).join("\n\n");
    if (merged) texts.set(page, merged);
  });
  return texts;
}
