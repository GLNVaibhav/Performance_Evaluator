"""Session 2: secret isolation proven through a REAL, full run lifecycle
(create -> background execute -> result), not just at the schema layer.

Uses the real, live demo API + real k6 (skipped if either is unavailable),
exactly like tests/test_target_validation.py and tests/test_golden_path.py.
The demo API does not itself require authentication -- the point here is
NOT "does auth work against a protected target" (out of scope: no
protected target exists in this repo to test against), it's "does a
secret supplied alongside a normal run ever leak anywhere it structurally
must not", proven against the one real target this project has.
"""
import os
import time

import httpx
import pytest

DEMO_API_URL = os.environ.get("DEMO_API_URL", "http://127.0.0.1:8080")
_SECRET = "totally-secret-bearer-token-xyz-789"


@pytest.fixture(autouse=True)
def _require_demo_api():
    try:
        resp = httpx.get(f"{DEMO_API_URL}/health", timeout=3.0)
        assert resp.status_code == 200
    except Exception:
        pytest.skip(f"canonical demo API not reachable at {DEMO_API_URL} -- start it with 'python run.py'")


def _run_to_completion(client, target_extra: dict):
    inline_plan = {
        "objective_type": "fixed_load",
        "test_type": "baseline",
        "target_vus": 3,
        "duration": "3s",
        "thresholds": {"p95_latency_ms": 5000, "error_rate": 1.0},
        "selected_endpoints": ["/products"],
    }
    run = client.post(
        "/api/v1/runs",
        json={"plan": inline_plan, "target": {"base_url": DEMO_API_URL, **target_extra}},
    )
    assert run.status_code == 201, run.text
    run_id = run.json()["run_id"]

    deadline = time.monotonic() + 30.0
    status_body = None
    while time.monotonic() < deadline:
        status_body = client.get(f"/api/v1/runs/{run_id}").json()
        if status_body["status"] in ("COMPLETED", "EXECUTION_ERROR", "CANCELLED"):
            break
        time.sleep(0.5)
    return run_id, status_body


def test_run_with_bearer_auth_completes_and_leaks_the_secret_nowhere(client):
    run_id, status_body = _run_to_completion(
        client, {"auth": {"type": "bearer", "token": _SECRET}}
    )
    assert status_body["status"] == "COMPLETED", status_body

    result = client.get(f"/api/v1/runs/{run_id}/result")
    assert result.status_code == 200
    assert _SECRET not in result.text

    # Also check the run-status body and the raw artifacts on disk -- the
    # secret must not appear in the generated k6 script, since
    # script_renderer.py is deliberately NOT given the credential (see
    # docs/target_auth_contract.md).
    assert _SECRET not in str(status_body)

    artifacts = result.json()["artifacts"]
    for path_key in ("script_path", "stdout_log_path", "stderr_log_path", "results_json_path"):
        path = artifacts.get(path_key)
        if path:
            content = open(path, "r", encoding="utf-8", errors="replace").read()
            assert _SECRET not in content, f"secret leaked into {path_key}"


def test_run_with_api_key_header_auth_still_completes_normally(client):
    """The credential is accepted and carried through the whole lifecycle
    without breaking anything -- the demo API ignores the extra header
    (it doesn't require auth), which is the expected, documented behavior
    for this project's one real target."""
    run_id, status_body = _run_to_completion(
        client,
        {"auth": {"type": "api_key_header", "header_name": "X-API-Key", "api_key": _SECRET}},
    )
    assert status_body["status"] == "COMPLETED", status_body


def test_target_context_store_is_cleared_after_run_completes(client):
    from app.services import target_context_store

    run_id, status_body = _run_to_completion(
        client, {"auth": {"type": "bearer", "token": _SECRET}}
    )
    assert status_body["status"] == "COMPLETED", status_body
    # The ephemeral in-memory secret must not linger past the run's
    # terminal state -- see target_context_store.py's module docstring.
    assert target_context_store.get(run_id) is None
