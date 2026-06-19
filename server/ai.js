// 교체 가능한 AI 프로바이더 추상화. provider/설정은 요청마다 resolveAiConfig 로 만들고
// withAiConfig() 로 감싸면 그 안의 aiComplete() 들이 그 설정을 쓴다(AsyncLocalStorage).
// 생략한 값은 .env 기본값. provider: vllm | openai | anthropic | bedrock | claude-cli | codex-cli | codex.

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

// 토큰 한도 잘림(finish_reason=length 등) 시 max_tokens 를 키워 재시도하는 상한.
const MAX_TOKENS_CAP = Number(process.env.AI_MAX_TOKENS_CAP || 8192);

// provider 별 응답에서 "출력이 토큰 한도에서 잘렸는가"를 판별 (OpenAI/vLLM · Anthropic · Gemini).
function isTruncated(json) {
  const reason =
    json?.choices?.[0]?.finish_reason ?? json?.stop_reason ?? json?.candidates?.[0]?.finishReason;
  return reason === "length" || reason === "max_tokens" || reason === "MAX_TOKENS";
}

export async function aiComplete({
  system,
  prompt,
  text,
  image,
  maxTokens = 512,
  temperature = 0.2,
  topP,
  presencePenalty,
  repetitionPenalty,
  frequencyPenalty,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const ai = currentAiConfig();
  const { provider: p, cfg } = ai;
  if (!p.enabled(cfg)) return "";
  // system 메시지는 vllm/openai(supportsSystem)만 별도 메시지로 보낸다 — 공통 지시문을 맨 앞에 둔다.
  // (지시문은 간결히 — prefix-cache 이득은 모델/서버 구성에 따라 다르므로 의존하지 말 것.)
  // 미지원 provider 는 기존 동작 보존을 위해 prompt 앞에 병합.
  let sys = system;
  let userPrompt = prompt;
  if (sys && !p.supportsSystem) {
    userPrompt = `${sys}\n\n${prompt}`;
    sys = undefined;
  }
  // 호출 통계 (aiConfig.stats 가 달려 있을 때만) — 변환 결과에 "AI 가 실제로 몇 번
  // 불렸는지/몇 번 실패했는지"를 남겨, 호출 0회·조용한 실패를 화면에서 식별 가능하게.
  if (ai.stats) ai.stats.calls++;
  try {
    if (p.complete) return await p.complete(cfg, { prompt: userPrompt, text, image, maxTokens, temperature, timeoutMs });
    // 잘림 감지 시 max_tokens 를 2배로 올려 1회 재시도. 빽빽한 페이지(통계표 등)에서
    // 출력 뒷부분이 조용히 유실되는 문제 방지 (CLI provider 는 finish_reason 이 없어 제외).
    let tokens = maxTokens;
    for (;;) {
      const req = p.build(cfg, {
        system: sys,
        prompt: userPrompt,
        text,
        image,
        maxTokens: tokens,
        temperature,
        topP,
        presencePenalty,
        repetitionPenalty,
        frequencyPenalty,
      });
      const json = await fetchJson(req, timeoutMs);
      if (isTruncated(json)) {
        const next = Math.min(tokens * 2, MAX_TOKENS_CAP);
        if (next > tokens) {
          console.warn(`[ai] 출력이 max_tokens=${tokens} 에서 잘림 — ${next} 로 재시도`);
          tokens = next;
          continue;
        }
        console.warn(`[ai] max_tokens=${tokens} (상한) 에서도 잘림 — 부분 출력 반환`);
      }
      return p.parse(json);
    }
  } catch (e) {
    if (ai.stats) ai.stats.failures++;
    throw e;
  }
}

export function aiEnabled(aiConfig) {
  const { provider: p, cfg } = aiConfig || currentAiConfig();
  return p.enabled(cfg);
}

// CLI 에이전트 provider(claude -p)의 이미지(vision) 호출은 매번 풀 에이전트를 cold-boot 하고
// 간헐적으로 타임아웃까지 행이 걸린다. 그래서 claude-cli 는 기본 '텍스트 전용'으로 동작한다 —
// kordoc 추출 + 표 텍스트 분석만 하고 OCR/reflow/이미지·차트 같은 vision 단계는 건너뛴다.
// 행을 감수하고 vision 을 켜려면 CLAUDE_CLI_VISION=1. (codex-cli 는 vision 이 느려도 동작하므로 on.)
// env 는 호출 시점에 읽는다(.env 가 import 이후 로드되므로 모듈 평가 시점에 읽으면 놓친다).
export function aiVisionEnabled(aiConfig) {
  const { id } = aiConfig || currentAiConfig();
  if (id === "claude-cli") return process.env.CLAUDE_CLI_VISION === "1";
  return true;
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

// 임의 aiConfig 로 연결 점검 — 자격증명/리전/모델 접근 문제를 변환 전에 드러낸다.
export async function aiPing(ai) {
  const { id, provider: p, cfg } = ai;
  if (!p.enabled(cfg)) return { ok: false, enabled: false, provider: id, error: `${id} provider 미설정` };
  try {
    // 문서 파서 엔진(MinerU 등)은 chat completer 가 아니라 자체 ping(/health)으로 점검한다.
    if (p.ping) return { ok: true, enabled: true, provider: id, ...(await p.ping(cfg)) };
    const text = await withAiConfig(ai, () =>
      aiComplete({ prompt: p.pingPrompt || "ping", maxTokens: 8, temperature: 0 })
    );
    return { ok: true, enabled: true, provider: id, text };
  } catch (e) {
    return { ok: false, enabled: true, provider: id, error: formatAiError(e) };
  }
}

export async function aiCheck() {
  return aiPing(resolveAiConfig());
}

export function formatAiError(e) {
  const parts = [];
  if (e?.name) parts.push(e.name);
  if (e?.message) parts.push(e.message);
  if (e?.cause?.code) parts.push(`cause=${e.cause.code}`);
  if (e?.cause?.message) parts.push(`causeMessage=${e.cause.message}`);
  return parts.join(" | ") || String(e);
}

// 재시도 가치가 있는 실패만 재시도: 429/5xx/네트워크/타임아웃. 그 외 4xx(잘못된 요청,
// 컨텍스트 초과 등)는 같은 요청을 다시 보내도 똑같이 실패하므로 즉시 던진다.
function isRetryable(e) {
  if (e?.status != null) return e.status === 429 || e.status >= 500;
  return true; // status 없음 = 네트워크/abort(타임아웃) 계열
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
        const err = new Error(`HTTP ${resp.status} ${detail.slice(0, 200)}`);
        err.status = resp.status;
        const ra = Number(resp.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
        throw err;
      }
      return await resp.json();
    } catch (e) {
      lastError = e;
      if (attempt >= RETRIES || !isRetryable(e)) break;
      // 지수 백오프 + 지터 (Retry-After 가 있으면 그 값을 우선)
      const backoff = e?.retryAfterMs ?? 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoff));
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
  const PRIORITY = /^(VLLM_|AI_|OPENAI_|ANTHROPIC_|GEMINI_|BEDROCK_|AWS_|CODEX_|CLAUDE_)/;
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
