// Mirrors backend/app/schemas/*.py exactly -- every literal here was
// verified against the actual enum/model source, not assumed.

export type TestType = "baseline" | "soak" | "stress";
export type ObjectiveType = "boundary_search" | "fixed_load";
export type RunState = "QUEUED" | "RUNNING" | "COMPLETED" | "CANCELLED" | "EXECUTION_ERROR";
export type ResultClassification = "PASS" | "FAIL";
export type IntentStatus = "READY" | "NEEDS_CLARIFICATION" | "INVALID";
export type InterpretationStatus =
  | "COMPLETE"
  | "INCOMPLETE"
  | "AMBIGUOUS"
  | "INVALID"
  | "INTERPRETATION_FAILURE";
// Session 3 (backend/app/schemas/enums.py::PayloadStrategy). "normal" is
// the backend's own default when the field is omitted entirely.
export type PayloadStrategy = "normal" | "boundary";
// Sessions 1/2/2.5 (backend/app/schemas/auth.py::AuthType).
export type AuthType = "none" | "bearer" | "api_key_header";
// Final session (backend/app/schemas/enums.py::Severity / Confidence).
export type Severity = "none" | "low" | "medium" | "high";
export type Confidence = "low" | "medium" | "high";

export interface LoadProfile {
  concurrent_users?: number | null;
  peak_users?: number | null;
}

export interface TargetScope {
  endpoints?: string[] | null;
  endpoint_weights?: Record<string, number> | null;
}

export interface SuccessCriteria {
  p95_latency_ms?: number | null;
  error_rate?: number | null;
}

export interface ClarificationItem {
  field: string;
  question: string;
}

export interface UniversalPerformanceIntent {
  objective?: string | null;
  test_type?: TestType | null;
  load_profile: LoadProfile;
  duration?: string | null;
  target_scope: TargetScope;
  business_flow?: { name?: string | null; steps: string[] } | null;
  success_criteria: SuccessCriteria;
  confidence?: { overall?: number | null } | null;
  clarifications_needed: ClarificationItem[];
}

export interface Thresholds {
  p95_latency_ms: number;
  error_rate: number;
}

export interface TestPlan {
  objective_type: ObjectiveType;
  test_type: TestType;
  target_vus: number;
  duration?: string; // fixed_load
  ramp_duration?: string; // boundary_search
  hold_duration?: string; // boundary_search
  thresholds: Thresholds;
  selected_endpoints: string[];
  endpoint_weights?: Record<string, number> | null;
  // Session 3, additive -- backend defaults to "normal" when the plan
  // (e.g. from an older /intents/compile response) omits this entirely.
  payload_strategy?: PayloadStrategy;
  assumptions: string[];
}

export interface IntentCompilationResponse {
  status: IntentStatus;
  intent: UniversalPerformanceIntent;
  test_plan?: TestPlan | null;
  clarifications_needed: ClarificationItem[];
  rejection_code?: string | null;
  rejection_reason?: string | null;
}

export interface InterpretationResult {
  status: InterpretationStatus;
  intent?: UniversalPerformanceIntent | null;
  reason?: string | null;
}

export interface InterpretAndCompileResponse {
  interpretation: InterpretationResult;
  compilation?: IntentCompilationResponse | null;
}

// Sessions 1/2/2.5 (backend/app/schemas/auth.py::AuthConfig). The frontend
// only ever CONSTRUCTS this (to submit a run) -- it is never returned by
// any backend response (TestPlan/TestResult have no auth-shaped field at
// all, by design; see backend/docs/target_auth_contract.md), so there is
// no corresponding "received from the API" shape to worry about.
export interface AuthConfig {
  type: AuthType;
  token?: string; // required iff type === "bearer"
  header_name?: string; // required iff type === "api_key_header"
  api_key?: string; // required iff type === "api_key_header"
}

export interface TargetConfig {
  base_url: string;
  // Sessions 1/2, additive -- both optional, both omitted entirely
  // reproduces the exact pre-existing no-auth/no-override behavior.
  openapi_url?: string;
  auth?: AuthConfig;
}

export interface RunCreateResponse {
  run_id: string;
  status: RunState;
}

export interface RunStatusResponse {
  run_id: string;
  status: RunState;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  error_message?: string | null;
}

export interface EndpointMetrics {
  endpoint: string;
  method: string;
  total_requests: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  average_ms: number;
  max_ms: number;
  rps: number;
  failed_requests: number;
  error_rate: number;
}

export interface MetricsSummary {
  p50_ms: number;
  // Session 5, additive -- absent (never a guessed value) for a result
  // predating k6_runner.py's expanded --summary-trend-stats.
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
  per_endpoint: EndpointMetrics[];
  // Session 5, additive -- {"200": 950, ...}, ONLY statuses actually
  // observed. Empty/absent for a result predating this mechanism --
  // never a hardcoded/guessed status list.
  status_codes?: Record<string, number>;
}

export interface ThresholdViolation {
  scope: string;
  metric: string;
  observed: number;
  threshold: number;
}

export interface ArtifactRefs {
  script_path?: string | null;
  results_json_path?: string | null;
  stdout_log_path?: string | null;
  stderr_log_path?: string | null;
}

// --- Statistics / evidence layer (Session 5) --------------------------------
// Mirrors backend/app/schemas/test_result.py exactly. A derived VIEW over
// MetricsSummary -- never a second source of truth, never independently
// recalculated here. error_rate/success_rate are FRACTIONS (0..1, same
// convention as MetricsSummary.error_rate); status_codes.percentages is
// ALREADY on a 0..100 scale (computed that way by the backend) -- do not
// multiply either by 100 a second time when rendering the other.

export interface LatencyStatistics {
  p50_ms: number;
  p75_ms?: number | null;
  p90_ms?: number | null;
  p95_ms: number;
  p99_ms: number;
  average_ms: number;
  max_ms: number;
  tail_latency_ratio?: number | null;
}

export interface ThroughputStatistics {
  total_requests: number;
  requests_per_second: number;
  requests_per_minute: number;
}

export interface ErrorStatistics {
  failed_requests: number;
  error_rate: number; // fraction 0..1
  success_rate: number; // fraction 0..1
}

export interface StatusCodeStatistics {
  counts: Record<string, number>;
  percentages: Record<string, number>; // ALREADY 0..100, not a fraction
}

export interface EndpointRankingEntry {
  endpoint: string;
  method: string;
  value: number;
}

export interface EndpointRankings {
  highest_p95_latency: EndpointRankingEntry[];
  highest_error_rate: EndpointRankingEntry[];
  highest_request_volume: EndpointRankingEntry[];
  highest_failed_requests: EndpointRankingEntry[];
}

export interface EndpointShare {
  endpoint: string;
  method: string;
  traffic_share: number; // fraction 0..1
  failure_share?: number | null; // fraction 0..1, null if zero total failures
}

export interface Statistics {
  latency: LatencyStatistics;
  throughput: ThroughputStatistics;
  errors: ErrorStatistics;
  status_codes: StatusCodeStatistics;
  endpoint_rankings: EndpointRankings;
  endpoint_shares: EndpointShare[];
}

// --- Failure localization (final session) -----------------------------------
// WHERE/WHICH threshold was crossed, using already-measured evidence --
// NEVER a root-cause claim (no infrastructure inference). `primary_failure`
// can be non-null even when `overall_status === "PASS"`: a single endpoint
// can violate its OWN threshold while the aggregate still passes.

export interface FailureEvidence {
  scope: string;
  total_requests?: number | null;
  error_rate?: number | null;
  p95_ms?: number | null;
  status_codes: Record<string, number>;
}

export interface LoadContext {
  objective_type?: string | null;
  test_type?: string | null;
  target_vus?: number | null;
  duration?: string | null;
  selected_endpoints: string[];
}

export interface FailureLocalization {
  overall_status: ResultClassification;
  primary_failure?: ThresholdViolation | null;
  violations: ThresholdViolation[];
  evidence?: FailureEvidence | null;
  load_context?: LoadContext | null;
}

// --- AI result analysis (final session) --------------------------------------
// OPTIONAL INTERPRETATION, never the source of truth -- see
// backend/docs/performance_engine_interface.md's AI section. `null`/absent
// always means "not requested or unavailable", never "analysis failed the
// run" -- the deterministic result above is complete without it.

export interface AIFinding {
  statement: string;
  evidence_ref?: string | null;
}

export interface AIAnalysis {
  summary: string;
  severity: Severity;
  findings: AIFinding[];
  confidence: Confidence;
  limitations: string[];
}

export interface AIAnalysisResponse {
  available: boolean;
  analysis?: AIAnalysis | null;
  reason?: string | null;
}

export interface TestResult {
  run_id: string;
  metrics: MetricsSummary;
  threshold_status: ResultClassification;
  evaluated_at: string;
  target_base_url?: string | null;
  plan?: TestPlan | null;
  threshold_violations: ThresholdViolation[];
  artifacts?: ArtifactRefs | null;
  // Session 5, additive -- always present for any result produced after
  // that session (assembled fresh at fetch time, never stale).
  statistics?: Statistics | null;
  // Final session, additive -- same "always assembled, cheap,
  // deterministic" pattern as `statistics`.
  failure_localization?: FailureLocalization | null;
  // NOTE: deliberately NO `ai_analysis` field here -- the backend never
  // computes or persists it as part of this response (see
  // backend/app/schemas/test_result.py::TestResult's docstring). AI
  // analysis is returned ONLY by the separate, explicit
  // POST /runs/{id}/analyze call -- see runsApi.analyze() and
  // AIAnalysisResponse below.
}

export interface KnownEndpointsResponse {
  endpoints: string[];
}
