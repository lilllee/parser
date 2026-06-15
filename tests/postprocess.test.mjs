// postprocessMarkdown 회귀 테스트: 페이지번호/머리말·꼬리말 제거 + 페이지 경계 표 병합.
// 실행: node tests/postprocess.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { postprocessMarkdown } from "../server/postprocess.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

console.log("\n[1] 고립 페이지번호는 제거, 흩어진 차트 값(군집)은 보존");
ok(!/(^|\n)11(\n|$)/.test(postprocessMarkdown("본문 한 줄.\n\n11\n\n다음 본문.")), "고립 '11' 제거");
ok(["45", "35", "24"].every((v) => postprocessMarkdown("항목\n\n45\n\n35\n\n다음\n\n24").includes(v)), "숫자 군집 보존");

console.log("\n[2] 반복 머리말·꼬리말 제거 (italic/bold 변형 통일)");
{
  const o = postprocessMarkdown("첫 문단.\n\n*입양실무매뉴얼 개정사항 11*\n\n둘째 문단.\n\n**입양실무매뉴얼 개정사항 13**\n\n끝 문단.");
  ok(!o.includes("개정사항"), "반복 꼬리말(italic+bold) 모두 제거");
  ok(o.includes("첫 문단") && o.includes("끝 문단"), "본문은 보존");
}
ok(postprocessMarkdown("서론\n\n결론 요약\n\n참고문헌").includes("결론 요약"), "1회만 나오는 짧은 줄은 보존(오삭제 방지)");

console.log("\n[3] 페이지 경계로 끊긴 동일-머리글 파이프 표 병합");
{
  const inp = [
    "| 쪽 | 현행(2023년) | 개정(2024년) |", "| :--- | :--- | :--- |", "| 25 | a | b |", "",
    "*입양실무매뉴얼 개정사항 11*", "",
    "| 쪽 | 현행(2023년) | 개정(2024년) |", "| :--- | :--- | :--- |", "| 26 | c | d |", "",
    "**입양실무매뉴얼 개정사항 13**", "",
    "| 쪽 | 현행(2023년) | 개정(2024년) |", "| :--- | :--- | :--- |", "| 35 | e | f |",
  ].join("\n");
  const o = postprocessMarkdown(inp);
  ok((o.match(/현행\(2023년\)/g) || []).length === 1, "꼬리말 제거 후 3개 표가 1개로 병합(머리글 1회)");
  ok(["| 25 | a | b |", "| 26 | c | d |", "| 35 | e | f |"].every((r) => o.includes(r)), "모든 데이터 행 보존");
}

console.log("\n[3b] 1회만 나오는 꼬리말이 같은-머리글 표 사이/끝에 있어도 병합·제거");
{
  const inp = [
    "| 쪽 | 값 |", "|---|---|", "| 1 | a |", "",
    "12 2024년 입양실무매뉴얼", "", // 단일 등장 꼬리말(숫자 포함) — 표 사이
    "| 쪽 | 값 |", "|---|---|", "| 2 | b |", "",
    "13 2024년 입양실무매뉴얼", // 끝 꼬리말
  ].join("\n");
  const o = postprocessMarkdown(inp);
  ok((o.match(/\| 쪽 \| 값 \|/g) || []).length === 1, "사이 꼬리말 흡수하며 표 병합");
  ok(!o.includes("2024년 입양실무매뉴얼"), "사이+끝 꼬리말 모두 제거");
  ok(o.includes("| 1 | a |") && o.includes("| 2 | b |"), "데이터 행 보존");
}

console.log("\n[4] 병합 안전장치: 다른 머리글 / 표 사이 본문 있으면 병합 안 함");
ok((postprocessMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n\n| X | Y |\n|---|---|\n| 3 | 4 |").match(/\| A \| B \|/g) || []).length === 1, "다른 머리글 표는 미병합");
{
  const o = postprocessMarkdown("| 쪽 | 값 |\n|---|---|\n| 1 | a |\n\n중간 설명 문단.\n\n| 쪽 | 값 |\n|---|---|\n| 2 | b |");
  ok(o.includes("중간 설명 문단") && (o.match(/\| 쪽 \| 값 \|/g) || []).length === 2, "표 사이 본문 있으면 미병합 + 본문 보존");
}

console.log("\n[5b] HTML 표 래퍼 보존 (꼬리말 제거가 반복 <table> 를 삼키지 않음)");
{
  const inp = "<table>\n<tr><td>a</td></tr>\n</table>\n\n문단\n\n<table>\n<tr><td>b</td></tr>\n</table>";
  const o = postprocessMarkdown(inp);
  ok((o.match(/<table>/g) || []).length === 2 && (o.match(/<\/table>/g) || []).length === 2, "반복 <table>/</table> 래퍼 모두 보존(병합표 깨짐 방지)");
}

console.log("\n[5] OCR 후보정 사전: 비-단어 오인식 교정, 정상 텍스트는 불변");
ok(postprocessMarkdown("입양정보공개정구를 했을 때").includes("입양정보공개청구"), "'정보공개정구' → '정보공개청구'");
ok(!postprocessMarkdown("입양정보공개정구를 했을 때").includes("정구"), "오인식 '정구' 잔존 없음");
ok(postprocessMarkdown("테니스 정구 동호회 안내").includes("정구 동호회"), "문맥상 바른 '정구'(단독)는 보존(오교정 없음)");

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
