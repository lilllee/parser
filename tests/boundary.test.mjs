// 청크 경계 완전성 검사 회귀 테스트 (assertion 기반, 외부 의존 없음)
// 실행: node tests/boundary.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { detectBoundaryIssues, scoreMarkdown } from "./quality.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✅ " + msg); } else { fail++; console.log("  ❌ " + msg); } };
const flags = (md, fn) => detectBoundaryIssues(md, fn).flags;
const codes = (md, fn) => detectBoundaryIssues(md, fn).warnings.map((w) => w.code);

console.log("\n[1] 문장 미완(조사/쉼표/콜론/열린 괄호) 감지");
ok(flags("보육사업은 다음과 같이 지원을").danglingSentence === 1, "조사(을)로 끝 → danglingSentence");
ok(flags("신청 기간은 다음과 같다,").danglingSentence === 1, "쉼표로 끝 → danglingSentence");
ok(flags("항목은 다음과 같다:").danglingSentence === 1, "콜론으로 끝 → danglingSentence");
ok(flags("자세한 내용은 (").danglingSentence === 1, "열린 괄호로 끝 → danglingSentence");
ok(flags("정상적인 문장으로 끝납니다.").danglingSentence === 0, "마침표로 끝 → 정상");
ok(flags("# 제2장 보육료 지원").danglingSentence === 0, "헤딩 → 오탐 없음");
ok(flags("| 항목 | 값 |\n| --- | --- |\n| 보육료 | 30만원 |").danglingSentence === 0, "정상 표로 끝 → 오탐 없음");

console.log("\n[2] HTML 표 미완 감지");
ok(flags("<table><tr><td>a</td></tr>").unclosedTable === 1, "닫히지 않은 <table> → unclosedTable");
ok(flags("<table><tr><td>a</td></tr></table>").unclosedTable === 0, "정상 표 → 0");
ok(flags("<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>").unclosedTable === 0, "중첩 표 균형 → 0");

console.log("\n[3] 조문 미완 감지");
ok(flags("지원 대상은 다음 각 호와 같다.").statuteCutoff === 1, "'다음 각 호' 뒤 목록 없음 → statuteCutoff");
ok(flags("지원 대상은 다음 각 호와 같다.\n1. 첫째\n2. 둘째").statuteCutoff === 0, "목록 있으면 정상");
ok(flags("제2조(도지사의 책무)").statuteCutoff === 1, "조 머리만 → statuteCutoff");
ok(flags("제2조(도지사의 책무) 도지사는 책무를 다한다.").statuteCutoff === 0, "조 본문 있으면 정상");

console.log("\n[4] 파일명 페이지 구간 청크 감지");
ok(flags("내용", "2026년 경기도 보육사업 안내-163-166.pdf").pageRangeChunk === 1, "-163-166.pdf → pageRangeChunk");
ok(flags("내용", "2026년 3월 인구동향-45-50.pdf").pageRangeChunk === 1, "-45-50.pdf → pageRangeChunk");
ok(codes("내용", "보고서-5-10.pdf").includes("PAGE_RANGE_CHUNK"), "-5-10.pdf → 경고 코드");
ok(flags("내용", "보고서_최종.pdf").pageRangeChunk === 0, "일반 파일명 → 0");

console.log("\n[5] scoreMarkdown 통합 — boundary 필드 존재 & problemTotal 불변");
{
  const s = scoreMarkdown("정상적인 한국어 문장입니다. 띄어쓰기 정상.");
  ok(s.boundary && s.boundary.danglingSentence === 0, "정상 md → boundary.danglingSentence 0");
  ok(s.problemTotal === 0, "boundary 추가가 problemTotal 에 영향 없음");
  const d = scoreMarkdown("지원 대상은 다음과 같이 신청을");
  ok(d.boundary.danglingSentence === 1, "미완 md → boundary.danglingSentence 1");
  ok(d.problemTotal === 0, "경계 미완은 problemTotal(변환 결함)에 합산되지 않음");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
