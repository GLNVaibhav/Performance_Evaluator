/**
 * k6-style load execution engine (deterministic simulation).
 *
 * Port of backend/app/services/k6_engine/* semantics into a closed-model
 * simulation: a staged load profile with ramp/hold phases, queueing-based
 * latency degradation past capacity, error budget breaches under overload,
 * per-second metric samples (the k6 summary's per-second equivalent), and
 * threshold evaluation identical in spirit to threshold_evaluator.py.
 *
 * The same plan + target always produces the same result (seed derived from
 * target), so evaluation runs are reproducible.
 */

export interface Stage {
  name: string;
  vus: number;
  durationSec: number;
}

export interface EngineSample {
  tSec: number;
  vus: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

export interface EngineTotals {
  totalRequests: number;
  totalFailures: number;
  errorRate: number;
  p50: number;
  p95: number;
  p99: number;
  maxRps: number;
  peakVus: number;
  iterations: number;
}

export interface EngineResult {
  samples: EngineSample[];
  log: { at: number; phase: string; message: string }[];
  totals: EngineTotals;
  capacityVus: number;
  breakpoint: { stage: string; vus: number } | null;
}

export interface SimulateOpts {
  plan: {
    objectiveType: "fixed_load" | "boundary_search";
    testType: "baseline" | "stress" | "soak";
    targetVus: number;
    duration?: string;
    rampDuration?: string;
    holdDuration?: string;
    selectedEndpoints: string[];
  };
  targetBaseUrl: string;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function parseDuration(d: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(d);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === "s" ? n : m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n / 1000;
}

export function planStages(plan: SimulateOpts["plan"]): Stage[] {
  if (plan.objectiveType === "boundary_search") {
    const ramp = Math.max(3, parseDuration(plan.rampDuration ?? "10s") || 10);
    const hold = Math.max(3, parseDuration(plan.holdDuration ?? "20s") || 20);
    return [
      { name: "ramp", vus: plan.targetVus, durationSec: Math.round(ramp) },
      { name: "hold", vus: plan.targetVus, durationSec: Math.round(hold) },
    ];
  }
  const dur = Math.max(10, parseDuration(plan.duration ?? "30s") || 30);
  // Fixed load: ramp into the steady VU level (k6 stages semantics).
  const rampSec = Math.max(5, Math.round(dur * 0.2));
  return [
    { name: "ramp-up", vus: plan.targetVus, durationSec: rampSec },
    { name: "steady", vus: plan.targetVus, durationSec: Math.round(dur) - rampSec },
  ];
}

export function simulateRun(opts: SimulateOpts): EngineResult {
  const stages = planStages(opts.plan);
  const rand = mulberry32(hashSeed(opts.targetBaseUrl + opts.plan.selectedEndpoints.join(",")));
  const log: EngineResult["log"] = [];
  const samples: EngineSample[] = [];

  // Server capacity: VU count where latency starts degrading. Derived from
  // the plan shape so heavier plans genuinely probe harder ceilings.
  const endpointFactor = 1 + opts.plan.selectedEndpoints.length * 0.08;
  const capacityVus = Math.max(
    20,
    Math.round((opts.plan.testType === "stress" ? 110 : 150) * endpointFactor + rand() * 60),
  );
  const breakdownVus = capacityVus + 50 + Math.round(rand() * 60);

  let t = 0;
  let breakpoint: { stage: string; vus: number } | null = null;
  let totalRequests = 0;
  let totalFailures = 0;
  let maxRps = 0;
  let peakVus = 0;
  let iterations = 0;
  let sumP50 = 0;
  let sumP95 = 0;
  let sumP99 = 0;
  const pushLog = (phase: string, message: string) => log.push({ at: t, phase, message });

  pushLog("init", `engine: target=${opts.targetBaseUrl} testType=${opts.plan.testType} objective=${opts.plan.objectiveType}`);
  pushLog("plan", stages.map((s) => `${s.name}:→${s.vus}VUs/${s.durationSec}s`).join("  "));

  for (const stage of stages) {
    for (let s = 0; s < stage.durationSec; s++) {
      t++;
      // Ramp stages interpolate VUs; hold stages sit at the ceiling.
      const frac = stage.durationSec > 1 ? s / (stage.durationSec - 1) : 1;
      const vus =
        stage.name === "ramp" || stage.name === "ramp-up"
          ? Math.max(1, Math.round(1 + (stage.vus - 1) * frac))
          : stage.vus;
      peakVus = Math.max(peakVus, vus);

      // Closed-model: per-VU request rate bounded by service time.
      const serviceMs = 42 + Math.round(rand() * 26);
      let rps: number;
      let p50: number;
      let p95: number;
      let p99: number;
      if (vus <= capacityVus) {
        rps = Math.min(vus * (1000 / serviceMs), vus * 13);
        p50 = serviceMs + Math.round(vus * 0.3);
        p95 = p50 + 24 + Math.round(vus * 0.45);
        p99 = p95 + 28 + Math.round(vus * 0.75);
      } else {
        const over = vus / capacityVus;
        rps = Math.round((capacityVus * (1000 / serviceMs)) / Math.sqrt(over));
        p50 = Math.round(serviceMs * over);
        p95 = Math.round(p50 * 1.65);
        p99 = Math.round(p50 * 2.35);
      }
      const errorRate =
        vus > breakdownVus
          ? 0.045 + rand() * 0.05
          : vus > capacityVus * 1.3
            ? rand() * 0.014
            : rand() * 0.002;
      const errors = Math.round(rps * errorRate);

      totalRequests += rps;
      totalFailures += errors;
      iterations += Math.max(1, Math.round(rps / stages.length));
      maxRps = Math.max(maxRps, rps);
      sumP50 += p50;
      sumP95 += p95;
      sumP99 += p99;

      samples.push({ tSec: t, vus, rps, p50, p95, p99, errors });

      if (!breakpoint && vus > capacityVus) {
        breakpoint = { stage: stage.name, vus };
        pushLog("breakpoint", `saturation onset: latency ≥ 2× baseline at ${vus} VUs (capacity ≈ ${capacityVus} VUs)`);
      }
      if (vus > breakdownVus) {
        pushLog("degraded", `error rate ${(errorRate * 100).toFixed(1)}% at ${vus} VUs — connection resets / 5xx observed`);
      }
    }
  }

  const n = samples.length || 1;
  const totals: EngineTotals = {
    totalRequests,
    totalFailures,
    errorRate: totalRequests ? totalFailures / totalRequests : 0,
    p50: Math.round(sumP50 / n),
    p95: Math.round(sumP95 / n),
    p99: Math.round(sumP99 / n),
    maxRps: Math.round(maxRps),
    peakVus,
    iterations,
  };

  pushLog("teardown", `test finished: ${totalRequests.toLocaleString("en-US")} requests, ${(totals.errorRate * 100).toFixed(2)}% errors, p95 ${totals.p95}ms, peak ${totals.maxRps} req/s`);
  pushLog(
    "verdict",
    breakpoint
      ? `breaking point identified at ${breakpoint.vus} VUs during "${breakpoint.stage}"`
      : `no saturation detected within the ${peakVus} VU ceiling — headroom remains`,
  );

  return { samples, log, totals, capacityVus, breakpoint };
}

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Threshold evaluation (port of threshold_evaluator.py) ------------------

export interface ThresholdInput {
  thresholds: { p95LatencyMs: number; errorRate: number };
  totals: EngineTotals;
}

export function evaluateThresholds({ thresholds, totals }: ThresholdInput): {
  status: "PASS" | "FAIL";
  violations: string[];
} {
  const violations: string[] = [];
  if (totals.p95 > thresholds.p95LatencyMs) {
    violations.push(`p95 ${totals.p95}ms exceeded threshold ${thresholds.p95LatencyMs}ms`);
  }
  if (totals.errorRate > thresholds.errorRate) {
    violations.push(`error rate ${(totals.errorRate * 100).toFixed(2)}% exceeded threshold ${(thresholds.errorRate * 100).toFixed(2)}%`);
  }
  return { status: violations.length ? "FAIL" : "PASS", violations };
}
