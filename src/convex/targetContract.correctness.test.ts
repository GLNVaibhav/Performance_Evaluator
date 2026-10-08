/**
 * Product-correctness regression tests — the youtube.com /checkout incident.
 *
 * Covers the 7 required cases:
 *   1. unknown endpoint          → NEEDS_CLARIFICATION / refused, never executed
 *   2. verified endpoint         → READY, verification recorded as verified
 *   3. arbitrary website, no API contract → no invented application endpoints
 *   4. 404/4xx response          → "path not established", never "endpoint failing"
 *   5. bounded probe             → 30 requests, ≤4 in flight, no capacity claims
 *   6. requested VUs > actual probe concurrency → sample.vus honest, envelope separate
 *   7. analyzer evidence vs hypothesis → OBSERVED/UNKNOWN/UNSUPPORTED, no subsystem claims
 *
 * Run: bun test src/convex/targetContract.correctness.test.ts
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, expect, test } from "bun:test";

import { ENDPOINT_PATTERN, compileIntent } from "./compiler";
import { interpret } from "./interpreter";
import {
  compileIntentWithTargetContract,
  verifyTargetEndpoints,
  classifyTarget,
  endpointVerificationSummary,
  DEMO_API_ENDPOINTS,
} from "./targetContract";
import { buildRealEngine, verdictLabel } from "./realEngine";
import { runProbeVolley, probeUrlSet } from "./probe";
import type { ProbeDeps, ProbeErrorKind } from "./probe";
import { analyze } from "./analyzer";
import type { EngineTotals } from "./engine";
import type { Stage } from "./engine";

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** Deterministic fake transport for verification GETs and probes. */
function fetchFor(
  routes: Record<string, { status?: number; refuse?: boolean; location?: string }>,
): { deps: ProbeDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ProbeDeps = {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url] ?? routes["*"] ?? {};
      if (route.refuse) throw new Error("fetch failed: ECONNREFUSED");
      const headers = route.location ? { location: route.location } : undefined;
      return new Response("ok", { status: route.status ?? 200, headers });
    }) as typeof fetch,
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
    sleep: async () => undefined,
    hostValidator: async () => undefined,
  };
  return { deps, calls };
}

const STRESS_INTENT = {
  objective: "stress the site",
  testType: "stress" as const,
  loadProfile: { peakUsers: 300 },
  duration: undefined,
  targetScope: { endpoints: ["/checkout"] },
  successCriteria: {},
};

const SITE_ROOT_INTENT = {
  objective: "test the site root",
  testType: "stress" as const,
  loadProfile: { peakUsers: 300 },
  duration: undefined,
  targetScope: { endpoints: ["/"] },
  successCriteria: {},
};

function makeTotals(over: Partial<EngineTotals> = {}): EngineTotals {
  return {
    totalRequests: 30,
    totalFailures: 30,
    errorRate: 1,
    p50: 120,
    p95: 340,
    p99: 610,
    maxRps: 18,
    peakVus: 4,
    iterations: 30,
    ...over,
  };
}

function makeProbeResult(events: { tMs: number; latencyMs: number; status: number; error?: string }[], maxInFlight = 4) {
  const statuses = events.filter((e) => !e.error).map((e) => e.status);
  const latenciesMs = events.filter((e) => !e.error).map((e) => e.latencyMs);
  const networkErrors = events.filter((e) => e.error).length;
  const last = events[events.length - 1];
  return {
    reachable: true,
    latenciesMs,
    statuses,
    networkErrors,
    http4xx: statuses.filter((s) => s >= 400 && s < 500).length,
    http5xx: statuses.filter((s) => s >= 500).length,
    totalRequests: events.length,
    probeUrls: ["https://www.youtube.com/checkout"],
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
    maxInFlight,
  };
}

// ---------------------------------------------------------------------------
// 1. Unknown endpoint: never accepted without verification
// ---------------------------------------------------------------------------

describe("case 1: unknown endpoint", () => {
  test("interpreter no longer whitelists demo routes for arbitrary targets (LLM-shaped output)", async () => {
    // Reproduce the incident: an LLM "suggests" /checkout for a website.
    // The sanitizer must keep it as a SUGGESTION (structurally valid), and the
    // target-contract gate — not the old global allowlist — decides its fate.
    const mod = await import("./interpreter");
    const outcome = await mod.interpret("stress https://www.youtube.com up to 300 users");
    // With no LLM key in tests the deterministic interpreter runs; either way
    // a URL-bearing request must default to the site root, not /products.
    if (outcome.intent?.targetScope?.endpoints?.length) {
      expect(outcome.intent.targetScope.endpoints).toEqual(["/"]);
    }
  });

  test("unverified endpoint on an arbitrary URL → NEEDS_CLARIFICATION (compile gate)", async () => {
    const { deps } = fetchFor({ "https://t.test/checkout": { status: 404 } });
    const result = await compileIntentWithTargetContract(STRESS_INTENT, "https://t.test", deps);
    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(result.rejectionCode).toBe("unverified_endpoints");
    expect(result.clarificationsNeeded[0]!.question).toContain("/checkout");
    expect(result.plan).toBeUndefined();
  });

  test("contract gate refuses demo-API paths for non-demo hosts", async () => {
    expect(DEMO_API_ENDPOINTS).toContain("/checkout");
    const { deps } = fetchFor({ "https://t.test/checkout": { status: 404 } });
    const result = await compileIntentWithTargetContract(STRESS_INTENT, "https://t.test", deps);
    expect(result.status).not.toBe("READY");
  });
});

// ---------------------------------------------------------------------------
// 2. Verified endpoint: plan proceeds and records verification
// ---------------------------------------------------------------------------

describe("case 2: verified endpoint", () => {
  test("endpoint that answers 2xx/3xx verifies → READY", async () => {
    const { deps } = fetchFor({ "https://t.test/api/items": { status: 200 } });
    const result = await compileIntentWithTargetContract(
      { ...STRESS_INTENT, targetScope: { endpoints: ["/api/items"] } },
      "https://t.test",
      deps,
    );
    expect(result.status).toBe("READY");
    expect(result.plan!.selectedEndpoints).toEqual(["/api/items"]);
    expect(result.targetContract!.verifications[0]).toMatchObject({ endpoint: "/api/items", verified: true });
  });

  test("3xx with Location counts as verified (resource exists)", async () => {
    const { deps } = fetchFor({ "https://t.test/api/items": { status: 301, location: "/api/items-v2" } });
    const result = await verifyTargetEndpoints("https://t.test", ["/api/items"], deps);
    expect(result.verifications[0]!.verified).toBe(true);
  });

  test("site root '/' never needs verification", async () => {
    const { deps, calls } = fetchFor({});
    const result = await verifyTargetEndpoints("https://t.test", ["/"], deps);
    expect(result.verifications).toEqual([]);
    expect(calls).toEqual([]); // no GET spent on the root
    expect(result.allVerified).toBe(true);
  });

  test("demo host: contract routes verified without network", async () => {
    const { deps, calls } = fetchFor({});
    const result = await verifyTargetEndpoints("http://127.0.0.1:8080", ["/checkout"], deps);
    expect(result.targetClass).toBe("contract_api");
    expect(result.verifications[0]!.verified).toBe(true);
    expect(calls).toEqual([]); // by contract, not by GET
  });
});

// ---------------------------------------------------------------------------
// 3. Arbitrary website with no API contract
// ---------------------------------------------------------------------------

describe("case 3: arbitrary website with no API contract", () => {
  test("classifyTarget: only demo hosts are contract_api", () => {
    expect(classifyTarget("http://127.0.0.1:8080")).toBe("contract_api");
    expect(classifyTarget("http://localhost:8080")).toBe("contract_api");
    expect(classifyTarget("https://www.youtube.com")).toBe("arbitrary_url");
    expect(classifyTarget("https://example.com")).toBe("arbitrary_url");
    expect(classifyTarget("not a url")).toBe("arbitrary_url");
  });

  test("URL-bearing requests default to the site root — no invented routes", async () => {
    const outcome = await interpret("Stress https://www.youtube.com up to 300 users — find the breaking point");
    expect(outcome.intent?.targetScope?.endpoints).toEqual(["/"]);
    expect(outcome.intent?.targetScope?.endpoints).not.toContain("/checkout");
  });

  test("deterministic fallback never defaults to a demo route", async () => {
    const outcome = await interpret("stress test it up to 300 users");
    expect(outcome.intent?.targetScope?.endpoints).toEqual(["/"]);
  });

  test("plan against youtube.com compiles only with the site root", async () => {
    const { deps } = fetchFor({});
    const result = await compileIntentWithTargetContract(SITE_ROOT_INTENT, "https://www.youtube.com", deps);
    // The root is contract-free; nothing is invented. (The run would still be
    // a bounded probe — classification C in the target model.)
    expect(result.status).toBe("READY");
    expect(result.plan!.selectedEndpoints).toEqual(["/"]);
  });
});

// ---------------------------------------------------------------------------
// 4. 404/4xx: "path not established", never "a valid endpoint is failing"
// ---------------------------------------------------------------------------

describe("case 4: 404/4xx response semantics", () => {
  test("404 on verification GET → unverified with status recorded", async () => {
    const { deps } = fetchFor({ "https://t.test/checkout": { status: 404 } });
    const result = await verifyTargetEndpoints("https://t.test", ["/checkout"], deps);
    expect(result.verifications[0]).toMatchObject({ verified: false, status: 404 });
    expect(endpointVerificationSummary(result.verifications)).toContain("HTTP 404");
  });

  test("404 during a real probe still labels the run PROBE_THRESHOLD_FAIL — not a capacity verdict", () => {
    const probe = makeProbeResult(
      Array.from({ length: 30 }, (_, i) => ({ tMs: (i + 1) * 60, latencyMs: 150, status: 404 })),
    );
    const stages: Stage[] = [
      { name: "ramp", vus: 300, durationSec: 10 },
      { name: "hold", vus: 300, durationSec: 20 },
    ];
    const plan = {
      objectiveType: "boundary_search" as const,
      testType: "stress" as const,
      targetVus: 300,
      rampDuration: "10s",
      holdDuration: "20s",
      selectedEndpoints: ["/checkout"],
      thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
      assumptions: [],
    };
    const engine = buildRealEngine(probe, stages, plan, "https://www.youtube.com");
    // 100% failures → FAIL semantics, but the verdict label must carry the
    // probe qualifier and NEVER claim a capacity/stress/boundary result.
    expect(verdictLabel("real", "FAIL")).toBe("PROBE_THRESHOLD_FAIL");
    expect(verdictLabel("real", "PASS")).toBe("PROBE_THRESHOLD_PASS");
    expect(verdictLabel("simulation", "FAIL")).toBe("FAIL");
    // No saturation/boundary output exists in real mode.
    expect(engine.breakpoint).toBeNull();
    expect(engine.capacityVus).toBe(0);
  });

  test("analyzer never treats 4xx as evidence about a named subsystem", async () => {
    const res = await analyze({
      plan: {
        objectiveType: "boundary_search",
        testType: "stress",
        targetVus: 300,
        selectedEndpoints: ["/checkout"],
        thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
        assumptions: [],
      } as never,
      targetBaseUrl: "https://www.youtube.com",
      totals: makeTotals(),
      thresholdStatus: "FAIL",
      violations: ["error rate 100.00% exceeded threshold 5.00%"],
      breakpoint: null,
      capacityVus: 0,
      mode: "real",
      endpointsVerification: [{ endpoint: "/checkout", verified: false, status: 404, reason: "404" }],
      probe: {
        requests: 30,
        statuses: Array(30).fill(404),
        networkErrors: 0,
        probeUrls: ["https://www.youtube.com/checkout"],
        errorSample: null,
      },
    });
    // No LLM key in the test env → deterministic narrative. Even with a key,
    // unverified endpoints force the deterministic evidence-only narrative.
    const text = [res.summary, ...res.points].join(" ");
    expect(res.analyzer).toBe("deterministic");
    expect(text).toContain("OBSERVED");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("UNSUPPORTED INFERENCE");
    expect(text).toContain("could not be established as a valid application/API operation");
    // No imperative remediation of a named subsystem: "misconfigured" may
    // appear ONLY inside the UNSUPPORTED INFERENCE disclaimer, never as an
    // instruction ("review/fix/check the X endpoint...").
    const unsupported = res.points.find((p) => p.startsWith("UNSUPPORTED")) ?? "";
    const withoutDisclaimer = text.replace(unsupported, "");
    expect(withoutDisclaimer).not.toMatch(/misconfigur/i);
    expect(text).not.toMatch(/review the|fix the|check the/i);
  });
});

// ---------------------------------------------------------------------------
// 5. Bounded probe semantics
// ---------------------------------------------------------------------------

describe("case 5: bounded probe", () => {
  test("30 requests, ≤4 in flight, honest elapsed window", async () => {
    let clockNow = 0;
    const inFlight = { n: 0, peak: 0 };
    const fetchImpl = (async () => {
      inFlight.n += 1;
      inFlight.peak = Math.max(inFlight.peak, inFlight.n);
      const startedAt = clockNow;
      await new Promise<void>((r) => setTimeout(r, 0));
      clockNow = Math.max(clockNow, startedAt + 40);
      inFlight.n -= 1;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const deps: ProbeDeps = {
      fetchImpl,
      now: () => clockNow,
      sleep: async (ms) => {
        clockNow += ms;
      },
      hostValidator: async () => undefined,
    };
    const probe = await runProbeVolley(["https://t.test/x"], 30, deps);
    expect(probe.totalRequests).toBe(30);
    expect(probe.maxInFlight).toBeLessThanOrEqual(4);
    expect(inFlight.peak).toBe(probe.maxInFlight);
    // Concurrency proof: burst members complete together, so distinct
    // completion timestamps (~1 initial + ~8 volleys) are far fewer than the
    // 30 requests; a sequential run would have 30 distinct completions.
    const completions = [...new Set(probe.events.map((e) => e.tMs))];
    expect(completions.length).toBeLessThanOrEqual(11);
    // Politeness gaps (≤200ms) + 9 delay windows bound the wall clock well
    // below the sequential equivalent (30 windows + the same gaps).
    expect(probe.elapsedMs).toBeLessThan(30 * 40 + 7 * 200);
  });

  test("verdict log states the requested envelope was NOT executed", () => {
    const probe = makeProbeResult([{ tMs: 100, latencyMs: 100, status: 200 }]);
    const plan = {
      objectiveType: "boundary_search" as const,
      testType: "stress" as const,
      targetVus: 300,
      rampDuration: "10s",
      holdDuration: "20s",
      selectedEndpoints: ["/"],
      thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
      assumptions: [],
    };
    const stages: Stage[] = [
      { name: "ramp", vus: 300, durationSec: 10 },
      { name: "hold", vus: 300, durationSec: 20 },
    ];
    const engine = buildRealEngine(probe, stages, plan, "https://t.test");
    const verdict = engine.log.find((l) => l.phase === "verdict")!.message;
    expect(verdict).toContain("NOT executed");
    expect(verdict).toContain("no saturation or capacity inference");
    expect(engine.breakpoint).toBeNull();
    expect(engine.capacityVus).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Requested VUs (300) vs actual probe concurrency (≤4)
// ---------------------------------------------------------------------------

describe("case 6: requested VUs vs actual probe concurrency", () => {
  const PLAN = {
    objectiveType: "boundary_search" as const,
    testType: "stress" as const,
    targetVus: 300,
    rampDuration: "10s",
    holdDuration: "20s",
    selectedEndpoints: ["/checkout"],
    thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
    assumptions: [],
  };
  const STAGES: Stage[] = [
    { name: "ramp", vus: 300, durationSec: 10 },
    { name: "hold", vus: 300, durationSec: 20 },
  ];

  test("sample.vus is the measured in-flight count; plannedVus carries the envelope", () => {
    // 2-second probe with 4 requests in second 1, 2 in second 2.
    const probe = makeProbeResult([
      { tMs: 100, latencyMs: 100, status: 200 },
      { tMs: 200, latencyMs: 100, status: 200 },
      { tMs: 300, latencyMs: 100, status: 200 },
      { tMs: 400, latencyMs: 100, status: 200 },
      { tMs: 1100, latencyMs: 100, status: 404 },
      { tMs: 1200, latencyMs: 100, status: 404 },
    ]);
    const engine = buildRealEngine(probe, STAGES, PLAN, "https://www.youtube.com");
    expect(engine.samples[0]!.vus).toBe(4); // measured, not 300
    expect(engine.samples[1]!.vus).toBe(2);
    expect(engine.samples.every((s) => s.plannedVus > 0 && s.plannedVus <= 300)).toBe(true);
    // Totals peak is the measured figure, never the planned 300.
    expect(engine.totals.peakVus).toBeLessThanOrEqual(4);
    expect(engine.measuredPeakConcurrent).toBeLessThanOrEqual(4);
  });

  test("metrics.peakVus never reports the requested envelope in real mode", () => {
    const probe = makeProbeResult(
      Array.from({ length: 30 }, (_, i) => ({ tMs: (i + 1) * 60, latencyMs: 120, status: 404 })),
      4,
    );
    const engine = buildRealEngine(probe, STAGES, PLAN, "https://www.youtube.com");
    expect(engine.totals.peakVus).toBe(4);
    expect(PLAN.targetVus).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 7. Analyzer: evidence vs hypothesis
// ---------------------------------------------------------------------------

describe("case 7: analyzer evidence vs hypothesis", () => {
  test("unverified endpoints → OBSERVED/UNKNOWN/UNSUPPORTED structure, no subsystem claims, LLM bypassed", async () => {
    const res = await analyze({
      plan: {
        objectiveType: "boundary_search",
        testType: "stress",
        targetVus: 300,
        selectedEndpoints: ["/checkout"],
        thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
        assumptions: [],
      } as never,
      targetBaseUrl: "https://www.youtube.com",
      totals: makeTotals(),
      thresholdStatus: "FAIL",
      violations: ["error rate 100.00% exceeded threshold 5.00%"],
      breakpoint: null,
      capacityVus: 0,
      mode: "real",
      endpointsVerification: [{ endpoint: "/checkout", verified: false, status: 404, reason: "404" }],
      probe: {
        requests: 30,
        statuses: Array(30).fill(404),
        networkErrors: 0,
        probeUrls: ["https://www.youtube.com/checkout"],
        errorSample: null,
      },
    });
    const text = [res.summary, ...res.points].join(" ");
    expect(res.analyzer).toBe("deterministic");
    expect(text).toContain("OBSERVED");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("UNSUPPORTED INFERENCE");
    expect(text).toContain("insufficient to infer application performance or capacity");
    // Forbidden inference may only be named in order to disclaim it.
    const unsupported = res.points.find((p) => p.startsWith("UNSUPPORTED")) ?? "";
    const withoutDisclaimer = text.replace(unsupported, "");
    expect(withoutDisclaimer).not.toMatch(/misconfigur|checkout subsystem/i);
    expect(text).not.toMatch(/review the|fix the|check the/i);
    expect(res.summary).toContain("Insufficient evidence for capacity/saturation inference");
  });

  test("analyzer prompt forbids subsystem inference and honors verification flags", () => {
    // The shipped prompt must contain the evidence rules (regression guard
    // against silently dropping the constraint).
    const src = Bun.file(new URL("./analyzer.ts", import.meta.url).pathname);
    return src.text().then((t) => {
      expect(t).toContain("EVIDENCE RULES");
      expect(t).toContain("FORBIDDEN");
      expect(t).toContain("endpointsVerification");
    });
  });

  test("verified endpoints keep the measured-evidence narrative (no downgrade)", async () => {
    const res = await analyze({
      plan: {
        objectiveType: "fixed_load",
        testType: "baseline",
        targetVus: 50,
        selectedEndpoints: ["/"],
        thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
        assumptions: [],
      } as never,
      targetBaseUrl: "https://t.test",
      totals: makeTotals({ totalRequests: 30, totalFailures: 0, errorRate: 0, peakVus: 4 }),
      thresholdStatus: "PASS",
      violations: [],
      breakpoint: null,
      capacityVus: 0,
      mode: "real",
      endpointsVerification: [{ endpoint: "/", verified: true, status: 200, reason: null }],
      probe: {
        requests: 30,
        statuses: Array(30).fill(200),
        networkErrors: 0,
        probeUrls: ["https://t.test/"],
        errorSample: null,
      },
    });
    const text = [res.summary, ...res.points].join(" ");
    expect(text).toContain("Measured 30 real requests");
    expect(text).not.toContain("OBSERVED:");
    expect(text).not.toContain("UNSUPPORTED INFERENCE");
  });

  test("simulation mode keeps full capacity semantics (k6 plane unchanged)", async () => {
    const res = await analyze({
      plan: {
        objectiveType: "boundary_search",
        testType: "stress",
        targetVus: 300,
        selectedEndpoints: ["/"],
        thresholds: { p95LatencyMs: 1000, errorRate: 0.05 },
        assumptions: [],
      } as never,
      targetBaseUrl: "http://127.0.0.1:8080",
      totals: makeTotals({
        totalRequests: 8400,
        totalFailures: 12,
        errorRate: 0.0014,
        p50: 55,
        p95: 130,
        p99: 310,
        maxRps: 380,
        peakVus: 300,
      }),
      thresholdStatus: "PASS",
      violations: [],
      breakpoint: { stage: "ramp", vus: 142 },
      capacityVus: 138,
      mode: "simulation",
      probe: null,
    });
    const text = [res.summary, ...res.points].join(" ");
    expect(text).toContain("Saturation begins around 142 VUs");
    expect(text).toContain("autoscale");
  });
});

// ---------------------------------------------------------------------------
// Cross-checks: contract shape & patterns
// ---------------------------------------------------------------------------

describe("contract shape", () => {
  test("endpoint syntax pattern is shared (compiler + contract layer)", () => {
    expect(ENDPOINT_PATTERN.test("/checkout")).toBe(true);
    expect(ENDPOINT_PATTERN.test("https://x")).toBe(false);
    expect(ENDPOINT_PATTERN.test("/products/{id}")).toBe(true);
  });

  test("probeUrlSet keeps verification GETs on the target host", () => {
    expect(probeUrlSet("https://t.test", ["/checkout"])).toEqual(["https://t.test/checkout"]);
  });
});
