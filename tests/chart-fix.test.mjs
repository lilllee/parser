// 차트 PDF 회귀 테스트: 흩어진 정수라벨 그룹막대 + 흰색(투명) 머리글 케이스.
// 세 가지 수정을 가드한다.
//   원인1: detectMangledPages 가 흩어진 차트 페이지를 못 잡아 vision 재추출이 안 됨.
//   원인2: postprocess 페이지번호 룰(^\d{1,4}$)이 줄마다 흩어진 차트 값을 삭제함.
//   원인3: kordoc 이 텍스트 레이어의 흰색(안 보이는) 머리글을 그대로 떠옴.
// 실행: node tests/chart-fix.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { parse, blocksToMarkdown } from "kordoc";
import { readFileSync, existsSync } from "node:fs";
import { detectMangledPages } from "../server/detect.js";
import { postprocessMarkdown } from "../server/postprocess.js";
import { collectInvisibleText, stripInvisibleFromBlocks } from "../server/invisible.js";

const FILE = "tests/file/US_Professional_Services_Partner_Compensation_Survey_2024_p11.pdf";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

// 테스트 데이터(PDF)는 저장소에 포함하지 않음 — 없으면 스킵(로컬에서만 검증).
if (!existsSync(FILE)) {
  console.log(`⏭  스킵: ${FILE} 없음 (테스트 데이터 미포함)`);
  process.exit(0);
}

const buf = readFileSync(FILE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const r = await parse(ab.slice(0));

// 텍스트 레이어 경로 재현: 흰색 텍스트 제거 → markdown 생성 → postprocess.
const invis = collectInvisibleText(ab.slice(0));
const { blocks } = stripInvisibleFromBlocks(r.blocks, invis);
const md = postprocessMarkdown(blocksToMarkdown(blocks));

// 차트 정답값(2024/2022 × 6항목) 12개. 라벨연결 무시한 '숫자 존재' 상한 측정.
const GT = [9, 5, 13, 14, 27, 45, 35, 24, 14, 6, 1, 6];
const coverage = (s) => {
  const pool = (s.match(/\d+/g) || []).map(Number);
  let f = 0;
  for (const v of GT) { const i = pool.indexOf(v); if (i >= 0) { f++; pool.splice(i, 1); } }
  return f;
};

console.log("\n[원인1] detectMangledPages 가 흩어진 차트 페이지(p1)를 vision 재추출 대상으로 잡는다");
ok(detectMangledPages(r.blocks, r.pageCount || 0).includes(1), "p1 flagged");

console.log("\n[원인2] postprocess 페이지번호 룰이 차트 값을 삭제하지 않는다 (12개 전부 보존)");
ok(coverage(md) === 12, `value coverage ${coverage(md)}/12`);

console.log("\n[원인3] 흰색(투명) 머리글은 제거, 보이는 라벨/머리글은 보존");
ok(invis.get(1)?.some((t) => t.includes("Diverse region")), "흰색 머리글 'Diverse region' 감지");
ok(!md.includes("Diverse region"), "출력에서 'Diverse region' 제거됨");
ok(/HEIDRICK/.test(md.replace(/\s+/g, "")), "보이는 머리글 'HEIDRICK' 보존");
ok(["9", "13", "27", "14", "35"].every((v) => md.includes(v)), "막대 위 흰 숫자 라벨(9,13,27,14,35) 보존");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
