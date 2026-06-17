// 흐름도(화살표 든 표) 감지 + mermaid 추출 회귀 테스트 (assertion 기반, AI 호출 불필요)
// 실행: node tests/flowchart.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { findFlowchartTargets, extractMermaid } from "../server/vllm.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

// 실제 kordoc 이 2016 수원시 HWP 의 '신청 및 입주절차' 흐름도를 떠온 형태(화살표 ⇨⇩⇦).
const FLOWCHART_TABLE = [
  "<table>",
  '<tr><th rowspan="2">입주희망기관</th><th rowspan="2">⇨</th><th>신청접수</th><th rowspan="2">⇨</th><th>운영기관 선정</th></tr>',
  "<tr><td>경기도청 담당부서</td><td>경기도</td></tr>",
  "<tr><td></td><td></td><td></td><td></td><td>⇩</td></tr>",
  '<tr><td rowspan="2"></td><td></td><td rowspan="2">잔금납부 및 입주</td><td>⇦</td><td>임대차계약</td></tr>',
  "<tr><td></td><td></td><td>LH↔운영기관</td></tr>",
  "</table>",
].join("\n");

console.log("\n[1] 화살표 든 표 → 흐름도 감지");
{
  const md = `## Ⅴ. 신청 및 입주절차\n\n${FLOWCHART_TABLE}\n\n다음 본문 문단입니다.`;
  const t = findFlowchartTargets(md);
  ok(t.length === 1, `흐름도 표 1개 감지 (got ${t.length})`);
  ok(t[0]?.type === "flowchart", "타입 flowchart");
  const span = md.slice(t[0].index, t[0].index + t[0].length);
  ok(span.startsWith("<table") && span.endsWith("</table>"), "범위가 <table>…</table> 전체를 정확히 덮음");
  ok(span.includes("입주희망기관") && span.includes("임대차계약"), "단계 텍스트 포함");
}

console.log("\n[2] 데이터 표 / 화살표 부족은 미감지 (오탐 방지)");
ok(findFlowchartTargets("<table><tr><td>구분</td><td>값</td></tr><tr><td>a</td><td>1</td></tr></table>").length === 0, "일반 데이터 표 미감지");
ok(findFlowchartTargets("<table><tr><td>A→B 설명</td></tr></table>").length === 0, "화살표 1개뿐인 표 미감지");
ok(findFlowchartTargets("화살표 → 가 본문에 있어도 ← 표가 아니면 무시").length === 0, "표 밖 화살표 무시");

console.log("\n[3] 중첩 표 / 다중 표 범위");
{
  const two = `${FLOWCHART_TABLE}\n\n<table><tr><td>일반</td><td>표</td></tr></table>\n\n${FLOWCHART_TABLE}`;
  ok(findFlowchartTargets(two).length === 2, "흐름도 표 2개만 감지(중간 일반표 제외)");
}

console.log("\n[4] mermaid 추출 (흐름도 아님/형식불량 → null = 원본 표 유지)");
ok(extractMermaid("```mermaid\ngraph LR\nA[\"입주희망기관\"] --> B[\"신청접수\"]\n```") === 'graph LR\nA["입주희망기관"] --> B["신청접수"]', "코드블록에서 mermaid 본문 추출");
ok(extractMermaid("graph TD\nA-->B") === "graph TD\nA-->B", "펜스 없는 graph 본문 허용");
ok(extractMermaid("NO_FLOWCHART") === null, "NO_FLOWCHART → null");
ok(extractMermaid("이 표는 신청 절차를 나타냅니다. 단계는 다음과 같습니다.") === null, "산문 응답 → null");
ok(extractMermaid("") === null, "빈 응답 → null");
ok(extractMermaid("```mermaid\nflowchart TD\n  A-->B\n```") === "flowchart TD\n  A-->B", "flowchart 키워드도 허용");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
