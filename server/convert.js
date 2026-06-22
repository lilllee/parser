// 변환 파이프라인: 파일 → kordoc 파싱 → (스캔본/펼침면) vision OCR 재추출 → 후처리 → 시각자료 enrich.
import { parse, blocksToMarkdown } from "kordoc";
import {
  detectSpreadPages,
  enrichMarkdown,
  ocrImageBuffer,
  ocrPdfBuffer,
  ocrSelectedPdfPages,
  hasBrokenTable,
  toSafeImageUrl,
} from "./vllm.js";
import { resolveAiConfig, withAiConfig, aiEnabled, aiVisionEnabled } from "./ai.js";
import { detectMangledPages } from "./detect.js";
import { postprocessMarkdown, hasCrammedTable, looksLikeTocTable, hasSentenceStuffedTable, hasDuplicatedColumns, comparePageNumbers } from "./postprocess.js";
import { collectInvisibleText, stripInvisibleFromBlocks } from "./invisible.js";
import { detectBoundaryIssues } from "../tests/quality.mjs";

// force_ocr 결정(공유): 요청 명시(force_ocr/forceOcr/ocr/mode=vision) > 서버 기본(FORCE_OCR env) > false.
// 실제 적용 대상은 _runConvert 가 결정 — PDF 만 force(이미지는 별도 vision, HWP/HWPX/DOCX 는 kordoc).
export function resolveForceOcr(body = {}) {
  const boolOf = (v) => (v == null || String(v).trim() === "" ? undefined : /^(1|true|on|yes)$/i.test(String(v)));
  let r = boolOf(body.force_ocr);
  if (r === undefined) r = boolOf(body.forceOcr);
  if (r === undefined) r = boolOf(body.ocr);
  if (r === undefined && String(body.mode || "").toLowerCase() === "vision") r = true;
  return r ?? (boolOf(process.env.FORCE_OCR) ?? false);
}

export async function runConvert(arrayBuffer, filename, sink = {}, aiConfig = resolveAiConfig()) {
  // MinerU 등 '문서 파서' 엔진은 파일을 통째 올려 한 번에 md 를 받는다 — kordoc/reflow/enrich 우회.
  if (aiConfig.provider?.parseDocument) {
    return documentParserConvert(arrayBuffer, filename, sink, aiConfig);
  }
  // 요청별 AI 설정을 컨텍스트에 깔아 내부 aiComplete 들이 같은 provider 를 쓰게 한다(ALS).
  return withAiConfig(aiConfig, () =>
    _runConvert(arrayBuffer, filename, sink, aiEnabled(aiConfig), aiVisionEnabled(aiConfig))
  );
}

// 문서 파서 엔진(MinerU 등): 파일 통째 업로드 → 전체 markdown. kordoc 파이프라인을 타지 않는다.
// 기본은 엔진 '원본' md 그대로 반환(육안 점검·비교용). cfg.postprocess=true 면 우리 후처리를 끼운다.
async function documentParserConvert(arrayBuffer, filename, sink, aiConfig) {
  const onPhase = sink.onPhase || (() => {});
  const onProgress = sink.onProgress || (() => {});
  const onWarning = sink.onWarning || (() => {});
  const { id, provider: p, cfg } = aiConfig;
  if (!p.enabled(cfg)) {
    const err = new Error(`${id} 엔진 미설정 — URL 을 확인하세요 (MINERU_URL 또는 요청 url).`);
    err.code = "ENGINE_DISABLED";
    throw err;
  }
  onPhase({ phase: "parse", message: `${id} 문서 파싱` });
  const r = await p.parseDocument(cfg, { buffer: arrayBuffer, filename, onPhase });
  const raw = r.markdown || "";
  const cleaned = cfg.postprocess ? postprocessMarkdown(raw) : raw;
  for (const w of detectBoundaryIssues(cleaned, filename).warnings) onWarning(w);
  onProgress({ progress: 1 });
  console.log(
    `[convert] ${filename} 완료 · ${id} · md ${cleaned.length}자${cfg.postprocess ? " (postprocess)" : " (raw)"}`
  );
  return {
    markdown: cleaned,
    metadata: r.metadata || { source: id },
    pageCount: r.pageCount ?? null,
  };
}

// enabled: 이 변환에서 AI(OCR/enrich)를 쓸 수 있는지 — 요청 provider 기준.
// vision: 이미지(vision) 호출을 써도 되는지 — claude-cli 텍스트 전용 모드면 false (aiVisionEnabled).
async function _runConvert(arrayBuffer, filename, sink, enabled, vision = true) {
  const onProgress = sink.onProgress || (() => {});
  const onPhase = sink.onPhase || (() => {});
  const onWarning = sink.onWarning || (() => {});
  // vision 단계(이미지 OCR·스캔본·reflow·이미지/차트 enrich)를 탈지 여부.
  const visionOk = enabled && vision;

  // ── 이미지 파일(PNG/JPG 등) → AI vision OCR 직행 (kordoc 우회) ──────────────
  const imageMime = imageMimeFromName(filename);
  if (imageMime) {
    if (!enabled) {
      const err = new Error("이미지 OCR 에는 AI provider 가 필요합니다 (provider / 설정 확인).");
      err.code = "AI_REQUIRED";
      throw err;
    }
    if (!vision) {
      const err = new Error(
        "이미지 파일 OCR 에는 vision provider 가 필요합니다 — claude-cli 는 텍스트 전용 모드입니다. " +
          "vllm/bedrock/anthropic 를 쓰거나 CLAUDE_CLI_VISION=1 로 켜세요."
      );
      err.code = "VISION_REQUIRED";
      throw err;
    }
    onPhase({ phase: "ocr", message: "이미지 vision OCR" });
    const md = await ocrImageBuffer(arrayBuffer, imageMime);
    let cleaned = postprocessMarkdown(md || "");
    // OCR 은 전사만 하므로 차트/그림 해설은 enrich(page-visual)가 담당 — 이미지 자체를 입력으로 공급.
    try {
      const imageUrl = await toSafeImageUrl(arrayBuffer, imageMime);
      const er = await enrichMarkdown(cleaned, [], {
        visualPages: [{ page: 1, image: imageUrl, blocks: [{ content: cleaned }] }],
        onNote: (note) => onPhase({ phase: "enrich", message: note }),
      });
      cleaned = er.markdown;
    } catch (e) {
      console.warn("[convert] 이미지 enrich 실패:", e?.message || e);
    }
    for (const w of detectBoundaryIssues(cleaned, filename).warnings) onWarning(w);
    onProgress({ progress: 1 });
    console.log(`[convert] ${filename} 완료 · 이미지 OCR · md ${cleaned.length}자`);
    return { markdown: cleaned, metadata: { source: "image-ocr", mimeType: imageMime }, pageCount: 1 };
  }

  // ── 강제 전체페이지 vision OCR (kordoc 우회) ─────────────────────────────────
  // kordoc 텍스트레이어 추출이 dense 한 한국어 표를 '열 뜯김 / 표→산문 / 숫자·문장부호 공백오염'으로
  // 망치는 문서가 있다(정부문서 다수). reflow 게이트가 그 손상을 매번 잡지 못하므로(두더지잡기 한계),
  // 이 모드는 게이트를 거치지 않고 모든 페이지를 렌더해 vision 으로 직접 전사한다(순수비전 전략 +
  // 우리 postprocess·차트/그림 enrich). PDF 에만 적용 — 그 외 포맷은 ocrPdfBuffer 가 렌더 불가.
  if (sink.forceOcr && isPdfName(filename)) {
    if (!enabled) {
      const err = new Error("강제 vision OCR 에는 AI provider 가 필요합니다 (provider / 설정 확인).");
      err.code = "AI_REQUIRED";
      throw err;
    }
    if (!vision) {
      const err = new Error(
        "강제 vision OCR 에는 vision provider 가 필요합니다 — claude-cli 텍스트 전용 모드 불가. " +
          "vllm/bedrock/anthropic 사용 또는 CLAUDE_CLI_VISION=1."
      );
      err.code = "VISION_REQUIRED";
      throw err;
    }
    onPhase({ phase: "ocr", message: "강제 전체페이지 vision OCR (kordoc 우회)" });
    const kordocBuf = arrayBuffer.slice(0); // 숫자 대조 검증용 kordoc 사본(ocrPdfBuffer 가 원본을 소비)
    const r = await ocrPdfBuffer(arrayBuffer, {
      onPage: (i, total) => onPhase({ phase: "ocr", message: `OCR 페이지 ${i}/${total}` }),
      onProgress: (p) => onProgress({ phase: "ocr", progress: p * 0.5 }),
    });
    let cleaned = postprocessMarkdown(r.markdown || "[OCR 결과 없음]");
    let enrichStats = null;
    if (enabled) {
      onPhase({ phase: "enrich", message: "시각 자료 분석" });
      const er = await enrichMarkdown(cleaned, [], {
        onProgress: (p) => onProgress({ phase: "enrich", progress: 0.5 + p * 0.5 }),
        onNote: (note) => onPhase({ phase: "enrich", message: note }),
        visualPages: r.visualPages || [], // 전사 후 차트/그림 해설용 페이지 이미지
        vision,
      });
      cleaned = er.markdown;
      enrichStats = { enriched: er.enriched, skipped: er.skipped, failed: er.failed, total: er.total };
    }
    // 페이지별 숫자 검증: vision(구조 좋음)이 숫자를 오독했는지 kordoc 텍스트레이어(숫자 정확)와 대조.
    // 안 깨지면 vision 그대로 채택, 깨진 페이지는 그 숫자를 경고로 표면화(출력은 유지 — 육안 확인용).
    let verification = null;
    try {
      onPhase({ phase: "verify", message: "kordoc 숫자 대조 검증" });
      const kr = await parse(kordocBuf, {});
      // 페이지별 블록 → blocksToMarkdown 로 텍스트화. 표 셀 숫자까지 포함해야(표는 table 블록 구조라
      // b.content 엔 없음) 예산표 등 숫자가 ground-truth 에 들어온다.
      const kBlocksByPage = new Map();
      for (const b of kr.blocks || []) {
        if (!kBlocksByPage.has(b.pageNumber)) kBlocksByPage.set(b.pageNumber, []);
        kBlocksByPage.get(b.pageNumber).push(b);
      }
      const kByPage = new Map();
      for (const [pn, blks] of kBlocksByPage) kByPage.set(pn, blocksToMarkdown(blks));
      verification = (r.pageTexts || []).map((vt, i) => ({
        page: i + 1,
        ...comparePageNumbers(kByPage.get(i + 1) || "", vt || ""),
      }));
      const mismatches = verification.filter((v) => !v.ok && !v.unverified);
      for (const v of mismatches) {
        onWarning({
          code: "NUMERIC_MISMATCH",
          message:
            `p${v.page} 숫자 검증 — vision 이 kordoc 확인 숫자를 잃음/오독 의심: 누락 ${JSON.stringify(v.missing.slice(0, 10))}` +
            (v.extra.length ? ` (참고: vision 에만 있는 숫자 ${JSON.stringify(v.extra.slice(0, 6))})` : "") +
            ` — vision 출력 유지, 육안 확인 권장`,
        });
      }
      const okN = verification.filter((v) => v.ok && !v.unverified).length;
      const unv = verification.filter((v) => v.unverified).length;
      console.log(
        `[verify] ${filename} · 숫자대조 ok ${okN} / 불일치 ${mismatches.length} / 무근거(스캔) ${unv}`
      );
    } catch (e) {
      console.warn("[verify] kordoc 대조 실패:", e?.message || e);
    }
    for (const w of detectBoundaryIssues(cleaned, filename).warnings) onWarning(w);
    onProgress({ progress: 1 });
    console.log(
      `[convert] ${filename} 완료 · 강제 vision OCR · md ${cleaned.length}자 · ${r.ocrPages}/${r.pageCount}p` +
        (enrichStats ? ` · enrich ${enrichStats.enriched}/${enrichStats.total}` : "")
    );
    return {
      markdown: cleaned,
      metadata: {
        source: "force-ocr",
        ocr: { pages: r.pageCount, recognized: r.ocrPages },
        visualPagesFound: (r.visualPages || []).length,
        enrich: enrichStats,
        verification,
      },
      pageCount: r.pageCount,
    };
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
  // page-visual enrich 입력(차트/그림 해설용). 스캔본 OCR 경로에서만 채워진다.
  let visualPages = [];
  const isImageBasedPdf =
    (!result.success && result.code === "IMAGE_BASED_PDF") ||
    (result.fileType === "pdf" && result.isImageBased === true && !(result.blocks || []).length);
  if (isImageBasedPdf && !enabled) {
    const err = new Error("이미지 기반 PDF (텍스트 레이어 없음) — OCR 에 AI provider 가 필요합니다.");
    err.code = "IMAGE_BASED_PDF";
    throw err;
  }
  if (isImageBasedPdf && enabled && !vision) {
    const err = new Error(
      "이미지 기반 PDF (텍스트 레이어 없음) OCR 에는 vision provider 가 필요합니다 — " +
        "claude-cli 텍스트 전용 모드. vllm/bedrock 사용 또는 CLAUDE_CLI_VISION=1."
    );
    err.code = "VISION_REQUIRED";
    throw err;
  }
  if (isImageBasedPdf && visionOk) {
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
    visualPages = r.visualPages || [];

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

  // 보이지 않는 텍스트(흰 배경 흰 글자 등 — kordoc 이 텍스트 레이어에서 그대로 떠온 것) 제거.
  // mangled 감지/재추출보다 먼저 해서 정리된 블록이 이후 단계에 흐르게 한다.
  if (result.fileType === "pdf" && (result.blocks || []).length) {
    try {
      const invis = collectInvisibleText(rawBackup.slice(0));
      if (invis.size) {
        const { blocks, removed } = stripInvisibleFromBlocks(result.blocks, invis);
        if (removed) {
          result.blocks = blocks;
          result.markdown = blocksToMarkdown(result.blocks);
          console.log(`[invisible] ${filename} · 숨은 텍스트 ${removed}블록 정리`);
        }
      }
    } catch (e) {
      console.warn("[invisible] failed:", e?.message || e);
    }
  }

  // 텍스트 전용 모드(claude-cli 등): vision 재추출/이미지·차트 분석을 건너뜀을 알린다.
  // 깨진 레이아웃·차트 페이지는 kordoc 출력 그대로 유지된다(품질 저하 가능 — 의도된 트레이드오프).
  if (enabled && !vision && result.fileType === "pdf") {
    onWarning({
      message: "텍스트 전용 모드 — vision 재추출·이미지/차트 분석을 건너뜁니다 (kordoc 출력 유지). vision 을 켜려면 CLAUDE_CLI_VISION=1.",
      code: "TEXT_ONLY_MODE",
    });
  }

  // 망가진/펼침면 페이지만 골라 vision OCR 로 재추출해 교체 (reflow).
  let reflowInfo = null;
  if (visionOk && !ocrInfo && result.fileType === "pdf" && (result.blocks || []).length) {
    // kordoc 는 PDF 페이지 수를 metadata.pageCount 에 넣으므로 fallback — 안 하면 0 이 전달돼
    // detectLowDensityPages(블록 0개인 빈 페이지 감지)가 무력화된다.
    const pageCount = result.pageCount ?? result.metadata?.pageCount ?? 0;
    const mangled = detectMangledPages(result.blocks, pageCount);
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
    // kordoc 가 이미 유효한 병합표(colspan/rowspan + 안 깨짐)를 만든 '표 위주' 페이지는 vision OCR 로
    // 개선되기보다 깨질 확률이 높다(예: 24열 보육료 그리드 — 일반 VLM 으로 재현 불가). 헛도는 재시도·
    // 토큰 잘림을 막고 kordoc + postprocess(과분할 표 정규화)를 신뢰해 reflow 대상에서 제외한다.
    // 펼침면(좌우 분할)과 본문이 충분한(prose 많은) 페이지는 면제 — 표만 보고 텍스트 보정을 건너뛰지 않게.
    const blocksByPage = new Map();
    for (const b of result.blocks || []) {
      if (!blocksByPage.has(b.pageNumber)) blocksByPage.set(b.pageNumber, []);
      blocksByPage.get(b.pageNumber).push(b);
    }
    // kordoc 이 2D 레이아웃(목차 등)을 망친 페이지: '크램드 표'(몇 셀에 <br> 로 뭉갬) 또는 목차가
    // 표로 떠져 제목이 컬럼에 쪼개진 것. detectMangledPages 가 잡아도 게이트가 '결함 아님'으로 스킵하나,
    // vision 이 2D 구조(라벨↔제목↔페이지 정렬)를 복원하므로 reflow 대상에 추가한다. (올바른 출력은
    // 표가 아니라 리스트이므로 아래 expectedTables 에서 제외.)
    const crammedPages = new Set();
    for (const [pn, blks] of blocksByPage) {
      const pmd = blocksToMarkdown(blks);
      if (hasCrammedTable(pmd) || looksLikeTocTable(pmd)) crammedPages.add(pn);
    }
    for (const pn of crammedPages) if (!mangled.includes(pn)) mangled.push(pn);
    mangled.sort((a, b) => a - b);

    // 펼침면 분할(vision)은 '텍스트 레이어가 없는' 스캔 펼침면이나 구조가 깨진 경우에만 적용한다.
    // 텍스트 레이어가 있는 펼침면(예: 포켓북)은 kordoc 텍스트가 RAG 에 더 정확하고(숫자·용어 오독 없음),
    // 좌우 컬럼 병합 같은 읽기순서 흐트러짐은 다운스트림 AI 분석이 복구 가능하다. 반면 vision 분할은
    // 숫자·이름 오독을 유입해 복구 불가한 사실 오류를 낸다 → 텍스트 레이어가 있으면 kordoc 우선.
    const pageTextLen = (pn) =>
      (blocksByPage.get(pn) || []).reduce((s, b) => s + String(b.content || b.text || "").length, 0);
    const TEXT_LAYER_MIN = Number(process.env.VLLM_SPREAD_TEXT_MIN ?? 80);
    const spreadForOcr = new Set(
      [...spreadPages].filter((pn) => {
        // 텍스트 레이어가 있는 펼침면은 kordoc 텍스트(정확한 숫자·용어)를 유지한다 — 구조가 다소
        // 흐트러져도(좌우 컬럼 병합 등) RAG 엔 vision 의 숫자/이름 오독보다 낫고, 읽기순서는
        // 다운스트림 AI 분석이 복구한다. 텍스트 레이어가 없는(스캔) 펼침면만 vision 분할 OCR —
        // 그 페이지는 kordoc 대안 자체가 없다.
        if (pageTextLen(pn) >= TEXT_LAYER_MIN) {
          console.log(`[reflow] p${pn} 펼침면+텍스트레이어 — vision 분할 생략(kordoc 텍스트 유지)`);
          return false;
        }
        return true;
      })
    );
    const mangledForOcr = mangled.filter((pn) => {
      if (spreadPages.has(pn)) return spreadForOcr.has(pn); // 펼침면은 텍스트레이어/구조에 따라 결정
      const blks = blocksByPage.get(pn) || [];
      const maxCols = Math.max(0, ...blks.filter((b) => b.type === "table").map((b) => b.table?.cols || 0));
      const pmd = blocksToMarkdown(blks);
      const broken = hasBrokenTable(pmd);
      // 매우 넓은 병합 그리드(예: 24열 보육료표)는 일반 VLM 이 열 수를 일관되게 재현하지 못해 vision
      // 으로 보내봐야 깨지고 kordoc 으로 되돌아온다 → 안 깨졌으면 vision 생략, kordoc+postprocess 신뢰.
      if (maxCols >= 10 && !broken) {
        console.log(`[reflow] p${pn} 광폭(${maxCols}열) 병합표 — vision 생략(kordoc+postprocess 신뢰)`);
        return false;
      }
      // vision reflow 는 텍스트 레이어의 한글 띄어쓰기·숫자를 오히려 망친다(실측: reflow PDF recall
      // 91~95% vs 스킵 99%). 그래서 kordoc 출력이 '실제로 결함'일 때만 reflow 한다: 표 깨짐 /
      // 산산조각(빈 셀 과다) / 한글 무공백 뭉침. 그 외 깨끗한 페이지는 detectMangledPages 가
      // 잡았더라도 kordoc 텍스트를 유지(오탐 — vision 이 오히려 충실도를 낮춤).
      // 참고: 값 뭉침(crammed)처럼 '구조만' 나쁜 표는 여기서 스킵되어 vision 교정을 받지 못한다.
      // 내용 보존을 우선한 트레이드오프이며, 필요 시 이 게이트를 완화한다.
      const deficient = broken || emptyCellRatio(pmd) >= 0.35 || NOSPACE_RUN.test(pmd) || crammedPages.has(pn) || hasSentenceStuffedTable(pmd) || hasDuplicatedColumns(pmd);
      if (!deficient) {
        console.log(`[reflow] p${pn} kordoc 출력 양호 — vision 생략(텍스트 충실도 보존)`);
        return false;
      }
      return true;
    });
    const targets = [...new Set([...mangledForOcr, ...spreadForOcr])].sort((a, b) => a - b);
    if (targets.length) {
      onPhase({
        phase: "ocr",
        message: `vision 재추출 ${targets.length}p (펼침면 ${spreadForOcr.size}/${spreadPages.size} · 레이아웃 ${mangledForOcr.length})`,
      });
      // kordoc 가 각 대상 페이지에서 본 '실제 표(2x2 이상)' 개수 — vision 이 표를 빠뜨리면
      // (개수 부족) 재시도하게 한다. 펼침면은 좌우로 나뉘므로 개수 비교가 부정확해 제외.
      // 크램드 표(목차 등)는 올바른 출력이 리스트이므로 표 개수 기대에서 제외 — 안 그러면 vision 이
      // 리스트로 잘 푼 것을 '표 누락'으로 오판해 표로 되돌리거나 kordoc 으로 폴백한다.
      const expectedTables = new Map();
      const targetSet = new Set(targets);
      for (const b of result.blocks || []) {
        if (b.type !== "table" || !targetSet.has(b.pageNumber) || spreadForOcr.has(b.pageNumber) || crammedPages.has(b.pageNumber)) continue;
        if ((b.table?.rows || 0) >= 2 && (b.table?.cols || 0) >= 2) {
          expectedTables.set(b.pageNumber, (expectedTables.get(b.pageNumber) || 0) + 1);
        }
      }
      try {
        const texts = await ocrSelectedPdfPages(rawBackup.slice(0), targets, {
          spreadPages: spreadForOcr,
          expectedTables,
          onPage: (i, total, pn) =>
            onPhase({ phase: "ocr", message: `vision 재추출 ${i}/${total} (p${pn})` }),
        });
        // 재시도까지 했는데도 표가 깨진(병합/중첩 표를 markdown 으로 누른) 페이지는, kordoc 가
        // 그 페이지에 블록(보통 유효 HTML 표)을 갖고 있으면 reflow 하지 않고 kordoc 출력을 유지한다
        // — 깨진 vision 표가 멀쩡한 kordoc 표를 덮어쓰는 것 방지. (kordoc 가 빈 페이지였다면 그래도
        // vision 결과가 유일한 출력이므로 유지.)
        const kordocPages = new Set((result.blocks || []).map((b) => b.pageNumber));
        for (const [pn, txt] of [...texts]) {
          if (hasBrokenTable(txt) && kordocPages.has(pn)) {
            texts.delete(pn);
            console.warn(`[reflow] p${pn} 표 깨짐 지속 — kordoc 출력 유지(vision 폐기)`);
          }
        }
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
      visualPages, // 스캔본 OCR 시 캡처한 차트/그림 페이지 이미지(전사 후 해설 담당).
      vision, // 텍스트 전용 모드면 이미지/차트 target 은 건너뛰고 표 텍스트 분석만.
    });
    cleaned = r.markdown;
    enrichStats = {
      enriched: r.enriched,
      skipped: r.skipped,
      failed: r.failed,
      total: r.total,
    };
  }

  // 청크 경계 완전성 경고(조사/표/조문 미완, 페이지 구간 파일명) — 변환 실패는 아니지만 표면화.
  for (const w of detectBoundaryIssues(cleaned, filename).warnings) onWarning(w);

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

// reflow 된 페이지를 OCR 텍스트 블록으로 치환(순서·union bbox 유지).
// kordoc 가 블록 0개로 떤 페이지(빈 페이지)라도 OCR 결과가 있으면 올바른 페이지 순서 위치에
// 삽입한다 — 예전엔 원본 블록만 순회해 교체했기에, 교체할 원본 블록이 없는 빈 페이지의 OCR
// 텍스트가 통째로 누락됐다. (export 는 단위 테스트용)
export function reflowBlocksWithOcr(blocks, texts) {
  // 페이지별 원본 블록 그룹(원본 순서 유지) + OCR 대상 페이지의 bbox 합집합.
  const byPage = new Map();
  const bboxByPage = new Map();
  for (const b of blocks) {
    if (!byPage.has(b.pageNumber)) byPage.set(b.pageNumber, []);
    byPage.get(b.pageNumber).push(b);
    if (texts.has(b.pageNumber) && b.bbox) {
      bboxByPage.set(b.pageNumber, unionBbox(bboxByPage.get(b.pageNumber), b.bbox));
    }
  }
  // 출력 페이지 순서 = (원본 블록 페이지 ∪ OCR 페이지) 오름차순 — 빈 페이지의 OCR 도 포함.
  const pages = [...new Set([...byPage.keys(), ...texts.keys()])].sort((a, b) => a - b);
  const out = [];
  for (const pn of pages) {
    if (texts.has(pn)) {
      const bbox = bboxByPage.get(pn);
      const chunks = String(texts.get(pn)).split(/\n{2,}/).map((t) => t.trim()).filter(Boolean);
      for (const chunk of chunks.length ? chunks : [texts.get(pn)]) {
        out.push({ type: "paragraph", text: chunk, pageNumber: pn, bbox });
      }
    } else {
      out.push(...byPage.get(pn));
    }
  }
  return out;
}

// kordoc 페이지 출력이 '실제로 결함'인지 판정 — reflow(vision 재추출) 가치가 있는 페이지만 거른다.
// vision 은 텍스트 레이어의 한글 띄어쓰기·숫자를 오히려 망치므로(실측: reflow PDF recall 91~95%
// vs 스킵 99%), 깨끗한 페이지는 kordoc 텍스트를 유지하는 편이 매칭율이 높다.
const NOSPACE_RUN = /[가-힣][가-힣,()·]{24,}/; // 한글 무공백 뭉침(kordoc 띄어쓰기 소실)
function emptyCellRatio(md) {
  const tdTotal = (md.match(/<td\b[^>]*>/gi) || []).length;
  const tdEmpty = (md.match(/<td\b[^>]*>\s*<\/td>/gi) || []).length;
  let pipeTotal = 0, pipeEmpty = 0;
  for (const line of String(md).split("\n")) {
    if (!/^\s*\|.*\|\s*$/.test(line) || /^\s*\|?\s*:?-{2,}/.test(line)) continue; // 데이터행만(구분행 제외)
    const cells = line.split("|").slice(1, -1);
    pipeTotal += cells.length;
    pipeEmpty += cells.filter((c) => !c.trim()).length;
  }
  const total = tdTotal + pipeTotal;
  return total ? (tdEmpty + pipeEmpty) / total : 0;
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

function isPdfName(name) {
  return String(name || "").toLowerCase().endsWith(".pdf");
}
