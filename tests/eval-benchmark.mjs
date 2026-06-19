// Review UI benchmark runner.
// Usage:
//   $env:BENCH_GEMINI_KEY="..."
//   node tests/eval-benchmark.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.BENCH_API || "http://localhost:8788";
const FILES = (process.env.BENCH_FILES || [
  "교육이수증.pdf",
  "자립준비청년과 보호종료예정아동을 위한 2026년 자립지원 포켓북.pdf",
  "주거지원정책.hwpx",
  "RAG_기술제안서 1.docx",
  "sample_1.png",
].join("|")).split("|").filter(Boolean);
const PROVIDERS = (process.env.BENCH_PROVIDERS || "vllm|gemini|claude_cli|codex_cli").split("|").filter(Boolean);

const providerOverrides = {
  gemini: {
    api_key: process.env.BENCH_GEMINI_KEY || "",
    model: process.env.BENCH_GEMINI_MODEL || "gemini-3.5-flash",
  },
  claude_cli: { model: process.env.BENCH_CLAUDE_MODEL || "opus4.8" },
  codex_cli: { model: process.env.BENCH_CODEX_MODEL || "gpt-5.5" },
};

const startedAt = new Date().toISOString();
const rows = [];

console.log(`[bench] api=${API}`);
console.log(`[bench] files=${FILES.length} providers=${PROVIDERS.join(",")}`);

for (const file of FILES) {
  for (const provider of PROVIDERS) {
    const label = `${file} :: ${provider}`;
    process.stdout.write(`[bench] start ${label}\n`);
    try {
      const response = await fetch(`${API}/api/eval/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file,
          provider,
          docType: docTypeOf(file),
          providerOverrides,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const result = data.result;
      rows.push(result);
      const status = result.ok ? "ok" : `fail:${result.code || "ERROR"}`;
      console.log(
        `[bench] done ${label} ${status} ${(result.elapsedMs / 1000).toFixed(1)}s` +
          ` chars=${result.quality?.chars ?? "-"} issues=${result.quality?.problemTotal ?? "-"}`
      );
    } catch (e) {
      const row = {
        file,
        provider,
        ok: false,
        error: e?.message || String(e),
        elapsedMs: null,
        createdAt: new Date().toISOString(),
      };
      rows.push(row);
      console.log(`[bench] error ${label} ${row.error}`);
    }
  }
}

const finishedAt = new Date().toISOString();
mkdirSync("tests/_eval/benchmarks", { recursive: true });
const outPath = join("tests/_eval/benchmarks", `${startedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, `${JSON.stringify({ startedAt, finishedAt, files: FILES, providers: PROVIDERS, rows }, null, 2)}\n`);

console.log(`\n[bench] saved ${outPath}`);
console.table(rows.map((r) => ({
  file: r.file,
  provider: r.provider,
  ok: r.ok,
  seconds: r.elapsedMs == null ? "-" : +(r.elapsedMs / 1000).toFixed(1),
  chars: r.quality?.chars ?? "-",
  issues: r.quality?.problemTotal ?? "-",
  score: r.metrics?.overallScore ?? "-",
  code: r.code || "",
})));

function docTypeOf(file) {
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(file)) return "image-ocr";
  if (/포켓북|pocket|booklet/i.test(file)) return "pdf-pocketbook";
  if (/\.pdf$/i.test(file)) return "pdf-single";
  if (/\.(hwp|hwpx|hwpml)$/i.test(file)) return "hwp";
  return "document";
}
