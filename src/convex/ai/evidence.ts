/**
 * AI Performance Intelligence — deterministic EVIDENCE BUILDER (Phase 9).
 *
 * Pure functions: stored run / boundary-search documents → structured
 * evidence + a NUMERIC EVIDENCE REGISTRY. Every number the AI may state
 * must exist in the registry; the validator (validate.ts) enforces that.
 * NOTHING here recomputes a metric — values are read from the verbatim
 * backend result (externalResult.metrics), the mapped metrics, the plan,
 * and the search state, all of which are already stored.
 *
 * This module sits strictly DOWNSTREAM of measurement (it is read-only
 * over evidence) and upstream of the LLM (which only ever sees this
 * object and returns interpretation that gets validated against the
 * same registry).
 */

export const PROMPT_VERSION = "perforso.ai-analyst.v1";

/** One per-endpoint evidence row (verbatim from externalResult.metrics.per_endpoint). */
export interface EndpointEvidence {
  endpoint: string;
  method: string | null;
  requests: number | null;
  failedRequests: number | null;
  errorRatePct: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  average: number | null;
  max: number | null;
  rps: number | null;
}

export interface RunEvidence {
  subject: "run";
  runId: string;
  externalRunId: string | null;
  correlationId: string | null;
  executionMode: string; // live_k6 | real | simulation | live_k6_pending
  status: string; // completed | execution_error | running | ...
  thresholdStatus: "PASS" | "FAIL" | null; // backend-authoritative, verbatim
  thresholdViolations: string[];
  verdictLabel: string | null;
  targetLabel: string | null;
  createdAt: number | null;
  finishedAt: number | null;
  plan: {
    objectiveType: string | null;
    testType: string | null;
    targetVus: number | null;
    duration: string | null;
    rampDuration: string | null;
    holdDuration: string | null;
    selectedEndpoints: string[];
    endpointWeights: Record<string, number> | null;
    thresholds: { p95LatencyMs: number | null; errorRatePct: number | null };
    assumptions: string[];
  } | null;
  // Mapped metrics (already stored; equal to the verbatim backend metrics).
  metrics: {
    totalRequests: number | null;
    totalFailures: number | null;
    errorRatePct: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
    average: number | null;
    max: number | null;
    rps: number | null;
  } | null;
  // Verbatim backend metrics layer (per-endpoint + status codes only exist here).
  externalMetrics: {
    durationS: number | null;
    statusCodes: { code: string; count: number }[];
    perEndpoint: EndpointEvidence[];
  } | null;
  liveProvenance: {
    engine: string;
    externalRunId: string;
    source: string;
    correlationId: string;
    artifactPresent: boolean;
    completedAt: string;
  } | null;
  errorMessage: string | null;
  /** Mode/capability limitations the AI must restate (and may not contradict). */
  limitations: string[];
  /** Registry: every numeric value any statement may cite. */
  numbers: Record<string, number>;
  /** All valid evidence-reference strings (registry keys + document refs). */
  evidenceKeys: string[];
}

export interface SearchExperimentEvidence {
  iteration: number;
  runId: string;
  targetVus: number;
  status: string;
  thresholdStatus: "PASS" | "FAIL" | null;
  p95: number | null;
  errorRatePct: number | null;
  totalRequests: number | null;
  externalRunId: string | null;
}

export interface SearchEvidence {
  subject: "boundary_search";
  searchId: string;
  status: string; // active | completed | error | blocked
  targetLabel: string;
  limits: {
    minVus: number;
    maxVus: number;
    tolerance: number;
    maximumExperiments: number;
  };
  basePlan: {
    testType: string;
    rampDuration: string;
    holdDuration: string;
    selectedEndpoints: string[];
    thresholds: { p95LatencyMs: number; errorRatePct: number };
    assumptions: string[];
  };
  lowestKnownPassVus: number | null; // null = never observed
  highestKnownFailVus: number | null; // null = never observed
  experimentCount: number;
  experiments: SearchExperimentEvidence[];
  result: {
    status: string;
    lowerBound: number | null; // highest observed PASS
    upperBound: number | null; // lowest observed FAIL (null = none observed)
    stopReason: string | null;
    note: string;
  } | null;
  limitations: string[];
  numbers: Record<string, number>;
  evidenceKeys: string[];
}

export type Evidence = RunEvidence | SearchEvidence;

// --- safe accessors ----------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

/** Backend error_rate (0..1) → percent, the unit the plan threshold is stated in. */
const pct = (rate01: unknown): number | null => {
  const n = num(rate01);
  return n === null ? null : n * 100;
};

const r2 = (v: number): number => Math.round(v * 100) / 100;

// --- registry helpers --------------------------------------------------------

class Registry {
  numbers: Record<string, number> = {};
  keys: string[] = [];

  add(key: string, value: number | null | undefined): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.numbers[key] = value;
    this.keys.push(key);
  }

  ref(key: string): void {
    this.keys.push(key);
  }
}

const MODE_LIMITATIONS: Record<string, string> = {
  live_k6: "Measurements come from an actual k6 execution on the execution plane.",
  real: "Measurements come from bounded HTTP probing and do not establish sustained-load capacity.",
  simulation: "The result is simulated and must not be interpreted as an observed target measurement.",
};

// --- run evidence ------------------------------------------------------------

export function buildRunEvidence(run: unknown): RunEvidence {
  const r = asRecord(run) ?? {};
  const runId = str(r._id) ?? "unknown";
  const plan = asRecord(r.plan);
  const planThresholds = plan ? asRecord(plan.thresholds) : null;
  const m = asRecord(r.metrics);
  const ext = asRecord(r.externalResult);
  const extMetrics = ext ? asRecord(ext.metrics) : null;
  const prov = asRecord(r.liveProvenance);
  const executionMode = str(r.executionMode) ?? str(r.engineMode) ?? "unknown";

  const reg = new Registry();
  const k = (suffix: string) => `run.${runId}.${suffix}`;

  // Plan values.
  const targetVus = plan ? int(plan.targetVus) : null;
  reg.add(k("metrics.targetVus"), targetVus);
  reg.add(k("thresholds.p95LatencyMs"), planThresholds ? num(planThresholds.p95LatencyMs) : null);
  reg.add(k("thresholds.errorRatePct"), planThresholds ? pct(planThresholds.errorRate) : null);

  // Mapped metrics (verbatim-equal to the backend values).
  reg.add(k("metrics.p50"), m ? num(m.p50) : null);
  reg.add(k("metrics.p75"), m ? num(m.p75) : null);
  reg.add(k("metrics.p90"), m ? num(m.p90) : null);
  reg.add(k("metrics.p95"), m ? num(m.p95) : null);
  reg.add(k("metrics.p99"), m ? num(m.p99) : null);
  reg.add(k("metrics.average"), m ? num(m.latencyAvgMs) : null);
  reg.add(k("metrics.max"), m ? num(m.latencyMaxMs) : null);
  reg.add(k("metrics.rps"), m ? num(m.maxRps) : null);
  reg.add(k("metrics.requests"), m ? int(m.totalRequests) : null);
  reg.add(k("metrics.failed"), m ? int(m.totalFailures) : null);
  reg.add(k("metrics.errorRatePct"), m ? r2((num(m.errorRate) ?? 0) * 100) : null);

  // Verbatim backend layer: status codes + per-endpoint rows.
  const statusCodes: { code: string; count: number }[] = [];
  const rawStatus = extMetrics ? asRecord(extMetrics.status_codes) : null;
  for (const [code, count] of Object.entries(rawStatus ?? {})) {
    const c = int(count);
    if (c === null) continue;
    statusCodes.push({ code, count: c });
    reg.add(k(`status.${code}`), c);
  }

  const perEndpoint: EndpointEvidence[] = [];
  const rawPer = extMetrics && Array.isArray(extMetrics.per_endpoint) ? extMetrics.per_endpoint : [];
  for (const row of rawPer) {
    const e = asRecord(row);
    if (!e) continue;
    const endpoint = str(e.endpoint);
    if (!endpoint) continue;
    const ek = (suffix: string) => k(`endpoint.${endpoint}.${suffix}`);
    const entry: EndpointEvidence = {
      endpoint,
      method: str(e.method),
      requests: int(e.total_requests),
      failedRequests: int(e.failed_requests),
      errorRatePct: r2((num(e.error_rate) ?? 0) * 100),
      p50: num(e.p50_ms),
      p95: num(e.p95_ms),
      p99: num(e.p99_ms),
      average: num(e.average_ms),
      max: num(e.max_ms),
      rps: num(e.rps),
    };
    perEndpoint.push(entry);
    reg.add(ek("requests"), entry.requests);
    reg.add(ek("failed"), entry.failedRequests);
    reg.add(ek("errorRatePct"), entry.errorRatePct);
    reg.add(ek("p50"), entry.p50);
    reg.add(ek("p95"), entry.p95);
    reg.add(ek("p99"), entry.p99);
    reg.add(ek("average"), entry.average);
    reg.add(ek("max"), entry.max);
    reg.add(ek("rps"), entry.rps);
  }

  // Document references (non-numeric).
  const externalRunId = str(r.externalRunId) ?? (prov ? str(prov.externalRunId) : null);
  reg.ref(`run:${runId}`);
  if (externalRunId) reg.ref(`externalRun:${externalRunId}`);
  reg.ref(`mode:${executionMode}`);
  const thresholdStatus = r.thresholdStatus === "PASS" || r.thresholdStatus === "FAIL" ? r.thresholdStatus : null;
  if (thresholdStatus) reg.ref(`thresholdStatus:${thresholdStatus}`);

  const limitations: string[] = [];
  const modeNote = MODE_LIMITATIONS[executionMode];
  if (modeNote) limitations.push(modeNote);
  limitations.push("This analysis alone does not establish system capacity or an exact maximum sustainable load.");
  if (r.status === "execution_error") {
    limitations.push("The run ended with EXECUTION_ERROR, so no performance verdict can be inferred.");
  }
  if (!extMetrics && r.status !== "execution_error") {
    limitations.push("Endpoint-level evidence is unavailable for this run.");
  }

  return {
    subject: "run",
    runId,
    externalRunId,
    correlationId: str(r.correlationId),
    executionMode,
    status: str(r.status) ?? "unknown",
    thresholdStatus,
    thresholdViolations: Array.isArray(r.thresholdViolations) ? (r.thresholdViolations as string[]) : [],
    verdictLabel: str(r.verdictLabel),
    targetLabel: str(r.targetBaseUrl),
    createdAt: num(r.createdAt),
    finishedAt: num(r.finishedAt),
    plan: plan
      ? {
          objectiveType: str(plan.objectiveType),
          testType: str(plan.testType),
          targetVus,
          duration: str(plan.duration),
          rampDuration: str(plan.rampDuration),
          holdDuration: str(plan.holdDuration),
          selectedEndpoints: Array.isArray(plan.selectedEndpoints) ? (plan.selectedEndpoints as string[]) : [],
          endpointWeights: asRecord(plan.endpointWeights)
            ? (Object.fromEntries(
                Object.entries(asRecord(plan.endpointWeights)!).filter(([, v]) => typeof v === "number"),
              ) as Record<string, number>)
            : null,
          thresholds: {
            p95LatencyMs: planThresholds ? num(planThresholds.p95LatencyMs) : null,
            errorRatePct: planThresholds ? pct(planThresholds.errorRate) : null,
          },
          assumptions: Array.isArray(plan.assumptions) ? (plan.assumptions as string[]) : [],
        }
      : null,
    metrics: m
      ? {
          totalRequests: int(m.totalRequests),
          totalFailures: int(m.totalFailures),
          errorRatePct: r2((num(m.errorRate) ?? 0) * 100),
          p50: num(m.p50),
          p75: num(m.p75),
          p90: num(m.p90),
          p95: num(m.p95),
          p99: num(m.p99),
          average: num(m.latencyAvgMs),
          max: num(m.latencyMaxMs),
          rps: num(m.maxRps),
        }
      : null,
    externalMetrics: extMetrics
      ? {
          durationS: num(extMetrics.duration_s),
          statusCodes,
          perEndpoint,
        }
      : null,
    liveProvenance: prov
      ? {
          engine: str(prov.engine) ?? "unknown",
          externalRunId: str(prov.externalRunId) ?? "unknown",
          source: str(prov.source) ?? "unknown",
          correlationId: str(prov.correlationId) ?? "unknown",
          artifactPresent: prov.artifactPresent === true,
          completedAt: str(prov.completedAt) ?? "unknown",
        }
      : null,
    errorMessage: str(r.errorMessage),
    limitations,
    numbers: reg.numbers,
    evidenceKeys: reg.keys,
  };
}

// --- boundary-search evidence ------------------------------------------------

export function buildSearchEvidence(
  search: unknown,
  experimentRows: { runId: string; iteration: number; targetVus: number; status: string; thresholdStatus: string | null; externalRunId: string | null; metrics: unknown }[],
): SearchEvidence {
  const s = asRecord(search) ?? {};
  const searchId = str(s._id) ?? "unknown";
  const basePlan = asRecord(s.basePlan) ?? {};
  const bpThresholds = asRecord(basePlan.thresholds) ?? {};
  const result = asRecord(s.result);
  const reg = new Registry();
  const k = (suffix: string) => `search.${searchId}.${suffix}`;

  reg.add(k("minVus"), int(s.minVus));
  reg.add(k("maxVus"), int(s.maxVus));
  reg.add(k("tolerance"), num(s.tolerance));
  reg.add(k("maximumExperiments"), int(s.maximumExperiments));
  reg.add(k("experimentCount"), int(s.experimentCount));
  reg.add(k("lowestKnownPassVus"), int(s.lowestKnownPassVus));
  reg.add(k("highestKnownFailVus"), int(s.highestKnownFailVus));
  reg.add(k("lowerBound"), result ? int(result.lowerBound) : null);
  reg.add(k("upperBound"), result ? int(result.upperBound) : null);

  reg.ref(`search:${searchId}`);

  const experiments: SearchExperimentEvidence[] = [];
  for (const row of experimentRows) {
    const m = asRecord(row.metrics);
    const ek = k(`exp.${row.iteration}`);
    reg.add(`${ek}.vus`, int(row.targetVus));
    reg.add(`${ek}.p95`, m ? num(m.p95) : null);
    reg.add(`${ek}.errorRatePct`, m ? r2((num(m.errorRate) ?? 0) * 100) : null);
    reg.add(`${ek}.requests`, m ? int(m.totalRequests) : null);
    reg.ref(`iteration:${row.iteration}`);
    reg.ref(`run:${row.runId}`);
    if (row.externalRunId) reg.ref(`externalRun:${row.externalRunId}`);
    experiments.push({
      iteration: row.iteration,
      runId: row.runId,
      targetVus: row.targetVus,
      status: row.status,
      thresholdStatus: row.thresholdStatus === "PASS" || row.thresholdStatus === "FAIL" ? row.thresholdStatus : null,
      p95: m ? num(m.p95) : null,
      errorRatePct: m ? r2((num(m.errorRate) ?? 0) * 100) : null,
      totalRequests: m ? int(m.totalRequests) : null,
      externalRunId: row.externalRunId,
    });
  }
  experiments.sort((a, b) => a.iteration - b.iteration);

  const limitations: string[] = [
    "The output of the search is an estimated safe operating region, never an exact capacity.",
    "The experiments do not establish the exact maximum sustainable capacity.",
  ];
  if (int(s.highestKnownFailVus) === null) {
    limitations.push("No FAIL was observed within the search limits, so no failing upper bound exists.");
  }
  if (int(s.lowestKnownPassVus) === null) {
    limitations.push("No PASS was observed, so no passing lower bound exists.");
  }

  return {
    subject: "boundary_search",
    searchId,
    status: str(s.status) ?? "unknown",
    targetLabel: str(s.targetBaseUrl) ?? "unknown",
    limits: {
      minVus: int(s.minVus) ?? 0,
      maxVus: int(s.maxVus) ?? 0,
      tolerance: num(s.tolerance) ?? 0,
      maximumExperiments: int(s.maximumExperiments) ?? 0,
    },
    basePlan: {
      testType: str(basePlan.testType) ?? "unknown",
      rampDuration: str(basePlan.rampDuration) ?? "unknown",
      holdDuration: str(basePlan.holdDuration) ?? "unknown",
      selectedEndpoints: Array.isArray(basePlan.selectedEndpoints) ? (basePlan.selectedEndpoints as string[]) : [],
      thresholds: {
        p95LatencyMs: num(bpThresholds.p95LatencyMs) ?? 0,
        errorRatePct: r2((num(bpThresholds.errorRate) ?? 0) * 100),
      },
      assumptions: Array.isArray(basePlan.assumptions) ? (basePlan.assumptions as string[]) : [],
    },
    lowestKnownPassVus: int(s.lowestKnownPassVus),
    highestKnownFailVus: int(s.highestKnownFailVus),
    experimentCount: int(s.experimentCount) ?? 0,
    experiments,
    result: result
      ? {
          status: str(result.status) ?? "unknown",
          lowerBound: int(result.lowerBound),
          upperBound: int(result.upperBound),
          stopReason: str(result.stopReason),
          note: str(result.note) ?? "",
        }
      : null,
    limitations,
    numbers: reg.numbers,
    evidenceKeys: reg.keys,
  };
}
