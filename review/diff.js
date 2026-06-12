// 결과 비교 팝업 — 자체 완결. ?file=&left=&right= 로 열리며, 해당 문서의 실행 결과를
// 직접 불러와 좌/우 선택 + LCS diff 렌더 (IntelliJ 스타일, 숫자 차이 강조).

const DIFF_FONT_MIN = 11;
const DIFF_FONT_MAX = 26;

const els = {
  left: document.querySelector("#diff-left-select"),
  right: document.querySelector("#diff-right-select"),
  swap: document.querySelector("#diff-swap"),
  onlyChanges: document.querySelector("#diff-only-changes"),
  fontDec: document.querySelector("#diff-font-dec"),
  fontInc: document.querySelector("#diff-font-inc"),
  fontLabel: document.querySelector("#diff-font-label"),
  stats: document.querySelector("#diff-stats"),
  body: document.querySelector("#diff-body"),
};

const params = new URLSearchParams(location.search);
const file = params.get("file") || "";
const markdownCache = new Map(); // resultId -> markdown
const expandedSkips = new Set();
let results = [];

els.left.addEventListener("change", render);
els.right.addEventListener("change", render);
els.onlyChanges.addEventListener("change", render);
els.swap.addEventListener("click", () => {
  const l = els.left.value;
  els.left.value = els.right.value;
  els.right.value = l;
  render();
});
els.fontDec.addEventListener("click", () => stepFont(-1));
els.fontInc.addEventListener("click", () => stepFont(1));
applyFont();

await init();

async function init() {
  if (!file) {
    els.body.innerHTML = `<div class="empty-state">비교할 문서가 지정되지 않았습니다.</div>`;
    return;
  }
  document.title = `비교 · ${file}`;
  try {
    const data = await fetchJson(`/api/eval/results?file=${encodeURIComponent(file)}`);
    results = data.results || [];
  } catch (e) {
    els.body.innerHTML = `<div class="empty-state">${escapeHtml(e.message || "결과 로드 실패")}</div>`;
    return;
  }
  if (results.length < 2) {
    els.body.innerHTML = `<div class="empty-state">비교하려면 실행 결과가 2개 이상 필요합니다 (현재 ${results.length}개).</div>`;
    return;
  }
  const options = results
    .map((r) => {
      const label = `${r.provider} · ${formatTime(r.elapsedMs)} · ${formatDate(r.createdAt)}${r.ok ? "" : " · 실패"}`;
      return `<option value="${escapeAttr(r.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  els.left.innerHTML = options;
  els.right.innerHTML = options;
  const left = params.get("left") && results.some((r) => r.id === params.get("left")) ? params.get("left") : results[0].id;
  const right =
    params.get("right") && results.some((r) => r.id === params.get("right"))
      ? params.get("right")
      : results.find((r) => r.id !== left)?.id;
  els.left.value = left;
  els.right.value = right;
  await render();
}

async function markdownOf(resultId) {
  if (!markdownCache.has(resultId)) {
    const data = await fetchJson(`/api/eval/compare?resultId=${encodeURIComponent(resultId)}`);
    markdownCache.set(resultId, String(data.result?.markdown || data.result?.error || ""));
  }
  return markdownCache.get(resultId);
}

async function render() {
  const leftId = els.left.value;
  const rightId = els.right.value;
  if (!leftId || !rightId) return;
  expandedSkips.clear();
  els.body.innerHTML = `<div class="empty-state">비교 중…</div>`;
  let leftMd, rightMd;
  try {
    [leftMd, rightMd] = await Promise.all([markdownOf(leftId), markdownOf(rightId)]);
  } catch (e) {
    els.body.innerHTML = `<div class="empty-state">${escapeHtml(e.message || "결과 로드 실패")}</div>`;
    return;
  }
  paint(leftMd, rightMd);
}

function paint(leftMd, rightMd) {
  const rows = diffRows(leftMd.split(/\r?\n/), rightMd.split(/\r?\n/));
  const changes = rows.filter((r) => r.type !== "equal").length;
  els.stats.textContent = changes ? `차이점 ${changes.toLocaleString()}줄` : "차이 없음";

  const leftNums = new Set(extractNumbers(leftMd));
  const rightNums = new Set(extractNumbers(rightMd));
  const display = els.onlyChanges.checked ? collapseEqualRows(rows) : rows;

  els.body.innerHTML = `
    <div class="diff-grid">
      ${display
        .map((row) => {
          if (row.type === "skip") {
            return `<button class="diff-skip" data-skip="${row.skipIndex}" type="button" title="동일 구간 펼치기">··· 동일 ${row.count}줄 ···</button>`;
          }
          return `
            <div class="diff-line left ${row.type}">
              <span class="line-no">${row.leftNo || ""}</span>
              <span class="line-text">${highlightNumbers(row.left || "", rightNums, "num-miss")}</span>
            </div>
            <div class="diff-line right ${row.type}">
              <span class="line-no">${row.rightNo || ""}</span>
              <span class="line-text">${highlightNumbers(row.right || "", leftNums, "num-extra")}</span>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
  els.body.querySelectorAll(".diff-skip").forEach((button) => {
    button.addEventListener("click", () => {
      expandedSkips.add(Number(button.dataset.skip));
      paint(leftMd, rightMd);
    });
  });
}

// 변경 주변 2줄 컨텍스트만 남기고 동일 구간은 접는다 (클릭으로 펼침).
function collapseEqualRows(rows, context = 2) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((row, i) => {
    if (row.type === "equal") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  const out = [];
  let skipIndex = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      out.push(rows[i]);
      continue;
    }
    let j = i;
    while (j < rows.length && !keep[j]) j++;
    const count = j - i;
    if (expandedSkips.has(skipIndex) || count <= 2) out.push(...rows.slice(i, j));
    else out.push({ type: "skip", count, skipIndex });
    skipIndex++;
    i = j - 1;
  }
  return out;
}

// LCS 기반 라인 diff (대용량은 위치 기반 폴백).
function diffRows(a, b) {
  if (a.length * b.length > 1200000) return pairedDiff(a, b);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      out.push({ type: "equal", left: a[i - 1], right: b[j - 1], leftNo: i, rightNo: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.push({ type: "added", right: b[j - 1], rightNo: j });
      j--;
    } else {
      out.push({ type: "removed", left: a[i - 1], leftNo: i });
      i--;
    }
  }
  return pairChanges(out.reverse());
}

function pairedDiff(a, b) {
  const len = Math.max(a.length, b.length);
  return Array.from({ length: len }, (_, idx) => {
    const left = a[idx] || "";
    const right = b[idx] || "";
    return {
      type: left === right ? "equal" : "changed",
      left,
      right,
      leftNo: a[idx] == null ? "" : idx + 1,
      rightNo: b[idx] == null ? "" : idx + 1,
    };
  });
}

// 인접한 removed+added 쌍을 changed 한 행으로 합친다 (IntelliJ 식 좌우 대응).
function pairChanges(rows) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const next = rows[i + 1];
    if (row.type === "removed" && next?.type === "added") {
      out.push({ type: "changed", left: row.left, right: next.right, leftNo: row.leftNo, rightNo: next.rightNo });
      i++;
    } else if (row.type === "added" && next?.type === "removed") {
      out.push({ type: "changed", left: next.left, right: row.right, leftNo: next.leftNo, rightNo: row.rightNo });
      i++;
    } else {
      out.push(row);
    }
  }
  return out;
}

// 반대편에 없는 숫자를 강조 — 파싱 결과 비교에서 수치 차이를 한눈에.
function highlightNumbers(text, otherNums, klass) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /\d{4}[./-]\d{1,2}[./-]\d{1,2}|[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|퍼센트|억원|만원|원|명|건|개|세|㎡|m2)?/g,
    (raw) => (otherNums.has(normalizeNumber(raw)) ? raw : `<span class="${klass}">${raw}</span>`)
  );
}

function extractNumbers(text) {
  return [
    ...String(text || "").matchAll(
      /\d{4}[./-]\d{1,2}[./-]\d{1,2}|[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:%|퍼센트|억원|만원|원|명|건|개|세|㎡|m2)?/g
    ),
  ].map((m) => normalizeNumber(m[0]));
}

function normalizeNumber(raw) {
  return raw.replace(/\s+/g, "").replace(/,/g, "").replace(/[./-]/g, ".").toLowerCase();
}

// ── 글자 크기 ───────────────────────────────────────────────
function loadFont() {
  const n = Number(localStorage.getItem("review.diffFont"));
  return Number.isFinite(n) && n >= DIFF_FONT_MIN && n <= DIFF_FONT_MAX ? n : 14;
}

function applyFont() {
  const px = loadFont();
  els.body.style.fontSize = `${px}px`;
  els.fontLabel.textContent = `${px}px`;
}

function stepFont(delta) {
  const px = Math.max(DIFF_FONT_MIN, Math.min(DIFF_FONT_MAX, loadFont() + delta));
  try {
    localStorage.setItem("review.diffFont", String(px));
  } catch {
    /* 세션 동안만 적용 */
  }
  applyFont();
}

// ── 유틸 ─────────────────────────────────────────────────────
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`);
  return data;
}

function formatTime(ms) {
  if (ms == null) return "-";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
