// PaddleOCR-VL 클라이언트 — endpoint 정규화 + 직렬 큐 순서 보장 (네트워크 불필요)
// 실행: node tests/paddle.test.mjs
import { paddleEndpoint, serialize, PADDLE_PARSE_ENABLED } from "../server/paddle.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

console.log("\n[1] paddleEndpoint — base/풀경로 정규화");
ok(paddleEndpoint("http://h:8500", "/api/v1/parse") === "http://h:8500/api/v1/parse", "base + path");
ok(paddleEndpoint("http://h:8500/", "/api/health") === "http://h:8500/api/health", "trailing slash 제거");
ok(paddleEndpoint("http://h:8500/api/v1/parse", "/api/health") === "http://h:8500/api/health", "풀 /parse 경로 → 루트 복원");
ok(paddleEndpoint("http://h:8500/api/v1/ocr", "/api/v1/parse") === "http://h:8500/api/v1/parse", "풀 /ocr 경로 → /parse 로");

console.log("\n[2] PADDLE_PARSE_ENABLED — env 없으면 false");
ok(PADDLE_PARSE_ENABLED() === false, "PADDLE_PARSE_URL 미설정 → false (회귀: paddle 미동작)");

console.log("\n[3] serialize — 직렬 큐(동시 호출 방지, /parse concurrency=1 준수)");
{
  const order = [];
  const mk = (id, delay) => () => new Promise((r) => setTimeout(() => { order.push(id); r(id); }, delay));
  // 일부러 역순 지연(첫 task 가 가장 느림) — 병렬이면 3,2,1, 직렬이면 1,2,3
  const p1 = serialize(mk(1, 40));
  const p2 = serialize(mk(2, 10));
  const p3 = serialize(mk(3, 1));
  const r = await Promise.all([p1, p2, p3]);
  ok(JSON.stringify(order) === "[1,2,3]", `완료 순서가 enqueue 순서와 동일 (got ${JSON.stringify(order)})`);
  ok(JSON.stringify(r) === "[1,2,3]", "각 호출 결과가 자기 task 값을 반환");
}

console.log("\n[4] serialize — 한 task 실패해도 다음 task 진행(체인 안 끊김)");
{
  const order = [];
  const good = (id) => () => new Promise((r) => { order.push(id); r(id); });
  const bad = () => () => Promise.reject(new Error("boom"));
  const a = serialize(good("a"));
  const b = serialize(bad()).catch(() => "caught");
  const c = serialize(good("c"));
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  ok(ra === "a" && rc === "c" && rb === "caught", "실패 task 이후에도 후속 task 실행됨");
  ok(JSON.stringify(order) === '["a","c"]', "성공 task 들이 순서대로 실행");
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
