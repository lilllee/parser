// 변환된 markdown 품질 스코어러 — 회귀 테스트용 객관 지표
// 사용: node tests/quality.mjs <file.md>  또는  import { scoreMarkdown }
import { readFileSync } from "node:fs";

// 각 항목: 적을수록 좋음(문제 수). chartCoverage 만 비율(높을수록 좋음).
export function scoreMarkdown(md) {
  const lines = md.split("\n");
  const issues = {};

  // 1) 한국어 띄어쓰기 소실 (한글+구두점 25자+ 무공백) — kordoc 버그
  issues.brokenKoreanSpacing = (md.match(/[가-힣][가-힣,()·]{24,}/g) || []).length;

  // 2) 한 셀에 데이터가 통째로 뭉친 pipe 표 줄 (진짜 망가진 표 잔재).
  //    "콤마구분 데이터값(238,317 같은)" 이 한 셀에 6개+ 들어있으면 표 여러 칸이
  //    한 셀로 평탄화된 것. 법조항/날짜/연도(콤마 없음)가 든 정상 긴 텍스트 셀은
  //    콤마구분 숫자가 거의 없어 오탐되지 않는다.
  issues.crammedTableRows = lines.filter((l) => {
    if (!/^\s*\|/.test(l)) return false;
    return l.split("|").some((cell) => (cell.match(/\d{1,3}(?:,\d{3})+/g) || []).length >= 6);
  }).length;

  // 3) 코드펜스 잔재 (모델이 ```markdown 으로 감쌈)
  issues.codeFences = (md.match(/^[ \t]*```/gm) || []).length;

  // 4) 단독 페이지번호/푸터 줄
  issues.strayPageNums = (md.match(/^[ \t]*-?\d{1,4}-?[ \t]*$/gm) || []).filter((l) => /\d/.test(l)).length;

  // 5) 빈/실패 마커
  issues.emptyMarkers = (md.match(/\[OCR 결과 없음\]|\[OCR\s*실패/g) || []).length;

  // 6) 본문이 헤딩으로 오인된 줄 (긴 문장이 #로 시작 + 마침표 끝)
  issues.bodyAsHeading = lines.filter((l) => /^#{1,6}\s+.{60,}[.,;]\s*$/.test(l)).length;

  // 7) 차트 설명 커버리지: [그림 N] 캡션 중 직후 N줄 안에 "> 설명" 붙은 비율
  const figIdx = [];
  lines.forEach((l, i) => { if (/\[그림\s*\d+|\[그림\d|Figure\s*\d+/i.test(l)) figIdx.push(i); });
  let described = 0;
  for (const i of figIdx) {
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      if (/^>\s/.test(lines[j].trim())) { described++; break; }
    }
  }
  const chartCoverage = figIdx.length ? +(described / figIdx.length).toFixed(2) : null;

  const problemTotal =
    issues.brokenKoreanSpacing + issues.crammedTableRows + issues.codeFences +
    issues.strayPageNums + issues.emptyMarkers + issues.bodyAsHeading;

  return { chars: md.length, lines: lines.length, figures: figIdx.length, chartCoverage, issues, problemTotal };
}

// CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const path = process.argv[2];
  if (!path) { console.error("사용: node tests/quality.mjs <file.md>"); process.exit(1); }
  const md = readFileSync(path, "utf-8");
  const s = scoreMarkdown(md);
  console.log(`📄 ${path}`);
  console.log(`  분량: ${s.chars}자 / ${s.lines}줄 | 그림 ${s.figures}개 (설명 커버리지 ${s.chartCoverage ?? "-"})`);
  console.log(`  문제 총합: ${s.problemTotal}`);
  for (const [k, v] of Object.entries(s.issues)) if (v) console.log(`    - ${k}: ${v}`);
  if (s.problemTotal === 0) console.log("  ✅ 주요 품질 문제 없음");
}
