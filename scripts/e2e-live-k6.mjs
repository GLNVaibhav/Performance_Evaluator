/**
 * Phase 6/7/13 — END-TO-END LIVE_K6 proof (local execution plane).
 *
 * Drives the EXACT product-path code with a REAL k6 execution:
 *
 *   approved deterministic plan (backend/demo_plans/baseline_checkout.json,
 *   shrunk to 5 VUs / 5s per Phase 6's small-and-safe mandate)
 *     → serializePlan()                [the real Convex adapter]
 *     → makeBridgeClient().submit()    [the real Convex bridge client]
 *     → ingress relay (0.0.0.0)        [deployment stand-in for the public tunnel]
 *     → FastAPI POST /api/v1/runs      [bearer-authenticated]
 *     → RunManager → RealK6PerformanceEngine
 *     → real k6 subprocess (demo-api/tools/k6/k6)
 *     → authorized controlled target (demo-api, 127.0.0.1:8080)
 *     → results.json
 *     → backend metrics parser
 *     → GET /api/v1/runs/{id} + /result  [polled by the same client]
 *     → mapBackendResult()             [verbatim persistence shape]
 *     → PROVENANCE CHECK: every mapped metric asserted EQUAL to the raw
 *       k6 results.json values.
 *
 * The only component this script replaces from the product path is the
 * Convex cloud action's network origin (Convex cannot reach this sandbox —
 * no public ingress; documented deployment blocker). Everything else is the
 * real bridge code and a real k6 run.
 *
 * Usage:
 *   bun scripts/e2e-live-k6.mjs
 * Env:
 *   BRIDGE_URL (default http://127.0.0.1:8002 — the relay)
 *   EXECUTION_BRIDGE_TOKEN (must match the backend's, if set)
 *   K6_BINARY (default demo-api/tools/k6/k6)
 */
import { readFileSync } from "node:fs";
import { serializePlan, mapBackendResult, validateBackendResult } from "../src/convex/executor/contract.ts";
import { makeBridgeClient } from "../src/convex/executor/client.ts";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:8002";
const TOKEN = process.env.EXECUTION_BRIDGE_TOKEN ?? "";
const K6_BINARY = process.env.K6_BINARY ?? "/home/daytona/codebase/demo-api/tools/k6/k6";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// --- Phase 6: small, safe, controlled baseline -------------------------------

const APPROVED_PLAN = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "5s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: ["e2e bridge validation: small fixed-load baseline on the controlled demo API"],
};

console.log(`bridge: ${BRIDGE_URL}  target: controlled demo API  plan: fixed_load 5 VUs / 5s / /products\n`);

const client = makeBridgeClient({ baseUrl: BRIDGE_URL, token: TOKEN || undefined, timeoutMs: 30_000 });
const correlationId = `e2e-${Date.now()}`;
const request = serializePlan(APPROVED_PLAN, "http://127.0.0.1:8080", correlationId, "e2e-live-k6");

// --- 1. Submit (duplicate-safe: exactly one submission per correlation) -------

let externalRunId;
try {
  const outcome = await client.submit(request);
  externalRunId = outcome.externalRunId;
  check("submit → 201 with externalRunId", !!externalRunId, `externalRunId=${externalRunId} status=${outcome.status}`);
} catch (err) {
  check("submit → 201 with externalRunId", false, err.message);
  process.exit(1);
}

// --- 2. Poll (external id only) until terminal --------------------------------

const deadline = Date.now() + 120_000;
let status = null;
let errorMessage = null;
while (Date.now() < deadline) {
  const s = await client.getStatus(externalRunId);
  status = s.status;
  errorMessage = s.errorMessage;
  if (["COMPLETED", "EXECUTION_ERROR", "CANCELLED"].includes(status)) break;
  process.stdout.write(`  .. ${status}\n`);
  await new Promise((r) => setTimeout(r, 1500));
}
check("k6 execution reached a terminal state", status === "COMPLETED", `status=${status}${errorMessage ? ` (${errorMessage})` : ""}`);

if (status !== "COMPLETED") process.exit(1);

// --- 3. Fetch result through the bridge client ---------------------------------

const raw = await client.getResult(externalRunId);
let resultOk = true;
try {
  validateBackendResult(raw);
} catch (e) {
  resultOk = false;
  console.log(`  validation error: ${e.message}`);
}
check("backend TestResult passes Convex-side validation", resultOk);

const mapped = mapBackendResult(raw, APPROVED_PLAN, correlationId);

// --- 4. PROVENANCE PROOF: mapped metrics == raw k6 results.json ----------------

const artifactPath = raw.artifacts?.results_json_path ?? null;
check("results.json artifact exists", !!artifactPath, artifactPath ?? "none");
if (artifactPath) {
  const k6 = JSON.parse(readFileSync(artifactPath, "utf8"));
  const signups = k6.metrics?.http_req_duration;
  const reqs = k6.metrics?.http_reqs;
  const failed = k6.metrics?.http_req_failed;
  // k6 summary-export has varied layouts across versions: stats directly on
  // the metric object vs nested under `values` (same defense as the parser).
  const pick = (metric, key) => (metric ? (metric.values ?? metric)[key] : undefined);

  const k6P50 = pick(signups, "p(50)") ?? pick(signups, "med");
  const k6P95 = pick(signups, "p(95)");
  const k6P99 = pick(signups, "p(99)");
  const k6Avg = pick(signups, "avg");
  const k6Max = pick(signups, "max");
  const k6Total = pick(reqs, "count");
  const k6Rps = pick(reqs, "rate");
  const k6FailRate = pick(failed, "value") ?? pick(failed, "rate") ?? 0;

  const round2 = (x) => Math.round(x * 100) / 100;
  const eq = (a, b) => Math.abs(a - b) < 0.011; // 10ms tolerance for ms floats
  check("p50 == k6 p(50)", eq(mapped.metrics.p50, k6P50), `convex=${round2(mapped.metrics.p50)} k6=${round2(k6P50)}`);
  check("p95 == k6 p(95)", eq(mapped.metrics.p95, k6P95), `convex=${round2(mapped.metrics.p95)} k6=${round2(k6P95)}`);
  check("p99 == k6 p(99)", eq(mapped.metrics.p99, k6P99), `convex=${round2(mapped.metrics.p99)} k6=${round2(k6P99)}`);
  check("average == k6 avg", eq(mapped.metrics.latencyAvgMs, k6Avg), `convex=${round2(mapped.metrics.latencyAvgMs)} k6=${round2(k6Avg)}`);
  check("max == k6 max", eq(mapped.metrics.latencyMaxMs, k6Max), `convex=${round2(mapped.metrics.latencyMaxMs)} k6=${round2(k6Max)}`);
  check("total requests == k6 http_reqs.count", mapped.metrics.totalRequests === k6Total, `convex=${mapped.metrics.totalRequests} k6=${k6Total}`);
  check("rps == k6 http_reqs.rate", eq(mapped.metrics.maxRps, k6Rps), `convex=${round2(mapped.metrics.maxRps)} k6=${round2(k6Rps)}`);
  check("failed/error_rate == k6 http_req_failed", eq(mapped.metrics.errorRate, k6FailRate), `convex=${round2(mapped.metrics.errorRate * 100)}% k6=${round2(k6FailRate * 100)}%`);
  check("failed_requests == round(error_rate * total)", mapped.metrics.totalFailures === Math.round(k6FailRate * k6Total), `convex=${mapped.metrics.totalFailures}`);
}

// --- 5. Verdict + provenance report -------------------------------------------

check("threshold status present", raw.threshold_status === "PASS" || raw.threshold_status === "FAIL", raw.threshold_status);
check("plan round-trips verbatim", raw.plan?.target_vus === 5 && raw.plan?.duration === "5s" && raw.plan?.selected_endpoints?.[0] === "/products");
check("correlation id traceable in plan assumptions", JSON.stringify(raw.plan?.assumptions ?? []).includes(correlationId));

console.log("\n================ LIVE_K6 PROVENANCE CHAIN ================");
console.log(`correlationId      : ${correlationId}`);
console.log(`externalRunId      : ${externalRunId}`);
console.log(`engine             : k6 (${K6_BINARY.split("/").pop()})`);
console.log(`artifact           : results.json (present=${!!artifactPath})`);
console.log(`source             : k6 --summary-export`);
console.log(`executed plan      : ${raw.plan?.objective_type} ${raw.plan?.target_vus} VUs / ${raw.plan?.duration} / ${raw.plan?.selected_endpoints?.join(",")}`);
console.log(`target             : ${raw.target_base_url} (controlled demo API)`);
console.log(`metrics (k6-derived): p50=${Math.round(mapped.metrics.p50)}ms p95=${Math.round(mapped.metrics.p95)}ms p99=${Math.round(mapped.metrics.p99)}ms avg=${Math.round(mapped.metrics.latencyAvgMs)}ms max=${Math.round(mapped.metrics.latencyMaxMs)}ms`);
console.log(`throughput         : ${mapped.metrics.totalRequests} requests, ${Math.round(mapped.metrics.maxRps * 10) / 10} rps`);
console.log(`errors             : ${mapped.metrics.totalFailures} failed (${(mapped.metrics.errorRate * 100).toFixed(2)}%)`);
console.log(`threshold status   : ${raw.threshold_status}`);
console.log(`persisted shape    : executionMode=live_k6 engineMode=live_k6 verdictLabel=${raw.threshold_status} analyzer=k6`);
console.log(`completedAt        : ${mapped.provenance.completedAt}`);
console.log("==========================================================\n");

console.log(failures === 0 ? "ALL CHECKS PASSED — LIVE_K6 chain proven end-to-end (local execution plane)." : `${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
