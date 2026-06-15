// 보이지 않는 텍스트(흰 배경에 흰 글자 등) 제거.
// kordoc 블록엔 색 정보가 없어 mupdf 로 페이지를 walk 하며 '거의 흰색' 글자 run 을 모은다.
// 단, 흰 글자라도 어두운 막대 위에 찍힌 차트 데이터 라벨(예: 막대 안 흰 숫자)은 보이므로
// 색만으로 판정하면 안 된다 → 페이지를 렌더해 run 영역의 '어두운 픽셀 비율'로 가시성을
// 확정한다(배경이 어두우면 보이는 라벨 → 보존, 전부 흰색이면 안 보이는 텍스트 → 제거).
import * as mupdf from "mupdf";

const NEAR_WHITE = 0.95; // r,g,b 모두 이 값 이상이면 흰 글자로 간주
const DARK_LUM = 160; // 픽셀 평균 명도(0~255) < 이 값이면 '어두운' 배경 픽셀
const INVISIBLE_DARK_FRAC = 0.15; // run 영역의 어두운 픽셀 비율이 이 값 미만이면 '안 보임'
const RENDER_DPR = 2;
const MIN_RUN_LEN = 4; // 짧은 run(데이터 라벨 등) 오제거 방지 — 이 길이 미만은 대상 제외

function isWhite(c) {
  return Array.isArray(c) && c.length >= 3 && c.slice(-3).every((v) => v >= NEAR_WHITE);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 페이지에서 흰 글자 run(연속된 흰 글자 묶음 + 합집합 bbox) 수집. 텍스트만 보므로 가볍다.
function whiteRuns(page) {
  let st;
  try {
    st = page.toStructuredText("preserve-whitespace");
  } catch {
    return [];
  }
  const runs = [];
  let cur = "";
  let box = null;
  const extend = (b, q) => {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    return b
      ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) }
      : { x0, y0, x1, y1 };
  };
  const flush = () => {
    if (cur.trim()) runs.push({ text: cur.trim(), bbox: box });
    cur = "";
    box = null;
  };
  try {
    st.walk({
      onChar(c, origin, font, size, quad, argb) {
        if (isWhite(argb)) {
          cur += c;
          box = extend(box, quad);
        } else {
          flush();
        }
      },
      endLine() {
        flush();
      },
    });
  } catch {
    return [];
  }
  flush();
  return runs;
}

// 렌더 픽셀에서 run bbox 영역의 어두운 픽셀 비율.
function darkFrac(b, S, W, H, N) {
  let dark = 0, tot = 0;
  const x0 = Math.max(0, Math.floor(b.x0 * RENDER_DPR));
  const x1 = Math.min(W, Math.ceil(b.x1 * RENDER_DPR));
  const y0 = Math.max(0, Math.floor(b.y0 * RENDER_DPR));
  const y1 = Math.min(H, Math.ceil(b.y1 * RENDER_DPR));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * N;
      const lum = (S[i] + S[i + 1] + S[i + 2]) / 3;
      tot++;
      if (lum < DARK_LUM) dark++;
    }
  }
  return tot ? dark / tot : 0;
}

// arrayBuffer → Map<pageNumber(1-based), string[]>: 페이지별 '보이지 않는 텍스트' 목록.
export function collectInvisibleText(arrayBuffer) {
  const out = new Map();
  let doc;
  try {
    doc = mupdf.Document.openDocument(new Uint8Array(arrayBuffer), "application/pdf");
  } catch {
    return out;
  }
  const n = doc.countPages();
  for (let p = 0; p < n; p++) {
    let page;
    try {
      page = doc.loadPage(p);
    } catch {
      continue;
    }
    const runs = whiteRuns(page).filter((r) => r.text.length >= MIN_RUN_LEN);
    if (!runs.length) continue; // 흰 글자 없으면 렌더 생략(대부분의 페이지)
    let pix;
    try {
      pix = page.toPixmap(mupdf.Matrix.scale(RENDER_DPR, RENDER_DPR), mupdf.ColorSpace.DeviceRGB, false);
    } catch {
      continue;
    }
    const W = pix.getWidth(), H = pix.getHeight(), N = pix.getNumberOfComponents(), S = pix.getPixels();
    const invisible = [];
    for (const r of runs) {
      if (darkFrac(r.bbox, S, W, H, N) < INVISIBLE_DARK_FRAC) invisible.push(r.text);
    }
    if (invisible.length) out.set(p + 1, invisible);
  }
  return out;
}

// 블록 텍스트에서 보이지 않는 run 을 (공백 무시) 제거. 남는 게 없으면 블록 드롭.
// { blocks: 정리된 블록, removed: 영향받은 블록 수 }.
export function stripInvisibleFromBlocks(blocks, invisibleByPage) {
  if (!invisibleByPage || !invisibleByPage.size) return { blocks, removed: 0 };
  const out = [];
  let removed = 0;
  for (const b of blocks || []) {
    const runs = invisibleByPage.get(b.pageNumber);
    if (!runs || b.type === "table" || !b.text) {
      out.push(b);
      continue;
    }
    let text = b.text;
    for (const run of runs) {
      const re = new RegExp(run.split(/\s+/).map(escapeRe).join("\\s*"));
      text = text.replace(re, "");
    }
    text = text.replace(/[ \t]{2,}/g, " ").trim();
    if (text === b.text) {
      out.push(b);
    } else if (text) {
      out.push({ ...b, text }); // 보이는 부분만 남김
      removed++;
    } else {
      removed++; // 전부 보이지 않는 텍스트였음 → 블록 드롭
    }
  }
  return { blocks: out, removed };
}
