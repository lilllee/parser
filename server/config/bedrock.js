// Bedrock 검수(eval) 허용 모델 — 이 목록의 모델만 검수 UI 에서 실행 가능 (요구사항 고정).
// inference profile 은 리전 패밀리(us./apac.)마다 따로 존재해서 리전에 맞춰 선택한다.
// ids 가 null 인 리전은 해당 모델 미제공 (예: 서울 ap-northeast-2 에는 3.5 Haiku /
// 3.7 Sonnet / Llama 가 없음 — 2026-06 ListInferenceProfiles 실측).
// vision=false 모델은 이미지(OCR) 입력 시 Bedrock 이 ValidationException 을 던진다 —
// 텍스트 문서 전용으로만 테스트할 것 (UI 에 "텍스트 전용" 으로 표기).
export const BEDROCK_EVAL_MODELS = Object.freeze([
  { key: "claude-3-haiku", label: "Claude 3 Haiku", vision: true,
    ids: { us: "us.anthropic.claude-3-haiku-20240307-v1:0", apac: "apac.anthropic.claude-3-haiku-20240307-v1:0" } },
  { key: "claude-3-5-haiku", label: "Claude 3.5 Haiku", vision: false,
    ids: { us: "us.anthropic.claude-3-5-haiku-20241022-v1:0", apac: null } },
  { key: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet v2", vision: true,
    ids: { us: "us.anthropic.claude-3-5-sonnet-20241022-v2:0", apac: "apac.anthropic.claude-3-5-sonnet-20241022-v2:0" } },
  { key: "claude-3-7-sonnet", label: "Claude 3.7 Sonnet", vision: true,
    ids: { us: "us.anthropic.claude-3-7-sonnet-20250219-v1:0", apac: null } },
  { key: "nova-micro", label: "Nova Micro", vision: false,
    ids: { us: "us.amazon.nova-micro-v1:0", apac: "apac.amazon.nova-micro-v1:0" } },
  { key: "nova-lite", label: "Nova Lite", vision: true,
    ids: { us: "us.amazon.nova-lite-v1:0", apac: "apac.amazon.nova-lite-v1:0" } },
  { key: "nova-pro", label: "Nova Pro", vision: true,
    ids: { us: "us.amazon.nova-pro-v1:0", apac: "apac.amazon.nova-pro-v1:0" } },
  { key: "llama-3-1-8b", label: "Llama 3.1 8B", vision: false,
    ids: { us: "us.meta.llama3-1-8b-instruct-v1:0", apac: null } },
  { key: "llama-3-3-70b", label: "Llama 3.3 70B", vision: false,
    ids: { us: "us.meta.llama3-3-70b-instruct-v1:0", apac: null } },
]);

function regionFamily(region) {
  const r = String(region || "");
  if (r.startsWith("ap-")) return "apac";
  if (r.startsWith("eu-")) return "eu";
  return "us";
}

// 리전에 맞는 모델 ID. 그 리전 패밀리에 프로파일이 없으면 null.
export function bedrockModelForRegion(m, region) {
  return m.ids[regionFamily(region)] ?? null;
}

// "bedrock:<key>" 검수 provider 문자열 해석. 목록 외 key / 리전 미제공 모델은 400.
export function resolveBedrockEvalModel(key, region) {
  const m = BEDROCK_EVAL_MODELS.find((row) => row.key === key);
  if (!m) {
    const err = new Error(
      `허용되지 않은 Bedrock 모델: "${key}" (가능: ${BEDROCK_EVAL_MODELS.map((r) => r.key).join(", ")})`
    );
    err.status = 400;
    throw err;
  }
  const modelId = bedrockModelForRegion(m, region);
  if (!modelId) {
    const err = new Error(`${m.label} 은(는) 리전 ${region} 에서 제공되지 않습니다 (US 리전 키 필요).`);
    err.status = 400;
    throw err;
  }
  return { ...m, modelId };
}
