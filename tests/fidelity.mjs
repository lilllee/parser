// 내용 보존율(content recall) 하니스 — 매칭율 검증용.
// 텍스트 레이어 PDF/HWP 는 kordoc 이 원문 텍스트를 정확히 추출하므로, 그 토큰 집합을 '원문 기준'으로
// 보고 최종 runConvert 출력이 얼마나 보존했는지(recall) 측정한다. reflow(vision 재추출)나 postprocess
// 가 내용을 누락/변형하면 recall 이 떨어진다. (이미지 기반 PDF·이미지 파일은 텍스트레이어가 없어 제외)
//   node tests/fidelity.mjs [dir]   기본 dir=tests/file
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "kordoc";
import { runConvert } from "../server/convert.js";
import { resolveAiConfig } from "../server/ai.js";

const dir = process.argv.slice(2).find((a) => !a.startsWith("--")) || "tests/file";
const SUPPORTED = /\.(pdf|hwp|hwpx|hwpml|docx|xlsx|xls)$/i; // 텍스트 추출 가능한 형식만
const files = readdirSync(dir).filter((f) => SUPPORTED.test(f)).sort();
const ai = resolveAiConfig({ provider: process.argv.includes("--no-ai") ? "none" : "vllm" });

// 내용 토큰: 한글 2+음절 / 숫자 / 영문 2+. markdown·HTML 마크업과 enrich 인용(>)·표 기호는 무시.
function tokens(md) {
  const text = String(md || "")
    .replace(/<[^>]+>/g, " ")           // HTML 태그
    .replace(/[#*`|>\-_~\[\]()]/g, " ") // markdown 기호
    .replace(/&[a-z]+;/gi, " ");
  return new Set(text.match(/[가-힣]{2,}|\d{2,}|[A-Za-z]{3,}/g) || []);
}
const recall = (src, out) => {
  if (!src.size) return null;
  let hit = 0;
  for (const t of src) if (out.has(t)) hit++;
  return hit / src.size;
};
// 구조 지표 — recall(내용)만으론 못 잡는 결함: kordoc 이 목차·산문을 표로 깨뜨린 '가짜 표' 잔존 수.
// 좁은 표(<=6열) 중 빈 셀 >=50% 또는 1~6셀에 <br>>=8 (진짜 병합 그리드·데이터 표는 제외).
function fakeTableCount(md) {
  let n = 0;
  for (const t of String(md).match(/<table[\s\S]*?<\/table>/gi) || []) {
    const rows = t.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    let mc = 0;
    for (const rw of rows) { let c = 0; for (const cl of rw.match(/<t[dh][^>]*>/gi) || []) { const m = cl.match(/colspan\s*=\s*["']?(\d+)/i); c += m ? +m[1] : 1; } mc = Math.max(mc, c); }
    const cs = (t.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).length;
    const e = (t.match(/<t[dh][^>]*>\s*<\/t[dh]>/gi) || []).length;
    const br = (t.match(/<br/gi) || []).length;
    if (mc <= 6 && ((cs && e / cs >= 0.5) || (cs <= 6 && br >= 8))) n++;
  }
  return n;
}

console.log(`[fidelity] dir=${dir} files=${files.length}\n`);
for (const f of files) {
  const buf = readFileSync(join(dir, f));
  const mk = () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength).slice(0);
  let srcMd, outMd;
  try {
    srcMd = (await parse(mk())).markdown || "";
  } catch (e) { console.log(`❌ ${f}  kordoc 실패: ${e?.message || e}`); continue; }
  if (!tokens(srcMd).size) { console.log(`⏭  ${f}  텍스트레이어 없음(이미지 기반) — recall 제외`); continue; }
  try {
    outMd = (await runConvert(mk(), f, {}, ai)).markdown || "";
  } catch (e) { console.log(`❌ ${f}  변환 실패: ${e?.message || e}`); continue; }

  const src = tokens(srcMd), out = tokens(outMd);
  const r = recall(src, out);
  const dropped = [...src].filter((t) => !out.has(t));
  const fake = fakeTableCount(outMd);
  const mark = r >= 0.97 && fake === 0 ? "🟢" : r >= 0.9 ? "🟡" : "🔴";
  console.log(`${mark} ${f}  recall ${(r * 100).toFixed(1)}% (원문 ${src.size}토큰 중 누락 ${dropped.length}) · 구조결함(가짜표) ${fake}`);
  if (dropped.length) console.log(`     누락 예: ${dropped.slice(0, 25).join(" ")}`);
}
