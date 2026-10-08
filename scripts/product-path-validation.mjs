/**
 * Phase 13 — PRODUCT-PATH validation: a LIVE_K6 run executed entirely through
 * the deployed Convex control plane (the same functions the Freebuff UI
 * calls), against the local execution plane via the ingress relay.
 *
 * Flow: auth:signIn → mutations:createRun {executeViaBridge: true}
 *       → scheduled internal.executor.submitExecutionRun (Convex cloud → relay → FastAPI)
 *       → scheduled pollExecutionRun loop → executorDb.saveLiveResult
 *       → queries:getRun (what the UI renders)
 *
 * Usage: bun scripts/product-path-validation.mjs
 */
const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function api(kind, path, args, token) {
  const res = await fetch(`${DEPLOY}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const j = await res.json();
  if (j.status !== "success") throw new Error(`${path} failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j.value;
}

const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
console.log(`signed in as ${EMAIL}\n`);

// Approved deterministic plan (same small-safe baseline as the local E2E;
// target = the controlled demo API, reachable from the execution plane).
const APPROVED_PLAN = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "5s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: ["product-path LIVE_K6 validation via Convex control plane"],
};

const runId = await api(
  "mutation",
  "mutations:createRun",
  {
    plan: APPROVED_PLAN,
    targetBaseUrl: "http://127.0.0.1:8080",
    rawInput: "Baseline /products with 5 users for 5s on the demo API (LIVE_K6 validation)",
    interpreter: "deterministic",
    executeViaBridge: true,
  },
  token,
);
console.log(`convex runId: ${runId}\n`);

const deadline = Date.now() + 150_000;
let run = null;
while (Date.now() < deadline) {
  run = await api("query", "queries:getRun", { runId }, token);
  if (["completed", "execution_error", "cancelled"].includes(run.status)) break;
  process.stdout.write(`  .. ${run.status} ext=${run.externalRunId ?? "pending"}\n`);
  await new Promise((r) => setTimeout(r, 3000));
}

console.log("");
check("run reached a terminal state", ["completed", "execution_error", "cancelled"].includes(run.status), run.status);
check("status is completed", run.status === "completed", run.errorMessage ?? "");
check("executionMode === live_k6", run.executionMode === "live_k6", run.executionMode ?? "(unset)");
check("engineMode === live_k6", run.engineMode === "live_k6", run.engineMode ?? "(unset)");
check("externalRunId stored (FastAPI id)", typeof run.externalRunId === "string" && run.externalRunId.length > 8, run.externalRunId ?? "(none)");
check("correlationId stored", typeof run.correlationId === "string" && run.correlationId.length > 8, run.correlationId ?? "(none)");

const p = run.liveProvenance;
check("provenance: engine === k6", p?.engine === "k6", p?.engine ?? "(none)");
check("provenance: source === k6/results.json", p?.source === "k6/results.json", p?.source ?? "(none)");
check("provenance: externalRunId matches", p?.externalRunId === run.externalRunId);
check("provenance: artifactPresent", p?.artifactPresent === true);
check("provenance: correlationId matches", p?.correlationId === run.correlationId);

const m = run.metrics;
if (m) {
  console.log(`\nk6-derived metrics (Convex-persisted):`);
  console.log(`  totalRequests=${m.totalRequests} failed=${m.totalFailures} errorRate=${(m.errorRate * 100).toFixed(2)}%`);
  console.log(`  p50=${m.p50}ms p95=${m.p95}ms p99=${m.p99}ms avg=${m.latencyAvgMs}ms max=${m.latencyMaxMs}ms rps=${m.maxRps}`);
  check("metrics present and finite", [m.p50, m.p95, m.p99, m.maxRps, m.totalRequests].every((x) => Number.isFinite(x)));
  check("thresholdStatus present", run.thresholdStatus === "PASS" || run.thresholdStatus === "FAIL", run.thresholdStatus);
  check("verdictLabel is plain PASS/FAIL for LIVE_K6", run.verdictLabel === run.thresholdStatus, run.verdictLabel);
  check("analyzer records k6 provenance", run.analyzer === "k6", run.analyzer);
  const ext = run.externalResult;
  check("externalResult (backend TestResult) stored verbatim", !!ext && ext.metrics?.total_requests === m.totalRequests, `total_requests=${ext?.metrics?.total_requests}`);
  check("no probe/simulation contamination: no probeStats", run.probeStats === undefined, String(run.probeStats ?? ""));
  check("plan.targetVus === executed peakVus (5 VUs live)", m.peakVus === 5 && run.plan?.targetVus === 5);
} else {
  check("metrics present", false, "no metrics on completed run");
}

console.log(`\n================ PRODUCT-PATH VALIDATION ================`);
console.log(`convex runId       : ${runId}`);
console.log(`fastapi externalRunId: ${run.externalRunId ?? "(none)"}`);
console.log(`correlationId      : ${run.correlationId ?? "(none)"}`);
console.log(`status             : ${run.status} / threshold ${run.thresholdStatus ?? "—"}`);
console.log(`executionMode      : ${run.executionMode ?? "(none)"} / engineMode ${run.engineMode ?? "(none)"}`);
console.log(`UI would render    : LIVE_K6 badge · provenance panel · k6 metrics above`);
console.log(`view               : https://perfev.freebuff.app/app/runs/${runId}`);
console.log(`=========================================================\n`);

console.log(failures === 0 ? "ALL CHECKS PASSED — LIVE_K6 executed through the real Convex product path." : `${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
