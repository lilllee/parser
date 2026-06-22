export const vllmConfig = Object.freeze({
    limits: {
      tableChars: Number(process.env.VLLM_MAX_TABLE_CHARS || 4000),
      pageVisualImageKb: Number(process.env.VLLM_PAGE_VISUAL_MAX_KB || 4000),
    },
    tokens: {
      image: 512,
      table: 256,
      pageVisual: 640,
      // OCR 은 '페이지 단위' 호출이라 출력 8192(≈6000+단어/페이지)면 어떤 빽빽한 전면 표·명단도
      // 한 번에 담긴다. 서버는 출력에 별도 캡이 없고 입력+출력 ≤ max_model_len(32768)만 제약 —
      // 2600px 이미지(~6~8K tok)+프롬프트 입력에 8192 출력이면 합쳐 ~16K 로 안전(2배 여유).
      // (그래도 잘리면 ai.js 가 AI_MAX_TOKENS_CAP 까지 확대.) env VLLM_OCR_MAX_TOKENS 로 조정.
      ocr: Number(process.env.VLLM_OCR_MAX_TOKENS || 8192),
    },
    concurrency: {
      enrich: Number(process.env.VLLM_CONCURRENCY || 3),
      ocr: Number(process.env.VLLM_OCR_CONCURRENCY || 3),
    },
    timeouts: {
      // HTML <table> 출력은 markdown 보다 토큰이 3~4배라 빽빽한 17행 표는 생성이 오래 걸린다 —
      // 240s 면 그런 페이지가 abort 되어 통째 유실됐다. 정확도 우선이라 600s 로(env 로 조정).
      ocrMs: Number(process.env.VLLM_OCR_TIMEOUT_MS || 600000),
    },
    render: {
      // 전사 충실도(작은 한글 글자 인식)는 해상도에 민감 — 3x 로 렌더(긴 변 cap 내에서).
      // 너무 크면 컨텍스트 초과 → ocrPageAdaptive 가 0.7배로 자동 축소 재시도.
      ocrScale: Number(process.env.VLLM_OCR_RENDER_SCALE || 3),
      ocrMaxLongSidePx: Number(process.env.VLLM_OCR_MAX_LONG_SIDE || 2600),
      // DeepSeek-OCR 의 crop_mode 처럼, 큰 페이지가 컨텍스트 초과로 실패하면 축소만 하지 않고
      // 읽기 순서 타일로 나눠 OCR 한다. 끄려면 VLLM_OCR_TILE_FALLBACK=0.
      ocrTileFallback: process.env.VLLM_OCR_TILE_FALLBACK !== "0",
      // DeepSeek-OCR 'Base'(1024) 모드: 컨텍스트 초과 페이지를 그리드 타일 전에 1024 긴변 단일 뷰로
      // 먼저 OCR(스티칭/이음새 중복 없는 깨끗한 단일 패스 — 대부분의 '큰' 페이지는 이걸로 해결).
      ocrBaseViewPx: Number(process.env.VLLM_OCR_BASE_VIEW_PX || 1024),
      ocrMinTiles: Number(process.env.VLLM_OCR_MIN_TILES || 2),
      ocrMaxTiles: Number(process.env.VLLM_OCR_MAX_TILES || 6),
      ocrTileOverlapPx: Number(process.env.VLLM_OCR_TILE_OVERLAP_PX || 48),
    },
    features: {
      pageVisual: process.env.VLLM_PAGE_VISUAL !== "0",
      tableAnalysis: process.env.VLLM_TABLE_ANALYSIS === "1",
      spreadSplit: process.env.VLLM_SPREAD_SPLIT !== "0",
      // 흐름도(화살표 글리프가 든 표) → mermaid 변환. 끄려면 VLLM_FLOWCHART=0.
      flowchart: process.env.VLLM_FLOWCHART !== "0",
    },
});
