/**
 * Port of backend/app/schemas (intent.py, test_plan.py) and
 * backend/app/services/intent_compiler.py to Convex/TypeScript.
 *
 * Deterministic only — no LLM here. The same intent always compiles to the
 * same result: READY (with a plan), NEEDS_CLARIFICATION (with questions),
 * or INVALID (with a rejection code/reason). Compilation never executes.
 */

export type TestType = "baseline" | "stress" | "soak";
export type ObjectiveType = "fixed_load" | "boundary_search";

export interface LoadProfile {
  concurrentUsers?: number;
  peakUsers?: number;
}

export interface TargetScope {
  endpoints?: string[];
  endpointWeights?: Record<string, number>;
}

export interface SuccessCriteria {
  p95LatencyMs?: number;
  errorRate?: number;
}

export interface ClarificationItem {
  field: string;
  question: string;
}

export interface UniversalPerformanceIntent {
  objective?: string;
  testType?: TestType;
  loadProfile?: LoadProfile;
  duration?: string; // k6-style, e.g. "30s", "5m"
  targetScope?: TargetScope;
  successCriteria?: SuccessCriteria;
  confidence?: number; // advisory only — never read for decisions
  clarificationsNeeded?: ClarificationItem[];
}

export interface CompiledPlan {
  objectiveType: ObjectiveType;
  testType: TestType;
  targetVus: number;
  duration?: string;
  rampDuration?: string;
  holdDuration?: string;
  selectedEndpoints: string[];
  thresholds: { p95LatencyMs: number; errorRate: number };
  assumptions: string[];
}

export interface CompilationResult {
  status: "READY" | "NEEDS_CLARIFICATION" | "INVALID";
  intent: UniversalPerformanceIntent;
  plan?: CompiledPlan;
  clarificationsNeeded: ClarificationItem[];
  rejectionCode?: string;
  rejectionReason?: string;
}

// --- Workload safety envelope (backend/app/services/workload_limits.py) ----
export const MAX_VUS = 2000;
export const MAX_DURATION_S = 90;
export const MAX_RAMP_PLUS_HOLD_S = 90;

export function parseDurationSeconds(d: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) return NaN;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n / 1000;
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    default: return NaN;
  }
}

export const DURATION_PATTERN = /^\d+(ms|s|m|h)$/;
export const ENDPOINT_PATTERN = /^\/[A-Za-z0-9_\-./{}]*$/;

// Deterministic defaults (mirrors intent_compiler.py)
export const DEFAULT_P95_LATENCY_MS = 1000;
export const DEFAULT_ERROR_RATE = 0.05;
const DEFAULT_STRESS_RAMP = "10s";
const DEFAULT_STRESS_HOLD = "20s";

export class WorkloadLimitExceededError extends Error {}

export function validateWorkloadLimits(plan: CompiledPlan): void {
  if (plan.targetVus > MAX_VUS) {
    throw new WorkloadLimitExceededError(
      `target_vus ${plan.targetVus} exceeds configured maximum ${MAX_VUS}`,
    );
  }
  if (plan.objectiveType === "fixed_load") {
    const s = parseDurationSeconds(plan.duration ?? "");
    if (Number.isNaN(s) || s > MAX_DURATION_S) {
      throw new WorkloadLimitExceededError(
        `duration ${plan.duration} exceeds configured maximum ${MAX_DURATION_S}s`,
      );
    }
  } else {
    const ramp = parseDurationSeconds(plan.rampDuration ?? "");
    const hold = parseDurationSeconds(plan.holdDuration ?? "");
    if (Number.isNaN(ramp) || Number.isNaN(hold) || ramp + hold > MAX_DURATION_S) {
      throw new WorkloadLimitExceededError(
        `ramp ${plan.rampDuration} + hold ${plan.holdDuration} exceeds configured maximum ${MAX_DURATION_S}s`,
      );
    }
  }
}

function invalid(
  intent: UniversalPerformanceIntent,
  code: string,
  reason: string,
): CompilationResult {
  return { status: "INVALID", intent, clarificationsNeeded: [], rejectionCode: code, rejectionReason: reason };
}

function needsClarification(
  intent: UniversalPerformanceIntent,
  items: ClarificationItem[],
): CompilationResult {
  return { status: "NEEDS_CLARIFICATION", intent, clarificationsNeeded: items };
}

function validateEndpoints(endpoints: string[]): string | null {
  for (const e of endpoints) {
    if (typeof e !== "string" || !e.trim()) return e;
    if (!ENDPOINT_PATTERN.test(e)) return e;
  }
  return null;
}

function resolveTargetVus(
  intent: UniversalPerformanceIntent,
  testType: TestType,
): { vus: number | null; clarifications: ClarificationItem[]; assumptions: string[] } {
  const assumptions: string[] = [];
  const profile = intent.loadProfile ?? {};
  if (testType === "stress") {
    if (profile.peakUsers != null) {
      const a: string[] = [];
      if (profile.concurrentUsers != null) {
        a.push("load_profile.concurrent_users was provided but ignored: stress uses load_profile.peak_users");
      }
      return { vus: profile.peakUsers, clarifications: [], assumptions: a };
    }
    return {
      vus: null,
      clarifications: [{
        field: "load_profile.peak_users",
        question: "What peak/maximum concurrent user count should the stress test target?",
      }],
      assumptions,
    };
  }
  // baseline / soak
  if (profile.concurrentUsers != null) {
    const a: string[] = [];
    if (profile.peakUsers != null) {
      a.push(`load_profile.peak_users was provided but ignored: ${testType} uses load_profile.concurrent_users`);
    }
    return { vus: profile.concurrentUsers, clarifications: [], assumptions: a };
  }
  return {
    vus: null,
    clarifications: [{
      field: "load_profile.concurrent_users",
      question: "How many concurrent users represent the typical/expected load to simulate?",
    }],
    assumptions,
  };
}

export function compileIntent(intent: UniversalPerformanceIntent): CompilationResult {
  const clarifications: ClarificationItem[] = [];

  if (!intent.testType) {
    clarifications.push({ field: "test_type", question: "Is this a baseline, stress, or soak test?" });
  }

  const endpoints = intent.targetScope?.endpoints ?? [];
  if (!endpoints.length) {
    clarifications.push({ field: "target_scope.endpoints", question: "Which endpoint(s) should be tested?" });
  }

  let targetVus: number | null = null;
  let vuAssumptions: string[] = [];
  if (intent.testType) {
    const r = resolveTargetVus(intent, intent.testType);
    targetVus = r.vus;
    vuAssumptions = r.assumptions;
    clarifications.push(...r.clarifications);
  }

  if ((intent.testType === "baseline" || intent.testType === "soak") && !intent.duration) {
    clarifications.push({ field: "duration", question: "How long should the test run (e.g. '30s', '5m')?" });
  }

  // Respect AI-supplied clarifications without dropping them.
  const seen = new Set(clarifications.map((c) => c.field));
  for (const item of intent.clarificationsNeeded ?? []) {
    if (!seen.has(item.field)) {
      clarifications.push(item);
      seen.add(item.field);
    }
  }

  if (clarifications.length) return needsClarification(intent, clarifications);

  // From here: testType, endpoints, targetVus all present.
  const bad = validateEndpoints(endpoints);
  if (bad != null) {
    return invalid(
      intent,
      "invalid_endpoint",
      `endpoint ${JSON.stringify(bad)} is not a structurally valid path (must start with '/', no scheme, no whitespace)`,
    );
  }

  const assumptions = [...vuAssumptions];
  const sc = intent.successCriteria ?? {};
  if (sc.p95LatencyMs == null) {
    assumptions.push(`success_criteria.p95_latency_ms defaulted to ${DEFAULT_P95_LATENCY_MS}ms`);
  }
  if (sc.errorRate == null) {
    assumptions.push(`success_criteria.error_rate defaulted to ${DEFAULT_ERROR_RATE}`);
  }
  const thresholds = {
    p95LatencyMs: sc.p95LatencyMs ?? DEFAULT_P95_LATENCY_MS,
    errorRate: sc.errorRate ?? DEFAULT_ERROR_RATE,
  };

  let plan: CompiledPlan;
  if (intent.testType === "stress") {
    let hold = intent.duration;
    if (!hold) {
      hold = DEFAULT_STRESS_HOLD;
      assumptions.push(`hold_duration defaulted to ${DEFAULT_STRESS_HOLD}`);
    }
    assumptions.push(`ramp_duration set to fixed default ${DEFAULT_STRESS_RAMP} (the intent contract has no separate ramp field)`);
    plan = {
      objectiveType: "boundary_search",
      testType: "stress",
      targetVus: targetVus!,
      rampDuration: DEFAULT_STRESS_RAMP,
      holdDuration: hold,
      selectedEndpoints: endpoints,
      thresholds,
      assumptions,
    };
  } else {
    plan = {
      objectiveType: "fixed_load",
      testType: intent.testType!,
      targetVus: targetVus!,
      duration: intent.duration!,
      selectedEndpoints: endpoints,
      thresholds,
      assumptions,
    };
  }

  try {
    validateWorkloadLimits(plan);
  } catch (exc) {
    if (exc instanceof WorkloadLimitExceededError) {
      return invalid(intent, "workload_limit_exceeded", String(exc.message));
    }
    throw exc;
  }

  return { status: "READY", intent, plan, clarificationsNeeded: [] };
}
