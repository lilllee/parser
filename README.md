문서·이미지를 **markdown** 으로 변환

## 실행

```bash
npm install
npm start        # http://localhost:8787   (개발: npm run dev — 파일 변경 시 자동 재시작)
```

→ **Swagger UI** http://localhost:8787/api/docs · **OpenAPI** `/api/openapi.json`

## API

| 엔드포인트 | 설명 |
|---|---|
| `POST /api/convert` | 파일 → markdown 변환 (JSON) |
| `GET /api/health` | 서버 상태 + 기본 provider |
| `GET /api/vllm/check` | 활성 AI 백엔드 연결 점검 |
| `GET /api/docs` · `/api/openapi.json` | Swagger UI · OpenAPI 3.1 |

`POST /api/convert` 는 `multipart/form-data` 로 받는다:

```bash
# 기본 provider(vllm, .env 설정) 사용
curl -F "file=@문서.pdf" http://localhost:8787/api/convert

# provider 와 설정을 요청마다 지정
curl -F "file=@문서.png" -F provider=gemini -F api_key=... http://localhost:8787/api/convert
```

응답 — **raw markdown + 기본 메타** 만 반환한다:

```jsonc
{
  "ok": true,
  "markdown": "# 제목\n\n본문...",        // OCR·reflow·enrich 가 반영된 최종 markdown
  "metadata": { "pageCount": 12, "createdAt": "..." },
  "pageCount": 12
}
```

실패 시 `{ "ok": false, "error": "...", "code": "IMAGE_BASED_PDF" }` (4xx/5xx).

### provider

AI 백엔드는 요청마다 `provider` 로 고른다(미지정 시 `vllm`). 설정 필드를 생략하면 서버 `.env` 기본값을 쓴다.

| provider | 설정 필드 | 백엔드 |
|---|---|---|
| `vllm` (기본) | `url` · `model` · `thinking` | 로컬 vLLM (OpenAI 호환) |
| `openai` | `api_key` · `model` · `base_url` | OpenAI / OpenAI 호환 |
| `gemini` | `api_key` · `model` · `base_url` | Google Gemini |
| `anthropic` | `api_key` · `model` · `base_url` | Anthropic Claude |
| `claude_cli` | `model` | Claude Max (`claude -p` CLI) |
| `codex_cli` | `model` | ChatGPT Pro (`codex exec` CLI) |

## 지원 형식

`PDF` · `HWP` · `HWPX` · `HWPML` · `DOCX` · `XLSX` · `XLS` · `TXT` · `MD` · 이미지(`PNG`·`JPG`·`JPEG`·`WEBP`·`GIF`·`BMP`·`TIFF`).
텍스트 레이어가 없는 스캔본 PDF·펼침면(2-page spread)·이미지 파일은 **AI vision OCR** 로 처리한다(AI provider 필요).

## 설정

환경 변수는 `.env` 로 관리한다(`.env.example` 복사). 핵심:

- `AI_PROVIDER` — 기본 provider (`vllm` 등)
- `VLLM_URL` · `VLLM_MODEL` — 로컬 vLLM
- `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — 외부 provider 키

전체 옵션은 `.env` 인라인 주석을, 변환 파이프라인 내부 동작은 [`pipeline.md`](./pipeline.md) 를 참고한다.

## 구조

```
server/
  index.js        HTTP 라우트 (Hono)
  convert.js      변환 파이프라인 (parse → OCR 재추출 → 후처리 → enrich)
  postprocess.js  markdown 후처리
  ai.js           provider 오케스트레이션 (요청별 선택 · AsyncLocalStorage)
  providers.js    provider 정의 (vllm·openai·gemini·anthropic·claude/codex)
  vllm.js         vision OCR · 시각자료 enrich · 렌더
  detect.js       망가진/펼침면 페이지 감지
  openapi.js      OpenAPI 스펙
  config/         설정 · 프롬프트 · 임계값
```

## 테스트

```bash
npm test     # 감지 신호 + AI 프로바이더 요청 포맷 회귀 테스트
```
