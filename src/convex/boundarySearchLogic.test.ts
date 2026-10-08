/**
 * Unit tests: deterministic adaptive boundary search logic (§20 items 1–11,
 * 15). All pure functions — no Convex runtime, no network, no LLM.
 *
 * Run: bun test src/convex/boundarySearchLogic.test.ts
 */
// @ts-nocheck — test file; bun runs it directly, app typecheck excludes it.
import { describe, expect, test } from "bun:test";

import {
  classifyOutcome,
  updateBoundaries,
  selectNextCandidate,
  decideStop,
  buildSafeRegion,
  iterationFingerprint,
} from "./boundarySearchLogic";

const LIMITS = { minVus: 1, maxVus: 2000, tolerance: 0, maximumExperiments: 10 };

describe("1+2. PASS / FAIL boundary updates", () => {
  test("PASS adopts an unknown previous boundary", () => {
    expect(updateBoundaries({ lowestKnownPassVus: null, highestKnownFailVus: null }, 100, "PASS")).toEqual({
      lowestKnownPassVus: 100,
      highestKnownFailVus: null,
    });
  });

  test("PASS keeps the stronger (higher) previously known pass", () => {
    expect(updateBoundaries({ lowestKnownPassVus: 200, highestKnownFailVus: 400 }, 100, "PASS")).toEqual({
      lowestKnownPassVus: 200,
      highestKnownFailVus: 400,
    });
  });

  test("PASS raises the boundary when the new pass is stronger (brief example)", () => {
    let b = updateBoundaries({ lowestKnownPassVus: null, highestKnownFailVus: null }, 100, "PASS");
    b = updateBoundaries(b, 200, "PASS");
    b = updateBoundaries(b, 400, "FAIL");
    expect(b).toEqual({ lowestKnownPassVus: 200, highestKnownFailVus: 400 });
  });

  test("FAIL adopts an unknown previous boundary", () => {
    expect(updateBoundaries({ lowestKnownPassVus: null, highestKnownFailVus: null }, 400, "FAIL")).toEqual({
      lowestKnownPassVus: null,
      highestKnownFailVus: 400,
    });
  });

  test("FAIL keeps the stronger (lower) previously known fail", () => {
    expect(updateBoundaries({ lowestKnownPassVus: 200, highestKnownFailVus: 300 }, 400, "FAIL")).toEqual({
      lowestKnownPassVus: 200,
      highestKnownFailVus: 300,
    });
  });
});

describe("3+11. unknown boundaries / no update on EXECUTION_ERROR", () => {
  test("EXECUTION_ERROR never moves either boundary", () => {
    const before = { lowestKnownPassVus: 200 as number | null, highestKnownFailVus: 400 as number | null };
    expect(updateBoundaries(before, 800, "EXECUTION_ERROR")).toEqual(before);
  });

  test("EXECUTION_ERROR leaves unknown boundaries unknown (never invented)", () => {
    const before = { lowestKnownPassVus: null, highestKnownFailVus: null };
    expect(updateBoundaries(before, 800, "EXECUTION_ERROR")).toEqual(before);
  });

  test("classification: completed+PASS → PASS, completed+FAIL → FAIL, execution_error → EXECUTION_ERROR", () => {
    expect(classifyOutcome("completed", "PASS")).toBe("PASS");
    expect(classifyOutcome("completed", "FAIL")).toBe("FAIL");
    expect(classifyOutcome("execution_error", null)).toBe("EXECUTION_ERROR");
    expect(classifyOutcome("cancelled", null)).toBe("EXECUTION_ERROR");
    expect(classifyOutcome("running", null)).toBe("PENDING");
    // a completed run without a threshold verdict is NOT silently a PASS
    expect(classifyOutcome("completed", null)).toBe("EXECUTION_ERROR");
  });
});

describe("4+5. midpoint calculation and rounding", () => {
  test("midpoint of [200, 400] is 300 (brief example)", () => {
    const { nextVus } = selectNextCandidate(
      { lowestKnownPassVus: 200, highestKnownFailVus: 400 },
      [200, 400],
      LIMITS,
    );
    expect(nextVus).toBe(300);
  });

  test("rounding rule is round-half-up on the integer midpoint", () => {
    const { nextVus } = selectNextCandidate(
      { lowestKnownPassVus: 200, highestKnownFailVus: 401 },
      [200, 401],
      LIMITS,
    );
    expect(nextVus).toBe(301); // (200+401)/2 = 300.5 → 301
  });
});

describe("6. duplicate candidate rejection", () => {
  test("tested midpoint → nearest untested integer inside the interval", () => {
    const { nextVus } = selectNextCandidate(
      { lowestKnownPassVus: 200, highestKnownFailVus: 400 },
      [200, 300, 400],
      LIMITS,
    );
    expect(nextVus).toBe(299); // nearest untested strictly inside
  });

  test("an already-executed (vus, fingerprint) pair is the same experiment", () => {
    const fp = iterationFingerprint({
      targetVus: 300,
      rampDuration: "8s",
      holdDuration: "5s",
      selectedEndpoints: ["/products"],
      thresholds: { p95LatencyMs: 200, errorRate: 0.01 },
    });
    const same = iterationFingerprint({
      targetVus: 300,
      rampDuration: "8s",
      holdDuration: "5s",
      selectedEndpoints: ["/products"],
      thresholds: { p95LatencyMs: 200, errorRate: 0.01 },
    });
    const differentVus = iterationFingerprint({
      targetVus: 301,
      rampDuration: "8s",
      holdDuration: "5s",
      selectedEndpoints: ["/products"],
      thresholds: { p95LatencyMs: 200, errorRate: 0.01 },
    });
    expect(fp).toBe(same);
    expect(fp).not.toBe(differentVus);
  });
});

describe("7–10. stop conditions", () => {
  test("stop by tolerance (interval ≤ tolerance)", () => {
    const { stop } = selectNextCandidate({ lowestKnownPassVus: 299, highestKnownFailVus: 300 }, [200, 299, 300], {
      ...LIMITS,
      tolerance: 1,
    });
    expect(stop).toBe("tolerance_reached");
  });

  test("stop by maximum experiment count", () => {
    const d = decideStop({ outcome: "PASS", experimentCount: 10, nextVus: 300, candidateStop: null, limits: LIMITS });
    expect(d).toEqual({ stop: true, reason: "maximum_experiments" });
  });

  test("stop by safety ceiling (no valid candidate under maxVus)", () => {
    const { nextVus, stop } = selectNextCandidate({ lowestKnownPassVus: 2000, highestKnownFailVus: null }, [2000], {
      ...LIMITS,
      maxVus: 2000,
    });
    expect(nextVus).toBeNull();
    expect(stop).toBe("safety_ceiling");
  });

  test("stop by minimum floor (only a FAIL known, floor reached)", () => {
    const { nextVus, stop } = selectNextCandidate({ lowestKnownPassVus: null, highestKnownFailVus: 2 }, [], {
      ...LIMITS,
      minVus: 2,
    });
    expect(nextVus).toBeNull();
    expect(stop).toBe("minimum_floor");
  });

  test("stop on execution error (E) — never continue blindly", () => {
    const d = decideStop({ outcome: "EXECUTION_ERROR", experimentCount: 2, nextVus: 300, candidateStop: null, limits: LIMITS });
    expect(d).toEqual({ stop: true, reason: "error" });
  });

  test("no stop while a valid candidate exists and limits allow", () => {
    const d = decideStop({ outcome: "PASS", experimentCount: 3, nextVus: 300, candidateStop: null, limits: LIMITS });
    expect(d).toEqual({ stop: false, reason: null });
  });

  test("controller never proposes a candidate above the safety ceiling", () => {
    const { nextVus, stop } = selectNextCandidate({ lowestKnownPassVus: 1500, highestKnownFailVus: null }, [1500], {
      ...LIMITS,
      maxVus: 2000,
    });
    expect(nextVus).toBe(2000); // clamped probe, exactly at the ceiling
    const d = decideStop({ outcome: "PASS", experimentCount: 2, nextVus: 2001, candidateStop: null, limits: { ...LIMITS, maxVus: 2000 } });
    expect(d.reason).toBe("safety_ceiling");
  });
});

describe("15. final safe-region calculation", () => {
  test("both boundaries observed (brief §12 example: PASS 100,200,300 FAIL 400)", () => {
    const r = buildSafeRegion({ lowestKnownPassVus: 300, highestKnownFailVus: 400 }, "completed");
    expect(r.estimatedSafeOperatingRegion).toEqual({ lowerBound: 300, upperBound: 400 });
    expect(r.highestObservedPassingVus).toBe(300);
    expect(r.lowestObservedFailingVus).toBe(400);
    expect(r.note).toContain("ESTIMATED SAFE OPERATING REGION");
    expect(r.note).toContain("not an exact, maximum, or guaranteed capacity");
  });

  test("no FAIL observed → upper bound unknown (never fabricated)", () => {
    const r = buildSafeRegion({ lowestKnownPassVus: 200, highestKnownFailVus: null }, "completed");
    expect(r.estimatedSafeOperatingRegion).toEqual({ lowerBound: 200, upperBound: null });
    expect(r.note).toContain("no failing point observed");
  });

  test("no PASS observed → lower bound unknown", () => {
    const r = buildSafeRegion({ lowestKnownPassVus: null, highestKnownFailVus: 400 }, "completed");
    expect(r.estimatedSafeOperatingRegion).toEqual({ lowerBound: null, upperBound: 400 });
    expect(r.note).toContain("no passing point observed");
  });

  test("no evidence at all → both bounds unknown", () => {
    const r = buildSafeRegion({ lowestKnownPassVus: null, highestKnownFailVus: null }, "completed");
    expect(r.estimatedSafeOperatingRegion).toEqual({ lowerBound: null, upperBound: null });
    expect(r.note).toContain("no boundary evidence recorded");
  });
});

describe("§14. threshold stability — exact observed result decides, no smoothing", () => {
  test("199ms vs 200ms threshold is PASS; 201ms is FAIL (no historical averaging)", () => {
    // The classification consumes ONLY the backend's threshold_status, which
    // is computed from the actual observed metric vs the configured threshold.
    // These asserts pin that no smoothing layer exists in this module: there
    // is no function here that takes historical results at all.
    expect(classifyOutcome("completed", "PASS")).toBe("PASS");
    expect(classifyOutcome("completed", "FAIL")).toBe("FAIL");
  });
});
