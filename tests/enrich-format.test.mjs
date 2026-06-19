// enrich 삽입 블록 포맷 회귀 테스트 (assertion 기반, vLLM 불필요)
// 실행: node tests/enrich-format.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { formatInsertion } from "../server/vllm.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); } };

console.log("\n[1] 표 없는 산문 → 기존처럼 한 줄 '> ' 인용");
{
  const out = formatInsertion("첫 문장입니다.\n둘째 줄도\n이어집니다.");
  ok(out === "\n\n> 첫 문장입니다. 둘째 줄도 이어집니다.\n", `한 줄 인용 병합: ${JSON.stringify(out)}`);
  ok(formatInsertion("") === "", "빈 응답 → 빈 문자열");
}

console.log("\n[2] markdown 표 포함 → 표 보존 + 산문만 인용");
{
  const out = formatInsertion(
    "차트 분석입니다.\n\n| 항목 | 값 |\n| :-- | :-- |\n| OTT | 69.1 |\n\n마무리 문장."
  );
  ok(out.includes("\n| 항목 | 값 |\n| :-- | :-- |\n| OTT | 69.1 |"), "표 행이 줄바꿈 그대로 보존");
  ok(out.includes("> 차트 분석입니다."), "앞 산문이 인용으로");
  ok(out.includes("> 마무리 문장."), "뒤 산문이 인용으로");
  ok(!/>\s*\|/.test(out), "표가 인용 안에 갇히지 않음");
  ok(/\|\n\n> 마무리/.test(out), "표와 다음 인용 사이 빈 줄(블록 분리)");
}

console.log("\n[3] HTML <table> 포함 → 태그 블록 보존");
{
  const out = formatInsertion(
    "설명 한 줄.\n<table>\n<tr><td>69.1</td></tr>\n</table>\n끝 문장."
  );
  ok(out.includes("<table>\n<tr><td>69.1</td></tr>\n</table>"), "HTML 표 멀티라인 보존");
  ok(out.includes("> 설명 한 줄."), "산문 인용 유지");
}

console.log("\n[4] 과포장 응답(헤딩/구분선) 정리 — 인용 안에서 깨지지 않게");
{
  const claudeish =
    "# 이미지 분석\n\n이 이미지는 LH 로고입니다.\n\n---\n\n## 구성 요소\n\n| 요소 | 설명 |\n| :-- | :-- |\n| 심볼 | 두 원형 |\n\n---\n\n## 특징\n\n간결한 로고.";
  const out = formatInsertion(claudeish);
  ok(!/>\s*#/.test(out), "인용에 '# 헤딩'이 남지 않음(평문화)");
  ok(!/^\s*-{3,}\s*$/m.test(out), "수평선(---) 줄이 제거됨");
  ok(out.includes("| 요소 | 설명 |"), "표는 그대로 보존");
  ok(out.includes("> 이미지 분석"), "헤딩 텍스트는 평문 인용으로 유지");
  const heading = formatInsertion("## 결론\n\n핵심만 적는다.");
  ok(heading === "\n\n> 결론 핵심만 적는다.\n", `표 없는 헤딩 응답도 평문 한 줄 인용: ${JSON.stringify(heading)}`);
}

console.log(`\n결과: ${pass} 통과, ${fail} 실패`);
process.exit(fail ? 1 : 0);
