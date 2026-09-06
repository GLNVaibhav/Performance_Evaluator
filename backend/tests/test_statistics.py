"""Session 5: app/schemas/test_result.py::build_statistics() -- the pure
function that derives the canonical Statistics view from an already-real,
already-measured MetricsSummary. Every assertion here traces back to a
documented formula (see that module's "Statistics / evidence layer"
comment) -- nothing is asserted against an invented/arbitrary number.
"""
from app.schemas.test_result import EndpointMetrics, MetricsSummary, build_statistics


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


# --- Latency -----------------------------------------------------------------


def test_latency_preserves_real_k6_measured_values_unchanged():
    stats = build_statistics(_metrics())
    assert stats.latency.p50_ms == 100.0
    assert stats.latency.p95_ms == 400.0
    assert stats.latency.p99_ms == 800.0
    assert stats.latency.average_ms == 150.0
    assert stats.latency.max_ms == 900.0


def test_p75_p90_are_passed_through_when_present():
    stats = build_statistics(_metrics(p75_ms=200.0, p90_ms=300.0))
    assert stats.latency.p75_ms == 200.0
    assert stats.latency.p90_ms == 300.0


def test_p75_p90_stay_none_when_absent_never_estimated():
    stats = build_statistics(_metrics())
    assert stats.latency.p75_ms is None
    assert stats.latency.p90_ms is None


def test_tail_latency_ratio_is_p99_over_p50():
    stats = build_statistics(_metrics(p50_ms=100.0, p99_ms=800.0))
    assert stats.latency.tail_latency_ratio == 8.0


def test_tail_latency_ratio_is_none_when_p50_is_zero_not_a_fabricated_infinity():
    stats = build_statistics(_metrics(p50_ms=0.0))
    assert stats.latency.tail_latency_ratio is None


# --- Throughput ---------------------------------------------------------------


def test_requests_per_second_is_k6s_own_rps_not_recomputed():
    stats = build_statistics(_metrics(rps=42.5))
    assert stats.throughput.requests_per_second == 42.5


def test_requests_per_minute_is_derived_from_rps_times_sixty():
    """Deliberately NOT total_requests / duration_s * 60 -- that wall-clock
    duration includes k6 process startup/teardown overhead and would
    understate throughput. See build_statistics()'s docstring."""
    stats = build_statistics(_metrics(rps=10.0, total_requests=1000, duration_s=20.0))
    assert stats.throughput.requests_per_minute == 600.0


def test_total_requests_matches_metrics():
    stats = build_statistics(_metrics(total_requests=1234))
    assert stats.throughput.total_requests == 1234


# --- Errors --------------------------------------------------------------------


def test_success_rate_is_one_minus_error_rate():
    stats = build_statistics(_metrics(error_rate=0.05))
    assert stats.errors.success_rate == 0.95


def test_success_rate_for_a_perfect_run():
    stats = build_statistics(_metrics(error_rate=0.0, failed_requests=0))
    assert stats.errors.success_rate == 1.0
    assert stats.errors.failed_requests == 0


def test_failed_requests_and_error_rate_pass_through_unchanged():
    stats = build_statistics(_metrics(failed_requests=50, error_rate=0.05))
    assert stats.errors.failed_requests == 50
    assert stats.errors.error_rate == 0.05


# --- Status codes ---------------------------------------------------------------


def test_status_code_counts_pass_through_verbatim():
    stats = build_statistics(_metrics(status_codes={"200": 950, "404": 30, "500": 20}, total_requests=1000))
    assert stats.status_codes.counts == {"200": 950, "404": 30, "500": 20}


def test_status_code_percentages_are_deterministically_derived():
    stats = build_statistics(_metrics(status_codes={"200": 950, "404": 30, "500": 20}, total_requests=1000))
    assert stats.status_codes.percentages == {"200": 95.0, "404": 3.0, "500": 2.0}


def test_status_code_percentages_empty_when_no_status_codes_collected():
    stats = build_statistics(_metrics())
    assert stats.status_codes.counts == {}
    assert stats.status_codes.percentages == {}


def test_status_code_percentages_empty_when_total_requests_is_zero():
    """Division-by-zero guard -- never a fabricated percentage."""
    stats = build_statistics(_metrics(status_codes={"200": 0}, total_requests=0))
    assert stats.status_codes.percentages == {}


# --- Endpoint rankings ------------------------------------------------------


def _endpoint(endpoint, **overrides) -> EndpointMetrics:
    payload = dict(
        endpoint=endpoint,
        method="GET",
        total_requests=10,
        p50_ms=10.0,
        p95_ms=20.0,
        p99_ms=30.0,
        average_ms=12.0,
        max_ms=40.0,
        rps=1.0,
        failed_requests=0,
        error_rate=0.0,
    )
    payload.update(overrides)
    return EndpointMetrics(**payload)


def test_endpoint_rankings_sort_descending_by_the_named_metric():
    metrics = _metrics(
        per_endpoint=[
            _endpoint("/a", p95_ms=100.0),
            _endpoint("/b", p95_ms=500.0),
            _endpoint("/c", p95_ms=300.0),
        ]
    )
    stats = build_statistics(metrics)
    ordered = [e.endpoint for e in stats.endpoint_rankings.highest_p95_latency]
    assert ordered == ["/b", "/c", "/a"]


def test_endpoint_rankings_highest_error_rate():
    metrics = _metrics(
        per_endpoint=[
            _endpoint("/a", error_rate=0.01),
            _endpoint("/b", error_rate=0.20),
        ]
    )
    stats = build_statistics(metrics)
    assert stats.endpoint_rankings.highest_error_rate[0].endpoint == "/b"
    assert stats.endpoint_rankings.highest_error_rate[0].value == 0.20


def test_endpoint_rankings_highest_request_volume_and_failed_requests():
    metrics = _metrics(
        per_endpoint=[
            _endpoint("/a", total_requests=900, failed_requests=5),
            _endpoint("/b", total_requests=100, failed_requests=45),
        ]
    )
    stats = build_statistics(metrics)
    assert stats.endpoint_rankings.highest_request_volume[0].endpoint == "/a"
    assert stats.endpoint_rankings.highest_failed_requests[0].endpoint == "/b"


def test_endpoint_rankings_are_empty_when_no_per_endpoint_evidence():
    """Never fabricate a ranking from insufficient evidence."""
    stats = build_statistics(_metrics(per_endpoint=[]))
    assert stats.endpoint_rankings.highest_p95_latency == []
    assert stats.endpoint_rankings.highest_error_rate == []
    assert stats.endpoint_rankings.highest_request_volume == []
    assert stats.endpoint_rankings.highest_failed_requests == []
    assert stats.endpoint_shares == []


# --- Endpoint shares --------------------------------------------------------


def test_endpoint_traffic_share_sums_to_one_across_all_endpoints():
    metrics = _metrics(
        total_requests=1000,
        per_endpoint=[_endpoint("/a", total_requests=600), _endpoint("/b", total_requests=400)],
    )
    stats = build_statistics(metrics)
    shares = {s.endpoint: s.traffic_share for s in stats.endpoint_shares}
    assert shares == {"/a": 0.6, "/b": 0.4}


def test_endpoint_failure_share_computed_against_total_failed_requests():
    metrics = _metrics(
        failed_requests=100,
        per_endpoint=[
            _endpoint("/a", failed_requests=75),
            _endpoint("/b", failed_requests=25),
        ],
    )
    stats = build_statistics(metrics)
    shares = {s.endpoint: s.failure_share for s in stats.endpoint_shares}
    assert shares == {"/a": 0.75, "/b": 0.25}


def test_endpoint_failure_share_is_none_when_zero_total_failures_not_zero_by_convention():
    metrics = _metrics(
        failed_requests=0,
        per_endpoint=[_endpoint("/a", failed_requests=0)],
    )
    stats = build_statistics(metrics)
    assert stats.endpoint_shares[0].failure_share is None


def test_endpoint_traffic_share_is_zero_when_total_requests_is_zero():
    metrics = _metrics(total_requests=0, per_endpoint=[_endpoint("/a", total_requests=0)])
    stats = build_statistics(metrics)
    assert stats.endpoint_shares[0].traffic_share == 0.0


# --- Determinism -------------------------------------------------------------


def test_build_statistics_is_a_pure_deterministic_function():
    metrics = _metrics(status_codes={"200": 100}, per_endpoint=[_endpoint("/a")])
    first = build_statistics(metrics)
    second = build_statistics(metrics)
    assert first.model_dump() == second.model_dump()
