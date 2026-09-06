from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from app.schemas.enums import Confidence, ObjectiveType, ResultClassification, Severity
from app.schemas.test_plan import TestPlan


class EndpointMetrics(BaseModel):
    """Per-endpoint breakdown for one TestPlan.selected_endpoints entry --
    same HTTP stat shape as MetricsSummary, scoped by a k6 request tag.
    Built ONLY from k6's own tagged --summary-export stats
    (app/services/k6_engine/metrics_parser.py); never estimated or
    back-derived from the aggregate. An endpoint that received zero real
    requests during the run is simply absent from
    MetricsSummary.per_endpoint rather than reported with fabricated
    zeroes -- see docs/performance_engine_interface.md "Amendment:
    endpoint mix + per-endpoint evidence"."""

    endpoint: str
    method: str
    total_requests: int
    p50_ms: float
    p95_ms: float
    p99_ms: float
    average_ms: float
    max_ms: float
    rps: float
    failed_requests: int
    error_rate: float = Field(ge=0, le=1)


class MetricsSummary(BaseModel):
    """Canonical MVP metrics contract. Values are whatever the performance
    engine computed (from k6's --summary-export) -- the backend never
    calculates percentiles/averages itself, only stores and serves them."""

    p50_ms: float
    # Additive (Session 5): Optional, unlike the required percentiles above
    # -- absent for a results.json predating k6_runner.py's expanded
    # --summary-trend-stats, never backfilled/estimated. See
    # app/services/k6_engine/metrics_parser.py's module docstring.
    p75_ms: Optional[float] = None
    p90_ms: Optional[float] = None
    p95_ms: float
    p99_ms: float
    average_ms: float
    max_ms: float
    rps: float
    total_requests: int
    failed_requests: int
    error_rate: float = Field(ge=0, le=1)
    duration_s: float
    # Additive: empty for any plan/engine that predates endpoint-mix
    # tagging, or for a single-endpoint plan's aggregate-equals-breakdown
    # case is still populated for consistency. Never required -- existing
    # callers constructing MetricsSummary() without this field are
    # unaffected (defaults to []).
    per_endpoint: List[EndpointMetrics] = Field(default_factory=list)
    # Additive (Session 5): {"200": 950, "404": 30, ...} -- ONLY statuses
    # actually observed (app/services/k6_engine/script_renderer.py's
    # recordHttpStatus() / metrics_parser.py's _extract_status_codes()).
    # Empty for a results.json predating this mechanism -- never a
    # hardcoded/guessed status list.
    status_codes: Dict[str, int] = Field(default_factory=dict)


class ThresholdViolation(BaseModel):
    """One deterministic threshold breach, derived (never estimated) by
    comparing already-computed metrics against the plan's own thresholds --
    see app/services/k6_engine/threshold_evaluator.py::localize_failures().
    `scope` is either the literal string "overall" or one of
    MetricsSummary.per_endpoint[].endpoint. This is derived evidence, not a
    root-cause claim: it says WHERE and WHICH threshold, never WHY."""

    scope: str
    metric: str
    observed: float
    threshold: float


class ArtifactRefs(BaseModel):
    """Paths to artifacts the engine already produces on disk for a
    COMPLETED run (app/services/k6_engine/k6_runner.py,
    app/services/k6_engine/engine.py). Each field is populated only if the
    file actually exists -- never a fabricated/guessed path."""

    script_path: Optional[str] = None
    results_json_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None


# ============================================================================
# Statistics / evidence layer (Session 5)
# ============================================================================
#
# EVERY field below either comes DIRECTLY from a real k6 measurement
# (MetricsSummary, itself sourced only from k6's --summary-export -- see
# metrics_parser.py) or is DETERMINISTICALLY DERIVED from one by plain
# arithmetic, in build_statistics() below. Nothing here is invented,
# estimated, or LLM-produced. No presentation strings (units, formatting,
# emoji) are embedded -- e.g. `p95_ms: 840`, never `"840 ms"` -- rendering
# is a later session's (terminal/frontend) concern.
#
# This is NOT a second source of truth: Statistics is never persisted on
# its own and never computed by the engine -- it is assembled fresh, on
# every GET /runs/{id}/result call, from the SAME persisted MetricsSummary
# that already existed (see routes_runs.py). MetricsSummary/EndpointMetrics
# remain the one canonical, persisted measurement record; Statistics is a
# derived, reorganized VIEW over it for terminal/frontend/AI consumption.


class LatencyStatistics(BaseModel):
    """p50/p95/p99/average/max are the same real k6-measured values already
    on MetricsSummary (never recomputed) -- duplicated here, not as a
    second source of truth, but because this is the stable, documented
    shape a frontend/terminal renders directly (Part J: `latency.p95_ms`,
    not a nested reach into `metrics.p95_ms`). p75/p90 are omitted (not
    `null`-padded) when the underlying results.json didn't collect them
    (see MetricsSummary.p75_ms's docstring) -- pydantic's `exclude_none`
    on serialization keeps a `null` from ever looking like "k6 reported
    zero-ish p75/p90"."""

    p50_ms: float
    p75_ms: Optional[float] = None
    p90_ms: Optional[float] = None
    p95_ms: float
    p99_ms: float
    average_ms: float
    max_ms: float
    # Derived: p99_ms / p50_ms -- a simple, real, mathematically meaningful
    # measure of tail-latency dispersion (how much worse the tail is than
    # the median). `None` when p50_ms is 0 (division undefined) -- never a
    # fabricated ratio.
    tail_latency_ratio: Optional[float] = None


class ThroughputStatistics(BaseModel):
    """`requests_per_second` is k6's OWN `http_reqs.rate` (MetricsSummary.rps),
    computed by k6 itself from its own internal timing -- never
    `total_requests / our_wall_clock_duration_s`, which would UNDERSTATE
    throughput (that wall-clock duration includes k6 process startup/
    teardown overhead outside the actual measured traffic window -- see
    docs/performance_engine_interface.md's "Statistics" section for the
    full reasoning). `requests_per_minute` is therefore derived as
    `requests_per_second * 60`, the one derivation that stays consistent
    with k6's own rate, not a second, differently-biased calculation."""

    total_requests: int
    requests_per_second: float
    requests_per_minute: float


class ErrorStatistics(BaseModel):
    """`failed_requests`/`error_rate` are the same real values already on
    MetricsSummary (`http_req_failed`-derived). `success_rate = 1 -
    error_rate` -- the one, single definition of "failure" this whole
    system uses (matching threshold_evaluator.py's own comparison), never
    a second, competing definition."""

    failed_requests: int
    error_rate: float = Field(ge=0, le=1)
    success_rate: float = Field(ge=0, le=1)


class StatusCodeStatistics(BaseModel):
    """`counts` is MetricsSummary.status_codes verbatim (only statuses
    actually observed). `percentages` is deterministically derived --
    `count / total_requests * 100` -- computed only when `total_requests >
    0`; both are empty `{}` (never a hardcoded/guessed status list) when
    the underlying results.json predates the status-code collection
    mechanism (see MetricsSummary.status_codes's docstring)."""

    counts: Dict[str, int] = Field(default_factory=dict)
    percentages: Dict[str, float] = Field(default_factory=dict)


class EndpointRankingEntry(BaseModel):
    """One row of a ranking -- `value`'s meaning is defined by which
    `EndpointRankings` list it appears in (see that model's field
    docstrings). Always sourced from a REAL `MetricsSummary.per_endpoint`
    entry -- never fabricated when evidence is insufficient (an empty
    `per_endpoint` list produces empty rankings, not invented rows)."""

    endpoint: str
    method: str
    value: float


class EndpointRankings(BaseModel):
    """Each list is `MetricsSummary.per_endpoint` SORTED descending by the
    named metric -- the full list, not an arbitrary top-N (truncating for
    display is a presentation decision left to a later session, per Part
    J: this model embeds no presentation choice). All four lists are `[]`
    together whenever `per_endpoint` is empty -- never a ranking computed
    from insufficient evidence."""

    highest_p95_latency: List[EndpointRankingEntry] = Field(default_factory=list)
    highest_error_rate: List[EndpointRankingEntry] = Field(default_factory=list)
    highest_request_volume: List[EndpointRankingEntry] = Field(default_factory=list)
    highest_failed_requests: List[EndpointRankingEntry] = Field(default_factory=list)


class EndpointShare(BaseModel):
    """Per-endpoint contribution to the aggregate totals -- both are plain
    ratios (0..1), matching the rest of this schema's convention
    (`error_rate`, `success_rate`) rather than a pre-multiplied
    percentage. `failure_share` is `None` when the run had zero total
    failed requests (division undefined, not zero-by-convention)."""

    endpoint: str
    method: str
    traffic_share: float = Field(ge=0, le=1)
    failure_share: Optional[float] = Field(default=None, ge=0, le=1)


class Statistics(BaseModel):
    """The canonical, evidence-grounded statistics section -- see this
    section's module-level comment for the sourcing/derivation rules every
    field here follows. Attached to TestResult additively (see below);
    never persisted separately (assembled fresh from MetricsSummary on
    every result fetch, so there is exactly one stored measurement record,
    not two)."""

    latency: LatencyStatistics
    throughput: ThroughputStatistics
    errors: ErrorStatistics
    status_codes: StatusCodeStatistics
    endpoint_rankings: EndpointRankings
    endpoint_shares: List[EndpointShare] = Field(default_factory=list)


def build_statistics(metrics: MetricsSummary) -> Statistics:
    """Pure function: MetricsSummary (already-persisted, real k6 evidence)
    -> Statistics (the derived, frontend-friendly view). No I/O, no
    randomness, no LLM -- same input always produces the same output.
    Called by routes_runs.py at result-fetch time, the same way `plan`/
    `artifacts`/`threshold_violations` are already assembled additively
    there -- see this module's "Statistics / evidence layer" comment for
    why this is not a second source of truth."""

    tail_latency_ratio = metrics.p99_ms / metrics.p50_ms if metrics.p50_ms > 0 else None
    latency = LatencyStatistics(
        p50_ms=metrics.p50_ms,
        p75_ms=metrics.p75_ms,
        p90_ms=metrics.p90_ms,
        p95_ms=metrics.p95_ms,
        p99_ms=metrics.p99_ms,
        average_ms=metrics.average_ms,
        max_ms=metrics.max_ms,
        tail_latency_ratio=tail_latency_ratio,
    )

    throughput = ThroughputStatistics(
        total_requests=metrics.total_requests,
        requests_per_second=metrics.rps,
        requests_per_minute=metrics.rps * 60,
    )

    errors = ErrorStatistics(
        failed_requests=metrics.failed_requests,
        error_rate=metrics.error_rate,
        success_rate=1.0 - metrics.error_rate,
    )

    status_code_percentages: Dict[str, float] = {}
    if metrics.total_requests > 0:
        status_code_percentages = {
            code: (count / metrics.total_requests) * 100 for code, count in metrics.status_codes.items()
        }
    status_codes = StatusCodeStatistics(counts=dict(metrics.status_codes), percentages=status_code_percentages)

    def _ranked(key, reverse: bool = True) -> List[EndpointRankingEntry]:
        return [
            EndpointRankingEntry(endpoint=e.endpoint, method=e.method, value=key(e))
            for e in sorted(metrics.per_endpoint, key=key, reverse=reverse)
        ]

    endpoint_rankings = EndpointRankings(
        highest_p95_latency=_ranked(lambda e: e.p95_ms),
        highest_error_rate=_ranked(lambda e: e.error_rate),
        highest_request_volume=_ranked(lambda e: e.total_requests),
        highest_failed_requests=_ranked(lambda e: e.failed_requests),
    )

    total_failed = metrics.failed_requests
    endpoint_shares = [
        EndpointShare(
            endpoint=e.endpoint,
            method=e.method,
            traffic_share=(e.total_requests / metrics.total_requests) if metrics.total_requests > 0 else 0.0,
            failure_share=(e.failed_requests / total_failed) if total_failed > 0 else None,
        )
        for e in metrics.per_endpoint
    ]

    return Statistics(
        latency=latency,
        throughput=throughput,
        errors=errors,
        status_codes=status_codes,
        endpoint_rankings=endpoint_rankings,
        endpoint_shares=endpoint_shares,
    )


# ============================================================================
# Failure localization (final session)
# ============================================================================
#
# Answers WHAT failed, WHERE, UNDER WHAT LOAD, WHICH threshold, and WHAT
# EVIDENCE supports it -- using ONLY data that already exists elsewhere
# (threshold_violations, MetricsSummary, TestPlan). Computes NO new
# statistic; it is a pure, deterministic REORGANIZATION of already-derived
# evidence, the same "assemble, don't recompute" discipline
# build_statistics() above already established.
#
# NOT root-cause detection: `primary_failure`/`evidence` say WHERE and
# WHICH threshold was crossed, using already-measured numbers -- never WHY
# (no infrastructure claim, e.g. "database locking").
#
# Lives in this file, not a separate module, specifically to avoid a
# circular import: FailureLocalization's `primary_failure`/`violations`
# fields are typed as the real `ThresholdViolation` class (a genuine
# Pydantic field type, not just a type-checking hint) -- a separate module
# importing that type back from here while this file imports
# FailureLocalization back from there would be circular. Co-locating it
# here (exactly where Statistics/build_statistics() already live) sidesteps
# that entirely.


class FailureEvidence(BaseModel):
    """The REAL measured numbers behind `primary_failure.scope` -- pulled
    from the already-computed `MetricsSummary` (aggregate, if scope is
    "overall", or the matching `EndpointMetrics` entry otherwise). Any
    field left `None`/empty simply means that evidence wasn't available
    for this scope (e.g. per-endpoint status codes are never collected --
    see this module's `status_codes` docstring on `MetricsSummary`) --
    never fabricated to fill the gap."""

    scope: str
    total_requests: Optional[int] = None
    error_rate: Optional[float] = None
    p95_ms: Optional[float] = None
    status_codes: Dict[str, int] = Field(default_factory=dict)


class LoadContext(BaseModel):
    """What workload actually produced this evidence -- read straight off
    the already-persisted `TestPlan`, never recomputed or guessed. `None`
    only if the plan itself is unavailable."""

    objective_type: Optional[str] = None
    test_type: Optional[str] = None
    target_vus: Optional[int] = None
    duration: Optional[str] = None
    selected_endpoints: List[str] = Field(default_factory=list)


class FailureLocalization(BaseModel):
    """`overall_status` mirrors `TestResult.threshold_status` verbatim --
    this module never recomputes or reinterprets PASS/FAIL
    (`threshold_evaluator.py` remains the sole authority). `violations` is
    `TestResult.threshold_violations` verbatim (authoritative -- never
    re-derived). `primary_failure` can be non-null even when
    `overall_status == PASS`: `threshold_evaluator.localize_failures()`
    checks the aggregate AND every per-endpoint entry independently, so a
    single slow/erroring endpoint can violate its own threshold even while
    the aggregate still passes -- that is real, useful, non-fabricated
    evidence (an early warning), not a contradiction, and is surfaced
    rather than suppressed."""

    overall_status: ResultClassification
    primary_failure: Optional[ThresholdViolation] = None
    violations: List[ThresholdViolation] = Field(default_factory=list)
    evidence: Optional[FailureEvidence] = None
    load_context: Optional[LoadContext] = None


# Deterministic, explainable metric-priority ranking for _primary_failure()
# below -- lower number = considered more severe when comparing violations
# of DIFFERENT metric types. Only two metrics exist today
# (threshold_evaluator.py checks exactly these two); an unrecognized
# future metric name sorts last (never crashes, never silently wins).
#
# Rationale (deliberately NOT a raw observed/threshold ratio comparison
# across metric types -- see this function's docstring for why that was
# rejected): a request that failed OUTRIGHT (error_rate) is a more severe
# failure mode than a request that merely completed slowly
# (p95_latency_ms), regardless of by how much either ratio was crossed.
# This is a simple, one-sentence-explainable, stable priority, not an
# attempt to make two different units "comparable" via an arbitrary ratio.
_METRIC_SEVERITY_RANK = {"error_rate": 0, "p95_latency_ms": 1}


def _primary_failure(violations: List[ThresholdViolation]) -> Optional[ThresholdViolation]:
    """Deterministic selection among possibly-multiple violations.

    Ranked, in order:
    1. Metric type, via `_METRIC_SEVERITY_RANK` above -- error_rate always
       outranks p95_latency_ms. This is the explainable, stable rule: it
       does NOT assume a latency-ms ratio and an error-rate ratio are
       meaningfully comparable numbers (they are not -- a 1.1x latency
       overage and a 1.1x error-rate overage are not "equally bad" in any
       principled sense, so no attempt is made to rank across metric
       types by ratio).
    2. WITHIN the same metric type, relative overage (`observed /
       threshold`) highest first -- ratios ARE meaningful to compare here,
       since the unit is identical. Division-by-zero-threshold guarded
       (treated as maximally severe, never a crash).
    3. A specific endpoint scope over the generic "overall" scope (more
       actionable for "WHERE").
    4. Alphabetically by scope, then by metric name.

    The same violations always produce the same choice -- never
    insertion-order-dependent."""
    if not violations:
        return None

    def _relative_overage(v: ThresholdViolation) -> float:
        return v.observed / v.threshold if v.threshold > 0 else float("inf")

    return sorted(
        violations,
        key=lambda v: (
            _METRIC_SEVERITY_RANK.get(v.metric, 99),
            -_relative_overage(v),
            v.scope == "overall",
            v.scope,
            v.metric,
        ),
    )[0]


def _evidence_for(scope: str, metrics: MetricsSummary) -> FailureEvidence:
    if scope == "overall":
        return FailureEvidence(
            scope="overall",
            total_requests=metrics.total_requests,
            error_rate=metrics.error_rate,
            p95_ms=metrics.p95_ms,
            status_codes=dict(metrics.status_codes),
        )
    endpoint = next((e for e in metrics.per_endpoint if e.endpoint == scope), None)
    if endpoint is None:
        # No matching per-endpoint record (shouldn't happen for a scope
        # localize_failures() itself produced from this same metrics
        # object, but degrade safely rather than raise if it ever does).
        return FailureEvidence(scope=scope)
    return FailureEvidence(
        scope=scope,
        total_requests=endpoint.total_requests,
        error_rate=endpoint.error_rate,
        p95_ms=endpoint.p95_ms,
        # Per-endpoint status-code evidence does not exist (Session 5's
        # recordHttpStatus() records globally, not per endpoint tag) --
        # empty, never fabricated.
        status_codes={},
    )


def _load_context(plan: Optional[TestPlan]) -> Optional[LoadContext]:
    if plan is None:
        return None
    if plan.objective_type == ObjectiveType.boundary_search:
        duration = f"ramp {plan.ramp_duration} + hold {plan.hold_duration}"
    else:
        duration = plan.duration
    return LoadContext(
        objective_type=plan.objective_type.value,
        test_type=plan.test_type.value,
        target_vus=plan.target_vus,
        duration=duration,
        selected_endpoints=list(plan.selected_endpoints),
    )


def build_failure_localization(
    metrics: MetricsSummary,
    threshold_status: ResultClassification,
    threshold_violations: List[ThresholdViolation],
    plan: Optional[TestPlan],
) -> FailureLocalization:
    """Pure function over already-computed/already-persisted pieces
    (exactly what a COMPLETED TestResult already carries) ->
    FailureLocalization. No I/O, no randomness, no LLM -- same input
    always produces the same output. Called from routes_runs.py the same
    way build_statistics() already is."""
    primary = _primary_failure(threshold_violations)
    return FailureLocalization(
        overall_status=threshold_status,
        primary_failure=primary,
        violations=list(threshold_violations),
        evidence=_evidence_for(primary.scope, metrics) if primary is not None else None,
        load_context=_load_context(plan),
    )


# ============================================================================
# AI result analysis (final session)
# ============================================================================
#
# OPTIONAL INTERPRETATION, never the source of truth: every field here is
# advisory text/labels the model produced FROM already-computed evidence
# (Statistics, FailureLocalization, TestPlan -- see
# app/services/ai_analyzer.py, which builds that evidence bundle and never
# lets the model compute a metric itself). Absent (`None` on TestResult)
# whenever no analysis was requested, the provider is unavailable, or the
# model's response failed validation -- the deterministic result
# (metrics/statistics/failure_localization/threshold_status) is complete
# and correct with or without this field. Lives here (not a separate
# module) for the same reason FailureLocalization does: `AIAnalysis` is a
# real Pydantic field type on `TestResult` below.


class AIFinding(BaseModel):
    """One model-produced observation. `evidence_ref` names WHICH
    structured evidence the statement is grounded in (e.g. "primary_failure",
    "endpoint:/checkout", "status_codes") -- a lightweight pointer back to
    the deterministic data, not a citation the frontend needs to resolve
    into anything; it exists so a reader can tell the difference between
    "this restates a measured fact" and "this has no evidence pointer"."""

    statement: str
    evidence_ref: Optional[str] = None


class AIAnalysis(BaseModel):
    """Stable, minimal structured output of the AI result analyzer.
    `confidence` is the model's own advisory self-rating (see
    app/schemas/enums.py::Confidence's docstring) -- never read by any
    deterministic code path. `limitations` is where the model is expected
    to say "evidence was insufficient to determine X" rather than
    guessing -- see app/services/ai_analyzer.py's system prompt."""

    summary: str
    severity: Severity
    findings: List[AIFinding] = Field(default_factory=list)
    confidence: Confidence
    limitations: List[str] = Field(default_factory=list)


class TestResult(BaseModel):
    run_id: str
    metrics: MetricsSummary
    threshold_status: ResultClassification
    evaluated_at: datetime
    # --- Additive result-model enrichment (endpoint mix + per-endpoint
    # evidence phase). Assembled by the API layer (routes_runs.py) from
    # data already persisted/produced elsewhere -- no new collection, no
    # LLM, no speculation. See docs/performance_engine_interface.md. ---
    target_base_url: Optional[str] = None
    plan: Optional[TestPlan] = None
    threshold_violations: List[ThresholdViolation] = Field(default_factory=list)
    artifacts: Optional[ArtifactRefs] = None
    # Additive (Session 5): assembled by routes_runs.py via
    # build_statistics(result.metrics) -- see that function's docstring.
    # Never persisted separately from `metrics`.
    statistics: Optional[Statistics] = None
    # Additive (final session): assembled by routes_runs.py via
    # build_failure_localization(...) -- see that function's docstring.
    # Never persisted separately; always cheap/deterministic (no LLM).
    failure_localization: Optional[FailureLocalization] = None
    #
    # NOTE, deliberately no `ai_analysis` field here: AI analysis is never
    # computed as a side effect of GET .../result and is never persisted,
    # so a field that could only ever read back as `None` here would be a
    # misleading, half-persisted contract (looks like data that might show
    # up, never does). The clean, explicit contract is:
    #   GET  /runs/{id}/result   -> deterministic result only (this class)
    #   POST /runs/{id}/analyze -> AIAnalysisResponse{available, analysis,
    #                              reason} (app/api/routes_runs.py) -- the
    #                              ONLY place `AIAnalysis` is ever returned.
    # Mirrors this project's existing "AI is a separate, explicit step"
    # pattern (POST /intents/interpret vs. /compile).


class EngineExecutionOutcome(BaseModel):
    """Return contract for PerformanceEngine.execute(). See
    docs/performance_engine_interface.md for the full contract, especially
    the summary_exists distinction between a legitimate performance result
    (thresholds failed, but the test ran) and an actual execution failure.
    """

    exit_code: int
    summary_exists: bool
    metrics: Optional[MetricsSummary] = None
    threshold_status: Optional[ResultClassification] = None
    # Additive: computed alongside threshold_status (same place, same
    # inputs) so derived evidence is produced once, at execution time, by
    # the engine -- never recomputed later by the API layer reaching back
    # into k6_engine internals. Empty for a PASS, or when summary_exists
    # is False (nothing to localize for an execution failure).
    threshold_violations: List[ThresholdViolation] = Field(default_factory=list)
    raw_output_path: Optional[str] = None
    summary_path: Optional[str] = None
    stdout_log_path: Optional[str] = None
    stderr_log_path: Optional[str] = None
    started_at: datetime
    finished_at: datetime
    error_message: Optional[str] = None
