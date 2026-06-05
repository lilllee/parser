// 감지 로직 회귀 테스트 (assertion 기반, vLLM 불필요)
// 실행: node tests/detect.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { parse } from "kordoc";
import { readFileSync } from "node:fs";
import { detectMangledPages, glyphNoiseScore } from "../server/detect.js";
import { scoreMarkdown } from "./quality.mjs";

const DIR = "D:/workspace/file";
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); } };

async function blocksOf(file) {
  const buf = readFileSync(`${DIR}/${file}`);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const r = await parse(ab.slice(0));
  return r;
}

console.log("\n[1] 인구동향: 통계표 다수 → 망가진 페이지 많이 감지 + 시도별표 페이지 포함");
{
  const r = await blocksOf("2026년 3월 인구동향.pdf");
  const pages = detectMangledPages(r.blocks);
  ok(pages.length >= 30, `flagged ${pages.length}p (>=30 기대)`);
  ok(pages.includes(6), `p6([표2] 시도별 출생아) 포함=${pages.includes(6)}`);
}

console.log("\n[2] 정책 안내서: 한국어 띄어쓰기 소실 페이지 감지");
{
  const r = await blocksOf("온라인 구독형 서비스 제공사업자를 위한 이용자보호 정책 안내서.pdf");
  const pages = detectMangledPages(r.blocks);
  ok(pages.length >= 10, `flagged ${pages.length}p (>=10 기대)`);
  ok(pages.includes(7), `p7(주요개념 무공백) 포함=${pages.includes(7)}`);
}

console.log("\n[4] 스코어러: 깨끗한 텍스트=0, 망가진 패턴 감지");
{
  ok(scoreMarkdown("# 제목\n\n정상적인 한국어 문장입니다. 띄어쓰기 정상.").problemTotal === 0, "정상 md → 문제 0");
  ok(scoreMarkdown("프로모션상품을설명하는과정에서유료구독전환시점정기구독료수준등을안내").issues.brokenKoreanSpacing >= 1, "무공백 한글 → brokenKoreanSpacing 감지");
  ok(scoreMarkdown("| 전국 238,317 254,457 21,112 65,362 22,898 25,200 75,013 4,088 9,651 |").issues.crammedTableRows >= 1, "콤마구분 숫자 뭉친 셀 → crammedTableRows 감지");
  ok(scoreMarkdown("| 일정 | 2026.05.22 | 2026.06.01 | 2026.06.02 |").issues.crammedTableRows === 0, "정상 날짜 표 → 오탐 없음");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
