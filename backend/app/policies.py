"""Versioned policy identities (Phase 11).

Policies in this system are not just code — they are named, versioned
contracts that recorded results remain interpretable under. This module is
the single place the BACKEND's policy versions are declared; the Convex
control plane declares its own in src/convex/policies.ts (the regression
engine and AI layers live there) and the version manifest
(app/version_manifest.py) reports both planes' versions from these
constants.

RULE: bump a version string whenever the SEMANTICS of that policy change —
not when only wording/docs change. A historical result must remain
interpretable even after future policy changes; consumers may pin the
policy version a result was produced under instead of silently
reinterpreting it under the current one (e.g. regressionAnalyses stores
policy_version per row; boundary searches store their limits per search).

This module deliberately contains NO logic — the gates themselves
(workload_limits.py, threshold_evaluator.py, and the Convex
boundarySearchLogic.ts) are unchanged. Versioning an unsafe gate would not
make it safe; versioning exists so recorded evidence can name exactly
which rules produced it.
"""

# app/services/workload_limits.py — MAX_VUS / MAX_DURATION_S enforcement.
# v1: VU ceiling + planned-duration ceiling (fixed_load duration;
# boundary_search ramp+hold), rejected server-side before persistence.
WORKLOAD_LIMITS_POLICY_VERSION = "perforso.workload-limits.v1"

# Threshold semantics (app/services/k6_engine/threshold_evaluator.py).
# v1: PASS iff p95_ms <= p95_latency_ms AND error_rate <= error_rate;
# computed by the backend from k6's own extracted metrics (never read from
# k6's ambiguous per-metric verdict fields).
THRESHOLD_POLICY_VERSION = "perforso.threshold.v1"

# Deterministic adaptive boundary search — pure decision logic lives in the
# Convex control plane (src/convex/boundarySearchLogic.ts): monotonic
# boundary updates, rounded-midpoint candidate selection, stop conditions
# (tolerance / maximum experiments / safety ceiling / minimum floor /
# no-valid-candidate); EXECUTION_ERROR never moves a boundary and never
# becomes a FAIL.
BOUNDARY_SEARCH_POLICY_VERSION = "perforso.boundary-search.v1"

# Target SSRF policy (app/services/target_url_safety.py): fixed cloud-
# metadata blocklist; private/loopback allowed by default
# (TARGET_SSRF_POLICY=allow_private) for the documented local/demo scope.
TARGET_SSRF_POLICY_VERSION = "perforso.target-ssrf.v1"

ALL_POLICY_VERSIONS = {
    "workloadLimits": WORKLOAD_LIMITS_POLICY_VERSION,
    "threshold": THRESHOLD_POLICY_VERSION,
    "boundarySearch": BOUNDARY_SEARCH_POLICY_VERSION,
    "targetSsrf": TARGET_SSRF_POLICY_VERSION,
}
