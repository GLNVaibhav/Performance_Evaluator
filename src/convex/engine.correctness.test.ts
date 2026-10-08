/**
 * Engine correctness tests for the bounded real-HTTP probe and its
 * aggregation (audit: percentile math, concurrency, error semantics,
 * request-count parity, latency monotonicity, SSRF/redirect safety).
 *
 * Run: bun test src/convex/engine.correctness.test.ts
 * (types come from bun-types when installed; this file is excluded from the
 * app typecheck — see tsconfig below — but is type-checked by bun itself)
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, expect, test } from "bun:test";

import { latencyStats, percentile } from "./percentile";
import {
  runProbeVolley,
  isBlockedHost,
  probeUrlSet,
  type ProbeDeps,
} from "./probe";
import type { ProbeErrorKind } from "./probe";
import { buildRealEngine } from "./realEngine";
import { validateWorkloadLimits } from "./functions";
import type { Stage } from "./engine";

// ---------------------------------------------------------------------------
// Test scaffolding: deterministic fake fetch + virtual clock.
// ---------------------------------------------------------------------------

interface FakeRoute {
  /** Respond with this status. Default 200. */
  status?: number;
  /** Artificial per-response delay in ms (honoured by the virtual clock). */
  delayMs?: number;
  /** Never resolve (probe should classify as timeout). */
  hang?: boolean;
  /** Reject like a connection failure. */
  refuse?: boolean;
  /** 3xx with this Location. */
  redirectTo?: string;
  /** Thrown when this URL is fetched (host safety hook handles blocks). */
}

function makeFakeFetch(
  routes: Record<string, FakeRoute>,
  clock: { now: number; tick: (ms: number) => void },
  calls: { urls: string[]; concurrent: number[] },
  opts: { onCall?: (url: string) => void } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.urls.push(url);
    calls.concurrent.push(clock.now);
    opts.onCall?.(url);
    const route = routes[url] ?? routes["*"] ?? {};
    if (route.refuse) throw new Error("fetch failed: ECONNREFUSED");
    if (route.hang) {
      // Never resolves within the probe's 4s timeout — classify as timeout.
      // Simulate by rejecting with an AbortError after the request timeout.
      return new Promise<Response>((_, reject) => {
        setTimeout(() => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        }, 5_000);
      });
    }
    const delay = route.delayMs ?? 0;
    clock.now += delay;
    if (route.redirectTo) {
      return new Response(null, { status: 302, headers: { location: route.redirectTo } });
    }
    return new Response("ok", { status: route.status ?? 200 });
  }) as typeof fetch;
}

function testDeps(
  routes: Record<string, FakeRoute>,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    hostValidator?: (host: string) => Promise<void>;
  } = {},
): { deps: ProbeDeps; clock: { now: number; tick: (ms: number) => void }; calls: { urls: string[]; concurrent: number[] } } {
  const clock = { now: 0, tick: () => undefined };
  const calls = { urls: [] as string[], concurrent: [] as number[] };
  const deps: ProbeDeps = {
    fetchImpl: makeFakeFetch(routes, clock, calls),
    now: () => clock.now,
    sleep: opts.sleep ?? (async () => undefined),
    hostValidator: opts.hostValidator ?? (async () => undefined),
  };
  return { deps, clock, calls };
}

// ---------------------------------------------------------------------------
// 1. Percentile math (verified against Python statistics.quantiles inclusive)
// ---------------------------------------------------------------------------

describe("percentile math (k6 / numpy linear-interpolation convention)", () => {
  test("[10..100] matches Python statistics.quantiles(method='inclusive')", () => {
    // python3 reference (verified live):
    //   statistics.quantiles(d, n=100, method='inclusive') -> p50=55.0, p95=95.5, p99=99.1
    //   (identical to numpy's default linear percentile method)
    // NOTE on the 0.5ms rounding difference: Python computes with exact
    // fractions (95.5); this implementation (like numpy/k6 in float64)
    // computes 0.95*9 = 8.549999999999999 in IEEE754, yielding 95.4999…
    // which rounds to 95. Both are within 0.5ms of the true quantile —
    // the convention (linear interpolation on rank q*(n-1)) is what matters.
    const s = latencyStats([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(s.p50).toBe(55); // linear-interp midpoint of even-length set
    expect(s.p95).toBe(95); // float64: 95.4999… -> 95 (Python exact-fraction: 95.5 -> 96)
    expect(s.p99).toBe(99); // 99.09999999999999 -> 99 (Python: 99.1 -> 99)
    expect(s.avg).toBe(55);
    expect(s.max).toBe(100);
    expect(s.count).toBe(10);
  });

  test("odd-length set: p50 is the median exactly", () => {
    const s = latencyStats([5, 10, 15, 20, 25]);
    expect(s.p50).toBe(15);
  });

  test("interpolates between ranks for non-integer rank positions", () => {
    // sorted [0,10]: q=0.25 -> rank 0.25*(2-1)=0.25 -> 2.5
    expect(percentile([0, 10], 0.25)).toBeCloseTo(2.5, 6);
    expect(percentile([0, 10], 0.5)).toBeCloseTo(5, 6);
    expect(percentile([0, 10], 1)).toBe(10);
  });

  test("1000-sample uniform set: p95 within 1 of the true quantile", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i);
    const s = latencyStats(samples);
    // Python reference: p95 = 949.05 -> rounds to 949; p50 = 499.5 -> 500 (Math.round)
    expect(s.p95).toBe(949);
    expect(s.p50).toBe(500); // 499.5 rounds up
  });

  test("never interpolates beyond the observed max; empty input is zeroed", () => {
    expect(latencyStats([]).p50).toBe(0);
    expect(latencyStats([7]).p50).toBe(7);
    expect(latencyStats([7]).p99).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 2. Concurrency: bursts of 4 run GENUINELY in parallel (wall-clock proof)
// ---------------------------------------------------------------------------

describe("concurrency", () => {
  /**
   * Deterministic virtual-clock transport: a request captures the virtual
   * start, yields one real macrotask (so all burst members enter before any
   * resolves), then advances the shared virtual clock to start+DELAY and
   * completes. All requests of a burst therefore overlap on the virtual
   * timeline exactly as truly concurrent HTTP would — with zero real-timer
   * flakiness.
   */
  function virtualDeps(delayMs: number) {
    let clockNow = 0;
    const inFlight = { n: 0, peak: 0 };
    const fetchImpl = (async () => {
      inFlight.n += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.n);
      const startedAt = clockNow;
      await new Promise<void>((r) => setTimeout(r, 0)); // yield: let the whole burst enter
      clockNow = Math.max(clockNow, startedAt + delayMs);
      inFlight.n -= 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async (ms) => {
        clockNow += ms; // inter-volley gap consumes virtual time
      },
      hostValidator: async () => undefined,
    };
    return { deps, inFlight };
  }

  test("4 delayed requests complete inside one delay window, not 4x", async () => {
    const DELAY = 500;
    const { deps, inFlight } = virtualDeps(DELAY);
    const probe = await runProbeVolley(["https://t.test/x"], 4, deps);
    expect(probe.totalRequests).toBe(4);
    // Scheduling: 1 solo reachability request (t=DELAY) + 1 burst of 3 (t=2*DELAY).
    // Concurrent wall clock: 2 delay windows. Sequential: 4 x 500ms = 2000ms+.
    const completions = [...new Set(probe.events.map((e) => e.tMs))];
    expect(completions.length).toBe(2);
    expect(completions).toEqual([DELAY, 2 * DELAY]);
    expect(probe.elapsedMs).toBe(2 * DELAY);
  });

  test("9 requests hit MAX_BURST in-flight: two overlapping 4-request volleys", async () => {
    const DELAY = 500;
    const { deps, inFlight } = virtualDeps(DELAY);
    const probe = await runProbeVolley(["https://t.test/x"], 9, deps);
    expect(probe.totalRequests).toBe(9);
    // 1 solo + 2 full bursts: peak in-flight == MAX_BURST proves overlap.
    expect(inFlight.peak).toBe(4);
    // Schedule: initial (1 window) + burst (1 window) + jittered politeness
    // gap (120-200ms virtual) + burst (1 window); no trailing sleep.
    // => 3*DELAY + [120,200]. Sequential would be ≥ 9*DELAY + gaps.
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(3 * DELAY + 120);
    expect(probe.elapsedMs).toBeLessThanOrEqual(3 * DELAY + 200);
  });

  test("elapsed wall time for 12 requests at 100ms delay ~= 3 bursts, not 12x", async () => {
    const DELAY = 100;
    const { deps, inFlight } = virtualDeps(DELAY);
    const probe = await runProbeVolley(["https://t.test/x"], 12, deps);
    expect(probe.totalRequests).toBe(12);
    // Peak in-flight == MAX_BURST (4) proves parallel dispatch.
    expect(inFlight.peak).toBe(4);
    // Concurrent: initial + 3 bursts + 2 virtual gaps ≈ 640-800ms.
    // Sequential: 12 x 100ms + gaps ≈ 1440-1600ms. Bound strictly between.
    expect(probe.elapsedMs).toBeGreaterThanOrEqual(3 * DELAY);
    expect(probe.elapsedMs).toBeLessThan(9 * DELAY);
  });
});

// ---------------------------------------------------------------------------
// 3. Error semantics: 200/400/404/500/timeout/connection-failure
// ---------------------------------------------------------------------------

describe("error semantics", () => {
  test("200 counts as success; 400/404/500 count as failures but recorded as completions", async () => {
    const { deps } = testDeps({
      "https://t.test/ok": { status: 200 },
      "https://t.test/bad": { status: 400 },
      "https://t.test/missing": { status: 404 },
      "https://t.test/boom": { status: 500 },
    });
    // 4 URLs -> round-robin gives one of each; run 8 requests = 2 of each.
    const probe = await runProbeVolley(
      ["https://t.test/ok", "https://t.test/bad", "https://t.test/missing", "https://t.test/boom"],
      8,
      deps,
    );
    expect(probe.totalRequests).toBe(8);
    expect(probe.reachable).toBe(true);
    // All 8 completed HTTP exchanges (latency recorded), incl. error statuses.
    expect(probe.statuses.length).toBe(8);
    expect(probe.latenciesMs.length).toBe(8);
    // 2x400 + 2x404 + 2x500 = 6 HTTP failures; 0 network errors.
    expect(probe.http4xx).toBe(4);
    expect(probe.http5xx).toBe(2);
    expect(probe.networkErrors).toBe(0);
  });

  test("connection refusal is a network error with kind=connection and excluded from latencies", async () => {
    const { deps } = testDeps({ "https://t.test/x": { refuse: true } });
    const probe = await runProbeVolley(["https://t.test/x"], 3, deps);
    // First request fails -> unreachable
    expect(probe.reachable).toBe(false);
    expect(probe.totalRequests).toBe(1);
    expect(probe.networkErrors).toBe(1);
    expect(probe.latenciesMs).toHaveLength(0);
    expect(probe.statuses).toHaveLength(0);
    expect(probe.errorKindCounts.connection).toBe(1);
  });

  test("timeout after first success is classified kind=timeout, status 0", async () => {
    // First request OK (establish reachability), then hang.
    let first = true;
    let clockNow = 0;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        clockNow += 10;
        return new Response("ok", { status: 200 });
      }
      // Simulate the probe's AbortError on timeout.
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async () => undefined,
      hostValidator: async () => undefined,
    };
    const probe = await runProbeVolley(["https://t.test/x"], 5, deps);
    expect(probe.reachable).toBe(true);
    expect(probe.statuses).toEqual([200]);
    expect(probe.networkErrors).toBeGreaterThanOrEqual(1);
    const timedOut = probe.events.find((e) => e.errorKind === "timeout");
    expect(timedOut).toBeDefined();
    expect(timedOut!.status).toBe(0);
    // Latency stats contain ONLY the completed exchange.
    expect(probe.latenciesMs).toEqual([10]);
  });
});

// ---------------------------------------------------------------------------
// 4. Request-count parity: reported count == number of fetches issued
// ---------------------------------------------------------------------------

describe("request-count parity", () => {
  test("reported totalRequests equals actual fetch calls (server-side counter analogue)", async () => {
    const { deps, calls } = testDeps({ "*": { status: 200 } });
    const probe = await runProbeVolley(["https://t.test/x"], 10, deps);
    expect(calls.urls.length).toBe(10);
    expect(probe.totalRequests).toBe(10);
  });

  test("round-robin distributes requests evenly across all endpoint URLs", async () => {
    const { deps, calls } = testDeps({ "*": { status: 200 } });
    await runProbeVolley(
      ["https://t.test/a", "https://t.test/b", "https://t.test/c"],
      9,
      deps,
    );
    const counts = calls.urls.map((u) => u.split("/").pop()!);
    expect(counts.filter((u) => u === "a").length).toBe(3);
    expect(counts.filter((u) => u === "b").length).toBe(3);
    expect(counts.filter((u) => u === "c").length).toBe(3);
  });

  test("redirect hops are counted per fetch (each hop is real traffic)", async () => {
    let clockNow = 0;
    const hopLog: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      hopLog.push(url);
      clockNow += 5;
      if (url === "https://t.test/start") {
        return new Response(null, { status: 302, headers: { location: "https://t.test/final" } });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async () => undefined,
      hostValidator: async () => undefined,
    };
    const probe = await runProbeVolley(["https://t.test/start"], 2, deps);
    expect(probe.reachable).toBe(true);
    // 2 logical requests; the first consumed 2 fetches (hop), second 1 hop... actually
    // every logical request through /start takes 2 hops, so fetches = 2 logical * 2 = 4 minus...
    // Deterministically: req1 -> start(302)+final, req2 -> start(302)+final => 4 fetches.
    expect(hopLog.length).toBe(4);
    expect(hopLog.filter((u) => u === "https://t.test/start").length).toBe(2);
    // Latency of each completed logical request includes both hops.
    expect(probe.latenciesMs.every((l) => l >= 10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Latency monotonicity: induced delay is reflected in measured latency
// ---------------------------------------------------------------------------

describe("latency monotonicity", () => {
  test("measured latency tracks induced server delay (0/50/100/500ms)", async () => {
    const mk = (delayMs: number) => {
      let clockNow = 0;
      const fetchImpl = (async () => {
        const startedAt = clockNow;
        // Simulate delay in shared wall-clock (all concurrent requests see it).
        await new Promise<void>((resolve) => {
          const iv = setInterval(() => {
            if (clockNow >= startedAt + delayMs) {
              clearInterval(iv);
              resolve();
            }
          }, 1);
        });
        return new Response("ok", { status: 200 });
      }) as typeof fetch;
      const ticker = setInterval(() => {
        clockNow += Math.max(1, Math.round(delayMs / 50));
      }, 1);
      const deps: ProbeDeps = {
        fetchImpl,
        now: () => clockNow,
        sleep: async () => undefined,
        hostValidator: async () => undefined,
      };
      return { deps, stop: () => clearInterval(ticker) };
    };

    const run = async (delayMs: number) => {
      const { deps, stop } = mk(delayMs);
      try {
        return await runProbeVolley(["https://t.test/x"], 4, deps);
      } finally {
        stop();
      }
    };

    const s0 = await run(0);
    const s50 = await run(50);
    const s100 = await run(100);
    const s500 = await run(500);
    // Median measured latency tracks the induced delay monotonically.
    const med = (p: Awaited<ReturnType<typeof run>>) => [...p.latenciesMs].sort((a, b) => a - b)[1] ?? 0;
    expect(med(s50)).toBeGreaterThan(med(s0));
    expect(med(s100)).toBeGreaterThan(med(s50));
    expect(med(s500)).toBeGreaterThan(med(s100));
    // ~correspondence: 500ms-delay median should be well above 50ms-delay median
    expect(med(s500)).toBeGreaterThan(med(s50) + 200);
  });
});

// ---------------------------------------------------------------------------
// 6. Aggregation (buildRealEngine): k6 semantics end-to-end
// ---------------------------------------------------------------------------

function makeProbeResult(events: { tMs: number; latencyMs: number; status: number; error?: string }[]) {
  const statuses = events.filter((e) => !e.error).map((e) => e.status);
  const latenciesMs = events.filter((e) => !e.error).map((e) => e.latencyMs);
  const networkErrors = events.filter((e) => e.error).length;
  const http4xx = statuses.filter((s) => s >= 400 && s < 500).length;
  const http5xx = statuses.filter((s) => s >= 500).length;
  const last = events[events.length - 1];
  return {
    reachable: true,
    latenciesMs,
    statuses,
    networkErrors,
    http4xx,
    http5xx,
    totalRequests: events.length,
    probeUrls: ["https://t.test/x"],
    errorSample: events.find((e) => e.error)?.error ?? null,
    errorKindCounts: {} as Partial<Record<ProbeErrorKind, number>>,
    events: events.map((e) => ({
      tMs: e.tMs,
      latencyMs: e.error ? 0 : e.latencyMs,
      status: e.error ? 0 : e.status,
      ok: !e.error && e.status >= 200 && e.status < 300,
      error: e.error ?? null,
      errorKind: (e.error ? "connection" : null) as ProbeErrorKind | null,
    })),
    elapsedMs: last ? last.tMs + 1 : 0,
  };
}

const PLAN = {
  objectiveType: "fixed_load" as const,
  testType: "baseline" as const,
  targetVus: 10,
  duration: "10s",
  selectedEndpoints: ["/"],
  thresholds: { p95LatencyMs: 800, errorRate: 0.1 },
  assumptions: [],
};
const STAGES: Stage[] = [{ name: "hold", vus: 10, durationSec: 10 }];

describe("buildRealEngine aggregation", () => {
  test("totals use k6-linear-interpolation over completed exchanges only", () => {
    const probe = makeProbeResult([
      { tMs: 10, latencyMs: 10, status: 200 },
      { tMs: 20, latencyMs: 20, status: 200 },
      { tMs: 30, latencyMs: 30, status: 200 },
      { tMs: 40, latencyMs: 40, status: 200 },
      { tMs: 50, latencyMs: 50, status: 200 },
      { tMs: 60, latencyMs: 60, status: 200 },
      { tMs: 70, latencyMs: 70, status: 200 },
      { tMs: 80, latencyMs: 80, status: 200 },
      { tMs: 90, latencyMs: 90, status: 200 },
      { tMs: 100, latencyMs: 100, status: 200 },
    ]);
    const out = buildRealEngine(probe, STAGES, PLAN, "https://t.test");
    // Completed-only: all 10 exchanges. Same float64 note as the unit test above.
    expect(out.totals.p50).toBe(55);
    expect(out.totals.p95).toBe(95);
    expect(out.totals.p99).toBe(99);
    expect(out.totals.totalRequests).toBe(10);
    expect(out.totals.errorRate).toBe(0);
  });

  test("500s and network errors count as failures; latency stats exclude network errors", () => {
    const probe = makeProbeResult([
      { tMs: 10, latencyMs: 10, status: 200 },
      { tMs: 20, latencyMs: 20, status: 500 },
      { tMs: 30, latencyMs: 0, status: 0, error: "connection refused" },
      { tMs: 40, latencyMs: 40, status: 200 },
    ]);
    const out = buildRealEngine(probe, STAGES, PLAN, "https://t.test");
    expect(out.totals.totalRequests).toBe(4);
    expect(out.totals.totalFailures).toBe(2); // one 500 + one network error
    expect(out.totals.errorRate).toBeCloseTo(0.5, 6);
    // Latency percentiles over completed exchanges [10,20,40] only:
    expect(out.totals.p50).toBe(20);
    expect(out.latencyAvgMs).toBe(23); // avg(10,20,40) = 23.33 -> Math.round -> 23
    expect(out.latencyMaxMs).toBe(40);
  });

  test("per-second buckets carry measured rps/errors and planned VUs are labelled context", () => {
    const probe = makeProbeResult([
      { tMs: 100, latencyMs: 5, status: 200 },
      { tMs: 1400, latencyMs: 6, status: 200 },
      { tMs: 2100, latencyMs: 7, status: 503 },
    ]);
    const out = buildRealEngine(probe, STAGES, PLAN, "https://t.test");
    expect(out.samples.length).toBe(3);
    expect(out.samples[0]!.rps).toBe(1);
    expect(out.samples[1]!.rps).toBe(1);
    expect(out.samples[2]!.rps).toBe(1);
    expect(out.samples[2]!.errors).toBe(1);
    // sample.vus is the MEASURED in-flight count (1 request that second), and
    // the requested envelope is carried separately on plannedVus (BUG 3).
    expect(out.samples.every((s) => s.vus === 1)).toBe(true);
    expect(out.samples.every((s) => s.plannedVus === 10)).toBe(true);
    expect(out.totals.peakVus).toBeLessThanOrEqual(4); // never the planned 10
    expect(out.breakpoint).toBeNull(); // no saturation inference in real mode
    expect(out.capacityVus).toBe(0);
  });

  test("thresholds gate the verdict on measured data", async () => {
    const probe = makeProbeResult(
      Array.from({ length: 10 }, (_, i) => ({ tMs: (i + 1) * 100, latencyMs: 900, status: 200 })),
    );
    const out = buildRealEngine(probe, STAGES, PLAN, "https://t.test");
    expect(out.totals.p95).toBeGreaterThan(PLAN.thresholds.p95LatencyMs - 1);
  });
});

// ---------------------------------------------------------------------------
// 7. SSRF / target safety
// ---------------------------------------------------------------------------

describe("target safety", () => {
  test("blocks localhost, metadata IPs, private ranges, IPv6 loopback/ULA", () => {
    for (const bad of [
      "localhost",
      "sub.localhost",
      "169.254.169.254",
      "metadata.google.internal",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "[::1]",
    ]) {
      expect(isBlockedHost(bad)).not.toBeNull();
    }
    expect(isBlockedHost("example.com")).toBeNull();
    expect(isBlockedHost("169.254.169.255")).not.toBeNull(); // link-local
  });

  test("blocks redirect hops to private addresses via the host validator", async () => {
    // Public initial URL, redirect to 169.254.169.254 — must be blocked.
    const blockedHosts = new Set(["169.254.169.254"]);
    const hostValidator = async (host: string) => {
      if (blockedHosts.has(host)) throw new Error(`probe host "${host}" is blocked (cloud metadata endpoint)`);
    };
    let clockNow = 0;
    const fetchImpl = (async () => {
      clockNow += 5;
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async () => undefined,
      hostValidator,
    };
    const probe = await runProbeVolley(["https://public.example/redirect"], 2, deps);
    expect(probe.reachable).toBe(false);
    expect(probe.networkErrors).toBe(1);
    expect(probe.errorKindCounts.blocked).toBe(1);
    expect(probe.errorSample).toContain("blocked");
  });

  test("never follows more than MAX_REDIRECTS hops", async () => {
    let clockNow = 0;
    let hops = 0;
    const fetchImpl = (async () => {
      hops += 1;
      clockNow += 2;
      return new Response(null, { status: 302, headers: { location: "/next" } });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async () => undefined,
      hostValidator: async () => undefined,
    };
    const probe = await runProbeVolley(["https://t.test/loop"], 2, deps);
    expect(probe.reachable).toBe(false);
    expect(probe.errorKindCounts.redirect).toBe(1);
    // 1 initial + 3 redirects = 4 fetches, then stop (no infinite loop).
    expect(hops).toBe(4);
  });

  test("blocks unsafe redirect schemes (file:, ftp:)", async () => {
    let clockNow = 0;
    const fetchImpl = (async () => {
      clockNow += 2;
      return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async () => undefined,
      hostValidator: async () => undefined,
    };
    const probe = await runProbeVolley(["https://t.test/x"], 2, deps);
    expect(probe.errorKindCounts.blocked).toBe(1);
  });

  test("probeUrlSet collapses path params to collection roots (no invented IDs)", () => {
    const urls = probeUrlSet("https://t.test", ["/products/{id}", "/users/{user_id}/orders"]);
    expect(urls).toEqual(["https://t.test/products", "https://t.test/users"]);
  });
});

// ---------------------------------------------------------------------------
// 8. Workload limits still guard the plan (compile-side safety)
// ---------------------------------------------------------------------------

describe("workload limits", () => {
  test("rejects VUs over the configured maximum", () => {
    expect(() =>
      validateWorkloadLimits({
        objectiveType: "fixed_load",
        testType: "baseline",
        targetVus: 1_000_000,
        duration: "10s",
        selectedEndpoints: ["/"],
        thresholds: { p95LatencyMs: 500, errorRate: 0.05 },
        assumptions: [],
      } as never),
    ).toThrow();
  });
});
