// Eval API regression tests (no external AI calls).
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const root = join(process.cwd(), ".cache", `eval-test-${process.pid}`);
process.env.EVAL_CORPUS_DIR = join(root, "corpus");
process.env.EVAL_GOLDEN_DIR = join(root, "golden");
process.env.EVAL_DIR = join(root, "eval");

const { registerEvalRoutes } = await import("../server/eval.js");

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) {
    pass++;
    console.log("  ✅ " + message);
  } else {
    fail++;
    console.log("  ❌ " + message);
  }
};

try {
  const app = new Hono();
  registerEvalRoutes(app);

  console.log("\n[eval golden] 저장한 골든을 다시 로드");
  {
    const markdown = "# Golden\n\n값 123";
    const put = await app.request("/api/eval/golden", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: "sample.md", markdown }),
    });
    ok(put.status === 200, `PUT /api/eval/golden status=${put.status}`);

    const get = await app.request("/api/eval/golden?file=sample.md");
    const data = await get.json();
    ok(get.status === 200, `GET /api/eval/golden status=${get.status}`);
    ok(data.exists === true, "exists=true");
    ok(data.generated === false, "generated=false");
    ok(data.scorable === true, "scorable=true");
    ok(data.markdown === markdown, "저장한 markdown 반환");
    ok(data.media?.kind === "text", "원본 media 정보 유지");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
