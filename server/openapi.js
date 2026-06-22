// OpenAPI 스펙 (/api/openapi.json · Swagger UI /api/docs). ConvertRequest 의 vllm 기본값은 .env 값.

const VLLM_URL_DEFAULT = process.env.VLLM_URL || "http://localhost:8000/v1/chat/completions";
const VLLM_MODEL_DEFAULT = process.env.VLLM_MODEL || "Intel/Qwen3.5-122B-A10B-int4-AutoRound";
const MINERU_URL_DEFAULT = process.env.MINERU_URL || "http://localhost:8000";
const VLLM_THINKING_DEFAULT = process.env.VLLM_THINKING === "1";
const BEDROCK_REGION_DEFAULT = process.env.BEDROCK_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
const BEDROCK_MODEL_DEFAULT = process.env.BEDROCK_MODEL || "anthropic.claude-3-5-sonnet-20241022-v2:0";

export const openapiSpec = {
  openapi: "3.1.0",
  info: {
    title: "파일 변환 API",
    description: `
- 텍스트 PDF / HWP / HWPX / DOCX / XLSX → kordoc 으로 markdown 추출
- 스캔본 PDF (텍스트 레이어 없음) → 페이지 렌더링 → AI vision OCR
- 이미지 파일 (PNG / JPG 등) → AI vision OCR 로 전체 텍스트 추출
- kordoc 이 망가뜨린 페이지 / 2-page spread 펼침면 → 해당 페이지만 AI vision OCR 로 재추출
- 본문 안의 표 / 이미지 → AI 로 분석해 \`> ...\` 인용 블록으로 inline 삽입

단일 엔드포인트 **\`POST /api/convert\`** — multipart 로 \`file\` + \`provider\`(및 provider 설정)를 받아
변환 결과 markdown 을 JSON 으로 반환한다. AI 백엔드는 요청마다 \`provider\` 로 선택하며,
설정값을 생략하면 서버 \`.env\` 기본값을 쓴다 (기본 provider = \`vllm\`).
    `.trim(),
    version: "0.3.0",
    contact: { name: "fs.md" },
    license: { name: "MIT" },
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "convert", description: "파일 → markdown 변환" },
    { name: "system", description: "서버 상태 / 메타" },
  ],
  paths: {
    "/api/convert": {
      post: {
        tags: ["convert"],
        summary: "파일 → markdown 변환",
        description:
          "multipart/form-data 로 `file` + `provider`(+ provider 설정)를 받아 변환 결과를 JSON 으로 반환한다. " +
          "OCR/enrichment 가 필요한 큰 PDF 는 수십 초~수 분 걸릴 수 있으니 클라이언트 timeout 을 넉넉히(≥5분) 둘 것.",
        operationId: "convert",
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: { $ref: "#/components/schemas/ConvertRequest" },
            },
          },
        },
        responses: {
          200: {
            description: "변환 성공",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ConvertResult" },
                example: {
                  ok: true,
                  markdown: "# 문서 제목\n\n본문...",
                  metadata: { pageCount: 1, createdAt: "2026-05-13T10:00:42" },
                  pageCount: 1,
                  elapsedMs: 13842,
                },
              },
            },
          },
          400: {
            description: "잘못된 요청 (file 누락 / 알 수 없는 provider)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorBody" },
                example: { ok: false, error: "file 필드가 필요합니다.", elapsedMs: 3 },
              },
            },
          },
          500: {
            description: "변환 실패 (kordoc 에러, OCR 실패 등)",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorBody" },
                example: { ok: false, error: "이미지 기반 PDF (1페이지, 0자)", code: "IMAGE_BASED_PDF", elapsedMs: 912 },
              },
            },
          },
        },
      },
    },
    "/api/health": {
      get: {
        tags: ["system"],
        summary: "서버 상태 + 기본 AI provider 메타",
        operationId: "getHealth",
        responses: {
          200: {
            description: "정상",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Health" },
                example: { ok: true, kordoc: true, vllm: { provider: "vllm", url: "", model: "qwen", enabled: false } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      ConvertRequest: {
        type: "object",
        required: ["file"],
        description:
          "provider 에 따라 쓰이는 설정 필드가 다르다 — vllm: url/model/thinking · openai·anthropic: api_key/model/base_url · gemini: api_key/model/base_url(generateContent) · bedrock: region/model/profile/access_key_id/secret_access_key/session_token · claude_cli·codex_cli: model · mineru: url(hybrid:8000)/pipeline_url(:8002)/backend(auto)/lang/parse_method/effort/table/formula/image_analysis/postprocess. 생략한 값은 서버 .env 기본값을 쓴다. ⚠ mineru 는 페이지별 vision 이 아니라 파일을 통째 업로드해 MinerU 서버가 직접 md 로 변환하는 '문서 파서' 엔진 — kordoc/reflow/enrich 파이프라인을 우회한다(원본 md 그대로, postprocess=true 면 우리 후처리 적용). backend=auto 면 이미지는 pipeline(한글 정확)·그 외는 hybrid-engine(복잡 표)로 자동 라우팅.",
        properties: {
          file: {
            type: "string",
            format: "binary",
            description: "변환할 파일. PDF / HWP / HWPX / HWPML / DOCX / XLSX / XLS / TXT / MD, 이미지(PNG/JPG/JPEG/WEBP/GIF/BMP/TIFF). 이미지·스캔본은 AI vision OCR 로 처리(AI provider 필요).",
          },
          provider: {
            type: "string",
            enum: ["vllm", "openai", "anthropic", "gemini", "bedrock", "claude_cli", "codex_cli", "mineru"],
            default: "vllm",
            description: "AI 백엔드 (OCR·시각자료 분석). 미지정 시 vllm. mineru = 파일 통째 업로드형 문서 파서(MinerU).",
          },
          url: {
            type: "string",
            default: VLLM_URL_DEFAULT,
            description: `[vllm] OpenAI 호환 chat completions 엔드포인트. [mineru] 는 hybrid-engine base URL(예: ${MINERU_URL_DEFAULT}) — /file_parse·/health 는 자동으로 붙인다. pipeline 백엔드 URL 은 pipeline_url 로 따로 준다.`,
          },
          pipeline_url: {
            type: "string",
            default: process.env.MINERU_PIPELINE_URL || "http://localhost:8002",
            description: "[mineru] pipeline 백엔드(PaddleOCR) base URL. 이미지/포스터/장식 폰트의 정확한 한글 전사용 — hybrid-engine 의 글자깨짐·한→일 드리프트·환각·`#` 삽입을 피한다.",
          },
          backend: {
            type: "string",
            enum: ["auto", "hybrid-engine", "pipeline"],
            default: process.env.MINERU_BACKEND || "auto",
            description: "[mineru] 백엔드 라우팅. auto(기본)=이미지는 pipeline(:8002, 한글 정확)·그 외는 hybrid-engine(:8000, 복잡 표/다단). hybrid-engine/pipeline 으로 강제 지정 가능.",
          },
          effort: {
            type: "string",
            enum: ["", "low", "medium", "high"],
            default: process.env.MINERU_EFFORT || "",
            description: "[mineru] 품질 vs 속도. 비우면 서버 기본(medium). 값이 있을 때만 전송.",
          },
          lang: {
            type: "string",
            default: process.env.MINERU_LANG || "korean",
            description: "[mineru] OCR 언어 (lang_list). 한국어 = korean. pipeline 백엔드에서 실제 적용됨(hybrid 는 거의 무시).",
          },
          parse_method: {
            type: "string",
            enum: ["auto", "txt", "ocr"],
            default: process.env.MINERU_PARSE_METHOD || "auto",
            description: "[mineru] auto(텍스트레이어 자동 판별) / txt(텍스트레이어) / ocr(강제 OCR).",
          },
          table: {
            type: "boolean",
            default: process.env.MINERU_TABLE !== "0",
            description: "[mineru] 표 인식(table_enable).",
          },
          formula: {
            type: "boolean",
            default: process.env.MINERU_FORMULA !== "0",
            description: "[mineru] 수식 인식(formula_enable). 끄면 계¹⁾ 등이 $..$ 로 안 싸여 더 깔끔할 수 있음.",
          },
          image_analysis: {
            type: "boolean",
            default: process.env.MINERU_IMAGE_ANALYSIS === "1",
            description: "[mineru] 이미지/차트 분석. 켜면 그림 설명이 붙는지 확인용(기본 off — 원본 점검).",
          },
          postprocess: {
            type: "boolean",
            default: process.env.MINERU_POSTPROCESS === "1",
            description: "[mineru] 우리 postprocess(공백/reflow/글리프 정리) 적용 여부. 기본 false = MinerU 원본 md 그대로(육안 점검·비교용).",
          },
          model: {
            type: "string",
            default: VLLM_MODEL_DEFAULT,
            description: "모델 id. vllm/openai/anthropic/gemini/bedrock/codex_cli·claude_cli 공통(provider 별 기본값 적용). 표시 기본값은 vllm 기준.",
          },
          thinking: {
            type: "boolean",
            default: VLLM_THINKING_DEFAULT,
            description: "[vllm] 모델 thinking 모드. 이 모델군은 켜면 응답이 비거나 잘릴 수 있어 기본 false 권장.",
          },
          format: {
            type: "string",
            enum: ["md", "html"],
            default: "md",
            description: "출력 표 포맷. md(기본): 사람/RAG 가독용 markdown 파이프 표. html: <table> 구조 보존(병합셀·ParseBench GRITS 등 HTML 표만 인식하는 소비처용).",
          },
          force_ocr: {
            type: "boolean",
            default: /^(1|true|on|yes)$/i.test(process.env.FORCE_OCR || ""),
            description: "PDF 를 kordoc 우회하고 전체페이지 vision OCR 로 전사(+postprocess·차트 enrich·페이지별 숫자검증). 미지정 시 서버 기본값(FORCE_OCR env)을 따르고, 지정하면 그 값이 우선(false 로 끄기도 가능). ⚠ 적용 대상: PDF 만 — HWP/HWPX/DOCX 는 자동 제외돼 kordoc 전처리를 거치고, 이미지는 원래부터 vision 이다. 숫자검증은 kordoc 텍스트레이어 숫자와 대조해 vision 오독 의심 페이지를 metadata.verification·NUMERIC_MISMATCH 경고로 표면화(출력은 vision 유지). 컨텍스트 초과 페이지는 1024 단일뷰→그리드타일(DeepSeek) 폴백. vision provider(vllm/bedrock/anthropic) 필요, mineru 엔 무효. (mode=vision 으로도 켜짐)",
          },
          api_key: {
            type: "string",
            description: "[openai / anthropic / gemini] API 키.",
          },
          base_url: {
            type: "string",
            description: "[openai / anthropic / gemini] base URL. gemini 는 기본 https://generativelanguage.googleapis.com/v1beta 를 사용하고 /models/{model}:generateContent 를 붙인다.",
          },
          region: {
            type: "string",
            default: BEDROCK_REGION_DEFAULT,
            description: "[bedrock] AWS region. BEDROCK_REGION / AWS_REGION / AWS_DEFAULT_REGION 기본값 사용.",
          },
          profile: {
            type: "string",
            description: "[bedrock] AWS shared credentials/config profile. 미지정 시 기본 AWS credential chain 사용.",
          },
          access_key_id: {
            type: "string",
            description: "[bedrock] 임시 명시 credentials. 가능하면 AWS_PROFILE 또는 서버 env 사용 권장.",
          },
          secret_access_key: {
            type: "string",
            format: "password",
            description: "[bedrock] 임시 명시 credentials secret.",
          },
          session_token: {
            type: "string",
            format: "password",
            description: "[bedrock] STS/session credentials 사용 시 optional token.",
          },
        },
      },
      ConvertResult: {
        type: "object",
        required: ["ok"],
        properties: {
          ok: { type: "boolean", description: "성공이면 true" },
          markdown: { type: "string", description: "변환된 markdown 전문 (OCR·reflow·enrich 가 반영됨)" },
          metadata: {
            type: "object",
            additionalProperties: true,
            description: "원본 파일 메타데이터 — title / author / pageCount / createdAt 등 (포맷별 상이)",
          },
          pageCount: {
            type: "integer",
            nullable: true,
            description: "PDF 페이지 수 / HWP·HWPX 섹션 수 / XLSX 시트 수",
          },
          verification: {
            type: "array",
            nullable: true,
            description: "force_ocr 시에만. 페이지별 숫자 대조 결과 — { page, kordocNumbers, missing[], extra[], ok, unverified }. ok=false 면 vision 숫자가 kordoc 과 어긋남(육안 확인), unverified=true 면 kordoc 텍스트 없음(스캔, 무근거).",
            items: { type: "object", additionalProperties: true },
          },
          elapsedMs: {
            type: "integer",
            minimum: 0,
            description: "요청 수신부터 최종 응답 직전까지의 전체 변환 처리 시간(ms)",
          },
          error: { type: "string", description: "ok=false 일 때 에러 메시지" },
          code: { type: "string", description: "ok=false 일 때 에러 코드 (IMAGE_BASED_PDF, BAD_PROVIDER 등)" },
        },
      },
      Health: {
        type: "object",
        required: ["ok"],
        properties: {
          ok: { type: "boolean" },
          kordoc: { type: "boolean", description: "kordoc 모듈 로드 여부" },
          vllm: {
            type: "object",
            description: ".env 기본 provider 정보",
            properties: {
              provider: { type: "string" },
              url: { type: "string" },
              model: { type: "string" },
              enabled: { type: "boolean" },
            },
          },
        },
      },
      ErrorBody: {
        type: "object",
        required: ["ok", "error"],
        properties: {
          ok: { type: "boolean", example: false },
          error: { type: "string" },
          code: { type: "string" },
          elapsedMs: {
            type: "integer",
            minimum: 0,
            description: "요청 수신부터 에러 응답 직전까지의 처리 시간(ms)",
          },
        },
      },
    },
  },
};
