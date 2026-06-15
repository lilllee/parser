// AI 프로바이더 정의 (HTTP=build/parse, CLI=complete). ai.js 가 PROVIDERS/별칭으로 사용.
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";

function openaiChatParse(json) {
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

// 로컬 vLLM (OpenAI 호환). thinking 켜면 사고 토큰이 답을 다 먹어 비므로 기본 OFF.
// system 메시지 지원: OCR 공통 지시문을 byte 동일하게 맨 앞에 보내 prefix cache 를 살린다.
// 샘플링 파라미터(topP 등)는 명시된 것만 body 에 포함 — 명시한 값은 서버의
// override-generation-config 기본값을 덮어쓴다. (OCR 은 frequency_penalty 등으로 반복
// 붕괴를 막으면서 표의 정상 반복은 허용 — OCR_SAMPLING in vllm.js 참고.)
const vllmProvider = {
  id: "vllm",
  fields: ["url", "model", "thinking"],
  supportsSystem: true,
  defaults: () => ({
    url: process.env.VLLM_URL || "",
    model: process.env.VLLM_MODEL || "qwen",
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
      code !== 0 ? reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)) : resolve(out);
    });
  });
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
      const args = ["-p", promptText, "--model", cfg.model,
        "--output-format", "json", "--permission-mode", "bypassPermissions"];
      if (imgPath) args.push("--allowedTools", "Read");
      const stdout = await runClaude(resolveClaudeBin(), args, timeoutMs || cfg.timeout_ms);
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

export const PROVIDERS = {
  vllm: vllmProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  bedrock: bedrockProvider,
  gemini: geminiProvider,
  codex: codexProvider,
  "claude-cli": claudeCliProvider,
  "codex-cli": codexCliProvider,
};

export const PROVIDER_ALIASES = { claude_cli: "claude-cli", codex_cli: "codex-cli" };

export const PROVIDER_CHOICES = ["vllm", "openai", "anthropic", "gemini", "bedrock", "claude_cli", "codex_cli"];
