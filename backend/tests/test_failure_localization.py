"""Final session: app/schemas/test_result.py::build_failure_localization()
-- deterministic, pure function. Every assertion traces back to the
documented primary-failure selection rule or to data already present on
MetricsSummary/ThresholdViolation/TestPlan -- nothing here is invented.
"""
from app.schemas.enums import ResultClassification
from app.schemas.test_plan import FixedLoadPlan, Thresholds
from app.schemas.test_result import EndpointMetrics, MetricsSummary, ThresholdViolation, build_failure_localization


def _metrics(**overrides) -> MetricsSummary:
    payload = dict(
        p50_ms=100.0,
        p95_ms=400.0,
        p99_ms=800.0,
        average_ms=150.0,
        max_ms=900.0,
        rps=50.0,
        total_requests=1000,
        failed_requests=50,
        error_rate=0.05,
        duration_s=20.0,
    )
    payload.update(overrides)
    return MetricsSummary(**payload)


def _plan(**overrides) -> FixedLoadPlan:
    payload = dict(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=500, error_rate=0.01),
        selected_endpoints=["/products"],
        target_vus=10,
        duration="30s",
    )
    payload.update(overrides)
    return FixedLoadPlan(**payload)


# --- overall_status is authoritative, never recomputed -----------------------


def test_overall_status_mirrors_threshold_status_verbatim():
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, [], _plan())
    assert fl.overall_status == ResultClassification.PASS

    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, [], _plan())
    assert fl.overall_status == ResultClassification.FAIL


def test_pass_with_no_violations_has_no_primary_failure():
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, [], _plan())
    assert fl.primary_failure is None
    assert fl.violations == []
    assert fl.evidence is None


# --- primary_failure selection: metric-priority first, then intra-metric ---
# --- relative overage (see _METRIC_SEVERITY_RANK's docstring for why a  ---
# --- cross-metric-type ratio comparison was deliberately rejected)      ---


def test_single_violation_becomes_the_primary_failure():
    violations = [ThresholdViolation(scope="overall", metric="p95_latency_ms", observed=820.0, threshold=500.0)]
    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert fl.primary_failure == violations[0]


def test_error_rate_always_outranks_latency_regardless_of_relative_overage():
    """The explainable rule this session settled on: a request that
    failed outright (error_rate) is a more severe failure mode than one
    that merely completed slowly (p95_latency_ms) -- true even when the
    LATENCY violation's relative overage is far larger. Deliberately NOT
    "highest observed/threshold ratio wins across metric types" (the
    previous rule): that would treat a 1.01x error-rate breach as less
    severe than a 10x latency breach, which is not a defensible claim --
    the two ratios are not comparable numbers."""
    violations = [
        ThresholdViolation(scope="overall", metric="p95_latency_ms", observed=5000.0, threshold=500.0),  # 10x
        ThresholdViolation(scope="/checkout", metric="error_rate", observed=0.0505, threshold=0.05),  # 1.01x
    ]
    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert fl.primary_failure.scope == "/checkout"
    assert fl.primary_failure.metric == "error_rate"


def test_within_the_same_metric_type_highest_relative_overage_wins():
    """Ratios ARE meaningful to compare once the unit is identical -- two
    latency violations, the one further over ITS OWN threshold wins."""
    violations = [
        ThresholdViolation(scope="/a", metric="p95_latency_ms", observed=550.0, threshold=500.0),  # 1.1x
        ThresholdViolation(scope="/b", metric="p95_latency_ms", observed=1000.0, threshold=500.0),  # 2.0x
    ]
    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert fl.primary_failure.scope == "/b"


def test_tie_break_prefers_specific_endpoint_over_overall_scope():
    violations = [
        ThresholdViolation(scope="overall", metric="p95_latency_ms", observed=1000.0, threshold=500.0),  # 2.0x
        ThresholdViolation(scope="/checkout", metric="p95_latency_ms", observed=1000.0, threshold=500.0),  # 2.0x tie
    ]
    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert fl.primary_failure.scope == "/checkout"


def test_zero_threshold_is_treated_as_infinitely_severe_within_the_same_metric_type():
    """Division-by-zero guard, exercised as the actual deciding factor:
    both violations are the SAME metric type (error_rate), so metric
    priority can't decide between them -- the zero-threshold-as-infinity
    rule must be what picks the correct one, and must not crash."""
    violations = [
        ThresholdViolation(scope="/a", metric="error_rate", observed=0.02, threshold=0.01),  # 2x
        ThresholdViolation(scope="/b", metric="error_rate", observed=0.01, threshold=0.0),  # infinite
    ]
    fl = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert fl.primary_failure.scope == "/b"


def test_deterministic_selection_is_reproducible():
    violations = [
        ThresholdViolation(scope="/a", metric="p95_latency_ms", observed=600.0, threshold=500.0),
        ThresholdViolation(scope="/b", metric="p95_latency_ms", observed=700.0, threshold=500.0),
    ]
    first = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    second = build_failure_localization(_metrics(), ResultClassification.FAIL, violations, _plan())
    assert first.model_dump() == second.model_dump()


def test_violations_that_do_not_affect_the_aggregate_pass_are_still_surfaced():
    """A real, documented edge case: threshold_evaluator.localize_failures()
    checks per-endpoint entries independently of the aggregate -- an
    endpoint can violate its OWN threshold even while the aggregate still
    PASSes. This must be surfaced, not suppressed."""
    violations = [ThresholdViolation(scope="/checkout", metric="p95_latency_ms", observed=900.0, threshold=500.0)]
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, violations, _plan())
    assert fl.overall_status == ResultClassification.PASS
    assert fl.primary_failure is not None
    assert fl.primary_failure.scope == "/checkout"


# --- evidence: pulled from real metrics, never fabricated -------------------


def test_evidence_for_overall_scope_uses_aggregate_metrics():
    metrics = _metrics(total_requests=1000, error_rate=0.05, p95_ms=400.0, status_codes={"500": 50})
    violations = [ThresholdViolation(scope="overall", metric="error_rate", observed=0.05, threshold=0.01)]
    fl = build_failure_localization(metrics, ResultClassification.FAIL, violations, _plan())
    assert fl.evidence.scope == "overall"
    assert fl.evidence.total_requests == 1000
    assert fl.evidence.error_rate == 0.05
    assert fl.evidence.status_codes == {"500": 50}


def test_evidence_for_endpoint_scope_uses_the_matching_endpoint_metrics():
    endpoint = EndpointMetrics(
        endpoint="/checkout",
        method="POST",
        total_requests=200,
        p50_ms=300.0,
        p95_ms=900.0,
        p99_ms=1200.0,
        average_ms=350.0,
        max_ms=1300.0,
        rps=10.0,
        failed_requests=5,
        error_rate=0.025,
    )
    metrics = _metrics(per_endpoint=[endpoint])
    violations = [ThresholdViolation(scope="/checkout", metric="p95_latency_ms", observed=900.0, threshold=500.0)]
    fl = build_failure_localization(metrics, ResultClassification.FAIL, violations, _plan())
    assert fl.evidence.scope == "/checkout"
    assert fl.evidence.total_requests == 200
    assert fl.evidence.p95_ms == 900.0
    # Per-endpoint status codes are never collected (Session 5 scope
    # decision) -- must be empty, never fabricated.
    assert fl.evidence.status_codes == {}


def test_evidence_scope_with_no_matching_endpoint_degrades_safely():
    """Should not happen in practice (localize_failures() only ever names
    a scope it derived from this same metrics object), but must not crash
    if it ever did."""
    violations = [ThresholdViolation(scope="/missing", metric="p95_latency_ms", observed=900.0, threshold=500.0)]
    fl = build_failure_localization(_metrics(per_endpoint=[]), ResultClassification.FAIL, violations, _plan())
    assert fl.evidence.scope == "/missing"
    assert fl.evidence.total_requests is None


# --- load_context: read from the plan, never guessed ------------------------


def test_load_context_for_fixed_load_plan():
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, [], _plan(target_vus=25, duration="45s"))
    assert fl.load_context.objective_type == "fixed_load"
    assert fl.load_context.target_vus == 25
    assert fl.load_context.duration == "45s"
    assert fl.load_context.selected_endpoints == ["/products"]


def test_load_context_for_boundary_search_plan_combines_ramp_and_hold():
    from app.schemas.test_plan import BoundarySearchPlan

    plan = BoundarySearchPlan(
        test_type="stress",
        thresholds=Thresholds(p95_latency_ms=500, error_rate=0.01),
        selected_endpoints=["/checkout"],
        target_vus=100,
        ramp_duration="10s",
        hold_duration="20s",
    )
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, [], plan)
    assert fl.load_context.duration == "ramp 10s + hold 20s"


def test_load_context_is_none_when_plan_is_unavailable():
    fl = build_failure_localization(_metrics(), ResultClassification.PASS, [], None)
    assert fl.load_context is None
