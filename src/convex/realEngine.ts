/**
 * Aggregation of a completed probe into the run's per-second samples and
 * totals — extracted from mutations.ts so it is pure and unit-testable.
 *
 * k6 measurement semantics preserved:
 *  - latency percentiles cover every COMPLETED response regardless of
 *    status (k6 http_req_duration includes 4xx/5xx exchanges)
 *  - network-level failures (no response) are excluded from latency stats
 *    but counted as failures (k6 http_req_failed)
 *  - status 0 = "no HTTP response received" (k6's convention)
 */

import { latencyStats } from "./percentile";
import { MAX_BURST } from "./probe";
import type { ProbeEvent, ProbeResult } from "./probe";
import type { EngineTotals, Stage } from "./engine";

export interface SampleRow {
  tSec: number;
  vus: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
}

export interface PlanShape {
  objectiveType: "fixed_load" | "boundary_search";
  testType: "baseline" | "stress" | "soak";
  targetVus: number;
  duration?: string;
  rampDuration?: string;
  holdDuration?: string;
  selectedEndpoints: string[];
  thresholds: { p95LatencyMs: number; errorRate: number };
  assumptions: string[];
}

export function buildRealEngine(
  probe: ProbeResult,
  stages: Stage[],
  plan: PlanShape,
  targetBaseUrl: string,
): {
  samples: (SampleRow & { plannedVus: number })[];
  log: { at: number; phase: string; message: string }[];
  totals: EngineTotals;
  breakpoint: null;
  capacityVus: number;
  latencyAvgMs: number;
  latencyMaxMs: number;
  /** Measured peak in-flight requests (honest probe concurrency). */
  measuredPeakConcurrent: number;
} {
  const seconds = Math.max(1, Math.ceil(Math.max(1000, probe.elapsedMs) / 1000));

  // Requested envelope: interpolate the PLANNED VU trajectory over the probe
  // window — reported as workload context (plannedVus), never as measured VUs.
  const totalStageSecs = Math.max(1, stages.reduce((a, s) => a + s.durationSec, 0));
  const plannedVusAt = (frac: number): number => {
    let pos = frac * totalStageSecs;
    for (const stage of stages) {
      if (pos < stage.durationSec || stage === stages[stages.length - 1]) {
        const f = stage.durationSec > 1 ? Math.min(1, pos / (stage.durationSec - 1)) : 1;
        return stage.name === "ramp" || stage.name === "ramp-up"
          ? Math.max(1, Math.round(1 + (stage.vus - 1) * f))
          : stage.vus;
      }
      pos -= stage.durationSec;
    }
    return plan.targetVus;
  };

  const buckets = Array.from({ length: seconds }, () => ({ requests: 0, errors: 0, latencies: [] as number[] }));
  for (const e of probe.events) {
    const idx = Math.min(seconds - 1, Math.floor(e.tMs / 1000));
    buckets[idx].requests += 1;
    if (e.error || e.status >= 400) buckets[idx].errors += 1;
    buckets[idx].latencies.push(e.latencyMs);
  }

  const log: { at: number; phase: string; message: string }[] = [
    { at: 0, phase: "init", message: `engine: target=${targetBaseUrl} testType=${plan.testType} objective=${plan.objectiveType} mode=real-traffic` },
    { at: 0, phase: "plan", message: `requested envelope (NOT executed as load): ${stages.map((s) => `${s.name}:→${s.vus}VUs/${s.durationSec}s`).join("  ")}` },
  ];
  for (const u of probe.probeUrls) {
    log.push({ at: 0, phase: "probe", message: `GET ${u}` });
  }

  const samples: (SampleRow & { plannedVus: number })[] = [];
  let maxRps = 0;
  for (let t = 1; t <= seconds; t++) {
    const b = buckets[t - 1];
    // k6 semantics: per-second latency percentiles use the same rule as the
    // run totals — every completed exchange regardless of status.
    const ls = latencyStats(b.latencies);
    const frac = seconds > 1 ? (t - 1) / (seconds - 1) : 1;
    // sample.vus is the MEASURED in-flight request count for that second
    // (capped at MAX_BURST); the requested envelope lives on plannedVus.
    const vus = Math.min(MAX_BURST, b.requests);
    maxRps = Math.max(maxRps, b.requests);
    samples.push({
      tSec: t,
      vus,
      plannedVus: plannedVusAt(frac),
      rps: b.requests,
      p50: ls.p50,
      p95: ls.p95,
      p99: ls.p99,
      errors: b.errors,
    });
  }

  // Run-level aggregates over completed exchanges only (k6 http_req_duration);
  // avg/max are reported for the first time in this audit.
  const completed = probe.events.filter((e) => !e.error).map((e) => e.latencyMs);
  const totalsStats = latencyStats(completed);
  const non2xx = probe.statuses.filter((s) => s >= 400).length;

  const totals: EngineTotals = {
    totalRequests: probe.totalRequests,
    totalFailures: probe.networkErrors + non2xx,
    errorRate: probe.totalRequests ? (probe.networkErrors + non2xx) / probe.totalRequests : 0,
    p50: totalsStats.p50,
    p95: totalsStats.p95,
    p99: totalsStats.p99,
    maxRps: Math.round(maxRps),
    peakVus: Math.min(MAX_BURST, probe.totalRequests),
    iterations: probe.totalRequests,
  };

  log.push({
    at: seconds,
    phase: "probe",
    message: `measured ${probe.totalRequests} real requests in ${(probe.elapsedMs / 1000).toFixed(1)}s, peak ${probe.maxInFlight} in flight — ${non2xx} non-2xx, ${probe.networkErrors} network errors${probe.errorSample ? ` (last error: ${probe.errorSample})` : ""}`,
  });
  log.push({
    at: seconds,
    phase: "teardown",
    message: `test finished: ${totals.totalRequests} requests, ${(totals.errorRate * 100).toFixed(2)}% errors, p95 ${totals.p95}ms (avg ${totalsStats.avg}ms, max ${totalsStats.max}ms), peak ${totals.maxRps} req/s (measured)`,
  });
  log.push({
    at: seconds,
    phase: "verdict",
    message: `bounded real-traffic probe (≤${MAX_BURST} in flight) — the requested ${plan.targetVus}-VU envelope was NOT executed; no saturation or capacity inference`,
  });

  return {
    samples,
    log,
    totals,
    breakpoint: null,
    capacityVus: 0,
    latencyAvgMs: totalsStats.avg,
    latencyMaxMs: totalsStats.max,
    measuredPeakConcurrent: probe.maxInFlight,
  };
}

/**
 * Verdict label for a run (BUG 4): a bounded probe's threshold result must
 * never be presented as a capacity/stress claim.
 *   real mode  → PROBE_THRESHOLD_PASS / PROBE_THRESHOLD_FAIL
 *   simulation → PASS / FAIL (full closed-model capacity semantics apply)
 */
export function verdictLabel(engineMode: string | null | undefined, thresholdStatus: string | null | undefined): string {
  if (engineMode === "real") {
    return thresholdStatus === "PASS" ? "PROBE_THRESHOLD_PASS" : "PROBE_THRESHOLD_FAIL";
  }
  return thresholdStatus === "PASS" ? "PASS" : "FAIL";
}
