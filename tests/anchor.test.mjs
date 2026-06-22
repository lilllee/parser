// P0(anchor 주입) + P1(페이지 N/총 M) 프롬프트/압축 회귀 테스트 (assertion 기반, AI 호출 불필요)
// 실행: node tests/anchor.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { truncateAnchor, acceptNumericRepair, anchorIndexForPage } from "../server/vllm.js";
import { vllmPrompts as prompts } from "../server/config/prompt.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

console.log("\n[1] pdfOcrUser — 페이지 N / 총 M (P1)");
ok(prompts.pdfOcrUser(3, 10).includes("총 10"), "pageTotal>1 이면 '총 M' 포함");
ok(prompts.pdfOcrUser(3, 10).includes("페이지 3"), "현재 페이지 N 포함");
ok(!prompts.pdfOcrUser(2).includes("총"), "pageTotal 미지정(legacy) → '총' 미포함");
ok(!prompts.pdfOcrUser(1, 1).includes("총"), "총 1쪽이면 '총 M' 생략(단일 페이지 회귀 무해)");
ok(prompts.pdfOcrUser(5).startsWith("페이지 5 이미지입니다"), "legacy 문구 byte-동일 유지");

console.log("\n[2] pdfOcrAnchor — 래퍼 형식 + 규칙 (P0)");
{
  const a = prompts.pdfOcrAnchor("매출 2,306");
  ok(a.includes("[anchor 시작]") && a.includes("[anchor 끝]"), "anchor 본문을 시작/끝 마커로 감쌈");
  ok(a.includes("매출 2,306"), "anchor 텍스트 포함");
  ok(/이미지.*유일한 시각 근거|유일한 시각 근거/.test(a), "이미지 우선 규칙 명시");
  ok(/베끼지/.test(a), "베끼기 금지 규칙 명시");
  ok(/안 보이면 출력하지 않/.test(a), "환각 금지(안 보이면 출력 안 함) 규칙 명시");
}

console.log("\n[3] truncateAnchor — tiered 압축");
{
  const short = "짧은 텍스트 123";
  ok(truncateAnchor(short, 2000) === short, "cap 이내는 원문 그대로");
  ok(truncateAnchor("", 2000) === "", "빈 입력 → 빈 문자열");

  // cap 초과 + 유의숫자/표 구분행/헤더 라인이 산문보다 우선 보존되는지.
  const filler = Array.from({ length: 60 }, (_, i) => `그냥 산문 줄 ${"가".repeat(20)}`).join("\n");
  const doc = [
    "# 예산 총괄표",
    filler,
    "| 항목 | 금액 |",
    "| --- | --- |",
    "| 소요예산 | 1,383,720 |",
    filler,
  ].join("\n");
  const out = truncateAnchor(doc, 200);
  ok(out.length <= 200 + 20, "cap(200) 근처로 잘림(+중략 표기 여유)");
  ok(out.includes("1,383,720"), "유의숫자 라인 우선 보존");
  ok(out.includes("# 예산 총괄표"), "헤더 라인 우선 보존");
  ok(out.includes("…(중략)…"), "절단 시 중략 표기");

  // 우선 라인이 전혀 없는 순수 산문은 머리+꼬리 절단.
  const prose = "가".repeat(1000);
  const pout = truncateAnchor(prose, 200);
  ok(pout.length <= 200 + 12 && pout.includes("…(중략)…"), "산문은 머리+꼬리 절단 + 중략");
}

console.log("\n[4] 회귀 안전망 — anchor 빈 값이면 OCR 입력 불변(개념 검증)");
// vllmOcrPageStrict 는 anchorText 가 falsy 면 text 슬롯을 undefined 로 둬 legacy 와 byte-동일.
ok(truncateAnchor(undefined) === "" && truncateAnchor(null) === "", "falsy anchor → '' (text 미전달 경로)");

console.log("\n[5] pdfOcrNumericRepair — 보정 프롬프트 (P0.5)");
{
  const p = prompts.pdfOcrNumericRepair(["2,306", "1,383,720"]);
  ok(p.includes("2,306") && p.includes("1,383,720"), "검증 기준 숫자 목록 포함");
  ok(/만들어 넣지 않는다|환각 금지/.test(p), "환각 금지(안 보이면 만들지 말 것) 가드");
  ok(/숫자만 바로잡|임의로 바꾸지 않/.test(p), "글자·표 구조 임의변경 금지");
  ok(prompts.pdfOcrNumericRepair([]).length > 0, "빈 목록도 안전하게 문자열 생성");
}

console.log("\n[6] acceptNumericRepair — accept/rollback 판정 (P0.5)");
{
  // missing 감소 + extra 비폭증 → accept
  ok(acceptNumericRepair(3, 0, { missing: [1], extra: [] }) === true, "missing 3→1, extra 0→0 → accept");
  // missing 불변 → rollback
  ok(acceptNumericRepair(3, 0, { missing: [1, 2, 3], extra: [] }) === false, "missing 불변 → rollback");
  // missing 증가 → rollback
  ok(acceptNumericRepair(2, 0, { missing: [1, 2, 3], extra: [] }) === false, "missing 증가 → rollback");
  // missing 1 감소했지만 extra 가 2 증가(환각 의심) → rollback
  ok(acceptNumericRepair(3, 0, { missing: [1, 2], extra: [9, 9] }) === false, "missing 1↓ 인데 extra 2↑(환각) → rollback");
  // missing 2 감소, extra 1 증가(감소폭 이내) → accept
  ok(acceptNumericRepair(3, 0, { missing: [1], extra: [9] }) === true, "missing 2↓, extra 1↑(감소폭 이내) → accept");
}

console.log("\n[7] anchorIndexForPage — page-visual 앵커 폴백 (P1.5)");
{
  // 스캔/force_ocr 합본: "## 페이지 N" 규약
  const scan = "## 페이지 1\n\n첫 페이지 본문\n\n## 페이지 2\n\n둘째 페이지\n\n---\n\n";
  const a1 = anchorIndexForPage(scan, 1);
  ok(a1 != null && scan.slice(0, a1).includes("첫 페이지 본문"), "'## 페이지 N' 규약: 섹션 끝 앵커");

  // kordoc/reflow md: "## 페이지 N" 없음 → 페이지 텍스트 라인을 본문에서 찾아 앵커(핵심 함정 수정)
  const reflowMd = "# 보고서\n\n매출 추이 그래프 설명\n\n다음 단락 본문입니다.\n";
  const pageText = "매출 추이 그래프 설명\n표 데이터 1,234";
  const a2 = anchorIndexForPage(reflowMd, 7, pageText);
  ok(a2 != null, "'## 페이지 N' 부재 + 텍스트 매칭 → 앵커 반환(과거엔 null=차트 누락)");
  ok(a2 === reflowMd.indexOf("매출 추이 그래프 설명") + "매출 추이 그래프 설명".length, "매칭 라인 끝을 앵커로");

  // 매칭 실패 → null(잘못된 위치 삽입 방지)
  ok(anchorIndexForPage("전혀 다른 본문", 3, "본문에 없는 페이지 텍스트 줄") == null, "매칭 실패 → null(미삽입)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
