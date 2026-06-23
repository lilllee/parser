// PaddleOCR-VL doc-parser API 클라이언트 (/api/v1/parse @ :8500).
// 레이아웃 감지 + HTML <table>(colspan/rowspan) 복원 + 블록 bbox. 서버측 옵션:
//   clean_html=true  → <table> border/inline style 제거, 셀 \n→<br>, 파이프표로 안 바꿈(HTML 유지)
//   drop_images=true → inline 안 할 때 빈 <img>(+감싼 div) 제거
//   dpi=N            → per-request PDF 렌더 DPI(기본 200, bbox/width/height 도 이 기준)
// ⚠ /parse 는 레이아웃 모델(CPU)이 비스레드세이프 → 서버가 사실상 직렬(concurrency=1).
//   클라이언트도 동시 호출하지 않도록 모듈 내 '직렬 큐'로 한 번에 하나씩 보낸다.
import { Buffer } from "node:buffer";

const ENV_URL = () => process.env.PADDLE_PARSE_URL || "";
const ENV_TIMEOUT = () => Number(process.env.PADDLE_PARSE_TIMEOUT_MS || 300_000);
const CLEAN_HTML = () => process.env.PADDLE_CLEAN_HTML !== "0"; // 기본 on (R1)
const DROP_IMAGES = () => process.env.PADDLE_DROP_IMAGES !== "0"; // 기본 on (R2)
const DPI = () => process.env.PADDLE_PARSE_DPI || ""; // 빈 값이면 미전송(서버 기본 200)

export const PADDLE_PARSE_ENABLED = () => !!ENV_URL();

// base(http://host:8500) 또는 풀 경로(.../api/v1/parse) 모두 허용 → 정규화. (export: 단위 테스트용)
export function paddleEndpoint(base, path) {
  const root = String(base || "").replace(/\/+$/, "").replace(/\/api\/v1\/(parse|ocr)$/, "");
  return `${root}${path}`;
}

const FILE_MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
};
function mimeOf(filename, fallback = "application/octet-stream") {
  return FILE_MIME[String(filename || "").split(".").pop().toLowerCase()] || fallback;
}

// 직렬 큐 — 이전 호출이 settle 한 뒤에야 다음 task 를 실행한다(성공/실패 무관). /parse 동시호출 방지.
let _chain = Promise.resolve();
export function serialize(task) {
  const run = _chain.then(task, task);
  _chain = run.then(() => {}, () => {});
  return run;
}

async function postParse(blob, filename, { url, timeoutMs } = {}) {
  const base = url || ENV_URL();
  if (!base) throw new Error("PADDLE_PARSE_URL 미설정");
  const form = new FormData();
  form.append("file", blob, filename);
  if (CLEAN_HTML()) form.append("clean_html", "true");
  if (DROP_IMAGES()) form.append("drop_images", "true");
  if (DPI()) form.append("dpi", String(DPI()));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || ENV_TIMEOUT());
  try {
    const resp = await fetch(paddleEndpoint(base, "/api/v1/parse"), { method: "POST", body: form, signal: ac.signal });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      const err = new Error(`PaddleParse HTTP ${resp.status} ${detail.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// 단일 페이지 PNG → 그 페이지 markdown(HTML 표). reflow per-page 결선용. (직렬 큐)
export async function paddleParsePageImage(png, opts = {}) {
  const json = await serialize(() => postParse(new Blob([Buffer.from(png)], { type: "image/png" }), "page.png", opts));
  return json?.pages?.[0]?.markdown || "";
}

// 파일 통째 → { markdown(페이지 ---로 합침), pages, pageCount }. document-parser/force_ocr 용. (직렬 큐)
export async function paddleParseFile(buffer, filename = "doc.pdf", mime, opts = {}) {
  const blob = new Blob([Buffer.from(buffer)], { type: mime || mimeOf(filename, "application/pdf") });
  const json = await serialize(() => postParse(blob, filename || "doc.pdf", opts));
  const pages = json?.pages || [];
  const markdown = pages.map((p) => p?.markdown || "").filter(Boolean).join("\n\n---\n\n");
  return { markdown, pages, pageCount: json?.page_count ?? pages.length };
}

export async function paddleHealth(url) {
  const base = url || ENV_URL();
  if (!base) throw new Error("PADDLE_PARSE_URL 미설정");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const resp = await fetch(paddleEndpoint(base, "/api/health"), { signal: ac.signal });
    if (!resp.ok) throw new Error(`Paddle /api/health HTTP ${resp.status}`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}
