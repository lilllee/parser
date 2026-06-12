// 망가진 페이지 감지 임계값 (server/detect.js). 실측 튜닝값 — tests/detect-precision 으로 검증.
export const detectConfig = Object.freeze({
  proseFakeTable: { minCells: 3, longCellLen: 40, minRows: 3, avgCellLen: 45, longCellRatio: 0.6 },
  pipeTableParagraph: { minPipeLines: 3 },
  garbledDataTable: { maxNumTokens: 10, minCols: 3, emptyRatio: 0.5 },
  glyphNoise: { pageThreshold: 2 },
  // 저밀도 페이지: 텍스트가 문서 중앙값 대비 비정상적으로 적은 페이지(부분 스캔/전면 이미지)를
  // vision OCR 로 보낸다. 블록 0개 페이지는 무조건, 그 외엔 중앙값×medianRatio 미만이면서
  // maxChars 이하일 때만(표지처럼 의도적으로 짧은 페이지 오탐 방지) 플래그.
  lowDensity: { medianRatio: 0.1, maxChars: 30 },
  // 차트/인포그래픽 잔해: 축눈금 런("0% 10% 20%…" %눈금 4개+ / "80 70 60…" 숫자 눈금 5개+)
  // 또는 한 표 셀에 %값 2개+ 뭉침(원형 차트 라벨이 셀로 합쳐진 것) — vision OCR 로 재추출.
  chartArtifact: { percentTickMin: 4, numberTickMin: 5, cellPercentTokens: 2 },
});
