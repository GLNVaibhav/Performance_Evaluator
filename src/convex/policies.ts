/**
 * Versioned policy identities — CONVEX CONTROL PLANE (Phase 11).
 *
 * The backend plane declares its versions in backend/app/policies.py; this
 * module is the control plane's mirror (regression, AI, boundary search,
 * workload limits as mirrored by boundarySearch.ts). The reproducibility
 * manifest (versionManifest.ts) reports both planes' versions from these
 * constants.
 *
 * RULE: bump a version string whenever the SEMANTICS of that policy
 * change. A historical result must remain interpretable after future
 * policy changes — regressionAnalyses rows store policyVersion per row
 * (never silently reinterpreted), AI documents store promptVersion, and
 * boundary searches freeze their limits per search.
 *
 * This module contains NO logic — the engines (regression/core.ts,
 * aiValidate.ts, boundarySearchLogic.ts) are unchanged.
 */

/** regression/core.ts — DEFAULT_REGRESSION_POLICY semantics. v1: latency
 * relative % (p50/p95/p99/avg/max, strictly-beyond +10%), rps relative %
 * (strictly-beyond −10%), error rate ABSOLUTE percentage points (+1pp). */
export const REGRESSION_POLICY_VERSION = "perforso.regression-policy.v1";

/** ai/validate.ts + regression/aiValidate.ts — the deterministic AI
 * validation discipline. v1: numeric registry (tolerance max(0.011, 0.15%),
 * ≤1000 integers exempt), endpoint existence, root-cause rejection,
 * capacity-claim rejection, quality-word rejection, classification/status
 * override rejection, OBSERVED-requires-evidence. */
export const AI_VALIDATION_POLICY_VERSION = "perforso.ai-validation.v1";

/** ai/evidence.ts + regression/aiEvidence.ts — the evidence registry /
 * evidence key schema handed to (and enforced on) the model. */
export const AI_EVIDENCE_POLICY_VERSION = "perforso.ai-evidence.v1";

/** The LLM system-prompt/schema identity for run & boundary-search
 * analyses (ai/evidence.ts PROMPT_VERSION). */
export const AI_PROMPT_VERSION_RUN = "perforso.ai-analyst.v1";

/** The LLM system-prompt/schema identity for regression interpretations
 * (regression/aiEvidence.ts REGRESSION_PROMPT_VERSION). */
export const AI_PROMPT_VERSION_REGRESSION = "perforso.regression-analyst.v1";

/** Deterministic adaptive boundary search decision rules
 * (boundarySearchLogic.ts). v1: monotonic boundary updates, rounded
 * midpoint selection, stop conditions, EXECUTION_ERROR never moves a
 * boundary and never becomes a FAIL. */
export const BOUNDARY_SEARCH_POLICY_VERSION = "perforso.boundary-search.v1";

/** Workload safety limits as mirrored/enforced in the control plane
 * (boundarySearch.ts creation validation + compiler.ts limits) — the
 * backend's MAX_VUS/MAX_DURATION_S remain authoritative; the control
 * plane can never raise them. */
export const WORKLOAD_LIMITS_POLICY_VERSION = "perforso.workload-limits.v1";

export const CONTROL_PLANE_POLICY_VERSIONS = {
  regression: REGRESSION_POLICY_VERSION,
  aiValidation: AI_VALIDATION_POLICY_VERSION,
  aiEvidence: AI_EVIDENCE_POLICY_VERSION,
  aiPromptRun: AI_PROMPT_VERSION_RUN,
  aiPromptRegression: AI_PROMPT_VERSION_REGRESSION,
  boundarySearch: BOUNDARY_SEARCH_POLICY_VERSION,
  workloadLimits: WORKLOAD_LIMITS_POLICY_VERSION,
} as const;
