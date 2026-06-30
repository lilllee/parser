// AI 프로바이더 정의 (HTTP=build/parse, CLI=complete). ai.js 가 PROVIDERS/별칭으로 사용.
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { paddleParseFile, paddleHealth } from "./paddle.js";

function openaiChatParse(json) {
  const msg = json?.choices?.[0]?.message;
  // reasoning 모델(Qwen3.6 등)은 enable_thinking=false 면 답이 content 로 나온다. 다만 일부
  // 템플릿/서버 설정에선 content 가 비고 reasoning_content 로만 채워질 수 있어, content 가
  // 비었을 때만 reasoning_content 로 방어적 폴백(정상 경로에선 reasoning_content 는 비어 무해).
  return msg?.content?.trim() || msg?.reasoning_content?.trim() || "";
}

// 로컬 vLLM (OpenAI 호환). thinking 켜면 사고 토큰이 답을 다 먹어 비므로 기본 OFF.
// system 메시지 지원: OCR 공통 지시문을 맨 앞 system 으로 보낸다. system 지시문은 '간결하게' 유지할 것
// (prefix-cache 이득은 모델/서버 구성에 따라 다르므로 의존하지 말고, 묶음 요청이 prefill 절감의 확실한 수단).
// 샘플링 파라미터(topP 등)는 명시된 것만 body 에 포함 — 명시한 값은 서버의
// override-generation-config 기본값을 덮어쓴다. (OCR 은 frequency_penalty 등으로 반복
// 붕괴를 막으면서 표의 정상 반복은 허용 — OCR_SAMPLING in vllm.js 참고.)
const vllmProvider = {
  id: "vllm",
  fields: ["url", "model", "thinking"],
  supportsSystem: true,
  defaults: () => ({
    url: process.env.VLLM_URL || "",
    model: process.env.VLLM_MODEL || "qwen/qwen3.6-27b", // 서버 A /v1/models 실제 id 와 일치 필요(틀리면 404)
    thinking: process.env.VLLM_THINKING === "1",
  }),
  enabled: (cfg) => !!cfg.url && process.env.VLLM_DISABLED !== "1",
  info: (cfg) => ({ url: cfg.url, model: cfg.model, thinking: !!cfg.thinking }),
  build(cfg, { system, prompt, text, image, maxTokens, temperature, topP, presencePenalty, repetitionPenalty, frequencyPenalty }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content });
    const body = {
      model: cfg.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      chat_template_kwargs: { enable_thinking: !!cfg.thinking },
    };
    if (topP != null) body.top_p = topP;
    if (presencePenalty != null) body.presence_penalty = presencePenalty;
    if (repetitionPenalty != null) body.repetition_penalty = repetitionPenalty;
    if (frequencyPenalty != null) body.frequency_penalty = frequencyPenalty;
    return {
      url: cfg.url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  },
  parse: openaiChatParse,
  pingPrompt: "ping 이라고만 답하세요.",
};

const openaiProvider = {
  id: "openai",
  fields: ["api_key", "model", "base_url"],
  supportsSystem: true,
  defaults: () => ({
    base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    api_key: process.env.OPENAI_API_KEY || "",
  }),
  enabled: (cfg) => !!cfg.api_key,
  info: (cfg) => ({ url: cfg.base_url, model: cfg.model }),
  build(cfg, { system, prompt, text, image, maxTokens, temperature, topP, presencePenalty }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content });
    const body = {
      model: cfg.model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (topP != null) body.top_p = topP;
    if (presencePenalty != null) body.presence_penalty = presencePenalty;
    return {
      url: cfg.base_url,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify(body),
    };
  },
  parse: openaiChatParse,
  pingPrompt: "Reply with the single word: ping",
};

function geminiParse(json) {
  return (json?.candidates?.[0]?.content?.parts || [])
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
}

function geminiGenerateUrl(baseUrl, model) {
  const base = String(baseUrl || "https://generativelanguage.googleapis.com/v1beta")
    .replace(/\/openai\/chat\/completions\/?$/, "")
    .replace(/\/$/, "");
  if (base.includes(":generateContent")) return base;
  return `${base}/models/${encodeURIComponent(model)}:generateContent`;
}

// Google Gemini native generateContent API. 키는 GEMINI_API_KEY 또는 요청 api_key.
const geminiProvider = {
  id: "gemini",
  fields: ["api_key", "model", "base_url"],
  defaults: () => ({
    base_url: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    model: process.env.GEMINI_MODEL || "gemini-3.5-flash",
    api_key: process.env.GEMINI_API_KEY || "",
  }),
  enabled: (cfg) => !!cfg.api_key,
  info: (cfg) => ({ url: geminiGenerateUrl(cfg.base_url, cfg.model), model: cfg.model }),
  build(cfg, { prompt, text, image, maxTokens, temperature }) {
    const parts = [{ text: text ? `${prompt}\n\n${text}` : prompt }];
    if (image) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
    return {
      url: geminiGenerateUrl(cfg.base_url, cfg.model),
      headers: { "Content-Type": "application/json", "X-goog-api-key": cfg.api_key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature,
        },
      }),
    };
  },
  parse: geminiParse,
  pingPrompt: "Reply with the single word: ping",
};

// 로컬 codex 프록시 (OpenAI 호환 HTTP, gpt-5.5). CLI 와 별개.
const codexProvider = {
  id: "codex",
  fields: ["url", "model"],
  defaults: () => ({
    url: process.env.CODEX_HTTP_URL || "http://127.0.0.1:10531/v1/chat/completions",
    model: process.env.CODEX_HTTP_MODEL || "gpt-5.5",
  }),
  enabled: (cfg) => !!cfg.url,
  info: (cfg) => ({ url: cfg.url, model: cfg.model }),
  build(cfg, { prompt, text, image }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    return {
      url: cfg.url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content }] }),
    };
  },
  parse: openaiChatParse,
  pingPrompt: "Reply with the single word: ping",
};

const anthropicProvider = {
  id: "anthropic",
  fields: ["api_key", "model", "base_url", "version"],
  defaults: () => ({
    base_url: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1/messages",
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
    api_key: process.env.ANTHROPIC_API_KEY || "",
    version: process.env.ANTHROPIC_VERSION || "2023-06-01",
  }),
  enabled: (cfg) => !!cfg.api_key,
  info: (cfg) => ({ url: cfg.base_url, model: cfg.model }),
  build(cfg, { prompt, text, image, maxTokens, temperature }) {
    const content = [];
    if (image) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
      if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
    content.push({ type: "text", text: text ? `${prompt}\n\n${text}` : prompt });
    return {
      url: cfg.base_url,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cfg.api_key,
        "anthropic-version": cfg.version,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: "user", content }],
      }),
    };
  },
  parse(json) {
    return (json?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  },
  pingPrompt: "Reply with the single word: ping",
};

const BEDROCK_DEFAULT_MODEL = "anthropic.claude-3-5-sonnet-20241022-v2:0";

function bedrockCredentials(cfg) {
  if (cfg.access_key_id && cfg.secret_access_key) {
    return {
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
      ...(cfg.session_token ? { sessionToken: cfg.session_token } : {}),
    };
  }
  return cfg.profile ? fromIni({ profile: cfg.profile }) : undefined;
}

function bedrockImageBlock(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  const format = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/jpg": "jpeg",
    "image/webp": "webp",
    "image/gif": "gif",
  }[m[1].toLowerCase()];
  if (!format) throw new Error(`Bedrock Converse image 미지원 mime: ${m[1]}`);
  return { format, source: { bytes: Buffer.from(m[2], "base64") } };
}

function parseBedrockConverse(out) {
  return (out?.output?.message?.content || [])
    .filter((b) => typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

const bedrockProvider = {
  id: "bedrock",
  fields: ["region", "model", "profile", "access_key_id", "secret_access_key", "session_token"],
  defaults: () => ({
    region: process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1",
    model: process.env.BEDROCK_MODEL || BEDROCK_DEFAULT_MODEL,
    profile: process.env.BEDROCK_PROFILE || process.env.AWS_PROFILE || "",
    access_key_id: process.env.BEDROCK_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
    secret_access_key: process.env.BEDROCK_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
    session_token: process.env.BEDROCK_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN || "",
  }),
  enabled: (cfg) => !!cfg.model && process.env.BEDROCK_DISABLED !== "1",
  info: (cfg) => ({
    region: cfg.region,
    model: cfg.model,
    profile: cfg.profile || undefined,
    credentials: cfg.access_key_id ? "explicit" : cfg.profile ? "profile" : "default-chain",
  }),
  async complete(cfg, { prompt, text, image, maxTokens, temperature, timeoutMs }) {
    const client = new BedrockRuntimeClient({
      region: cfg.region,
      credentials: bedrockCredentials(cfg),
    });
    const content = [];
    if (image) {
      const imageBlock = bedrockImageBlock(image);
      if (imageBlock) content.push({ image: imageBlock });
    }
    content.push({ text: text ? `${prompt}\n\n${text}` : prompt });

    const command = new ConverseCommand({
      modelId: cfg.model,
      messages: [{ role: "user", content }],
      inferenceConfig: {
        maxTokens,
        temperature,
      },
    });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const out = await client.send(command, { abortSignal: ac.signal });
      return parseBedrockConverse(out);
    } finally {
      clearTimeout(timer);
    }
  },
  pingPrompt: "Reply with the single word: ping",
};

// Claude Max(claude -p CLI) — HTTP 아닌 spawn. Windows 는 .cmd shim 이 ENOENT 라 claude.exe 직접 실행.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === "win32") {
    const sub = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";
    const candidates = [
      process.env.npm_config_prefix && join(process.env.npm_config_prefix, sub),
      process.env.APPDATA && join(process.env.APPDATA, "npm", sub),
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch { /* ignore */ }
    }
  }
  return "claude";
}

function runClaude(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude cli timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code !== 0 ? reject(new Error(formatClaudeExit(code, out, err))) : resolve(out);
    });
  });
}

function formatClaudeExit(code, out, err) {
  const parts = [];
  const stdout = String(out || "").trim();
  const stderr = String(err || "").trim();
  if (stdout) {
    try {
      const json = JSON.parse(stdout);
      const msg = [
        json.result,
        json.api_error_status,
        json.subtype,
        json.terminal_reason,
        json.stop_reason,
      ].filter(Boolean).join(" | ");
      if (msg) parts.push(msg);
    } catch {
      parts.push(stdout);
    }
  }
  if (stderr) parts.push(stderr);
  const detail = parts.join(" | ").replace(/\s+/g, " ").slice(0, 600);
  return `claude exited ${code}${detail ? `: ${detail}` : ""}`;
}

const claudeCliProvider = {
  id: "claude-cli",
  fields: ["model"],
  defaults: () => ({
    model: process.env.CLAUDE_CLI_MODEL || "sonnet",
    timeout_ms: Number(process.env.CLAUDE_CLI_TIMEOUT_MS || 120_000),
  }),
  enabled: () => process.env.CLAUDE_CLI_DISABLED !== "1",
  info: (cfg) => ({ bin: resolveClaudeBin(), model: cfg.model }),
  async complete(cfg, { prompt, text, image, timeoutMs }) {
    const dir = mkdtempSync(join(tmpdir(), "claude-ocr-"));
    let imgPath = null;
    let promptText = text ? `${prompt}\n\n${text}` : prompt;
    try {
      if (image) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
        if (m) {
          const ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
          imgPath = join(dir, `page.${ext}`);
          writeFileSync(imgPath, Buffer.from(m[2], "base64"));
          promptText = `Read the image at ${imgPath} and ${prompt}`;
        }
      }
      // --strict-mcp-config: 사용자 개인 MCP 서버(Gmail/Drive/Figma 등)를 0개만 로딩.
      // 안 붙이면 매 OCR 호출마다 원격 MCP 전부에 연결을 시도해 startup 이 수초~행으로 늘어난다
      // (인증 필요한 서버는 timeout 까지 블록 → "호출 자체가 안 되는" 것처럼 보임). OCR 은 MCP 불필요.
      const args = ["-p", promptText, "--model", cfg.model,
        "--output-format", "json", "--permission-mode", "bypassPermissions",
        "--strict-mcp-config"];
      if (imgPath) args.push("--allowedTools", "Read");
      // OCR 경로는 timeoutMs=240s(vLLM 기준)를 넘겨오지만, claude -p 는 매 호출이 에이전트를
      // cold-boot 하는 데다 간헐적으로 행이 걸려 한 호출이 240s 를 다 태우면 4분간 멈춘 것처럼
      // 보인다. claude 전용 상한(cfg.timeout_ms, 기본 120s)으로 클램프 — 정상 페이지 OCR 은
      // ~36s 라 120s 면 충분하고, 행은 절반 시간에 끊어 사용자 대기를 줄인다.
      const limitMs = Math.min(timeoutMs || cfg.timeout_ms, cfg.timeout_ms);
      const stdout = await runClaude(resolveClaudeBin(), args, limitMs);
      const json = JSON.parse(stdout);
      if (json.is_error) throw new Error(json.result || "claude cli error");
      return (json.result || "").trim();
    } finally {
      try { if (imgPath) unlinkSync(imgPath); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
  pingPrompt: "Reply with the single word: ping",
};

// Codex CLI(codex exec, ChatGPT Pro). 프롬프트는 stdin 으로(−i 가 위치인자 삼킴), 결과는 -o 파일.
// Windows 는 `node codex.js` 라 node + codex.js 직접 실행.
function resolveCodexExec() {
  if (process.env.CODEX_BIN) return { cmd: process.env.CODEX_BIN, prefix: [] };
  if (process.platform === "win32") {
    const sub = "node_modules/@openai/codex/bin/codex.js";
    const candidates = [
      process.env.npm_config_prefix && join(process.env.npm_config_prefix, sub),
      process.env.APPDATA && join(process.env.APPDATA, "npm", sub),
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (existsSync(c)) return { cmd: process.execPath, prefix: [c] }; } catch { /* ignore */ }
    }
  }
  return { cmd: "codex", prefix: [] };
}

function runCodex(cmd, args, promptText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      code !== 0 ? reject(new Error(`codex exited ${code}: ${err.slice(0, 300)}`)) : resolve(out);
    });
    child.stdin.write(promptText);
    child.stdin.end();
  });
}

const codexCliProvider = {
  id: "codex-cli",
  fields: ["model"],
  defaults: () => ({
    model: process.env.CODEX_MODEL || "",
    timeout_ms: Number(process.env.CODEX_TIMEOUT_MS || 120_000),
  }),
  enabled: () => process.env.CODEX_DISABLED !== "1",
  info: (cfg) => {
    const { cmd, prefix } = resolveCodexExec();
    return { bin: prefix[0] || cmd, model: cfg.model || "(config default)" };
  },
  async complete(cfg, { prompt, text, image, timeoutMs }) {
    const dir = mkdtempSync(join(tmpdir(), "codex-ocr-"));
    const outPath = join(dir, "out.txt");
    const promptText = text ? `${prompt}\n\n${text}` : prompt;
    try {
      const { cmd, prefix } = resolveCodexExec();
      const args = [...prefix, "exec", "-o", outPath,
        "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];
      if (cfg.model) args.push("-m", cfg.model);
      if (image) {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(image);
        if (m) {
          const ext = (m[1].split("/")[1] || "png").replace(/[^a-z0-9]/gi, "");
          const imgPath = join(dir, `page.${ext}`);
          writeFileSync(imgPath, Buffer.from(m[2], "base64"));
          args.push("-i", imgPath);
        }
      }
      await runCodex(cmd, args, promptText, timeoutMs || cfg.timeout_ms);
      return readFileSync(outPath, "utf-8").trim();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
  pingPrompt: "Reply with the single word: ping",
};

// MinerU 문서 파싱 REST API. OpenAI 호환 chat 이 아니라 — 파일을 multipart 로 통째 업로드하면
// 서버 파이프라인(레이아웃+OCR+표+읽기순서)이 한 번에 markdown 으로 변환한다. 그래서 페이지 단위
// build/parse/complete 대신 '파일 단위' parseDocument 를 쓰고(kind:"document-parser"), convert.js 가
// 이 엔진을 만나면 kordoc/reflow/enrich 파이프라인을 통째 우회한다. (HWP/HWPX 는 MinerU 가 못 먹으니
// PDF·이미지·DOCX 위주 — 그 외 포맷은 기존 vllm 파이프라인을 쓸 것.)
function mineruEndpoint(url, path) {
  // 사용자가 base(http://host:8000) 또는 풀 경로(.../file_parse)를 넣을 수 있으니 정규화.
  const root = String(url || "").replace(/\/+$/, "").replace(/\/file_parse$/, "");
  return `${root}${path}`;
}

const MINERU_FILE_MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function mineruMime(filename) {
  const ext = String(filename || "").split(".").pop().toLowerCase();
  return MINERU_FILE_MIME[ext] || "application/octet-stream";
}

const MINERU_IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]);
function isMineruImage(filename) {
  return MINERU_IMAGE_EXT.has(String(filename || "").split(".").pop().toLowerCase());
}

// MinerU 는 백엔드가 둘이고 OCR 특성이 정반대다(서버 가이드 MINERU_API.md):
//  · hybrid-engine(VLM, :8000) — 복잡한 표/다단/수식엔 강하나 '스타일·장식 폰트' 이미지에서
//    글자 깨짐·한→일 언어 드리프트·환각·`#/##` 오삽입(고질병). lang_list 거의 무시.
//  · pipeline(PaddleOCR 계열, :8002) — lang_list=korean 이 실제 적용돼 한글 전사가 정확. 포스터/
//    배너/장식 폰트에 강함. 복잡한 표/레이아웃은 약함.
// 그래서 파일·설정으로 (backend, baseUrl)을 라우팅한다. auto: 이미지=pipeline, 그 외(PDF/DOCX)=hybrid.
// (export 는 단위 테스트용 — 네트워크 없이 라우팅만 검증.)
export function mineruRoute(filename, cfg) {
  let backend = cfg.backend || "auto";
  if (backend === "auto") backend = isMineruImage(filename) ? "pipeline" : "hybrid-engine";
  let base = backend === "pipeline" ? cfg.pipeline_url : cfg.url;
  // 원하는 백엔드의 서버 URL 이 비어 있으면, 설정된 다른 서버로 폴백하고 backend 도 그에 맞춘다
  // (pipeline 백엔드를 hybrid 서버로 보내면 CUDA error 로 죽으므로 backend 값을 서버와 일치시킨다).
  if (!base) {
    base = cfg.url || cfg.pipeline_url;
    backend = base && base === cfg.pipeline_url ? "pipeline" : "hybrid-engine";
  }
  return { backend, base };
}

const mineruProvider = {
  id: "mineru",
  kind: "document-parser", // 페이지 단위 completer 가 아니라 파일 단위 파서 — convert 가 파이프라인 우회.
  fields: ["url", "pipeline_url", "backend", "lang", "parse_method", "effort", "table", "formula", "image_analysis", "postprocess", "timeout_ms"],
  defaults: () => ({
    url: process.env.MINERU_URL || "",                     // hybrid-engine(VLM, :8000) — 복잡 표/다단/PDF
    pipeline_url: process.env.MINERU_PIPELINE_URL || "",   // pipeline(PaddleOCR, :8002) — 이미지/포스터/한글 정확
    backend: process.env.MINERU_BACKEND || "auto",         // auto | hybrid-engine | pipeline
    lang: process.env.MINERU_LANG || "korean",
    parse_method: process.env.MINERU_PARSE_METHOD || "auto",
    effort: process.env.MINERU_EFFORT || "",               // ""(미전송) | low | medium | high
    table: process.env.MINERU_TABLE !== "0",
    formula: process.env.MINERU_FORMULA !== "0",
    image_analysis: process.env.MINERU_IMAGE_ANALYSIS === "1",
    // 육안 점검 기본은 MinerU '원본' md 그대로 — 우리 postprocess 를 끼우면 비교가 흐려진다. 1 로 켜면 적용.
    postprocess: process.env.MINERU_POSTPROCESS === "1",
    timeout_ms: Number(process.env.MINERU_TIMEOUT_MS || 600_000),
  }),
  enabled: (cfg) => !!(cfg.url || cfg.pipeline_url) && process.env.MINERU_DISABLED !== "1",
  info: (cfg) => ({
    hybrid: cfg.url ? mineruEndpoint(cfg.url, "/file_parse") : null,
    pipeline: cfg.pipeline_url ? mineruEndpoint(cfg.pipeline_url, "/file_parse") : null,
    backend: cfg.backend,
    lang: cfg.lang,
  }),
  // chat completer 가 아니므로 aiPing 은 /health 로 점검한다(아래 ai.js 가 provider.ping 우선 사용).
  async ping(cfg) {
    const url = mineruEndpoint(cfg.url || cfg.pipeline_url, "/health");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      const resp = await fetch(url, { signal: ac.signal });
      if (!resp.ok) throw new Error(`MinerU /health HTTP ${resp.status}`);
      return { text: "healthy", url };
    } finally {
      clearTimeout(timer);
    }
  },
  // 파일 통째 업로드 → { markdown, pageCount, metadata }. convert.js 의 documentParserConvert 가 호출.
  async parseDocument(cfg, { buffer, filename, onPhase = () => {} }) {
    // 이미지=pipeline(:8002, 한글 정확) / PDF·DOCX=hybrid-engine(:8000, 복잡 표) 로 라우팅.
    const { backend, base } = mineruRoute(filename, cfg);
    if (!base) throw new Error("MinerU URL 미설정 (MINERU_URL / MINERU_PIPELINE_URL)");
    const url = mineruEndpoint(base, "/file_parse");
    const form = new FormData();
    form.append("files", new Blob([buffer], { type: mineruMime(filename) }), filename || "document.pdf");
    form.append("backend", backend);
    form.append("lang_list", cfg.lang);
    form.append("parse_method", cfg.parse_method);
    if (cfg.effort) form.append("effort", cfg.effort);
    form.append("table_enable", String(!!cfg.table));
    form.append("formula_enable", String(!!cfg.formula));
    form.append("image_analysis", String(!!cfg.image_analysis));
    form.append("return_md", "true");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeout_ms);
    let resp;
    try {
      onPhase({ phase: "parse", message: `MinerU(${backend}) 업로드 → ${url}` });
      resp = await fetch(url, { method: "POST", body: form, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      const err = new Error(`MinerU HTTP ${resp.status} ${detail.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    if (data.status && data.status !== "completed") {
      throw new Error(`MinerU 파싱 실패: status=${data.status} error=${data.error || ""}`);
    }
    const fname = data.file_names?.[0];
    const md = (fname && data.results?.[fname]?.md_content) || data.md_content || "";
    if (!md) throw new Error("MinerU 응답에 md_content 가 없음");
    return {
      markdown: md,
      pageCount: null,
      metadata: { source: "mineru", backend: data.backend || backend, version: data.version, file: fname },
    };
  },
  pingPrompt: "health",
};

// PaddleOCR-VL doc-parser(/api/v1/parse @ :8500) — 파일 통째 업로드 → 레이아웃+HTML표+bbox 구조화 md.
// MinerU 와 같은 document-parser(파일 단위) — convert 가 만나면 kordoc/reflow/enrich 파이프라인 우회.
// (reflow 경로의 페이지 단위 결선은 vllm.js paddleReflowPage + OCR_BACKEND=paddle 가 담당 — 별개.)
const paddleParseProvider = {
  id: "paddle-parse",
  kind: "document-parser",
  fields: ["url", "timeout_ms"],
  defaults: () => ({
    url: process.env.PADDLE_PARSE_URL || "",
    timeout_ms: Number(process.env.PADDLE_PARSE_TIMEOUT_MS || 600_000),
  }),
  enabled: (cfg) => !!cfg.url && process.env.PADDLE_DISABLED !== "1",
  info: (cfg) => ({ url: cfg.url }),
  async ping(cfg) {
    await paddleHealth(cfg.url);
    return { text: "healthy", url: cfg.url };
  },
  async parseDocument(cfg, { buffer, filename, onPhase = () => {} }) {
    onPhase({ phase: "parse", message: `PaddleOCR-VL /parse → ${cfg.url}` });
    const r = await paddleParseFile(buffer, filename, undefined, { url: cfg.url, timeoutMs: cfg.timeout_ms });
    if (!r.markdown) throw new Error("Paddle /parse 응답에 markdown 이 없음");
    return { markdown: r.markdown, pageCount: r.pageCount, metadata: { source: "paddle-parse", pages: r.pages?.length } };
  },
  pingPrompt: "health",
};

export const PROVIDERS = {
  vllm: vllmProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  bedrock: bedrockProvider,
  gemini: geminiProvider,
  codex: codexProvider,
  "claude-cli": claudeCliProvider,
  "codex-cli": codexCliProvider,
  mineru: mineruProvider,
  "paddle-parse": paddleParseProvider,
};

export const PROVIDER_ALIASES = { claude_cli: "claude-cli", codex_cli: "codex-cli", paddle_parse: "paddle-parse", paddle: "paddle-parse" };

export const PROVIDER_CHOICES = ["vllm", "openai", "anthropic", "gemini", "bedrock", "claude_cli", "codex_cli", "mineru", "paddle_parse"];
