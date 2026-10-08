/**
 * Phase 10 — REAL LIVE_K6 REGRESSION VALIDATION (§17).
 *
 * Runs two real k6 executions through the local execution plane on the
 * CONTROLLED demo API (§18: no public targets):
 *
 *   BASELINE   (demo mode: normal)  → live run
 *   controlled change (demo mode: db_latency — the §17 "controlled
 *   difference introduced between runs")
 *   CANDIDATE  (same plan, same target, same VUs, same duration)
 *   deterministic regression analysis (the product engine, core.ts)
 *   AI interpretation (skipped here — LLM proven separately; the analyst
 *   action is exercised by the unit tests and the deployed app)
 *
 * Every reported delta is VERIFIED against the actual stored run metrics
 * (the mapped metrics the product would persist).
 *
 * Usage: bun scripts/phase10-regression-validation.mjs
 * Env:   BRIDGE_URL (default http://127.0.0.1:8002), K6_BINARY
 */
import { serializePlan, mapBackendResult, validateBackendResult } from "../src/convex/executor/contract.ts";
import { makeBridgeClient } from "../src/convex/executor/client.ts";
import { computeDeterministicRegression, DEFAULT_REGRESSION_POLICY } from "../src/convex/regression/core.ts";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:8002";
const TOKEN = process.env.EXECUTION_BRIDGE_TOKEN ?? "";
const TARGET = "http://127.0.0.1:8080";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setDemoMode(mode) {
  const res = await fetch(`${TARGET}/demo/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error(`demo mode switch failed: ${res.status}`);
  return (await res.json()).mode;
}

/** Run one LIVE_K6 execution via the real bridge client + real k6. */
async function runLive(label, plan) {
  console.log(`\n--- ${label}: submitting approved plan (fixed_load ${plan.targetVus} VUs / ${plan.duration} / ${plan.selectedEndpoints.join(",")}) ---`);
  const client = makeBridgeClient({ baseUrl: BRIDGE_URL, token: TOKEN || undefined, timeoutMs: 30_000 });
  const correlationId = `p10-${label}-${Date.now()}`;
  const request = serializePlan(plan, TARGET, correlationId, "phase10-regression-validation");
  const outcome = await client.submit(request);
  const externalRunId = outcome.externalRunId;
  console.log(`    externalRunId=${externalRunId}`);

  const deadline = Date.now() + 120_000;
  let status = null;
  while (Date.now() < deadline) {
    const s = await client.getStatus(externalRunId);
    status = s.status;
    if (["COMPLETED", "EXECUTION_ERROR", "CANCELLED"].includes(status)) break;
    await sleep(1500);
  }
  if (status !== "COMPLETED") throw new Error(`${label} run did not complete: ${status}`);

  const raw = await client.getResult(externalRunId);
  validateBackendResult(raw);
  // Map exactly as the product poller does → the "stored run" shape the
  // regression engine consumes in production.
  const mapped = mapBackendResult(raw, plan, correlationId);
  const storedRun = {
    _id: `local-${label}-${externalRunId}`,
    status: "completed",
    executionMode: "live_k6",
    engineMode: "live_k6",
    thresholdStatus: mapped.thresholdStatus,
    targetBaseUrl: raw.target_base_url ?? TARGET,
    plan,
    metrics: mapped.metrics,
    externalResult: raw,
  };
  console.log(`    completed: p95=${mapped.metrics.p95}ms avg=${mapped.metrics.latencyAvgMs}ms rps=${Math.round(mapped.metrics.maxRps * 10) / 10} err=${(mapped.metrics.errorRate * 100).toFixed(2)}%`);
  return storedRun;
}

// --- the approved deterministic plan (small + safe; controlled demo API) ------

const PLAN = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "8s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: ["phase 10 regression validation: identical plan on both sides of the controlled change"],
};

console.log(`bridge: ${BRIDGE_URL}  target: controlled demo API (${TARGET})`);

// 0. Safety: start from a known demo state.
await setDemoMode("normal");

// 1. BASELINE — demo API in `normal` mode.
let baseline;
try {
  baseline = await runLive("baseline", PLAN);
} catch (e) {
  check("BASELINE live run", false, e.message);
  process.exit(1);
}

// 2. THE CONTROLLED CHANGE (§17) — slow product reads deterministically.
const newMode = await setDemoMode("db_latency");
check("controlled demo difference applied", newMode === "db_latency", `demo mode=${newMode}`);

// 3. CANDIDATE — identical workload, changed target behavior.
let candidate;
try {
  candidate = await runLive("candidate", PLAN);
} catch (e) {
  check("CANDIDATE live run", false, e.message);
  await setDemoMode("normal");
  process.exit(1);
}

// 4. restore the demo API.
await setDemoMode("normal");

// 5. DETERMINISTIC REGRESSION ANALYSIS — the product engine.
const regression = computeDeterministicRegression(baseline, candidate, DEFAULT_REGRESSION_POLICY);

console.log("\n================ DETERMINISTIC REGRESSION OBJECT ================");
console.log(`baselineRunId : ${regression.baselineRunId}`);
console.log(`candidateRunId: ${regression.candidateRunId}`);
console.log(`compatibility : ${regression.compatibility}${regression.compatibilityReasons.length ? ` (${regression.compatibilityReasons.join("; ")})` : ""}`);
console.log(`policyVersion : ${regression.policyVersion}`);
for (const [name, d] of Object.entries(regression.metrics)) {
  const pct = d.percentageDelta === null ? "—" : `${d.percentageDelta > 0 ? "+" : ""}${d.percentageDelta.toFixed(2)}%`;
  console.log(`  ${String(name).padEnd(13)} ${JSON.stringify(d.baseline)} → ${JSON.stringify(d.candidate)}  Δ=${d.absoluteDelta?.toFixed(3)}  Δ%=${pct}`);
}
console.log(`status        : ${regression.status}`);
console.log(`breaches      : ${regression.breaches.length ? regression.breaches.join(" | ") : "(none)"}`);
console.log("==================================================================\n");

// 6. §17 VERIFICATION: every reported delta must equal the stored metrics.
check("compatibility is COMPATIBLE (same target/VUs/duration/endpoints/thresholds)", regression.compatibility === "COMPATIBLE", regression.compatibilityReasons.join("; "));
// db_latency adds ~150ms per request. In a CLOSED fixed-VU workload added
// per-request latency necessarily reduces completed requests/sec, so the
// deterministic engine MUST classify MULTIPLE_REGRESSIONS: the latency
// breaches AND the throughput breach are both honest, policy-derived
// consequences of the single controlled change (§17).
check(
  "status is MULTIPLE_REGRESSIONS (latency regression + closed-model throughput consequence)",
  regression.status === "MULTIPLE_REGRESSIONS" &&
    regression.breaches.some((b) => b.startsWith("p95 latency")) &&
    regression.breaches.some((b) => b.startsWith("rps ")),
  regression.status,
);
check("no error-rate breach is claimed (errorRate 0 → 0)", !regression.breaches.some((b) => b.startsWith("error rate")));
check(
  "breach set is exactly the 5 latency metrics + rps (nothing else fires)",
  regression.breaches.length === 6 &&
    regression.breaches.every((b) => /^(p50|p95|p99|average|max) latency /.test(b) || b.startsWith("rps ")),
  `${regression.breaches.length} breaches`,
);

const eq = (a, b, tol = 0.011) => a !== null && b !== null && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 0.0015);
for (const [name, bm, cm] of [
  ["p50", baseline.metrics.p50, candidate.metrics.p50],
  ["p95", baseline.metrics.p95, candidate.metrics.p95],
  ["p99", baseline.metrics.p99, candidate.metrics.p99],
  ["average", baseline.metrics.latencyAvgMs, candidate.metrics.latencyAvgMs],
  ["max", baseline.metrics.latencyMaxMs, candidate.metrics.latencyMaxMs],
  ["rps", baseline.metrics.maxRps, candidate.metrics.maxRps],
]) {
  const d = regression.metrics[name];
  check(
    `${name} delta matches stored run metrics (baseline=${bm} candidate=${cm})`,
    eq(d.baseline, bm) && eq(d.candidate, cm) && eq(d.absoluteDelta, cm - bm),
    `engine Δ=${d.absoluteDelta?.toFixed(3)}`,
  );
}
const p95pct = ((candidate.metrics.p95 - baseline.metrics.p95) / baseline.metrics.p95) * 100;
check(
  "p95 percentage delta matches stored metrics",
  regression.metrics.p95.percentageDelta !== null && Math.abs(regression.metrics.p95.percentageDelta - p95pct) < 0.01,
  `engine=${regression.metrics.p95.percentageDelta?.toFixed(2)}% stored=${p95pct.toFixed(2)}%`,
);
check(
  "p95 latency exceeds the +10% policy threshold (classification justified)",
  p95pct > DEFAULT_REGRESSION_POLICY.latencyRegressionThresholdPct,
  `+${p95pct.toFixed(1)}% vs +${DEFAULT_REGRESSION_POLICY.latencyRegressionThresholdPct}%`,
);
const ep = regression.endpointResults[0];
check(
  "endpoint row for /products matches stored per-endpoint evidence",
  !!ep && ep.endpoint === "/products" && eq(ep.p95.baseline, baseline.externalResult.metrics.per_endpoint[0].p95_ms),
  ep ? `p95 Δ=${ep.p95.absoluteDelta?.toFixed(3)}ms` : "(no row)",
);
check("no subjective wording enters the deterministic object", !JSON.stringify(regression).match(/\b(good|bad|better|worse|score)\b/i));

console.log("\n================ §17 REAL LIVE_K6 REGRESSION VALIDATION ================");
console.log(`baselineRunId (local reference): ${regression.baselineRunId}`);
console.log(`candidateRunId (local reference): ${regression.candidateRunId}`);
console.log(`controlled change: demo-api mode normal → db_latency (BASELINE → CANDIDATE)`);
console.log(`classification: ${regression.status}`);
console.log(`p95: ${baseline.metrics.p95}ms → ${candidate.metrics.p95}ms (${regression.metrics.p95.percentageDelta?.toFixed(2)}%)`);
console.log("next: AI interpretation runs downstream on this object (validated, interpretation-only)");
console.log("========================================================================\n");

console.log(failures === 0 ? "ALL CHECKS PASSED — deterministic regression verified against real LIVE_K6 runs." : `${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
