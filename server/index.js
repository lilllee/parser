// HTTP 서버: 라우트 + Swagger UI. 변환 로직은 convert.js, 후처리는 postprocess.js.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { pathToFileURL } from "node:url";
import { runConvert } from "./convert.js";
import { markdownTablesToHtml } from "./postprocess.js";
import { resolveAiConfig } from "./ai.js";
import { checkVllmConnection, vllmInfo, VLLM_ENABLED } from "./vllm.js";
import { openapiSpec } from "./openapi.js";
import { registerEvalRoutes } from "./eval.js";

const PORT = Number(process.env.PORT || 8787);

const app = new Hono();

app.use("/api/*", cors({ origin: process.env.CORS_ORIGIN || "*" }));
registerEvalRoutes(app);

app.get("/api/health", (c) => c.json({ ok: true, kordoc: true, vllm: vllmInfo }));
app.get("/api/vllm/check", async (c) => c.json(await checkVllmConnection()));
app.get("/api/openapi.json", (c) => {
  const u = new URL(c.req.url);
  const host = (c.req.header("x-forwarded-host") || u.host).split(",")[0].trim();
  const proto = (c.req.header("x-forwarded-proto") || u.protocol.replace(/:$/, "")).split(",")[0].trim();
  return c.json({ ...openapiSpec, servers: [{ url: `${proto}://${host}` }] });
});
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json", title: "fs.md API" }));

// POST /api/convert (multipart): file + provider(+provider 설정) → { ok, markdown, metadata, pageCount }.
// provider/설정 상세는 openapi.js(/api/docs) 참고.
app.post("/api/convert", async (c) => {
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  const parsed = await readMultipartFile(c);
  if (parsed.error) return c.json({ ok: false, error: parsed.error, elapsedMs: elapsedMs() }, 400);
  const { arrayBuffer, filename, body } = parsed;

  let aiConfig;
  try {
    aiConfig = resolveAiConfig(body);
  } catch (e) {
    return c.json(
      { ok: false, error: e?.message || String(e), code: e?.code || "BAD_PROVIDER", elapsedMs: elapsedMs() },
      400
    );
  }

  console.log(
    `[convert] ${filename} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB) · provider=${aiConfig.id}`
  );

  // 출력 표 포맷: md(기본, 사람/RAG 가독) | html(<table>, 구조보존·ParseBench GRITS 등).
  const format = String(body.format || body.output_format || "md").toLowerCase() === "html" ? "html" : "md";

  // 강제 전체페이지 vision OCR (kordoc 우회). dense 표를 kordoc 이 산산조각 내는 PDF용. vision provider 필요.
  // 우선순위: 요청 명시(force_ocr/ocr/mode=vision) > 서버 기본(FORCE_OCR env). 셋 다 없으면 false.
  // 적용 대상은 convert 가 결정 — PDF 만 force(이미지는 별도 vision 경로, HWP/HWPX/DOCX 는 kordoc 유지).
  const boolOf = (v) => (v == null || String(v).trim() === "" ? undefined : /^(1|true|on|yes)$/i.test(String(v)));
  let reqForce = boolOf(body.force_ocr);
  if (reqForce === undefined) reqForce = boolOf(body.ocr);
  if (reqForce === undefined && String(body.mode || "").toLowerCase() === "vision") reqForce = true;
  const forceOcr = reqForce ?? (boolOf(process.env.FORCE_OCR) ?? false);

  try {
    const result = await runConvert(arrayBuffer, filename, { forceOcr }, aiConfig);
    const markdown = format === "html" ? markdownTablesToHtml(result.markdown || "") : result.markdown;
    return c.json({ ok: true, ...result, markdown, format, elapsedMs: elapsedMs() });
  } catch (e) {
    console.error("[convert] 실패:", e);
    return c.json({ ok: false, error: e?.message || String(e), code: e?.code, elapsedMs: elapsedMs() }, 500);
  }
});

async function readMultipartFile(c) {
  let body;
  try {
    body = await c.req.parseBody();
  } catch (e) {
    return { error: `multipart 파싱 실패: ${e.message}` };
  }
  const file = body.file;
  if (!file || typeof file === "string") {
    return { error: "file 필드가 필요합니다." };
  }
  const arrayBuffer = await file.arrayBuffer();
  return { arrayBuffer, filename: file.name || "unknown", body };
}

// 직접 실행(node server/index.js)일 때만 listen. import 시엔 안 띄움(테스트용).
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (IS_MAIN) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(
      `[server] listening on http://localhost:${info.port}  vLLM=${VLLM_ENABLED ? "on" : "off"} ${vllmInfo.url ? `url=${vllmInfo.url}` : ""}`
    );
    console.log(`[server] Swagger UI: http://localhost:${info.port}/api/docs`);
  });
}
