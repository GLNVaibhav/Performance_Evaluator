"""Final session: API-level tests for
- GET /runs/{id}/result's new `failure_localization` field (additive,
  same "assemble at fetch time" pattern as `statistics`)
- POST /runs/{id}/analyze (new, explicit, separate AI-analysis step)

The analyzer itself is stubbed at the provider-wiring seam
(app.api.routes_runs.get_ai_analyzer, mirroring how other tests trap
get_performance_engine/get_intent_interpreter) so these tests make no
real network call and do not depend on LLM_API_KEY being configured.
"""
from app.schemas.enums import ResultClassification
from app.schemas.run import RunCreateRequest
from app.schemas.test_plan import TargetConfig
from app.schemas.test_result import (
    AIAnalysis,
    AIFinding,
    EndpointMetrics,
    MetricsSummary,
    ThresholdViolation,
)
from app.services import run_service
from app.storage import repository


def _create_and_complete_run(db_session, metrics: MetricsSummary, threshold_status=ResultClassification.PASS, violations=None):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    run = run_service.create_run(db_session, request)
    repository.save_result(db_session, run.id, metrics, threshold_status, violations or [])
    repository.mark_run_completed(db_session, run.id)
    return run


def _metrics(**overrides) -> MetricsSummary:
    payload = dict(
        p50_ms=100.0,
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


# --- GET /result's new failure_localization field ---------------------------


def test_result_includes_failure_localization_for_a_pass(client, db_session):
    run = _create_and_complete_run(db_session, _metrics(), ResultClassification.PASS)
    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    fl = resp.json()["failure_localization"]
    assert fl["overall_status"] == "PASS"
    assert fl["primary_failure"] is None
    assert fl["violations"] == []
    assert fl["load_context"]["target_vus"] == 20  # from demo_plans/baseline_checkout.json


def test_result_includes_failure_localization_for_a_fail_with_primary_failure(client, db_session):
    violations = [
        ThresholdViolation(scope="/products", metric="p95_latency_ms", observed=820.0, threshold=500.0)
    ]
    run = _create_and_complete_run(
        db_session,
        _metrics(per_endpoint=[
            EndpointMetrics(
                endpoint="/products", method="GET", total_requests=100, p50_ms=400.0, p95_ms=820.0, p99_ms=900.0,
                average_ms=450.0, max_ms=950.0, rps=5.0, failed_requests=0, error_rate=0.0,
            )
        ]),
        ResultClassification.FAIL,
        violations,
    )
    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert resp.status_code == 200
    fl = resp.json()["failure_localization"]
    assert fl["overall_status"] == "FAIL"
    assert fl["primary_failure"]["scope"] == "/products"
    assert fl["evidence"]["scope"] == "/products"
    assert fl["evidence"]["total_requests"] == 100


# --- POST /runs/{id}/analyze -------------------------------------------------


def test_analyze_returns_404_for_unknown_run(client):
    resp = client.post("/api/v1/runs/does-not-exist/analyze")
    assert resp.status_code == 404


def test_analyze_returns_409_for_a_run_not_yet_completed(client, db_session):
    request = RunCreateRequest(plan_id="baseline_checkout", target=TargetConfig(base_url="http://127.0.0.1:1"))
    run = run_service.create_run(db_session, request)
    resp = client.post(f"/api/v1/runs/{run.id}/analyze")
    assert resp.status_code == 409


def test_analyze_returns_available_true_when_analyzer_succeeds(client, db_session, monkeypatch):
    import app.api.routes_runs as routes_runs_module

    class _StubAnalyzer:
        def analyze(self, evidence):
            return AIAnalysis(
                summary="Checkout latency exceeded the configured p95 threshold.",
                severity="high",
                findings=[AIFinding(statement="p95 was over threshold.", evidence_ref="primary_failure")],
                confidence="high",
                limitations=[],
            )

    monkeypatch.setattr(routes_runs_module, "get_ai_analyzer", lambda: _StubAnalyzer())

    run = _create_and_complete_run(db_session, _metrics(), ResultClassification.PASS)
    resp = client.post(f"/api/v1/runs/{run.id}/analyze")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["analysis"]["severity"] == "high"


def test_analyze_returns_available_false_when_analyzer_returns_none(client, db_session, monkeypatch):
    """Simulates an unreachable/misconfigured LLM provider -- must be a
    200 with available=False, never a 500, and must never mark the run
    itself as failed."""
    import app.api.routes_runs as routes_runs_module

    class _NullAnalyzer:
        def analyze(self, evidence):
            return None

    monkeypatch.setattr(routes_runs_module, "get_ai_analyzer", lambda: _NullAnalyzer())

    run = _create_and_complete_run(db_session, _metrics(), ResultClassification.PASS)
    resp = client.post(f"/api/v1/runs/{run.id}/analyze")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is False
    assert body["analysis"] is None
    assert body["reason"] is not None

    # The run/result itself is completely unaffected by AI unavailability.
    result_resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert result_resp.status_code == 200
    assert result_resp.json()["threshold_status"] == "PASS"


def test_analyze_never_persists_anything_new_run_state_unaffected(client, db_session, monkeypatch):
    import app.api.routes_runs as routes_runs_module

    class _NullAnalyzer:
        def analyze(self, evidence):
            return None

    monkeypatch.setattr(routes_runs_module, "get_ai_analyzer", lambda: _NullAnalyzer())

    run = _create_and_complete_run(db_session, _metrics(), ResultClassification.PASS)
    client.post(f"/api/v1/runs/{run.id}/analyze")

    status_resp = client.get(f"/api/v1/runs/{run.id}")
    assert status_resp.json()["status"] == "COMPLETED"


def test_result_carries_no_ai_analysis_field_at_all(client, db_session):
    """GET /result never auto-triggers AI analysis, and deliberately has
    no `ai_analysis` field to leave `None` -- AIAnalysis is returned ONLY
    by the separate, explicit POST .../analyze call (see
    app/schemas/test_result.py::TestResult's docstring for why a
    half-persisted field was rejected as misleading)."""
    run = _create_and_complete_run(db_session, _metrics(), ResultClassification.PASS)
    resp = client.get(f"/api/v1/runs/{run.id}/result")
    assert "ai_analysis" not in resp.json()
