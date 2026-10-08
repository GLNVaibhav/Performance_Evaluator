import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Convex Auth ships its exact table definitions (users, authSessions,
 * authAccounts, authRefreshTokens, authVerificationCodes, authVerifiers,
 * authRateLimits) as `authTables` — spreading them in guarantees the indexes
 * the library queries (e.g. authAccounts.providerAndAccountId) always exist.
 * Hand-copying them silently breaks signup when a table or index drifts.
 */
export default defineSchema({
  ...authTables,

  /**
   * One performance evaluation. Mirrors the repo's workflow contract:
   * intent -> compile (READY/NEEDS_CLARIFICATION/INVALID) -> approved run
   * -> execution -> result. The compiled plan is stored verbatim; the
   * raw NL input and interpretation provenance are kept for observability.
   */
  runs: defineTable({
    userId: v.id("users"),
    // request provenance
    rawInput: v.optional(v.string()),
    interpreter: v.optional(v.string()), // "llm" | "deterministic"
    objective: v.optional(v.string()),
    // compiled plan (TestPlan union, discriminated by objectiveType)
    plan: v.optional(
      v.object({
        objectiveType: v.string(), // fixed_load | boundary_search
        testType: v.string(), // baseline | stress | soak
        targetVus: v.number(),
        duration: v.optional(v.string()), // fixed_load
        rampDuration: v.optional(v.string()), // boundary_search
        holdDuration: v.optional(v.string()), // boundary_search
        selectedEndpoints: v.array(v.string()),
        // Deterministic per-endpoint dispatch weights (Phase 3 experimentation);
        // optional, mirrors the backend contract's endpoint_weights exactly.
        endpointWeights: v.optional(v.record(v.string(), v.number())),
        thresholds: v.object({ p95LatencyMs: v.number(), errorRate: v.number() }),
        assumptions: v.array(v.string()),
      }),
    ),
    // lifecycle: queued | running | completed | execution_error
    // Bridge runs add: submitted (accepted by the execution plane, not yet
    // polled) and cancelled (backend CANCELLED). Execution-mode semantics:
    // engineMode "live_k6" means metrics originate from a real FastAPI+k6
    // execution (see liveProvenance); "real" = bounded probe; "simulation"
    // = offline model. Simulation is NEVER substituted for a failed live run.
    status: v.string(),
    // Execution mode, explicit (Phase 5): "live_k6" | "real" | "simulation"
    // | "live_k6_pending" (accepted by the bridge, awaiting k6 evidence).
    executionMode: v.optional(v.string()),
    // Correlation with the execution plane (Phase 9):
    //   externalRunId — the FastAPI run id (set immediately after submission)
    //   correlationId — generated here, echoed by the backend's assumptions
    externalRunId: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    // Provenance for LIVE_K6 results (Phase 7) — ids/labels only, never
    // filesystem paths or secrets.
    liveProvenance: v.optional(
      v.object({
        engine: v.string(), // "k6"
        externalRunId: v.string(),
        source: v.string(), // "k6/results.json"
        completedAt: v.string(),
        correlationId: v.string(),
        artifactPresent: v.boolean(),
        backendSummary: v.optional(v.string()),
      }),
    ),
    // Full backend TestResult JSON, kept verbatim for provenance/debugging.
    externalResult: v.optional(v.any()),
    targetBaseUrl: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    plannedSeconds: v.optional(v.number()),
    progress: v.number(), // 0..100
    currentVus: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    // result (filled at completion)
    thresholdStatus: v.optional(v.string()), // PASS | FAIL (threshold evaluator output)
    // Verdict semantics label (BUG 4): real mode → PROBE_THRESHOLD_PASS/FAIL
    // (bounded probe, never a capacity claim); simulation → PASS/FAIL.
    verdictLabel: v.optional(v.string()),
    engineMode: v.optional(v.string()), // "real" | "simulation" — execution mode actually used
    // Bridge submission single-flight guard (Phase 9 duplicate protection)
    // and polling horizon (Phase 8.H — bounded polling, honest timeout).
    submissionLockUntil: v.optional(v.number()),
    pollDeadlineAt: v.optional(v.number()),
    // Target-contract outcome per endpoint (deterministic endpoint validation).
    endpointsVerification: v.optional(
      v.array(
        v.object({
          endpoint: v.string(),
          verified: v.boolean(),
          status: v.optional(v.number()),
          reason: v.optional(v.string()),
        }),
      ),
    ),
    probeStats: v.optional(
      v.object({
        requests: v.number(),
        non2xx: v.number(),
        networkErrors: v.number(),
        probeUrls: v.array(v.string()),
      }),
    ),
    // Adaptive boundary search linkage (deterministic controller phase).
    // Additive; unset for ordinary runs. The search record (see the
    // boundarySearches table) is the server-authoritative state; these
    // fields only link an iteration to its search and iteration number.
    boundarySearchId: v.optional(v.id("boundarySearches")),
    boundarySearchIteration: v.optional(v.number()),
    boundarySearchFingerprint: v.optional(v.string()),
    metrics: v.optional(
      v.object({
        totalRequests: v.number(),
        totalFailures: v.number(),
        errorRate: v.number(),
        p50: v.number(),
        p95: v.number(),
        p99: v.number(),
        maxRps: v.number(),
        peakVus: v.number(),
        iterations: v.number(),
        // real mode only — measured latency aggregates (avg/max)
        latencyAvgMs: v.optional(v.number()),
        latencyMaxMs: v.optional(v.number()),
      }),
    ),
    thresholdViolations: v.optional(v.array(v.string())),
    analysis: v.optional(v.array(v.string())),
    summary: v.optional(v.string()),
    analyzer: v.optional(v.string()), // "llm" | "deterministic"
    score: v.optional(v.number()), // 0..100
  })
    .index("userId", ["userId"])
    .index("status", ["status"]),

  /** Per-second ingest samples, streamed by the executor while running. */
  samples: defineTable({
    runId: v.id("runs"),
    tSec: v.number(),
    vus: v.number(),
    rps: v.number(),
    p50: v.number(),
    p95: v.number(),
    p99: v.number(),
    errors: v.number(),
    plannedVus: v.optional(v.number()), // workload envelope (real mode keeps measured rps/errors honest)
  }).index("runId", ["runId"]),

  /** Narrated engine log: plan -> ramp -> saturation -> verdict. */
  logs: defineTable({
    runId: v.id("runs"),
    at: v.number(),
    phase: v.string(),
    message: v.string(),
  }).index("runId", ["runId"]),

  /**
   * Deterministic adaptive boundary search (server-authoritative state).
   * The controller advances this document one experiment at a time; every
   * iteration is a normal immutable run (runs.boundarySearchId links back).
   * NO LLM participates: next VU level, PASS/FAIL classification, stop
   * conditions, and safety limits are pure deterministic rules
   * (boundarySearchLogic.ts). The final output is an "estimated safe
   * operating region" — never an exact-capacity claim.
   */
  boundarySearches: defineTable({
    userId: v.id("users"),
    targetBaseUrl: v.string(),
    status: v.string(), // active | completed | error | blocked
    // frozen base plan (per-iteration targetVus is overridden per experiment)
    basePlan: v.object({
      testType: v.string(),
      rampDuration: v.string(),
      holdDuration: v.string(),
      selectedEndpoints: v.array(v.string()),
      endpointWeights: v.optional(v.record(v.string(), v.number())),
      thresholds: v.object({ p95LatencyMs: v.number(), errorRate: v.number() }),
      assumptions: v.array(v.string()),
    }),
    // search range + limits (never raised by the controller)
    minVus: v.number(),
    maxVus: v.number(),
    tolerance: v.number(),
    maximumExperiments: v.number(),
    // boundaries: null = not yet observed (never invented)
    lowestKnownPassVus: v.optional(v.number()),
    highestKnownFailVus: v.optional(v.number()),
    currentVus: v.optional(v.number()),
    currentIterationRunId: v.optional(v.id("runs")),
    currentIteration: v.number(), // next iteration number to create (1-based)
    experimentCount: v.number(), // completed experiments so far
    experimentIds: v.array(v.id("runs")),
    // only set when terminal
    result: v.optional(
      v.object({
        status: v.string(), // completed | error | blocked
        lowerBound: v.optional(v.number()), // highest observed passing load
        upperBound: v.optional(v.number()), // lowest observed failing load (unknown → absent)
        lowestObservedFailingVus: v.optional(v.number()),
        highestObservedPassingVus: v.optional(v.number()),
        note: v.string(),
        stopReason: v.optional(v.string()),
      }),
    ),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("userId", ["userId"])
    .index("status", ["status"]),

  /**
   * AI Performance Intelligence (interpretation-only phase). ONE versioned
   * analysis document per generation — append-only, never an overwrite: a
   * regenerated analysis becomes version N+1 and the prior version (and the
   * underlying deterministic run/search documents) are never modified.
   * The AI has zero execution authority; it only reads structured evidence
   * and returns validated, classification-tagged interpretation.
   */
  aiAnalyses: defineTable({
    userId: v.id("users"),
    // "run" | "boundary_search" | "regression" (Phase 10)
    subjectKind: v.string(),
    runId: v.optional(v.id("runs")),
    boundarySearchId: v.optional(v.id("boundarySearches")),
    regressionAnalysisId: v.optional(v.id("regressionAnalyses")),
    version: v.number(), // 1-based, monotonic per subject (regeneration = new doc)
    // analysis provenance
    analyzerKind: v.string(), // "llm" | "deterministic" (fallback / no-key / incomplete evidence)
    model: v.optional(v.string()), // LLM model id when analyzerKind === "llm"
    promptVersion: v.string(), // e.g. "perforso.ai-analyst.v1"
    generatedAt: v.number(),
    // The validated structured analysis (deterministic validation layer has
    // already rejected/sanitized unsupported claims; `analysis.rejected`
    // records every removed statement with its reason).
    // Phase 10: analysis is a union of the two VALIDATED shapes —
    //  (a) run/boundary-search analyses (Phase 9: observations + threshold
    //      + boundary assessment), or
    //  (b) regression interpretations (regression/aiValidate.ts: whatChanged
    //      + endpointObservations; the deterministic object lives on the
    //      regressionAnalyses row, never duplicated here).
    analysis: v.union(
      v.object({
        summary: v.string(),
        observations: v.array(
          v.object({
            statement: v.string(),
            classification: v.string(), // OBSERVED | INFERRED | UNKNOWN
            evidence: v.array(v.string()),
          }),
        ),
        thresholdAssessment: v.object({
          status: v.string(),
          evidence: v.array(v.string()),
        }),
        endpointObservations: v.array(
          v.object({
            endpoint: v.string(),
            statement: v.string(),
            classification: v.string(),
            evidence: v.array(v.string()),
          }),
        ),
        boundaryAssessment: v.object({
          highestObservedPass: v.optional(v.number()),
          lowestObservedFail: v.optional(v.number()),
          estimatedSafeOperatingRegion: v.optional(
            v.object({
              lowerBound: v.optional(v.number()),
              upperBound: v.optional(v.number()),
            }),
          ),
        }),
        limitations: v.array(v.string()),
        confidenceNotes: v.array(v.string()),
        rejected: v.array(
          v.object({ reason: v.string(), excerpt: v.string() }),
        ),
      }),
      v.object({
        summary: v.string(),
        whatChanged: v.array(
          v.object({
            statement: v.string(),
            classification: v.string(), // OBSERVED | INFERRED | UNKNOWN
            evidence: v.array(v.string()),
          }),
        ),
        endpointObservations: v.array(
          v.object({
            endpoint: v.string(),
            statement: v.string(),
            classification: v.string(),
            evidence: v.array(v.string()),
          }),
        ),
        limitations: v.array(v.string()),
        confidenceNotes: v.array(v.string()),
        rejected: v.array(
          v.object({ reason: v.string(), excerpt: v.string() }),
        ),
      }),
    ),
    // Evidence references actually used (registry keys, for traceability).
    evidenceRefs: v.array(v.string()),
  })
    .index("runId", ["runId"])
    .index("boundarySearchId", ["boundarySearchId"])
    .index("regressionAnalysisId", ["regressionAnalysisId"]),

  /**
   * Performance Regression Intelligence (Phase 10) — independent history.
   * A regression analysis REFERENCES two immutable runs (baselineRunId /
   * candidateRunId); the runs themselves are never copied or mutated.
   * `deterministic` holds the reproducible regression object (runs + policy
   * → same output). Append-only: a re-analysis is a NEW document with
   * version N+1; existing rows are immutable.
   */
  regressionAnalyses: defineTable({
    userId: v.id("users"),
    baselineRunId: v.id("runs"),
    candidateRunId: v.id("runs"),
    version: v.number(), // 1-based, monotonic per (baseline, candidate) pair
    policyVersion: v.string(), // e.g. "perforso.regression-policy.v1"
    createdAt: v.number(),
    // The structured deterministic object (§11) — computed at creation time
    // by the pure engine and stored verbatim.
    deterministic: v.any(),
    // The latest validated AI interpretation, if one was generated. The AI
    // document itself lives in aiAnalyses (subjectKind "regression"); this
    // field links it for the UI and records generation provenance.
    aiAnalysisId: v.optional(v.id("aiAnalyses")),
    aiAnalyzerKind: v.optional(v.string()), // "llm" | "deterministic"
    aiGeneratedAt: v.optional(v.number()),
    aiAnalysis: v.optional(v.any()), // validated regression interpretation (denormalized read copy)
  })
    .index("baselineRunId", ["baselineRunId"])
    .index("candidateRunId", ["candidateRunId"])
    .index("userId", ["userId"]),
});
