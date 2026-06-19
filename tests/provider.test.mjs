// AI 프로바이더 추상화 회귀 테스트 (외부 API 호출 없음 — 요청 포맷만 검증)
// 확장성 보장: vllm/openai/anthropic 로 전환 시 각 API 포맷이 올바른지 단언.
import { buildRequest, PROVIDER_IDS, resolveAiConfig } from "../server/ai.js";
import { mineruRoute } from "../server/providers.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

const PNG = "data:image/png;base64,AAAABBBBCCCC";
const opts = { prompt: "이 표를 설명", text: "| a | b |", image: PNG, maxTokens: 300, temperature: 0 };

console.log("\n[등록된 프로바이더]");
ok(["vllm", "openai", "anthropic", "gemini", "bedrock", "claude-cli", "codex-cli"].every((id) => PROVIDER_IDS.includes(id)),
  `vllm/openai/anthropic/gemini/bedrock/claude-cli/codex-cli 등록됨: ${PROVIDER_IDS.join(",")}`);
// claude-cli·codex-cli 는 HTTP 가 아니라 complete() 방식 → buildRequest(build) 대상 아님.
// 실제 spawn OCR 동작은 e2e 로 별도 검증(Pro/Max 쿼터·속도 때문에 npm test 미포함).

console.log("\n[vllm] OpenAI 호환 + 이미지 image_url + thinking kwarg");
{
  const r = buildRequest({ providerId: "vllm", ...opts });
  const b = JSON.parse(r.body);
  ok(r.headers["Content-Type"] === "application/json", "Content-Type json");
  ok(b.messages[0].content.some((c) => c.type === "image_url" && c.image_url.url === PNG), "이미지가 image_url(dataURL)로");
  ok(b.max_tokens === 300 && b.temperature === 0, "max_tokens/temperature 전달");
  ok("chat_template_kwargs" in b, "vllm 은 enable_thinking kwarg 포함");
}

console.log("\n[openai] Bearer 인증 + image_url, thinking kwarg 없음");
{
  process.env.OPENAI_API_KEY = "sk-test";
  const r = buildRequest({ providerId: "openai", ...opts });
  const b = JSON.parse(r.body);
  ok(r.headers.Authorization === "Bearer sk-test", "Authorization: Bearer");
  ok(b.messages[0].content.some((c) => c.type === "image_url"), "이미지가 image_url로");
  ok(!("chat_template_kwargs" in b), "openai 는 vllm 전용 kwarg 없음");
}

console.log("\n[anthropic] x-api-key + 이미지 source(base64) + content[].text");
{
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  const r = buildRequest({ providerId: "anthropic", ...opts });
  const b = JSON.parse(r.body);
  ok(r.headers["x-api-key"] === "sk-ant-test" && !!r.headers["anthropic-version"], "x-api-key + anthropic-version");
  const img = b.messages[0].content.find((c) => c.type === "image");
  ok(img && img.source.type === "base64" && img.source.media_type === "image/png" && img.source.data === "AAAABBBBCCCC",
    "이미지가 source.base64 로 분해됨(dataURL → media_type+data)");
  ok(b.messages[0].content.some((c) => c.type === "text"), "프롬프트가 text 블록으로");
}

console.log("\n[gemini] generateContent + X-goog-api-key + inlineData");
{
  process.env.GEMINI_API_KEY = "gem-test";
  process.env.GEMINI_MODEL = "gemini-3.5-flash";
  const r = buildRequest({ providerId: "gemini", ...opts });
  const b = JSON.parse(r.body);
  ok(r.url.endsWith("/models/gemini-3.5-flash:generateContent"), "generateContent URL + model path");
  ok(r.headers["X-goog-api-key"] === "gem-test", "X-goog-api-key 인증");
  ok(b.contents[0].parts.some((p) => p.text?.includes("이 표를 설명")), "프롬프트가 parts[].text 로");
  const img = b.contents[0].parts.find((p) => p.inlineData);
  ok(img?.inlineData?.mimeType === "image/png" && img.inlineData.data === "AAAABBBBCCCC",
    "이미지가 inlineData 로 분해됨(dataURL → mimeType+data)");
  ok(b.generationConfig.maxOutputTokens === 300 && b.generationConfig.temperature === 0,
    "generationConfig 전달");
}

console.log("\n[bedrock] Converse SDK provider 설정 병합");
{
  const ai = resolveAiConfig({
    provider: "bedrock",
    region: "ap-northeast-2",
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    profile: "dev-profile",
  });
  ok(ai.id === "bedrock", "provider=bedrock 해석");
  ok(ai.cfg.region === "ap-northeast-2", "region override");
  ok(ai.cfg.model.includes("claude-3-5-sonnet"), "model override");
  ok(ai.cfg.profile === "dev-profile", "profile override");
}

console.log("\n[mineru] 문서 파서 엔진 — 파일 단위 parseDocument(페이지 단위 build/complete 아님)");
{
  const ai = resolveAiConfig({ provider: "mineru", url: "http://10.0.0.9:8000/" });
  ok(ai.id === "mineru", "provider=mineru 해석");
  ok(typeof ai.provider.parseDocument === "function", "parseDocument(파일 단위) 보유");
  ok(!ai.provider.build && !ai.provider.complete, "페이지 단위 build/complete 는 없음(파이프라인 우회 신호)");
  ok(ai.provider.kind === "document-parser", "kind=document-parser");
  ok(typeof ai.provider.ping === "function", "ping(/health) 보유 — aiPing 이 chat 대신 사용");
  ok(ai.cfg.url === "http://10.0.0.9:8000/" && ai.cfg.lang === "korean" && ai.cfg.postprocess === false,
    "url override + 기본 lang=korean + postprocess 기본 off(원본 점검)");
  ok(ai.provider.enabled(ai.cfg) === true, "url 있으면 enabled");
  ok(ai.provider.enabled({ ...ai.cfg, url: "", pipeline_url: "" }) === false, "url/pipeline_url 모두 비면 disabled");
  ok(ai.provider.enabled({ url: "", pipeline_url: "http://h:8002" }) === true, "pipeline_url 만 있어도 enabled");
}

console.log("\n[mineru] 백엔드 라우팅 — 이미지→pipeline(:8002, 한글정확) / PDF·DOCX→hybrid(:8000)");
{
  const cfg = { url: "http://h:8000", pipeline_url: "http://h:8002", backend: "auto" };
  ok(JSON.stringify(mineruRoute("poster.jpg", cfg)) === JSON.stringify({ backend: "pipeline", base: "http://h:8002" }),
    "auto + 이미지(.jpg) → pipeline:8002");
  ok(mineruRoute("notice.png", cfg).backend === "pipeline", "auto + .png → pipeline");
  ok(JSON.stringify(mineruRoute("report.pdf", cfg)) === JSON.stringify({ backend: "hybrid-engine", base: "http://h:8000" }),
    "auto + PDF → hybrid-engine:8000");
  ok(mineruRoute("doc.docx", cfg).backend === "hybrid-engine", "auto + DOCX → hybrid-engine");
  ok(mineruRoute("poster.jpg", { ...cfg, backend: "hybrid-engine" }).backend === "hybrid-engine",
    "backend 강제 지정이 auto 라우팅보다 우선(이미지도 hybrid 로)");
  ok(mineruRoute("report.pdf", { ...cfg, backend: "pipeline" }).base === "http://h:8002",
    "backend=pipeline 강제 → pipeline URL");
  // 폴백: 원하는 백엔드 서버 URL 이 비면 있는 서버로 보내고 backend 도 일치시킨다(엉뚱한 서버에 pipeline 전송 방지).
  const r = mineruRoute("poster.jpg", { url: "http://h:8000", pipeline_url: "", backend: "auto" });
  ok(r.base === "http://h:8000" && r.backend === "hybrid-engine",
    "pipeline_url 없음 → hybrid 로 폴백 + backend=hybrid-engine(서버와 일치)");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
