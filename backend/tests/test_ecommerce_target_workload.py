"""Real vertical-slice proof against the EXPANDED demo API (categories +
products + cart + checkout): intent -> compile_intent() -> TestPlan ->
POST /api/v1/runs -> RealK6PerformanceEngine -> real k6 -> real demo API
-> real TestResult, exercised entirely through the existing public HTTP
API (see backend/docs/workflow_contract.md).

No hand-constructed TestResult, no faked k6 output -- every assertion here
is checked against a real k6 execution's real per-endpoint metrics. See
backend/docs/target_api_notes.md for the target-API architecture review
this file demonstrates.
"""
import os
import shutil
import time
from pathlib import Path

import httpx
import pytest

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


def _run_intent_to_result(client, intent: dict) -> dict:
    compiled = client.post("/api/v1/intents/compile", json=intent)
    assert compiled.status_code == 200, compiled.text
    body = compiled.json()
    assert body["status"] == "READY", body

    run = client.post(
        "/api/v1/runs",
        json={"plan": body["test_plan"], "target": {"base_url": DEMO_API_URL}},
    )
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]

    deadline = time.monotonic() + 60.0
    status_body = None
    while time.monotonic() < deadline:
        status_body = client.get(f"/api/v1/runs/{run_id}").json()
        if status_body["status"] in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            break
        time.sleep(0.5)
    assert status_body["status"] == "COMPLETED", status_body

    result = client.get(f"/api/v1/runs/{run_id}/result")
    assert result.status_code == 200
    return result.json()


# --- Workload shape 1: read-heavy catalog traffic ---------------------------


def test_read_heavy_catalog_workload_real_k6(client):
    """70% /products, 30% /categories -- pure read traffic, weighted, two
    genuinely different resources (proves endpoint diversity beyond the
    original single-resource demo)."""
    intent = {
        "objective": "Read-heavy catalog browsing",
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 10},
        "duration": "8s",
        "target_scope": {
            "endpoints": ["/products", "/categories"],
            "endpoint_weights": {"/products": 70, "/categories": 30},
        },
        "success_criteria": {"p95_latency_ms": 2000, "error_rate": 0.1},
    }
    result = _run_intent_to_result(client, intent)

    assert result["threshold_status"] == "PASS"
    endpoints_seen = {e["endpoint"] for e in result["metrics"]["per_endpoint"]}
    assert endpoints_seen == {"/products", "/categories"}
    products_ep = next(e for e in result["metrics"]["per_endpoint"] if e["endpoint"] == "/products")
    categories_ep = next(e for e in result["metrics"]["per_endpoint"] if e["endpoint"] == "/categories")
    # Weighted split roughly reflects the configured 70/30 (statistical,
    # generous tolerance for an 8s run).
    total = products_ep["total_requests"] + categories_ep["total_requests"]
    assert 0.5 < products_ep["total_requests"] / total < 0.9


# --- Workload shape 2: mixed browse+cart+checkout across the expanded domain


def test_mixed_ecommerce_workload_real_k6_full_vertical_slice(client):
    """The full 5-endpoint mix from this review's demonstration: catalog
    browsing (list + detail), the new /categories resource, cart creation,
    and the existing checkout<-cart dependency chain -- all real, all
    through the real intent -> compile -> run -> result pipeline."""
    intent = {
        "objective": "Evaluate realistic e-commerce workload",
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 15},
        "duration": "10s",
        "target_scope": {
            "endpoints": ["/products", "/products/{product_id}", "/categories", "/cart", "/checkout"],
            "endpoint_weights": {
                "/products": 40,
                "/products/{product_id}": 20,
                "/categories": 15,
                "/cart": 15,
                "/checkout": 10,
            },
        },
        "success_criteria": {"p95_latency_ms": 2000, "error_rate": 0.5},
    }
    result = _run_intent_to_result(client, intent)

    assert result["threshold_status"] == "PASS"
    assert result["metrics"]["total_requests"] > 0
    assert result["metrics"]["error_rate"] == 0.0

    endpoints_seen = {e["endpoint"] for e in result["metrics"]["per_endpoint"]}
    assert endpoints_seen == {"/products", "/products/{product_id}", "/categories", "/cart", "/checkout"}
    for ep in result["metrics"]["per_endpoint"]:
        assert ep["total_requests"] > 0
        assert ep["p95_ms"] >= 0

    # The checkout<-cart dependency (script_renderer.py's one hardcoded
    # chain) still works against the expanded target: every /checkout
    # request succeeded, meaning every one found a real cart_id from its
    # own iteration's /cart call -- proving multi-endpoint traffic and
    # the dependent-workflow mechanism coexist correctly.
    checkout_ep = next(e for e in result["metrics"]["per_endpoint"] if e["endpoint"] == "/checkout")
    assert checkout_ep["error_rate"] == 0.0

    # Artifacts and plan/target are real, on-disk, and echoed back (proves
    # the enriched result model from the prior review still holds for this
    # expanded target).
    assert result["artifacts"]["results_json_path"] is not None
    assert result["plan"]["endpoint_weights"]["/products"] == 40
