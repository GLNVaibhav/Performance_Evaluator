/**
 * AI Performance Intelligence — deterministic VALIDATION LAYER (Phase 9).
 *
 * The LLM's structured output is never trusted: this pure module validates
 * every statement against the evidence registry built from stored records
 * and rejects/sanitizes unsupported claims BEFORE anything is persisted.
 * The stored deterministic TestResult / boundary state is never touched.
 *
 * Validation rules (§16 of the phase brief):
 *  - schema conformance (shape, classification enum, types)
 *  - every numeric claim must exist in the evidence registry
 *  - no nonexistent metrics / endpoints / runs / iterations
 *  - root-cause discipline: subsystem-cause claims are rejected
 *  - capacity claims are rejected
 *  - PASS/FAIL and boundary values may only be restated, never altered
 *
 * The deterministic TestResult remains authoritative; analysis is advisory.
 */

import type { Evidence, RunEvidence, SearchEvidence } from "./evidence";

export type Classification = "OBSERVED" | "INFERRED" | "UNKNOWN";

export interface AiObservation {
  statement: string;
  classification: Classification;
  evidence: string[];
}

export interface ValidatedAnalysis {
  summary: string;
  observations: AiObservation[];
  thresholdAssessment: { status: string; evidence: string[] };
  endpointObservations: (AiObservation & { endpoint: string })[];
  boundaryAssessment: {
    highestObservedPass: number | null;
    lowestObservedFail: number | null;
    estimatedSafeOperatingRegion: { lowerBound: number | null; upperBound: number | null } | null;
  };
  limitations: string[];
  confidenceNotes: string[];
  rejected: { reason: string; excerpt: string }[];
}

interface RawObservation {
  statement?: unknown;
  classification?: unknown;
  evidence?: unknown;
}

interface RawAnalysis {
  summary?: unknown;
  observations?: unknown;
  threshold_assessment?: unknown;
  thresholdAssessment?: unknown;
  endpoint_observations?: unknown;
  endpointObservations?: unknown;
  boundary_assessment?: unknown;
  boundaryAssessment?: unknown;
  limitations?: unknown;
  confidence_notes?: unknown;
  confidenceNotes?: unknown;
}

const CLASSIFICATIONS: Classification[] = ["OBSERVED", "INFERRED", "UNKNOWN"];

// --- claim-pattern rules -----------------------------------------------------

/** Subsystem/root-cause vocabulary that may NEVER appear as a causal claim. */
const SUBSYSTEM_RE =
  /\b(database|db|cache|connection pool|worker|thread|cpu|memory|garbage collection|gc|lock|mutex|queue|disk|network stack|kernel|proxy|load balancer|dns|tls handshake|kernel)\b/i;

const ROOT_CAUSE_RE =
  /\b(caused by|caused the|cause[sd]? (?:of|the)|root cause(?:d)?(?: is| was| lies in)?|due to|because of|the cause is|stem(?:s|ming)? from|originates? (?:from|in)|bottleneck(?:ed)? (?:at|by|in)\b|explains? the (?:regression|latency|increase|change)|responsible for the regression)/i;

/** Capacity/certainty claims that may NEVER appear. */
const CAPACITY_RE =
  /\b(exact(?:ly)? capacity|maximum capacity|guaranteed capacity|can (?:safely )?(?:handle|support) exactly|system capacity is|the system can handle|safe operating limit is|breaking point is|saturation point is)\b/i;

/** A root-cause statement is only tolerated if it explicitly references the
 * controlled demo condition as context (the configured mode), not as proof. */
const DEMO_CONDITION_RE =
  /\b(controlled demo api was configured with|demo mode|controlled demo condition)\b/i;

function excerpt(text: string, pattern: RegExp, span = 70): string {
  const m = pattern.exec(text);
  if (!m || m.index === undefined) return text.slice(0, span);
  const start = Math.max(0, m.index - 12);
  return text.slice(start, m.index + m[0].length + span - 12).trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function cleanRefs(raw: unknown, validKeys: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.length <= 200 && validKeys.has(item)) {
      out.push(item);
    }
    // Invalid/unknown references are silently dropped — statements that lose
    // ALL their references are rejected wholesale below (OBSERVED requires ≥1).
  }
  return out;
}

function classificationOf(raw: unknown): Classification | null {
  return typeof raw === "string" && (CLASSIFICATIONS as string[]).includes(raw) ? (raw as Classification) : null;
}

/** Reject statements whose numbers aren't in the registry. */
function numericClaimProblem(statement: string, numbers: Record<string, number>): string | null {
  const matches = statement.matchAll(/-?\d+(?:\.\d+)?/g);
  for (const m of matches) {
    const v = Number(m[0]);
    if (!Number.isFinite(v)) continue;
    if (v <= 1000 && Number.isInteger(v)) continue; // small integers (VU counts, codes, "2 experiments")
    const registered = Object.values(numbers).some(
      (n) => Math.abs(n - v) <= Math.max(0.011, Math.abs(v) * 0.0015),
    );
    if (!registered) {
      return `numeric value ${m[0]} not present in recorded evidence`;
    }
  }
  return null;
}

function validateObservation(
  raw: RawObservation,
  evidence: Evidence,
  validKeys: Set<string>,
  rejected: { reason: string; excerpt: string }[],
): AiObservation | null {
  const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
  const classification = classificationOf(raw.classification);
  if (!statement || statement.length > 600) {
    if (statement) rejected.push({ reason: "statement exceeds 600 characters", excerpt: excerpt(statement, /./) });
    return null;
  }
  if (!classification) {
    rejected.push({ reason: "missing or invalid classification", excerpt: statement.slice(0, 80) });
    return null;
  }
  const refs = cleanRefs(raw.evidence, validKeys);
  // OBSERVED requires a valid evidence reference.
  if (classification === "OBSERVED" && refs.length === 0) {
    rejected.push({ reason: "OBSERVED statement without any valid evidence reference", excerpt: statement.slice(0, 80) });
    return null;
  }
  // Numeric claims must trace to recorded values.
  const numProblem = numericClaimProblem(statement, evidence.numbers);
  if (numProblem) {
    rejected.push({ reason: numProblem, excerpt: statement.slice(0, 80) });
    return null;
  }
  // Capacity claims: always rejected.
  if (CAPACITY_RE.test(statement)) {
    rejected.push({ reason: "unsupported capacity/certainty claim", excerpt: excerpt(statement, CAPACITY_RE) });
    return null;
  }
  // Root-cause discipline: subsystem-causal claims rejected unless the
  // statement itself frames the condition as a controlled demo context.
  if (SUBSYSTEM_RE.test(statement) && ROOT_CAUSE_RE.test(statement) && !DEMO_CONDITION_RE.test(statement)) {
    rejected.push({ reason: "unsupported root-cause claim (subsystem causality is not established by these measurements)", excerpt: excerpt(statement, ROOT_CAUSE_RE) });
    return null;
  }
  return { statement, classification, evidence: refs };
}

// --- run analysis ------------------------------------------------------------

function validateRunAnalysis(raw: RawAnalysis, evidence: RunEvidence): ValidatedAnalysis {
  const rejected: { reason: string; excerpt: string }[] = [];
  const validKeys = new Set(evidence.evidenceKeys);
  const summary = typeof raw.summary === "string" && raw.summary.trim().length > 0 && raw.summary.length <= 800
    ? raw.summary.trim()
    : "AI analysis unavailable (model returned no usable summary).";

  const observations: AiObservation[] = [];
  if (Array.isArray(raw.observations)) {
    for (const item of raw.observations) {
      if (!isObject(item)) continue;
      const obs = validateObservation(item as RawObservation, evidence, validKeys, rejected);
      if (obs) observations.push(obs);
    }
  }

  // Threshold assessment: status must match the backend verdict verbatim.
  const rawThreshold = isObject(raw.threshold_assessment)
    ? raw.threshold_assessment
    : isObject(raw.thresholdAssessment)
      ? raw.thresholdAssessment
      : null;
  let thresholdAssessment = { status: "NOT_ASSESSED", evidence: [] as string[] };
  if (rawThreshold) {
    const status = typeof rawThreshold.status === "string" ? rawThreshold.status.toUpperCase() : "";
    if (evidence.thresholdStatus && status === evidence.thresholdStatus) {
      thresholdAssessment = {
        status: evidence.thresholdStatus,
        evidence: cleanRefs(rawThreshold.evidence, validKeys),
      };
    } else {
      rejected.push({
        reason: `threshold status "${status}" does not match the backend-authoritative verdict "${evidence.thresholdStatus ?? "none"}"`,
        excerpt: typeof rawThreshold.status === "string" ? status : "(missing)",
      });
    }
  }

  // Endpoint observations: endpoint must exist in the recorded per-endpoint evidence.
  const endpointObservations: (AiObservation & { endpoint: string })[] = [];
  const rawEndpoints = Array.isArray(raw.endpoint_observations)
    ? raw.endpoint_observations
    : Array.isArray(raw.endpointObservations)
      ? raw.endpointObservations
      : [];
  const knownEndpoints = new Set((evidence.externalMetrics?.perEndpoint ?? []).map((e) => e.endpoint));
  for (const item of rawEndpoints) {
    if (!isObject(item)) continue;
    const endpoint = typeof (item as RawObservation & { endpoint?: unknown }).endpoint === "string"
      ? (item as { endpoint: string }).endpoint
      : null;
    if (!endpoint || !knownEndpoints.has(endpoint)) {
      rejected.push({
        reason: "nonexistent endpoint",
        excerpt: typeof endpoint === "string" ? endpoint.slice(0, 60) : "(missing endpoint)",
      });
      continue;
    }
    const obs = validateObservation(item as RawObservation, evidence, validKeys, rejected);
    if (obs) endpointObservations.push({ ...obs, endpoint });
  }

  // Runs have no boundary assessment: reject an LLM-supplied one.
  if (isObject(raw.boundary_assessment) || isObject(raw.boundaryAssessment)) {
    const supplied = (raw.boundary_assessment ?? raw.boundaryAssessment) as Record<string, unknown>;
    const nonEmpty = Object.keys(supplied).some((k) => supplied[k] !== null && supplied[k] !== undefined);
    if (nonEmpty) {
      rejected.push({ reason: "boundary assessment supplied for a single-run analysis (no boundary evidence exists for a run)", excerpt: JSON.stringify(supplied).slice(0, 80) });
    }
  }

  const limitations = Array.isArray(raw.limitations)
    ? raw.limitations.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 400).slice(0, 8)
    : [];
  // Mandatory limitations (mode rules) are prepended, never dropped.
  const confidenceNotes = Array.isArray(raw.confidence_notes)
    ? raw.confidence_notes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
    : Array.isArray(raw.confidenceNotes)
      ? raw.confidenceNotes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
      : [];

  return {
    summary,
    observations,
    thresholdAssessment,
    endpointObservations,
    boundaryAssessment: { highestObservedPass: null, lowestObservedFail: null, estimatedSafeOperatingRegion: null },
    limitations: [...new Set([...evidence.limitations, ...limitations])],
    confidenceNotes,
    rejected,
  };
}

// --- boundary-search analysis ------------------------------------------------

function validateSearchAnalysis(raw: RawAnalysis, evidence: SearchEvidence): ValidatedAnalysis {
  const rejected: { reason: string; excerpt: string }[] = [];
  const validKeys = new Set(evidence.evidenceKeys);
  const summary = typeof raw.summary === "string" && raw.summary.trim().length > 0 && raw.summary.length <= 800
    ? raw.summary.trim()
    : "AI analysis unavailable (model returned no usable summary).";

  const observations: AiObservation[] = [];
  if (Array.isArray(raw.observations)) {
    for (const item of raw.observations) {
      if (!isObject(item)) continue;
      const obs = validateObservation(item as RawObservation, evidence, validKeys, rejected);
      if (obs) observations.push(obs);
    }
  }

  // Boundary assessment: values may only be RESTATED from the search state.
  const rawBoundary = isObject(raw.boundary_assessment)
    ? raw.boundary_assessment
    : isObject(raw.boundaryAssessment)
      ? raw.boundaryAssessment
      : null;
  let boundaryAssessment: ValidatedAnalysis["boundaryAssessment"] = {
    highestObservedPass: evidence.lowestKnownPassVus,
    lowestObservedFail: evidence.highestKnownFailVus,
    estimatedSafeOperatingRegion: evidence.result
      ? {
          lowerBound: evidence.result.lowerBound,
          upperBound: evidence.result.upperBound,
        }
      : null,
  };
  if (rawBoundary) {
    const pass = typeof rawBoundary.highest_observed_pass === "number"
      ? rawBoundary.highest_observed_pass
      : typeof rawBoundary.highestObservedPass === "number"
        ? rawBoundary.highestObservedPass
        : null;
    const failRaw = typeof rawBoundary.lowest_observed_fail === "number"
      ? rawBoundary.lowest_observed_fail
      : typeof rawBoundary.lowestObservedFail === "number"
        ? rawBoundary.lowestObservedFail
        : null;
    if (pass !== null && pass !== evidence.lowestKnownPassVus) {
      rejected.push({ reason: "altered boundary value (highest observed PASS)", excerpt: String(pass) });
    }
    if (failRaw !== null && failRaw !== evidence.highestKnownFailVus) {
      rejected.push({ reason: "altered boundary value (lowest observed FAIL)", excerpt: String(failRaw) });
    }
  }

  const limitations = Array.isArray(raw.limitations)
    ? raw.limitations.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 400).slice(0, 8)
    : [];
  const confidenceNotes = Array.isArray(raw.confidence_notes)
    ? raw.confidence_notes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
    : Array.isArray(raw.confidenceNotes)
      ? raw.confidenceNotes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
      : [];

  return {
    summary,
    observations,
    thresholdAssessment: { status: "NOT_ASSESSED", evidence: [] },
    endpointObservations: [],
    boundaryAssessment,
    limitations: [...new Set([...evidence.limitations, ...limitations])],
    confidenceNotes,
    rejected,
  };
}

// --- entry point -------------------------------------------------------------

export function validateAnalysis(raw: unknown, evidence: Evidence): ValidatedAnalysis {
  if (!isObject(raw)) {
    return {
      summary: "AI analysis unavailable (model returned malformed output).",
      observations: [],
      thresholdAssessment: { status: "NOT_ASSESSED", evidence: [] },
      endpointObservations: [],
      boundaryAssessment: { highestObservedPass: null, lowestObservedFail: null, estimatedSafeOperatingRegion: null },
      limitations: [...evidence.limitations, "The model's response failed validation."],
      confidenceNotes: [],
      rejected: [{ reason: "malformed response (not a JSON object)", excerpt: "(entire response)" }],
    };
  }
  return evidence.subject === "run"
    ? validateRunAnalysis(raw as RawAnalysis, evidence)
    : validateSearchAnalysis(raw as RawAnalysis, evidence);
}
