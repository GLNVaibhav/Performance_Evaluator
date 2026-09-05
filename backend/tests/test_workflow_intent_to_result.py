"""Product-workflow integration proof: intent -> compile -> (human approval)
-> execute -> poll -> result, driven ENTIRELY through the existing public
HTTP API (the `client` TestClient fixture, i.e. exactly what a real
frontend would call) -- no new backend endpoint, no orchestration glue.

This file exists because a repository architecture review (see
backend/docs/workflow_contract.md) found that the existing endpoints
(POST /api/v1/intents/compile, POST /api/v1/runs, GET /api/v1/runs/{id},
GET /api/v1/runs/{id}/result) already provide everything a client needs
to build the full product workflow, with zero schema translation --
IntentCompilationResponse.test_plan is the exact same TestPlan type
RunCreateRequest.plan accepts. These tests are the demonstration that
this composition genuinely works end to end, including against the real
k6 binary and the real demo API, not just in theory.

Requires a real k6 binary (K6_BINARY) and the live demo API
(DEMO_API_URL) -- skips gracefully otherwise, same convention as
tests/k6_engine/test_real_k6_integration.py.
"""
import os
import shutil
import time
from pathlib import Path

import httpx
import pytest

from app.schemas.enums import RunState
from app.storage import repository

DEMO_API_URL = os.environ.get("DEMO_API_URL", "http://127.0.0.1:8080")
K6_BINARY = os.environ.get("K6_BINARY", "k6")

pytestmark = pytest.mark.skipif(
    shutil.which(K6_BINARY) is None and not Path(K6_BINARY).exists(),
    reason=f"k6 binary not found at '{K6_BINARY}' -- set K6_BINARY",
)


@pytest.fixture(autouse=True)
def _require_demo_api():
    try:
        resp = httpx.get(f"{DEMO_API_URL}/health", timeout=3.0)
        assert resp.status_code == 200
    except Exception:
        pytest.skip(f"canonical demo API not reachable at {DEMO_API_URL} -- start it with 'python run.py'")


@pytest.fixture(autouse=True)
def _reset_mode():
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "normal"})
    yield
    httpx.post(f"{DEMO_API_URL}/demo/mode", json={"mode": "normal"})


def _poll_until_terminal(client, run_id: str, timeout_s: float = 60.0) -> dict:
    deadline = time.monotonic() + timeout_s
    status_body = None
    while time.monotonic() < deadline:
        resp = client.get(f"/api/v1/runs/{run_id}")
        assert resp.status_code == 200
        status_body = resp.json()
        if status_body["status"] in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            return status_body
        time.sleep(0.5)
    raise AssertionError(f"run {run_id} did not reach a terminal state within {timeout_s}s: {status_body}")


# --- 1, 5, 6: READY intent -> plan preview -> explicit execution -> polling -> result ---


def test_full_workflow_ready_intent_to_result_via_public_api_only(client):
    """Corrected version of the user's own ecommerce_intent.json example
    (target_scope.endpoints uses /products and /checkout, which resolve
    against the real demo API's actual OpenAPI surface -- see the
    "compile-time READY does not guarantee executability" finding in
    backend/docs/workflow_contract.md; the original file's literal
    '/products/1' does not match the real path template
    '/products/{product_id}' and was empirically confirmed to compile
    READY but fail at execution with a ResolutionError)."""
    intent = {
        "objective": "Simulate realistic e-commerce traffic and identify endpoint-level bottlenecks",
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "8s",
        "target_scope": {
            "endpoints": ["/products", "/checkout"],
            "endpoint_weights": {"/products": 70, "/checkout": 30},
        },
        "success_criteria": {"p95_latency_ms": 2000, "error_rate": 0.5},
    }

    # Step 1: compile. This must never touch RunService/PerformanceEngine
    # or create any run row (see test_compiling_never_creates_a_run below
    # for the direct proof) -- here we just prove the response shape a
    # frontend needs for plan preview.
    compile_resp = client.post("/api/v1/intents/compile", json=intent)
    assert compile_resp.status_code == 200
    compiled = compile_resp.json()
    assert compiled["status"] == "READY"
    assert compiled["test_plan"] is not None
    plan = compiled["test_plan"]
    # Everything a "review this plan before running it" UI needs, with zero
    # extra backend calls:
    assert plan["target_vus"] == 10
    assert plan["duration"] == "8s"
    assert plan["selected_endpoints"] == ["/products", "/checkout"]
    assert plan["endpoint_weights"] == {"/products": 70, "/checkout": 30}
    assert plan["thresholds"] == {"p95_latency_ms": 2000, "error_rate": 0.5}

    # Step 2: explicit execution approval -- a SEPARATE HTTP call, made
    # only because the (simulated) human reviewed the plan above. The
    # compiled test_plan is submitted VERBATIM, no client-side translation.
    run_resp = client.post(
        "/api/v1/runs",
        json={"plan": plan, "target": {"base_url": DEMO_API_URL}},
    )
    assert run_resp.status_code == 201
    run_id = run_resp.json()["run_id"]
    assert run_resp.json()["status"] in ("QUEUED", "RUNNING", "COMPLETED")

    # Step 3: poll status (requirement 5/7).
    final_status = _poll_until_terminal(client, run_id)
    assert final_status["status"] == "COMPLETED", final_status

    # Step 4: retrieve the enriched TestResult (requirement 6/9).
    result_resp = client.get(f"/api/v1/runs/{run_id}/result")
    assert result_resp.status_code == 200
    result = result_resp.json()

    assert result["run_id"] == run_id
    assert result["threshold_status"] in ("PASS", "FAIL")
    assert result["metrics"]["total_requests"] > 0
    # Per-endpoint evidence (the "performance intelligence" contract):
    endpoints_seen = {e["endpoint"] for e in result["metrics"]["per_endpoint"]}
    assert endpoints_seen == {"/products", "/checkout"}
    # Plan + target echoed back for a self-contained result view, exactly
    # as produced by the compile step -- no re-fetch needed.
    assert result["plan"]["selected_endpoints"] == ["/products", "/checkout"]
    assert result["target_base_url"] == DEMO_API_URL
    assert result["artifacts"]["results_json_path"] is not None


# --- 2. NEEDS_CLARIFICATION -> nothing to execute ---------------------------


def test_needs_clarification_intent_carries_no_test_plan_to_execute(client):
    intent = {"test_type": "baseline"}  # missing endpoints, load, duration
    resp = client.post("/api/v1/intents/compile", json=intent)
    assert resp.status_code == 200
    body = resp.json()

    assert body["status"] == "NEEDS_CLARIFICATION"
    assert body["test_plan"] is None  # nothing a client could submit to /runs
    assert len(body["clarifications_needed"]) > 0


# --- 3. INVALID -> nothing to execute ---------------------------------------


def test_invalid_intent_carries_no_test_plan_to_execute(client):
    intent = {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "10s",
        "business_flow": ["browse", "checkout"],
    }
    resp = client.post("/api/v1/intents/compile", json=intent)
    assert resp.status_code == 200
    body = resp.json()

    assert body["status"] == "INVALID"
    assert body["test_plan"] is None
    assert body["rejection_code"] is not None


# --- 4. Approval is a separate action -- compiling alone creates nothing ---


def test_compiling_a_ready_intent_creates_no_run_and_touches_no_engine(client, db_session, monkeypatch):
    """Directly proves the CRITICAL SAFETY INVARIANT: compilation never
    automatically executes. Both angles: (a) no TestRunRecord exists after
    compiling, and (b) the engine is provably never invoked (an
    assertion-trap monkeypatch, not just "we didn't observe a run")."""
    import app.services.engine_provider as engine_provider_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("compiling an intent must never touch the performance engine")

    monkeypatch.setattr(engine_provider_module, "get_performance_engine", _fail_if_called)

    runs_before = db_session.query(repository.TestRunRecord).count()

    intent = {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "8s",
        "target_scope": {"endpoints": ["/products"]},
    }
    resp = client.post("/api/v1/intents/compile", json=intent)
    assert resp.status_code == 200
    assert resp.json()["status"] == "READY"

    runs_after = db_session.query(repository.TestRunRecord).count()
    assert runs_after == runs_before  # nothing was created by compiling alone


# --- 7. Existing inline TestPlan execution (no intent layer at all) still works


def test_backward_compatible_inline_plan_execution_still_works(client):
    """A client that never touches the intent layer -- submitting a
    hand-authored TestPlan straight to /runs, exactly as before any of
    this workflow existed -- must be completely unaffected."""
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 5,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.5},
        "selected_endpoints": ["/products"],
    }
    resp = client.post("/api/v1/runs", json={"plan": inline_plan, "target": {"base_url": DEMO_API_URL}})
    assert resp.status_code == 201
    final_status = _poll_until_terminal(client, resp.json()["run_id"])
    assert final_status["status"] == "COMPLETED"


# --- 8. Determinism holds at the workflow level, not just inside the compiler


def test_compiling_the_same_intent_twice_yields_identical_submittable_plans(client):
    intent = {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "8s",
        "target_scope": {"endpoints": ["/products"]},
    }
    plan_a = client.post("/api/v1/intents/compile", json=intent).json()["test_plan"]
    plan_b = client.post("/api/v1/intents/compile", json=intent).json()["test_plan"]
    assert plan_a == plan_b
