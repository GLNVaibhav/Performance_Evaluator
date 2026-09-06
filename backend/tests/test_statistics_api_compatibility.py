"""Session 5: GET /api/v1/runs/{id}/result's `statistics` field -- additive,
backward-compatible. Verifies existing fields (metrics, threshold_status,
per_endpoint, plan, artifacts, threshold_violations) are completely
unaffected, and that a result row saved WITHOUT the new p75/p90/
status_codes evidence (simulating data written before Session 5) still
serves a valid response with `statistics` present but those specific
sub-fields empty/absent -- never an error, never a fabricated value.
"""
from app.schemas.enums import ResultClassification
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.schemas.test_result import EndpointMetrics, MetricsSummary
from app.services import run_service
from app.storage import repository


def _create_and_complete_run(db_session, metrics: MetricsSummary):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    run = run_service.create_run(db_session, request)
    repository.save_result(db_session, run.id, metrics, ResultClassification.PASS)
    repository.mark_run_completed(db_session, run.id)
    return run


def test_statistics_present_and_derived_correctly_for_a_completed_run(client, db_session):
    metrics = MetricsSummary(
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
        status_codes={"200": 490, "500": 10},
        per_endpoint=[
            EndpointMetrics(
                endpoint="/products",
                method="GET",
                total_requests=500,
                p50_ms=100.0,
                p95_ms=200.0,
                p99_ms=300.0,
                average_ms=120.0,
                max_ms=350.0,
                rps=20.0,
                failed_requests=10,
                error_rate=0.02,
            )
        ],
    )
    run = _create_and_complete_run(db_session, metrics)

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    body = resp.json()

    # Existing fields completely unaffected.
    assert body["metrics"]["p50_ms"] == 100.0
    assert body["metrics"]["total_requests"] == 500
    assert body["threshold_status"] == "PASS"
    assert len(body["metrics"]["per_endpoint"]) == 1
    assert body["plan"] is not None
    assert body["artifacts"] is not None

    # New statistics field, correctly derived.
    stats = body["statistics"]
    assert stats["latency"]["p50_ms"] == 100.0
    assert stats["latency"]["p75_ms"] == 150.0
    assert stats["latency"]["tail_latency_ratio"] == 3.0
    assert stats["throughput"]["requests_per_second"] == 20.0
    assert stats["throughput"]["requests_per_minute"] == 1200.0
    assert stats["errors"]["success_rate"] == 0.98
    assert stats["status_codes"]["counts"] == {"200": 490, "500": 10}
    assert stats["status_codes"]["percentages"] == {"200": 98.0, "500": 2.0}
    assert stats["endpoint_rankings"]["highest_p95_latency"][0]["endpoint"] == "/products"
    assert stats["endpoint_shares"][0]["traffic_share"] == 1.0


def test_statistics_degrades_safely_for_a_result_predating_session_5_evidence(client, db_session):
    """No p75/p90/status_codes at all -- exactly what a result row saved
    before this session's columns existed looks like when read back."""
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
    )
    run = _create_and_complete_run(db_session, metrics)

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    body = resp.json()

    assert body["metrics"]["p75_ms"] is None
    assert body["metrics"]["p90_ms"] is None
    assert body["metrics"]["status_codes"] == {}

    stats = body["statistics"]
    assert stats["latency"]["p75_ms"] is None
    assert stats["latency"]["p90_ms"] is None
    assert stats["status_codes"]["counts"] == {}
    assert stats["status_codes"]["percentages"] == {}
    assert stats["endpoint_rankings"]["highest_p95_latency"] == []
    assert stats["endpoint_shares"] == []
    # Errors/throughput still fully derivable -- no evidence gap there.
    assert stats["errors"]["success_rate"] == 1.0
