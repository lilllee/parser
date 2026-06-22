// hasBrokenTable 회귀 테스트.
// 복잡한 표(병합·중첩)에서 vision OCR 이 markdown 으로 표를 깨뜨린 출력을 결정적으로 감지해
// 재시도 트리거로 쓴다. 정상 표(markdown/HTML)는 감지하지 않아야 한다(불필요한 재시도 방지).
// 실행: node tests/ocr-table.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { cleanOcrText, hasBrokenTable, hasDegenerateRepeat, stitchTiles } from "../server/vllm.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

console.log("\n[1] 깨진 표 출력 감지");
ok(hasBrokenTable('| 민간 | 450㎡ 이상 | 1.5억원 | rowspan="3">1억원 |') === true, "markdown 칸에 rowspan 텍스트 누출 → 감지");
ok(hasBrokenTable('| 구분 | colspan="2">2025년 |') === true, "markdown 칸에 colspan 텍스트 누출 → 감지");
ok(hasBrokenTable('○ 최대 1.5억원<br><br>| 유형 | 리모델링비 |<br>| 민간 | 1억원 |') === true, "<br>+| 로 셀에 표 욱여넣기 → 감지");
// 하위표가 같은 블록에 흘러나옴 → 구분행 2개+ (사용자가 본 깨진 패턴)
ok(hasBrokenTable("| 구분 | 지원내용 | 지원금액 |\n| :--- | :--- | :--- |\n| 공동주택 | ... | 유형 | 면적 | 비용 |\n| --- | --- | --- |\n| 민간 | 450 이상 | 1.5억 |") === true, "하위표 흘러나옴(구분행 2개+) → 감지");
// 같은 블록 내 칸 수 큰 불일치
ok(hasBrokenTable("| a | b |\n| :--- | :--- |\n| 1 | 2 | 3 | 4 |") === true, "한 표 블록 내 칸 수 불일치 → 감지");
ok(hasBrokenTable('<table><tr><th rowspan="2">구 분</th><th rowspan="2">계</th><th colspan="3">도 자체사업</th><th colspan="2">국비지원사업</th><th rowspan="2">누리과정</th></tr><tr><th>처우개선비</th><th>특수근무수당</th><th>추가</th><th>환경개선비</th><th>겸직원장</th></tr><tr><td>인건비 미지원</td><td>교사</td><td>영아반</td><td>590</td><td>200</td><td>80</td><td>30</td><td>280</td><td></td><td></td></tr></table>') === true, "HTML 표 헤더/본문 유효 열 수 불일치 → 감지");
ok(hasBrokenTable('<table><tr><th colspan="2">구 분</th><th></th><th>0세반</th><th>1세반</th></tr><tr><td>A</td><td>B</td><td>C</td><td>1</td><td>2</td></tr></table>') === true, "HTML 병합 헤더가 빈 th 로 쪼개짐 → 감지");

console.log("\n[2] 정상 표는 감지하지 않음 (오재시도 방지)");
ok(hasBrokenTable("| a | b |\n|---|---|\n| 1 | 2 |") === false, "정상 markdown 표 → 미감지");
ok(hasBrokenTable("| a | b |\n|---|---|\n| 1 | 2 |\n\n| c | d |\n|---|---|\n| 3 | 4 |") === false, "빈 줄로 분리된 정상 표 2개 → 미감지(오탐 방지)");
ok(hasBrokenTable('<table>\n<tr><td rowspan="3">x</td><td>y</td></tr>\n</table>') === false, "정상 HTML rowspan → 미감지");
ok(hasBrokenTable('<table><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><th>B1</th><th>B2</th></tr><tr><td rowspan="2">x</td><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>') === false, "정상 HTML rowspan/colspan 열폭 일치 → 미감지");
ok(hasBrokenTable("일반 문장. 표 없음.") === false, "일반 텍스트 → 미감지");
ok(hasBrokenTable("") === false, "빈 텍스트 → 미감지");

console.log("\n[3] DeepSeek-OCR 출력 아티팩트 정리");
{
  const raw = [
    "```markdown",
    "# 제목",
    "<|ref|>title<|/ref|><|det|>[[1,2,3,4]]<|/det|>",
    "<center>본문</center>",
    "\\coloneqq 와 \\eqqcolon",
    "<｜end▁of▁sentence｜>",
    "```",
  ].join("\n");
  const out = cleanOcrText(raw);
  ok(!out.includes("<|ref|>") && !out.includes("<|det|>"), "grounding ref/det 태그 제거");
  ok(!out.includes("<center>") && !out.includes("</center>"), "center 태그 제거");
  ok(out.includes(":= 와 =:"), "coloneqq/eqqcolon 정규화");
  ok(!out.includes("end▁of▁sentence"), "DeepSeek EOS 토큰 제거");
}

console.log("\n[4] 반복 붕괴 출력 감지");
{
  const repeated = Array.from({ length: 8 }, () => "동일한 문장이 계속 반복됩니다.").join("\n");
  ok(hasDegenerateRepeat(repeated) === true, "같은 줄 반복 → 감지");
  ok(hasDegenerateRepeat("정상 문단입니다.\n\n| 항목 | 값 |\n|---|---|\n| A | 1 |\n| B | 2 |") === false, "짧은 정상 OCR → 미감지");
}

console.log("\n[5] stitchTiles — 타일 이음새 overlap 중복 제거");
{
  const a = "줄1\n줄2\n공통 라인 A\n공통 라인 B";
  const b = "공통 라인 A\n공통 라인 B\n줄3\n줄4";
  ok(stitchTiles([a, b]) === "줄1\n줄2\n공통 라인 A\n공통 라인 B\n줄3\n줄4", "이음새 공통 라인열 제거");
  ok(stitchTiles(["A\nB", "C\nD"]) === "A\nB\nC\nD", "겹침 없으면 단순 연결");
  ok(stitchTiles(["| A | 1 |\n| B | 2 |"]) === "| A | 1 |\n| B | 2 |", "단일 파트 보존");
  ok(stitchTiles([]) === "", "빈 입력 → 빈 문자열");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
