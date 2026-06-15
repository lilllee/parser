// kordoc/OCR 출력 markdown 후처리 (정형화).
import { ocrCorrections } from "./config/corrections.js";

const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

// OCR 글자 오인식 후보정 (사전 기반, 전체 용어 단위 literal 치환).
function applyOcrCorrections(md) {
  let out = md;
  for (const [from, to] of Object.entries(ocrCorrections)) {
    if (from) out = out.split(from).join(to);
  }
  return out;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => HTML_ESCAPE[c]);
}

// GFM 구분행( |---|:--:| 등 ) 판별.
function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

// "| a | b |" 한 줄 → ["a","b"] (양끝 파이프 기준 셀 분리).
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

// markdown 파이프 표 → HTML <table>. 이미 HTML(<table>)인 표/일반 본문은 그대로 둔다.
// 출력 포맷=html 일 때 사용 (ParseBench GRITS 등 HTML 표만 인식하는 평가/소비처 대응).
export function markdownTablesToHtml(md) {
  if (!md || md.indexOf("|") === -1) return md;
  const lines = String(md).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    if (isTableRow(lines[i])) {
      const block = [];
      while (i < lines.length && isTableRow(lines[i])) block.push(lines[i++]);
      const hasSeparator = block.some(isSeparatorRow);
      const dataRows = block.filter((l) => !isSeparatorRow(l)).map(splitRow);
      if (!dataRows.length) {
        out.push(...block); // 구분행만 있는 비정상 블록 — 원문 유지
        continue;
      }
      // 구분행이 있으면 첫 데이터행이 헤더(th), 없으면 헤더 없이 전부 td.
      const header = hasSeparator ? dataRows[0] : null;
      const body = hasSeparator ? dataRows.slice(1) : dataRows;

      const html = ["<table>", "  <tbody>"];
      if (header) html.push("    <tr>" + header.map((c) => `<th>${escapeHtml(c)}</th>`).join("") + "</tr>");
      for (const r of body) html.push("    <tr>" + r.map((c) => `<td>${escapeHtml(c)}</td>`).join("") + "</tr>");
      html.push("  </tbody>", "</table>");
      out.push(html.join("\n"));
    } else {
      out.push(lines[i++]);
    }
  }
  return out.join("\n");
}

// markdown 후처리: 추출 잔재 정리 + caption 을 인용 블록으로 강조.
export function postprocessMarkdown(md) {
  if (!md) return md;

  // OCR 글자 오인식 후보정 (사전 기반) — 이후 단계가 교정된 텍스트를 보도록 맨 앞에서.
  let out = applyOcrCorrections(md);

  // 합자 복원: "e ffi cient" → "efficient" (ff/ffi/ffl 한정 — 오탐 위험 낮음).
  out = out.replace(/([A-Za-z])[ \t]+(ffl|ffi|ff)[ \t]+([A-Za-z])/g, "$1$2$3");

  // 빈 대괄호 잔재 라인 제거 (예: "[][]M").
  out = out.replace(/^[ \t]*(?:\[\][ \t]*)+[A-Za-z]?[ \t]*$/gm, "");

  // 단독 숫자 줄(1~4자리) 중 '고립된' 것만 페이지번호로 보고 제거.
  // 차트/표가 줄마다 흩어져 생긴 숫자 군집은 데이터이므로 보존(인접 비공백 줄에 다른
  // 숫자 줄이 있으면 군집=데이터). (목록 "1.", 참고문헌 "[1]" 은 패턴상 애초 비대상)
  out = stripLonePageNumbers(out);

  // 페이지마다 반복되는 머리말·꼬리말(문서/장 제목 + 페이지번호) 제거.
  out = removeRunningHeadersFooters(out);

  // 헤딩 레벨 정규화.
  out = normalizeHeadings(out);

  const label = "(?:Figure|Fig\\.|Table|그림|표)";

  // 1) 본문 + tab + caption  →  본문 + (blank) + > **caption**
  out = out.replace(
    new RegExp(`([^\\t\\n]+?)\\t+(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)`, "g"),
    "$1\n\n> **$2**\n"
  );

  // 2) 다중 공백 (4+) 으로 분리된 caption — 학술 PDF 의 2단 컬럼에서 나타남
  out = out.replace(
    new RegExp(`([^\\n]{8,}?)[ ]{4,}(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)`, "g"),
    "$1\n\n> **$2**\n"
  );

  // 3) 단독 라인 caption 도 같은 형태로 강조
  out = out.replace(
    new RegExp(`^(${label}\\s*\\d+[:.\\-]\\s*[^\\n]+)$`, "gm"),
    "> **$1**"
  );

  // 페이지 경계로 끊긴 '같은 머리글' 파이프 표를 하나로 병합 (머리말·꼬리말 제거 후).
  out = mergeAdjacentPipeTables(out);

  // 4) 과도한 빈 줄 축소 (3+ → 2) + 문서 앞뒤 공백 정리
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
  out = out.replace(/\s+$/, "") + "\n";

  return out;
}

// 페이지마다 반복되는 머리말·꼬리말 제거. 짧은 단독 텍스트 줄을 숫자/강조/구두점 제거한 형태로
// 정규화했을 때 문서에서 2회 이상 반복되면(= 페이지번호만 바뀌는 러닝 헤더/푸터) 삭제한다.
// 표 행·헤딩·목록·인용은 대상에서 제외하고, 짧은 줄(maxLen 이하)만 본다(본문 오삭제 방지).
function isRunningCandidate(line) {
  const t = line.trim();
  if (!t || t.length > 40) return false;
  if (/^\|/.test(t)) return false; // 표 행
  if (/^</.test(t)) return false; // HTML 태그(<table>,</table>,<tr> 등) — 표 구조 보존
  if (/^#{1,6}\s/.test(t)) return false; // 헤딩
  if (/^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) return false; // 목록
  if (/^>/.test(t)) return false; // 인용
  return true;
}
function runningNorm(line) {
  return line
    .replace(/[*_`]/g, "") // 강조 마크업(*, **, _, __, `) 전부 제거 — 같은 꼬리말의 italic/bold 변형 통일
    .replace(/[\d\s]/g, "")
    .replace(/[.,·:;~∼\-—]/g, "");
}
function removeRunningHeadersFooters(md) {
  const lines = md.split("\n");
  const counts = new Map();
  for (const l of lines) {
    if (!isRunningCandidate(l)) continue;
    const n = runningNorm(l);
    if (n.length >= 4) counts.set(n, (counts.get(n) || 0) + 1);
  }
  return lines
    .filter((l) => !(isRunningCandidate(l) && (counts.get(runningNorm(l)) || 0) >= 2))
    .join("\n");
}

// 페이지 경계로 끊긴 '머리글이 동일한' 연속 파이프 표를 하나로 병합 (둘째 표의 머리글·구분행을
// 버리고 본문 행만 첫 표에 이어붙임). 두 표 사이에 빈 줄 또는 '짧은 잔재(페이지 꼬리말 등)'만
// 있을 때 병합하며, 그 사잇줄은 페이지 경계 노이즈로 보고 버린다(머리글이 byte 동일 = 같은 표의
// 페이지 분할이라는 강한 신호). 표 사이에 실제 본문(긴 줄·헤딩·목록·인용)이 끼면 병합하지 않고
// 그대로 보존. HTML <table>·머리글이 다른 표는 건드리지 않는다.
const PIPE_ROW = /^\s*\|.*\|\s*$/;
function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
// 표 사이 줄이 '버려도 되는' 페이지 경계 잔재인가: 빈 줄, 또는 짧고 숫자(페이지번호)를 포함한
// 비-구조 줄. 숫자 요구로 '중간 설명 문단.' 같은 짧은 실제 본문이 버려지는 것을 막는다.
function isDroppableBetween(line) {
  const t = line.trim();
  if (t === "") return true;
  if (t.length > 40 || /^[#>|]|^[-*]\s|^\d+\.\s/.test(t)) return false;
  return /\d/.test(t); // 짧고 숫자 포함 = 페이지 꼬리말로 간주
}
function mergeAdjacentPipeTables(md) {
  const lines = md.split("\n");
  const out = [];
  let pending = null; // { headerCells, lines:[헤더,구분,...본문] }
  let between = []; // pending 이후 모인 줄(빈 줄/짧은 잔재 후보)
  const emit = () => {
    if (pending) { out.push(...pending.lines); pending = null; }
    if (between.length) { out.push(...between); between = []; }
  };
  let i = 0;
  while (i < lines.length) {
    if (PIPE_ROW.test(lines[i])) {
      const block = [];
      let j = i;
      while (j < lines.length && PIPE_ROW.test(lines[j])) block.push(lines[j++]);
      const sepIdx = block.findIndex(isSeparatorRow);
      if (sepIdx >= 1) {
        const headerCells = splitRow(block[0]);
        const body = block.slice(sepIdx + 1);
        if (pending && arraysEqual(pending.headerCells, headerCells) && between.every(isDroppableBetween)) {
          pending.lines.push(...body); // 병합: 머리글·구분·사잇 잔재(빈 줄/꼬리말) 버림
          between = [];
        } else {
          emit();
          if (out.length && out[out.length - 1] !== "") out.push("");
          pending = { headerCells, lines: block.slice() };
        }
        i = j;
        continue;
      }
      // 머리글/구분행이 없는 비정상 파이프 블록 — 그대로 둔다.
      emit();
      out.push(...block);
      i = j;
      continue;
    }
    if (pending) {
      between.push(lines[i]); // pending 유지: 다음이 같은 머리글 표면 사잇줄째 버리고 병합
      if (!isDroppableBetween(lines[i])) emit(); // 실제 본문이 끼면 병합 포기, 확정 출력
    } else {
      out.push(lines[i]);
    }
    i++;
  }
  // 끝: 남은 표 출력. 마지막 표 뒤에 빈 줄/꼬리말(between)만 남았으면 함께 버린다(끝 꼬리말 제거).
  // (비-droppable 줄이 왔다면 루프 중 이미 emit 되어 pending 이 비므로, pending 이 남아있으면
  //  between 은 모두 droppable 잔재임이 보장된다.)
  if (pending) out.push(...pending.lines);
  else if (between.length) out.push(...between);
  return out.join("\n");
}

// 단독 숫자 줄 제거 헬퍼: 비공백 줄 시퀀스에서 ±2 이내에 다른 숫자 줄이 없는 '고립된'
// 1~4자리 숫자만 페이지번호로 간주해 제거. 흩어진 차트/표 값(군집)은 데이터이므로 살린다.
const PAGE_NUM_LINE = /^[ \t]*\d{1,4}[ \t]*$/; // 삭제 후보(페이지번호 형태)
const NUMERIC_LINE = /^[ \t]*-?\d[\d,]*\.?\d*[ \t]*$/; // 군집 판단용(값 형태 전반)
function stripLonePageNumbers(md) {
  const lines = md.split("\n");
  const nb = []; // 비공백 줄의 인덱스
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nb.push(i);
  const numeric = nb.map((i) => NUMERIC_LINE.test(lines[i]));
  const W = 2;
  for (let k = 0; k < nb.length; k++) {
    if (!PAGE_NUM_LINE.test(lines[nb[k]])) continue; // 페이지번호 형태만 삭제 후보
    let clustered = false;
    for (let d = -W; d <= W && !clustered; d++) if (d !== 0 && numeric[k + d]) clustered = true;
    if (!clustered) lines[nb[k]] = ""; // 고립된 단독 숫자 = 페이지번호 → 제거
  }
  return lines.join("\n");
}

// 헤딩 보정: 번호 섹션은 깊이에 맞춰 레벨 통일(N→##, N.M→###), 본문 오인 헤딩은 문단으로 강등.
function normalizeHeadings(md) {
  return md
    .split("\n")
    .map((line) => {
      const m = line.match(/^(#{1,6})[ \t]+(.*\S)[ \t]*$/);
      if (!m) return line;
      const text = m[2];

      const num = text.match(/^(\d+(?:\.\d+)*)\.?(?:\s|$)/);
      if (num) {
        const depth = num[1].split(".").length;
        const level = Math.min(6, depth + 1);
        return `${"#".repeat(level)} ${text}`;
      }

      const looksLikeBody =
        text.length > 80 || /[.,;]$/.test(text) || /^[a-z]/.test(text);
      if (looksLikeBody) return text; // # 제거 → 일반 문단

      return line;
    })
    .join("\n");
}
