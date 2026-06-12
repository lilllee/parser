// fs.md Parse UI — 좌: 원본 문서, 우: 파싱 결과 (LlamaCloud Parse 스타일 2-pane).
const state = {
  files: [],
  providers: [],
  bedrockModels: [],
  bedrockRegion: "",
  currentFile: null,
  source: null, // /api/eval/golden 응답 (원본 media 정보로만 사용)
  results: [],
  compare: null,
  view: "rendered",
};

const els = {
  fileTabs: document.querySelector("#file-tabs"),
  fileCount: document.querySelector("#file-count"),
  fileInput: document.querySelector("#document-file-input"),
  sourceView: document.querySelector("#source-view"),
  sourceMeta: document.querySelector("#source-meta"),
  resultView: document.querySelector("#result-view"),
  resultMeta: document.querySelector("#result-meta"),
  resultSelect: document.querySelector("#result-select"),
  exportMdButton: document.querySelector("#export-md-button"),
  provider: document.querySelector("#provider-select"),
  providerChecks: document.querySelector("#provider-checks"),
  providerConfig: document.querySelector("#provider-config"),
  geminiApiKey: document.querySelector("#gemini-api-key"),
  geminiModel: document.querySelector("#gemini-model"),
  bedrockRegionInput: document.querySelector("#bedrock-region"),
  bedrockModelList: document.querySelector("#bedrock-model-list"),
  bedrockProfile: document.querySelector("#bedrock-profile"),
  bedrockAccessKeyId: document.querySelector("#bedrock-access-key-id"),
  bedrockSecretAccessKey: document.querySelector("#bedrock-secret-access-key"),
  bedrockSessionToken: document.querySelector("#bedrock-session-token"),
  claudeCliModel: document.querySelector("#claude-cli-model"),
  codexCliModel: document.querySelector("#codex-cli-model"),
  docType: document.querySelector("#doc-type-select"),
  runSettings: document.querySelector("#run-settings"),
  settingsToggle: document.querySelector("#settings-toggle"),
  runProgress: document.querySelector("#run-progress"),
  runProgressFill: document.querySelector("#run-progress-fill"),
  runProgressLabel: document.querySelector("#run-progress-label"),
  toast: document.querySelector("#toast"),
};

document.querySelector("#refresh-button").addEventListener("click", init);
els.fileInput.addEventListener("change", uploadDocument);
els.provider.addEventListener("change", renderProviderConfig);
let bedrockRegionTimer = null;
els.bedrockRegionInput.addEventListener("input", () => {
  clearTimeout(bedrockRegionTimer);
  bedrockRegionTimer = setTimeout(refreshBedrockModels, 300);
});
els.bedrockRegionInput.addEventListener("change", refreshBedrockModels);
document.querySelector("#run-button").addEventListener("click", runSelected);
document.querySelector("#batch-button").addEventListener("click", runChecked);
els.exportMdButton.addEventListener("click", exportMarkdown);
els.resultSelect.addEventListener("change", () => loadComparison(els.resultSelect.value));
els.settingsToggle.addEventListener("click", () => {
  const open = els.runSettings.hidden;
  els.runSettings.hidden = !open;
  els.settingsToggle.setAttribute("aria-expanded", String(open));
  els.settingsToggle.classList.toggle("is-active", open);
});
document.querySelector("#diff-button").addEventListener("click", openDiffWindow);
document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b === button));
    renderResult();
  });
});

await init();

async function init() {
  const [providerData, fileData] = await Promise.all([
    fetchJson("/api/eval/providers"),
    fetchJson("/api/eval/files"),
  ]);
  state.providers = providerData.providers || [];
  state.bedrockModels = providerData.bedrockModels || [];
  state.bedrockRegion = providerData.bedrockRegion || "";
  if (!els.bedrockRegionInput.value.trim() && state.bedrockRegion) {
    els.bedrockRegionInput.value = state.bedrockRegion;
  }
  state.files = fileData.files || [];
  renderProviders();
  renderBedrockModels();
  renderFileTabs();
  const currentExists = state.currentFile && state.files.some((file) => file.name === state.currentFile.name);
  if (currentExists) {
    await selectFile(state.currentFile.name);
  } else if (state.files[0]) {
    await selectFile(state.files[0].name);
  } else {
    resetSelection();
  }
}

function resetSelection() {
  state.currentFile = null;
  state.source = null;
  state.results = [];
  state.compare = null;
  renderFileTabs();
  renderResultSelect();
  renderAll();
}

function renderProviders() {
  els.provider.innerHTML = state.providers.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");
  els.providerChecks.innerHTML = state.providers
    .map((p, i) => {
      const checked = i === 0 ? "checked" : "";
      return `<label><input type="checkbox" value="${escapeAttr(p)}" ${checked} /> ${escapeHtml(p)}</label>`;
    })
    .join("");
  els.providerChecks.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", renderProviderConfig);
  });
  renderProviderConfig();
}

function renderProviderConfig() {
  const selected = els.provider.value;
  const checked = new Set([...els.providerChecks.querySelectorAll("input:checked")].map((input) => input.value));
  checked.add(selected);
  els.providerConfig.querySelectorAll(".config-field").forEach((field) => {
    const key = field.dataset.config;
    field.hidden = !checked.has(key);
  });
}

// Bedrock 허용 모델 체크리스트 (서버 고정 목록). 선택 상태는 localStorage 에 유지.
function renderBedrockModels() {
  if (!els.bedrockModelList) return;
  const saved = loadBedrockModelState();
  els.bedrockModelList.innerHTML = state.bedrockModels
    .map((m) => {
      const tags = [];
      if (!m.vision) tags.push("텍스트 전용");
      if (!m.available) tags.push(`${escapeHtml(state.bedrockRegion)} 미제공`);
      const tag = tags.length ? ` <em class="model-tag">${tags.join(" · ")}</em>` : "";
      const disabled = m.available ? "" : "disabled";
      const checked = m.available && (saved ? saved.includes(m.key) : true) ? "checked" : "";
      return `<label class="${m.available ? "" : "is-unavailable"}"><input type="checkbox" value="${escapeAttr(m.key)}" ${checked} ${disabled} /> ${escapeHtml(m.label)}${tag}</label>`;
    })
    .join("");
  els.bedrockModelList.querySelectorAll("input").forEach((input) => {
    input.addEventListener("change", saveBedrockModelState);
  });
}

function checkedBedrockModelKeys() {
  return [...(els.bedrockModelList?.querySelectorAll("input:checked") || [])].map((input) => input.value);
}

function loadBedrockModelState() {
  try {
    const saved = JSON.parse(localStorage.getItem("review.bedrockModels") || "null");
    return Array.isArray(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveBedrockModelState() {
  try {
    localStorage.setItem("review.bedrockModels", JSON.stringify(checkedBedrockModelKeys()));
  } catch {
    // 저장 실패해도 체크 상태는 이번 세션 동안 유효.
  }
}

async function refreshBedrockModels() {
  const region = els.bedrockRegionInput.value.trim();
  const suffix = region ? `?region=${encodeURIComponent(region)}` : "";
  try {
    const data = await fetchJson(`/api/eval/providers${suffix}`);
    state.bedrockModels = data.bedrockModels || [];
    state.bedrockRegion = data.bedrockRegion || region;
    renderBedrockModels();
  } catch (e) {
    toast(e.message || "Bedrock 모델 목록 갱신 실패");
  }
}

// 실행할 provider 목록 구성 — "bedrock" 은 체크한 Bedrock 모델들("bedrock:<key>")로 펼친다.
function expandProviders(providers) {
  const out = [];
  for (const p of providers) {
    if (p !== "bedrock") {
      out.push(p);
      continue;
    }
    const keys = checkedBedrockModelKeys();
    if (!keys.length) {
      toast("Bedrock 모델을 1개 이상 체크하세요.");
      return null;
    }
    out.push(...keys.map((key) => `bedrock:${key}`));
  }
  return out;
}

// 상단 문서 칩(탭) — 클릭으로 전환, 휴지통으로 개별 삭제 (LlamaCloud 파일 칩 스타일).
function renderFileTabs() {
  els.fileCount.textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
  els.fileTabs.innerHTML = state.files.length
    ? state.files
        .map((file) => {
          const active = state.currentFile?.name === file.name ? " is-active" : "";
          const name = escapeAttr(file.name);
          return `
            <span class="file-chip${active}" data-file="${name}" role="tab" aria-selected="${active ? "true" : "false"}">
              <button class="chip-name" type="button" title="${name} (${formatBytes(file.size)} · ${file.resultCount} runs)">${escapeHtml(file.name)}</button>
              <button class="chip-delete" type="button" title="파일 삭제" aria-label="${name} 삭제"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 4h11M5.5 4V2.8c0-.4.3-.8.8-.8h3.4c.5 0 .8.4.8.8V4M4 4l.7 9.3c0 .5.4.9.9.9h4.8c.5 0 .9-.4.9-.9L12 4M6.5 7v4M9.5 7v4"/></svg></button>
            </span>
          `;
        })
        .join("")
    : `<span class="file-chip-empty">파일 없음</span>`;
  els.fileTabs.querySelectorAll(".file-chip").forEach((chip) => {
    const name = chip.dataset.file;
    chip.querySelector(".chip-name").addEventListener("click", () => selectFile(name));
    chip.querySelector(".chip-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFile(name);
    });
  });
}

async function deleteFile(name) {
  if (!window.confirm(`'${name}' 파일을 삭제할까요?`)) return;
  setBusy(true);
  try {
    const data = await fetchJson("/api/eval/files/delete", {
      method: "POST",
      body: JSON.stringify({ file: name }),
    });
    state.files = data.files || [];
    toast(`삭제 완료: ${name}`);
    if (state.currentFile?.name === name) {
      state.currentFile = null;
      if (state.files[0]) await selectFile(state.files[0].name);
      else resetSelection();
    } else {
      renderFileTabs();
    }
  } catch (e) {
    toast(e.message || "파일 삭제 실패");
  } finally {
    setBusy(false);
  }
}

// 다중 선택 업로드 — 순차 전송(진행 토스트), 실패는 모아서 보고, 마지막 파일을 활성화.
async function uploadDocument() {
  const files = [...(els.fileInput.files || [])];
  if (!files.length) return;
  setBusy(true);
  let lastName = null;
  const failed = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (files.length > 1) toast(`업로드 중 ${i + 1}/${files.length}: ${file.name}`);
      const formData = new FormData();
      formData.append("file", file);
      try {
        const data = await fetchJson("/api/eval/upload", { method: "POST", body: formData });
        state.files = data.files || [];
        lastName = data.file.name;
      } catch (e) {
        failed.push(`${file.name}: ${e.message || "실패"}`);
      }
    }
    renderFileTabs();
    if (failed.length) toast(`업로드 실패 ${failed.length}건 — ${failed[0]}`);
    else toast(files.length > 1 ? `${files.length}개 파일 추가 완료` : `파일 추가 완료: ${lastName}`);
    if (lastName) await selectFile(lastName);
  } finally {
    els.fileInput.value = "";
    setBusy(false);
  }
}

async function selectFile(name) {
  if (!name) return resetSelection();
  state.currentFile = state.files.find((file) => file.name === name) || { name, docType: "document" };
  els.docType.value = state.currentFile.docType || "document";
  renderFileTabs();
  const [source, resultData] = await Promise.all([
    fetchJson(`/api/eval/golden?file=${encodeURIComponent(name)}`),
    fetchJson(`/api/eval/results?file=${encodeURIComponent(name)}`),
  ]);
  state.source = source;
  state.results = resultData.results || [];
  renderResultSelect();
  if (state.results[0]) await loadComparison(state.results[0].id);
  else {
    state.compare = null;
    renderAll();
  }
}

function renderResultSelect() {
  if (!state.results.length) {
    els.resultSelect.innerHTML = `<option value="">결과 없음</option>`;
    return;
  }
  els.resultSelect.innerHTML = state.results
    .map((result) => {
      const label = `${result.provider} · ${formatTime(result.elapsedMs)} · ${formatDate(result.createdAt)}${result.ok ? "" : " · 실패"}`;
      return `<option value="${escapeAttr(result.id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
}

async function loadComparison(resultId) {
  if (!resultId) {
    state.compare = null;
    renderAll();
    return;
  }
  state.compare = await fetchJson(`/api/eval/compare?resultId=${encodeURIComponent(resultId)}`);
  state.source = state.compare.golden;
  renderAll();
}

function exportMarkdown() {
  const result = state.compare?.result;
  if (!result) return toast("추출할 변환 결과가 없습니다.");
  if (!String(result.markdown || "").trim()) return toast("추출할 markdown이 없습니다.");

  const link = document.createElement("a");
  link.href = `/api/eval/result.md?resultId=${encodeURIComponent(result.id)}`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  toast("MD 추출을 시작했습니다.");
}

// 결과 비교 — 별도 브라우저 창(팝업)으로 띄운다. diff.html 이 자체적으로 결과 목록을
// 불러와 좌/우 선택·diff 렌더를 처리하므로 메인 UI 와 독립적이며 다른 모니터로 옮길 수 있다.
function openDiffWindow() {
  if (!state.currentFile) return toast("문서를 선택하세요.");
  if (state.results.length < 2) return toast("비교하려면 같은 문서의 실행 결과가 2개 이상 필요합니다.");
  const left = state.compare?.result?.id || state.results[0].id;
  const right = state.results.find((r) => r.id !== left)?.id || "";
  const qs = new URLSearchParams({ file: state.currentFile.name, left, right }).toString();
  const features = "popup,noopener=no,width=1500,height=950,left=120,top=80";
  const win = window.open(`/review/diff.html?${qs}`, `fsmd-diff-${state.currentFile.name}`, features);
  if (!win) toast("팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용하세요.");
  else win.focus();
}

function renderAll() {
  renderSource();
  renderResult();
}

function renderSource() {
  if (!state.currentFile) {
    els.sourceView.innerHTML = `<div class="empty-state">문서를 업로드하거나 선택하세요</div>`;
    els.sourceMeta.textContent = "-";
    return;
  }
  els.sourceView.innerHTML = renderSourceViewer(state.source);
  const size = state.currentFile.size ? ` · ${formatBytes(state.currentFile.size)}` : "";
  els.sourceMeta.textContent = `${state.currentFile.name}${size}`;
}

function renderResult() {
  const result = state.compare?.result;
  if (!result) {
    els.resultView.innerHTML = `<div class="empty-state">${state.currentFile ? "실행 결과 없음 — Run Parse 로 변환하세요" : "실행 결과가 여기에 표시됩니다"}</div>`;
    els.resultMeta.textContent = "-";
    return;
  }
  const output = result.markdown || "";
  els.resultMeta.textContent = result.ok
    ? `${result.provider} · ${formatTime(result.elapsedMs)} · ${output.length.toLocaleString()}자${aiCallsLabel(result)}`
    : `${result.provider} · 실패: ${result.code || result.error || "unknown"}`;
  if (state.view === "raw") {
    els.resultView.innerHTML = `<pre class="raw-pane">${escapeHtml(output || result.error || "")}</pre>`;
    return;
  }
  els.resultView.innerHTML = `<div class="render-pane">${renderMarkdown(output || result.error || "")}</div>`;
}

// 변환 중 AI 가 실제로 몇 번 불렸는지 표시 — 0회면 모델 비교가 무의미한 결과(순수 kordoc).
function aiCallsLabel(result) {
  if (result.aiCalls == null) return "";
  if (!result.aiCalls) return " · ⚠ AI 미사용";
  return ` · AI ${result.aiCalls}회${result.aiFailures ? ` (실패 ${result.aiFailures})` : ""}`;
}

async function runSelected() {
  if (!state.currentFile) return toast("문서를 선택하세요.");
  const provider = els.provider.value;
  // Bedrock 은 단일 실행도 체크한 모델 전부 일괄 실행 (다중 모델 테스트 요구사항).
  if (provider === "bedrock") {
    const providers = expandProviders(["bedrock"]);
    if (!providers) return;
    return runProviderBatch(providers);
  }
  await runPayload({ provider });
}

async function runChecked() {
  if (!state.currentFile) return toast("문서를 선택하세요.");
  const checked = [...els.providerChecks.querySelectorAll("input:checked")].map((input) => input.value);
  if (!checked.length) return toast("설정에서 비교할 모델을 체크하세요.");
  const providers = expandProviders(checked);
  if (!providers) return;
  await runProviderBatch(providers);
}

async function runProviderBatch(providers) {
  // Bedrock 은 모델별로 계정/리전 제약이 달라(use case form, 리전 미제공 등) 실행 전에
  // 모델별로 연결을 점검하고, 실패한 모델만 제외한 채 나머지를 실행한다.
  const bedrockEntries = providers.filter((p) => p.startsWith("bedrock:"));
  let skippedCount = 0;
  if (bedrockEntries.length) {
    setBusy(true);
    let checks;
    try {
      checks = await Promise.all(
        bedrockEntries.map(async (p) => {
          try {
            const r = await fetchJson("/api/eval/check", {
              method: "POST",
              body: JSON.stringify({ provider: p, providerOverrides: collectProviderOverrides() }),
            });
            return { p, ok: !!r.ok, error: r.error };
          } catch (e) {
            return { p, ok: false, error: e.message };
          }
        })
      );
    } finally {
      setBusy(false);
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) {
      skippedCount = failed.length;
      const failedSet = new Set(failed.map((c) => c.p));
      providers = providers.filter((p) => !failedSet.has(p));
      const names = failed.map((c) => c.p.replace("bedrock:", "")).join(", ");
      toast(`Bedrock ${failed.length}개 모델 제외(${names}) — ${failed[0].error}`);
      if (!providers.length) return;
    }
  }
  setBusy(true);
  try {
    await fetchJson("/api/eval/batch", {
      method: "POST",
      body: JSON.stringify({
        files: [state.currentFile.name],
        providers,
        docType: els.docType.value,
        providerOverrides: collectProviderOverrides(),
      }),
    });
    toast(`${providers.length}개 모델 실행 완료${skippedCount ? ` · ${skippedCount}개 제외(연결 실패)` : ""}`);
    await init();
    await selectFile(state.currentFile.name);
  } finally {
    setBusy(false);
  }
}

async function runPayload({ provider }) {
  setBusy(true);
  showProgress(0, "시작 중…");
  let result = null;
  try {
    const response = await fetch("/api/eval/run/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: state.currentFile.name,
        provider,
        docType: els.docType.value,
        providerOverrides: collectProviderOverrides(),
      }),
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    // ndjson 스트림: 한 줄당 JSON 이벤트 (phase / progress / warning / done / error)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        handleRunEvent(ev, (r) => (result = r));
      }
    }
  } catch (e) {
    toast(e.message || "변환 요청 실패");
  } finally {
    hideProgress();
    setBusy(false);
  }

  if (result) {
    toast(result.ok ? "변환 완료" : `변환 실패: ${result.code || result.error || ""}`);
    await selectFile(state.currentFile.name);
    if (result.id) {
      els.resultSelect.value = result.id;
      await loadComparison(result.id);
    }
  }
}

function handleRunEvent(ev, setResult) {
  if (ev.type === "progress" && typeof ev.progress === "number") {
    showProgress(ev.progress, els.runProgressLabel.textContent);
  } else if (ev.type === "phase") {
    const detail = ev.message || ev.phase || "";
    showProgress(null, detail);
  } else if (ev.type === "done") {
    showProgress(1, "완료");
    setResult(ev.result);
  } else if (ev.type === "error") {
    setResult({ ok: false, error: ev.error, code: ev.code });
  }
}

// progress: 0..1 = 막대 채움, null = 라벨만 갱신(막대는 불확정 애니메이션 유지)
function showProgress(progress, label) {
  els.runProgress.hidden = false;
  if (label != null) els.runProgressLabel.textContent = label;
  if (typeof progress === "number") {
    els.runProgress.classList.remove("is-indeterminate");
    els.runProgressFill.style.width = `${Math.max(2, Math.min(100, progress * 100))}%`;
  } else if (!els.runProgressFill.style.width) {
    els.runProgress.classList.add("is-indeterminate");
  }
}

function hideProgress() {
  els.runProgress.hidden = true;
  els.runProgress.classList.remove("is-indeterminate");
  els.runProgressFill.style.width = "";
}

function collectProviderOverrides() {
  const overrides = {};
  const gemini = {};
  if (els.geminiApiKey.value.trim()) gemini.api_key = els.geminiApiKey.value.trim();
  if (els.geminiModel.value.trim()) gemini.model = els.geminiModel.value.trim();
  if (Object.keys(gemini).length) overrides.gemini = gemini;

  const bedrock = {};
  if (els.bedrockRegionInput.value.trim()) bedrock.region = els.bedrockRegionInput.value.trim();
  if (els.bedrockProfile.value.trim()) bedrock.profile = els.bedrockProfile.value.trim();
  if (els.bedrockAccessKeyId.value.trim()) bedrock.access_key_id = els.bedrockAccessKeyId.value.trim();
  if (els.bedrockSecretAccessKey.value.trim()) bedrock.secret_access_key = els.bedrockSecretAccessKey.value.trim();
  if (els.bedrockSessionToken.value.trim()) bedrock.session_token = els.bedrockSessionToken.value.trim();
  if (Object.keys(bedrock).length) overrides.bedrock = bedrock;

  const claudeModel = els.claudeCliModel.value.trim();
  if (claudeModel) overrides.claude_cli = { model: claudeModel };

  const codexModel = els.codexCliModel.value.trim();
  if (codexModel) overrides.codex_cli = { model: codexModel };

  return overrides;
}

function renderSourceViewer(source) {
  const media = source?.media;
  if (!media?.url) return `<div class="empty-state">원본 파일 없음</div>`;
  const file = source.file || state.currentFile?.name || "source";
  const url = escapeAttr(media.url);
  const label = escapeHtml(file);

  if (media.kind === "pdf") {
    return `<object class="source-pdf" data="${url}" type="application/pdf"><a href="${url}" target="_blank" rel="noreferrer">${label}</a></object>`;
  }
  if (media.kind === "image") {
    return `<figure class="source-figure"><img class="source-image" src="${url}" alt="${escapeAttr(file)}" /></figure>`;
  }
  if (media.kind === "text") {
    return `<iframe class="source-frame" src="${url}" title="${escapeAttr(file)}"></iframe>`;
  }
  return `
    <div class="source-fallback">
      <strong>${label}</strong>
      <span>브라우저 미리보기를 지원하지 않는 원본 파일입니다.</span>
      <a href="${url}" target="_blank" rel="noreferrer">원본 파일 열기</a>
    </div>
  `;
}

function renderMarkdown(md) {
  const lines = String(md || "").split(/\r?\n/);
  let html = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const image = /^!\[([^\]]*)]\(([^)]+)\)\s*$/.exec(line);
    if (image) {
      html += `<figure class="source-figure"><img class="source-image" src="${escapeAttr(image[2])}" alt="${escapeAttr(image[1])}" /></figure>`;
      continue;
    }
    if (/^\s*<table[\s>]/i.test(line)) {
      // OCR 이 복잡한 병합셀 표를 HTML 로 출력하는 경우 — 블록 통째로 통과시킨다.
      const buf = [];
      while (i < lines.length) {
        buf.push(lines[i]);
        if (/<\/table>/i.test(lines[i])) break;
        i++;
      }
      html += sanitizeHtmlTable(buf.join("\n"));
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const table = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        table.push(lines[i++]);
      }
      i--;
      html += renderTable(table);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const level = Math.min(3, line.match(/^#+/)[0].length);
      html += `<h${level}>${escapeHtml(line.replace(/^#{1,6}\s+/, ""))}</h${level}>`;
    } else if (/^>\s?/.test(line)) {
      html += `<blockquote>${escapeHtml(line.replace(/^>\s?/, ""))}</blockquote>`;
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      html += `<p class="li">• ${escapeHtml(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))}</p>`;
    } else if (line.trim()) {
      html += `<p>${escapeHtml(line)}</p>`;
    } else {
      html += `<br />`;
    }
  }
  return html || `<div class="empty-state">-</div>`;
}

// HTML 표 블록: 표 구조 태그만 허용하고 나머지는 이스케이프 (스크립트 주입 방지).
function sanitizeHtmlTable(block) {
  const allowed = /^<\/?(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col|br)(\s[^<>]*)?\/?>$/i;
  return block.replace(/<[^<>]*>|[<>]/g, (tag) => {
    if (allowed.test(tag)) return tag.replace(/\son\w+="[^"]*"/gi, "");
    return escapeHtml(tag);
  });
}

function renderTable(lines) {
  const rows = lines
    .filter((line) => !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => escapeHtml(cell.trim())));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return `<table><thead><tr>${head.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function setBusy(busy) {
  document.body.style.cursor = busy ? "progress" : "";
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = busy;
  });
}

async function fetchJson(url, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(url, {
    headers: isForm ? options.headers || {} : { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
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

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  // 긴 메시지(연결 실패 사유 등)는 읽을 시간을 더 준다.
  const duration = Math.min(9000, 2400 + message.length * 40);
  toast.timer = setTimeout(() => els.toast.classList.remove("is-visible"), duration);
}

function formatTime(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(value) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  if (value > 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
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
