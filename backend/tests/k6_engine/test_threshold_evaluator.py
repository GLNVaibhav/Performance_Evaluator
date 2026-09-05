from app.schemas.enums import ResultClassification
from app.schemas.test_plan import FixedLoadPlan, Thresholds
from app.schemas.test_result import EndpointMetrics, MetricsSummary
from app.services.k6_engine.threshold_evaluator import evaluate_threshold, localize_failures


def _plan(p95_latency_ms: int, error_rate: float) -> FixedLoadPlan:
    return FixedLoadPlan(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=p95_latency_ms, error_rate=error_rate),
        selected_endpoints=["/products"],
        target_vus=10,
        duration="10s",
    )


def _metrics(p95_ms: float, error_rate: float) -> MetricsSummary:
    return MetricsSummary(
        p50_ms=1.0, p95_ms=p95_ms, p99_ms=p95_ms + 1, average_ms=1.0, max_ms=p95_ms + 5,
        rps=10.0, total_requests=100, failed_requests=round(error_rate * 100),
        error_rate=error_rate, duration_s=10.0,
    )


def test_within_both_thresholds_passes():
    result = evaluate_threshold(_metrics(p95_ms=50, error_rate=0.0), _plan(2000, 0.01))
    assert result == ResultClassification.PASS


def test_p95_violation_fails():
    result = evaluate_threshold(_metrics(p95_ms=5000, error_rate=0.0), _plan(2000, 0.01))
    assert result == ResultClassification.FAIL


def test_error_rate_violation_fails():
    result = evaluate_threshold(_metrics(p95_ms=50, error_rate=0.05), _plan(2000, 0.01))
    assert result == ResultClassification.FAIL


def test_both_violated_fails():
    result = evaluate_threshold(_metrics(p95_ms=5000, error_rate=0.5), _plan(2000, 0.01))
    assert result == ResultClassification.FAIL


def test_exact_boundary_value_passes_inclusive():
    result = evaluate_threshold(_metrics(p95_ms=2000, error_rate=0.01), _plan(2000, 0.01))
    assert result == ResultClassification.PASS


# --- Failure localization (endpoint mix + per-endpoint evidence) ---------


def _endpoint(endpoint: str, error_rate: float, p95_ms: float = 50.0) -> EndpointMetrics:
    return EndpointMetrics(
        endpoint=endpoint, method="GET", total_requests=100,
        p50_ms=1.0, p95_ms=p95_ms, p99_ms=p95_ms + 1, average_ms=1.0, max_ms=p95_ms + 5,
        rps=10.0, failed_requests=round(error_rate * 100), error_rate=error_rate,
    )


def test_localize_failures_empty_on_a_clean_pass():
    """evaluate_threshold()'s PASS/FAIL rule is unchanged and authoritative
    -- localize_failures only explains it. An empty list for a PASS is
    correct, not a bug."""
    metrics = _metrics(p95_ms=50, error_rate=0.0)
    violations = localize_failures(metrics, _plan(2000, 0.01))
    assert violations == []


def test_localize_failures_flags_only_the_endpoint_exceeding_threshold():
    """Exact scenario from the stabilization brief: /products at 0.26
    error rate stays under a 0.40 threshold; /checkout at 0.61 exceeds it.
    Only /checkout must be flagged."""
    plan = _plan(p95_latency_ms=1_000_000, error_rate=0.40)  # p95 threshold made irrelevant on purpose
    metrics = MetricsSummary(
        p50_ms=1.0, p95_ms=10.0, p99_ms=20.0, average_ms=5.0, max_ms=30.0,
        rps=10.0, total_requests=200, failed_requests=29, error_rate=0.29, duration_s=10.0,
        per_endpoint=[
            _endpoint("/products", error_rate=0.26),
            _endpoint("/checkout", error_rate=0.61),
        ],
    )

    violations = localize_failures(metrics, plan)

    scopes = {v.scope for v in violations}
    assert scopes == {"/checkout"}  # exclusively -- neither "overall" nor "/products" is flagged

    checkout_violation = next(v for v in violations if v.scope == "/checkout")
    assert checkout_violation.metric == "error_rate"
    assert checkout_violation.observed == 0.61
    assert checkout_violation.threshold == 0.40


def test_localize_failures_also_reports_the_overall_scope():
    metrics = _metrics(p95_ms=5000, error_rate=0.0)  # overall p95 violates, error_rate does not
    violations = localize_failures(metrics, _plan(2000, 0.01))

    assert len(violations) == 1
    assert violations[0].scope == "overall"
    assert violations[0].metric == "p95_latency_ms"
    assert violations[0].observed == 5000
    assert violations[0].threshold == 2000


def test_localize_failures_can_report_both_overall_and_per_endpoint_violations():
    plan = _plan(p95_latency_ms=2000, error_rate=0.01)
    metrics = MetricsSummary(
        p50_ms=1.0, p95_ms=5000.0, p99_ms=6000.0, average_ms=1000.0, max_ms=7000.0,
        rps=10.0, total_requests=100, failed_requests=5, error_rate=0.05, duration_s=10.0,
        per_endpoint=[_endpoint("/checkout", error_rate=0.05, p95_ms=5000.0)],
    )

    violations = localize_failures(metrics, plan)
    scopes_and_metrics = {(v.scope, v.metric) for v in violations}

    assert ("overall", "p95_latency_ms") in scopes_and_metrics
    assert ("overall", "error_rate") in scopes_and_metrics
    assert ("/checkout", "p95_latency_ms") in scopes_and_metrics
    assert ("/checkout", "error_rate") in scopes_and_metrics
