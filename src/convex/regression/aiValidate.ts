/**
 * PERFORMANCE REGRESSION INTELLIGENCE — AI VALIDATION LAYER (Phase 10).
 *
 * The LLM's regression interpretation is never trusted. This pure module
 * validates the model output against the combined regression evidence and:
 *  - enforces the ROOT-CAUSE LANGUAGE RULES (§13): statements like "the
 *    database caused the regression" are rejected; "the candidate recorded
 *    higher latency for /products" is allowed;
 *  - FORBIDS modifying the deterministic layer: any statement that asserts a
 *    different classification/compatibility, or a delta value that does not
 *    exist in the numeric registry, is rejected;
 *  - keeps the Phase 9 numeric-registry discipline: every non-trivial number
 *    in a statement must exist in the recorded evidence.
 *
 * The deterministic regression object is never altered by this layer —
 * the model's rejected claims are recorded with reasons, and everything
 * that survives is interpretation only.
 */
import type { RegressionEvidence } from "./aiEvidence";

export type RegressionStatementClass = "OBSERVED" | "INFERRED" | "UNKNOWN";

export interface RegressionObservation {
  statement: string;
  classification: RegressionStatementClass;
  evidence: string[];
}

export interface ValidatedRegressionAnalysis {
  summary: string;
  whatChanged: RegressionObservation[];
  endpointObservations: (RegressionObservation & { endpoint: string })[];
  limitations: string[];
  confidenceNotes: string[];
  rejected: { reason: string; excerpt: string }[];
}

interface RawObservation {
  statement?: unknown;
  classification?: unknown;
  evidence?: unknown;
  endpoint?: unknown;
}

interface RawAnalysis {
  summary?: unknown;
  what_changed?: unknown;
  whatChanged?: unknown;
  endpoint_observations?: unknown;
  endpointObservations?: unknown;
  limitations?: unknown;
  confidence_notes?: unknown;
  confidenceNotes?: unknown;
}

// --- §13 root-cause language rules -------------------------------------------

/** Subsystem-vocabulary that may never be asserted as the CAUSE. */
const SUBSYSTEM_RE =
  /\b(database|db|cache|connection pool|worker pool|thread pool|cpu|memory|garbage collection|gc|lock|mutex|queue|disk|network stack|kernel|proxy|load balancer|dns|tls handshake|gc pause|jvm|vm|host|container)\b/i;

const ROOT_CAUSE_RE =
  /\b(caused by|caused the|cause[sd]? (?:of|the)|root cause(?:d)?(?: is| was| lies in)?|due to|because of|the cause is|stem(?:s|ming)? from|originates? (?:from|in)|bottleneck(?:ed)? (?:at|by|in)\b|explains? the (?:regression|latency|increase|change)|responsible for the regression)/i;

/** A subsystem mention is tolerated ONLY as a controlled demo condition restated. */
const DEMO_CONDITION_RE =
  /\b(controlled demo api (?:was|is) configured with|demo mode|controlled demo condition)\b/i;

/** Quality judgments the brief forbids (§6) — rejected as claims. */
const QUALITY_RE = /\b\b(good|bad|worse|better|improved|superior|inferior)\b/i;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function excerpt(text: string, pattern: RegExp, span = 70): string {
  const m = pattern.exec(text);
  if (!m || m.index === undefined) return text.slice(0, span);
  const start = Math.max(0, m.index - 12);
  return text.slice(start, m.index + m[0].length + span - 12).trim();
}

/** Registry check mirroring the Phase 9 validator's tolerance exactly. */
function numericClaimProblem(statement: string, numbers: Record<string, number>): string | null {
  const matches = statement.matchAll(/-?\d+(?:\.\d+)?/g);
  for (const m of matches) {
    const v = Number(m[0]);
    if (!Number.isFinite(v)) continue;
    if (v <= 1000 && Number.isInteger(v)) continue; // small integers (VU counts, status codes)
    const registered = Object.values(numbers).some(
      (n) => Math.abs(n - v) <= Math.max(0.011, Math.abs(v) * 0.0015),
    );
    if (!registered) {
      return `numeric value ${m[0]} not present in recorded evidence`;
    }
  }
  return null;
}

function classificationOf(raw: unknown): RegressionStatementClass | null {
  return typeof raw === "string" && ["OBSERVED", "INFERRED", "UNKNOWN"].includes(raw)
    ? (raw as RegressionStatementClass)
    : null;
}

function cleanRefs(raw: unknown, validKeys: Set<string>): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is string => typeof i === "string" && i.length <= 200 && validKeys.has(i));
}

function validateStatement(
  raw: RawObservation,
  evidence: RegressionEvidence,
  validKeys: Set<string>,
  rejected: { reason: string; excerpt: string }[],
  requireEndpoint: boolean,
): RegressionObservation | null {
  const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
  const classification = classificationOf(raw.classification);
  if (!statement || statement.length > 600) {
    if (statement) rejected.push({ reason: "statement exceeds 600 characters", excerpt: statement.slice(0, 70) });
    return null;
  }
  if (!classification) {
    rejected.push({ reason: "missing or invalid classification", excerpt: statement.slice(0, 80) });
    return null;
  }
  if (requireEndpoint) {
    const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : null;
    const known = evidence.deterministic.endpointResults.some((e) => e.endpoint === endpoint);
    if (!endpoint || !known) {
      rejected.push({
        reason: "nonexistent endpoint (endpoint-level regression rows exist only for endpoints present in both runs)",
        excerpt: typeof endpoint === "string" ? endpoint.slice(0, 60) : "(missing endpoint)",
      });
      return null;
    }
  }
  const refs = cleanRefs(raw.evidence, validKeys);
  if (classification === "OBSERVED" && refs.length === 0) {
    rejected.push({ reason: "OBSERVED statement without any valid evidence reference", excerpt: statement.slice(0, 80) });
    return null;
  }
  const numProblem = numericClaimProblem(statement, evidence.numbers);
  if (numProblem) {
    rejected.push({ reason: numProblem, excerpt: statement.slice(0, 80) });
    return null;
  }
  if (QUALITY_RE.test(statement)) {
    rejected.push({ reason: "subjective quality judgment (good/bad/better/worse is not a factual classification)", excerpt: excerpt(statement, QUALITY_RE) });
    return null;
  }
  if (SUBSYSTEM_RE.test(statement) && ROOT_CAUSE_RE.test(statement) && !DEMO_CONDITION_RE.test(statement)) {
    rejected.push({
      reason: "unsupported root-cause claim (§13: subsystem causality is not established by these measurements)",
      excerpt: excerpt(statement, ROOT_CAUSE_RE),
    });
    return null;
  }
  return { statement, classification, evidence: refs };
}

/** The summary is constrained like any statement but may survive with a fallback. */
function validateSummary(
  raw: unknown,
  evidence: RegressionEvidence,
  validKeys: Set<string>,
  rejected: { reason: string; excerpt: string }[],
): string {
  const det = evidence.deterministic;
  const fallback =
    det.status === "INCONCLUSIVE"
      ? `Regression comparison is INCONCLUSIVE (${det.compatibility}${det.compatibilityReasons.length ? `: ${det.compatibilityReasons.join("; ")}` : ""}).`
      : det.compatibility === "COMPATIBLE"
        ? `Deterministic regression analysis: ${det.status.replace(/_/g, " ").toLowerCase()}; policy ${det.policyVersion}.`
        : `Runs are incompatible; no regression comparison was performed.`;
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const statement = raw.trim();
  if (statement.length > 800) {
    rejected.push({ reason: "summary exceeds 800 characters", excerpt: statement.slice(0, 70) });
    return fallback;
  }
  if (numericClaimProblem(statement, evidence.numbers)) {
    rejected.push({ reason: "summary contains a numeric claim not present in recorded evidence", excerpt: statement.slice(0, 80) });
    return fallback;
  }
  if (SUBSYSTEM_RE.test(statement) && ROOT_CAUSE_RE.test(statement) && !DEMO_CONDITION_RE.test(statement)) {
    rejected.push({ reason: "unsupported root-cause claim (§13)", excerpt: excerpt(statement, ROOT_CAUSE_RE) });
    return fallback;
  }
  if (QUALITY_RE.test(statement)) {
    rejected.push({ reason: "subjective quality judgment in summary", excerpt: excerpt(statement, QUALITY_RE) });
    return fallback;
  }
  void validKeys;
  return statement;
}

export function validateRegressionAnalysis(
  raw: unknown,
  evidence: RegressionEvidence,
): ValidatedRegressionAnalysis {
  const rejected: { reason: string; excerpt: string }[] = [];
  const validKeys = new Set(evidence.evidenceKeys);
  const det = evidence.deterministic;

  if (!isObject(raw)) {
    return {
      summary: "AI regression interpretation unavailable (model returned malformed output).",
      whatChanged: [],
      endpointObservations: [],
      limitations: [...evidence.limitations, "The model's response failed validation."],
      confidenceNotes: [],
      rejected: [{ reason: "malformed response (not a JSON object)", excerpt: "(entire response)" }],
    };
  }
  const r = raw as RawAnalysis;

  const summary = validateSummary(r.summary, evidence, validKeys, rejected);

  const whatChanged: RegressionObservation[] = [];
  const rawChanged = Array.isArray(r.what_changed) ? r.what_changed : Array.isArray(r.whatChanged) ? r.whatChanged : [];
  for (const item of rawChanged) {
    if (!isObject(item)) continue;
    const obs = validateStatement(item as RawObservation, evidence, validKeys, rejected, false);
    if (obs) whatChanged.push(obs);
  }

  const endpointObservations: (RegressionObservation & { endpoint: string })[] = [];
  const rawEndpoints = Array.isArray(r.endpoint_observations)
    ? r.endpoint_observations
    : Array.isArray(r.endpointObservations)
      ? r.endpointObservations
      : [];
  for (const item of rawEndpoints) {
    if (!isObject(item)) continue;
    const obs = validateStatement(item as RawObservation, evidence, validKeys, rejected, true);
    if (obs) endpointObservations.push({ ...obs, endpoint: (item as { endpoint: string }).endpoint });
  }

  // Guard against classification/compatibility override attempts phrased as
  // statements: any statement claiming a status label NOT equal to the
  // deterministic one is dropped (restating the deterministic status is fine).
  const statusWords: RegExp =
    /\b(NO_REGRESSION_DETECTED|LATENCY_REGRESSION|ERROR_RATE_REGRESSION|THROUGHPUT_REGRESSION|MULTIPLE_REGRESSIONS|INCONCLUSIVE|COMPATIBLE|INCOMPATIBLE)\b/;
  const allowStatus = (statement: string, rejectedList: { reason: string; excerpt: string }[]): boolean => {
    const m = statusWords.exec(statement);
    if (!m) return true;
    const claimed = m[0];
    const detAllows = statement.includes(`status ${claimed}`) || statement.includes(`classification ${claimed}`) || statement.includes(`is ${claimed}`);
    if (claimed === det.status || claimed === det.compatibility) return true;
    if (detAllows && (claimed === det.status || claimed === det.compatibility)) return true;
    rejectedList.push({
      reason: `statement asserts regression status "${claimed}" which contradicts the deterministic classification "${det.status}"`,
      excerpt: statement.slice(0, 80),
    });
    return false;
  };
  const filteredWhatChanged = whatChanged.filter((o) => allowStatus(o.statement, rejected));

  const limitations = Array.isArray(r.limitations)
    ? r.limitations.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 400).slice(0, 8)
    : [];
  const confidenceNotes = Array.isArray(r.confidence_notes)
    ? r.confidence_notes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
    : Array.isArray(r.confidenceNotes)
      ? r.confidenceNotes.filter((l): l is string => typeof l === "string" && l.length > 0 && l.length <= 300).slice(0, 6)
      : [];

  return {
    summary,
    whatChanged: filteredWhatChanged,
    endpointObservations,
    limitations: [...new Set([...evidence.limitations, ...limitations])],
    confidenceNotes,
    rejected,
  };
}
