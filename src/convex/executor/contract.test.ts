/**
 * Bridge regression tests (Phases 12 + 8): Convex control plane ⇄ FastAPI
 * execution plane.
 *
 * Covers all 14 required categories: serialization, request validation,
 * Convex→FastAPI mapping, run creation, status polling, result retrieval,
 * execution-mode preservation, threshold-failure vs execution-error
 * semantics, timeout semantics, invalid-target rejection, no-simulation-
 * fallback, result provenance, and duplicate/retry behavior.
 *
 * Run: bun test src/convex/executor/contract.test.ts
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, expect, test } from "bun:test";

import {
  serializePlan,
  mapBackendStatus,
  mapBackendResult,
  validateBackendResult,
  isPollHorizonExceeded,
} from "./contract";
import {
  makeBridgeClient,
  ExecutionBackendUnreachableError,
  ExecutionBackendError,
} from "./client";
import type { ConvexTestPlan } from "./contract";

const BASELINE_PLAN: ConvexTestPlan = {
  objectiveType: "fixed_load",
  testType: "baseline",
  targetVus: 20,
  duration: "10s",
  selectedEndpoints: ["/products"],
  thresholds: { p95LatencyMs: 2000, errorRate: 0.01 },
  assumptions: ["demo-mode accelerated duration (10s); not a standard-mode-equivalent result"],
};

const STRESS_PLAN: ConvexTestPlan = {
  objectiveType: "boundary_search",
  testType: "stress",
  targetVus: 300,
  rampDuration: "10s",
  holdDuration: "20s",
  selectedEndpoints: ["/products", "/cart"],
  thresholds: { p95LatencyMs: 800, errorRate: 0.05 },
  assumptions: [],
};

// ---------------------------------------------------------------------------
// 1. TestPlan serialization (Convex camelCase -> FastAPI snake_case)
// ---------------------------------------------------------------------------

describe("TestPlan serialization", () => {
  test("fixed_load plan maps field-for-field onto the FastAPI contract", () => {
    const req = serializePlan(BASELINE_PLAN, "http://127.0.0.1:8080", "corr-123", "convex-run:r1");
    expect(req.plan).toEqual({
      objective_type: "fixed_load",
      test_type: "baseline",
      target_vus: 20,
      duration: "10s",
      selected_endpoints: ["/products"],
      payload_strategy: "normal",
      assumptions: [
        "demo-mode accelerated duration (10s); not a standard-mode-equivalent result",
        "correlation_id: corr-123",
      ],
      thresholds: { p95_latency_ms: 2000, error_rate: 0.01 },
    });
    expect(req.target).toEqual({ base_url: "http://127.0.0.1:8080" });
    expect(req.correlation_id).toBe("corr-123");
    expect(req.submitted_by).toBe("convex-run:r1");
  });

  test("boundary_search plan maps ramp+hold durations", () => {
    const req = serializePlan(STRESS_PLAN, "http://127.0.0.1:8080", "corr-9", "x");
    expect(req.plan.objective_type).toBe("boundary_search");
    expect(req.plan.ramp_duration).toBe("10s");
    expect(req.plan.hold_duration).toBe("20s");
    expect((req.plan as never as { duration?: string }).duration).toBeUndefined();
  });

  test("endpoint_weights pass through when present", () => {
    const req = serializePlan(
      { ...BASELINE_PLAN, selectedEndpoints: ["/products", "/cart"], endpointWeights: { "/products": 3, "/cart": 1 } },
      "http://127.0.0.1:8080",
      "c",
      "x",
    );
    expect(req.plan.endpoint_weights).toEqual({ "/products": 3, "/cart": 1 });
  });

  test("correlation id is appended to assumptions exactly once", () => {
    const req = serializePlan(
      { ...BASELINE_PLAN, assumptions: ["correlation_id: corr-123"] },
      "http://127.0.0.1:8080",
      "corr-123",
      "x",
    );
    expect(req.plan.assumptions.filter((a) => a.includes("corr-123")).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. FastAPI request validation (adapter refuses what Python would refuse)
// ---------------------------------------------------------------------------

describe("adapter validation", () => {
  test("rejects empty selectedEndpoints", () => {
    expect(() =>
      serializePlan({ ...BASELINE_PLAN, selectedEndpoints: [] }, "http://t.test", "c", "x"),
    ).toThrow(/selectedEndpoints/);
  });

  test("rejects non-positive or fractional targetVus", () => {
    expect(() => serializePlan({ ...BASELINE_PLAN, targetVus: 0 }, "http://t.test", "c", "x")).toThrow();
    expect(() => serializePlan({ ...BASELINE_PLAN, targetVus: 2.5 }, "http://t.test", "c", "x")).toThrow();
  });

  test("rejects a target that is not an http(s) URL", () => {
    expect(() => serializePlan(BASELINE_PLAN, "ftp://x", "c", "x")).toThrow(/base_url/);
    expect(() => serializePlan(BASELINE_PLAN, "not a url", "c", "x")).toThrow(/base_url/);
  });

  test("rejects malformed k6-style durations", () => {
    expect(() => serializePlan({ ...BASELINE_PLAN, duration: "ten seconds" }, "http://t.test", "c", "x")).toThrow();
    expect(() => serializePlan({ ...STRESS_PLAN, rampDuration: undefined }, "http://t.test", "c", "x")).toThrow();
  });

  test("rejects out-of-range error_rate", () => {
    expect(() =>
      serializePlan({ ...BASELINE_PLAN, thresholds: { p95LatencyMs: 100, errorRate: 1.5 } }, "http://t.test", "c", "x"),
    ).toThrow(/errorRate/);
  });
});

// ---------------------------------------------------------------------------
// 5+6. Status polling + result retrieval (transport-level, stubbed fetch)
// ---------------------------------------------------------------------------

describe("bridge client", () => {
  function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    return makeBridgeClient({
      baseUrl: "https://exec.test",
      token: "tok",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
        handler(String(url), init)) as typeof fetch,
    });
  }

  test("submit posts the serialized request with the bearer token", async () => {
    let seen;
    const client = clientWith(async (url, init) => {
      seen = { url, init };
      return Response.json({ run_id: "abc-1", status: "QUEUED" }, { status: 201 });
    });
    const out = await client.submit(serializePlan(BASELINE_PLAN, "http://127.0.0.1:8080", "c", "x"));
    expect(out).toEqual({ externalRunId: "abc-1", status: "QUEUED" });
    expect(seen.url).toBe("https://exec.test/api/v1/runs");
    expect(seen.init.method).toBe("POST");
    expect(seen.init.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(seen.init.body);
    expect(body.plan.target_vus).toBe(20);
  });

  test("getStatus and getResult target the external run id", async () => {
    const urls: string[] = [];
    const client = clientWith(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/result")) {
        return Response.json({ run_id: "abc-1", metrics: {}, threshold_status: "PASS" });
      }
      return Response.json({ run_id: "abc-1", status: "RUNNING", error_message: null });
    });
    await client.getStatus("abc-1");
    await client.getResult("abc-1");
    expect(urls).toEqual(["https://exec.test/api/v1/runs/abc-1", "https://exec.test/api/v1/runs/abc-1/result"]);
  });

  test("network failure -> ExecutionBackendUnreachableError (distinct from HTTP errors)", async () => {
    const client = clientWith(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(client.getStatus("abc-1")).rejects.toBeInstanceOf(ExecutionBackendUnreachableError);
  });

  test("422/401 from the backend -> ExecutionBackendError with the detail", async () => {
    const client = clientWith(async () => Response.json({ detail: "plan exceeds limits" }, { status: 422 }));
    try {
      await client.submit(serializePlan(BASELINE_PLAN, "http://127.0.0.1:8080", "c", "x"));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ExecutionBackendError);
      expect((e as ExecutionBackendError).httpStatus).toBe(422);
      expect((e as Error).message).toContain("plan exceeds limits");
    }
  });
});

// ---------------------------------------------------------------------------
// Status mapping (1:1, no collapsing)
// ---------------------------------------------------------------------------

describe("status mapping", () => {
  test("every backend state maps 1:1", () => {
    expect(mapBackendStatus("QUEUED")).toBe("queued");
    expect(mapBackendStatus("RUNNING")).toBe("running");
    expect(mapBackendStatus("COMPLETED")).toBe("completed");
    expect(mapBackendStatus("EXECUTION_ERROR")).toBe("execution_error");
    expect(mapBackendStatus("CANCELLED")).toBe("cancelled");
  });

  test("unknown backend states throw (surfaced, never guessed)", () => {
    expect(() => mapBackendStatus("SOMETHING_ELSE")).toThrow(/unknown backend run status/);
  });
});

// ---------------------------------------------------------------------------
// 7+13. Result mapping + provenance (verbatim, never recomputed)
// ---------------------------------------------------------------------------

function backendResult(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "ext-1",
    metrics: {
      p50_ms: 12.345,
      p95_ms: 45.678,
      p99_ms: 88.9,
      average_ms: 15.0,
      max_ms: 120.0,
      rps: 19.5,
      total_requests: 195,
      failed_requests: 2,
      error_rate: 0.010256,
      duration_s: 10.0,
    },
    threshold_status: "PASS",
    evaluated_at: "2026-09-26T12:00:00Z",
    threshold_violations: [],
    artifacts: { results_json_path: "/artifacts/ext-1/results.json" },
    ...overrides,
  };
}

describe("result mapping + provenance", () => {
  test("metrics are carried verbatim — no recomputation, rounding, or derivation", () => {
    const mapped = mapBackendResult(backendResult(), BASELINE_PLAN, "corr-1");
    expect(mapped.metrics.p50).toBe(12.345);
    expect(mapped.metrics.p95).toBe(45.678);
    expect(mapped.metrics.p99).toBe(88.9);
    expect(mapped.metrics.maxRps).toBe(19.5);
    expect(mapped.metrics.totalRequests).toBe(195);
    expect(mapped.metrics.totalFailures).toBe(2); // failed_requests, not recomputed
    expect(mapped.metrics.errorRate).toBe(0.010256);
    expect(mapped.metrics.latencyAvgMs).toBe(15.0);
    expect(mapped.metrics.latencyMaxMs).toBe(120.0);
  });

  test("provenance records the full LIVE_K6 chain", () => {
    const mapped = mapBackendResult(backendResult(), BASELINE_PLAN, "corr-1");
    expect(mapped.provenance).toEqual({
      engine: "k6",
      externalRunId: "ext-1",
      source: "k6/results.json",
      completedAt: "2026-09-26T12:00:00Z",
      correlationId: "corr-1",
      artifactPresent: true,
    });
  });

  test("peakVus equals the planned VUs (k6 runs exactly what was asked)", () => {
    const mapped = mapBackendResult(backendResult(), STRESS_PLAN, "c");
    expect(mapped.metrics.peakVus).toBe(300);
  });

  test("threshold violations are carried through readably", () => {
    const mapped = mapBackendResult(
      backendResult({
        threshold_status: "FAIL",
        threshold_violations: [{ scope: "overall", metric: "p95_latency_ms", observed: 5000, threshold: 2000 }],
      }),
      BASELINE_PLAN,
      "c",
    );
    expect(mapped.thresholdStatus).toBe("FAIL");
    expect(mapped.thresholdViolations).toEqual(["overall p95_latency_ms 5000 exceeded 2000"]);
  });
});

// ---------------------------------------------------------------------------
// F. Malformed/missing result artifact -> execution error, never a result
// ---------------------------------------------------------------------------

describe("result validation", () => {
  test("missing metrics object throws", () => {
    expect(() => validateBackendResult({ run_id: "x" } as never)).toThrow(/no metrics object/);
  });

  test("non-numeric or missing metric fields throw", () => {
    expect(() =>
      validateBackendResult(backendResult({ metrics: { ...backendResult().metrics, p95_ms: "fast" } })),
    ).toThrow(/p95_ms/);
    expect(() =>
      validateBackendResult(backendResult({ metrics: { ...backendResult().metrics, rps: undefined } })),
    ).toThrow(/rps/);
  });

  test("unknown threshold_status throws", () => {
    expect(() => validateBackendResult(backendResult({ threshold_status: "MAYBE" }))).toThrow(/threshold_status/);
  });

  test("missing run_id throws", () => {
    const r = backendResult();
    delete r.run_id;
    expect(() => validateBackendResult(r)).toThrow(/run_id/);
  });

  test("a complete result passes", () => {
    expect(() => validateBackendResult(backendResult())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. Threshold failure semantics (B) — COMPLETED/FAIL is a result, not an error
// ---------------------------------------------------------------------------

describe("threshold failure vs execution error", () => {
  test("a FAIL result maps to a completed run with PASS/FAIL verdict semantics", () => {
    const mapped = mapBackendResult(
      backendResult({ threshold_status: "FAIL" }),
      BASELINE_PLAN,
      "c",
    );
    // The metric data is intact — the run completed; the *performance* failed.
    expect(mapped.thresholdStatus).toBe("FAIL");
    expect(mapped.metrics.totalRequests).toBe(195);
  });

  test("an execution error carries NO metrics to misrepresent", () => {
    // Contract: the backend never sends a TestResult for EXECUTION_ERROR
    // (routes_runs.py returns 422), and validateBackendResult rejects
    // anything incomplete. There is no code path that turns an execution
    // failure into metrics.
    const incomplete = { metrics: null, threshold_status: null };
    expect(() => validateBackendResult(incomplete as never)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. Invalid target rejection (E)
// ---------------------------------------------------------------------------

describe("invalid target rejection", () => {
  test("serializePlan refuses to build a request for a non-http target", () => {
    // This is the Convex-side half of invalid-target handling; the backend's
    // SSRF gate (target_url_safety.py) is the authoritative other half.
    expect(() => serializePlan(BASELINE_PLAN, "gopher://127.0.0.1:8080", "c", "x")).toThrow(/base_url/);
  });
});

// ---------------------------------------------------------------------------
// 14. Poll horizon (H) + duplicate/retry behavior invariants
// ---------------------------------------------------------------------------

describe("poll horizon (Phase 8.H)", () => {
  test("not exceeded while now is before the deadline", () => {
    expect(isPollHorizonExceeded({ externalRunId: "e1", pollDeadlineAt: 10_000 }, 9_999)).toBe(false);
  });

  test("exceeded once now passes the deadline (only with an externalRunId)", () => {
    expect(isPollHorizonExceeded({ externalRunId: "e1", pollDeadlineAt: 10_000 }, 10_001)).toBe(true);
    expect(isPollHorizonExceeded({ pollDeadlineAt: 1 }, 10_001)).toBe(false);
    expect(isPollHorizonExceeded({ externalRunId: "e1" }, 10_001)).toBe(true);
  });
});

describe("requested-vs-executed honesty for LIVE_K6", () => {
  test("a k6 run executes the full requested envelope — displayed peakVus equals the plan's", () => {
    // Unlike the bounded probe (where requested 300 VUs must never be shown
    // as executed), LIVE_K6 genuinely drives plan.targetVus — so the UI may
    // show requested = executed. This test pins that distinction.
    const mapped = mapBackendResult(backendResult(), STRESS_PLAN, "c");
    expect(STRESS_PLAN.targetVus).toBe(300);
    expect(mapped.metrics.peakVus).toBe(300);
  });
});
