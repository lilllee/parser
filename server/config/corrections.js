// OCR 글자 오인식 후보정 사전 (post-correction lexicon).
// vision 모델이 형태가 비슷한 글자를 헷갈리는 경우(예: '청구'→'정구')를 결정적으로 교정한다.
// 안전 원칙: '틀린 형태가 그 문맥에서 실제 단어가 아닌' 고신뢰 항목만, 그리고 단일 글자가 아닌
// 전체 용어 단위로만 등록한다(바른 '정구'(예: 인명/정구공)를 깨뜨리지 않도록).
// 확장: 환경변수 VLLM_OCR_CORRECTIONS 에 JSON({"틀림":"맞음", ...})으로 추가하면 빌트인에 병합된다.

function loadEnvCorrections() {
  const raw = process.env.VLLM_OCR_CORRECTIONS;
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : {};
  } catch {
    console.warn("[corrections] VLLM_OCR_CORRECTIONS JSON 파싱 실패 — 무시");
    return {};
  }
}

// 빌트인: 입양실무 매뉴얼 등에서 실측 확인된 비-단어 오인식만.
const BUILTIN = {
  정보공개정구: "정보공개청구", // 청구 ↔ 정구 (정보공개청구는 고정 법령 용어)
  성분찰설: "성본창설", // 성·본 창설
  응아전담: "영아전담",
  응야전담: "영아전담",
};

export const ocrCorrections = Object.freeze({ ...BUILTIN, ...loadEnvCorrections() });
