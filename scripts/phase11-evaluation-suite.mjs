/**
 * Phase 11 — CONTROLLED EVALUATION SUITE RUNNER (real execution).
 *
 * Executes evaluation/suite.json: scenarios A–D plus the regression matrix,
 * each against the REAL execution plane (bridge + k6) and the controlled
 * demo API. Verifies, per scenario, the declared observable behavior and
 * evidence, and per matrix row, that the regression engine classifies
 * exactly what the stored evidence supports.
 *
 * Usage:
 *   bun scripts/phase11-evaluation-suite.mjs            # needs bridge+token
 *   EXECUTION_BRIDGE_TOKEN=... bun scripts/phase11-evaluation-suite.mjs
 */
import { readFileSync } from "node:fs";
import { serializePlan, mapBackendResult, validateBackendResult } from "../src/convex/executor/contract.ts";
import { makeBridgeClient } from "../src/convex/executor/client.ts";
import { computeDeterministicRegression, DEFAULT_REGRESSION_POLICY } from "../src/convex/regression/core.ts";

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://127.0.0.1:8002";
const TOKEN = process.env.EXECUTION_BRIDGE_TOKEN ?? "";
const TARGET = process.env.DEMO_API_URL ?? "http://127.0.0.1:8080";

const SUITE = JSON.parse(readFileSync(new URL("../evaluation/suite.json", import.meta.url), "utf8"));

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

function planOf(spec) {
  const base = SUITE.plan_defaults;
  const overrides = spec.test_plan === "plan_defaults" ? {} : SUITE.plan_overrides?.[spec.test_plan] ?? {};
  return { ...base, ...overrides };
}

/** One real LIVE_K6 run via the actual bridge client + k6. */
async function runLive(label, plan) {
  const client = makeBridgeClient({ baseUrl: BRIDGE_URL, token: TOKEN || undefined, timeoutMs: 30_000 });
  const correlationId = `p11-eval-${label}-${Date.now()}`;
  const request = serializePlan(plan, TARGET, correlationId, "phase11-evaluation-suite");
  const { externalRunId } = await client.submit(request);
  const deadline = Date.now() + 90_000;
  let status = null;
  while (Date.now() < deadline) {
    const s = await client.getStatus(externalRunId);
    status = s.status;
    if (["COMPLETED", "EXECUTION_ERROR", "CANCELLED"].includes(status)) break;
    await sleep(1500);
  }
  if (status !== "COMPLETED") throw new Error(`${label}: run did not complete (${status})`);
  const raw = await client.getResult(externalRunId);
  validateBackendResult(raw);
  return { raw, mapped: mapBackendResult(raw, plan, correlationId), externalRunId };
}

const inRange = (v, [lo, hi]) => v >= lo && v <= hi;

/** Verify one scenario's declared observables + evidence against a real run. */
async function runScenario(id, spec) {
  console.log(`\n--- scenario ${id} (demo mode: ${spec.demo_mode}) ---`);
  await setDemoMode(spec.demo_mode);
  try {
    const plan = planOf(spec);
    const { raw, mapped } = await runLive(id, plan);
    const o = spec.observable;
    const m = mapped.metrics;
    const extMetrics = raw.metrics;

    check(`${id}: run completed with live provenance`, mapped.provenance.engine === "k6");
    check(`${id}: threshold status matches declared observable`, mapped.thresholdStatus === o.threshold_status, `got ${mapped.thresholdStatus}, want ${o.threshold_status}`);

    const errPct = (m.errorRate ?? extMetrics.error_rate) * 100;
    if (o.error_rate_pp_max !== undefined) check(`${id}: error rate ≤ ${o.error_rate_pp_max}pp`, errPct <= o.error_rate_pp_max, `${errPct.toFixed(2)}%`);
    if (o.error_rate_pp_min !== undefined) check(`${id}: error rate ≥ ${o.error_rate_pp_min}pp`, errPct >= o.error_rate_pp_min, `${errPct.toFixed(2)}%`);

    const codes = Object.keys(extMetrics.status_codes ?? {});
    if (o.status_codes_exclusive) check(`${id}: observed status codes == [${o.status_codes_exclusive.join(", ")}]`, codes.length > 0 && codes.every((c) => o.status_codes_exclusive.includes(c)), codes.join(","));
    if (o.status_codes_subset) check(`${id}: observed status codes ⊆ [${o.status_codes_subset.join(", ")}]`, codes.every((c) => o.status_codes_subset.includes(c)), codes.join(","));
    if (o.status_codes_subset) check(`${id}: declared failure code ${o.status_codes_subset[o.status_codes_subset.length - 1]} actually observed`, codes.includes(o.status_codes_subset[o.status_codes_subset.length - 1]), codes.join(","));

    if (o.latency_p95_ms_range) {
      const p95 = m.p95;
      check(`${id}: p95 within declared range [${o.latency_p95_ms_range.join(", ")}]ms (tolerance-based, not exact)`, inRange(p95, o.latency_p95_ms_range), `${p95?.toFixed(1)}ms`);
    }

    // Declared per-scenario evidence checks (documented intent, verified here).
    if (id === "B_db_latency") {
      const epP95 = extMetrics.per_endpoint?.[0]?.p95_ms ?? m.p95;
      check(`${id}: per-endpoint p95 >= 100ms (injection ~${process.env.DB_LATENCY_MS ?? 150}ms + noise)`, epP95 >= 100, `${epP95?.toFixed(1)}ms`);
    }
    if (id === "D_error_injection") {
      check(`${id}: error evidence comes from real 503 responses`, (extMetrics.status_codes?.["503"] ?? 0) > 0, JSON.stringify(extMetrics.status_codes ?? {}));
    }
    if (id === "C_checkout_bottleneck") {
      const epP95 = extMetrics.per_endpoint?.[0]?.p95_ms ?? m.p95;
      check(`${id}: /products unaffected by checkout_bottleneck (mode scoping)`, epP95 < 500, `${epP95?.toFixed(1)}ms`);
    }
  } catch (e) {
    check(`${id}: scenario executed`, false, e.message);
  } finally {
    await setDemoMode("normal");
  }
}

/** Verify one regression-matrix row with two real runs + the product engine. */
async function runMatrixRow(row) {
  console.log(`\n--- matrix ${row.id} (normal → ${row.candidate_mode}) ---`);
  const plan = { ...SUITE.plan_defaults, ...(row.plan_overrides ?? {}) };
  await setDemoMode(row.baseline_mode);
  let baseline;
  try {
    baseline = await runLive(`${row.id}-baseline`, plan);
  } catch (e) {
    check(`${row.id}: baseline executed`, false, e.message);
    await setDemoMode("normal");
    return;
  }
  await setDemoMode(row.candidate_mode);
  let candidate;
  try {
    candidate = await runLive(`${row.id}-candidate`, plan);
  } catch (e) {
    check(`${row.id}: candidate executed`, false, e.message);
    await setDemoMode("normal");
    return;
  } finally {
    if (!candidate) await setDemoMode("normal");
  }
  await setDemoMode("normal");

  const storedBaseline = {
    _id: `matrix-${row.id}-baseline-${baseline.externalRunId}`,
    status: "completed",
    executionMode: "live_k6",
    targetBaseUrl: TARGET,
    plan,
    metrics: baseline.mapped.metrics,
    externalResult: baseline.raw,
  };
  const storedCandidate = {
    _id: `matrix-${row.id}-candidate-${candidate.externalRunId}`,
    status: "completed",
    executionMode: "live_k6",
    targetBaseUrl: TARGET,
    plan,
    metrics: candidate.mapped.metrics,
    externalResult: candidate.raw,
  };
  const reg = computeDeterministicRegression(storedBaseline, storedCandidate, DEFAULT_REGRESSION_POLICY);
  const exp = row.expectation;

  check(`${row.id}: compatibility ${exp.compatibility}`, reg.compatibility === exp.compatibility, reg.compatibility);
  check(
    `${row.id}: classification ${exp.classification} (exactly what the stored evidence + policy support)`,
    reg.status === exp.classification,
    `got ${reg.status} — ${exp.rationale}`,
  );
  check(`${row.id}: breaches back the classification (factual, not subjective)`, (reg.status === "NO_REGRESSION_DETECTED") === (reg.breaches.length === 0), `${reg.breaches.length} breaches`);
  if (exp.classification !== "NO_REGRESSION_DETECTED") {
    check(`${row.id}: no subjective wording in the object`, !JSON.stringify(reg).match(/\b(good|bad|better|worse)\b/i));
  }
}

// --- main ----------------------------------------------------------------------

console.log(`bridge: ${BRIDGE_URL}  target: controlled demo API (${TARGET})  suite: ${SUITE.schema_version}`);
await setDemoMode("normal");

for (const [id, spec] of Object.entries(SUITE.scenarios)) {
  await runScenario(id, spec);
}
for (const row of SUITE.regression_matrix) {
  await runMatrixRow(row);
}
await setDemoMode("normal");

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED — controlled evaluation suite verified on real executions." : `${failures} CHECK(S) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
