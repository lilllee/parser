export const vllmConfig = Object.freeze({
    limits: {
      tableChars: Number(process.env.VLLM_MAX_TABLE_CHARS || 4000),
      pageVisualImageKb: Number(process.env.VLLM_PAGE_VISUAL_MAX_KB || 4000),
    },
    tokens: {
      image: 512,
      table: 256,
      pageVisual: 640,
      ocr: 2000,
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
    },
});