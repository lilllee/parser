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

  // 3) 코드펜스 잔재 (모델이 ```markdown 으로 감쌈) — 단, ```mermaid/graph 등 다이어그램 블록은
  //    의도된 산출물(흐름도)이라 결함이 아니다. 다이어그램 블록의 여는/닫는 펜스 2개씩을 제외한다.
  const allFences = (md.match(/^[ \t]*```/gm) || []).length;
  const diagramBlocks = (md.match(/^[ \t]*```(?:mermaid|graph|flowchart|sequenceDiagram|gantt|classDiagram|stateDiagram|erDiagram|dot)\b/gim) || []).length;
  issues.codeFences = Math.max(0, allFences - 2 * diagramBlocks);

  // 4) 단독 페이지번호/푸터 줄. 단, 인접(이전/다음 비공백) 줄이 표 행이거나 또 다른 단독 숫자면
  //    (차트값 군집 또는 깨진 표에서 튕겨나온 셀) 데이터로 보고 제외 — 진짜 고립 페이지번호만 센다.
  const isBareNum = (l) => /^[ \t]*-?\d{1,4}-?[ \t]*$/.test(l) && /\d/.test(l);
  const isTableish = (l) => /^[ \t]*(?:\||<\/?(?:table|tr|td|th)\b)/i.test(l);
  let stray = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!isBareNum(lines[i])) continue;
    let prev = ""; for (let j = i - 1; j >= 0; j--) if (lines[j].trim()) { prev = lines[j]; break; }
    let next = ""; for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) { next = lines[j]; break; }
    if (!((prev && (isTableish(prev) || isBareNum(prev))) || (next && (isTableish(next) || isBareNum(next))))) stray++;
  }
  issues.strayPageNums = stray;

  // 4b) 표 셀에 문장이 통째로 박힘 — 두 표가 한 페이지에서 하나의 <table> 로 뭉개지거나(인구동향
  //     [표3]+[표4]), 비교표가 깨지며 산문이 셀로 들어간 신호. HTML 이 well-formed 라 기존 지표는
  //     이를 0 으로 놓쳤다. 셀 텍스트가 한글 문장(종결/증감 표현)이거나 [그림/[표 캡션을 품으면 센다.
  issues.sentenceInTableCell = (md.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).filter((cell) => {
    const text = cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length < 30 || !/[가-힣]/.test(text)) return false;
    return /(?:증가함|감소함|하였다|되었다|하였음|되었음|명으로|배 증가|배 감소)/.test(text) || /\[(?:그림|표)\s*\d/.test(text);
  }).length;

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
    issues.strayPageNums + issues.emptyMarkers + issues.bodyAsHeading +
    issues.sentenceInTableCell;

  // 청크 경계 완전성 — 변환 결함(problemTotal)과 별개의 정보성 신호라 따로 둔다.
  const boundary = detectBoundaryIssues(md).flags;

  return { chars: md.length, lines: lines.length, figures: figIdx.length, chartCoverage, issues, problemTotal, boundary };
}

// 청크 경계 완전성 검사 — 원문이 중간(조사/표/조문 미완)에서 잘렸는지 결정론적으로 감지한다.
// 변환 실패는 아니지만 RAG 청크 품질에 중요한 신호라 경고로 표면화한다. (pipeline.md 2.1 참고)
// 반환: { flags: {0|1}, warnings: [{code, message}] }. scoreMarkdown 은 flags 를, convert 는 warnings 를 쓴다.
const JOSA_TAIL_RE = /(?:을|를|이|가|은|는|와|과|의|에|에서|에게|으로|로|및|또는|이나|거나|하고|하며|하여|부터|까지|보다|라며|라고|면서|지만|는데|으며|며)$/;
const OPEN_BRACKET_RE = /[([{（［｛「『]$/;
const LIST_MARKER_RE = /[①-⑮㉠-㉭]|(?:^|\s)\d+\s*\.|(?:^|\s)[가-하]\s*\.|(?:^|\n)\s*[-*]\s/;

export function detectBoundaryIssues(md, filename = "") {
  const text = String(md || "");
  const flags = { danglingSentence: 0, unclosedTable: 0, statuteCutoff: 0, pageRangeChunk: 0 };
  const warnings = [];

  // 마지막 비어있지 않은 줄(장식 기호 꼬리는 떼고 본문 끝 글자로 판정).
  const lines = text.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].replace(/[ \t>#*`~_]+$/g, "").trim();
    if (t) { last = t; break; }
  }

  // (a) 문장 미완 — 마지막 줄이 조사/접속어미·쉼표·콜론·열린 괄호로 끝남(표 구분행 제외).
  const isSep = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(last);
  if (last && !isSep && (JOSA_TAIL_RE.test(last) || /[,;:·،]$/.test(last) || OPEN_BRACKET_RE.test(last))) {
    flags.danglingSentence = 1;
    warnings.push({ code: "INCOMPLETE_TAIL", message: `문서가 문장 중간에서 끝남(말미: "${last.slice(-24)}") — 청크 경계에서 잘렸을 수 있음` });
  }

  // (b) 표 미완 — HTML <table> 개폐 불일치(표가 문서 끝에서 잘림).
  const opens = (text.match(/<table\b/gi) || []).length;
  const closes = (text.match(/<\/table\s*>/gi) || []).length;
  if (opens !== closes) {
    flags.unclosedTable = 1;
    warnings.push({ code: "UNCLOSED_TABLE", message: `HTML <table> 가 닫히지 않음(open ${opens} / close ${closes}) — 표가 문서 끝에서 잘렸을 수 있음` });
  }

  // (c) 조문 미완 — '다음 각 호/목' 뒤 목록 없음, 또는 마지막 줄이 조/항/호 머리뿐.
  const tail = text.slice(-220);
  const afterEach = tail.split(/다음\s*각\s*[호목]/);
  if (afterEach.length > 1 && !LIST_MARKER_RE.test(afterEach[afterEach.length - 1])) {
    flags.statuteCutoff = 1;
    warnings.push({ code: "STATUTE_CUTOFF", message: "'다음 각 호' 뒤 목록 없이 끝남 — 본문이 잘렸을 수 있음" });
  } else if (/(?:^|\n)\s*제\s*\d+\s*[조항호](?:\s*\([^)\n]*\))?\s*$/.test(text)) {
    flags.statuteCutoff = 1;
    warnings.push({ code: "STATUTE_CUTOFF", message: "조/항/호 머리만 있고 본문 없이 끝남 — 본문이 잘렸을 수 있음" });
  }

  // (d) 파일명이 페이지 구간 청크 패턴(...-N-M.ext, M>=N) — 원문 일부일 가능성.
  const m = String(filename || "").match(/-(\d+)-(\d+)\.[A-Za-z0-9]+$/);
  if (m && Number(m[2]) >= Number(m[1])) {
    flags.pageRangeChunk = 1;
    warnings.push({ code: "PAGE_RANGE_CHUNK", message: `파일명이 페이지 구간 청크(${m[1]}-${m[2]}) 패턴 — 원문 일부일 수 있음(전체성 보장 안 됨)` });
  }

  return { flags, warnings };
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
  const { warnings } = detectBoundaryIssues(md, path);
  if (warnings.length) {
    console.log(`  ⚠ 경계 경고 ${warnings.length}건:`);
    for (const w of warnings) console.log(`    - [${w.code}] ${w.message}`);
  }
}
