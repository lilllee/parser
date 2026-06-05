// 교체 가능한 AI 프로바이더 추상화. provider/설정은 요청마다 resolveAiConfig 로 만들고
// withAiConfig() 로 감싸면 그 안의 aiComplete() 들이 그 설정을 쓴다(AsyncLocalStorage).
// 생략한 값은 .env 기본값. provider: vllm | openai | anthropic | claude-cli | codex-cli | codex.

import { existsSync, readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { PROVIDERS, PROVIDER_ALIASES, PROVIDER_CHOICES } from "./providers.js";

const LOADED_ENV_FILES = loadLocalEnv();

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 60_000);
const RETRIES = Number(process.env.AI_RETRY ?? 1);


// 요청 overrides 를 .env 기본값 위에 병합해 { id, provider, cfg } 로 해석. 모르는 provider 면 throw.
export function resolveAiConfig(overrides = {}) {
  const raw =
    overrides.provider != null && String(overrides.provider).trim() !== ""
      ? String(overrides.provider).trim()
      : process.env.AI_PROVIDER || "vllm";
  const id = PROVIDER_ALIASES[raw] || raw;
  const p = PROVIDERS[id];
  if (!p) {
    const err = new Error(`알 수 없는 provider: "${raw}" (가능: ${PROVIDER_CHOICES.join(", ")})`);
    err.code = "BAD_PROVIDER";
    throw err;
  }
  const cfg = { ...p.defaults() };
  for (const f of p.fields || []) {
    const v = overrides[f];
    if (v === undefined || v === null || v === "") continue;
    const def = cfg[f];
    cfg[f] =
      typeof def === "boolean"
        ? v === true || v === "true" || v === "1" || v === "on"
        : typeof def === "number"
          ? Number(v)
          : String(v);
  }
  return { id, provider: p, cfg };
}

const aiStore = new AsyncLocalStorage();

export function withAiConfig(aiConfig, fn) {
  return aiStore.run(aiConfig, fn);
}
function currentAiConfig() {
  return aiStore.getStore() || resolveAiConfig();
}

export async function aiComplete({
  prompt,
  text,
  image,
  maxTokens = 512,
  temperature = 0.2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const { provider: p, cfg } = currentAiConfig();
  if (!p.enabled(cfg)) return "";
  if (p.complete) return p.complete(cfg, { prompt, text, image, maxTokens, temperature, timeoutMs });
  const req = p.build(cfg, { prompt, text, image, maxTokens, temperature });
  const json = await fetchJson(req, timeoutMs);
  return p.parse(json);
}

export function aiEnabled(aiConfig) {
  const { provider: p, cfg } = aiConfig || currentAiConfig();
  return p.enabled(cfg);
}

// 실제 전송 없이 provider 의 HTTP 요청 객체만 생성(테스트용).
export function buildRequest({ providerId, prompt, text, image, maxTokens = 512, temperature = 0.2 }) {
  const id = PROVIDER_ALIASES[providerId] || providerId || process.env.AI_PROVIDER || "vllm";
  const p = PROVIDERS[id] || PROVIDERS.vllm;
  return p.build(p.defaults(), { prompt, text, image, maxTokens, temperature });
}

export const PROVIDER_IDS = Object.keys(PROVIDERS);

export const aiInfo = (() => {
  const { id, provider: p, cfg } = resolveAiConfig();
  return { provider: id, enabled: p.enabled(cfg), ...p.info(cfg), envFiles: LOADED_ENV_FILES };
})();
export const AI_ENABLED = aiInfo.enabled;

export async function aiCheck() {
  const ai = resolveAiConfig();
  const { id, provider: p, cfg } = ai;
  if (!p.enabled(cfg)) return { ok: false, enabled: false, provider: id, error: `${id} provider 미설정` };
  try {
    const text = await withAiConfig(ai, () =>
      aiComplete({ prompt: p.pingPrompt || "ping", maxTokens: 8, temperature: 0 })
    );
    return { ok: true, enabled: true, provider: id, text };
  } catch (e) {
    return { ok: false, enabled: true, provider: id, error: formatAiError(e) };
  }
}

export function formatAiError(e) {
  const parts = [];
  if (e?.name) parts.push(e.name);
  if (e?.message) parts.push(e.message);
  if (e?.cause?.code) parts.push(`cause=${e.cause.code}`);
  if (e?.cause?.message) parts.push(`causeMessage=${e.cause.message}`);
  return parts.join(" | ") || String(e);
}

async function fetchJson(req, timeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: ac.signal,
      });
      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 200)}`);
      }
      return await resp.json();
    } catch (e) {
      lastError = e;
      if (attempt >= RETRIES) break;
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function loadLocalEnv() {
  const files = [process.env.VLLM_ENV_FILE, ".env.local", ".env"].filter(Boolean);
  const loaded = [];
  // AI 설정 키는 로컬 .env 값을 우선 적용(개발 편의). 그 외 키는 기존 env 보존.
  const PRIORITY = /^(VLLM_|AI_|OPENAI_|ANTHROPIC_|GEMINI_|CODEX_|CLAUDE_)/;
  for (const file of files) {
    if (!existsSync(file)) continue;
    loaded.push(file);
    const text = readFileSync(file, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (!PRIORITY.test(key) && process.env[key] !== undefined) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
  return loaded;
}
