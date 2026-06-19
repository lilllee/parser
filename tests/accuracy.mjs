// 변환 정확도 / 회귀 하니스: 코퍼스 → runConvert → scoreMarkdown + 골든 비교.
//   node tests/accuracy.mjs [dir] [--save] [--provider=vllm] [--max=N]
//   dir 기본 tests/file. --save 로 현재 결과를 골든(tests/_golden/<file>.md)으로 저장,
//   생략 시 골든과 비교해 점수 회귀(🔴)/개선(🟢)/동일(✅)/내용변경(⚠️)을 보고한다.
//   회귀가 하나라도 있으면 exit 1 (CI 게이트).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { runConvert } from "../server/convert.js";
import { resolveAiConfig } from "../server/ai.js";
import { scoreMarkdown } from "./quality.mjs";

const args = process.argv.slice(2);
const arg = (name, def) => (args.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${def}`).split("=").slice(1).join("=");
const dir = args.find((a) => !a.startsWith("--")) || "tests/file";
const save = args.includes("--save");
const provider = arg("provider", "vllm");
const max = Number(arg("max", 0));

const GOLDEN = "tests/_golden";
mkdirSync(GOLDEN, { recursive: true });
const SUPPORTED = /\.(pdf|hwp|hwpx|hwpml|docx|xlsx|xls|png|jpe?g|webp|gif|bmp|tiff?)$/i;
let files = readdirSync(dir).filter((f) => SUPPORTED.test(f)).sort();
if (max) files = files.slice(0, max);

const aiConfig = resolveAiConfig({ provider });
console.log(`[accuracy] dir=${dir} provider=${provider} files=${files.length} ${save ? "(SAVE golden)" : "(compare)"}\n`);

let regressions = 0;
for (const f of files) {
  const buf = readFileSync(join(dir, f));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const t0 = Date.now();
  let md = "";
  try {
    md = (await runConvert(ab, f, {}, aiConfig)).markdown || "";
  } catch (e) {
    console.log(`❌ ${f}  변환실패: ${e?.message || e}`);
    continue;
  }
  const ms = Date.now() - t0;
  const s = scoreMarkdown(md);

  const goldenPath = join(GOLDEN, basename(f) + ".md");
  const golden = existsSync(goldenPath) ? readFileSync(goldenPath, "utf-8") : null;
  if (save) writeFileSync(goldenPath, md);

  let delta = save ? " | 골든 저장" : " | (골든 없음)";
  if (golden != null && !save) {
    const gs = scoreMarkdown(golden);
    const dProb = s.problemTotal - gs.problemTotal;
    const dChars = s.chars - gs.chars;
    const mark = dProb > 0 ? "🔴 회귀" : dProb < 0 ? "🟢 개선" : golden === md ? "✅ 동일" : "⚠️ 내용변경";
    if (dProb > 0) regressions++;
    delta = ` | Δ자 ${dChars >= 0 ? "+" : ""}${dChars}, Δ문제 ${dProb >= 0 ? "+" : ""}${dProb} → ${mark}`;
  }

  const probs = Object.entries(s.issues).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(
    `📄 ${f}  ${s.chars}자 · 문제 ${s.problemTotal}` +
    `${s.chartCoverage != null ? ` · 차트커버 ${s.chartCoverage}` : ""} · ${(ms / 1000).toFixed(1)}s${delta}`
  );
  if (probs) console.log(`     ${probs}`);
}

console.log(`\n총 ${files.length}개 · 회귀 ${regressions}개`);
// process.exit() 는 native addon(canvas/mupdf) 핸들이 닫히는 중 libuv assert 를 내므로,
// exitCode 만 설정하고 이벤트 루프가 자연 종료하게 둔다.
process.exitCode = regressions ? 1 : 0;
