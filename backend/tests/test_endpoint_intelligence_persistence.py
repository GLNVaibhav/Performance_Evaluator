"""Round-trip regression coverage for the endpoint-intelligence result
fields, proving they are not silently dropped anywhere along:

    EngineExecutionOutcome -> run_service.execute_run -> repository.save_result
    -> DB (per_endpoint_json / threshold_violations_json columns)
    -> repository.result_record_to_schema -> GET /api/v1/runs/{id}/result

Uses FakePerformanceEngine (tests/fakes.py) so this is deterministic and
independent of real k6 -- the real-k6 path is covered separately (see
docs/performance_engine_interface.md "Amendment: endpoint mix +
per-endpoint evidence" and the manual verification it documents).
"""
from datetime import datetime, timezone

from app.schemas.enums import ResultClassification
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.schemas.test_result import EndpointMetrics, EngineExecutionOutcome, MetricsSummary, ThresholdViolation
from app.services import run_service
from app.storage import repository
from tests.fakes import FakePerformanceEngine


def _create_baseline_run(db_session):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    return run_service.create_run(db_session, request)


def _outcome_with_endpoint_intelligence() -> EngineExecutionOutcome:
    now = datetime.now(timezone.utc)
    metrics = MetricsSummary(
        p50_ms=10.0, p95_ms=1800.0, p99_ms=2000.0, average_ms=500.0, max_ms=3000.0,
        rps=10.0, total_requests=100, failed_requests=26, error_rate=0.26, duration_s=8.0,
        per_endpoint=[
            EndpointMetrics(
                endpoint="/products", method="GET", total_requests=70,
                p50_ms=8.0, p95_ms=300.0, p99_ms=400.0, average_ms=100.0, max_ms=500.0,
                rps=8.75, failed_requests=18, error_rate=0.26,
            ),
            EndpointMetrics(
                endpoint="/checkout", method="POST", total_requests=30,
                p50_ms=15.0, p95_ms=4200.0, p99_ms=5000.0, average_ms=2000.0, max_ms=6000.0,
                rps=3.75, failed_requests=18, error_rate=0.6,
            ),
        ],
    )
    violations = [ThresholdViolation(scope="/checkout", metric="error_rate", observed=0.6, threshold=0.4)]
    return EngineExecutionOutcome(
        exit_code=0,
        summary_exists=True,
        metrics=metrics,
        threshold_status=ResultClassification.FAIL,
        threshold_violations=violations,
        summary_path="fake/summary.json",
        stdout_log_path="fake/stdout.log",
        stderr_log_path="fake/stderr.log",
        started_at=now,
        finished_at=now,
    )


def test_per_endpoint_and_violations_survive_repository_round_trip(db_session):
    run = _create_baseline_run(db_session)
    run_service.execute_run(run.id, FakePerformanceEngine(outcome=_outcome_with_endpoint_intelligence()))
    db_session.expire_all()

    result_record = repository.get_result(db_session, run.id)
    assert result_record is not None
    result = repository.result_record_to_schema(result_record)

    assert len(result.metrics.per_endpoint) == 2
    products = next(e for e in result.metrics.per_endpoint if e.endpoint == "/products")
    checkout = next(e for e in result.metrics.per_endpoint if e.endpoint == "/checkout")
    assert products.total_requests == 70
    assert products.failed_requests == 18
    assert checkout.error_rate == 0.6

    assert len(result.threshold_violations) == 1
    assert result.threshold_violations[0].scope == "/checkout"
    assert result.threshold_violations[0].metric == "error_rate"


def test_api_result_endpoint_returns_the_full_enriched_result(client, db_session):
    run = _create_baseline_run(db_session)
    run_service.execute_run(run.id, FakePerformanceEngine(outcome=_outcome_with_endpoint_intelligence()))
    db_session.expire_all()

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    body = resp.json()

    # C. Overall performance (unchanged existing contract).
    assert body["threshold_status"] == "FAIL"
    assert body["metrics"]["total_requests"] == 100

    # D. Per-endpoint performance.
    per_endpoint = body["metrics"]["per_endpoint"]
    assert len(per_endpoint) == 2
    checkout = next(e for e in per_endpoint if e["endpoint"] == "/checkout")
    assert checkout["failed_requests"] == 18
    assert checkout["method"] == "POST"

    # E. Failure localization.
    assert len(body["threshold_violations"]) == 1
    assert body["threshold_violations"][0]["scope"] == "/checkout"

    # B. Experiment configuration + A. target overview -- assembled at the
    # route layer from data already persisted elsewhere (TestPlanRecord /
    # TestRunRecord), not recomputed or invented.
    assert body["target_base_url"] == "http://127.0.0.1:1"
    assert body["plan"]["selected_endpoints"] == ["/products"]  # baseline_checkout demo plan

    # F. Artifacts -- only real, on-disk paths (the fake engine wrote none,
    # so this proves artifacts are never fabricated when nothing exists).
    assert body["artifacts"] == {
        "script_path": None,
        "results_json_path": None,
        "stdout_log_path": None,
        "stderr_log_path": None,
    }


def test_result_with_no_per_endpoint_data_is_still_backward_compatible(client, db_session):
    """A plan/engine that predates endpoint-mix tagging (per_endpoint=[])
    must still round-trip cleanly -- this is the exact shape every
    existing test in the suite (test_golden_path, test_failure_semantics)
    already produces."""
    from tests.fakes import performance_pass_outcome

    run = _create_baseline_run(db_session)
    run_service.execute_run(run.id, FakePerformanceEngine(outcome=performance_pass_outcome()))
    db_session.expire_all()

    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    body = resp.json()
    assert body["metrics"]["per_endpoint"] == []
    assert body["threshold_violations"] == []
    assert body["plan"] is not None
