// AI 프로바이더 정의 (HTTP=build/parse, CLI=complete). ai.js 가 PROVIDERS/별칭으로 사용.
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function openaiChatParse(json) {
  return json?.choices?.[0]?.message?.content?.trim() || "";
}

// 로컬 vLLM (OpenAI 호환). thinking 켜면 사고 토큰이 답을 다 먹어 비므로 기본 OFF.
const vllmProvider = {
  id: "vllm",
  fields: ["url", "model", "thinking"],
  defaults: () => ({
    url: process.env.VLLM_URL || "",
    model: process.env.VLLM_MODEL || "qwen",
    thinking: process.env.VLLM_THINKING === "1",
  }),
  enabled: (cfg) => !!cfg.url && process.env.VLLM_DISABLED !== "1",
  info: (cfg) => ({ url: cfg.url, model: cfg.model, thinking: !!cfg.thinking }),
  build(cfg, { prompt, text, image, maxTokens, temperature }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    return {
      url: cfg.url,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
        temperature,
        chat_template_kwargs: { enable_thinking: !!cfg.thinking },
      }),
    };
  },
  parse: openaiChatParse,
  pingPrompt: "ping 이라고만 답하세요.",
};

const openaiProvider = {
  id: "openai",
  fields: ["api_key", "model", "base_url"],
  defaults: () => ({
    base_url: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    api_key: process.env.OPENAI_API_KEY || "",
  }),
  enabled: (cfg) => !!cfg.api_key,
  info: (cfg) => ({ url: cfg.base_url, model: cfg.model }),
  build(cfg, { prompt, text, image, maxTokens, temperature }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    return {
      url: cfg.base_url,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
        temperature,
      }),
    };
  },
  parse: openaiChatParse,
  pingPrompt: "Reply with the single word: ping",
};

// Google Gemini — OpenAI 호환 엔드포인트(Bearer + image_url). 키는 GEMINI_API_KEY.
const geminiProvider = {
  id: "gemini",
  fields: ["api_key", "model", "base_url"],
  defaults: () => ({
    base_url: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    api_key: process.env.GEMINI_API_KEY || "",
  }),
  enabled: (cfg) => !!cfg.api_key,
  info: (cfg) => ({ url: cfg.base_url, model: cfg.model }),
  build(cfg, { prompt, text, image, maxTokens, temperature }) {
    const content = [{ type: "text", text: prompt }];
    if (text) content.push({ type: "text", text });
    if (image) content.push({ type: "image_url", image_url: { url: image } });
    return {
      url: cfg.base_url,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content }],
        max_tokens: maxTokens,
        temperature,
      }),
    };
  },
  parse: openaiChatParse,
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
  gemini: geminiProvider,
  codex: codexProvider,
  "claude-cli": claudeCliProvider,
  "codex-cli": codexCliProvider,
};

export const PROVIDER_ALIASES = { claude_cli: "claude-cli", codex_cli: "codex-cli" };

export const PROVIDER_CHOICES = ["vllm", "openai", "anthropic", "gemini", "claude_cli", "codex_cli"];
