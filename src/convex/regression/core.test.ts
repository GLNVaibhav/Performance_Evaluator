/**
 * Phase 10 unit tests — DETERMINISTIC regression engine + AI validation.
 *
 * Pure-function tests (bun:test): the engine must produce reproducible
 * deltas/classifications from stored runs + policy, and must return
 * INCONCLUSIVE (never a forced verdict) for every §7 condition. The AI
 * validator must reject fabricated metrics/endpoints/causes and any attempt
 * to override the deterministic layer.
 * Case numbering follows §16 of the phase brief.
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, test, expect } from "bun:test";
import {
  extractMetric,
  checkCompatibility,
  delta,
  computeDeterministicRegression,
  classifyFromDeltas,
  statusDistributionChanges,
  compareEndpoints,
  DEFAULT_REGRESSION_POLICY,
  REGRESSION_POLICY_VERSION,
} from "./core";
import { buildRegressionEvidence } from "./aiEvidence";
import { validateRegressionAnalysis } from "./aiValidate";

// --- fixtures ----------------------------------------------------------------

const BASE_PLAN = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 5,
  duration: "10s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
  assumptions: [],
};

/** A completed LIVE_K6 run shaped exactly like the stored document. */
function liveRun(id, metrics, overrides = {}) {
  const {
    p50_ms = 10, p95_ms = 20, p99_ms = 30, average_ms = 12, max_ms = 40,
    rps = 50, total_requests = 500, failed_requests = 0, error_rate = 0,
    status_codes = { "200": total_requests - failed_requests },
    per_endpoint = [
      { endpoint: "/products", method: "GET", total_requests, p50_ms, p95_ms, p99_ms, average_ms, max_ms, rps, failed_requests, error_rate },
    ],
  } = metrics ?? {};
  return {
    _id: id,
    userId: "user123",
    status: "completed",
    executionMode: "live_k6",
    engineMode: "live_k6",
    thresholdStatus: "PASS",
    targetBaseUrl: "http://127.0.0.1:8080",
    plan: { ...BASE_PLAN },
    metrics: {
      totalRequests: total_requests,
      totalFailures: failed_requests,
      errorRate: error_rate,
      p50: p50_ms,
      p95: p95_ms,
      p99: p99_ms,
      maxRps: rps,
      peakVus: 5,
      iterations: total_requests,
      latencyAvgMs: average_ms,
      latencyMaxMs: max_ms,
    },
    externalResult: {
      run_id: `ext-${id}`,
      metrics: {
        p50_ms, p95_ms, p99_ms, average_ms, max_ms, rps,
        total_requests, failed_requests, error_rate, duration_s: 10,
        status_codes, per_endpoint,
      },
      threshold_status: "PASS",
      evaluated_at: "2026-09-27T00:00:00Z",
    },
    ...overrides,
  };
}

function extMetrics(p95_ms, extra = {}) {
  return {
    p50_ms: 10, p99_ms: 30, average_ms: 12, max_ms: 40, rps: 50,
    total_requests: 500, failed_requests: 0, error_rate: 0, duration_s: 10,
    ...extra,
    p95_ms,
  };
}

// === §16 deterministic cases (1–20) ==========================================

describe("deterministic regression engine", () => {
  test("1. identical metrics → NO_REGRESSION_DETECTED with zero deltas", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("NO_REGRESSION_DETECTED");
    expect(r.compatibility).toBe("COMPATIBLE");
    expect(r.metrics.p95.absoluteDelta).toBe(0);
    expect(r.metrics.p95.percentageDelta).toBe(0);
    expect(r.breaches).toHaveLength(0);
  });

  test("2. positive latency delta beyond policy → LATENCY_REGRESSION", () => {
    const b = liveRun("run-b", extMetrics(100));
    const c = liveRun("run-c", extMetrics(150));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("LATENCY_REGRESSION");
    expect(r.metrics.p95.absoluteDelta).toBeCloseTo(50);
    expect(r.metrics.p95.percentageDelta).toBeCloseTo(50);
    expect(r.breaches.some((x) => x.includes("p95"))).toBe(true);
  });

  test("3. negative latency delta → NO_REGRESSION_DETECTED (no improvement classification)", () => {
    const b = liveRun("run-b", extMetrics(100));
    const c = liveRun("run-c", extMetrics(50));
    const r = computeDeterministicRegression(b, c);
    // The engine is factual: lower latency is not a "regression", and the
    // brief forbids good/bad verdicts — so no classification fires.
    expect(r.status).toBe("NO_REGRESSION_DETECTED");
    expect(r.metrics.p95.absoluteDelta).toBeCloseTo(-50);
  });

  test("4. percentage calculation is exact (8.4 → 12.1 ms = +44.05%)", () => {
    const d = delta(
      { value: 8.4, source: "test" },
      { value: 12.1, source: "test" },
    );
    expect(d.absoluteDelta).toBeCloseTo(3.7);
    expect(d.percentageDelta).toBeCloseTo(44.0476, 3);
  });

  test("5. zero-baseline percentage → null percentage, factual absolute delta", () => {
    const d = delta({ value: 0, source: "test" }, { value: 5, source: "test" });
    expect(d.absoluteDelta).toBe(5);
    expect(d.percentageDelta).toBeNull();
  });

  test("6. error-rate change 0 → 3% with 503 appearing → ERROR_RATE_REGRESSION + status change", () => {
    const b = liveRun("run-b", extMetrics(20, { status_codes: { "200": 100 } }));
    const c = liveRun("run-c", extMetrics(20, {
      failed_requests: 3, error_rate: 0.03, status_codes: { "200": 97, "503": 3 },
    }));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("ERROR_RATE_REGRESSION");
    expect(r.metrics.errorRate.absoluteDelta).toBeCloseTo(0.03);
    expect(r.statusDistributionChanges.some((s) => s.includes("503"))).toBe(true);
  });

  test("7. RPS degradation −25% → THROUGHPUT_REGRESSION", () => {
    const b = liveRun("run-b", extMetrics(20, { rps: 100 }));
    const c = liveRun("run-c", extMetrics(20, { rps: 75 }));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("THROUGHPUT_REGRESSION");
    expect(r.metrics.rps.percentageDelta).toBeCloseTo(-25);
  });

  test("8. endpoint-level differences are reported per endpoint", () => {
    const mk = (id, p95) =>
      liveRun(id, extMetrics(20, {
        per_endpoint: [
          { endpoint: "/products", method: "GET", total_requests: 300, p50_ms: 10, p95_ms: 20, p99_ms: 30, average_ms: 12, max_ms: 40, rps: 30, failed_requests: 0, error_rate: 0 },
          { endpoint: "/checkout", method: "POST", total_requests: 100, p50_ms: 10, p95_ms: p95, p99_ms: 30, average_ms: 12, max_ms: 40, rps: 10, failed_requests: 0, error_rate: 0 },
        ],
      }));
    const r = computeDeterministicRegression(mk("run-b", 100), mk("run-c", 160));
    expect(r.endpointResults).toHaveLength(2);
    const checkout = r.endpointResults.find((e) => e.endpoint === "/checkout");
    expect(checkout.p95.absoluteDelta).toBeCloseTo(60);
    expect(checkout.p95.percentageDelta).toBeCloseTo(60);
  });

  test("9. status-code changes are reported factually (no cause)", () => {
    const changes = statusDistributionChanges(
      [{ code: "200", count: 100 }],
      [{ code: "200", count: 97 }, { code: "503", count: 3 }],
    );
    expect(changes).toContain("status 503 observed in candidate (3) but absent in baseline");
    expect(changes.some((c) => c.includes("200") && c.includes("100 → 97"))).toBe(true);
  });

  test("10. incompatible target → INCOMPATIBLE + INCONCLUSIVE", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { targetBaseUrl: "http://127.0.0.1:9999" });
    const r = computeDeterministicRegression(b, c);
    expect(r.compatibility).toBe("INCOMPATIBLE");
    expect(r.compatibilityReasons[0]).toContain("target mismatch");
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("incompatible_workload");
  });

  test("11. VU mismatch alone → load-sensitivity, not regression", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(40), {
      plan: { ...BASE_PLAN, targetVus: 10 },
      metrics: { ...b.metrics, peakVus: 10 },
    });
    const compat = checkCompatibility(b, c);
    expect(compat.compatible).toBe(false);
    expect(compat.loadSensitivityOnly).toBe(true);
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("load_sensitivity_comparison");
    expect(r.compatibilityReasons[0]).toContain("target VUs mismatch");
  });

  test("12. duration mismatch → incompatible", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { plan: { ...BASE_PLAN, duration: "20s" } });
    const compat = checkCompatibility(b, c);
    expect(compat.compatible).toBe(false);
    expect(compat.reasons[0]).toContain("duration mismatch");
  });

  test("13. endpoint-set mismatch → incompatible", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { plan: { ...BASE_PLAN, selectedEndpoints: ["/products", "/cart"] } });
    const compat = checkCompatibility(b, c);
    expect(compat.compatible).toBe(false);
    expect(compat.reasons[0]).toContain("selected endpoints mismatch");
  });

  test("14. missing metrics → INCONCLUSIVE with missing_metrics", () => {
    const b = liveRun("run-b", extMetrics(20), { externalResult: null, metrics: null });
    const c = liveRun("run-c", extMetrics(20));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("missing_metrics");
    expect(r.metrics.p50.baseline).toBeNull();
  });

  test("15. execution_error run → INCONCLUSIVE, never a verdict", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { status: "execution_error", errorMessage: "k6 failed" });
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("execution_error");
  });

  test("16. simulation input → INCONCLUSIVE (simulation_involved)", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { executionMode: "simulation", engineMode: "simulation" });
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("simulation_involved");
  });

  test("17. REAL_PROBE input → INCONCLUSIVE (real_probe_involved)", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(20), { executionMode: "real", engineMode: "real" });
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("real_probe_involved");
  });

  test("18. policy threshold classification: +8% latency stays under a +10% policy", () => {
    const b = liveRun("run-b", extMetrics(100));
    const c = liveRun("run-c", extMetrics(108));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("NO_REGRESSION_DETECTED");
    // boundary semantics: exactly +10% is NOT a regression (strictly-beyond)
    const c2 = liveRun("run-c", extMetrics(110));
    expect(computeDeterministicRegression(b, c2).status).toBe("NO_REGRESSION_DETECTED");
    // strictly beyond the threshold fires
    const c3 = liveRun("run-c", extMetrics(110.01));
    expect(computeDeterministicRegression(b, c3).status).toBe("LATENCY_REGRESSION");
    // a tighter policy fires earlier
    const custom = computeDeterministicRegression(b, c, { ...DEFAULT_REGRESSION_POLICY, latencyRegressionThresholdPct: 5 });
    expect(custom.status).toBe("LATENCY_REGRESSION");
    expect(custom.policyVersion).toBe(REGRESSION_POLICY_VERSION);
  });

  test("19. latency + throughput + error breaches → MULTIPLE_REGRESSIONS", () => {
    const b = liveRun("run-b", extMetrics(100, { rps: 100 }));
    const c = liveRun("run-c", extMetrics(200, { rps: 50, failed_requests: 30, error_rate: 0.06, status_codes: { "200": 470, "500": 30 } }));
    const r = computeDeterministicRegression(b, c);
    expect(r.status).toBe("MULTIPLE_REGRESSIONS");
    expect(r.breaches.length).toBeGreaterThanOrEqual(3);
  });

  test("20. missing baseline/candidate → INCONCLUSIVE (missing_baseline)", () => {
    const r = computeDeterministicRegression(null, liveRun("run-c", extMetrics(20)));
    expect(r.status).toBe("INCONCLUSIVE");
    expect(r.inconclusive.reasons).toContain("missing_baseline");
    const r2 = computeDeterministicRegression(liveRun("run-b", extMetrics(20)), null);
    expect(r2.inconclusive.reasons).toContain("missing_candidate");
  });

  test("extractMetric prefers the verbatim externalResult source", () => {
    const run = liveRun("run-b", extMetrics(20));
    const m = extractMetric(run);
    expect(m.p95.value).toBe(20);
    expect(m.p95.source).toBe("externalResult.metrics.p95_ms");
  });

  test("endpoint comparison skips single-sided endpoints", () => {
    const rows = compareEndpoints(
      [{ endpoint: "/a", method: "GET", requests: 10, p50: 1, p95: 2, p99: 3, average: 1.5, max: 4, rps: 5, errorRate: 0 }],
      [{ endpoint: "/b", method: "GET", requests: 10, p50: 1, p95: 2, p99: 3, average: 1.5, max: 4, rps: 5, errorRate: 0 }],
      null,
      null,
    );
    expect(rows).toHaveLength(0);
  });

  test("reproducibility: same inputs → identical object (no clock/randomness in the object)", () => {
    const b = liveRun("run-b", extMetrics(20));
    const c = liveRun("run-c", extMetrics(33));
    expect(JSON.stringify(computeDeterministicRegression(b, c))).toBe(
      JSON.stringify(computeDeterministicRegression(b, c)),
    );
  });
});

// === §16 AI cases (21–25) =====================================================

describe("regression AI validation", () => {
  function evidenceFor(status = "LATENCY_REGRESSION", p95 = 150) {
    const b = liveRun("run-b", extMetrics(100, { rps: 100 }));
    const c = liveRun("run-c", extMetrics(p95, {
      rps: 50, failed_requests: 30, error_rate: 0.06, status_codes: { "200": 470, "500": 30 },
    }));
    const det = computeDeterministicRegression(b, c);
    if (status) det.status = status;
    return buildRegressionEvidence("reg123", b, c, det);
  }

  test("21. valid regression interpretation passes validation", () => {
    const ev = evidenceFor("MULTIPLE_REGRESSIONS");
    const out = validateRegressionAnalysis(
      {
        summary: "Candidate p95 rose from 100ms to 150ms; rps fell from 100 to 50.",
        what_changed: [
          {
            statement: "p95 latency changed by 50 (50%) from baseline 100 to candidate 150.",
            classification: "OBSERVED",
            evidence: ["regression.metrics.p95.absoluteDelta", "run:run-b", "run:run-c"],
          },
          {
            statement: "The observed changes are concentrated in the run-level latency distribution.",
            classification: "INFERRED",
            evidence: ["regression:reg123"],
          },
        ],
        endpoint_observations: [],
        limitations: [],
        confidence_notes: [],
      },
      ev,
    );
    expect(out.rejected).toHaveLength(0);
    expect(out.whatChanged).toHaveLength(2);
    expect(out.summary).toContain("150");
  });

  test("22. fabricated metric rejection (number not in evidence)", () => {
    const ev = evidenceFor();
    const out = validateRegressionAnalysis(
      {
        summary: "p95 latency rose to 1500.5ms.",
        what_changed: [],
        endpoint_observations: [],
      },
      ev,
    );
    expect(out.rejected.some((r) => r.reason.includes("not present in recorded evidence"))).toBe(true);
    expect(out.summary).not.toContain("1500.5");
  });

  test("23. fabricated endpoint rejection", () => {
    const ev = evidenceFor();
    const out = validateRegressionAnalysis(
      {
        summary: "Summary without fabricated numbers.",
        what_changed: [],
        endpoint_observations: [
          {
            endpoint: "/nonexistent",
            statement: "p95 latency changed for this endpoint.",
            classification: "OBSERVED",
            evidence: ["regression.metrics.p95.absoluteDelta"],
          },
        ],
      },
      ev,
    );
    expect(out.rejected.some((r) => r.reason.includes("nonexistent endpoint"))).toBe(true);
    expect(out.endpointObservations).toHaveLength(0);
  });

  test("24. fabricated root-cause rejection (§13)", () => {
    const ev = evidenceFor();
    const out = validateRegressionAnalysis(
      {
        summary: "Summary without fabricated numbers.",
        what_changed: [
          {
            statement: "The database caused the regression: p95 rose by 50 (50%).",
            classification: "OBSERVED",
            evidence: ["regression.metrics.p95.absoluteDelta"],
          },
          {
            statement: "CPU regression explains the latency increase.",
            classification: "INFERRED",
            evidence: ["regression:reg123"],
          },
        ],
        endpoint_observations: [],
      },
      ev,
    );
    expect(out.rejected.filter((r) => r.reason.includes("root-cause")).length).toBe(2);
    expect(out.whatChanged).toHaveLength(0);
  });

  test("25. classification-override rejection", () => {
    const ev = evidenceFor("LATENCY_REGRESSION");
    const out = validateRegressionAnalysis(
      {
        summary: "Summary without fabricated numbers.",
        what_changed: [
          {
            statement: "This comparison shows NO_REGRESSION_DETECTED despite the engine result.",
            classification: "OBSERVED",
            evidence: ["regression.metrics.p95.absoluteDelta"],
          },
        ],
        endpoint_observations: [],
      },
      ev,
    );
    expect(out.rejected.some((r) => r.reason.includes("contradicts the deterministic classification"))).toBe(true);
    expect(out.whatChanged).toHaveLength(0);
  });

  test("restating the deterministic classification is allowed", () => {
    const ev = evidenceFor("MULTIPLE_REGRESSIONS");
    const out = validateRegressionAnalysis(
      {
        summary: "The engine classified MULTIPLE_REGRESSIONS.",
        what_changed: [
          {
            statement: "Deterministic classification is MULTIPLE_REGRESSIONS.",
            classification: "OBSERVED",
            evidence: ["classification:MULTIPLE_REGRESSIONS", "regression:reg123"],
          },
        ],
        endpoint_observations: [],
      },
      ev,
    );
    expect(out.rejected).toHaveLength(0);
    expect(out.whatChanged).toHaveLength(1);
  });

  test("subjective quality judgments (good/bad) are rejected", () => {
    const ev = evidenceFor();
    const out = validateRegressionAnalysis(
      {
        summary: "Summary without fabricated numbers.",
        what_changed: [
          {
            statement: "The candidate performed worse than the baseline.",
            classification: "OBSERVED",
            evidence: ["regression.metrics.p95.absoluteDelta"],
          },
        ],
        endpoint_observations: [],
      },
      ev,
    );
    expect(out.rejected.some((r) => r.reason.includes("quality judgment"))).toBe(true);
  });
});

// === classification policy unit sanity ========================================

describe("classification policy internals", () => {
  const baseDelta = (b, c) => delta({ value: b, source: "t" }, { value: c, source: "t" });

  test("error-rate uses absolute percentage points, not relative percent", () => {
    const metrics = {
      p50: baseDelta(0, 0), p95: baseDelta(0, 0), p99: baseDelta(0, 0),
      average: baseDelta(0, 0), max: baseDelta(0, 0), rps: baseDelta(100, 100),
      errorRate: baseDelta(0.01, 0.02), // 1% → 2%: +1pp exactly (boundary, not beyond)
    };
    expect(classifyFromDeltas(metrics, DEFAULT_REGRESSION_POLICY).status).toBe("NO_REGRESSION_DETECTED");
    const worse = { ...metrics, errorRate: baseDelta(0.01, 0.025) }; // +1.5pp
    expect(classifyFromDeltas(worse, DEFAULT_REGRESSION_POLICY).status).toBe("ERROR_RATE_REGRESSION");
  });

  test("missing error-rate values never fire a classification", () => {
    const metrics = {
      p50: baseDelta(0, 0), p95: baseDelta(0, 0), p99: baseDelta(0, 0),
      average: baseDelta(0, 0), max: baseDelta(0, 0), rps: baseDelta(100, 100),
      errorRate: baseDelta(null, 0.5),
    };
    expect(classifyFromDeltas(metrics, DEFAULT_REGRESSION_POLICY).status).toBe("NO_REGRESSION_DETECTED");
  });
});
