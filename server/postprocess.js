// kordoc/OCR 출력 markdown 후처리 (정형화).

// markdown 후처리: 추출 잔재 정리 + caption 을 인용 블록으로 강조.
export function postprocessMarkdown(md) {
  if (!md) return md;

  // 합자 복원: "e ffi cient" → "efficient" (ff/ffi/ffl 한정 — 오탐 위험 낮음).
  let out = md.replace(/([A-Za-z])[ \t]+(ffl|ffi|ff)[ \t]+([A-Za-z])/g, "$1$2$3");

  // 빈 대괄호 잔재 라인 제거 (예: "[][]M").
  out = out.replace(/^[ \t]*(?:\[\][ \t]*)+[A-Za-z]?[ \t]*$/gm, "");

  // 단독 페이지번호 줄(숫자만 1~4자리) 제거. (목록 "1.", 참고문헌 "[1]" 은 안전)
  out = out.replace(/^[ \t]*\d{1,4}[ \t]*$/gm, "");

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

  // 4) 과도한 빈 줄 축소 (3+ → 2) + 문서 앞뒤 공백 정리
  out = out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "");
  out = out.replace(/\s+$/, "") + "\n";

  return out;
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
