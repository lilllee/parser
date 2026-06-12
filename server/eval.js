import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runConvert } from "./convert.js";
import { resolveAiConfig, aiPing } from "./ai.js";
import { PROVIDER_ALIASES, PROVIDER_CHOICES } from "./providers.js";
import { BEDROCK_EVAL_MODELS, bedrockModelForRegion, resolveBedrockEvalModel } from "./config/bedrock.js";
import { scoreMarkdown } from "../tests/quality.mjs";

const ROOT = process.cwd();
const CORPUS_DIR = resolve(ROOT, process.env.EVAL_CORPUS_DIR || "tests/file");
const GOLDEN_DIR = resolve(ROOT, process.env.EVAL_GOLDEN_DIR || "tests/_golden");
const EVAL_DIR = resolve(ROOT, process.env.EVAL_DIR || "tests/_eval");
const RESULTS_DIR = join(EVAL_DIR, "results");
const JUDGEMENTS_PATH = join(EVAL_DIR, "judgements.json");
const REVIEW_DIR = resolve(ROOT, "review");
const SUPPORTED = /\.(pdf|hwp|hwpx|hwpml|docx|xlsx|xls|txt|md|png|jpe?g|webp|gif|bmp|tiff?)$/i;

export function registerEvalRoutes(app) {
  app.get("/", (c) => c.redirect("/review"));
  app.get("/review", (c) => serveReviewFile(c, "index.html"));
  app.get("/review/", (c) => serveReviewFile(c, "index.html"));
  app.get("/review/:asset", (c) => serveReviewFile(c, c.req.param("asset")));

  app.get("/api/eval/providers", evalRoute((c) => {
    // Bedrock 모델별 "이 리전에서 사용 가능한지"를 함께 내려 UI 가 비활성화 표시.
    const requestedRegion = String(c.req.query("region") || "").trim();
    const ai = resolveAiConfig({
      provider: "bedrock",
      ...(requestedRegion ? { region: requestedRegion } : {}),
    });
    const region = ai.cfg.region;
    const bedrockModels = BEDROCK_EVAL_MODELS.map((m) => {
      const modelId = bedrockModelForRegion(m, region);
      return { key: m.key, label: m.label, vision: m.vision, modelId, available: !!modelId };
    });
    return c.json({ providers: PROVIDER_CHOICES, bedrockRegion: region, bedrockModels });
  }));
  app.get("/api/eval/files", evalRoute((c) => c.json({ files: listCorpusFiles() })));
  app.post("/api/eval/files/delete", evalRoute(async (c) => c.json(deleteCorpusFile((await readJson(c)).file))));
  app.post("/api/eval/files/clear", evalRoute((c) => c.json(clearCorpusFiles())));
  app.post("/api/eval/cache/clear", evalRoute((c) => c.json(clearEvalCache())));
  app.get("/api/eval/results", evalRoute((c) => c.json({ results: listResults(c.req.query("file")) })));
  app.post("/api/eval/upload", evalRoute(async (c) => c.json(await uploadCorpusFile(c))));
  app.get("/api/eval/source", evalRoute((c) => serveCorpusFile(c, c.req.query("file"))));
  app.get("/api/eval/golden", evalRoute(async (c) => c.json(await loadGolden(c.req.query("file")))));
  app.put("/api/eval/golden", evalRoute(async (c) => c.json(saveGolden(await readJson(c)))));
  app.get("/api/eval/compare", evalRoute(async (c) => c.json(await loadComparison(c.req.query("resultId")))));
  app.get("/api/eval/result.md", evalRoute((c) => downloadResultMarkdown(c)));
  app.post("/api/eval/check", evalRoute(async (c) => c.json(await checkEvalProvider(await readJson(c)))));
  app.post("/api/eval/run", evalRoute(async (c) => c.json(await runEval(await readJson(c)))));
  app.post("/api/eval/batch", evalRoute(async (c) => c.json(await runBatch(await readJson(c)))));
  app.get("/api/eval/judgements", evalRoute((c) => c.json({ judgements: readJudgements() })));
  app.post("/api/eval/judgement", evalRoute(async (c) => c.json(saveJudgement(await readJson(c)))));
  app.get("/api/eval/export.csv", evalRoute((c) => c.body(exportCsv(), 200, { "Content-Type": "text/csv; charset=utf-8" })));
}

function evalRoute(handler) {
  return async (c) => {
    try {
      return await handler(c);
    } catch (e) {
      const status = e?.status || (e?.code === "BAD_PROVIDER" ? 400 : 500);
      return c.json({ ok: false, error: e?.message || String(e), code: e?.code }, status);
    }
  };
}

function ensureDirs() {
  mkdirSync(CORPUS_DIR, { recursive: true });
  mkdirSync(GOLDEN_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
}

function listCorpusFiles() {
  ensureDirs();
  const results = listResults();
  const judgements = readJudgements();
  return readdirSync(CORPUS_DIR)
    .filter((name) => SUPPORTED.test(name))
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((name) => {
      const path = corpusPath(name);
      const fileResults = results.filter((r) => r.file === name);
      return {
        name,
        docType: inferDocType(name),
        ext: extname(name).slice(1).toLowerCase(),
        size: statSync(path).size,
        golden: existsSync(goldenPath(name)),
        resultCount: fileResults.length,
        judgedCount: fileResults.filter((r) => judgements[r.id]).length,
      };
    });
}

// 단일 corpus 파일 삭제 (UI 파일 칩의 휴지통 버튼). 결과/판정 기록은 건드리지 않는다.
function deleteCorpusFile(file) {
  const path = corpusPath(file); // 파일명 검증 + 존재 확인 (없으면 throw)
  rmSync(path, { force: true });
  return { ok: true, deleted: basename(path), files: listCorpusFiles() };
}

function clearCorpusFiles() {
  ensureDirs();
  const deleted = [];
  for (const name of readdirSync(CORPUS_DIR).filter((entry) => SUPPORTED.test(entry))) {
    const path = corpusPath(name);
    if (!statSync(path).isFile()) continue;
    rmSync(path, { force: true });
    deleted.push(name);
  }
  const cache = clearEvalCache();
  return { ok: true, deletedCount: deleted.length, deleted, cache, files: listCorpusFiles() };
}

function clearEvalCache() {
  ensureSafeWorkspaceDir(GOLDEN_DIR);
  ensureSafeWorkspaceDir(EVAL_DIR);

  const deleted = [
    ...clearDirectoryContents(GOLDEN_DIR),
    ...clearDirectoryContents(EVAL_DIR, new Set(["review-server.log"])),
  ];
  ensureDirs();
  return { ok: true, deletedCount: deleted.length, deleted };
}

function clearDirectoryContents(dir, skipNames = new Set()) {
  mkdirSync(dir, { recursive: true });
  const deleted = [];
  for (const name of readdirSync(dir)) {
    if (skipNames.has(name)) continue;
    const path = resolve(dir, name);
    if (!isInsideOrSame(dir, path)) throw new Error("허용되지 않은 캐시 경로입니다.");
    rmSync(path, { recursive: true, force: true });
    deleted.push(relative(ROOT, path));
  }
  return deleted;
}

function listResults(file) {
  ensureDirs();
  const rows = readdirSync(RESULTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJsonFile(join(RESULTS_DIR, name)))
    .filter(Boolean)
    .filter((row) => !file || row.file === file)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows.map(({ markdown, ...row }) => row);
}

async function uploadCorpusFile(c) {
  ensureDirs();
  let body;
  try {
    body = await c.req.parseBody();
  } catch (e) {
    const err = new Error(`multipart 파싱 실패: ${e.message}`);
    err.status = 400;
    throw err;
  }

  const file = body.file;
  if (!file || typeof file === "string") {
    const err = new Error("file 필드가 필요합니다.");
    err.status = 400;
    throw err;
  }

  const name = uniqueCorpusName(sanitizeUploadName(file.name || "document"));
  const arrayBuffer = await file.arrayBuffer();
  writeFileSync(resolve(CORPUS_DIR, name), Buffer.from(arrayBuffer));
  const uploaded = listCorpusFiles().find((row) => row.name === name);
  return { file: uploaded, files: listCorpusFiles() };
}

async function runEval(body) {
  ensureDirs();
  const file = requireFileName(body.file);
  const provider = body.provider || "vllm";
  const { baseProvider, modelKey } = parseEvalProvider(provider);
  const overrides = providerOverrides(body, baseProvider);
  const aiConfig = resolveAiConfig({ ...overrides, provider: baseProvider });
  // 모델 ID 는 리전 해석 후에 결정 (us./apac. inference profile 이 리전마다 다름)
  if (modelKey) aiConfig.cfg.model = resolveBedrockEvalModel(modelKey, aiConfig.cfg.region).modelId;
  aiConfig.stats = { calls: 0, failures: 0 }; // 변환 중 실제 AI 호출 횟수 추적
  const buf = readFileSync(corpusPath(file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const startedAt = performance.now();
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}__${safeId(provider)}__${shortFileId(file)}`;

  let record;
  try {
    const result = await runConvert(ab, file, {}, aiConfig);
    const elapsedMs = Math.round(performance.now() - startedAt);
    const quality = scoreMarkdown(result.markdown || "");
    const golden = await loadGolden(file);
    const metrics = isScorableGolden(golden) ? scoreAgainstGolden(golden.markdown, result.markdown || "", quality) : null;
    record = {
      id,
      file,
      provider,
      docType: body.docType || inferDocType(file),
      createdAt,
      ok: true,
      elapsedMs,
      aiCalls: aiConfig.stats.calls,
      aiFailures: aiConfig.stats.failures,
      markdown: result.markdown || "",
      metadata: result.metadata || {},
      pageCount: result.pageCount ?? null,
      quality,
      metrics,
    };
  } catch (e) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    record = {
      id,
      file,
      provider,
      docType: body.docType || inferDocType(file),
      createdAt,
      ok: false,
      elapsedMs,
      aiCalls: aiConfig.stats.calls,
      aiFailures: aiConfig.stats.failures,
      markdown: "",
      error: e?.message || String(e),
      code: e?.code || "CONVERT_FAILED",
      quality: null,
      metrics: null,
    };
  }

  writeJsonAtomic(resultPath(id), record);
  return { result: withoutMarkdown(record) };
}

async function runBatch(body) {
  const files = Array.isArray(body.files) && body.files.length ? body.files : listCorpusFiles().map((f) => f.name);
  const providers = Array.isArray(body.providers) && body.providers.length ? body.providers : ["vllm"];
  const results = [];
  for (const file of files) {
    for (const provider of providers) {
      results.push((await runEval({ ...body, file, provider })).result);
    }
  }
  return { results };
}

async function loadGolden(file) {
  const name = requireFileName(file);
  const draft = goldenDraft(name);
  if (!existsSync(goldenPath(name))) return draft;
  return {
    ...draft,
    exists: true,
    generated: false,
    source: "golden",
    scorable: true,
    markdown: readFileSync(goldenPath(name), "utf-8"),
  };
}

function saveGolden(body) {
  ensureDirs();
  const file = requireFileName(body.file);
  const markdown = String(body.markdown ?? "");
  writeFileSync(goldenPath(file), markdown, "utf-8");

  const updated = [];
  for (const row of listResults(file)) {
    const full = readJsonFile(resultPath(row.id));
    if (!full?.ok) continue;
    full.metrics = markdown.trim()
      ? scoreAgainstGolden(markdown, full.markdown || "", full.quality || scoreMarkdown(full.markdown || ""))
      : null;
    writeJsonAtomic(resultPath(full.id), full);
    updated.push(withoutMarkdown(full));
  }
  return { file, exists: true, updatedResults: updated };
}

async function loadComparison(resultId) {
  ensureDirs();
  const result = readJsonFile(resultPath(requireResultId(resultId)));
  if (!result) {
    const err = new Error("결과를 찾을 수 없습니다.");
    err.status = 404;
    throw err;
  }
  return {
    result,
    golden: await loadGolden(result.file),
    judgement: readJudgements()[result.id] || null,
  };
}

function downloadResultMarkdown(c) {
  ensureDirs();
  const result = readJsonFile(resultPath(requireResultId(c.req.query("resultId"))));
  if (!result) {
    const err = new Error("결과를 찾을 수 없습니다.");
    err.status = 404;
    throw err;
  }
  const markdown = String(result.markdown || "");
  if (!markdown.trim()) {
    const err = new Error("추출할 markdown이 없습니다.");
    err.status = 400;
    throw err;
  }
  const filename = markdownDownloadName(result);
  return c.body(markdown, 200, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
}

// provider 연결 사전 점검 — 자격증명/리전/모델 접근 오류를 변환 실행 전에 노출.
async function checkEvalProvider(body) {
  const provider = body.provider || "vllm";
  const { baseProvider, modelKey } = parseEvalProvider(provider);
  const overrides = providerOverrides(body, baseProvider);
  const ai = resolveAiConfig({ ...overrides, provider: baseProvider });
  if (modelKey) ai.cfg.model = resolveBedrockEvalModel(modelKey, ai.cfg.region).modelId;
  const result = await aiPing(ai);
  return { ...result, requested: provider, model: ai.cfg.model, region: ai.cfg.region };
}

// 검수 provider 문자열 해석. "bedrock:<key>" 는 Bedrock 다중 모델 항목 —
// key 검증/모델 ID 치환은 리전이 정해진 뒤 resolveBedrockEvalModel 에서 수행.
function parseEvalProvider(provider) {
  const idx = String(provider).indexOf(":");
  if (idx < 0) return { baseProvider: provider, modelKey: null };
  const base = provider.slice(0, idx);
  if (base !== "bedrock") {
    const err = new Error(`"provider:model" 형식은 bedrock 만 지원합니다: "${provider}"`);
    err.status = 400;
    throw err;
  }
  return { baseProvider: base, modelKey: provider.slice(idx + 1) };
}

function providerOverrides(body, provider) {
  const shared = body.overrides && typeof body.overrides === "object" ? body.overrides : {};
  const all = body.providerOverrides && typeof body.providerOverrides === "object" ? body.providerOverrides : {};
  const normalized = PROVIDER_ALIASES[provider] || provider;
  const perProvider = all[provider] || all[normalized] || {};
  return { ...shared, ...perProvider };
}

function isScorableGolden(golden) {
  return !!golden?.markdown && golden.scorable !== false;
}

function goldenDraft(file) {
  const ext = extname(file).toLowerCase();
  const sourceUrl = `/api/eval/source?file=${encodeURIComponent(file)}`;
  const media = originalMedia(file, sourceUrl, ext);

  return {
    file,
    exists: false,
    generated: true,
    source: "original",
    scorable: false,
    markdown: sourceMarkdown(file, media),
    media,
  };
}

function originalMedia(file, url, ext) {
  if (ext === ".pdf") return { kind: "pdf", url, contentType: "application/pdf" };
  if (isImageExt(ext)) return { kind: "image", url, contentType: sourceContentType(file) };
  if (ext === ".txt" || ext === ".md") return { kind: "text", url, contentType: sourceContentType(file) };
  return { kind: "file", url, contentType: sourceContentType(file) };
}

function sourceMarkdown(file, media) {
  if (media.kind === "pdf") return `@[pdf:${file}](${media.url})`;
  if (media.kind === "image") return `![${file}](${media.url})`;
  return `[${file}](${media.url})`;
}

function saveJudgement(body) {
  ensureDirs();
  const resultId = requireResultId(body.resultId);
  const result = readJsonFile(resultPath(resultId));
  if (!result) throw new Error("검수 대상 결과를 찾을 수 없습니다.");
  const judgements = readJudgements();
  const row = {
    resultId,
    file: result.file,
    provider: result.provider,
    docType: body.docType || result.docType || inferDocType(result.file),
    status: body.status || "reviewing",
    textScore: numberOrNull(body.textScore),
    numberScore: numberOrNull(body.numberScore),
    tableScore: numberOrNull(body.tableScore),
    imageScore: numberOrNull(body.imageScore),
    errorTypes: Array.isArray(body.errorTypes) ? body.errorTypes.map(String) : [],
    note: String(body.note || ""),
    updatedAt: new Date().toISOString(),
  };
  judgements[resultId] = row;
  writeJsonAtomic(JUDGEMENTS_PATH, judgements);
  return { judgement: row };
}

function readJudgements() {
  ensureDirs();
  if (!existsSync(JUDGEMENTS_PATH)) return {};
  return readJsonFile(JUDGEMENTS_PATH) || {};
}

function exportCsv() {
  ensureDirs();
  const judgements = readJudgements();
  const header = [
    "file",
    "docType",
    "provider",
    "createdAt",
    "elapsedMs",
    "ok",
    "textAccuracy",
    "numberAccuracy",
    "tableAccuracy",
    "structureAccuracy",
    "overallScore",
    "qualityIssues",
    "judgementStatus",
    "humanTextScore",
    "humanNumberScore",
    "humanTableScore",
    "humanImageScore",
    "errorTypes",
    "note",
  ];
  const rows = listResults().map((r) => {
    const j = judgements[r.id] || {};
    return [
      r.file,
      j.docType || r.docType,
      r.provider,
      r.createdAt,
      r.elapsedMs,
      r.ok,
      r.metrics?.textAccuracy,
      r.metrics?.numberAccuracy,
      r.metrics?.tableAccuracy,
      r.metrics?.structureAccuracy,
      r.metrics?.overallScore,
      r.quality?.problemTotal,
      j.status,
      j.textScore,
      j.numberScore,
      j.tableScore,
      j.imageScore,
      (j.errorTypes || []).join("|"),
      j.note,
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function scoreAgainstGolden(goldenMd, outputMd, quality = scoreMarkdown(outputMd)) {
  const textAccuracy = similarityScore(normalizeText(goldenMd), normalizeText(outputMd));
  const numberAccuracy = multisetScore(extractNumbers(goldenMd), extractNumbers(outputMd));
  const tableAccuracy = tableScore(goldenMd, outputMd);
  const structureAccuracy = structureScore(goldenMd, outputMd);
  const weightedAccuracy = weightedAverage([
    [textAccuracy, 50],
    [numberAccuracy, 25],
    [tableAccuracy, 15],
    [structureAccuracy, 10],
  ]);
  const qualityPenalty = Math.min(20, (quality?.problemTotal || 0) * 2);
  return {
    textAccuracy,
    numberAccuracy,
    tableAccuracy,
    structureAccuracy,
    weightedAccuracy,
    qualityPenalty,
    overallScore: weightedAccuracy == null ? null : roundScore(Math.max(0, weightedAccuracy - qualityPenalty)),
    lengthRatio: ratioScore(outputMd.length, goldenMd.length),
  };
}

function normalizeText(md) {
  return String(md || "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/^[ \t]*-?\d{1,4}-?[ \t]*$/gm, "")
    .replace(/[`*_>#|[\]()]|!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function similarityScore(a, b) {
  if (!a && !b) return 100;
  if (!a || !b) return 0;
  if (a === b) return 100;
  const gramsA = gramCounts(a, a.length < 2 ? 1 : 2);
  const gramsB = gramCounts(b, b.length < 2 ? 1 : 2);
  return f1FromMaps(gramsA, gramsB);
}

function gramCounts(text, n) {
  const map = new Map();
  for (let i = 0; i <= text.length - n; i++) {
    const gram = text.slice(i, i + n);
    map.set(gram, (map.get(gram) || 0) + 1);
  }
  return map;
}

function extractNumbers(md) {
  const text = String(md || "").normalize("NFKC");
  const regex = /\d{4}[./-]\d{1,2}[./-]\d{1,2}|[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|퍼센트|억원|만원|원|명|건|개|세|㎡|m2)?/g;
  return [...text.matchAll(regex)].map((m) =>
    m[0]
      .replace(/\s+/g, "")
      .replace(/,/g, "")
      .replace(/[./-]/g, ".")
      .toLowerCase()
  );
}

function multisetScore(gold, output) {
  if (!gold.length && !output.length) return null;
  if (!gold.length || !output.length) return 0;
  return f1FromMaps(counts(gold), counts(output));
}

function tableScore(goldenMd, outputMd) {
  const gold = extractTableShape(goldenMd);
  const out = extractTableShape(outputMd);
  if (!gold.cells.length && !out.cells.length) return null;
  if (!gold.cells.length || !out.cells.length) return 0;
  const cellF1 = f1FromMaps(counts(gold.cells), counts(out.cells));
  const rowRatio = ratioScore(out.rows, gold.rows);
  return roundScore(cellF1 * 0.8 + rowRatio * 0.2);
}

function extractTableShape(md) {
  const rows = String(md || "")
    .split(/\r?\n/)
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line));
  const cells = rows.flatMap((line) =>
    line
      .split("|")
      .map((cell) => normalizeText(cell))
      .filter(Boolean)
  );
  return { rows: rows.length, cells };
}

function structureScore(goldenMd, outputMd) {
  const g = structureCounts(goldenMd);
  const o = structureCounts(outputMd);
  return weightedAverage([
    [ratioScore(o.headings, g.headings), 25],
    [ratioScore(o.lists, g.lists), 20],
    [ratioScore(o.tables, g.tables), 35],
    [ratioScore(o.paragraphs, g.paragraphs), 20],
  ]);
}

function structureCounts(md) {
  const lines = String(md || "").split(/\r?\n/);
  return {
    headings: lines.filter((line) => /^#{1,6}\s+\S/.test(line)).length,
    lists: lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length,
    tables: lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length,
    paragraphs: lines.filter((line) => line.trim() && !/^#{1,6}\s+|\s*\|.*\|\s*$|^\s*(?:[-*+]|\d+[.)])\s+/.test(line)).length,
  };
}

function f1FromMaps(gold, output) {
  let common = 0;
  let goldTotal = 0;
  let outTotal = 0;
  for (const count of gold.values()) goldTotal += count;
  for (const count of output.values()) outTotal += count;
  for (const [key, count] of gold.entries()) common += Math.min(count, output.get(key) || 0);
  if (!goldTotal && !outTotal) return 100;
  if (!goldTotal || !outTotal || !common) return 0;
  const precision = common / outTotal;
  const recall = common / goldTotal;
  return roundScore((2 * precision * recall * 100) / (precision + recall));
}

function counts(items) {
  const map = new Map();
  for (const item of items) map.set(item, (map.get(item) || 0) + 1);
  return map;
}

function ratioScore(actual, expected) {
  if (!actual && !expected) return null;
  if (!actual || !expected) return 0;
  return roundScore((Math.min(actual, expected) / Math.max(actual, expected)) * 100);
}

function weightedAverage(rows) {
  let total = 0;
  let weights = 0;
  for (const [value, weight] of rows) {
    if (value == null || Number.isNaN(value)) continue;
    total += value * weight;
    weights += weight;
  }
  return weights ? roundScore(total / weights) : null;
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}

function inferDocType(file) {
  const name = String(file || "").toLowerCase();
  const ext = extname(name);
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)) return "image-ocr";
  if (/\.(hwp|hwpx|hwpml)$/.test(name)) return /image|img|그림|이미지|차트|chart/.test(name) ? "hwp-image" : "hwp";
  if (ext === ".pdf") return /pocket|booklet|포켓|소책자/.test(name) ? "pdf-pocketbook" : "pdf-single";
  return ext.slice(1) || "document";
}

function corpusPath(file) {
  const safe = requireFileName(file);
  const path = resolve(CORPUS_DIR, safe);
  if (!isInside(CORPUS_DIR, path)) throw new Error("허용되지 않은 파일 경로입니다.");
  if (!existsSync(path)) throw new Error(`파일을 찾을 수 없습니다: ${safe}`);
  return path;
}

function goldenPath(file) {
  const safe = requireFileName(file);
  return resolve(GOLDEN_DIR, `${basename(safe)}.md`);
}

function resultPath(id) {
  const safe = requireResultId(id);
  return resolve(RESULTS_DIR, `${safe}.json`);
}

function requireFileName(file) {
  const value = String(file || "");
  if (!value || value !== basename(value) || !SUPPORTED.test(value)) throw new Error("지원하지 않는 파일명입니다.");
  return value;
}

function sanitizeUploadName(name) {
  // NFC 로 통일 — 같은 한글 파일명이 NFD/NFC 로 갈려 결과 매칭이 깨지는 것 방지.
  const raw = String(name || "document").split(/[\\/]/).pop().normalize("NFC");
  // UTF-8 이 아닌 인코딩(예: Windows curl 의 CP949)으로 온 파일명은 U+FFFD(치환문자)나
  // 짝 없는 surrogate 로 깨진다 — 복구 불가하므로 쓰레기 파일을 저장하지 말고 명확히 거부.
  if (/�/.test(raw) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(raw)) {
    const err = new Error("파일명 인코딩이 깨졌습니다. UTF-8 로 인코딩해 업로드하세요.");
    err.status = 400;
    throw err;
  }
  const cleaned = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || !SUPPORTED.test(cleaned)) {
    const err = new Error("지원하지 않는 파일 형식입니다.");
    err.status = 400;
    throw err;
  }
  const ext = extname(cleaned);
  const stem = basename(cleaned, ext).slice(0, Math.max(1, 180 - ext.length));
  return `${stem}${ext}`;
}

function uniqueCorpusName(name) {
  const ext = extname(name);
  const base = basename(name, ext);
  let candidate = name;
  let i = 2;
  while (existsSync(resolve(CORPUS_DIR, candidate))) {
    candidate = `${base} (${i})${ext}`;
    i++;
  }
  return candidate;
}

function requireResultId(id) {
  const value = String(id || "");
  if (!/^[A-Za-z0-9_.%~-]+$/.test(value)) throw new Error("지원하지 않는 결과 ID입니다.");
  return value;
}

function safeId(value) {
  return encodeURIComponent(String(value)).replace(/%/g, "~").replace(/[^A-Za-z0-9_.~-]/g, "_");
}

function shortFileId(value) {
  const safe = safeId(value);
  const hash = createHash("sha1").update(String(value)).digest("hex").slice(0, 10);
  return `${safe.slice(0, 72)}~${hash}`;
}

function markdownDownloadName(result) {
  const ext = extname(result.file || "");
  const stem = basename(result.file || "converted", ext) || "converted";
  const provider = result.provider || "model";
  const stamp = String(result.createdAt || new Date().toISOString()).replace(/[:.]/g, "-");
  const raw = `${stem}__${provider}__${stamp}`.normalize("NFKC");
  const safe = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 175);
  return `${safe || "converted"}.md`;
}

function withoutMarkdown(record) {
  const { markdown, ...rest } = record;
  return rest;
}

async function readJson(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function numberOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function serveReviewFile(c, asset) {
  const file = asset && asset !== "/" ? asset : "index.html";
  if (!/^[A-Za-z0-9_.-]+$/.test(file)) return c.text("Not found", 404);
  const path = resolve(REVIEW_DIR, file);
  if (!isInside(REVIEW_DIR, path) || !existsSync(path)) return c.text("Not found", 404);
  // dev 검수 UI — 캐시 금지. 안 그러면 app.js/styles.css 수정이 캐시된 구버전과
  // 섞여 모듈이 죽는다(예: 제거된 요소 참조). 정적 자산이 작아 캐시 이득도 없음.
  return c.body(readFileSync(path), 200, {
    "Content-Type": contentType(file),
    "Cache-Control": "no-store, must-revalidate",
  });
}

function serveCorpusFile(c, file) {
  const safe = requireFileName(file);
  const path = corpusPath(safe);
  return c.body(readFileSync(path), 200, {
    "Content-Type": sourceContentType(safe),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(safe)}`,
  });
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function isInsideOrSame(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}

function ensureSafeWorkspaceDir(dir) {
  if (!isInside(ROOT, dir)) throw new Error("workspace 밖 캐시 경로는 초기화할 수 없습니다.");
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function sourceContentType(file) {
  const ext = extname(file).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xls") return "application/vnd.ms-excel";
  return "application/octet-stream";
}

function isImageExt(ext) {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"].includes(ext);
}
