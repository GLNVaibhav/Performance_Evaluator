"""Session 6: app/presentation/terminal_report.py -- pure formatting layer.
Every test here checks that the renderer reads already-computed structured
data correctly; none of them exercise any new computation (there isn't
any -- see that module's docstring).
"""
from datetime import datetime, timezone

from app.presentation.terminal_report import (
    render_completed_report,
    render_header,
    render_results,
)
from app.schemas.enums import ResultClassification, RunState
from app.schemas.test_plan import FixedLoadPlan, Thresholds
from app.schemas.test_result import (
    ArtifactRefs,
    EndpointMetrics,
    MetricsSummary,
    TestResult,
    ThresholdViolation,
    build_statistics,
)


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


def _metrics(**overrides) -> MetricsSummary:
    payload = dict(
        p50_ms=100.0,
        p75_ms=150.0,
        p90_ms=180.0,
        p95_ms=200.0,
        p99_ms=300.0,
        average_ms=120.0,
        max_ms=350.0,
        rps=20.0,
        total_requests=500,
        failed_requests=10,
        error_rate=0.02,
        duration_s=25.0,
    )
    payload.update(overrides)
    return MetricsSummary(**payload)


def _result(metrics: MetricsSummary, **overrides) -> TestResult:
    payload = dict(
        run_id="run-1",
        metrics=metrics,
        threshold_status=ResultClassification.PASS,
        evaluated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        target_base_url="http://127.0.0.1:8080",
        plan=_plan(),
        threshold_violations=[],
        artifacts=ArtifactRefs(script_path="/tmp/run-1/script.js", results_json_path="/tmp/run-1/results.json"),
        statistics=build_statistics(metrics),
    )
    payload.update(overrides)
    return TestResult(**payload)


# --- 1/2. Completed result renders key latency statistics -------------------


def test_completed_result_renders_latency_percentiles():
    report = render_completed_report(_result(_metrics()))
    assert "p50:  100.00 ms" in report
    assert "p75:  150.00 ms" in report
    assert "p90:  180.00 ms" in report
    assert "p95:  200.00 ms" in report
    assert "p99:  300.00 ms" in report
    assert "avg:  120.00 ms" in report
    assert "max:  350.00 ms" in report


# --- 3. Throughput values ----------------------------------------------------


def test_throughput_values_render_correctly():
    report = render_completed_report(_result(_metrics(rps=20.0, total_requests=500)))
    assert "requests:   500" in report
    assert "req/s:      20.00" in report
    assert "req/min:    1200.00" in report


# --- 4. Error values -- the critical unit-conversion test -------------------


def test_error_rate_fraction_is_correctly_converted_to_percent_not_double_scaled():
    """error_rate=0.05 must render as 5.00%, never 0.05% -- the exact
    ambiguous-units bug this session was warned about."""
    report = render_completed_report(_result(_metrics(error_rate=0.05, failed_requests=25, total_requests=500)))
    assert "error rate:   5.00%" in report
    assert "success rate: 95.00%" in report
    assert "failed:       25" in report


def test_perfect_run_renders_zero_error_full_success():
    report = render_completed_report(_result(_metrics(error_rate=0.0, failed_requests=0)))
    assert "error rate:   0.00%" in report
    assert "success rate: 100.00%" in report


# --- 5. Status codes render dynamically, never a fixed list -----------------


def test_status_codes_render_only_actually_observed_codes():
    metrics = _metrics(status_codes={"200": 480, "500": 20}, total_requests=500)
    report = render_completed_report(_result(metrics))
    assert "200: 480 (96.0%)" in report
    assert "500: 20 (4.0%)" in report
    # Never a fixed/hardcoded set -- codes not present must not appear.
    assert "404" not in report
    assert "429" not in report


def test_unusual_status_codes_are_not_assumed_away():
    """Proves this isn't secretly hardcoded to 200/404/429/500 -- an
    unusual code (418, 301) must render exactly like any other."""
    metrics = _metrics(status_codes={"418": 3, "301": 7}, total_requests=10)
    report = render_completed_report(_result(metrics))
    assert "418: 3" in report
    assert "301: 7" in report


def test_no_status_code_evidence_shows_explicit_message_not_a_crash():
    report = render_completed_report(_result(_metrics(status_codes={})))
    assert "No status-code evidence available" in report


# --- 6. Endpoint ranking renders deterministically --------------------------


def _endpoint(name, **overrides) -> EndpointMetrics:
    payload = dict(
        endpoint=name,
        method="GET",
        total_requests=100,
        p50_ms=50.0,
        p95_ms=100.0,
        p99_ms=150.0,
        average_ms=60.0,
        max_ms=180.0,
        rps=5.0,
        failed_requests=1,
        error_rate=0.01,
    )
    payload.update(overrides)
    return EndpointMetrics(**payload)


def test_endpoint_table_orders_rows_using_the_same_canonical_ranking():
    metrics = _metrics(
        per_endpoint=[
            _endpoint("/a", p95_ms=100.0),
            _endpoint("/b", p95_ms=500.0),
            _endpoint("/c", p95_ms=300.0),
        ]
    )
    report = render_completed_report(_result(metrics))
    idx_b = report.index("/b")
    idx_c = report.index("/c")
    idx_a = report.index("/a", report.index("Endpoint Performance"))
    assert idx_b < idx_c < idx_a  # descending p95, matching Statistics.endpoint_rankings


def test_endpoint_table_shows_requests_and_error_rate_columns():
    metrics = _metrics(per_endpoint=[_endpoint("/products", total_requests=250, error_rate=0.04)])
    report = render_completed_report(_result(metrics))
    assert "/products" in report
    assert "250" in report
    assert "4.00%" in report


def test_no_endpoint_evidence_shows_explicit_message():
    report = render_completed_report(_result(_metrics(per_endpoint=[])))
    assert "No endpoint evidence available" in report


# --- 7/8. Threshold PASS / FAIL ----------------------------------------------


def test_threshold_pass_renders_correctly():
    report = render_completed_report(_result(_metrics(), threshold_status=ResultClassification.PASS))
    assert "Threshold Status: PASS" in report
    assert "Violations:" not in report


def test_threshold_fail_renders_violations_readably():
    violations = [
        ThresholdViolation(scope="/checkout", metric="p95_latency_ms", observed=820.0, threshold=500.0),
        ThresholdViolation(scope="overall", metric="error_rate", observed=0.042, threshold=0.01),
    ]
    report = render_completed_report(
        _result(_metrics(), threshold_status=ResultClassification.FAIL, threshold_violations=violations)
    )
    assert "Threshold Status: FAIL" in report
    assert "/checkout p95_latency_ms 820.00 ms > 500.00 ms" in report
    assert "overall error_rate 4.20% > 1.00%" in report


def test_threshold_fail_with_no_violations_list_still_renders_status():
    """Session 5's aggregate status is the fallback -- no fabricated detail
    when threshold_violations happens to be empty despite a FAIL."""
    report = render_completed_report(_result(_metrics(), threshold_status=ResultClassification.FAIL))
    assert "Threshold Status: FAIL" in report


# --- 9. Missing optional evidence never crashes -----------------------------


def test_missing_p75_p90_renders_n_a_not_a_crash():
    metrics = _metrics(p75_ms=None, p90_ms=None)
    report = render_completed_report(_result(metrics))
    assert "p75:  N/A" in report
    assert "p90:  N/A" in report


def test_tail_latency_ratio_omitted_when_p50_is_zero():
    metrics = _metrics(p50_ms=0.0, p99_ms=300.0)
    report = render_completed_report(_result(metrics))
    assert "p99/p50 ratio" not in report


def test_no_plan_available_renders_n_a_workload_not_a_crash():
    report = render_header(target_base_url="http://x", plan=None, state=RunState.QUEUED)
    assert "Workload:\n  N/A" in report
    assert "Test:\n  N/A" in report


def test_no_target_available_renders_n_a_not_a_crash():
    report = render_header(target_base_url=None, plan=_plan(), state=RunState.RUNNING)
    assert "Target:\n  N/A" in report


# --- 10. Failed run renders failure state safely -----------------------------


def test_execution_error_state_renders_error_message():
    report = render_header(
        target_base_url="http://127.0.0.1:8080",
        plan=_plan(),
        state=RunState.EXECUTION_ERROR,
        error_message="k6 exited with non-zero status 1",
    )
    assert "Status:\n  EXECUTION_ERROR" in report
    assert "Execution error:" in report
    assert "k6 exited with non-zero status 1" in report


def test_execution_error_with_no_message_does_not_crash():
    report = render_header(
        target_base_url="http://127.0.0.1:8080", plan=_plan(), state=RunState.EXECUTION_ERROR, error_message=None
    )
    assert "(no error message recorded)" in report


def test_queued_and_running_states_render_without_a_result():
    for state in (RunState.QUEUED, RunState.RUNNING, RunState.CANCELLED):
        report = render_header(target_base_url="http://x", plan=_plan(), state=state)
        assert f"Status:\n  {state.value}" in report


# --- 11. No secret ever printed ----------------------------------------------


def test_no_secret_shaped_string_appears_anywhere_in_the_report():
    """Structural guarantee, not just a string check: neither TestResult
    nor RunStatusResponse has any auth-shaped field at all (see
    docs/target_auth_contract.md) -- this test documents that guarantee
    by construction, using a plan/result exactly as the real API would
    return them."""
    report = render_completed_report(_result(_metrics()))
    for marker in ("Bearer ", "Authorization", "api_key", "token", "secret", "password"):
        assert marker not in report


# --- 12. Old / pre-Session-5 result data does not crash ----------------------


def test_result_with_no_statistics_object_still_renders_safely():
    """Simulates a TestResult constructed without Session 5's `statistics`
    field at all (e.g. a hand-built object in an older caller/test)."""
    metrics = _metrics()
    result = _result(metrics, statistics=None)
    report = render_completed_report(result)
    assert "no structured statistics available" in report
    assert "Threshold Status: PASS" in report  # aggregate status still shown


def test_pre_session_5_metrics_with_empty_status_and_endpoint_evidence():
    metrics = MetricsSummary(
        p50_ms=50.0,
        p95_ms=100.0,
        p99_ms=150.0,
        average_ms=60.0,
        max_ms=180.0,
        rps=10.0,
        total_requests=200,
        failed_requests=0,
        error_rate=0.0,
        duration_s=20.0,
        # p75_ms/p90_ms/status_codes/per_endpoint all left at their
        # defaults -- exactly what reading back a pre-Session-5 DB row
        # produces (see repository.py::result_record_to_schema).
    )
    report = render_completed_report(_result(metrics))
    assert "p75:  N/A" in report
    assert "No status-code evidence available" in report
    assert "No endpoint evidence available" in report
