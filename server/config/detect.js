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
  // 흩어진 차트/표: '숫자만 있는 단락 블록'이 한 페이지에 minLoneBlocks 개 이상이면
  // kordoc 이 표/차트 구조를 잃고 값을 개별 단락으로 흩뿌린 것 — vision OCR 로 재추출.
  // (정상 표는 값이 table 블록 셀 안에 있어 안 걸림. 정수 라벨 그룹막대 차트가 대표 케이스.)
  scatteredNumbers: { minLoneBlocks: 4 },
  // 좌우 컬럼이 거의 같은 비교표(현행/개정·전/후 등): 비교 가능한 행(minCellLen 자+ 셀 2개+)
  // 중 '중복 셀쌍'을 가진 행 비율이 dupRatio 이상이고 그런 행이 minRows 이상이면, kordoc 이
  // 3단(쪽|현행|개정)을 2단으로 뭉개고 페이지번호를 본문에 섞은 것 — vision OCR 로 재추출.
  dupColumnTable: { minCellLen: 8, minRows: 3, dupRatio: 0.5 },
  // 개정 대비표 페이지: '현행'과 '개정' 머리글이 한 페이지에 함께 있으면 좌우 2단 비교 레이아웃
  // (내용이 비대칭이라 dupColumnTable 로 안 잡히는 페이지 포함) → 페이지 단위 vision 재추출.
  // 본문 우연 동시등장 오탐을 줄이려 maxMarkerLen 자 이하 짧은 블록/표 머리글 셀에서만 인정.
  revisionTable: { maxMarkerLen: 25 },
  // 한 셀에 여러 줄(문단/구간)이 통째로 뭉친 표 — kordoc 이 칸 구조를 잃고 본문을 셀 하나에
  // 욱여넣은 신호. 정상 표 셀은 길어도 1줄(줄바꿈 없음)이라, '셀 안 줄수'로 구분(글자수 아님:
  // 통계표엔 줄바꿈 없는 긴 셀이 정상 존재). 좁은 표(maxCols 이하)에서만 본다.
  crammedCell: { maxCols: 3, minLines: 10 },
  // 단위 열이 값 열과 한 셀에 뭉친 표 — kordoc 이 열 분리에 실패한 신호. 예: '명 1,180 1,109',
  // '% 46 50'. 정상 표는 단위(명/%/개소…)와 값이 별도 셀이므로, 단위 뒤에 숫자가 바로 붙은
  // 셀이 minCells 개 이상이면 망가진 표로 보고 vision OCR 로 재추출.
  unitJam: { minCells: 1 },
});
