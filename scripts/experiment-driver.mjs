/**
 * REAL PERFORMANCE EXPERIMENTATION — controlled experiment driver (Phases 2–6).
 *
 * Every experiment is executed through the REAL product path:
 *   deployed Convex mutations:createRun {executeViaBridge:true}
 *     → internal.executor.submitExecutionRun (Convex cloud)
 *     → public HTTPS ingress (cloudflared tunnel) → FastAPI
 *     → RealK6PerformanceEngine → real k6 v2.2.0 subprocess
 *     → controlled demo API → results.json → backend metrics parser
 *     → Convex poll → saveLiveResult (verbatim) → queries:getRun
 *
 * Per experiment the driver verifies the four metric layers carry the SAME
 * values: raw k6 results.json == FastAPI TestResult == Convex externalResult
 * == Convex mapped metrics. No layer is allowed to invent or alter numbers.
 *
 * Phase selection (one phase per invocation; experiments are real k6 runs):
 *   PHASE=2  fixed-load A/B/C        (5VU/5s, 10VU/10s, 20VU/10s on /products)
 *   PHASE=3  weighted multi-endpoint (3:1 /products : /products/{product_id})
 *   PHASE=4  controlled failure      (normal, db_latency, error_injection, checkout_bottleneck)
 *   PHASE=5  one conservative stress (boundary_search 30 VUs, ramp 8s + hold 5s)
 *   PHASE=6  history immutability    (re-fetch every recorded experiment and
 *                                     deep-compare against the recorded snapshot)
 *
 * Usage: PHASE=2 bun scripts/experiment-driver.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { makeBridgeClient } from "../src/convex/executor/client.ts";

const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";
const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:8000";
const BRIDGE_TOKEN = process.env.EXECUTION_BRIDGE_TOKEN ?? "perforso-bridge-dev-token";
const TARGET = process.env.EXPERIMENT_TARGET ?? "http://127.0.0.1:8080";
const DEMO_API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";
const ARTIFACTS = process.env.K6_ARTIFACTS_DIR ?? "/home/daytona/codebase/backend/artifacts";
const STATE_FILE = new URL("./.experiment-state.json", import.meta.url).pathname;
const PHASE = process.env.PHASE ?? "2";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function section(t) {
  console.log(`\n──────── ${t} ────────`);
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

async function setDemoMode(mode) {
  const res = await fetch(`${DEMO_API}/demo/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const j = await res.json();
  if (!j.mode) throw new Error(`demo mode set failed: ${JSON.stringify(j)}`);
  return j.mode;
}

const STATE = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { experiments: [] };
function record(entry) {
  STATE.experiments.push(entry);
  writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2));
}

const pick = (metric, key) => (metric ? (metric.values ?? metric)[key] : undefined);
const eq = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

function k6Summary(externalRunId) {
  const p = `${ARTIFACTS}/${externalRunId}/results.json`;
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function k6CoreValues(k6) {
  const dur = k6.metrics.http_req_duration;
  const reqs = k6.metrics.http_reqs;
  const failed = k6.metrics.http_req_failed;
  return {
    p50: pick(dur, "p(50)") ?? pick(dur, "med"),
    p95: pick(dur, "p(95)"),
    p99: pick(dur, "p(99)"),
    avg: pick(dur, "avg"),
    max: pick(dur, "max"),
    total: pick(reqs, "count"),
    rps: pick(reqs, "rate"),
    err: pick(failed, "value") ?? pick(failed, "rate") ?? 0,
  };
}

async function verifyProvenanceChain(run, label) {
  const k6 = k6Summary(run.externalRunId);
  check(`${label}: raw k6 results.json artifact exists`, !!k6, run.externalRunId);
  if (!k6) return null;
  const k = k6CoreValues(k6);

  const client = makeBridgeClient({ baseUrl: BRIDGE_URL, token: BRIDGE_TOKEN, timeoutMs: 20_000 });
  const fastapi = await client.getResult(run.externalRunId);
  check(`${label}: FastAPI TestResult retrievable`, !!fastapi?.metrics);

  // Layer 1 == Layer 2: FastAPI TestResult == raw k6
  check(`${label}: FastAPI p50_ms == k6 p(50)`, eq(fastapi.metrics.p50_ms, k.p50));
  check(`${label}: FastAPI p95_ms == k6 p(95)`, eq(fastapi.metrics.p95_ms, k.p95));
  check(`${label}: FastAPI p99_ms == k6 p(99)`, eq(fastapi.metrics.p99_ms, k.p99));
  check(`${label}: FastAPI average_ms == k6 avg`, eq(fastapi.metrics.average_ms, k.avg));
  check(`${label}: FastAPI max_ms == k6 max`, eq(fastapi.metrics.max_ms, k.max));
  check(`${label}: FastAPI total_requests == k6 count`, fastapi.metrics.total_requests === k.total);
  check(`${label}: FastAPI rps == k6 rate`, eq(fastapi.metrics.rps, k.rps));
  check(`${label}: FastAPI error_rate == k6 failed`, eq(fastapi.metrics.error_rate, k.err));

  // Layer 2 == Layer 3: Convex externalResult (verbatim copy) == FastAPI
  const c = run.externalResult;
  check(`${label}: Convex externalResult present`, !!c?.metrics);
  if (c?.metrics) {
    check(`${label}: Convex externalResult.threshold_status verbatim`, c.threshold_status === fastapi.threshold_status);
    check(`${label}: Convex externalResult.metrics.total_requests verbatim`, c.metrics.total_requests === fastapi.metrics.total_requests);
    check(`${label}: Convex externalResult.metrics.p95_ms verbatim`, eq(c.metrics.p95_ms, fastapi.metrics.p95_ms));
    check(`${label}: Convex externalResult.metrics.error_rate verbatim`, eq(c.metrics.error_rate, fastapi.metrics.error_rate));
  }

  // Layer 3 == Layer 1: Convex mapped metrics == raw k6
  const m = run.metrics;
  check(`${label}: Convex p50 == k6`, eq(m.p50, k.p50));
  check(`${label}: Convex p95 == k6`, eq(m.p95, k.p95));
  check(`${label}: Convex p99 == k6`, eq(m.p99, k.p99));
  check(`${label}: Convex latencyAvgMs == k6 avg`, eq(m.latencyAvgMs, k.avg));
  check(`${label}: Convex latencyMaxMs == k6 max`, eq(m.latencyMaxMs, k.max));
  check(`${label}: Convex totalRequests == k6 count`, m.totalRequests === k.total);
  check(`${label}: Convex maxRps == k6 rate`, eq(m.maxRps, k.rps));
  check(`${label}: Convex errorRate == k6 failed`, eq(m.errorRate, k.err));
  check(`${label}: Convex thresholdStatus == backend verdict`, run.thresholdStatus === fastapi.threshold_status);
  return k;
}

async function runExperiment(label, plan, opts = {}) {
  section(`EXPERIMENT ${label}`);
  console.log(
    `plan: ${plan.objectiveType} ${plan.targetVus}VUs ${
      plan.duration ?? `ramp ${plan.rampDuration} + hold ${plan.holdDuration}`
    } [${plan.selectedEndpoints.join(", ")}]` +
      (plan.endpointWeights ? ` weights=${JSON.stringify(plan.endpointWeights)}` : ""),
  );

  const runId = await api(
    "mutation",
    "mutations:createRun",
    {
      plan,
      targetBaseUrl: TARGET,
      rawInput: opts.rawInput ?? `Experiment ${label} (controlled demo API)`,
      interpreter: "deterministic",
      executeViaBridge: true,
    },
    token,
  );
  console.log(`convex runId: ${runId}`);

  const deadline = Date.now() + 150_000;
  let run = null;
  while (Date.now() < deadline) {
    run = await api("query", "queries:getRun", { runId }, token);
    if (["completed", "execution_error", "cancelled"].includes(run.status)) break;
    process.stdout.write(`  .. ${run.status} ext=${run.externalRunId ?? "pending"}\n`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("");

  check(`${label}: run reached terminal state`, ["completed", "execution_error", "cancelled"].includes(run.status), run.status);
  check(`${label}: status completed`, run.status === "completed", run.errorMessage ?? "");
  check(`${label}: executionMode === live_k6`, run.executionMode === "live_k6", run.executionMode ?? "(unset)");
  check(`${label}: engineMode === live_k6`, run.engineMode === "live_k6", run.engineMode ?? "(unset)");
  check(`${label}: analyzer is the backend (k6), no LLM narrative`, run.analyzer === "k6", run.analyzer ?? "(none)");
  const p = run.liveProvenance;
  check(`${label}: provenance engine=k6 source=k6/results.json`, p?.engine === "k6" && p?.source === "k6/results.json");
  check(`${label}: provenance ids match`, p?.externalRunId === run.externalRunId && p?.correlationId === run.correlationId);

  if (run.status === "completed") {
    await verifyProvenanceChain(run, label);
    check(`${label}: requested VUs executed (peakVus === targetVus)`, run.metrics.peakVus === plan.targetVus, `${run.metrics.peakVus} vs ${plan.targetVus}`);
  }

  record({
    label,
    phase: PHASE,
    runId,
    externalRunId: run.externalRunId,
    correlationId: run.correlationId,
    requestedPlan: plan,
    target: TARGET,
    status: run.status,
    thresholdStatus: run.thresholdStatus ?? null,
    thresholdViolations: run.thresholdViolations ?? [],
    metrics: run.metrics ?? null,
    liveProvenance: run.liveProvenance ?? null,
    requestedVsObserved: opts.requestedVsObserved ?? null,
    finishedAt: run.finishedAt ?? null,
    createdAt: run.createdAt ?? null,
  });

  console.log(
    `result: ${run.status} threshold=${run.thresholdStatus ?? "—"} requests=${run.metrics?.totalRequests ?? "—"} ` +
      `p50=${run.metrics?.p50?.toFixed(2) ?? "—"}ms p95=${run.metrics?.p95?.toFixed(2) ?? "—"}ms ` +
      `p99=${run.metrics?.p99?.toFixed(2) ?? "—"}ms err=${((run.metrics?.errorRate ?? 0) * 100).toFixed(2)}%`,
  );
  return run;
}

// ---------------------------------------------------------------------------
let token;
const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
token = signIn.tokens.token;
console.log(`signed in as ${EMAIL} — PHASE=${PHASE}`);

if (PHASE === "2") {
  section("PHASE 2 — FIXED LOAD EXPERIMENTS (progressively increasing, conservative)");
  const base = { objectiveType: "fixed_load", testType: "baseline", selectedEndpoints: ["/products"] };
  const A = { ...base, targetVus: 5, duration: "5s", thresholds: { p95LatencyMs: 2000, errorRate: 0.5 }, assumptions: ["phase2 experiment A: 5 VUs / 5s / /products (controlled demo API)"] };
  const B = { ...base, targetVus: 10, duration: "10s", thresholds: { p95LatencyMs: 2000, errorRate: 0.5 }, assumptions: ["phase2 experiment B: 10 VUs / 10s / /products (controlled demo API)"] };
  const C = { ...base, targetVus: 20, duration: "10s", thresholds: { p95LatencyMs: 2000, errorRate: 0.5 }, assumptions: ["phase2 experiment C: 20 VUs / 10s / /products (controlled demo API)"] };
  const a = await runExperiment("A 5VU/5s", A);
  const b = await runExperiment("B 10VU/10s", B);
  const c = await runExperiment("C 20VU/10s", C);
  section("PHASE 2 — observed experiment table (factual record, no causal claims)");
  console.log(
    ["exp", "VUs", "dur", "requests", "rps", "p50", "p95", "p99", "avg", "max", "err%", "verdict"].join("\t"),
  );
  for (const [n, r, vus, dur] of [["A", a, 5, "5s"], ["B", b, 10, "10s"], ["C", c, 20, "10s"]]) {
    const m = r.metrics ?? {};
    console.log(
      [n, vus, dur, m.totalRequests, m.maxRps?.toFixed(2), m.p50?.toFixed(2), m.p95?.toFixed(2), m.p99?.toFixed(2), m.latencyAvgMs?.toFixed(2), m.latencyMaxMs?.toFixed(2), (m.errorRate * 100 ?? 0).toFixed(2), r.thresholdStatus].join("\t"),
    );
  }
  check("phase2: experiments produced distinct real request volumes", a.metrics.totalRequests !== b.metrics.totalRequests && b.metrics.totalRequests !== c.metrics.totalRequests, `${a.metrics.totalRequests}/${b.metrics.totalRequests}/${c.metrics.totalRequests}`);
}

if (PHASE === "3") {
  section("PHASE 3 — WEIGHTED MULTI-ENDPOINT (requested 3:1)");
  const plan = {
    objectiveType: "fixed_load",
    testType: "baseline",
    targetVus: 10,
    duration: "10s",
    selectedEndpoints: ["/products", "/products/{product_id}"],
    endpointWeights: { "/products": 3, "/products/{product_id}": 1 },
    thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
    assumptions: ["phase3: weighted dispatch 3:1 across /products and /products/{product_id} (controlled demo API)"],
  };
  const run = await runExperiment("weighted 3:1", plan);
  const per = run.externalResult?.metrics?.per_endpoint ?? [];
  const totalObs = per.reduce((s, e) => s + e.total_requests, 0);
  console.log(`\nrequested vs observed endpoint distribution (from k6 tagged submetrics):`);
  const shares = {};
  for (const e of per) {
    const share = totalObs > 0 ? e.total_requests / totalObs : 0;
    shares[e.endpoint] = share;
    const requested = plan.endpointWeights[e.endpoint] / 4; // 3+1 normalization
    console.log(
      `  ${e.endpoint}: requested=${(requested * 100).toFixed(1)}% observed=${(share * 100).toFixed(1)}% (${e.total_requests}/${totalObs}) p95=${e.p95_ms.toFixed(2)}ms err=${(e.error_rate * 100).toFixed(2)}%`,
    );
  }
  check("phase3: both endpoints observed with real requests", per.length === 2 && per.every((e) => e.total_requests > 0), per.map((e) => `${e.endpoint}=${e.total_requests}`).join(", "));
  check("phase3: observed /products share within ±0.15 of requested 0.75", shares["/products"] !== undefined && Math.abs(shares["/products"] - 0.75) < 0.15, `observed=${((shares["/products"] ?? 0) * 100).toFixed(1)}% (tolerance band, not an equality claim)`);
  check("phase3: Convex stored observed distribution verbatim (externalResult.per_endpoint)", JSON.stringify(per) === JSON.stringify(run.externalResult.metrics.per_endpoint));
}

if (PHASE === "4") {
  section("PHASE 4 — CONTROLLED FAILURE EXPERIMENTS (demo modes only)");
  const base = { objectiveType: "fixed_load", testType: "baseline", selectedEndpoints: ["/products"] };

  await setDemoMode("normal");
  await runExperiment("normal (control)", { ...base, targetVus: 5, duration: "5s", thresholds: { p95LatencyMs: 2000, errorRate: 0.5 }, assumptions: ["phase4 control: demo mode normal"] });

  await setDemoMode("db_latency");
  const db = await runExperiment("db_latency", { ...base, targetVus: 5, duration: "8s", thresholds: { p95LatencyMs: 50, errorRate: 0.5 }, assumptions: ["phase4: demo mode db_latency (150ms injected per request)"] });
  check("phase4 db_latency: threshold FAIL observed (p95 above 50ms)", db.thresholdStatus === "FAIL", `p95=${db.metrics?.p95?.toFixed(2)}ms`);
  check("phase4 db_latency: violation localized to p95 with observed value", (db.thresholdViolations ?? []).some((v) => v.includes("p95")), (db.thresholdViolations ?? []).join("; "));

  await setDemoMode("error_injection");
  const err = await runExperiment("error_injection", { ...base, targetVus: 5, duration: "10s", thresholds: { p95LatencyMs: 2000, errorRate: 0.01 }, assumptions: ["phase4: demo mode error_injection (~30% 503s)"] });
  check("phase4 error_injection: threshold FAIL observed (error rate above 1%)", err.thresholdStatus === "FAIL", `err=${((err.metrics?.errorRate ?? 0) * 100).toFixed(2)}%`);
  const statuses = err.externalResult?.metrics?.status_codes ?? {};
  check("phase4 error_injection: observed 503s recorded as status evidence", (statuses["503"] ?? 0) > 0, JSON.stringify(statuses));

  await setDemoMode("checkout_bottleneck");
  const chk = await runExperiment("checkout_bottleneck", { objectiveType: "fixed_load", testType: "baseline", targetVus: 5, duration: "8s", selectedEndpoints: ["/checkout"], thresholds: { p95LatencyMs: 200, errorRate: 0.5 }, assumptions: ["phase4: demo mode checkout_bottleneck (800ms injected on /checkout)"] });
  check("phase4 checkout_bottleneck: threshold FAIL observed (p95 above 200ms)", chk.thresholdStatus === "FAIL", `p95=${chk.metrics?.p95?.toFixed(2)}ms`);

  await setDemoMode("normal");
  const after = await fetch(`${DEMO_API}/demo/mode`).then((r) => r.json());
  check("phase4: demo mode restored to normal after experiments", after.mode === "normal", after.mode);
  console.log(`\nNote: analyzer for every run is the deterministic backend (analyzer=k6) — no LLM narrative exists in these records, so no invented root cause is possible. Controlled-mode facts are recorded above as observed values only.`);
}

if (PHASE === "5") {
  section("PHASE 5 — ONE CONSERVATIVE STRESS EXPERIMENT (boundary_search contract)");
  const plan = {
    objectiveType: "boundary_search",
    testType: "stress",
    targetVus: 30,
    rampDuration: "8s",
    holdDuration: "5s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
    assumptions: ["phase5 stress experiment: single ramp 8s + hold 5s to 30 VUs (conservative ceiling) — NOT capacity discovery"],
  };
  const run = await runExperiment("stress 30VU r8+h5", plan);
  const scriptPath = `${ARTIFACTS}/${run.externalRunId}/script.js`;
  const script = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : null;
  check("phase5: k6 script artifact exists", !!script);
  if (script) {
    check("phase5: executed k6 stages = ramp(8s→30) + hold(5s→30), exactly two", script.includes("{ duration: '8s', target: 30 },") && script.includes("{ duration: '5s', target: 30 },") && (script.match(/duration: '/g) ?? []).length === 2, "single ramp+hold scenario per the frozen BoundarySearchPlan contract");
    check("phase5: single scenario (one VU-level experiment, no ladder)", (script.match(/executor: '/g) ?? []).length === 1);
  }
  const stored = run.externalResult?.plan;
  check("phase5: backend plan round-trips (boundary_search, ramp 8s, hold 5s)", stored?.objective_type === "boundary_search" && stored?.ramp_duration === "8s" && stored?.hold_duration === "5s");
  console.log(`\nSemantics: this is a STRESS EXPERIMENT (one VU-level ramp+hold run). No capacity claim is made or derivable from a single experiment.`);
}

if (PHASE === "6") {
  section("PHASE 6 — EXPERIMENT HISTORY IMMUTABILITY VERIFICATION");
  check("phase6: recorded experiment history exists", STATE.experiments.length >= 5, `${STATE.experiments.length} recorded`);

  // Canonical, key-order-insensitive comparison of the VALUE content (Convex
  // documents serialize object keys in schema order, so raw JSON.stringify
  // comparison would produce false diffs). Same fields, same values required.
  const planKey = (p) =>
    JSON.stringify(
      p
        ? {
            objectiveType: p.objectiveType,
            testType: p.testType,
            targetVus: p.targetVus,
            duration: p.duration ?? null,
            rampDuration: p.rampDuration ?? null,
            holdDuration: p.holdDuration ?? null,
            selectedEndpoints: p.selectedEndpoints,
            endpointWeights: p.endpointWeights ?? null,
            thresholds: {
              p95LatencyMs: p.thresholds?.p95LatencyMs,
              errorRate: p.thresholds?.errorRate,
            },
            assumptions: p.assumptions,
          }
        : null,
    );
  const metricsKey = (m) =>
    JSON.stringify(
      m
        ? {
            totalRequests: m.totalRequests,
            totalFailures: m.totalFailures,
            errorRate: m.errorRate,
            p50: m.p50,
            p95: m.p95,
            p99: m.p99,
            maxRps: m.maxRps,
            peakVus: m.peakVus,
            iterations: m.iterations,
            latencyAvgMs: m.latencyAvgMs ?? null,
            latencyMaxMs: m.latencyMaxMs ?? null,
          }
        : null,
    );
  const provKey = (v) =>
    JSON.stringify(
      v
        ? {
            engine: v.engine,
            externalRunId: v.externalRunId,
            source: v.source,
            completedAt: v.completedAt,
            correlationId: v.correlationId,
            artifactPresent: v.artifactPresent,
            backendSummary: v.backendSummary ?? null,
          }
        : null,
    );

  let immutable = true;
  for (const rec of STATE.experiments) {
    const current = await api("query", "queries:getRun", { runId: rec.runId }, token);
    const fields = {
      plan: planKey(current?.plan) === planKey(rec.requestedPlan),
      metrics: metricsKey(current?.metrics) === metricsKey(rec.metrics),
      thresholdStatus: (current?.thresholdStatus ?? null) === rec.thresholdStatus,
      externalRunId: (current?.externalRunId ?? null) === rec.externalRunId,
      correlationId: (current?.correlationId ?? null) === rec.correlationId,
      provenance: provKey(current?.liveProvenance) === provKey(rec.liveProvenance),
    };
    const ok = Object.values(fields).every(Boolean);
    if (!ok) immutable = false;
    check(
      `history: ${rec.label} record unchanged since execution`,
      ok,
      Object.entries(fields)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(",") || "all fields identical (value-wise)",
    );
  }
  check("phase6: full history is immutable and reconstructable", immutable);
}

console.log(
  failures === 0
    ? `\nALL CHECKS PASSED — PHASE ${PHASE} complete (real k6 executions, verbatim provenance).`
    : `\n${failures} CHECK(S) FAILED — PHASE ${PHASE}.`,
);
process.exit(failures === 0 ? 0 : 1);
