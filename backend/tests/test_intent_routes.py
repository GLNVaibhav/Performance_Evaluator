"""HTTP-level tests for POST /api/v1/intents/compile, plus the
cross-cutting guarantees that matter for the AI-intent architecture:
backward compatibility of the existing run API, and that intent compilation
can never reach the performance engine directly.
"""

from app.services import engine_provider


def test_compile_baseline_intent_returns_ready_and_test_plan(client):
    resp = client.post(
        "/api/v1/intents/compile",
        json={
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 50},
            "duration": "30s",
            "target_scope": {"endpoints": ["/products"]},
            "success_criteria": {"p95_latency_ms": 500, "error_rate": 0.01},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "READY"
    assert body["test_plan"]["objective_type"] == "fixed_load"
    assert body["test_plan"]["target_vus"] == 50


def test_compile_missing_fields_returns_needs_clarification(client):
    resp = client.post("/api/v1/intents/compile", json={"test_type": "baseline"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "NEEDS_CLARIFICATION"
    assert len(body["clarifications_needed"]) > 0
    assert body["test_plan"] is None


def test_compile_business_flow_returns_invalid(client):
    resp = client.post(
        "/api/v1/intents/compile",
        json={
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 50},
            "duration": "30s",
            "business_flow": ["browse", "checkout"],
            "success_criteria": {"p95_latency_ms": 500, "error_rate": 0.01},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "INVALID"
    assert body["rejection_code"] == "unsupported_business_flow"


# 9. Invalid thresholds -> rejected at the schema boundary (same convention
# as app/schemas/test_plan.py::Thresholds -- ge/le constraints, not a
# separate ad-hoc check).
def test_compile_invalid_error_rate_returns_422(client):
    resp = client.post(
        "/api/v1/intents/compile",
        json={
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 50},
            "duration": "30s",
            "target_scope": {"endpoints": ["/products"]},
            "success_criteria": {"p95_latency_ms": 500, "error_rate": 1.5},
        },
    )
    assert resp.status_code == 422


def test_compile_malformed_duration_returns_422(client):
    resp = client.post(
        "/api/v1/intents/compile",
        json={
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 50},
            "duration": "not-a-duration",
            "target_scope": {"endpoints": ["/products"]},
        },
    )
    assert resp.status_code == 422


# 12. Existing POST /api/v1/runs remains unchanged by the new router.
def test_existing_run_creation_still_works_with_hardcoded_plan(client):
    resp = client.post(
        "/api/v1/runs",
        json={"plan_id": "baseline_checkout", "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "QUEUED"


def test_existing_run_creation_still_works_with_inline_plan(client):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 10,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.01},
        "selected_endpoints": ["/products"],
    }
    resp = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": "http://127.0.0.1:1"}},
    )
    assert resp.status_code == 201


# 13 / 14. No intent can bypass workload limits or reach PerformanceEngine
# directly -- compiling never touches the engine at all.
def test_compile_never_invokes_performance_engine(client, monkeypatch):
    def _fail_if_called():
        raise AssertionError("intent compilation must never construct/invoke the performance engine")

    monkeypatch.setattr(engine_provider, "get_performance_engine", _fail_if_called)

    resp = client.post(
        "/api/v1/intents/compile",
        json={
            "test_type": "stress",
            "load_profile": {"peak_users": 999_999_999},  # would be unsafe if ever executed
            "target_scope": {"endpoints": ["/checkout"]},
        },
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "INVALID"


def test_compile_result_is_deterministic_over_http(client):
    payload = {
        "test_type": "stress",
        "load_profile": {"peak_users": 500},
        "duration": "20s",
        "target_scope": {"endpoints": ["/checkout"]},
    }
    first = client.post("/api/v1/intents/compile", json=payload).json()
    second = client.post("/api/v1/intents/compile", json=payload).json()

    assert first["test_plan"] == second["test_plan"]
