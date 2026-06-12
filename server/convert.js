// 변환 파이프라인: 파일 → kordoc 파싱 → (스캔본/펼침면) vision OCR 재추출 → 후처리 → 시각자료 enrich.
import { parse, blocksToMarkdown } from "kordoc";
import {
  detectSpreadPages,
  enrichMarkdown,
  ocrImageBuffer,
  ocrPdfBuffer,
  ocrSelectedPdfPages,
} from "./vllm.js";
import { resolveAiConfig, withAiConfig, aiEnabled } from "./ai.js";
import { detectMangledPages } from "./detect.js";
import { postprocessMarkdown } from "./postprocess.js";

export async function runConvert(arrayBuffer, filename, sink = {}, aiConfig = resolveAiConfig()) {
  // 요청별 AI 설정을 컨텍스트에 깔아 내부 aiComplete 들이 같은 provider 를 쓰게 한다(ALS).
  return withAiConfig(aiConfig, () => _runConvert(arrayBuffer, filename, sink, aiEnabled(aiConfig)));
}

// enabled: 이 변환에서 AI(OCR/enrich)를 쓸 수 있는지 — 요청 provider 기준.
async function _runConvert(arrayBuffer, filename, sink, enabled) {
  const onProgress = sink.onProgress || (() => {});
  const onPhase = sink.onPhase || (() => {});
  const onWarning = sink.onWarning || (() => {});

  // ── 이미지 파일(PNG/JPG 등) → AI vision OCR 직행 (kordoc 우회) ──────────────
  const imageMime = imageMimeFromName(filename);
  if (imageMime) {
    if (!enabled) {
      const err = new Error("이미지 OCR 에는 AI provider 가 필요합니다 (provider / 설정 확인).");
      err.code = "AI_REQUIRED";
      throw err;
    }
    onPhase({ phase: "ocr", message: "이미지 vision OCR" });
    const md = await ocrImageBuffer(arrayBuffer, imageMime);
    const cleaned = postprocessMarkdown(md || "");
    onProgress({ progress: 1 });
    console.log(`[convert] ${filename} 완료 · 이미지 OCR · md ${cleaned.length}자`);
    return { markdown: cleaned, metadata: { source: "image-ocr", mimeType: imageMime }, pageCount: 1 };
  }

  // parse 단계: AI 활성화 시 0~0.5, 아니면 0~1
  const parseShare = enabled ? 0.5 : 1.0;
  // kordoc 가 arrayBuffer 를 detach 하므로 OCR fallback + parsed view 용 사본 확보
  const rawBackup = arrayBuffer.slice(0);
  let result = await parse(arrayBuffer, {
    onProgress: (current, total) => {
      if (total > 0) {
        onProgress({
          phase: "parse",
          progress: (current / total) * parseShare,
          current,
          total,
        });
      }
    },
  });
  // 스캔본(텍스트 레이어 없는 PDF) → 자체 OCR fallback.
  // kordoc 2.x 는 이미지 PDF 를 success:false + code:"IMAGE_BASED_PDF" 로 반환했지만,
  // 3.0+ 는 success:true + isImageBased:true + 빈 markdown + warnings[NEEDS_OCR] 로 바뀌었다.
  // (CHANGELOG 3.0.0 "NEEDS_OCR 경고 정식화") 둘 다 잡지 않으면 빈 결과가 그대로 나간다.
  let ocrInfo = null;
  const isImageBasedPdf =
    (!result.success && result.code === "IMAGE_BASED_PDF") ||
    (result.fileType === "pdf" && result.isImageBased === true && !(result.blocks || []).length);
  if (isImageBasedPdf && !enabled) {
    const err = new Error("이미지 기반 PDF (텍스트 레이어 없음) — OCR 에 AI provider 가 필요합니다.");
    err.code = "IMAGE_BASED_PDF";
    throw err;
  }
  if (isImageBasedPdf && enabled) {
    onPhase({ phase: "ocr", message: "텍스트 레이어 없음 — vLLM vision OCR 진입" });
    const r = await ocrPdfBuffer(rawBackup, {
      onPage: (i, total) =>
        onPhase({ phase: "ocr", message: `OCR 페이지 ${i}/${total}` }),
      onProgress: (p) =>
        onProgress({ phase: "ocr", progress: p * parseShare }),
    });
    console.log(
      `[ocr-fallback] ${filename} · ${r.ocrPages}/${r.pageCount} 페이지 인식`
    );
    ocrInfo = { pages: r.pageCount, recognized: r.ocrPages };

    result = {
      success: true,
      fileType: "pdf",
      markdown: r.markdown || "[OCR 결과 없음]",
      blocks: [],
      metadata: result.metadata || {},
      images: [],
      warnings: [],
      pageCount: r.pageCount,
      isImageBased: true,
    };
  }

  if (!result.success) {
    const err = new Error(result.error || "kordoc 변환 실패");
    err.code = result.code;
    throw err;
  }

  for (const w of result.warnings || []) {
    onWarning({ message: w.message || String(w), code: w.code });
  }

  // 망가진/펼침면 페이지만 골라 vision OCR 로 재추출해 교체 (reflow).
  let reflowInfo = null;
  if (enabled && !ocrInfo && result.fileType === "pdf" && (result.blocks || []).length) {
    const mangled = detectMangledPages(result.blocks, result.pageCount || 0);
    const qualityOcr = (result.pageQuality || []).filter((q) => q.needsOcr).map((q) => q.page);
    if (qualityOcr.length) {
      console.log(`[quality] kordoc needsOcr 페이지: ${qualityOcr.join(",")}`);
      for (const pn of qualityOcr) if (!mangled.includes(pn)) mangled.push(pn);
      mangled.sort((a, b) => a - b);
    }
    // 펼침면(2-page spread)은 단어가 멀쩡해 텍스트 신호로 안 잡히므로 페이지 기하로 추가 감지.
    let spreadPages = new Set();
    try {
      ({ spreadPages } = await detectSpreadPages(rawBackup.slice(0), result.blocks));
    } catch (e) {
      console.warn("[spread] detect failed:", e?.message || e);
    }
    const targets = [...new Set([...mangled, ...spreadPages])].sort((a, b) => a - b);
    if (targets.length) {
      onPhase({
        phase: "ocr",
        message: `vision 재추출 ${targets.length}p (펼침면 ${spreadPages.size} · 레이아웃 ${mangled.length})`,
      });
      try {
        const texts = await ocrSelectedPdfPages(rawBackup.slice(0), targets, {
          spreadPages,
          onPage: (i, total, pn) =>
            onPhase({ phase: "ocr", message: `vision 재추출 ${i}/${total} (p${pn})` }),
        });
        if (texts.size) {
          result.blocks = reflowBlocksWithOcr(result.blocks, texts);
          result.markdown = blocksToMarkdown(result.blocks);
          reflowInfo = {
            detected: targets.length,
            reflowed: texts.size,
            spreads: spreadPages.size,
            mangled: mangled.length,
          };
          console.log(
            `[reflow] ${filename} · ${texts.size}/${targets.length} 페이지 vision 재추출 (펼침면 ${spreadPages.size}, 레이아웃 ${mangled.length})`
          );
        }
      } catch (e) {
        console.warn("[reflow] failed:", e?.message || e);
      }
    }
  }

  let cleaned = postprocessMarkdown(result.markdown);

  let enrichStats = null;
  if (enabled) {
    onPhase({ phase: "enrich", message: "시각 자료 vLLM 분석 시작" });
    const r = await enrichMarkdown(cleaned, result.images || [], {
      onProgress: (p) => onProgress({ phase: "enrich", progress: 0.5 + p * 0.5 }),
      onNote: (note) => onPhase({ phase: "enrich", message: note }),
      visualPages: [],
    });
    cleaned = r.markdown;
    enrichStats = {
      enriched: r.enriched,
      skipped: r.skipped,
      failed: r.failed,
      total: r.total,
    };
  }

  onProgress({ progress: 1 });

  console.log(
    `[convert] ${filename} 완료 · md ${cleaned.length}자 · images ${(result.images || []).length}` +
      (ocrInfo ? ` · ocr ${ocrInfo.recognized}/${ocrInfo.pages}` : "") +
      (reflowInfo ? ` · reflow ${reflowInfo.reflowed}/${reflowInfo.detected}p` : "") +
      (enrichStats
        ? ` · enrich ${enrichStats.enriched}/${enrichStats.total} (skip ${enrichStats.skipped}, fail ${enrichStats.failed})`
        : "")
  );

  return {
    markdown: cleaned,
    metadata: result.metadata || {},
    // PDF 는 result.pageCount, HWP/XLSX 등은 metadata.pageCount 에 들어가므로 fallback.
    pageCount: result.pageCount ?? result.metadata?.pageCount ?? null,
  };
}

// reflow 된 페이지의 블록들을 OCR 텍스트 블록들로 치환(순서·union bbox 유지).
function reflowBlocksWithOcr(blocks, texts) {
  const bboxByPage = new Map();
  for (const b of blocks) {
    if (!texts.has(b.pageNumber) || !b.bbox) continue;
    bboxByPage.set(b.pageNumber, unionBbox(bboxByPage.get(b.pageNumber), b.bbox));
  }
  const out = [];
  const emitted = new Set();
  for (const b of blocks) {
    const pn = b.pageNumber;
    if (texts.has(pn)) {
      if (!emitted.has(pn)) {
        const bbox = bboxByPage.get(pn);
        const chunks = String(texts.get(pn)).split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
        for (const chunk of chunks.length ? chunks : [texts.get(pn)]) {
          out.push({ type: "paragraph", text: chunk, pageNumber: pn, bbox });
        }
        emitted.add(pn);
      }
      continue;
    }
    out.push(b);
  }
  return out;
}

function unionBbox(a, b) {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { page: a.page ?? b.page, x, y, width: right - x, height: bottom - y };
}

// 파일명 확장자로 이미지 mime 판별 (이미지면 mime 문자열, 아니면 null).
const IMAGE_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};
function imageMimeFromName(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  return IMAGE_MIME[ext] || null;
}
