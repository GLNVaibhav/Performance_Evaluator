/**
 * Percentile & aggregate statistics over observed latency samples.
 *
 * Convention: linear interpolation between closest ranks over the sorted
 * samples with rank r = q * (n - 1) — the same family k6 uses for its trend
 * percentiles and the numpy default (`statistics.quantiles(method="inclusive")`
 * in Python's stdlib). Chosen deliberately so Convex-probe numbers are
 * directly comparable to real k6 --summary-export numbers.
 *
 * Rounding to integer milliseconds happens only at the reporting boundary
 * (latencyStats), never inside the interpolation.
 */

export function percentile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const r = q * (sortedAsc.length - 1);
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (r - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
  count: number;
}

export function latencyStats(samples: number[]): LatencyStats {
  if (!samples.length) return { p50: 0, p95: 0, p99: 0, avg: 0, max: 0, count: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50: Math.round(percentile(sorted, 0.5)),
    p95: Math.round(percentile(sorted, 0.95)),
    p99: Math.round(percentile(sorted, 0.99)),
    avg: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}
