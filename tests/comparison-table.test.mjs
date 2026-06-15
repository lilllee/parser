// 비교표(현행/개정·전/후) 회귀 테스트.
// kordoc 은 3단(쪽|현행|개정) 비교표를 망가뜨린다. 세 신호로 vision 재추출 대상에 넣는다:
//   - isDuplicateColumnTable: 좌우 칼럼이 거의 같은 대칭 비교표
//   - isCrammedCellTable: 한 셀에 여러 줄을 욱여넣은 표(비대칭 페이지)
//   - detectRevisionComparisonPages: '현행'+'개정' 머리글이 함께 있는 페이지
// 실행: node tests/comparison-table.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { parse } from "kordoc";
import { readFileSync, existsSync } from "node:fs";
import {
  detectMangledPages,
  isDuplicateColumnTable,
  isCrammedCellTable,
  detectRevisionComparisonPages,
} from "../server/detect.js";

const FILE = "tests/file/2024. 입양실무 매뉴얼-10-18.pdf";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

console.log("\n[1] isDuplicateColumnTable: 좌우 중복 컬럼 표는 잡고, 정상 표는 안 잡는다");
const dupTable = {
  rows: 4, cols: 2,
  cells: [
    [{ text: "보호자의 입양 동의 및 아동 일시보호" }, { text: "보호자의 입양 동의 및 아동 일시보호" }],
    [{ text: "입양동의서를 가정법원에 제출해야 함" }, { text: "입양동의서를 가정법원에 제출해야 함" }],
    [{ text: "친생부모 양측의 동의를 받아야 함" }, { text: "친생부모 양측의 동의를 받아야 하며," }],
    [{ text: "동의를 받도록 최대한 노력함" }, { text: "동의를 받도록 최대한 노력함" }],
  ],
};
const normalTable = {
  rows: 4, cols: 3,
  cells: [
    [{ text: "시도" }, { text: "출생아수" }, { text: "사망자수" }],
    [{ text: "서울특별시" }, { text: "12345" }, { text: "23456" }],
    [{ text: "부산광역시" }, { text: "6789" }, { text: "11223" }],
    [{ text: "대구광역시" }, { text: "5544" }, { text: "9988" }],
  ],
};
ok(isDuplicateColumnTable(dupTable) === true, "중복 컬럼 비교표 → 감지");
ok(isDuplicateColumnTable(normalTable) === false, "정상 통계표(열마다 다른 값) → 미감지(오탐 없음)");

console.log("\n[2] isCrammedCellTable: 한 셀에 여러 줄 뭉친 표는 잡고, 정상/긴-1줄 셀은 안 잡는다");
const crammed = { rows: 1, cols: 1, cells: [[{ text: Array.from({ length: 12 }, (_, i) => `${i}번째 줄 내용`).join("\n") }]] };
const longOneLine = { rows: 2, cols: 2, cells: [[{ text: "구분" }, { text: "값" }], [{ text: "서울" }, { text: "가".repeat(800) }]] };
ok(isCrammedCellTable(crammed) === true, "12줄 뭉친 셀 → 감지");
ok(isCrammedCellTable(longOneLine) === false, "줄바꿈 없는 긴 셀(통계표) → 미감지(오탐 없음)");
ok(isCrammedCellTable(normalTable) === false, "정상 통계표 → 미감지");

console.log("\n[3] 실제 비교표 PDF: 망가진 비교표 페이지가 전부 vision 재추출 대상으로 잡힌다");
if (!existsSync(FILE)) {
  console.log(`  ⏭  스킵: ${FILE} 없음 (테스트 데이터는 저장소에 포함하지 않음)`);
} else {
  const buf = readFileSync(FILE);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = await parse(ab.slice(0));
  const flagged = detectMangledPages(r.blocks, r.pageCount || 9);
  // 대칭 표 페이지(3,4,7,8,9) + 비대칭(셀 뭉침) 페이지(5,6) 모두 — 이전엔 5,6 누락이었음
  for (const p of [3, 4, 5, 6, 7, 8, 9]) ok(flagged.includes(p), `p${p}(비교표) flagged`);
  const revPages = detectRevisionComparisonPages(r.blocks);
  ok(revPages.size >= 1, `revision 머리글 페이지 감지 (${[...revPages].sort((a, b) => a - b).join(",")})`);
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
