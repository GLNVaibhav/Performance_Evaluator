/**
 * Deterministic adaptive boundary search — PURE decision logic.
 *
 * Every function here is deterministic, side-effect-free, and unit-tested.
 * The Convex controller (boundarySearchController.ts) applies these decisions
 * to the database and executes each iteration through the EXISTING LIVE_K6
 * product path. NO LLM participates anywhere in this module: the next VU
 * level, PASS/FAIL classification, stop conditions, and safety limits are all
 * deterministic rules over recorded experiment outcomes.
 *
 * Terminology contract (mandatory): the output of a completed search is an
 * "estimated safe operating region" — NEVER "exact capacity", "maximum
 * capacity", or any claim stronger than what was actually observed.
 *
 * Reuses the EXISTING BoundarySearchPlan contract: every iteration compiles
 * to one valid plan (objective_type="boundary_search", single ramp+hold
 * scenario) and executes as one separate LIVE_K6 run. There is no multi-stage
 * ladder anywhere.
 */

// --- Outcome classification (§4) --------------------------------------------

export type IterationOutcome = "PASS" | "FAIL" | "EXECUTION_ERROR" | "PENDING";

/**
 * Classification from the authoritative backend threshold result.
 *  - PASS:  execution completed AND threshold_status === "PASS"
 *  - FAIL:  execution completed AND threshold_status === "FAIL"
 *  - EXECUTION_ERROR: k6 did not produce a valid performance result
 *    (execution_error / cancelled). An EXECUTION_ERROR is NOT a performance
 *    FAIL and must never move the PASS/FAIL boundaries.
 *  - PENDING: anything not yet terminal.
 */
export function classifyOutcome(status: string, thresholdStatus: string | null | undefined): IterationOutcome {
  if (status === "completed") {
    if (thresholdStatus === "PASS") return "PASS";
    if (thresholdStatus === "FAIL") return "FAIL";
    return "EXECUTION_ERROR";
  }
  if (status === "execution_error" || status === "cancelled") return "EXECUTION_ERROR";
  return "PENDING";
}

// --- Boundary updates (§6) ---------------------------------------------------

export type Boundary = number | null; // null = not yet observed (never invented)

export interface SearchBoundaries {
  lowestKnownPassVus: Boundary;
  highestKnownFailVus: Boundary;
}

/**
 * Update rules, monotonic by construction:
 *  - PASS  → lowest_known_pass = max(previous, current)   (never weaker)
 *  - FAIL  → highest_known_fail = min(previous, current)  (never weaker)
 *  - EXECUTION_ERROR → boundaries UNCHANGED.
 * Previous nulls (unknown) adopt the new observation.
 */
export function updateBoundaries(prev: SearchBoundaries, vus: number, outcome: IterationOutcome): SearchBoundaries {
  if (outcome === "PASS") {
    return {
      lowestKnownPassVus: prev.lowestKnownPassVus === null ? vus : Math.max(prev.lowestKnownPassVus, vus),
      highestKnownFailVus: prev.highestKnownFailVus,
    };
  }
  if (outcome === "FAIL") {
    return {
      lowestKnownPassVus: prev.lowestKnownPassVus,
      highestKnownFailVus: prev.highestKnownFailVus === null ? vus : Math.min(prev.highestKnownFailVus, vus),
    };
  }
  // EXECUTION_ERROR (and anything unexpected): no boundary movement.
  return { ...prev };
}

// --- Candidate selection (§5, §7, §9) ----------------------------------------

export interface SearchLimits {
  minVus: number;
  maxVus: number;
  tolerance: number;
  maximumExperiments: number;
}

export type StopReason =
  | "tolerance_reached"
  | "maximum_experiments"
  | "safety_ceiling"
  | "minimum_floor"
  | "no_valid_candidate"
  | null; // null = keep searching

/**
 * Deterministic next-VU selection.
 *
 *  - Both boundaries unknown → initial candidate = rangeFloor (the user's
 *    explicit lower bound; documented default — no invented heuristic).
 *  - Only one boundary known → probe toward the unknown side, clamped to
 *    [minVus, maxVus], without crossing a known boundary.
 *  - Both known → rounded midpoint of [lowestKnownPass, highestKnownFail];
 *    if the midpoint was already tested, the nearest UNTESTED integer inside
 *    the open interval (§7). If none exists → stop condition E.
 *
 * Rounding rule (documented, not arbitrary): round-half-up on the midpoint
 * integer dividend via Math.round((lo + hi) / 2).
 */
export function selectNextCandidate(
  boundaries: SearchBoundaries,
  testedVus: number[],
  limits: SearchLimits,
): { nextVus: number | null; stop: StopReason } {
  const { minVus, maxVus, tolerance } = limits;
  const tested = new Set(testedVus);

  const bothKnown = boundaries.lowestKnownPassVus !== null && boundaries.highestKnownFailVus !== null;

  // §9.A — interval within tolerance (only meaningful once both are known).
  if (bothKnown) {
    const lo = boundaries.lowestKnownPassVus as number;
    const hi = boundaries.highestKnownFailVus as number;
    if (hi - lo <= tolerance) return { nextVus: null, stop: "tolerance_reached" };
  }

  if (boundaries.lowestKnownPassVus === null && boundaries.highestKnownFailVus === null) {
    // §5 — initial experiment at the user's floor.
    const initial = Math.max(minVus, 1);
    if (initial > maxVus) return { nextVus: null, stop: "safety_ceiling" };
    return { nextVus: initial, stop: null };
  }

  if (boundaries.lowestKnownPassVus === null) {
    // Only a FAIL known: probe downward from the fail point.
    const fail = boundaries.highestKnownFailVus as number;
    const candidate = Math.max(minVus, Math.floor(fail / 2));
    if (candidate >= fail) {
      // No probe space below the failing point. If that emptiness is caused
      // by the minimum floor itself, the honest stop reason is the floor.
      return { nextVus: null, stop: minVus >= fail ? "minimum_floor" : "no_valid_candidate" };
    }
    if (tested.has(candidate)) {
      // nearest untested below the fail boundary
      for (let v = candidate - 1; v >= minVus; v -= 1) {
        if (v < fail) return { nextVus: v, stop: null };
      }
      return { nextVus: null, stop: "no_valid_candidate" };
    }
    return { nextVus: candidate, stop: null };
  }

  if (boundaries.highestKnownFailVus === null) {
    // Only a PASS known: probe upward, bounded by the safety ceiling.
    const pass = boundaries.lowestKnownPassVus as number;
    const candidate = pass * 2;
    if (candidate > maxVus) {
      // nothing above the current pass inside the ceiling → ceiling stop
      const upper = maxVus;
      if (upper <= pass) return { nextVus: null, stop: "safety_ceiling" };
      if (!tested.has(upper)) return { nextVus: upper, stop: null };
      for (let v = upper - 1; v > pass; v -= 1) {
        if (!tested.has(v)) return { nextVus: v, stop: null };
      }
      return { nextVus: null, stop: "safety_ceiling" };
    }
    if (tested.has(candidate)) {
      for (let v = candidate + 1; v <= maxVus; v += 1) {
        if (!tested.has(v)) return { nextVus: v, stop: null };
      }
      return { nextVus: null, stop: "safety_ceiling" };
    }
    return { nextVus: candidate, stop: null };
  }

  // Both known: midpoint inside [pass, fail].
  const lo = boundaries.lowestKnownPassVus as number;
  const hi = boundaries.highestKnownFailVus as number;
  if (hi <= lo) return { nextVus: null, stop: "no_valid_candidate" };

  const mid = Math.round((lo + hi) / 2);
  if (mid > lo && mid < hi && !tested.has(mid)) return { nextVus: mid, stop: null };

  // Midpoint tested (or not an integer strictly inside): nearest untested
  // integer strictly inside the interval, expanding outward from the midpoint.
  for (let d = 1; d < hi - lo; d += 1) {
    const down = mid - d;
    if (down > lo && !tested.has(down)) return { nextVus: down, stop: null };
    const up = mid + d;
    if (up < hi && !tested.has(up)) return { nextVus: up, stop: null };
  }
  return { nextVus: null, stop: "no_valid_candidate" };
}

// --- Stop conditions (§9) -----------------------------------------------------

export interface StopInput {
  outcome: IterationOutcome;
  experimentCount: number;
  nextVus: number | null;
  candidateStop: StopReason;
  limits: SearchLimits;
}

/**
 * Deterministic stop decision after each completed experiment.
 * The controller checks these BEFORE scheduling the next iteration and never
 * raises any safety limit to continue.
 */
export function decideStop(input: StopInput): { stop: boolean; reason: StopReason | "completed" | "error" } {
  const { outcome, experimentCount, nextVus, candidateStop, limits } = input;

  // §9.F — execution failure: do not continue blindly.
  if (outcome === "EXECUTION_ERROR") return { stop: true, reason: "error" };

  if (experimentCount >= limits.maximumExperiments) return { stop: true, reason: "maximum_experiments" };
  if (candidateStop === "tolerance_reached") return { stop: true, reason: "tolerance_reached" };
  if (candidateStop === "safety_ceiling") return { stop: true, reason: "safety_ceiling" };
  if (candidateStop === "minimum_floor") return { stop: true, reason: "minimum_floor" };
  if (candidateStop === "no_valid_candidate") return { stop: true, reason: "no_valid_candidate" };
  if (nextVus === null) return { stop: true, reason: "no_valid_candidate" };
  if (nextVus > limits.maxVus) return { stop: true, reason: "safety_ceiling" };
  return { stop: false, reason: null };
}

// --- Final result (§12) -------------------------------------------------------

export interface SafeRegion {
  status: "completed" | "error" | "blocked";
  estimatedSafeOperatingRegion: {
    lowerBound: number | null; // highest observed passing load
    upperBound: number | null; // lowest observed failing load; null = unknown
  };
  lowestObservedFailingVus: number | null;
  highestObservedPassingVus: number | null;
  note: string;
}

/**
 * §12 — never fabricates a missing boundary. The region is expressed exactly
 * as the evidence supports: bounds that were not observed stay null/unknown,
 * and the note states the terminology contract explicitly.
 */
export function buildSafeRegion(
  boundaries: SearchBoundaries,
  status: "completed" | "error" | "blocked",
): SafeRegion {
  const pass = boundaries.lowestKnownPassVus;
  const fail = boundaries.highestKnownFailVus;
  const parts: string[] = [];
  if (pass !== null) parts.push(`highest observed passing load: ${pass} VUs`);
  if (fail !== null) parts.push(`lowest observed failing load: ${fail} VUs`);
  if (pass !== null && fail !== null) {
    parts.push(`estimated safe operating region: ${pass}–${fail} VUs (within the tested range)`);
  } else if (pass !== null) {
    parts.push(`estimated safe operating region: ${pass} VUs and below, within the tested range (no failing point observed)`);
  } else if (fail !== null) {
    parts.push(`estimated safe operating region: unknown below ${fail} VUs (no passing point observed)`);
  } else {
    parts.push("no boundary evidence recorded");
  }
  return {
    status,
    estimatedSafeOperatingRegion: {
      lowerBound: pass,
      upperBound: fail,
    },
    lowestObservedFailingVus: fail,
    highestObservedPassingVus: pass,
    note: `This is an ESTIMATED SAFE OPERATING REGION derived only from observed experiments (${parts.join("; ")}). It is not an exact, maximum, or guaranteed capacity.`,
  };
}

// --- Plan fingerprint (§15) ----------------------------------------------------

/**
 * Deterministic fingerprint of an iteration's plan: target VUs + the exact
 * duration/threshold/endpoint shape. Two iterations with the same fingerprint
 * are the same experiment; the controller must never execute one twice
 * (idempotency) and must select the next candidate instead.
 */
export function iterationFingerprint(input: {
  targetVus: number;
  rampDuration: string;
  holdDuration: string;
  selectedEndpoints: string[];
  thresholds: { p95LatencyMs: number; errorRate: number };
}): string {
  const { targetVus, rampDuration, holdDuration, selectedEndpoints, thresholds } = input;
  return [
    `vus=${targetVus}`,
    `ramp=${rampDuration}`,
    `hold=${holdDuration}`,
    `eps=${[...selectedEndpoints].sort().join("|")}`,
    `p95=${thresholds.p95LatencyMs}`,
    `err=${thresholds.errorRate}`,
  ].join(";");
}
