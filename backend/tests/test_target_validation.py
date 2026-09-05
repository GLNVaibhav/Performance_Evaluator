"""Tests for the target-compatibility gate (app/services/target_validation.py)
introduced to close a proven gap: an intent naming a syntactically valid
but nonexistent endpoint (e.g. "/products/1" instead of the target's real
"/products/{product_id}" template) previously compiled READY, was accepted
by POST /api/v1/runs, and only surfaced as EXECUTION_ERROR after the run
had already been created and background execution begun.

Uses the real, live demo API (see the _require_demo_api fixture) so every
"endpoint exists / doesn't exist" verdict here is a real OpenAPI
resolution, never mocked. See backend/docs/target_validation_notes.md for
the full architectural review this file proves.
"""
import os
import shutil
import time
from pathlib import Path

import httpx
import pytest

from app.schemas.test_plan import FixedLoadPlan, TargetConfig, Thresholds
from app.services.target_validation import TargetValidationError, validate_target_compatibility

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


def _plan(endpoints, weights=None, **overrides):
    payload = dict(
        test_type="baseline",
        thresholds=Thresholds(p95_latency_ms=2000, error_rate=0.5),
        selected_endpoints=endpoints,
        endpoint_weights=weights,
        target_vus=5,
        duration="5s",
    )
    payload.update(overrides)
    return FixedLoadPlan(**payload)


_TARGET = TargetConfig(base_url=DEMO_API_URL)


# --- Test 1: valid endpoint -------------------------------------------------


def test_valid_endpoint_passes_target_validation():
    validate_target_compatibility(_plan(["/products"]), _TARGET)  # must not raise


# --- Test 2: OpenAPI template endpoint --------------------------------------


def test_openapi_template_endpoint_passes_target_validation():
    validate_target_compatibility(_plan(["/products/{product_id}"]), _TARGET)  # must not raise


# --- Test 3: the exact proven-gap case --------------------------------------


def test_concrete_path_not_matching_the_real_template_fails_validation():
    """The exact bug this module exists to catch: /products/1 is
    syntactically valid and would compile READY, but does not match the
    target's real path template /products/{product_id}."""
    with pytest.raises(TargetValidationError) as exc_info:
        validate_target_compatibility(_plan(["/products/1"]), _TARGET)
    assert "/products/1" in str(exc_info.value)
    assert "does not exist" in str(exc_info.value)


# --- Test 4: mixed valid endpoints -------------------------------------------


def test_mixed_valid_endpoints_pass_target_validation():
    validate_target_compatibility(
        _plan(["/products", "/categories", "/products/{product_id}"]), _TARGET
    )  # must not raise


# --- Test 5: one invalid endpoint in a weighted mix -------------------------


def test_one_invalid_endpoint_in_weighted_mix_rejects_the_whole_plan_and_names_it():
    plan = _plan(
        ["/products", "/categories", "/nonexistent"],
        weights={"/products": 50, "/categories": 30, "/nonexistent": 20},
    )
    with pytest.raises(TargetValidationError) as exc_info:
        validate_target_compatibility(plan, _TARGET)
    assert "/nonexistent" in str(exc_info.value)


# --- Deliberate asymmetry: unreachable target is NOT rejected here ----------


def test_unreachable_target_does_not_raise_here_deferred_to_execution():
    """Core design decision (see target_validation.py's "DELIBERATE
    ASYMMETRY" docstring section): "can't verify" is not the same
    assertion as "verified incompatible". Rejecting here would also break
    every existing test that deliberately uses an unreachable placeholder
    target for unrelated run-lifecycle testing -- confirmed by the full
    regression run in this task's report, not merely asserted here."""
    unreachable = TargetConfig(base_url="http://127.0.0.1:1")
    validate_target_compatibility(_plan(["/products"]), unreachable)  # must not raise


# --- Test 6: compile_intent() remains side-effect-free ----------------------


def test_compile_intent_never_touches_network_run_service_or_engine(monkeypatch):
    """Traps the OpenAPI fetcher, RunService, and the performance engine --
    proves target validation living in a separate module never gets pulled
    into compile_intent()'s pure, deterministic path."""
    import app.services.engine_provider as engine_provider_module
    import app.services.intent_compiler as intent_compiler_module
    import app.services.k6_engine.openapi_loader as openapi_loader_module
    import app.services.run_service as run_service_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("compile_intent() must never trigger this")

    monkeypatch.setattr(openapi_loader_module, "fetch_openapi", _fail_if_called)
    monkeypatch.setattr(run_service_module, "create_run", _fail_if_called)
    monkeypatch.setattr(engine_provider_module, "get_performance_engine", _fail_if_called)

    from app.schemas.intent import UniversalPerformanceIntent

    intent = UniversalPerformanceIntent.model_validate(
        {
            "test_type": "baseline",
            "load_profile": {"concurrent_users": 10},
            "duration": "10s",
            "target_scope": {"endpoints": ["/products/1"]},  # even a target-incompatible one
        }
    )
    result = intent_compiler_module.compile_intent(intent)
    assert result.status.value == "READY"  # compile_intent() has no notion of targets at all


# --- Test 7: an incompatible target never reaches the engine ----------------


def test_target_incompatible_run_creation_never_reaches_the_engine(client, monkeypatch):
    import app.services.engine_provider as engine_provider_module

    def _fail_if_called(*a, **kw):
        raise AssertionError("a target-validation rejection must never reach the performance engine")

    monkeypatch.setattr(engine_provider_module, "get_performance_engine", _fail_if_called)

    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 5,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.5},
        "selected_endpoints": ["/products/1"],
    }
    resp = client.post("/api/v1/runs", json={"plan": inline_plan, "target": {"base_url": DEMO_API_URL}})
    assert resp.status_code == 422
    assert "/products/1" in resp.json()["detail"]


def test_target_incompatible_run_creation_persists_no_run_or_plan(client, db_session):
    """No run/plan row is created for a plan known in advance to be
    incompatible with its target -- the gap this closes is specifically
    "the run was already created before the incompatibility was found"."""
    from app.storage import repository

    runs_before = db_session.query(repository.TestRunRecord).count()

    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 5,
        "duration": "5s",
        "thresholds": {"p95_latency_ms": 2000, "error_rate": 0.5},
        "selected_endpoints": ["/products/1"],
    }
    resp = client.post("/api/v1/runs", json={"plan": inline_plan, "target": {"base_url": DEMO_API_URL}})
    assert resp.status_code == 422

    runs_after = db_session.query(repository.TestRunRecord).count()
    assert runs_after == runs_before


# --- Test 8: existing workflow regression -----------------------------------


def test_full_workflow_with_valid_target_still_works_end_to_end(client):
    """Intent -> compile -> TestPlan -> valid target -> run -> result,
    exactly as before this gate existed, now passing THROUGH the new gate
    rather than around it."""
    intent = {
        "test_type": "baseline",
        "load_profile": {"concurrent_users": 5},
        "duration": "5s",
        "target_scope": {"endpoints": ["/products"]},
        "success_criteria": {"p95_latency_ms": 2000, "error_rate": 0.5},
    }
    compiled = client.post("/api/v1/intents/compile", json=intent)
    assert compiled.status_code == 200
    plan = compiled.json()["test_plan"]

    run = client.post("/api/v1/runs", json={"plan": plan, "target": {"base_url": DEMO_API_URL}})
    assert run.status_code == 201
    run_id = run.json()["run_id"]

    deadline = time.monotonic() + 30.0
    status_body = None
    while time.monotonic() < deadline:
        status_body = client.get(f"/api/v1/runs/{run_id}").json()
        if status_body["status"] in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            break
        time.sleep(0.5)
    assert status_body["status"] == "COMPLETED", status_body

    result = client.get(f"/api/v1/runs/{run_id}/result")
    assert result.status_code == 200
    assert result.json()["metrics"]["total_requests"] > 0
