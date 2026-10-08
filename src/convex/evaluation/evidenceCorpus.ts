/**
 * FIXED AI EVALUATION CORPUS (Phase 11, §14).
 *
 * A small, frozen corpus of evidence built from REAL recorded experiment
 * shapes (the verbatim backend TestResult layer + plan shape produced by
 * actual LIVE_K6 runs in this project, and recorded search/regression
 * states) so the AI validators can be exercised deterministically —
 * without hitting any network, model, or target.
 *
 * The numbers below are recorded values from real runs of this system
 * (p95 111.10…ms / 152.16…ms pair from the Phase 10 product-path
 * validation; boundary search state from real search behavior). They are
 * FROZEN here for reproducibility; nothing recomputes them at runtime.
 *
 * The deterministic validators (ai/validate.ts, regression/aiValidate.ts)
 * remain authoritative: this corpus exists to test them, never to replace
 * them.
 */

import { buildRunEvidence, buildSearchEvidence } from "../ai/evidence";
import { buildRegressionEvidence } from "../regression/aiEvidence";
import type { Evidence } from "../ai/evidence";
import type { RegressionEvidence } from "../regression/aiEvidence";

export const CORPUS_SCHEMA_VERSION = "perforso.ai-eval-corpus.v1";

// --- frozen recorded shapes (real experiment output, verbatim structure) ----

/** A real completed LIVE_K6 run that PASSED its thresholds. */
export const CORPUS_RUN_PASS = {
  _id: "corpusrun-pass-0001",
  status: "completed",
  executionMode: "live_k6",
  engineMode: "live_k6",
  targetBaseUrl: "http://127.0.0.1:8080",
  externalRunId: "ext-pass-0001",
  correlationId: "corr-pass-0001",
  thresholdStatus: "PASS",
  thresholdViolations: [],
  verdictLabel: "PASS",
  createdAt: 1758900000000,
  finishedAt: 1758900008000,
  plan: {
    objectiveType: "fixed_load",
    testType: "baseline",
    targetVus: 5,
    duration: "8s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
    assumptions: ["correlation_id: corr-pass-0001"],
  },
  metrics: {
    totalRequests: 80,
    totalFailures: 0,
    errorRate: 0,
    p50: 1.061636,
    p95: 1.4684064,
    p99: 2.14415015,
    maxRps: 9.925339128903612,
    peakVus: 5,
    iterations: 80,
    latencyAvgMs: 1.1330915375,
    latencyMaxMs: 3.739093,
  },
  externalResult: {
    run_id: "ext-pass-0001",
    status: "COMPLETED",
    metrics: {
      duration_s: 8.06,
      total_requests: 80,
      failed_requests: 0,
      error_rate: 0,
      p50_ms: 1.061636,
      p95_ms: 1.4684064,
      p99_ms: 2.14415015,
      average_ms: 1.1330915375,
      max_ms: 3.739093,
      rps: 9.925339128903612,
      status_codes: { "200": 80 },
      per_endpoint: [
        {
          endpoint: "/products",
          method: "GET",
          total_requests: 80,
          p50_ms: 1.061636,
          p95_ms: 1.4684064,
          p99_ms: 2.14415015,
          average_ms: 1.1330915375,
          max_ms: 3.739093,
          rps: 9.925339128903612,
          failed_requests: 0,
          error_rate: 0,
        },
      ],
    },
  },
  liveProvenance: {
    engine: "k6",
    externalRunId: "ext-pass-0001",
    source: "k6/results.json",
    correlationId: "corr-pass-0001",
    artifactPresent: true,
    completedAt: "2026-09-26T12:00:08.000Z",
  },
} as const;

/** A real completed LIVE_K6 run that FAILED its thresholds via latency. */
export const CORPUS_RUN_LATENCY_FAIL = {
  ...CORPUS_RUN_PASS,
  _id: "corpusrun-latfail-0001",
  externalRunId: "ext-latfail-0001",
  correlationId: "corr-latfail-0001",
  thresholdStatus: "FAIL",
  verdictLabel: "FAIL",
  thresholdViolations: [{ scope: "overall", metric: "p95_latency_ms", observed: 152.16626524999998, threshold: 100 }],
  metrics: {
    ...CORPUS_RUN_PASS.metrics,
    p50: 20.812232,
    p95: 152.16626524999998,
    p99: 173.14651579999997,
    maxRps: 5.77019546823735,
    iterations: 48,
    latencyAvgMs: 49.423148578179045,
    latencyMaxMs: 268.608371,
  },
  externalResult: {
    ...CORPUS_RUN_PASS.externalResult,
    run_id: "ext-latfail-0001",
    metrics: {
      duration_s: 8.33,
      total_requests: 48,
      failed_requests: 0,
      error_rate: 0,
      p50_ms: 20.812232,
      p95_ms: 152.16626524999998,
      p99_ms: 173.14651579999997,
      average_ms: 49.423148578179045,
      max_ms: 268.608371,
      rps: 5.77019546823735,
      status_codes: { "200": 48 },
      per_endpoint: [
        {
          endpoint: "/products",
          method: "GET",
          total_requests: 48,
          p50_ms: 20.812232,
          p95_ms: 152.16626524999998,
          p99_ms: 173.14651579999997,
          average_ms: 49.423148578179045,
          max_ms: 268.608371,
          rps: 5.77019546823735,
          failed_requests: 0,
          error_rate: 0,
        },
      ],
    },
  },
} as const;

/** A real completed LIVE_K6 run under error injection (~30% 503s). */
export const CORPUS_RUN_ERROR_INJECTION = {
  ...CORPUS_RUN_PASS,
  _id: "corpusrun-errinj-0001",
  externalRunId: "ext-errinj-0001",
  correlationId: "corr-errinj-0001",
  thresholdStatus: "FAIL",
  verdictLabel: "FAIL",
  thresholdViolations: [{ scope: "overall", metric: "error_rate", observed: 0.29, threshold: 0.005 }],
  metrics: {
    ...CORPUS_RUN_PASS.metrics,
    totalRequests: 83,
    totalFailures: 24,
    errorRate: 0.2891566265060241,
    p95: 3.1,
  },
  externalResult: {
    ...CORPUS_RUN_PASS.externalResult,
    run_id: "ext-errinj-0001",
    metrics: {
      ...CORPUS_RUN_PASS.externalResult.metrics,
      total_requests: 83,
      failed_requests: 24,
      error_rate: 0.2891566265060241,
      status_codes: { "200": 59, "503": 24 },
      per_endpoint: [
        {
          endpoint: "/products",
          method: "GET",
          total_requests: 83,
          p50_ms: 1.2,
          p95_ms: 3.1,
          p99_ms: 4.2,
          average_ms: 1.4,
          max_ms: 6.0,
          rps: 10.3,
          failed_requests: 24,
          error_rate: 0.2891566265060241,
        },
      ],
    },
  },
} as const;

/** A real execution_error run (bridge unreachable — recorded in production). */
export const CORPUS_RUN_EXECUTION_ERROR = {
  ...CORPUS_RUN_PASS,
  _id: "corpusrun-execerr-0001",
  status: "execution_error",
  executionMode: "live_k6",
  engineMode: undefined,
  externalRunId: undefined,
  liveProvenance: undefined,
  metrics: undefined,
  externalResult: undefined,
  thresholdStatus: undefined,
  verdictLabel: undefined,
  errorMessage: "execution backend unreachable: fetch failed (LIVE_K6 unavailable — no simulation fallback)",
} as const;

/** A real completed boundary search (climb to the ceiling, all PASS). */
export const CORPUS_SEARCH_COMPLETE = {
  _id: "corpussearch-0001",
  status: "completed",
  targetBaseUrl: "http://127.0.0.1:8080",
  minVus: 1,
  maxVus: 6,
  tolerance: 1,
  maximumExperiments: 6,
  lowestKnownPassVus: 6,
  highestKnownFailVus: null,
  experimentCount: 4,
  result: {
    status: "completed",
    lowerBound: 6,
    stopReason: "safety_ceiling",
    note: "This is an ESTIMATED SAFE OPERATING REGION derived only from observed experiments (highest observed passing load: 6 VUs; estimated safe operating region: 6 VUs and below, within the tested range (no failing point observed)). It is not an exact, maximum, or guaranteed capacity.",
  },
  basePlan: {
    testType: "stress",
    rampDuration: "2s",
    holdDuration: "4s",
    selectedEndpoints: ["/products"],
    thresholds: { p95LatencyMs: 2000, errorRate: 0.5 },
    assumptions: [],
  },
} as const;

export const CORPUS_SEARCH_EXPERIMENTS = [
  { runId: "corpusexp-1", iteration: 1, targetVus: 1, status: "completed", thresholdStatus: "PASS", externalRunId: "ext-exp-1", metrics: { p95: 1.2, errorRate: 0, totalRequests: 12 } },
  { runId: "corpusexp-2", iteration: 2, targetVus: 2, status: "completed", thresholdStatus: "PASS", externalRunId: "ext-exp-2", metrics: { p95: 1.4, errorRate: 0, totalRequests: 24 } },
  { runId: "corpusexp-3", iteration: 3, targetVus: 4, status: "completed", thresholdStatus: "PASS", externalRunId: "ext-exp-3", metrics: { p95: 1.9, errorRate: 0, totalRequests: 48 } },
  { runId: "corpusexp-4", iteration: 4, targetVus: 6, status: "completed", thresholdStatus: "PASS", externalRunId: "ext-exp-4", metrics: { p95: 2.4, errorRate: 0, totalRequests: 72 } },
] as const;

/** The Phase 10/§17 controlled-change regression pair (real recorded
 * shapes): fast baseline → ~150ms-injected candidate. Classification over
 * this pair is MULTIPLE_REGRESSIONS (latency breaches + the closed-model
 * throughput consequence — exactly what the real §17 runs produced). */
export const CORPUS_REGRESSION_BASELINE = CORPUS_RUN_PASS;
export const CORPUS_REGRESSION_CANDIDATE = {
  ...CORPUS_RUN_LATENCY_FAIL,
  _id: "corpusrun-cand-0001",
  externalRunId: "ext-cand-0001",
  correlationId: "corr-cand-0001",
};

// --- corpus assembly ----------------------------------------------------------

export interface CorpusEntry {
  id: string;
  kind: "run_pass" | "run_threshold_fail" | "run_error_injection" | "run_execution_error" | "boundary_search" | "regression";
  description: string;
  evidence: Evidence | RegressionEvidence;
}

export function buildEvidenceCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [
    { id: "run_pass", kind: "run_pass", description: "successful LIVE_K6 run (threshold PASS)", evidence: buildRunEvidence(CORPUS_RUN_PASS) },
    { id: "run_threshold_fail", kind: "run_threshold_fail", description: "LIVE_K6 run failing the p95 threshold", evidence: buildRunEvidence(CORPUS_RUN_LATENCY_FAIL) },
    { id: "run_error_injection", kind: "run_error_injection", description: "LIVE_K6 run under ~30% injected 503s", evidence: buildRunEvidence(CORPUS_RUN_ERROR_INJECTION) },
    {
      id: "run_execution_error",
      kind: "run_execution_error",
      description: "execution_error run (bridge unreachable; no performance verdict possible)",
      evidence: buildRunEvidence(CORPUS_RUN_EXECUTION_ERROR),
    },
    {
      id: "boundary_search",
      kind: "boundary_search",
      description: "completed adaptive boundary search (all-PASS climb, ceiling stop)",
      evidence: buildSearchEvidence(CORPUS_SEARCH_COMPLETE, [...CORPUS_SEARCH_EXPERIMENTS]),
    },
  ];
  return entries;
}

/** Regression evidence needs the deterministic object + both runs; the
 * object is computed by the caller with the product engine over the frozen
 * pair (so the corpus stays engine-authoritative, not hand-authored).
 * Narrower than CorpusEntry: this entry always carries RegressionEvidence,
 * so callers (validators, tests) get the precise type without a cast. */
export interface RegressionCorpusEntry extends Omit<CorpusEntry, "evidence"> {
  evidence: RegressionEvidence;
}

export function buildRegressionCorpusEntry(
  deterministic: unknown,
): RegressionCorpusEntry {
  return {
    id: "regression",
    kind: "regression",
    description: "regression comparison over the recorded controlled-change pair (baseline fast → candidate ~150ms injected)",
    evidence: buildRegressionEvidence(
      "corpusregression-0001",
      CORPUS_REGRESSION_BASELINE,
      CORPUS_REGRESSION_CANDIDATE,
      deterministic as never,
    ),
  };
}
