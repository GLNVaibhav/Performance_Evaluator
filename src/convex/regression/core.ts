/**
 * PERFORMANCE REGRESSION INTELLIGENCE — DETERMINISTIC CORE (Phase 10).
 *
 * Pure functions ONLY: stored run documents → compatibility verdict →
 * factual metric deltas → policy classifications. NO LLM participates
 * anywhere in this module; the AI layer (regressionAnalyst.ts) sits
 * strictly downstream and consumes this output. The engine never reads
 * anything but the two immutable run documents and the policy — the
 * result is reproducible from stored runs + policy alone (§11).
 *
 * Language rules (§6): classifications are factual, never "good/bad/
 * better/worse". No overall score is computed anywhere.
 */

// --- source-of-truth value extraction ----------------------------------------

/** A metric value with its exact stored provenance. */
export interface SourceValue {
  value: number | null;
  /** Where the number came from, verbatim. */
  source: string;
}

export interface RunLike {
  _id?: unknown;
  status?: unknown;
  executionMode?: unknown;
  engineMode?: unknown;
  targetBaseUrl?: unknown;
  errorMessage?: unknown;
  metrics?: unknown;
  externalResult?: unknown;
  plan?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) ? n : null;
};

/**
 * Read a value from the run using the EXACT STORED SOURCE VALUES (§3):
 * total-level numbers come from externalResult.metrics (the verbatim
 * backend TestResult, where per-endpoint and status codes also live);
 * the mapped metrics block is the fallback when a verbatim value is
 * absent. Nothing is recomputed from raw samples, ever.
 */
export function extractMetric(run: RunLike): {
  p50: SourceValue;
  p95: SourceValue;
  p99: SourceValue;
  average: SourceValue;
  max: SourceValue;
  rps: SourceValue;
  errorRate: SourceValue; // 0..1
  totalRequests: SourceValue;
  totalFailures: SourceValue;
  statusCodes: { code: string; count: number }[] | null;
  perEndpoint: StoredEndpointRow[];
} {
  const ext = asRecord(run.externalResult);
  const extMetrics = ext ? asRecord(ext.metrics) : null;
  const mapped = asRecord(run.metrics);

  const fromExt = (key: string): SourceValue | null => {
    const n = extMetrics ? num(extMetrics[key]) : null;
    return n === null ? null : { value: n, source: `externalResult.metrics.${key}` };
  };
  const fromMapped = (key: string): SourceValue | null => {
    const n = mapped ? num(mapped[key]) : null;
    return n === null ? null : { value: n, source: `metrics.${key}` };
  };
  const pick = (extKey: string, mappedKey: string): SourceValue => {
    if (extMetrics) {
      const v = fromExt(extKey);
      if (v) return v;
    }
    const v = fromMapped(mappedKey);
    if (v) return v;
    return { value: null, source: "missing" };
  };

  // error_rate is stored 0..1 in both layers.
  const errorRate = pick("error_rate", "errorRate");
  // totalRequests: prefer the verbatim count; never derive one layer from the other.
  const totalRequests = pick("total_requests", "totalRequests");
  const totalFailures = pick("failed_requests", "totalFailures");

  // Status codes / per-endpoint rows exist ONLY in the verbatim backend layer.
  let statusCodes: { code: string; count: number }[] | null = null;
  const rawStatus = extMetrics ? asRecord(extMetrics.status_codes) : null;
  if (rawStatus) {
    statusCodes = Object.entries(rawStatus)
      .map(([code, count]) => ({ code, count: int(count) ?? -1 }))
      .filter((c) => c.count >= 0)
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  let perEndpoint: StoredEndpointRow[] = [];
  const rawPer = extMetrics && Array.isArray(extMetrics.per_endpoint) ? extMetrics.per_endpoint : [];
  for (const row of rawPer) {
    const e = asRecord(row);
    if (!e) continue;
    const endpoint = str(e.endpoint);
    if (!endpoint) continue;
    perEndpoint.push({
      endpoint,
      method: str(e.method),
      requests: int(e.total_requests),
      p50: num(e.p50_ms),
      p95: num(e.p95_ms),
      p99: num(e.p99_ms),
      average: num(e.average_ms),
      max: num(e.max_ms),
      rps: num(e.rps),
      errorRate: num(e.error_rate),
    });
  }

  return {
    p50: pick("p50_ms", "p50"),
    p95: pick("p95_ms", "p95"),
    p99: pick("p99_ms", "p99"),
    average: pick("average_ms", "latencyAvgMs"),
    max: pick("max_ms", "latencyMaxMs"),
    rps: pick("rps", "maxRps"),
    errorRate,
    totalRequests,
    totalFailures,
    statusCodes,
    perEndpoint,
  };
}

export interface StoredEndpointRow {
  endpoint: string;
  method: string | null;
  requests: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  average: number | null;
  max: number | null;
  rps: number | null;
  errorRate: number | null; // 0..1
}

// --- regression policy --------------------------------------------------------

export const REGRESSION_POLICY_VERSION = "perforso.regression-policy.v1";

/**
 * §6 — configurable, DOCUMENTED policy thresholds. Defaults are the brief's
 * example values; callers may override (configuration, not hard-coding).
 * Latency/RPS thresholds are relative percentages; the error-rate threshold
 * is ABSOLUTE percentage points (pp) so 1% → 2% is a regression (+1pp) even
 * though it is +100% relatively.
 */
export interface RegressionPolicy {
  /** p50/p95/p99/avg/max: candidate may be at most this % above baseline. */
  latencyRegressionThresholdPct: number;
  /** RPS may fall by at most this % before THROUGHPUT_REGRESSION. */
  rpsDegradationThresholdPct: number;
  /** Error rate may rise by at most this many percentage points. */
  errorRateRegressionThresholdPp: number;
}

export const DEFAULT_REGRESSION_POLICY: RegressionPolicy = {
  latencyRegressionThresholdPct: 10,
  rpsDegradationThresholdPct: 10,
  errorRateRegressionThresholdPp: 1,
};

/** Public documentation of the policy semantics (rendered in UI/API). */
export const POLICY_DOCUMENTATION = {
  version: REGRESSION_POLICY_VERSION,
  rules: [
    "LATENCY_REGRESSION: any of p50/p95/p99/average/max rises by more than latencyRegressionThresholdPct percent of the baseline value (relative).",
    "THROUGHPUT_REGRESSION: rps falls by more than rpsDegradationThresholdPct percent of the baseline value (relative).",
    "ERROR_RATE_REGRESSION: error rate rises by more than errorRateRegressionThresholdPp absolute percentage points.",
  ],
  notes: [
    "Percentage deltas are computed against the baseline value; a zero baseline cannot yield a percentage (percentage is null, absolute delta remains factual).",
    "Metrics equal to the threshold boundary are NOT regressions (strictly-beyond semantics).",
    "Classifications are factual outcomes of the thresholds — never quality judgments.",
  ],
} as const;

// --- compatibility ------------------------------------------------------------

export interface CompatibilityCheck {
  compatible: boolean;
  /** Machine-readable reasons for every incompatibility found (empty if compatible). */
  reasons: string[];
  /** True only when the ONLY mismatch is target VUs — a load-sensitivity comparison (§2). */
  loadSensitivityOnly: boolean;
}

/**
 * §2 — COMPATIBILITY FIRST. Every dimension is compared and EVERY mismatch is
 * reported; nothing is silently compared. A VU mismatch alone is reported as
 * load-sensitivity, not invalid — the caller decides how to label it.
 */
export function checkCompatibility(baseline: RunLike, candidate: RunLike): CompatibilityCheck {
  const reasons: string[] = [];
  const bp = asRecord(baseline.plan);
  const cp = asRecord(candidate.plan);
  const bPlan = bp ?? {};
  const cPlan = cp ?? {};

  const mismatch = (dim: string, b: unknown, c: unknown, render: (v: unknown) => string = JSON.stringify) => {
    reasons.push(`${dim} mismatch: baseline=${render(b)} candidate=${render(c)}`);
  };

  // Target (normalized URL, trailing-slash-insensitive like the safety gate).
  const bTarget = str(baseline.targetBaseUrl);
  const cTarget = str(candidate.targetBaseUrl);
  if ((bTarget ?? "") !== (cTarget ?? "")) mismatch("target", bTarget, cTarget, (v) => String(v));

  // Execution mode: the authoritative live execution mode (fallback engineMode).
  const bMode = str(baseline.executionMode) ?? str(baseline.engineMode);
  const cMode = str(candidate.executionMode) ?? str(candidate.engineMode);
  if ((bMode ?? "") !== (cMode ?? "")) mismatch("execution mode", bMode, cMode, (v) => String(v ?? "unknown"));

  // Objective type / test type.
  const bObj = str(bPlan.objectiveType);
  const cObj = str(cPlan.objectiveType);
  if ((bObj ?? "") !== (cObj ?? "")) mismatch("objective type", bObj, cObj, (v) => String(v ?? "unknown"));

  const bTest = str(bPlan.testType);
  const cTest = str(cPlan.testType);
  if ((bTest ?? "") !== (cTest ?? "")) mismatch("test type", bTest, cTest, (v) => String(v ?? "unknown"));

  // Selected endpoints: set equality, order-insensitive (§13: endpoint set).
  const bEps = Array.isArray(bPlan.selectedEndpoints) ? [...(bPlan.selectedEndpoints as string[])].sort() : [];
  const cEps = Array.isArray(cPlan.selectedEndpoints) ? [...(cPlan.selectedEndpoints as string[])].sort() : [];
  if (JSON.stringify(bEps) !== JSON.stringify(cEps)) {
    mismatch("selected endpoints", bEps, cEps, (v) => (v as string[]).join(",") || "(none)");
  }

  // Endpoint weights: exact map equality when either side declares any.
  const bW = asRecord(bPlan.endpointWeights);
  const cW = asRecord(cPlan.endpointWeights);
  if (bW || cW) {
    const norm = (w: Record<string, unknown> | null): string =>
      w
        ? Object.keys(w)
            .sort()
            .map((k) => `${k}=${num(w[k]) ?? "?"}`)
            .join(",")
        : "(none)";
    if (norm(bW) !== norm(cW)) mismatch("endpoint weights", bW, cW, (v) => norm(asRecord(v)));
  }

  // Target VUs.
  const bVus = int(bPlan.targetVus);
  const cVus = int(cPlan.targetVus);
  if (bVus === null || cVus === null || bVus !== cVus) {
    mismatch("target VUs", bVus, cVus, (v) => String(v ?? "unknown"));
  }

  // Duration (fixed_load): normalized to seconds via a strict parser.
  const dur = (p: Record<string, unknown>): number | null => {
    const d = str(p.duration);
    if (!d) return null;
    const m = /^(\d+)(ms|s|m|h)$/.exec(d);
    if (!m) return NaN; // unparseable ≠ absent: still a mismatch, never guessed equal
    const mult = { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2] as "ms" | "s" | "m" | "h"];
    return Number(m[1]) * mult;
  };
  const bDur = dur(bPlan);
  const cDur = dur(cPlan);
  if (bDur === null && cDur === null) {
    // Both boundary_search-shaped (ramp/hold): compare ramp+hold exactly.
    const ramp = (p: Record<string, unknown>) => str(p.rampDuration) ?? "";
    const hold = (p: Record<string, unknown>) => str(p.holdDuration) ?? "";
    if (ramp(bPlan) !== ramp(cPlan) || hold(bPlan) !== hold(cPlan)) {
      mismatch("ramp/hold durations", `${ramp(bPlan)}+${hold(bPlan)}`, `${ramp(cPlan)}+${hold(cPlan)}`);
    }
  } else if (bDur === null || cDur === null || bDur !== cDur) {
    mismatch("duration", str(bPlan.duration), str(cPlan.duration), (v) => String(v ?? "unknown"));
  }

  // Thresholds (exact).
  const bThr = asRecord(bPlan.thresholds);
  const cThr = asRecord(cPlan.thresholds);
  const thrRepr = (t: Record<string, unknown> | null): string =>
    t ? `${num(t.p95LatencyMs) ?? "?"}ms/${num(t.errorRate) ?? "?"}` : "(none)";
  if (thrRepr(bThr) !== thrRepr(cThr)) mismatch("thresholds", bThr, cThr, (v) => thrRepr(asRecord(v)));

  const loadSensitivityOnly =
    reasons.length === 1 && bVus !== null && cVus !== null && bVus !== cVus && (bMode ?? "") === (cMode ?? "");

  return { compatible: reasons.length === 0, reasons, loadSensitivityOnly };
}

// --- deterministic deltas ------------------------------------------------------

export interface MetricDelta {
  baseline: number | null;
  candidate: number | null;
  /** candidate − baseline, exact stored values (null when either side is missing). */
  absoluteDelta: number | null;
  /** (candidate − baseline) / |baseline| × 100. Null for zero/missing baselines (§16.5). */
  percentageDelta: number | null;
  baselineSource: string;
  candidateSource: string;
}

/**
 * §3 — deterministic delta: absolute + percentage. Percentage is computed
 * against the baseline; a ZERO baseline has no meaningful percentage and
 * yields null (the absolute delta stays factual). No rounding here —
 * rounding is presentation, and the engine's output must stay reproducible.
 */
export function delta(baseline: SourceValue, candidate: SourceValue): MetricDelta {
  const b = baseline.value;
  const c = candidate.value;
  const absoluteDelta = b !== null && c !== null ? c - b : null;
  const percentageDelta =
    b !== null && c !== null && b !== 0 ? ((c - b) / Math.abs(b)) * 100 : null;
  return {
    baseline: b,
    candidate: c,
    absoluteDelta,
    percentageDelta,
    baselineSource: baseline.source,
    candidateSource: candidate.source,
  };
}

// --- classifications ------------------------------------------------------------

export type RegressionClassification =
  | "NO_REGRESSION_DETECTED"
  | "LATENCY_REGRESSION"
  | "ERROR_RATE_REGRESSION"
  | "THROUGHPUT_REGRESSION"
  | "MULTIPLE_REGRESSIONS"
  | "INCONCLUSIVE";

export interface RegressionStatus {
  status: RegressionClassification;
  /** Factual threshold breaches backing the status (empty for NO_REGRESSION_DETECTED). */
  breaches: string[];
}

/**
 * §6 — policy classification from the deltas. Deterministic, thresholded,
 * factual. Cannot be overridden by the AI layer (validated downstream).
 */
export function classifyFromDeltas(
  metrics: {
    p50: MetricDelta;
    p95: MetricDelta;
    p99: MetricDelta;
    average: MetricDelta;
    max: MetricDelta;
    rps: MetricDelta;
    errorRate: MetricDelta; // 0..1 values
  },
  policy: RegressionPolicy,
): RegressionStatus {
  const breaches: string[] = [];
  let latency = false;
  let throughput = false;
  let error = false;

  const latencyMetrics: [string, MetricDelta][] = [
    ["p50", metrics.p50],
    ["p95", metrics.p95],
    ["p99", metrics.p99],
    ["average", metrics.average],
    ["max", metrics.max],
  ];
  for (const [name, d] of latencyMetrics) {
    if (d.absoluteDelta === null || d.percentageDelta === null) continue; // missing → INCONCLUSIVE below
    if (d.absoluteDelta > 0 && d.percentageDelta > policy.latencyRegressionThresholdPct) {
      latency = true;
      breaches.push(
        `${name} latency +${round(d.percentageDelta)}% exceeds the +${policy.latencyRegressionThresholdPct}% latency regression threshold (${round(d.baseline ?? 0)}ms → ${round(d.candidate ?? 0)}ms)`,
      );
    }
  }

  if (metrics.rps.absoluteDelta !== null && metrics.rps.percentageDelta !== null) {
    if (metrics.rps.absoluteDelta < 0 && metrics.rps.percentageDelta < -policy.rpsDegradationThresholdPct) {
      throughput = true;
      breaches.push(
        `rps ${round(metrics.rps.percentageDelta)}% exceeds the −${policy.rpsDegradationThresholdPct}% throughput degradation threshold (${round(metrics.rps.baseline ?? 0)} → ${round(metrics.rps.candidate ?? 0)})`,
      );
    }
  }

  // Error rate: ABSOLUTE percentage points (1% → 2% = +1pp), never relative %.
  const errB = metrics.errorRate.baseline;
  const errC = metrics.errorRate.candidate;
  if (errB !== null && errC !== null) {
    const pp = (errC - errB) * 100;
    if (pp > policy.errorRateRegressionThresholdPp) {
      error = true;
      breaches.push(
        `error rate +${round(pp)}pp exceeds the +${policy.errorRateRegressionThresholdPp}pp error-rate regression threshold (${round(errB * 100)}% → ${round(errC * 100)}%)`,
      );
    }
  }

  const hits = [latency, throughput, error].filter(Boolean).length;
  const status: RegressionClassification =
    hits === 0 ? "NO_REGRESSION_DETECTED" : hits === 1 ? (latency ? "LATENCY_REGRESSION" : throughput ? "THROUGHPUT_REGRESSION" : "ERROR_RATE_REGRESSION") : "MULTIPLE_REGRESSIONS";
  return { status, breaches };
}

const round = (v: number): number => Math.round(v * 100) / 100;

// --- endpoint comparison ---------------------------------------------------------

export interface EndpointMetricDelta {
  baseline: number | null;
  candidate: number | null;
  absoluteDelta: number | null;
  percentageDelta: number | null;
}

export interface EndpointComparison {
  endpoint: string;
  requests: EndpointMetricDelta;
  p50: EndpointMetricDelta;
  p95: EndpointMetricDelta;
  p99: EndpointMetricDelta;
  average: EndpointMetricDelta;
  max: EndpointMetricDelta;
  rps: EndpointMetricDelta;
  errorRate: EndpointMetricDelta; // 0..1 values (percentages in pp terms at policy time)
  /** Status-code distribution per side; null = no verbatim status evidence. */
  baselineStatusCodes: { code: string; count: number }[] | null;
  candidateStatusCodes: { code: string; count: number }[] | null;
  /** Factual distribution differences: new codes, disappeared codes, count changes. */
  statusDistributionChanges: string[];
}

function cmp(baseline: number | null, candidate: number | null): EndpointMetricDelta {
  const absoluteDelta = baseline !== null && candidate !== null ? candidate - baseline : null;
  const percentageDelta =
    baseline !== null && candidate !== null && baseline !== 0
      ? ((candidate - baseline) / Math.abs(baseline)) * 100
      : null;
  return { baseline, candidate, absoluteDelta, percentageDelta };
}

/**
 * §4 — endpoint-level comparison for every endpoint present in BOTH runs.
 * Endpoints present in only one run are reported as insufficient overlap
 * (compatibility layer), never silently compared.
 */
export function compareEndpoints(
  baselineRows: StoredEndpointRow[],
  candidateRows: StoredEndpointRow[],
  baselineStatus: { code: string; count: number }[] | null,
  candidateStatus: { code: string; count: number }[] | null,
): EndpointComparison[] {
  const bByEp = new Map(baselineRows.map((r) => [r.endpoint, r]));
  const cByEp = new Map(candidateRows.map((r) => [r.endpoint, r]));
  const out: EndpointComparison[] = [];
  for (const [endpoint, b] of bByEp) {
    const c = cByEp.get(endpoint);
    if (!c) continue; // single-sided endpoints never compared
    // Per-endpoint status codes: proportional split is DERIVATION — instead,
    // report distribution changes from the whole-run evidence when the run is
    // single-endpoint (identity), else compare the run-level distributions.
    const changes: string[] = [];
    if (b.requests !== null && c.requests !== null && b.requests > 0 && c.requests > 0) {
      const single = baselineRows.length === 1 && candidateRows.length === 1;
      if (single && baselineStatus && candidateStatus) {
        changes.push(...statusDistributionChanges(baselineStatus, candidateStatus));
      }
    }
    out.push({
      endpoint,
      requests: cmp(b.requests, c.requests),
      p50: cmp(b.p50, c.p50),
      p95: cmp(b.p95, c.p95),
      p99: cmp(b.p99, c.p99),
      average: cmp(b.average, c.average),
      max: cmp(b.max, c.max),
      rps: cmp(b.rps, c.rps),
      errorRate: cmp(b.errorRate, c.errorRate),
      baselineStatusCodes: baselineStatus,
      candidateStatusCodes: candidateStatus,
      statusDistributionChanges: changes,
    });
  }
  out.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return out;
}

/**
 * §5 — factual status-code distribution differences. Reports codes that
 * appeared, disappeared, or changed count. Never states WHY (no cause).
 */
export function statusDistributionChanges(
  baseline: { code: string; count: number }[],
  candidate: { code: string; count: number }[],
): string[] {
  const bMap = new Map(baseline.map((s) => [s.code, s.count]));
  const cMap = new Map(candidate.map((s) => [s.code, s.count]));
  const changes: string[] = [];
  for (const [code, cCount] of cMap) {
    const bCount = bMap.get(code);
    if (bCount === undefined) changes.push(`status ${code} observed in candidate (${cCount}) but absent in baseline`);
    else if (bCount !== cCount) changes.push(`status ${code} count changed: ${bCount} → ${cCount}`);
  }
  for (const [code, bCount] of bMap) {
    if (!cMap.has(code)) changes.push(`status ${code} observed in baseline (${bCount}) but absent in candidate`);
  }
  return changes;
}

// --- inconclusive reasons ----------------------------------------------------------

export type InconclusiveReason =
  | "missing_baseline"
  | "missing_candidate"
  | "incompatible_workload"
  | "load_sensitivity_comparison"
  | "insufficient_endpoint_overlap"
  | "missing_metrics"
  | "execution_error"
  | "simulation_involved"
  | "real_probe_involved"
  | "pending_execution";

export interface Inconclusive {
  inconclusive: true;
  reasons: InconclusiveReason[];
  detail: string[];
}

/**
 * §7 — INCONCLUSIVE detection. Any of these conditions forbids a regression
 * verdict; the engine returns INCONCLUSIVE instead of forcing one.
 */
export function inconclusiveReasons(
  baseline: RunLike | null,
  candidate: RunLike | null,
  compatibility: CompatibilityCheck | null,
  baselineMetrics: ReturnType<typeof extractMetric> | null,
  candidateMetrics: ReturnType<typeof extractMetric> | null,
): Inconclusive | null {
  const reasons: InconclusiveReason[] = [];
  const detail: string[] = [];

  if (!baseline) reasons.push("missing_baseline");
  if (!candidate) reasons.push("missing_candidate");
  if (!baseline || !candidate) {
    const early: InconclusiveReason[] = reasons.filter(
      (r): r is InconclusiveReason => r === "missing_baseline" || r === "missing_candidate",
    );
    return { inconclusive: true, reasons: uniqueInconclusive(early), detail };
  }

  const bStatus = str(baseline.status);
  const cStatus = str(candidate.status);
  if (bStatus === "execution_error") {
    reasons.push("execution_error");
    detail.push(`baseline run ended in EXECUTION_ERROR${str(baseline.errorMessage) ? `: ${str(baseline.errorMessage)}` : ""}`);
  }
  if (cStatus === "execution_error") {
    reasons.push("execution_error");
    detail.push(`candidate run ended in EXECUTION_ERROR${str(candidate.errorMessage) ? `: ${str(candidate.errorMessage)}` : ""}`);
  }

  const modeOf = (r: RunLike, label: string): string | null => {
    const m = str(r.executionMode) ?? str(r.engineMode);
    if (m === "simulation") {
      reasons.push("simulation_involved");
      detail.push(`${label} run is a simulation — simulated values must never enter a regression comparison`);
    } else if (m === "real") {
      reasons.push("real_probe_involved");
      detail.push(`${label} run is a bounded REAL_PROBE — probe measurements are not sustained-load comparisons`);
    } else if (m === "live_k6_pending" || m === "submitted" || m === null) {
      reasons.push("pending_execution");
      detail.push(`${label} run execution mode is ${m ?? "unknown"} — no completed LIVE_K6 evidence`);
    }
    return m;
  };
  modeOf(baseline, "baseline");
  modeOf(candidate, "candidate");

  if (compatibility && !compatibility.compatible) {
    reasons.push(compatibility.loadSensitivityOnly ? "load_sensitivity_comparison" : "incompatible_workload");
    detail.push(...compatibility.reasons);
  }
  // Endpoint overlap: every planned endpoint must have rows on both sides.
  const checkOverlap = (m: ReturnType<typeof extractMetric>, plan: unknown, label: string) => {
    const p = asRecord(plan);
    const planned = Array.isArray(p?.selectedEndpoints) ? (p!.selectedEndpoints as string[]) : [];
    const measured = new Set(m.perEndpoint.map((r) => r.endpoint));
    const missing = planned.filter((e) => !measured.has(e));
    if (planned.length > 0 && missing.length > 0) {
      reasons.push("insufficient_endpoint_overlap");
      detail.push(`${label} run has no per-endpoint metrics for: ${missing.join(", ")}`);
    }
  };
  if (baselineMetrics && candidateMetrics) {
    checkOverlap(baselineMetrics, baseline.plan, "baseline");
    checkOverlap(candidateMetrics, candidate.plan, "candidate");
  }

  // Missing top-level metrics: every compared metric must exist on both sides.
  if (baselineMetrics && candidateMetrics) {
    const keys: [string, SourceValue, SourceValue][] = [
      ["p50", baselineMetrics.p50, candidateMetrics.p50],
      ["p95", baselineMetrics.p95, candidateMetrics.p95],
      ["p99", baselineMetrics.p99, candidateMetrics.p99],
      ["average", baselineMetrics.average, candidateMetrics.average],
      ["max", baselineMetrics.max, candidateMetrics.max],
      ["rps", baselineMetrics.rps, candidateMetrics.rps],
      ["errorRate", baselineMetrics.errorRate, candidateMetrics.errorRate],
      ["totalRequests", baselineMetrics.totalRequests, candidateMetrics.totalRequests],
    ];
    for (const [name, b, c] of keys) {
      if (b.value === null || c.value === null) {
        reasons.push("missing_metrics");
        detail.push(
          `${name} is ${b.value === null ? "missing from the baseline" : "missing from the candidate"} (source: ${b.value === null ? b.source : c.source})`,
        );
      }
    }
  }

  return reasons.length > 0 ? { inconclusive: true, reasons: uniqueInconclusive(reasons), detail } : null;
}

function uniqueInconclusive(arr: InconclusiveReason[]): InconclusiveReason[] {
  return Array.from(new Set(arr));
}

// --- the deterministic object ---------------------------------------------------

export interface RegressionMetricsObject {
  p50: MetricDelta;
  p95: MetricDelta;
  p99: MetricDelta;
  average: MetricDelta;
  max: MetricDelta;
  rps: MetricDelta;
  errorRate: MetricDelta;
  totalRequests: MetricDelta;
}

export interface DeterministicRegressionObject {
  baselineRunId: string;
  candidateRunId: string;
  compatibility: "COMPATIBLE" | "INCOMPATIBLE";
  compatibilityReasons: string[];
  /** VU-mismatch-only comparisons are load-sensitivity, not invalid (§2). */
  loadSensitivityOnly: boolean;
  policyVersion: string;
  policy: RegressionPolicy;
  metrics: RegressionMetricsObject;
  endpointResults: EndpointComparison[];
  statusDistributionChanges: string[];
  classifications: RegressionClassification[];
  /** Factual threshold breaches backing the primary classification. */
  breaches: string[];
  status: RegressionClassification;
  inconclusive: Inconclusive | null;
  /** Run status/execution-mode provenance, restated (never judged). */
  baselineSummary: { runId: string; status: string; executionMode: string; totalRequests: number | null };
  candidateSummary: { runId: string; status: string; executionMode: string; totalRequests: number | null };
}

/**
 * §11 — the structured deterministic regression object. Reproducible from
 * the two stored runs + the policy: no clock, no randomness, no AI.
 */
export function computeDeterministicRegression(
  baseline: RunLike | null,
  candidate: RunLike | null,
  policy: RegressionPolicy = DEFAULT_REGRESSION_POLICY,
): DeterministicRegressionObject {
  const baselineRunId = baseline && str(baseline._id) ? String(baseline._id) : "";
  const candidateRunId = candidate && str(candidate._id) ? String(candidate._id) : "";

  const summaryOf = (r: RunLike | null) => ({
    runId: r && str(r._id) ? String(r._id) : "",
    status: (r && str(r.status)) ?? "unknown",
    executionMode: (r && (str(r.executionMode) ?? str(r.engineMode))) ?? "unknown",
    totalRequests: r ? extractMetric(r).totalRequests.value : null,
  });

  const emptyObject = (over: Partial<DeterministicRegressionObject>): DeterministicRegressionObject => ({
    baselineRunId,
    candidateRunId,
    compatibility: "INCOMPATIBLE",
    compatibilityReasons: [],
    loadSensitivityOnly: false,
    policyVersion: REGRESSION_POLICY_VERSION,
    policy,
    metrics: {
      p50: miss(), p95: miss(), p99: miss(), average: miss(),
      max: miss(), rps: miss(), errorRate: miss(), totalRequests: miss(),
    },
    endpointResults: [],
    statusDistributionChanges: [],
    classifications: ["INCONCLUSIVE"],
    breaches: [],
    status: "INCONCLUSIVE",
    inconclusive: {
      inconclusive: true,
      reasons: baseline && candidate ? [] : ["missing_baseline"],
      detail: [],
    },
    baselineSummary: summaryOf(baseline),
    candidateSummary: summaryOf(candidate),
    ...over,
  });

  if (!baseline || !candidate) {
    return emptyObject({
      compatibilityReasons: [],
      inconclusive: {
        inconclusive: true,
        reasons: baseline ? ["missing_candidate"] : candidate ? ["missing_baseline"] : ["missing_baseline", "missing_candidate"],
        detail: [],
      },
    });
  }

  const compatibility = checkCompatibility(baseline, candidate);
  const bm = extractMetric(baseline);
  const cm = extractMetric(candidate);

  const inc = inconclusiveReasons(baseline, candidate, compatibility, bm, cm);
  if (inc) {
    return emptyObject({
      compatibility: compatibility.compatible ? "COMPATIBLE" : "INCOMPATIBLE",
      compatibilityReasons: compatibility.reasons,
      loadSensitivityOnly: compatibility.loadSensitivityOnly,
      inconclusive: inc,
    });
  }

  const metrics: RegressionMetricsObject = {
    p50: delta(bm.p50, cm.p50),
    p95: delta(bm.p95, cm.p95),
    p99: delta(bm.p99, cm.p99),
    average: delta(bm.average, cm.average),
    max: delta(bm.max, cm.max),
    rps: delta(bm.rps, cm.rps),
    errorRate: delta(bm.errorRate, cm.errorRate),
    totalRequests: delta(bm.totalRequests, cm.totalRequests),
  };

  const endpointResults = compareEndpoints(bm.perEndpoint, cm.perEndpoint, bm.statusCodes, cm.statusCodes);
  const runLevelStatusChanges =
    bm.statusCodes && cm.statusCodes ? statusDistributionChanges(bm.statusCodes, cm.statusCodes) : [];

  const classification = classifyFromDeltas(metrics, policy);

  return {
    baselineRunId,
    candidateRunId,
    compatibility: compatibility.compatible ? "COMPATIBLE" : "INCOMPATIBLE",
    compatibilityReasons: compatibility.reasons,
    loadSensitivityOnly: compatibility.loadSensitivityOnly,
    policyVersion: REGRESSION_POLICY_VERSION,
    policy,
    metrics,
    endpointResults,
    statusDistributionChanges: runLevelStatusChanges,
    classifications: [classification.status],
    breaches: classification.breaches,
    status: classification.status,
    inconclusive: null,
    baselineSummary: summaryOf(baseline),
    candidateSummary: summaryOf(candidate),
  };
}

const miss = (): MetricDelta => ({
  baseline: null,
  candidate: null,
  absoluteDelta: null,
  percentageDelta: null,
  baselineSource: "missing",
  candidateSource: "missing",
});
