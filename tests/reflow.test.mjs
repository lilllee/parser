// reflowBlocksWithOcr 회귀 테스트.
// kordoc 가 블록 0개로 떤 페이지라도 vision OCR 결과가 있으면 누락 없이 올바른 순서에 삽입돼야
// 한다(예전엔 교체할 원본 블록이 없어 빈 페이지의 OCR 텍스트가 통째로 사라졌다 — 인구동향 등에서
// 마지막 표 누락).
// 실행: node tests/reflow.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { reflowBlocksWithOcr } from "../server/convert.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };
const blk = (pn) => ({ type: "table", pageNumber: pn, bbox: { x: 0, y: 0, width: 10, height: 10 }, table: {} });
const pagesOf = (out) => out.map((b) => b.pageNumber);

console.log("\n[1] 0블록 페이지의 OCR 텍스트가 누락되지 않는다 (핵심 버그)");
{
  const blocks = [blk(1), blk(2)]; // kordoc: 페이지 1,2 만 추출 (페이지 3 = 0블록)
  const texts = new Map([[1, "p1"], [2, "p2"], [3, "자연증가 전북 전남 경북 경남 제주"]]);
  const out = reflowBlocksWithOcr(blocks, texts);
  ok(out.some((b) => b.pageNumber === 3), "페이지 3(0블록) OCR 텍스트 출력됨");
  ok(out.some((b) => (b.text || "").includes("제주")), "제주 표 내용 보존");
}

console.log("\n[2] 중간 빈 페이지도 올바른 순서 위치에 삽입");
{
  const blocks = [blk(1), blk(3)]; // 페이지 2 = 0블록
  const texts = new Map([[2, "middle"]]); // 페이지 2 만 OCR
  const out = reflowBlocksWithOcr(blocks, texts);
  ok(JSON.stringify(pagesOf(out)) === JSON.stringify([1, 2, 3]), `페이지 순서 1,2,3 (got ${pagesOf(out)})`);
}

console.log("\n[3] 기존 동작 유지: OCR 페이지는 교체, 비-OCR 페이지는 원본 보존");
{
  const blocks = [blk(1), blk(2)];
  const texts = new Map([[1, "ocr1"]]); // 페이지 1 만 OCR
  const out = reflowBlocksWithOcr(blocks, texts);
  const p1 = out.filter((b) => b.pageNumber === 1);
  ok(p1.length === 1 && p1[0].type === "paragraph" && p1[0].text === "ocr1", "페이지 1 OCR 텍스트로 교체");
  const p2 = out.filter((b) => b.pageNumber === 2);
  ok(p2.length === 1 && p2[0].type === "table", "페이지 2 원본 블록 보존");
}

console.log("\n[4] 여러 블록 페이지: OCR 결과로 한 번만 교체(중복 없음)");
{
  const blocks = [blk(1), blk(1), blk(1)]; // 페이지 1 에 원본 블록 3개
  const texts = new Map([[1, "a\n\nb"]]); // 빈 줄 기준 2청크
  const out = reflowBlocksWithOcr(blocks, texts);
  ok(out.length === 2 && out.every((b) => b.pageNumber === 1), "3블록 → OCR 2청크로 교체(중복 삽입 없음)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
