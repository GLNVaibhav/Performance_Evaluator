/**
 * The ONE bridge contract between the Convex control plane and the FastAPI
 * execution plane. Everything Convex knows about the authoritative Python
 * TestPlan flows through this module — pure functions only, fully unit-tested.
 *
 * Convex TestPlan (camelCase, from compiler.ts)
 *   → serializePlan (this module)
 *   → FastAPI RunCreateRequest (backend/app/schemas/run.py)
 *   → Python TestPlan (backend/app/schemas/test_plan.py)
 *   → k6
 *
 * Status and result mapping flow the other way, verbatim — the control plane
 * never recomputes a metric. See backend/app/schemas/{run,test_result}.py for
 * the authoritative Python side.
 */

// --- Convex side shapes (from compiler.ts / schema.ts) ----------------------

export interface ConvexThresholds {
  p95LatencyMs: number;
  errorRate: number;
}

/** Exactly src/convex/compiler.ts's CompiledPlan. */
export interface ConvexTestPlan {
  objectiveType: "fixed_load" | "boundary_search";
  testType: "baseline" | "stress" | "soak";
  targetVus: number;
  duration?: string;
  rampDuration?: string;
  holdDuration?: string;
  selectedEndpoints: string[];
  thresholds: ConvexThresholds;
  assumptions: string[];
  endpointWeights?: Record<string, number>;
}

// --- FastAPI side shapes (from backend/app/schemas/{run,test_plan}.py) ------

export interface FastApiThresholds {
  p95_latency_ms: number;
  error_rate: number;
}

export interface FastApiTestPlan {
  objective_type: "fixed_load" | "boundary_search";
  test_type: "baseline" | "stress" | "soak";
  target_vus: number;
  duration?: string;
  ramp_duration?: string;
  hold_duration?: string;
  selected_endpoints: string[];
  endpoint_weights?: Record<string, number>;
  payload_strategy: "normal";
  assumptions: string[];
  thresholds: FastApiThresholds;
}

export interface FastApiRunCreateRequest {
  plan: FastApiTestPlan;
  target: { base_url: string };
  correlation_id: string;
  submitted_by: string;
}

// --- Serialization (Convex plan -> FastAPI request) -------------------------

/**
 * Deterministic TestPlan serialization. Throws (never silently rewrites) on
 * anything the Python TestPlan schema would reject — the backend is the
 * authority; this adapter must not "helpfully" fix plans.
 */
export function serializePlan(plan: ConvexTestPlan, targetBaseUrl: string, correlationId: string, submittedBy: string): FastApiRunCreateRequest {
  if (!plan.selectedEndpoints?.length) {
    throw new Error("invalid plan: selectedEndpoints must be non-empty");
  }
  if (!Number.isFinite(plan.targetVus) || plan.targetVus <= 0 || !Number.isInteger(plan.targetVus)) {
    throw new Error(`invalid plan: targetVus must be a positive integer, got ${plan.targetVus}`);
  }
  const base = targetBaseUrl.trim();
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`invalid target: base_url must start with http(s)://, got ${JSON.stringify(targetBaseUrl)}`);
  }

  const thresholds = {
    p95_latency_ms: requirePositiveInt(plan.thresholds.p95LatencyMs, "thresholds.p95LatencyMs"),
    error_rate: requireFraction(plan.thresholds.errorRate, "thresholds.errorRate"),
  };
  // Correlation traceability: appended once, even if a retry already added it.
  const marker = `correlation_id: ${correlationId}`;
  const assumptions = plan.assumptions.some((a) => a.includes(marker))
    ? [...plan.assumptions]
    : [...plan.assumptions, marker];
  const envelope = {
    target: { base_url: base },
    correlation_id: correlationId,
    submitted_by: submittedBy,
  };

  if (plan.objectiveType === "boundary_search") {
    return {
      plan: {
        objective_type: "boundary_search",
        test_type: plan.testType,
        target_vus: plan.targetVus,
        ramp_duration: requireDuration(plan.rampDuration, "rampDuration"),
        hold_duration: requireDuration(plan.holdDuration, "holdDuration"),
        selected_endpoints: [...plan.selectedEndpoints],
        ...(plan.endpointWeights ? { endpoint_weights: { ...plan.endpointWeights } } : {}),
        payload_strategy: "normal",
        assumptions,
        thresholds,
      },
      ...envelope,
    };
  }
  return {
    plan: {
      objective_type: "fixed_load",
      test_type: plan.testType,
      target_vus: plan.targetVus,
      duration: requireDuration(plan.duration, "duration"),
      selected_endpoints: [...plan.selectedEndpoints],
      ...(plan.endpointWeights ? { endpoint_weights: { ...plan.endpointWeights } } : {}),
      payload_strategy: "normal",
      assumptions,
      thresholds,
    },
    ...envelope,
  };
}

function requireDuration(value: string | undefined, field: string): string {
  if (!value || !/^\d+(ms|s|m|h)$/.test(value)) {
    throw new Error(`invalid plan: ${field} must be a k6-style duration ("10s", "2m"), got ${JSON.stringify(value)}`);
  }
  return value;
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value) || Math.floor(value) !== value) {
    throw new Error(`invalid plan: ${field} must be a positive integer, got ${value}`);
  }
  return value;
}

function requireFraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid plan: ${field} must be a fraction in [0,1], got ${value}`);
  }
  return value;
}

// --- Status mapping (FastAPI -> Convex) --------------------------------------

/** Backend RunState (enums.py) -> Convex run status (schema.ts). 1:1, no collapsing. */
export function mapBackendStatus(backendStatus: string): "submitted" | "queued" | "running" | "completed" | "execution_error" | "cancelled" {
  switch (backendStatus) {
    case "QUEUED":
      return "queued";
    case "RUNNING":
      return "running";
    case "COMPLETED":
      return "completed";
    case "EXECUTION_ERROR":
      return "execution_error";
    case "CANCELLED":
      return "cancelled";
    default:
      // Unknown backend state: surface it, never guess.
      throw new Error(`unknown backend run status: ${JSON.stringify(backendStatus)}`);
  }
}

// --- Result mapping (FastAPI TestResult -> Convex persisted metrics) ---------

export interface BackendMetricsSummary {
  p50_ms: number;
  p75_ms?: number | null;
  p90_ms?: number | null;
  p95_ms: number;
  p99_ms: number;
  average_ms: number;
  max_ms: number;
  rps: number;
  total_requests: number;
  failed_requests: number;
  error_rate: number;
  duration_s: number;
  per_endpoint?: unknown[];
  status_codes?: Record<string, number>;
}

export interface BackendTestResult {
  run_id: string;
  metrics: BackendMetricsSummary;
  threshold_status: "PASS" | "FAIL";
  evaluated_at: string;
  target_base_url?: string | null;
  threshold_violations?: { scope: string; metric: string; observed: number; threshold: number }[];
  artifacts?: { results_json_path?: string | null } | null;
}

export interface MappedLiveResult {
  metrics: {
    totalRequests: number;
    totalFailures: number;
    errorRate: number;
    p50: number;
    p95: number;
    p99: number;
    maxRps: number;
    peakVus: number;
    iterations: number;
    latencyAvgMs: number;
    latencyMaxMs: number;
  };
  thresholdStatus: "PASS" | "FAIL";
  thresholdViolations: string[];
  provenance: {
    engine: "k6";
    externalRunId: string;
    source: "k6/results.json";
    completedAt: string;
    correlationId: string;
    artifactPresent: boolean;
  };
}

/** Peak VUs the plan actually drove (k6 runs exactly what the plan says). */
export function plannedPeakVus(plan: ConvexTestPlan): number {
  return plan.targetVus;
}

/**
 * Phase 8.H — polling horizon check (pure, unit-tested). A submitted run
 * whose backend never reaches a terminal state stops polling at the horizon
 * and ends as an honest execution_error — never a simulation fallback.
 */
export function isPollHorizonExceeded(
  run: { pollDeadlineAt?: number; externalRunId?: string },
  now: number,
): boolean {
  return !!(run.externalRunId && (run.pollDeadlineAt ?? 0) < now);
}

/**
 * Map the backend TestResult onto the Convex persisted-metrics shape.
 * EVERY number is the backend's own value, verbatim — this function must
 * never compute, round, or derive a metric (Phase 7 provenance rule).
 */
export function mapBackendResult(result: BackendTestResult, plan: ConvexTestPlan, correlationId: string): MappedLiveResult {
  const m = result.metrics;
  const violations = (result.threshold_violations ?? []).map(
    (v) => `${v.scope} ${v.metric} ${v.observed} exceeded ${v.threshold}`,
  );
  return {
    metrics: {
      totalRequests: m.total_requests,
      // k6's http_req_failed-derived counts, verbatim (never re-derived).
      totalFailures: m.failed_requests,
      errorRate: m.error_rate,
      p50: m.p50_ms,
      p95: m.p95_ms,
      p99: m.p99_ms,
      maxRps: m.rps,
      // k6 runs the exact planned VU population — peakVus IS plan.targetVus,
      // carried through so the UI can display "requested = executed".
      peakVus: plannedPeakVus(plan),
      iterations: m.total_requests,
      latencyAvgMs: m.average_ms,
      latencyMaxMs: m.max_ms,
    },
    thresholdStatus: result.threshold_status,
    thresholdViolations: violations,
    provenance: {
      engine: "k6",
      externalRunId: result.run_id,
      source: "k6/results.json",
      completedAt: result.evaluated_at,
      correlationId,
      artifactPresent: !!result.artifacts?.results_json_path,
    },
  };
}

/**
 * Reject any result that is not a complete, sane k6 summary. Used by the
 * poller before persisting — malformed/missing artifacts must surface as
 * execution errors (the backend should never send these, but Convex does
 * not trust that blindly).
 */
export function validateBackendResult(result: BackendTestResult): void {
  const m = result?.metrics;
  if (!m || typeof m !== "object") throw new Error("backend result has no metrics object");
  for (const field of ["p50_ms", "p95_ms", "p99_ms", "average_ms", "max_ms", "rps", "total_requests", "failed_requests", "error_rate", "duration_s"] as const) {
    if (typeof m[field] !== "number" || !Number.isFinite(m[field])) {
      throw new Error(`backend result metric ${field} is missing or not a finite number`);
    }
  }
  if (result.threshold_status !== "PASS" && result.threshold_status !== "FAIL") {
    throw new Error(`backend result threshold_status must be PASS|FAIL, got ${JSON.stringify(result.threshold_status)}`);
  }
  if (!result.run_id) throw new Error("backend result has no run_id");
}
