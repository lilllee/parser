export const vllmConfig = Object.freeze({
    limits: {
      tableChars: Number(process.env.VLLM_MAX_TABLE_CHARS || 4000),
      pageVisualImageKb: Number(process.env.VLLM_PAGE_VISUAL_MAX_KB || 4000),
      // OCR anchor(텍스트레이어 보조) user 블록 최대 길이. 통짜로 넣되 너무 길면 모델이 anchor 를
      // 베껴 '이미지 근거' 원칙을 우회 → 보수적 cap. 초과 시 truncateAnchor 가 표/숫자/헤더 우선 압축.
      ocrAnchorMaxChars: Number(process.env.VLLM_OCR_ANCHOR_MAX_CHARS || 2000),
      // numeric repair: 페이지당 보정 재호출 상한(decode ~13.6tok/s 라 1회 ≈ 1분 → 보수적 1회 고정),
      // 및 보정을 트리거할 최소 missing 숫자 수(1은 경계 오독 노이즈 → 기본 2).
      numericRepairMax: Number(process.env.VLLM_OCR_NUMERIC_REPAIR_MAX || 1),
      numericRepairMinMismatch: Number(process.env.VLLM_OCR_NUMERIC_REPAIR_MIN_MISMATCH || 2),
    },
    tokens: {
      // enrich(설명) 출력 — 짧으면 차트/그림/표 설명이 중간에 끊긴다. 캡은 상한일 뿐(평균 출력 ~640tok
      // 라 안 채우면 비용 0). 자주 튜닝하도록 env 훅 부여. (decode ~13.6tok/s 라 '채워질 때만' 느려짐.)
      image: Number(process.env.VLLM_IMAGE_MAX_TOKENS || 1024),
      table: Number(process.env.VLLM_TABLE_MAX_TOKENS || 1024),
      pageVisual: Number(process.env.VLLM_PAGE_VISUAL_MAX_TOKENS || 1280),
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
      // kordoc(텍스트 PDF) 경로의 차트/그림 페이지도 렌더해 enrich 해설 대상에 포함(P1.5). 끄면(=0)
      // 기존처럼 스캔/force_ocr 경로만 차트 해설을 받는다(reflow 페이지 차트 해설 누락 = legacy).
      pageVisualReflow: process.env.VLLM_PAGE_VISUAL_REFLOW !== "0",
      tableAnalysis: process.env.VLLM_TABLE_ANALYSIS === "1",
      spreadSplit: process.env.VLLM_SPREAD_SPLIT !== "0",
      // 흐름도(화살표 글리프가 든 표) → mermaid 변환. 끄려면 VLLM_FLOWCHART=0.
      flowchart: process.env.VLLM_FLOWCHART !== "0",
      // OCR user 프롬프트에 '페이지 N / 총 M' 주입(마지막/이어짐 판단 단서). 끄면(=0) legacy '페이지 N'.
      pageInfo: process.env.VLLM_OCR_PAGE_INFO !== "0",
      // kordoc 텍스트레이어를 OCR 입력 anchor(숫자/철자/읽기순서 보조)로 주입. 끄면(=0) anchor 미전달
      // = legacy byte-identical. reflow 경로에만 적용(force_ocr 는 사용자가 텍스트레이어 불신 모드라 제외).
      ocrAnchor: process.env.VLLM_OCR_ANCHOR !== "0",
      // reflow 페이지 vision 전사 후 kordoc 숫자와 대조해 누락/오독이 임계 이상이면 보정 재호출
      // (accept/rollback). 끄면(=0) 보정 없이 불일치만 경고. force_ocr 는 별도 경로(현행 경고 유지).
      numericRepair: process.env.VLLM_OCR_NUMERIC_REPAIR !== "0",
    },
});
