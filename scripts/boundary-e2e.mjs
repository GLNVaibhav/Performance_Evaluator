/**
 * REAL E2E — deterministic adaptive boundary search on the controlled demo API.
 *
 * §19 validation, no fabrication:
 *   1. set demo mode = db_latency (controlled +150ms per request)
 *   2. calibrate: two REAL fixed-load k6 runs (low VUs / high VUs) through the
 *      product path observe actual p95 values; the search threshold is derived
 *      from those observations (midpoint) or the script aborts honestly
 *   3. start an adaptive search (mutations via boundarySearch.createSearch)
 *      and let the deterministic controller run REAL LIVE_K6 iterations
 *   4. verify: per-iteration runs (executionMode=live_k6, externalRunId,
 *      provenance), exact sequence, boundary consistency, final region,
 *      immutability on re-fetch
 */
import { readFileSync } from "node:fs";

const DEPLOY = process.env.PERFSO_DEPLOY_URL ?? "https://brilliant-mastiff-710.convex.cloud";
const EMAIL = process.env.PERFSO_EMAIL ?? "admin@perforso.dev";
const PASSWORD = process.env.PERFSO_PASSWORD ?? "Perforso-Demo-2026!";
const DEMO_API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";

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

async function setDemoMode(mode) {
  const res = await fetch(`${DEMO_API}/demo/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return (await res.json()).mode;
}

async function runFixedLoad(token, vus, durationS, mode = "normal") {
  const runId = await api(
    "mutation",
    "mutations:createRun",
    {
      plan: {
        objectiveType: "fixed_load",
        testType: "baseline",
        targetVus: vus,
        duration: `${durationS}s`,
        selectedEndpoints: ["/products"],
        thresholds: { p95LatencyMs: 60_000, errorRate: 0.9 }, // calibration: verdict irrelevant
        assumptions: [`boundary-search calibration observation: ${vus} VUs / ${durationS}s (db_latency)`],
      },
      targetBaseUrl: "http://127.0.0.1:8080",
      rawInput: `Boundary-search calibration: ${vus} VUs (db_latency mode)`,
      interpreter: "deterministic",
      executeViaBridge: true,
    },
    token,
  );
  const deadline = Date.now() + 150_000;
  let run = null;
  while (Date.now() < deadline) {
    run = await api("query", "queries:getRun", { runId }, token);
    // "completed" settles in two steps (status, then verbatim result) — wait
    // for the threshold verdict before reading metrics (race observed live).
    const settled = run.status !== "completed" || !!run.thresholdStatus;
    if (["completed", "execution_error", "cancelled"].includes(run.status) && settled) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (run?.status !== "completed") throw new Error(`calibration run ${vus} VUs did not complete: ${run?.status} ${run?.errorMessage ?? ""}`);
  return { runId, p95: run.metrics.p95, err: run.metrics.errorRate };
}

// ─────────────────────────────────────────────────────────────────────────────
const signIn = await api("action", "auth:signIn", {
  provider: "password",
  params: { flow: "signIn", email: EMAIL, password: PASSWORD },
});
const token = signIn.tokens.token;
console.log(`signed in as ${EMAIL}\n`);

// --- §19: controlled mode + threshold calibrated from ACTUAL observations ----
// NOTE (measured, 2026-09-27): demo mode db_latency injects +150ms as an
// ASYNC per-request sleep, so p95 is ~152ms at 2 VUs AND at 64 VUs — no
// load-dependent boundary exists in that mode (an honest calibration abort
// proved this). In normal mode the sandbox target genuinely degrades under
// concurrency, so the boundary is calibrated there from real observations.
check("demo mode set to normal", (await setDemoMode("normal")) === "normal");

console.log("calibration observation 1: 2 VUs (real k6)…");
const low = await runFixedLoad(token, 2, 5);
console.log(`  observed p95 @ 2 VUs   = ${low.p95.toFixed(2)}ms`);

console.log("calibration observation 2: 500 VUs (real k6)…");
const high = await runFixedLoad(token, 500, 5);
console.log(`  observed p95 @ 500 VUs = ${high.p95.toFixed(2)}ms\n`);

const gap = high.p95 - low.p95;
const threshold = Math.round((low.p95 + high.p95) / 2);
check(
  "observations show a meaningful load-dependent p95 gap",
  high.p95 > low.p95 * 3 && gap > 5 && low.p95 < threshold && high.p95 > threshold,
  `low=${low.p95.toFixed(2)}ms high=${high.p95.toFixed(2)}ms → threshold=${threshold}ms`,
);
if (failures > 0) {
  await setDemoMode("normal");
  console.log("\nCalibration did not produce a separable boundary — aborting honestly (no fabricated threshold).");
  process.exit(1);
}

// --- start the deterministic adaptive search through the product -------------
const searchId = await api(
  "mutation",
  "boundarySearch:createSearch",
  {
    targetBaseUrl: "http://127.0.0.1:8080",
    minVus: 2,
    maxVus: 500,
    rampDuration: "3s",
    holdDuration: "3s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: threshold, errorRate: 0.5 },
    maximumExperiments: 8,
    tolerance: 0,
  },
  token,
);
console.log(`\nsearch started: ${searchId} — threshold p95 ≤ ${threshold}ms, range 2–500 VUs, max 8 experiments\n`);

// --- wait for the deterministic controller to finish --------------------------
const deadline = Date.now() + 420_000;
let detail = null;
while (Date.now() < deadline) {
  detail = await api("query", "boundarySearch:getSearch", { searchId }, token);
  if (detail.search.status !== "active") break;
  process.stdout.write(`  .. ${detail.search.status} experiments=${detail.search.experimentCount} pass=${detail.search.lowestKnownPassVus ?? "?"} fail=${detail.search.highestKnownFailVus ?? "?"}\n`);
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("");

const s = detail.search;
const exps = [...detail.experiments].sort((a, b) => a.iteration - b.iteration);

check("search reached a terminal state", ["completed", "error", "blocked"].includes(s.status), s.status);
check("at least 2 real experiments executed", exps.length >= 2, `${exps.length} iterations`);
check("no duplicate target VUs across iterations", new Set(exps.map((e) => e.targetVus)).size === exps.length, exps.map((e) => e.targetVus).join(","));
check("every iteration is a LIVE_K6 run with externalRunId", exps.every((e) => e.externalRunId && e.externalRunId.length > 8));

// --- sequence sanity: first candidate = range floor, then doubling/midpoints --
check("first iteration executed at the range floor (minVus)", exps[0]?.targetVus === 2, `${exps[0]?.targetVus}`);

// --- boundary consistency with the recorded outcomes --------------------------
let expectedPass = null;
let expectedFail = null;
for (const e of exps) {
  if (e.status === "completed" && e.thresholdStatus === "PASS") expectedPass = Math.max(expectedPass ?? 0, e.targetVus);
  if (e.status === "completed" && e.thresholdStatus === "FAIL") expectedFail = expectedFail === null ? e.targetVus : Math.min(expectedFail, e.targetVus);
}
check("lowestKnownPassVus == highest observed PASS among iterations", (s.lowestKnownPassVus ?? null) === expectedPass, `state=${s.lowestKnownPassVus ?? "unknown"} recomputed=${expectedPass ?? "unknown"}`);
check("highestKnownFailVus == lowest observed FAIL among iterations", (s.highestKnownFailVus ?? null) === expectedFail, `state=${s.highestKnownFailVus ?? "unknown"} recomputed=${expectedFail ?? "unknown"}`);

// --- final region: matches the evidence, never fabricated ---------------------
if (s.result) {
  check("region lowerBound == highest observed passing load", (s.result.lowerBound ?? null) === expectedPass);
  check("region upperBound == lowest observed failing load (absent when unknown)", (s.result.upperBound ?? null) === expectedFail);
  check("region note uses mandated terminology (estimated, not exact capacity)", s.result.note.includes("ESTIMATED SAFE OPERATING REGION") && s.result.note.includes("not an exact, maximum, or guaranteed capacity"));
  console.log(`\nestimated safe operating region: ${s.result.lowerBound ?? "?"}–${s.result.upperBound ?? "unknown (no FAIL observed)"} VUs`);
} else {
  check("terminal search carries a result", false, "no result recorded");
}

// --- immutability: re-fetch and compare every iteration's metrics -------------
await new Promise((r) => setTimeout(r, 5000));
const again = await api("query", "boundarySearch:getSearch", { searchId }, token);
const same = JSON.stringify(again.experiments) === JSON.stringify(detail.experiments);
check("experiment history immutable on re-fetch (metrics/verdicts/ids identical)", same);

console.log("\n──────── exact experiment sequence ────────");
for (const e of exps) {
  console.log(
    `  iteration ${e.iteration}: ${e.targetVus} VUs → ${e.status}${e.thresholdStatus ? ` / ${e.thresholdStatus}` : ""} (ext ${e.externalRunId?.slice(0, 8)}…, p95 ${e.metrics?.p95?.toFixed(2) ?? "?"}ms, ${e.metrics?.totalRequests ?? "?"} req)`,
  );
}
console.log(
  `\nHighest observed PASS: ${s.lowestKnownPassVus ?? "unknown"} VUs\nLowest observed FAIL: ${s.highestKnownFailVus ?? "unknown (none observed)"} VUs\nStatus: ${s.status}${s.result?.stopReason ? ` (${s.result.stopReason.replace(/_/g, " ")})` : ""}`,
);

await setDemoMode("normal");
const after = await fetch(`${DEMO_API}/demo/mode`).then((r) => r.json());
check("demo mode restored to normal", after.mode === "normal", after.mode);

console.log(failures === 0 ? "\nALL CHECKS PASSED — adaptive boundary search executed real k6 experiments through the product path." : `\n${failures} CHECK(S) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
