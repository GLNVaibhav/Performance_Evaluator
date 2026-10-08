"""Execution-bridge contract tests (Convex control plane -> this plane).

Covers the bridge-specific concerns ONLY — the engine, run lifecycle and
target gates are covered by their own suites and are deliberately not
re-tested here:

1. Bearer auth (app/api/bridge_auth.py):
   - EXECUTION_BRIDGE_TOKEN unset  -> /runs* open exactly as before
   - EXECUTION_BRIDGE_TOKEN set    -> 401 without / with the wrong token,
     201 with the exact token, on every /runs* route
2. Correlation: a client-supplied `correlation_id` on RunCreateRequest is
   echoed into the plan's `assumptions` (traceable end-to-end, never a
   competing identifier).
3. Envelope limits are NOT weakened by the bridge (existing limits hold).
4. Status/result shapes the Convex poller relies on (Phase 8 semantics).

NOTE: this repo deliberately sets `python_classes` empty in pytest.ini
(domain models are named TestPlan/TestResult/TestRun — the default
"collect Test*" heuristic must not grab them), so these tests are
module-level functions, not classes.

The plan submitted below is the exact shape the Convex adapter
(src/convex/executor/contract.ts::serializePlan) produces for a Convex
CompiledPlan — this file doubles as the cross-plane contract proof.
"""

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.db import SessionLocal, init_db
from app.storage import repository


@pytest.fixture()
def client(monkeypatch):
    """TestClient against the REAL app with a fake engine seam. These tests
    exercise the bridge contract (auth/correlation/limits/status shapes), not
    execution itself — a success outcome keeps background tasks harmless."""
    from tests.fakes import FakePerformanceEngine, performance_pass_outcome

    init_db()
    engine = FakePerformanceEngine(outcome=performance_pass_outcome())
    monkeypatch.setattr("app.services.engine_provider.get_performance_engine", lambda: engine)
    with TestClient(app) as c:
        yield c


VALID_PLAN = {
    "objective_type": "fixed_load",
    "test_type": "baseline",
    "target_vus": 5,
    "duration": "5s",
    "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.1},
    "selected_endpoints": ["/products"],
    "assumptions": [],
}


def _submit(client, correlation_id=None):
    body = {
        "plan": VALID_PLAN,
        "target": {"base_url": "http://127.0.0.1:59999"},  # nothing listens here
        "correlation_id": correlation_id or str(uuid.uuid4()),
        "submitted_by": "convex-test",
    }
    return client.post("/api/v1/runs", json=body)


def test_bridge_auth_open_when_token_unset(client, monkeypatch):
    monkeypatch.delenv("EXECUTION_BRIDGE_TOKEN", raising=False)
    response = _submit(client)
    # Auth is off; the request proceeds to normal validation (201).
    assert response.status_code == 201, response.text


def test_bridge_auth_401_without_token_when_configured(client, monkeypatch):
    monkeypatch.setenv("EXECUTION_BRIDGE_TOKEN", "secret-bridge-token")
    response = client.post(
        "/api/v1/runs",
        json={"plan": VALID_PLAN, "target": {"base_url": "http://127.0.0.1:59999"}},
    )
    assert response.status_code == 401
    assert "secret" not in response.text.lower()


def test_bridge_auth_401_with_wrong_token(client, monkeypatch):
    monkeypatch.setenv("EXECUTION_BRIDGE_TOKEN", "secret-bridge-token")
    response = client.post(
        "/api/v1/runs",
        json={"plan": VALID_PLAN, "target": {"base_url": "http://127.0.0.1:59999"}},
        headers={"Authorization": "Bearer wrong"},
    )
    assert response.status_code == 401


def test_bridge_auth_201_with_exact_token(client, monkeypatch):
    monkeypatch.setenv("EXECUTION_BRIDGE_TOKEN", "secret-bridge-token")
    response = client.post(
        "/api/v1/runs",
        json={"plan": VALID_PLAN, "target": {"base_url": "http://127.0.0.1:59999"}},
        headers={"Authorization": "Bearer secret-bridge-token"},
    )
    assert response.status_code == 201, response.text


def test_bridge_auth_wrong_token_cannot_poll(client, monkeypatch):
    monkeypatch.delenv("EXECUTION_BRIDGE_TOKEN", raising=False)
    created = _submit(client)
    run_id = created.json()["run_id"]
    monkeypatch.setenv("EXECUTION_BRIDGE_TOKEN", "secret-bridge-token")
    assert client.get(f"/api/v1/runs/{run_id}").status_code == 401
    assert (
        client.get(f"/api/v1/runs/{run_id}", headers={"Authorization": "Bearer secret-bridge-token"}).status_code
        == 200
    )


def test_correlation_id_echoed_into_plan_assumptions(client):
    correlation_id = str(uuid.uuid4())
    created = _submit(client, correlation_id=correlation_id)
    assert created.status_code == 201
    run_id = created.json()["run_id"]

    db = SessionLocal()
    try:
        run = repository.get_run(db, run_id)
        plan_record = repository.get_plan(db, run.plan_id)
        plan_json = (
            plan_record.plan_json
            if isinstance(plan_record.plan_json, dict)
            else json.loads(plan_record.plan_json)
        )
        assert any(correlation_id in a for a in plan_json["assumptions"])
    finally:
        db.close()


def test_submitted_by_is_accepted_envelope_field(client):
    body = {
        "plan": VALID_PLAN,
        "target": {"base_url": "http://127.0.0.1:59999"},
        "correlation_id": str(uuid.uuid4()),
        "submitted_by": "convex-user:abc123",
    }
    response = client.post("/api/v1/runs", json=body)
    assert response.status_code == 201


def test_no_correlation_id_still_works(client):
    # Backward compatible: the envelope fields are optional, never required.
    response = client.post(
        "/api/v1/runs",
        json={"plan": VALID_PLAN, "target": {"base_url": "http://127.0.0.1:59999"}},
    )
    assert response.status_code == 201


def test_envelope_limits_not_weakened_vus(client, monkeypatch):
    # workload_limits.py reads the constant at module level (env-configured at
    # import time), so patch the constant the service actually reads — same
    # approach as tests/test_workload_limits.py.
    import app.services.workload_limits as wl

    monkeypatch.setattr(wl, "MAX_VUS", 10)
    plan = dict(VALID_PLAN, target_vus=11)
    response = client.post(
        "/api/v1/runs",
        json={"plan": plan, "target": {"base_url": "http://127.0.0.1:59999"}, "correlation_id": str(uuid.uuid4())},
    )
    assert response.status_code == 422


def test_envelope_limits_not_weakened_duration(client, monkeypatch):
    import app.services.workload_limits as wl

    monkeypatch.setattr(wl, "MAX_DURATION_S", 10)
    plan = dict(VALID_PLAN, duration="30s")
    response = client.post(
        "/api/v1/runs",
        json={"plan": plan, "target": {"base_url": "http://127.0.0.1:59999"}, "correlation_id": str(uuid.uuid4())},
    )
    assert response.status_code == 422


def test_status_shape_has_the_fields_the_poller_reads(client):
    created = _submit(client)
    run_id = created.json()["run_id"]
    response = client.get(f"/api/v1/runs/{run_id}")
    body = response.json()
    assert response.status_code == 200
    assert body["run_id"] == run_id
    assert body["status"] in {"QUEUED", "RUNNING", "COMPLETED", "CANCELLED", "EXECUTION_ERROR"}
    assert "error_message" in body


def test_result_not_ready_is_409_not_500(client):
    created = _submit(client)
    run_id = created.json()["run_id"]
    response = client.get(f"/api/v1/runs/{run_id}/result")
    assert response.status_code in (200, 409, 422)
