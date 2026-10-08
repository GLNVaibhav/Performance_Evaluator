/**
 * Phase 9 unit tests — AI validation layer + evidence builder.
 *
 * Pure-function tests (bun:test): the validator must reject every
 * unsupported claim class and must never alter the authoritative
 * deterministic values. Case numbering follows §19 of the phase brief.
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, test, expect } from "bun:test";
import { buildRunEvidence, buildSearchEvidence } from "./evidence";
import { validateAnalysis } from "./validate";

// --- fixtures ---------------------------------------------------------------

const RUN_ID = "jx1234liverun00";

/** A stored LIVE_K6 run doc shaped exactly like schema.ts defines it. */
const LIVE_RUN = {
  _id: RUN_ID,
  userId: "user123",
  status: "completed",
  executionMode: "live_k6",
  engineMode: "live_k6",
  thresholdStatus: "FAIL",
  verdictLabel: "FAIL",
  targetBaseUrl: "http://127.0.0.1:8080",
  externalRunId: "abc123ext",
  correlationId: "corr-1",
  createdAt: 1_000,
  finishedAt: 2_000,
  errorMessage: null,
  plan: {
    objectiveType: "boundary_search",
    testType: "stress",
    targetVus: 256,
    rampDuration: "8s",
    holdDuration: "5s",
    selectedEndpoints: ["/products"],
    endpointWeights: null,
    thresholds: { p95LatencyMs: 77, errorRate: 0.05 },
    assumptions: [],
  },
  metrics: {
    totalRequests: 4847,
    totalFailures: 0,
    errorRate: 0,
    p50: 30.11,
    p95: 112.15,
    p99: 180.4,
    maxRps: 400.2,
    peakVus: 256,
    iterations: 1,
    latencyAvgMs: 40.5,
    latencyMaxMs: 220.1,
  },
  externalResult: {
    metrics: {
      p50_ms: 30.11,
      p95_ms: 112.15,
      p99_ms: 180.4,
      average_ms: 40.5,
      max_ms: 220.1,
      rps: 400.2,
      total_requests: 4847,
      failed_requests: 0,
      error_rate: 0,
      duration_s: 13,
      status_codes: { "200": 4847 },
      per_endpoint: [
        {
          endpoint: "/products",
          method: "GET",
          total_requests: 4847,
          p50_ms: 30.11,
          p95_ms: 112.15,
          p99_ms: 180.4,
          average_ms: 40.5,
          max_ms: 220.1,
          rps: 400.2,
          failed_requests: 0,
          error_rate: 0,
        },
      ],
    },
  },
  liveProvenance: {
    engine: "k6",
    externalRunId: "abc123ext",
    source: "k6/results.json",
    correlationId: "corr-1",
    artifactPresent: true,
    completedAt: "2026-09-27T00:00:00Z",
  },
  thresholdViolations: ["p95 latency 112.15ms exceeded the configured 77ms threshold"],
} as unknown as Record<string, unknown>;

const p95Key = `run.${RUN_ID}.metrics.p95`;
const thrKey = `run.${RUN_ID}.thresholds.p95LatencyMs`;

const SEARCH_ID = "ksearch999";
const SEARCH = {
  _id: SEARCH_ID,
  userId: "user123",
  targetBaseUrl: "http://127.0.0.1:8080",
  status: "completed",
  basePlan: {
    testType: "stress",
    rampDuration: "3s",
    holdDuration: "2s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: 77, errorRate: 0.05 },
    assumptions: [],
  },
  minVus: 2,
  maxVus: 500,
  tolerance: 0,
  maximumExperiments: 8,
  lowestKnownPassVus: 128,
  highestKnownFailVus: 256,
  experimentCount: 8,
  experimentIds: ["r1", "r2"],
  result: {
    status: "completed",
    lowerBound: 128,
    upperBound: 256,
    stopReason: "maximum_experiments",
    note: "n",
  },
  createdAt: 1,
} as unknown as Record<string, unknown>;

const SEARCH_EXPS = [
  { runId: "r1", iteration: 7, targetVus: 128, status: "completed", thresholdStatus: "PASS", externalRunId: "e7", metrics: { p95: 31.6, errorRate: 0, totalRequests: 900 } },
  { runId: "r2", iteration: 8, targetVus: 256, status: "completed", thresholdStatus: "FAIL", externalRunId: "e8", metrics: { p95: 112.15, errorRate: 0, totalRequests: 4847 } },
];

// --- §19.11/§19.9/§19.10: mode-aware evidence --------------------------------

describe("evidence builder", () => {
  test("§19.11 LIVE_K6 input: k6 values registered verbatim", () => {
    const e = buildRunEvidence(LIVE_RUN);
    expect(e.executionMode).toBe("live_k6");
    expect(e.numbers[p95Key]).toBe(112.15);
    expect(e.numbers[`run.${RUN_ID}.endpoint./products.p95`]).toBe(112.15);
    expect(e.numbers[`run.${RUN_ID}.status.200`]).toBe(4847);
    expect(e.evidenceKeys).toContain(`run:${RUN_ID}`);
    expect(e.limitations.join(" ")).toMatch(/actual k6 execution/);
  });

  test("§19.9 REAL_PROBE input: probe limitation attached, no k6 claims", () => {
    const e = buildRunEvidence({ ...LIVE_RUN, executionMode: "real", engineMode: "real", externalResult: null });
    expect(e.limitations.join(" ")).toMatch(/bounded HTTP probing/);
    expect(e.limitations.join(" ")).toMatch(/do not establish sustained-load capacity/);
    expect(e.externalMetrics).toBeNull();
  });

  test("§19.10 SIMULATION input: simulated limitation attached", () => {
    const e = buildRunEvidence({ ...LIVE_RUN, executionMode: "simulation", engineMode: "simulation", externalResult: null });
    expect(e.limitations.join(" ")).toMatch(/simulated/);
  });

  test("§19.8 execution-error input: no verdict inferred", () => {
    const e = buildRunEvidence({ ...LIVE_RUN, status: "execution_error", thresholdStatus: null, metrics: null, externalResult: null, errorMessage: "k6 failed" });
    expect(e.thresholdStatus).toBeNull();
    expect(e.limitations.join(" ")).toMatch(/EXECUTION_ERROR/);
    const out = validateAnalysis({ summary: "n", observations: [] }, e);
    expect(out.limitations.join(" ")).toMatch(/EXECUTION_ERROR/);
  });

  test("§19.12 missing endpoint evidence: stated, not filled", () => {
    const e = buildRunEvidence({ ...LIVE_RUN, externalResult: null });
    expect(e.externalMetrics).toBeNull();
    expect(e.limitations.join(" ")).toMatch(/Endpoint-level evidence is unavailable/);
  });
});

// --- §19.1–§19.7: validation of LLM-shaped output -----------------------------

describe("analysis validation — run", () => {
  const evidence = buildRunEvidence(LIVE_RUN);

  test("§19.1 valid structured response passes with references", () => {
    const out = validateAnalysis(
      {
        summary: "p95 breached the configured threshold at 256 VUs.",
        observations: [
          {
            statement: "At 256 VUs, p95 latency was 112.15ms and exceeded the configured 77ms threshold.",
            classification: "OBSERVED",
            evidence: [p95Key, thrKey],
          },
        ],
        threshold_assessment: { status: "FAIL", evidence: ["thresholdStatus:FAIL"] },
        endpoint_observations: [],
        limitations: [],
        confidence_notes: [],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(1);
    expect(out.thresholdAssessment.status).toBe("FAIL");
    expect(out.rejected).toHaveLength(0);
    // Boundary assessment stays empty for a single run.
    expect(out.boundaryAssessment.highestObservedPass).toBeNull();
  });

  test("§19.2 malformed AI response is sanitized, not trusted", () => {
    const out = validateAnalysis("not an object", evidence);
    expect(out.summary).toMatch(/unavailable/);
    expect(out.rejected[0]!.reason).toMatch(/malformed/);
    const out2 = validateAnalysis({ observations: [{ statement: "x", classification: "CERTAIN" }] }, evidence);
    expect(out2.observations).toHaveLength(0);
    expect(out2.rejected[0]!.reason).toMatch(/invalid classification/);
  });

  test("§19.3 nonexistent metric value is rejected", () => {
    const out = validateAnalysis(
      {
        observations: [
          { statement: "p95 was 999.99ms at 256 VUs.", classification: "OBSERVED", evidence: [p95Key] },
        ],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/999\.99 not present/);
  });

  test("§19.4 nonexistent endpoint is rejected", () => {
    const out = validateAnalysis(
      {
        endpoint_observations: [
          { endpoint: "/admin/secret", statement: "p95 was 112.15ms.", classification: "OBSERVED", evidence: [] },
        ],
      },
      evidence,
    );
    expect(out.endpointObservations).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/nonexistent endpoint/);
  });

  test("§19.5 altered threshold value in a statement is rejected", () => {
    const out = validateAnalysis(
      {
        observations: [
          { statement: "p95 latency was 111.15ms against the 77ms threshold.", classification: "OBSERVED", evidence: [p95Key] },
        ],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/111\.15 not present/);
  });

  test("§19.6 unsupported root cause is rejected", () => {
    const out = validateAnalysis(
      {
        observations: [
          {
            statement: "The latency increase is caused by database connection pool exhaustion.",
            classification: "INFERRED",
            evidence: [p95Key],
          },
        ],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/root-cause/);
  });

  test("§19.6b controlled demo condition may be mentioned as context", () => {
    const out = validateAnalysis(
      {
        observations: [
          {
            statement: "The run was executed while the controlled demo API was configured with db_latency mode; the measurements themselves do not identify a subsystem cause.",
            classification: "OBSERVED",
            evidence: [`mode:${evidence.executionMode}`],
          },
        ],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(1);
  });

  test("§19.7 unsupported capacity claim is rejected", () => {
    const out = validateAnalysis(
      {
        observations: [
          { statement: "The system can safely support exactly 256 users.", classification: "OBSERVED", evidence: [p95Key] },
          { statement: "The maximum capacity is 256 VUs.", classification: "INFERRED", evidence: [] },
        ],
      },
      evidence,
    );
    expect(out.observations).toHaveLength(0);
    expect(out.rejected).toHaveLength(2);
    expect(out.rejected[0]!.reason).toMatch(/capacity/);
  });

  test("§19.14 evidence references: invalid refs dropped, OBSERVED without refs rejected", () => {
    const out = validateAnalysis(
      {
        observations: [
          { statement: "p95 was 112.15ms.", classification: "OBSERVED", evidence: ["run.imaginary.metrics.p95"] },
          { statement: "p95 was 112.15ms.", classification: "UNKNOWN", evidence: ["bogus-ref"] },
        ],
      },
      evidence,
    );
    // First: OBSERVED with only invalid refs → rejected. Second: UNKNOWN kept (refs optional).
    expect(out.observations).toHaveLength(1);
    expect(out.observations[0]!.classification).toBe("UNKNOWN");
    expect(out.observations[0]!.evidence).toHaveLength(0);
    expect(out.rejected[0]!.reason).toMatch(/without any valid evidence reference/);
  });
});

// --- §19.13: boundary-search evidence ----------------------------------------

describe("analysis validation — boundary search", () => {
  const evidence = buildSearchEvidence(SEARCH, SEARCH_EXPS);

  test("§19.13 boundary evidence carries sequence + canonical boundaries", () => {
    expect(evidence.experiments.map((x) => x.targetVus)).toEqual([128, 256]);
    expect(evidence.numbers[`search.${SEARCH_ID}.exp.8.p95`]).toBe(112.15);
    expect(evidence.numbers[`search.${SEARCH_ID}.lowestKnownPassVus`]).toBe(128);
    expect(evidence.numbers[`search.${SEARCH_ID}.highestKnownFailVus`]).toBe(256);
    const out = validateAnalysis(
      {
        observations: [
          {
            statement: "The highest observed passing load was 128 VUs and the lowest observed failing load was 256 VUs.",
            classification: "OBSERVED",
            evidence: [`search.${SEARCH_ID}.lowestKnownPassVus`, `search.${SEARCH_ID}.highestKnownFailVus`],
          },
        ],
        boundary_assessment: { highest_observed_pass: 128, lowest_observed_fail: 256 },
      },
      evidence,
    );
    expect(out.observations).toHaveLength(1);
    expect(out.boundaryAssessment.highestObservedPass).toBe(128);
    expect(out.boundaryAssessment.lowestObservedFail).toBe(256);
    expect(out.boundaryAssessment.estimatedSafeOperatingRegion).toEqual({ lowerBound: 128, upperBound: 256 });
    expect(out.rejected).toHaveLength(0);
  });

  test("§19.5b altered boundary value is rejected; canonical value preserved", () => {
    const out = validateAnalysis(
      { boundary_assessment: { highest_observed_pass: 300, lowest_observed_fail: 256 } },
      evidence,
    );
    expect(out.rejected[0]!.reason).toMatch(/altered boundary/);
    // The stored analysis carries the AUTHORITATIVE value, never the altered one.
    expect(out.boundaryAssessment.highestObservedPass).toBe(128);
  });

  test("never-fabricated boundaries: unobserved FAIL stays unknown", () => {
    const e = buildSearchEvidence({ ...SEARCH, highestKnownFailVus: null, result: null }, [SEARCH_EXPS[0]!]);
    const out = validateAnalysis({}, e);
    expect(out.boundaryAssessment.lowestObservedFail).toBeNull();
    expect(out.boundaryAssessment.estimatedSafeOperatingRegion).toBeNull();
    expect(e.limitations.join(" ")).toMatch(/No FAIL was observed/);
  });
});

// --- §19.15 regeneration + immutability of inputs ------------------------------

describe("regeneration & determinism", () => {
  test("§19.15 repeated generation from the same evidence is identical and non-mutating", () => {
    const evidence = buildRunEvidence(LIVE_RUN);
    const snapshot = JSON.stringify(LIVE_RUN);
    const raw = {
      summary: "s",
      observations: [
        { statement: "p95 was 112.15ms.", classification: "OBSERVED", evidence: [p95Key] },
      ],
    };
    const a = validateAnalysis(raw, evidence);
    const b = validateAnalysis(raw, evidence);
    expect(a).toEqual(b);
    // The validator never mutates its inputs.
    expect(JSON.stringify(LIVE_RUN)).toBe(snapshot);
    expect(a.observations[0]!.statement).toBe("p95 was 112.15ms.");
  });
});
