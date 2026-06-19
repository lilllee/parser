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
  { onProgress, onNote, visualPages, vision = true } = {}
) {
  if (!markdown) return empty(markdown);

  const imageMap = new Map();
  for (const img of images || []) {
    if (!img?.filename || !img?.data) continue;
    const url = await toSafeImageUrl(img.data, img.mimeType);
    imageMap.set(img.filename, url);
    imageMap.set(normalizeImageRef(img.filename), url);
  }

  // 텍스트 전용 모드(claude-cli 등): 이미지/차트(page-visual) target 은 vision 호출이라 제외하고
  // 텍스트만 보는 표 분석(table)만 남긴다. (table 분석 자체는 VLLM_TABLE_ANALYSIS=1 일 때만 생성됨)
  let targets = findTargets(markdown, imageMap, visualPages);
  // flowchart 는 텍스트 입력(표→mermaid)이라 vision 없이도 가능 → 텍스트 전용 모드에서도 유지.
  if (!vision) targets = targets.filter((t) => t.type === "table" || t.type === "flowchart");
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
          : t.type === "flowchart"
            ? `흐름도 변환 ${idx + 1}/${targets.length}`
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

  // 결과 적용(끝에서부터 — 인덱스 안 깨지게): flowchart 는 표를 mermaid 로 '교체',
  // 나머지는 target 바로 뒤에 분석 블록 '삽입'.
  const edits = targets
    .map((t, i) => {
      if (!results[i]) return null;
      const after = t.index + t.length;
      return t.type === "flowchart"
        ? { start: t.index, end: after, piece: formatMermaid(results[i]) }
        : { start: after, end: after, piece: formatInsertion(results[i]) };
    })
    .filter(Boolean)
    .sort((a, b) => b.start - a.start);

  let out = markdown;
  for (const e of edits) {
    out = out.slice(0, e.start) + e.piece + out.slice(e.end);
  }

  return { markdown: out, enriched, skipped, failed, total: targets.length };
}

// 분석 응답 → 삽입 블록. 응답에 표(markdown |…| / HTML <table>)가 있으면 표는 그대로
// 살리고 산문 줄만 "> " 인용으로 감싼다. 표가 없으면 기존처럼 한 줄 인용.
// (export 는 단위 테스트용)
export function formatInsertion(text) {
  // 일부 provider 가 분석을 #헤딩·---구분선·소제목으로 과포장한다 — 인용 블록 안에서 깨져 보이므로
  // 헤딩 마커는 평문화하고 수평선 줄은 제거한다(표는 보존). 프롬프트로도 막지만 방어적으로 한 번 더.
  const t = String(text || "")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

// ── 흐름도(flowchart) → mermaid ──────────────────────────────────────────────
// kordoc 은 HWP/PDF 의 단계 흐름도를 '화살표 글리프(⇨⇩⇦ 등)가 든 표'로 떠온다. 이는 데이터 표가
// 아니라 흐름도이므로 mermaid 로 변환한다. 표 안에 단계 텍스트+방향이 다 들어있어 페이지 이미지
// 없이도(HWP 포함) 텍스트만으로 변환 가능하다.
const FLOW_ARROW_G = /[⇨⇦⇧⇩⟶⟵→←↑↓➡➜➞⬇⬆⬅▶►▼◀]/g;

// 여는 <table> 다음 위치(fromIdx)부터 짝이 맞는 </table> 끝 인덱스를 찾는다(중첩 표 고려).
function matchTableEnd(md, fromIdx) {
  const re = /<\/?table\b[^>]*>/gi;
  re.lastIndex = fromIdx;
  let depth = 1;
  let m;
  while ((m = re.exec(md)) !== null) {
    if (/^<\//.test(m[0])) { if (--depth === 0) return re.lastIndex; }
    else depth++;
  }
  return -1;
}

// 흐름 화살표 글리프가 2개 이상 든 최상위 <table> 블록을 흐름도 후보로 잡는다.
// (export 는 단위 테스트용)
export function findFlowchartTargets(md, occupied = []) {
  const targets = [];
  const openRe = /<table\b[^>]*>/gi;
  let m;
  while ((m = openRe.exec(md)) !== null) {
    const start = m.index;
    const end = matchTableEnd(md, openRe.lastIndex);
    if (end < 0) break;
    const block = md.slice(start, end);
    if ((block.match(FLOW_ARROW_G) || []).length >= 2 && !overlaps(start, end, occupied)) {
      targets.push({ type: "flowchart", index: start, length: end - start, text: block });
      occupied.push([start, end]);
    }
    openRe.lastIndex = end; // 표 블록 전체 건너뛰기(중첩 표 재매칭 방지)
  }
  return targets;
}

// AI 응답에서 mermaid 본문만 추출. 흐름도 아님(NO_FLOWCHART)·형식 불량이면 null(원본 표 유지).
// (export 는 단위 테스트용)
export function extractMermaid(text) {
  const t = String(text || "").trim();
  if (!t || /\bNO_FLOWCHART\b/i.test(t)) return null;
  const fenced = t.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : t).trim();
  if (!/^(?:graph|flowchart|sequenceDiagram|stateDiagram(?:-v2)?|gantt|erDiagram)\b/i.test(body)) return null;
  return body;
}

// 교체용: mermaid 본문을 ```mermaid 펜스로 감싼다.
function formatMermaid(body) {
  return `\n\n\`\`\`mermaid\n${String(body).trim()}\n\`\`\`\n`;
}

function findTargets(md, imageMap, visualPages) {
  const targets = [];
  const occupied = [];

  // 흐름도(화살표 글리프가 든 표) → mermaid 변환 대상. 먼저 잡아 occupied 에 올려 표/이미지 분석과
  // 겹치지 않게 한다.
  if (cfg.features.flowchart) {
    targets.push(...findFlowchartTargets(md, occupied));
  }

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
  if (t.type === "flowchart") {
    const out = await aiCall({
      prompt: prompts.flowchartToMermaid,
      text: t.text,
      maxTokens: cfg.tokens.pageVisual,
    });
    // mermaid 추출 실패/흐름도 아님이면 null → enrichMarkdown 이 원본 표를 그대로 둔다.
    return extractMermaid(out);
  }
  if (t.type === "image") {
    const url = t.imageUrl || imageMap.get(t.file) || imageMap.get(normalizeImageRef(t.file));
    if (!url) return null;
    const out = await aiCall({ image: url, prompt: prompts.imageAnalysis });
    // 로고·도장·서명·장식 등 정보성 없는 이미지는 삽입하지 않는다(거짓/잡음 블록 방지).
    if (!out || isNoVisualResponse(out)) return null;
    return out;
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

// 추출(OCR) 호출용 샘플링. 순수 greedy(temp 0) — 전사·숫자 충실도 최고이자 '결정적'(같은
// 페이지 = 같은 출력)이라 회귀 측정 노이즈가 사라진다. 과거 구모델(Qwen3)은 빈 영역에서 <br>·개행
// 무한반복(degeneration)이 있어 temp 0.1 + repetition_penalty 1.1 로 막았으나, qwen3.6-27b 은
// degeneration 없음을 실측 확인(희소 표·극단 여백 합성·표지/서식 13페이지 전부 finish=stop,
// 극단 여백은 3자만 출력) → rep_penalty 불필요해 off(1.0). 모두 env 로 모델별 튜닝/복구 가능
// (구모델로 회귀 시 VLLM_OCR_TEMPERATURE=0.1, VLLM_OCR_REPETITION_PENALTY=1.1 로 되돌린다).
const OCR_SAMPLING = Object.freeze({
  temperature: Number(process.env.VLLM_OCR_TEMPERATURE ?? 0),
  topP: Number(process.env.VLLM_OCR_TOP_P ?? 1.0),
  presencePenalty: Number(process.env.VLLM_OCR_PRESENCE_PENALTY ?? 0),
  repetitionPenalty: Number(process.env.VLLM_OCR_REPETITION_PENALTY ?? 1.0),
  frequencyPenalty: Number(process.env.VLLM_OCR_FREQUENCY_PENALTY ?? 0),
});

// 복잡한 표(병합·중첩)에서 모델이 markdown 으로 표를 깨뜨리는 출력 신호. 결정적으로 감지해
// 재시도한다 — 모델이 같은 페이지를 절반쯤은 올바른 HTML 로 그리므로 몇 번 재시도하면 수렴.
const TABLE_MAX_RETRY = Number(process.env.VLLM_OCR_TABLE_RETRY ?? 2);
export function hasBrokenTable(text) {
  if (!text) return false;
  if (/\|[^\n|]*(?:row|col)span\s*=/i.test(text)) return true; // markdown 칸에 rowspan/colspan 텍스트 누출
  if (/<br>\s*\|/.test(text)) return true; // 표를 <br>+| 로 셀에 욱여넣음(중첩 표 실패)
  if (hasMalformedHtmlTable(text)) return true;
  // 연속 파이프표 블록 검사: 구분행이 2개 이상(하위표가 같은 블록에 흘러나옴) 또는 행별 칸 수
  // 불일치(병합/중첩을 markdown 으로 누른 흔적). 정상 markdown 표는 구분행 1개·직사각형.
  const isPipe = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; ) {
    if (!isPipe(lines[i])) { i++; continue; }
    const block = [];
    while (i < lines.length && isPipe(lines[i])) block.push(lines[i++]);
    if (block.length < 2) continue;
    if (block.filter(isSep).length >= 2) return true; // 구분행 2개+ = 하위표 흘러나옴
    const widths = block.filter((l) => !isSep(l)).map((l) => l.split("|").length);
    if (widths.length && Math.max(...widths) - Math.min(...widths) >= 2) return true; // 칸 수 불일치
  }
  return false;
}

function hasMalformedHtmlTable(text) {
  if (!/<table[\s>]/i.test(text)) return false;
  for (const table of extractTopLevelTables(String(text))) {
    // 병합 헤더를 두 칸짜리 "구분" + 빈 헤더칸으로 쪼개면 시각적으로는 비슷해도
    // 왼쪽 다중 구분 열의 의미가 밀린다. colspan 을 정확히 써야 한다.
    if (/<th\b[^>]*colspan\s*=\s*["']?2["']?[^>]*>\s*구\s*분\s*<\/th>\s*<th\b[^>]*>\s*<\/th>/i.test(table)) {
      return true;
    }

    const widths = htmlTableRowWidths(stripNestedTables(table));
    if (widths.length < 2) continue;
    const positive = widths.filter((n) => n > 0);
    if (positive.length < 2) continue;
    const max = Math.max(...positive);
    const min = Math.min(...positive);
    if (max - min >= 2) return true;
  }
  return false;
}

function extractTopLevelTables(text) {
  const blocks = [];
  const tagRe = /<\/?table\b[^>]*>/gi;
  const stack = [];
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const isClose = /^<\//.test(m[0]);
    if (!isClose) {
      stack.push(m.index);
    } else if (stack.length) {
      const start = stack.pop();
      if (stack.length === 0) blocks.push(text.slice(start, tagRe.lastIndex));
    }
  }
  return blocks;
}

function stripNestedTables(table) {
  const tagRe = /<\/?table\b[^>]*>/gi;
  const ranges = [];
  let depth = 0;
  let nestedStart = -1;
  let m;
  while ((m = tagRe.exec(table)) !== null) {
    const isClose = /^<\//.test(m[0]);
    if (!isClose) {
      if (depth === 1) nestedStart = m.index;
      depth++;
    } else {
      if (depth === 2 && nestedStart >= 0) {
        ranges.push([nestedStart, tagRe.lastIndex]);
        nestedStart = -1;
      }
      depth = Math.max(0, depth - 1);
    }
  }
  let out = table;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [start, end] = ranges[i];
    out = out.slice(0, start) + "[nested table]" + out.slice(end);
  }
  return out;
}

function htmlTableRowWidths(table) {
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const activeRowspans = [];
  const widths = [];
  for (const row of rows) {
    let col = 0;
    const occupyPrior = () => {
      while ((activeRowspans[col] || 0) > 0) {
        activeRowspans[col]--;
        col++;
      }
    };
    const cellRe = /<t[dh]\b([^>]*)>[\s\S]*?<\/t[dh]>/gi;
    let m;
    while ((m = cellRe.exec(row)) !== null) {
      occupyPrior();
      const attrs = m[1] || "";
      const colspan = Math.max(1, Number((attrs.match(/\bcolspan\s*=\s*["']?(\d+)/i) || [])[1] || 1));
      const rowspan = Math.max(1, Number((attrs.match(/\browspan\s*=\s*["']?(\d+)/i) || [])[1] || 1));
      if (rowspan > 1) {
        for (let i = 0; i < colspan; i++) activeRowspans[col + i] = Math.max(activeRowspans[col + i] || 0, rowspan - 1);
      }
      col += colspan;
    }
    occupyPrior();
    widths.push(col);
  }
  return widths;
}

// 페이지 OCR 본체 — 실패 시 throw (호출부에서 스케일 재시도 등 판단).
// 공통 지시문은 system 으로(byte 동일 → prefix cache), 페이지 번호 등 가변값은 user 로.
async function vllmOcrPageStrict(pageImage, pageNumber, mimeType = "image/png", samplingOverride = null, extraInstruction = "") {
  const b64 = Buffer.from(pageImage).toString("base64");
  const url = `data:${mimeType};base64,${b64}`;
  const text = await aiCall({
    image: url,
    system: prompts.pdfOcrSystem,
    prompt: prompts.pdfOcrUser(pageNumber) + (extraInstruction ? `\n${extraInstruction}` : ""),
    maxTokens: cfg.tokens.ocr,
    ...OCR_SAMPLING,
    ...(samplingOverride || {}),
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
// (export 는 이미지 파일 변환 경로에서 page-visual enrich 입력 URL 을 만들 때 재사용)
const AI_SAFE_IMAGE = /^image\/(png|jpe?g|webp)$/i;
export async function toSafeImageUrl(data, mime = "image/png") {
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

// 스캔본 OCR 시 page-visual enrich 입력으로 모을 페이지 단서(차트/그림 위주 — 표는 전사로 충분).
const VISUAL_CUE_RE = /그림|도표|차트|그래프|다이어그램|통계|추이|분포|증감|Figure|Fig\.|Chart|Graph|Diagram/i;
// page-visual 입력 이미지는 OCR 해상도보다 작게 렌더(데이터 URL 크기·enrich 통과율 고려).
const VISUAL_RENDER_FACTOR = Number(process.env.VLLM_VISUAL_RENDER_FACTOR ?? 0.6);
// 스캔본 한 건에서 모을 시각 페이지 상한(차트 enrich 호출 수·메모리 폭주 방지).
const VISUAL_PAGE_CAP = Number(process.env.VLLM_VISUAL_PAGE_CAP ?? 30);

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

// 텍스트 내 표 개수(HTML <table> + markdown 구분행). vision 이 표를 빠뜨렸는지 판단용.
function countTables(text) {
  const html = (String(text).match(/<table[\s>]/gi) || []).length;
  const mdSep = (String(text).match(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm) || []).length;
  return html + mdSep;
}

// 렌더 → OCR 1页. 컨텍스트 초과(400)면 0.7배로 줄여 1회 재시도. 그 외 실패는 "" (페이지 단위 격리).
// expectedTables: kordoc 가 그 페이지에서 본 '실제 표' 개수 — vision 출력이 이보다 적으면(표 누락/
// 본문에 흡수) 깨진 것으로 보고 재시도한다(사용자 사례: '26년 예산 표가 통째로 누락된 케이스).
async function ocrPageAdaptive(renderer, pageNum, expectedTables = 0) {
  let png = null;
  let text = null;
  // 1) 렌더 → OCR. 컨텍스트 초과(400)면 0.7배로 줄여 1회 재시도.
  for (const factor of [1, 0.7]) {
    try {
      png = renderer.renderPage(pageNum, factor);
    } catch (e) {
      console.warn(`[render] page ${pageNum} failed:`, e?.message || e);
      return "";
    }
    try {
      text = await vllmOcrPageStrict(png, pageNum, "image/png");
      break;
    } catch (e) {
      if (factor === 1 && isContextOverflow(e)) {
        console.warn(`[vllm-ocr] page ${pageNum} 컨텍스트 초과 — 0.7배 축소 재시도`);
        continue;
      }
      console.warn(`[vllm-ocr] page ${pageNum} failed:`, e?.message || e);
      return "";
    }
  }
  if (text == null) return "";
  // 2) 표가 깨졌거나(병합/중첩을 markdown 으로 누름) 표를 빠뜨렸으면(개수 부족) 재시도.
  const bad = (t) => hasBrokenTable(t) || (expectedTables > 0 && countTables(t) < expectedTables);
  for (let r = 0; r < TABLE_MAX_RETRY && bad(text); r++) {
    const why = hasBrokenTable(text) ? "표 깨짐" : `표 누락(${countTables(text)}/${expectedTables})`;
    console.warn(`[vllm-ocr] page ${pageNum} ${why} 감지 — 재시도 ${r + 1}/${TABLE_MAX_RETRY}`);
    try {
      const retry = await vllmOcrPageStrict(png, pageNum, "image/png", { temperature: 0.4 }, prompts.pdfOcrTableRetry);
      if (retry && !bad(retry)) return retry;
      if (retry && countTables(retry) > countTables(text)) text = retry; // 더 완전한 쪽 유지
    } catch (e) {
      console.warn(`[vllm-ocr] page ${pageNum} 표 재시도 실패:`, e?.message || e);
      break;
    }
  }
  return text;
}

// 스캔본(IMAGE_BASED_PDF) fallback: 전 페이지 lazy 렌더 → OCR → markdown 합성.
// collectVisuals: 차트/그림 단서가 있는 페이지의 렌더 이미지를 page-visual enrich 입력으로 함께 모은다.
// (OCR 프롬프트는 전사만 하고 시각자료 해설은 enrich 가 담당하므로 그 입력을 여기서 공급한다.)
export async function ocrPdfBuffer(arrayBuffer, { onProgress, onPage, collectVisuals = true } = {}) {
  const renderer = await openPdfRenderer(arrayBuffer);
  const pageCount = renderer.pageCount;
  const pageNums = Array.from({ length: pageCount }, (_, i) => i + 1);
  const texts = new Array(pageCount).fill("");
  const visualPages = [];
  let okCount = 0;
  let done = 0;

  await mapWithLimit(pageNums, cfg.concurrency.ocr, async (page, idx) => {
    onPage?.(page, pageCount);
    const clean = (await ocrPageAdaptive(renderer, page)).trim();
    if (clean) {
      texts[idx] = clean;
      okCount++;
      // 차트/그림 단서가 있는 페이지만 enrich 후보로 캡처(상한·축소 렌더로 비용 제한).
      if (collectVisuals && visualPages.length < VISUAL_PAGE_CAP && VISUAL_CUE_RE.test(clean)) {
        try {
          const png = renderer.renderPage(page, VISUAL_RENDER_FACTOR);
          visualPages.push({
            page,
            image: `data:image/png;base64,${png.toString("base64")}`,
            blocks: [{ content: clean }],
          });
        } catch (e) {
          console.warn(`[vllm-ocr] page ${page} visual 캡처 실패:`, e?.message || e);
        }
      }
    }
    onProgress?.(++done / (pageCount || 1));
  });

  const sections = pageNums
    .map((page, idx) =>
      texts[idx] ? (pageCount > 1 ? `## 페이지 ${page}\n\n${texts[idx]}` : texts[idx]) : null
    )
    .filter(Boolean);

  visualPages.sort((a, b) => a.page - b.page);
  return { markdown: sections.join("\n\n---\n\n"), pageCount, ocrPages: okCount, visualPages };
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

export async function ocrSelectedPdfPages(arrayBuffer, pageNumbers, { onPage, spreadPages, expectedTables } = {}) {
  const want = [...new Set((pageNumbers || []).filter((n) => n > 0))].sort((a, b) => a - b);
  if (!want.length) return new Map();
  const spreads = spreadPages instanceof Set ? spreadPages : new Set(spreadPages || []);
  const expTbl = expectedTables instanceof Map ? expectedTables : new Map();
  const renderer = await openPdfRenderer(arrayBuffer);
  const totalUnits = want.reduce((s, p) => s + (spreads.has(p) ? 2 : 1), 0);

  const texts = new Map(); // page -> merged markdown
  let done = 0;
  await mapWithLimit(want, cfg.concurrency.ocr, async (page) => {
    // 일반 페이지(또는 분할 실패 fallback): 통짜 OCR.
    const wholePage = async () => {
      const t = (await ocrPageAdaptive(renderer, page, expTbl.get(page) || 0)).trim();
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
