// 망가진 페이지 감지 임계값 (server/detect.js). 실측 튜닝값 — tests/detect-precision 으로 검증.
export const detectConfig = Object.freeze({
  proseFakeTable: { minCells: 3, longCellLen: 40, minRows: 3, avgCellLen: 45, longCellRatio: 0.6 },
  pipeTableParagraph: { minPipeLines: 3 },
  garbledDataTable: { maxNumTokens: 10, minCols: 3, emptyRatio: 0.5 },
  glyphNoise: { pageThreshold: 2 },
});
