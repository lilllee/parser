// postprocessMarkdown 회귀 테스트: 페이지번호/머리말·꼬리말 제거 + 페이지 경계 표 병합.
// 실행: node tests/postprocess.test.mjs   → 통과 시 exit 0, 실패 시 exit 1
import { postprocessMarkdown, hasSentenceStuffedTable, hasDuplicatedColumns, comparePageNumbers } from "../server/postprocess.js";

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
ok((postprocessMarkdown("표 A\n\n(단위: 천원)\n\n표 B\n\n(단위: 천원)").match(/\(단위: 천원\)/g) || []).length === 2, "반복 단위 표기는 보존");
{
  const o = postprocessMarkdown([
    "## 경기도 보육 조례",
    "",
    "(일부개정) 2011-01-10 조례 제 4126호",
    "",
    "(일부개정) 2011-03-15 조례 제 4158호",
    "",
    "(일부개정) 2012-01-05 조례 제 4308호",
  ].join("\n"));
  ok(o.includes("2011-01-10") && o.includes("2011-03-15") && o.includes("2012-01-05"), "조례 제·개정 이력은 반복 꼬리말로 오삭제하지 않음");
}

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

console.log("\n[6] ㎡ 위첨자 추출 순서 보정");
{
  const o = postprocessMarkdown("면적\n\n2<br>450m 이상\n\n450m2 미만\n\n250m² 이하");
  ok(o.includes("450㎡ 이상"), "'2<br>450m 이상' → '450㎡ 이상'");
  ok(o.includes("450㎡ 미만"), "'450m2 미만' → '450㎡ 미만'");
  ok(o.includes("250㎡ 이하"), "'250m² 이하' → '250㎡ 이하'");
}

console.log("\n[7] 경기도 보육표 과분할 grid 정규화");
{
  const fee = postprocessMarkdown('<table>\n<tr><th colspan="12">어린이집 보육료 및 가정양육 지원</th><th colspan="11" rowspan="2">(단위:</th></tr>\n<tr><td></td></tr>\n<tr><td>구</td><td>분</td></tr>\n<tr><td colspan="6">280</td></tr>\n</table>\n\n천원)');
  ok(fee.includes("# 어린이집 보육료 및 가정양육 지원"), "보육료 표 제목 복원");
  ok(fee.includes('<td colspan="3">280</td><td>인건비 30~100% 지원</td>'), "보육료 280 병합폭 정규화");
  ok(fee.includes('<td colspan="4">100</td><td rowspan="3">24~85개월 이하</td>'), "양육수당 100 병합폭 정규화");

  const treatment = postprocessMarkdown('<table>\n<tr><th></th><th></th><th>처우개선비</th><th></th><th>지원</th><th></th><th rowspan="2"></th><th colspan="17" rowspan="2">(단위: 천원)</th></tr>\n<tr><td></td></tr>\n<tr><td>처우개선비</td><td>특수근무수당</td><td>교사겸직원장</td></tr>\n</table>\n\n(\n\n- ※ 특수근무수당');
  ok(treatment.includes("## 처우개선비 지원"), "처우개선비 표 제목 복원");
  ok(treatment.includes('<th colspan="3" rowspan="2">구 분</th><th rowspan="2">계</th>'), "처우개선비 왼쪽 구분 3열 보존");
  ok(treatment.includes("영아반<br>(0∼2세)") && !treatment.includes("영어반"), "영아반 텍스트 보존");
}

console.log("\n[8] kordoc 섹션 머리글 가짜 표 → ## 헤딩 승격 (진짜 표는 보존)");
{
  const o = postprocessMarkdown([
    "| Ⅰ |  | 모집지역 및 모집세대 |", "| --- | --- | --- |", "",
    "본문 문장입니다.", "",
    "| 구분 | 수원시 |", "| --- | --- |", "| 공동생활가정형 | 4 |", "",
    "| Ⅶ |  | 유의사항 |", "| --- | --- | --- |", "",
    "| 25 | 현행 내용이 길게 들어있는 비교표 셀 | 개정 내용이 길게 들어있는 비교표 셀 |",
    "| --- | --- | --- |", "| 26 | 다음 행 | 다음 행 |",
  ].join("\n"));
  ok(o.includes("## Ⅰ. 모집지역 및 모집세대"), "로마숫자 섹션 머리글 → ## 승격");
  ok(o.includes("## Ⅶ. 유의사항"), "Ⅶ 머리글 → ## 승격");
  ok(!/\|\s*Ⅰ\s*\|/.test(o) && !/\|\s*Ⅶ\s*\|/.test(o), "가짜 헤딩표가 표로 남지 않음");
  ok(o.includes("| 구분 | 수원시 |") && o.includes("| 공동생활가정형 | 4 |"), "진짜 2열 표(데이터행)는 보존");
  ok(o.includes("| 25 |") && o.includes("| 26 | 다음 행"), "데이터행 있는 비교표는 보존(오승격 없음)");
}
{
  // 제N장 / 아라비아 / 원문자 마커도 처리, 마커 아닌 머리글-only 표는 미변환
  ok(postprocessMarkdown("| 제2장 |  | 총칙 |\n| --- | --- | --- |").includes("## 제2장 총칙"), "제N장 마커 승격");
  ok(postprocessMarkdown("| 3 |  | 신청 자격 |\n| --- | --- | --- |").includes("## 3. 신청 자격"), "아라비아 마커 승격");
  const keep = postprocessMarkdown("| 구분 |  | 내용 |\n| --- | --- | --- |");
  ok(keep.includes("| 구분 |"), "마커 아닌 '구분' 머리글-only 표는 변환하지 않음(오탐 방지)");
}

console.log("\n[9] 중첩 표(셀 안 <table>) 평탄화 시 바깥 셀 본문(<br> 목차) 보존");
{
  // kordoc 이 목차를 '바깥<table> > <th> 안에 제목 inner<table> + <br> 목차항목' 으로 떠오는 형태.
  // 과거 htmlTableRows 의 lazy <tr>/<th> 정규식이 inner 표의 첫 </tr> 에서 끊겨 목차 본문을 통째 누락.
  const nested = [
    "<table>",
    "<tr><th><table>",
    "<tr><th>사업신청서 지침 및 서식</th></tr>",
    "</table><br>[지침] 작성요령\t 3<br>1-1. 지원신청서\t 7<br>1-2. 프로그램 개요서\t 8<br>1-3. 세부계획서\t 14<br>1-4. 소개서\t 20<br>1-5. 인력현황\t 21<br>1-6. 서약서\t 22<br>[별첨] 보조금 예산편성 원칙\t 54</th></tr>",
    "</table>",
  ].join("\n");
  const o = postprocessMarkdown(nested);
  ok(o.includes("사업신청서 지침 및 서식"), "중첩 표 제목 보존");
  ok(o.includes("1-1. 지원신청서") && o.includes("[별첨] 보조금 예산편성 원칙"), "바깥 셀 <br> 목차 본문 보존(누락 안 됨)");
  ok(o.includes("54") && o.includes("22"), "목차 페이지번호 보존");
}
{
  // 중첩 없는 일반 표는 그대로(해체 로직이 단일 표를 건드리지 않음)
  const plain = "<table>\n<tr><th>구분</th><th>값</th></tr>\n<tr><td>인구</td><td>1,234</td></tr>\n</table>";
  const o = postprocessMarkdown(plain);
  ok(/<table/i.test(o) && o.includes("인구") && o.includes("1,234"), "중첩 없는 일반 표는 보존");
}

console.log("\n[10] 소프트랩 reflow — 헤딩-라벨(번호+[태그])은 다음 문장을 흡수하지 않음");
{
  const o = postprocessMarkdown("① [공통] 프로그램 신청 시 역량기반 활동계획을 반영\n\n모든(활동·참여·보호) 분야 적용한다.");
  ok(!o.includes("반영모든"), "헤딩-라벨이 다음 줄을 오병합하지 않음(반영모든 없음)");
  // 정상 소프트랩(헤딩-라벨 아님)은 여전히 병합 — 의도된 동작 보존
  const wrap = postprocessMarkdown("도시 저소득 국민의 주거안정과 자활을 위하여 매입한 주택을\n\n저렴하게 공급하는 사업이다.");
  ok(wrap.includes("주택을저렴하게") || wrap.includes("주택을 저렴하게"), "일반 소프트랩 문장은 계속 병합/유지");
}

console.log("\n[11] 전보 기호 garbage 제거 / 단위·마커 보존 / 줄머리 불릿 정규화");
{
  const o = postprocessMarkdown("㋊㍙수원시\n\n㋋㍙용인시\n\n면적 450㎡ 이상 30㎥\n\n• 보호대상아동\n\n가·나·다\n\n㉠ 항목");
  ok(!/[㋀-㋿㍘-㍰]/.test(o), "전보 기호(㋊㍙) 제거");
  ok(o.includes("수원시") && o.includes("용인시"), "도시명 본문 보존");
  ok(o.includes("450㎡") && o.includes("30㎥"), "단위 기호 ㎡/㎥(U+3371↑) 보존");
  ok(o.includes("- 보호대상아동"), "줄머리 불릿 • → markdown '- '");
  ok(o.includes("가·나·다"), "한국어 가운뎃점(·)은 변환 안 함");
  ok(o.includes("㉠ 항목"), "원문자 한글 목록마커(㉠, U+3260↓) 보존");
}

console.log("\n[12] 문장 박힌 표 감지 — kordoc 레이아웃 실패(표+산문 뭉갬)를 vision 라우팅용으로 잡는다");
{
  // 표 셀에 문장(증감 종결어/캡션)이 박힌 kordoc '산산조각' 표 → true (reflow vision 대상)
  ok(hasSentenceStuffedTable('<table><tr><th>2026년 3월 합계출산율은 0.93명으로 전년동월대비 0.15명 증가함</th><td>1.2</td></tr></table>'), "HTML 셀 속 문장(증가함) → true");
  ok(hasSentenceStuffedTable('<table><tr><td>4.4 [그림 2] 모의 연령별 출산율</td></tr></table>'), "HTML 셀 속 [그림 N] 캡션 → true");
  ok(hasSentenceStuffedTable("| 합계출산율 0.93명으로 전년동월대비 0.15명 증가함 | 1.2 |\n| --- | --- |"), "pipe 셀 속 문장 → true");
  // 정상 데이터 표(숫자/짧은 라벨)는 false — 오탐 없음(보육료·통계표가 잘못 vision 라우팅되지 않게)
  ok(!hasSentenceStuffedTable('<table><tr><th>구분</th><th>3월</th></tr><tr><td>합계출산율</td><td>0.93</td></tr></table>'), "정상 데이터 표 → false");
  ok(!hasSentenceStuffedTable("| 구분 | 3월 | 1~3월 |\n| --- | --- | --- |\n| 출생아 수 | 25,200 | 75,013 |"), "정상 pipe 표 → false");
}

console.log("\n[13] 열 복제 감지 — kordoc 비교표(현행/개정)를 한 열만 읽어 양쪽에 복제한 실패 패턴");
{
  const long = "입양동의서(입양특례법 시행규칙 별지 제8호 서식)는 가정법원에 입양허가 신청 시 제출해야함";
  // 긴 동일 내용이 인접 열에 든 행 2개+ → true (vision 라우팅 대상)
  ok(hasDuplicatedColumns(`| 25 | ${long} | ${long} |\n| --- | --- | --- |\n| 26 | ${long} 다른시작 | ${long} 다른시작 |`), "긴 동일 인접열 2행+ → true");
  // 1행만 동일 → false (우연 1건은 제외)
  ok(!hasDuplicatedColumns(`| 25 | ${long} | ${long} |\n| 26 | 가 | 나 |`), "동일 1행뿐 → false");
  // 정상 비교표(좌우 다름) → false
  ok(!hasDuplicatedColumns(`| 쪽 | 현행 내용이 길게 들어있는 셀 | 개정 내용이 길게 들어있는 셀 |\n| 26 | 또 다른 긴 현행 내용 셀 | 또 다른 긴 개정 내용 셀 |`), "좌우 다른 정상 비교표 → false");
  // 짧은 동일 셀(숫자 등) → false (>=20자 가드)
  ok(!hasDuplicatedColumns("| 0.93 | 0.93 |\n| 0.80 | 0.80 |\n| 100 | 100 |"), "짧은 동일 셀(숫자) → false");
}

console.log("\n[14] comparePageNumbers — force_ocr 페이지별 kordoc↔vision 숫자 대조 검증");
{
  // kordoc 산산조각 텍스트라도 '숫자'는 다 들어있다 → vision 이 같은 숫자면 ok
  const kordoc = "지원인원 2,306 명 소요예산 1,383,720 천원 도 30% 시군 70% 합계출산율 0.93";
  const visionGood = "- 지원인원: 2,306명\n- 소요예산: 1,383,720천원(도 30%, 시군 70%)\n- 합계출산율 0.93";
  const g = comparePageNumbers(kordoc, visionGood);
  ok(g.ok && !g.unverified && g.missing.length === 0 && g.extra.length === 0, "숫자 일치 → ok(검증됨)");

  // vision 이 2,306 → 2,308 로 오독 → missing[2306] + extra[2308] 로 잡힘
  const visionBad = "- 지원인원: 2,308명\n- 소요예산: 1,383,720천원(도 30%, 시군 70%)\n- 합계출산율 0.93";
  const b = comparePageNumbers(kordoc, visionBad);
  ok(!b.ok && b.missing.includes("2306") && b.extra.includes("2308"), "숫자 오독 → 불일치(누락 2306 / 추가 2308)");

  // 1~2자리 노이즈(페이지번호/리스트마커)는 무시 — 의미있는 숫자만 비교
  ok(comparePageNumbers("19 5 2", "- 19 -\n5회\n2개").ok, "1~2자리 노이즈는 검증서 제외 → ok");

  // extra 만(vision 이 kordoc 보다 숫자 많음 — 연도/미추출영역) → ok=true (정보일 뿐, 오류 아님)
  const e = comparePageNumbers("합계 100", "합계 100\n2024년 기준\n추가수치 12,345");
  ok(e.ok && e.missing.length === 0 && e.extra.length > 0, "extra만(vision 더 완전) → ok=true, extra는 정보");

  // kordoc 텍스트 없음(스캔 페이지) → unverified(=ok, 무근거)
  const u = comparePageNumbers("", "출생아 25,200명");
  ok(u.unverified && u.ok && u.kordocNumbers === 0, "kordoc 비면 unverified(무근거)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
