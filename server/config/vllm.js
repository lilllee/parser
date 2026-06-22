export const vllmConfig = Object.freeze({
    limits: {
      tableChars: Number(process.env.VLLM_MAX_TABLE_CHARS || 4000),
      pageVisualImageKb: Number(process.env.VLLM_PAGE_VISUAL_MAX_KB || 4000),
    },
    tokens: {
      image: 512,
      table: 256,
      pageVisual: 640,
      // 전면 통계표·명단 같은 빽빽한 페이지는 2000 으로 잘려(truncation) 재시도에 의존했다(보육 실측).
      // 정확도/완전성 우선이라 4096 으로 올려 한 번에 담는다(잘림 시 ai.js 가 8192 까지 추가 확대).
      ocr: Number(process.env.VLLM_OCR_MAX_TOKENS || 4096),
    },
    concurrency: {
      enrich: Number(process.env.VLLM_CONCURRENCY || 3),
      ocr: Number(process.env.VLLM_OCR_CONCURRENCY || 3),
    },
    timeouts: {
      ocrMs: Number(process.env.VLLM_OCR_TIMEOUT_MS || 240000),
    },
    render: {
      // 전사 충실도(작은 한글 글자 인식)는 해상도에 민감 — 3x 로 렌더(긴 변 cap 내에서).
      // 너무 크면 컨텍스트 초과 → ocrPageAdaptive 가 0.7배로 자동 축소 재시도.
      ocrScale: Number(process.env.VLLM_OCR_RENDER_SCALE || 3),
      ocrMaxLongSidePx: Number(process.env.VLLM_OCR_MAX_LONG_SIDE || 2600),
    },
    features: {
      pageVisual: process.env.VLLM_PAGE_VISUAL !== "0",
      tableAnalysis: process.env.VLLM_TABLE_ANALYSIS === "1",
      spreadSplit: process.env.VLLM_SPREAD_SPLIT !== "0",
      // 흐름도(화살표 글리프가 든 표) → mermaid 변환. 끄려면 VLLM_FLOWCHART=0.
      flowchart: process.env.VLLM_FLOWCHART !== "0",
    },
});