/**
 * Phase 11 — AI EVALUATION MATRIX over the FIXED evidence corpus (§14).
 *
 * Exercises the DETERMINISTIC validators (the authority — no model, no
 * network) against correct and adversarial claims for every corpus kind:
 * correct numerical claims pass; altered numbers, invented endpoints,
 * unsupported causes, capacity claims, and classification overrides are
 * rejected with recorded reasons.
 */
import { describe, expect, test } from "bun:test";
import { validateAnalysis } from "../ai/validate";
import { validateRegressionAnalysis } from "../regression/aiValidate";
import { computeDeterministicRegression, DEFAULT_REGRESSION_POLICY } from "../regression/core";
import {
  buildEvidenceCorpus,
  buildRegressionCorpusEntry,
  CORPUS_RUN_PASS,
  CORPUS_RUN_ERROR_INJECTION,
  CORPUS_SEARCH_COMPLETE,
  CORPUS_SEARCH_EXPERIMENTS,
  CORPUS_REGRESSION_BASELINE,
  CORPUS_REGRESSION_CANDIDATE,
} from "./evidenceCorpus";

const corpus = buildEvidenceCorpus();
const byId = new Map(corpus.map((e) => [e.id, e]));

// --- corpus integrity -----------------------------------------------------------

describe("phase 11 evidence corpus", () => {
  test("contains all six required kinds", () => {
    const kinds = new Set<string>(corpus.map((e) => e.kind));
    for (const kind of ["run_pass", "run_threshold_fail", "run_error_injection", "run_execution_error", "boundary_search"]) {
      expect(kinds.has(kind)).toBe(true);
    }
    // regression is assembled with the engine below; the base kinds cover the rest
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });

  test("corpus entries build valid evidence registries", () => {
    for (const entry of corpus) {
      expect(Object.keys(entry.evidence.numbers).length).toBeGreaterThan(0);
      expect(entry.evidence.evidenceKeys.length).toBeGreaterThan(0);
    }
  });

  test("error-injection corpus entry carries real 503 evidence", () => {
    const ev = byId.get("run_error_injection")!.evidence;
    const run = ev as Extract<typeof ev, { subject: "run" }>;
    expect(run.externalMetrics?.statusCodes).toContainEqual({ code: "503", count: 24 });
    expect(run.thresholdStatus).toBe("FAIL");
  });

  test("execution-error corpus entry yields no performance verdict", () => {
    const ev = byId.get("run_execution_error")!.evidence as Extract<(typeof corpus)[number]["evidence"], { subject: "run" }>;
    expect(ev.status).toBe("execution_error");
    expect(ev.limitations.some((l) => l.toLowerCase().includes("execution_error"))).toBe(true);
  });
});

// --- run-kind validator matrix ----------------------------------------------------

describe("phase 11 AI validator matrix — run corpus", () => {
  const pass = byId.get("run_pass")!.evidence as Extract<(typeof corpus)[number]["evidence"], { subject: "run" }>;

  test("correct numerical claim is accepted", () => {
    const v = validateAnalysis(
      {
        summary: "The run passed its thresholds.",
        observations: [
          {
            statement: "p95 latency was 1.4684064ms across 80 requests.",
            classification: "OBSERVED",
            evidence: [`run.${CORPUS_RUN_PASS._id}.metrics.p95`, `run.${CORPUS_RUN_PASS._id}.metrics.requests`],
          },
        ],
        threshold_assessment: { status: "PASS", evidence: ["thresholdStatus:PASS"] },
      },
      pass,
    );
    expect(v.rejected).toHaveLength(0);
    expect(v.observations).toHaveLength(1);
    expect(v.thresholdAssessment.status).toBe("PASS");
  });

  test("altered numerical claim is rejected", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        observations: [{ statement: "p95 latency was 9.99ms.", classification: "OBSERVED", evidence: [pass.evidenceKeys[0]] }],
      },
      pass,
    );
    expect(v.observations).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("not present in recorded evidence"))).toBe(true);
  });

  test("invented endpoint is rejected", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        endpoint_observations: [
          { endpoint: "/nonexistent", statement: "ok", classification: "UNKNOWN", evidence: [] },
        ],
      },
      pass,
    );
    expect(v.endpointObservations).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("nonexistent endpoint"))).toBe(true);
  });

  test("unsupported root-cause claim is rejected", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        observations: [
          { statement: "The database caused the latency.", classification: "OBSERVED", evidence: [pass.evidenceKeys[0]] },
        ],
      },
      pass,
    );
    expect(v.observations).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("root-cause"))).toBe(true);
  });

  test("unsupported capacity claim is rejected", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        observations: [
          { statement: "This proves the maximum capacity of the system.", classification: "INFERRED", evidence: [] },
        ],
      },
      pass,
    );
    expect(v.observations).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("capacity"))).toBe(true);
  });

  test("threshold-status override is rejected; verbatim restatement accepted", () => {
    const fail = byId.get("run_threshold_fail")!.evidence as Extract<(typeof corpus)[number]["evidence"], { subject: "run" }>;
    const rejected = validateAnalysis(
      { summary: "s", threshold_assessment: { status: "PASS", evidence: [] } },
      fail,
    );
    expect(rejected.thresholdAssessment.status).toBe("NOT_ASSESSED");
    expect(rejected.rejected.some((r) => r.reason.includes("does not match the backend-authoritative verdict"))).toBe(true);

    const restated = validateAnalysis(
      { summary: "s", threshold_assessment: { status: "FAIL", evidence: ["thresholdStatus:FAIL"] } },
      fail,
    );
    expect(restated.thresholdAssessment.status).toBe("FAIL");
    expect(restated.rejected).toHaveLength(0);
  });

  test("execution-error corpus cannot be spun into a performance verdict", () => {
    const err = byId.get("run_execution_error")!.evidence as Extract<(typeof corpus)[number]["evidence"], { subject: "run" }>;
    const v = validateAnalysis(
      {
        summary: "s",
        observations: [{ statement: "The run failed its p95 threshold.", classification: "OBSERVED", evidence: [] }],
      },
      err,
    );
    // No threshold evidence exists; anything inferred from it must carry no
    // valid refs, and the deterministic limitations are always prepended.
    expect(v.limitations.some((l) => l.toLowerCase().includes("execution_error"))).toBe(true);
    expect(v.observations).toHaveLength(0);
  });
});

// --- boundary-search-kind validator matrix -----------------------------------------

describe("phase 11 AI validator matrix — boundary-search corpus", () => {
  const search = byId.get("boundary_search")!.evidence as Extract<(typeof corpus)[number]["evidence"], { subject: "boundary_search" }>;

  test("correct boundary restatement accepted", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        boundary_assessment: { highest_observed_pass: 6, lowest_observed_fail: null },
        observations: [{ statement: "The search observed a passing load at 6 VUs.", classification: "OBSERVED", evidence: ["search.corpussearch-0001.lowestKnownPassVus"] }],
      },
      search,
    );
    expect(v.rejected).toHaveLength(0);
    expect(v.boundaryAssessment.highestObservedPass).toBe(6);
  });

  test("altered boundary value rejected", () => {
    const v = validateAnalysis(
      { summary: "s", boundary_assessment: { highest_observed_pass: 9 } },
      search,
    );
    expect(v.rejected.some((r) => r.reason.includes("altered boundary value"))).toBe(true);
  });

  test("exact-capacity claim rejected even when boundaries are restated correctly", () => {
    const v = validateAnalysis(
      {
        summary: "s",
        observations: [{ statement: "The estimated safe operating region shows the exact capacity is 6.", classification: "INFERRED", evidence: [] }],
      },
      search,
    );
    expect(v.rejected.some((r) => r.reason.includes("capacity"))).toBe(true);
  });

  test("experiment sequence evidence (iteration refs) exists in the registry", () => {
    expect(CORPUS_SEARCH_EXPERIMENTS.length).toBe(4);
    expect(search.evidenceKeys.some((k) => k.includes("exp.4"))).toBe(true);
    expect(search.result?.stopReason).toBe("safety_ceiling");
  });
});

// --- regression-kind validator matrix ------------------------------------------------

describe("phase 11 AI validator matrix — regression corpus", () => {
  const deterministic = computeDeterministicRegression(CORPUS_REGRESSION_BASELINE, CORPUS_REGRESSION_CANDIDATE, DEFAULT_REGRESSION_POLICY);
  const entry = buildRegressionCorpusEntry(deterministic);
  const ev = entry.evidence;

  test("frozen pair classifies from stored evidence exactly as the real §17 runs did", () => {
    // Closed 5-VU workload + ~150ms injection → latency breaches AND the
    // throughput consequence (real §17 result: MULTIPLE_REGRESSIONS).
    expect(deterministic.status).toBe("MULTIPLE_REGRESSIONS");
    expect(deterministic.compatibility).toBe("COMPATIBLE");
    expect(deterministic.breaches.length).toBe(6);
  });

  test("correct restatement accepted", () => {
    const v = validateRegressionAnalysis(
      {
        summary: "Deterministic classification: MULTIPLE_REGRESSIONS under policy perforso.regression-policy.v1.",
        what_changed: [
          {
            statement: `p95 changed by ${deterministic.metrics.p95.absoluteDelta} from baseline ${deterministic.metrics.p95.baseline} to candidate ${deterministic.metrics.p95.candidate}.`,
            classification: "OBSERVED",
            evidence: [`regression.metrics.p95.absoluteDelta`, `run:${deterministic.baselineRunId}`],
          },
        ],
        endpoint_observations: [
          {
            endpoint: "/products",
            statement: `The candidate recorded higher p95 latency for /products: ${deterministic.endpointResults[0].p95.baseline}ms → ${deterministic.endpointResults[0].p95.candidate}ms.`,
            classification: "OBSERVED",
            evidence: ["regression.endpoint./products.p95.absoluteDelta"],
          },
        ],
      },
      ev,
    );
    expect(v.rejected).toHaveLength(0);
    expect(v.whatChanged).toHaveLength(1);
    expect(v.endpointObservations).toHaveLength(1);
  });

  test("fabricated delta rejected", () => {
    const v = validateRegressionAnalysis(
      {
        summary: "s",
        what_changed: [{ statement: "p95 changed by 4242.42.", classification: "OBSERVED", evidence: [ev.evidenceKeys[0]] }],
      },
      ev,
    );
    expect(v.whatChanged).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("not present in recorded evidence"))).toBe(true);
  });

  test("classification override rejected; verbatim restatement allowed", () => {
    const override = validateRegressionAnalysis(
      { summary: "s", what_changed: [{ statement: "The comparison shows NO_REGRESSION_DETECTED.", classification: "UNKNOWN", evidence: [] }] },
      ev,
    );
    expect(override.whatChanged).toHaveLength(0);
    expect(override.rejected.some((r) => r.reason.includes("contradicts the deterministic classification"))).toBe(true);

    const restated = validateRegressionAnalysis(
      { summary: `Deterministic regression analysis: ${deterministic.status}.`, what_changed: [], endpoint_observations: [], limitations: [], confidence_notes: [] },
      ev,
    );
    expect(restated.rejected).toHaveLength(0);
  });

  test("nonexistent endpoint rejected", () => {
    const v = validateRegressionAnalysis(
      {
        summary: "s",
        endpoint_observations: [{ endpoint: "/cart", statement: "slower", classification: "OBSERVED", evidence: [ev.evidenceKeys[0]] }],
      },
      ev,
    );
    expect(v.endpointObservations).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("nonexistent endpoint"))).toBe(true);
  });

  test("root-cause language rejected in regression interpretations", () => {
    const v = validateRegressionAnalysis(
      {
        summary: "s",
        what_changed: [{ statement: "The database caused the regression.", classification: "OBSERVED", evidence: [ev.evidenceKeys[0]] }],
      },
      ev,
    );
    expect(v.whatChanged).toHaveLength(0);
    expect(v.rejected.some((r) => r.reason.includes("root-cause"))).toBe(true);
  });

  test("CORPUS search state and error-injection fixtures are frozen and stable", () => {
    expect(CORPUS_SEARCH_COMPLETE.lowestKnownPassVus).toBe(6);
    expect(CORPUS_SEARCH_COMPLETE.highestKnownFailVus).toBeNull();
    expect(CORPUS_RUN_ERROR_INJECTION.metrics.totalFailures).toBe(24);
  });
});
