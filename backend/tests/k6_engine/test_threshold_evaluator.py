from app.schemas.enums import ResultClassification
from app.schemas.test_plan import FixedLoadPlan, Thresholds
from app.schemas.test_result import MetricsSummary
from app.services.k6_engine.threshold_evaluator import evaluate_threshold


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
